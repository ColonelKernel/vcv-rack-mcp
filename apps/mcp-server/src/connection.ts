import { BridgeClient, BridgeRequestError, loadPairingSecret, scanInstances } from "@rackmcp/protocol";
import type { BridgeMethod } from "@rackmcp/schemas";
import type { ServerConfig } from "./config.js";
import { ToolError } from "./errors.js";
import { log } from "./logger.js";

export interface SelectedInstance {
  instanceId: string;
  sessionId: string;
  rackVersion: string;
  rackEdition: string;
  port: number;
  pid: number;
}

/**
 * Owns the selected Rack instance and its authenticated bridge session.
 * All tools go through request(); the manager attaches nothing to the wire
 * beyond what the bridge needs and normalizes disconnects.
 */
export class ConnectionManager {
  private client: BridgeClient | null = null;
  private selected: SelectedInstance | null = null;
  private leaseId: string | null = null;
  /** Tail of the connect chain; serializes every connect/authenticate attempt. */
  private connectChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: ServerConfig) {}

  get selectedInstance(): SelectedInstance | null {
    return this.selected;
  }
  get connected(): boolean {
    return this.client?.isConnected ?? false;
  }
  get hasWriterLease(): boolean {
    return this.leaseId !== null;
  }

  listInstances() {
    return scanInstances(this.config.discoveryDir);
  }

  async select(instanceId: string): Promise<SelectedInstance> {
    const selected = await this.runExclusive(() => this.connectTo(instanceId));
    // The command pump attaches a frame or two after Rack's Bridge widget
    // first steps; status/inspection requests return BRIDGE_NOT_READY until
    // then. Wait briefly so a freshly launched instance is usable on return.
    // Outside the connect lock: this issues requests that re-enter
    // ensureConnected().
    await this.waitForReady(15000).catch(() => {
      log.warn("command pump not ready within timeout after select", {
        instanceId: selected.instanceId,
      });
    });
    return selected;
  }

  /**
   * Serializes connect attempts. Two overlapping ones would each build a
   * BridgeClient and the loser would be orphaned: its socket, heartbeat and
   * any writer lease it acquired stay alive on the plugin with nothing
   * referencing them.
   */
  private runExclusive(fn: () => Promise<SelectedInstance>): Promise<SelectedInstance> {
    const run = this.connectChain.then(fn, fn);
    this.connectChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Connects and authenticates. Runs under the connect lock; issues no requests. */
  private async connectTo(instanceId: string): Promise<SelectedInstance> {
    // A concurrent caller may have connected while we waited for the lock.
    if (this.client?.isConnected && this.selected?.instanceId === instanceId) {
      return this.selected;
    }
    const found = this.listInstances().find((i) => i.manifest.instanceId === instanceId);
    if (!found) {
      throw new ToolError("RACK_NOT_FOUND", `no discoverable Rack instance ${instanceId}`, true);
    }
    if (found.stale) {
      throw new ToolError("RACK_DISCONNECTED", `instance ${instanceId} is stale (no heartbeat)`, true);
    }
    // Drop any prior session, selection included: a failed connect must not
    // leave the previous instance selected, or later calls would silently
    // reconnect to an instance the caller did not ask for.
    this.disconnect();
    this.selected = null;

    let secret: Buffer;
    try {
      secret = loadPairingSecret(this.config.rackmcpDir);
    } catch (e) {
      throw new ToolError("AUTHENTICATION_FAILED", `cannot read pairing secret: ${String(e)}`, false);
    }

    const client = new BridgeClient({ clientName: "rack-mcp-server", clientVersion: "0.1.0" });
    client.onClose = () => {
      log.warn("bridge session closed", { instanceId });
      if (this.client === client) {
        this.client = null;
        this.leaseId = null;
      }
    };
    client.onEvent = (event) => {
      log.info("bridge event", { event, instanceId });
      if (event === "shutting_down") this.disconnect();
    };

    const welcome = await client.connect(found.manifest.port);
    await client.authenticate(secret);
    // Scrub the secret copy.
    secret.fill(0);

    this.client = client;
    this.selected = {
      instanceId: welcome.instanceId,
      sessionId: welcome.sessionId,
      rackVersion: welcome.rackVersion,
      rackEdition: welcome.rackEdition,
      port: found.manifest.port,
      pid: found.manifest.pid,
    };
    log.info("selected instance", { instanceId: welcome.instanceId, port: found.manifest.port });
    return this.selected;
  }

  /**
   * Polls status.get, swallowing the transient BRIDGE_NOT_READY that occurs
   * while the command pump is attaching. Resolves once the pump responds;
   * rejects on timeout (e.g. a patch with no Bridge module, hence no pump).
   */
  async waitForReady(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.request("status.get", {});
        return;
      } catch (e) {
        const notReady = e instanceof BridgeRequestError && e.rpcError.code === "BRIDGE_NOT_READY";
        if (!notReady || Date.now() >= deadline) throw e;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  /** Auto-selects when exactly one live instance exists; else throws. */
  async ensureConnected(): Promise<SelectedInstance> {
    if (this.client?.isConnected && this.selected) return this.selected;
    if (this.selected) {
      // Reconnect to the previously selected instance.
      return this.select(this.selected.instanceId);
    }
    const live = this.listInstances().filter((i) => !i.stale);
    if (live.length === 0) {
      throw new ToolError("RACK_NOT_FOUND", "no running Rack instance with the RackMCP bridge", true);
    }
    if (live.length > 1) {
      throw new ToolError(
        "INSTANCE_NOT_SELECTED",
        `${live.length} instances available; call select_rack_instance first`,
        false,
        false,
        { instanceIds: live.map((i) => i.manifest.instanceId) },
      );
    }
    return this.select(live[0]!.manifest.instanceId);
  }

  async request<T = unknown>(
    method: BridgeMethod,
    payload: unknown,
    opts: { operationId?: string; deadlineMs?: number } = {},
  ): Promise<T> {
    const instance = await this.ensureConnected();
    if (!this.client) throw new ToolError("RACK_DISCONNECTED", "bridge session lost", true);
    void instance;
    const reqOpts: { operationId?: string; deadlineMs?: number } = {
      deadlineMs: opts.deadlineMs ?? this.config.requestDeadlineMs,
    };
    if (opts.operationId !== undefined) reqOpts.operationId = opts.operationId;
    return this.client.request<T>(method, payload, reqOpts);
  }

  async acquireLease(): Promise<{ leaseId: string; expiresInMs: number }> {
    const res = await this.request<{ leaseId: string; expiresInMs: number }>("lease.acquire", {
      clientName: "rack-mcp-server",
    });
    this.leaseId = res.leaseId;
    return res;
  }

  async releaseLease(): Promise<boolean> {
    if (!this.leaseId) return false;
    await this.request("lease.release", { leaseId: this.leaseId });
    this.leaseId = null;
    return true;
  }

  /** Refreshes the lease before a mutation; acquires if not yet held. */
  async ensureLease(): Promise<void> {
    if (this.leaseId) {
      try {
        await this.request("lease.renew", { leaseId: this.leaseId });
        return;
      } catch {
        this.leaseId = null;
      }
    }
    await this.acquireLease();
  }

  disconnect(): void {
    this.leaseId = null;
    this.client?.close();
    this.client = null;
  }
}
