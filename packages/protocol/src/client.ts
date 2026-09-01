import { createHmac, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  BRIDGE_PROTOCOL_VERSION,
  LIMITS,
  RackMcpError,
  type BridgeMethod,
} from "@rackmcp/schemas";
import { encodeFrame, FrameDecoder } from "./framing.js";

export interface BridgeClientOptions {
  clientName: string;
  clientVersion: string;
  /** Default per-request deadline. */
  deadlineMs?: number;
}

export interface WelcomeData {
  instanceId: string;
  sessionId: string;
  bridgeVersion: string;
  rackVersion: string;
  rackEdition: string;
  patchEpoch: number;
  nonce: string;
}

export class BridgeRequestError extends Error {
  constructor(public readonly rpcError: RackMcpError) {
    super(`${rpcError.code}: ${rpcError.message}`);
    this.name = "BridgeRequestError";
  }
}

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Bridge protocol client: framing, hello/welcome/auth handshake, request
 * multiplexing with per-request deadlines, ping heartbeats, and event hooks.
 */
export class BridgeClient {
  private socket: Socket | null = null;
  private decoder = new FrameDecoder();
  private pending = new Map<string, Pending>();
  private welcomeData: WelcomeData | null = null;
  private handshakeQueue: Array<(frame: Record<string, unknown>) => void> = [];
  private closed = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  /** Fired for evt frames (shutting_down, patch_epoch_changed, lease_revoked). */
  onEvent: ((event: string, payload: unknown) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(private readonly options: BridgeClientOptions) {}

  get welcome(): WelcomeData | null {
    return this.welcomeData;
  }
  get isConnected(): boolean {
    return this.socket !== null && !this.closed;
  }

  async connect(port: number, timeoutMs = 5000): Promise<WelcomeData> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection({ host: "127.0.0.1", port, noDelay: true });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error("bridge connect timeout"));
      }, timeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.teardown(new Error("bridge connection closed")));
    socket.on("error", () => this.teardown(new Error("bridge connection error")));

    const welcome = await this.exchangeHandshake(
      {
        kind: "hello",
        versions: [BRIDGE_PROTOCOL_VERSION],
        client: { name: this.options.clientName, version: this.options.clientVersion },
      },
      timeoutMs,
    );
    if (welcome.kind !== "welcome") {
      const error = (welcome as { error?: RackMcpError }).error;
      this.close();
      throw new BridgeRequestError(
        error ?? {
          code: "PROTOCOL_VERSION_MISMATCH",
          message: "handshake failed",
          retrySafe: false,
          mutationMayHaveOccurred: false,
        },
      );
    }
    this.welcomeData = {
      instanceId: welcome.instanceId as string,
      sessionId: welcome.sessionId as string,
      bridgeVersion: welcome.bridgeVersion as string,
      rackVersion: welcome.rackVersion as string,
      rackEdition: welcome.rackEdition as string,
      patchEpoch: welcome.patchEpoch as number,
      nonce: welcome.nonce as string,
    };
    return this.welcomeData;
  }

  /** Authenticates with the raw 32-byte pairing secret. */
  async authenticate(secret: Buffer, timeoutMs = 5000): Promise<void> {
    if (!this.welcomeData) throw new Error("connect() first");
    const message = `${this.welcomeData.nonce}|${this.welcomeData.instanceId}|${this.welcomeData.sessionId}`;
    const hmac = createHmac("sha256", secret).update(message, "utf8").digest("hex");
    const result = await this.exchangeHandshake({ kind: "auth", hmac }, timeoutMs);
    if (result.kind !== "authResult" || result.ok !== true) {
      const error = (result as { error?: RackMcpError }).error;
      this.close();
      throw new BridgeRequestError(
        error ?? {
          code: "AUTHENTICATION_FAILED",
          message: "authentication failed",
          retrySafe: false,
          mutationMayHaveOccurred: false,
        },
      );
    }
    this.startHeartbeat();
  }

  async request<T = unknown>(
    method: BridgeMethod,
    payload: unknown,
    opts: { deadlineMs?: number; operationId?: string } = {},
  ): Promise<T> {
    if (!this.socket || this.closed) throw new Error("not connected");
    const id = randomBytes(8).toString("hex");
    const deadlineMs = opts.deadlineMs ?? this.options.deadlineMs ?? LIMITS.commandTimeoutMs;
    const frame: Record<string, unknown> = { kind: "req", id, method, deadlineMs, payload };
    if (opts.operationId) frame.operationId = opts.operationId;
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeRequestError({
            code: "TIMEOUT",
            message: `bridge request ${method} timed out after ${deadlineMs}ms`,
            retrySafe: false,
            mutationMayHaveOccurred: true,
          }),
        );
      }, deadlineMs + 1000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    this.send(frame);
    return result;
  }

  close(): void {
    this.teardown(new Error("client closed"));
  }

  // -------------------------------------------------------------------------

  private send(frame: Record<string, unknown>): void {
    if (!this.socket) throw new Error("not connected");
    this.socket.write(encodeFrame(JSON.stringify(frame)));
  }

  private exchangeHandshake(
    frame: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("handshake timeout")), timeoutMs);
      this.handshakeQueue.push((incoming) => {
        clearTimeout(timer);
        resolve(incoming);
      });
      try {
        this.send(frame);
      } catch (e) {
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      try {
        this.send({ kind: "ping", id: randomBytes(8).toString("hex") });
      } catch {
        // teardown handles it
      }
    }, LIMITS.bridgeHeartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private onData(chunk: Buffer): void {
    if (!this.decoder.push(chunk)) {
      this.teardown(new Error("bridge frame decode error"));
      return;
    }
    let frame: string | null;
    while ((frame = this.decoder.next()) !== null) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(frame) as Record<string, unknown>;
      } catch {
        this.teardown(new Error("bridge sent invalid JSON"));
        return;
      }
      this.dispatch(parsed);
    }
    if (this.decoder.error) {
      this.teardown(new Error("bridge frame decode error"));
    }
  }

  private dispatch(frame: Record<string, unknown>): void {
    const kind = frame.kind;
    if (kind === "welcome" || kind === "authResult") {
      const waiter = this.handshakeQueue.shift();
      waiter?.(frame);
      return;
    }
    if (kind === "res") {
      const id = frame.id as string;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (frame.ok === true) {
        entry.resolve(frame.payload);
      } else {
        const error = frame.error as RackMcpError | undefined;
        entry.reject(
          new BridgeRequestError(
            error ?? {
              code: "INTERNAL",
              message: "malformed error response",
              retrySafe: false,
              mutationMayHaveOccurred: true,
            },
          ),
        );
      }
      return;
    }
    if (kind === "pong") return;
    if (kind === "evt") {
      this.onEvent?.(frame.event as string, frame.payload);
      return;
    }
  }

  private teardown(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
    this.handshakeQueue = [];
    this.onClose?.();
  }
}
