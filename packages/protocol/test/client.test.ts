import { afterEach, describe, expect, it } from "vitest";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { LIMITS } from "@rackmcp/schemas";
import { BridgeClient, BridgeRequestError } from "../src/client.js";
import { encodeFrame, FrameDecoder } from "../src/framing.js";

/**
 * The client speaks TCP, so these tests drive it against a real loopback
 * server: socket teardown and mid-request loss cannot be faked honestly.
 */

type FrameHandler = (
  socket: Socket,
  frame: Record<string, unknown>,
  send: (f: Record<string, unknown>) => void,
) => void;

const WELCOME: Record<string, unknown> = {
  kind: "welcome",
  instanceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  bridgeVersion: "0.1.0",
  rackVersion: "2.6.6",
  rackEdition: "Free",
  patchEpoch: 1,
  nonce: "0f0f0f0f",
};

/** Answers hello/auth; leaves everything else to the caller's handler. */
const handshake: FrameHandler = (_socket, frame, send) => {
  if (frame.kind === "hello") send(WELCOME);
  else if (frame.kind === "auth") send({ kind: "authResult", ok: true });
};

interface FakeBridge {
  port: number;
  sockets: Socket[];
  server: Server;
}

const bridges: FakeBridge[] = [];
const clients: BridgeClient[] = [];

/** Starts a loopback bridge. A null handler closes every connection at once. */
async function startBridge(onFrame: FrameHandler | null): Promise<FakeBridge> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    if (!onFrame) {
      socket.destroy();
      return;
    }
    const decoder = new FrameDecoder();
    const send = (f: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(f)));
    };
    socket.on("data", (chunk) => {
      decoder.push(chunk);
      let raw: string | null;
      while ((raw = decoder.next()) !== null) {
        onFrame(socket, JSON.parse(raw) as Record<string, unknown>, send);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bridge: FakeBridge = { port: (server.address() as AddressInfo).port, sockets, server };
  bridges.push(bridge);
  return bridge;
}

function newClient(): BridgeClient {
  const c = new BridgeClient({ clientName: "test", clientVersion: "0.0.0" });
  clients.push(c);
  return c;
}

/** In-flight request bookkeeping, asserted directly so cleanup is observable. */
function pendingCount(client: BridgeClient): number {
  return (client as unknown as { pending: Map<string, unknown> }).pending.size;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const b of bridges.splice(0)) {
    for (const s of b.sockets) s.destroy();
    await new Promise<void>((resolve) => b.server.close(() => resolve()));
  }
});

describe("BridgeClient handshake", () => {
  it("connects, authenticates and round trips a request", async () => {
    const bridge = await startBridge((socket, frame, send) => {
      handshake(socket, frame, send);
      if (frame.kind === "req")
        send({ kind: "res", id: frame.id, ok: true, payload: { ready: true } });
    });
    const client = newClient();
    const welcome = await client.connect(bridge.port);
    expect(welcome.instanceId).toBe(WELCOME.instanceId);
    await client.authenticate(Buffer.alloc(32, 7));
    await expect(client.request("status.get", {})).resolves.toEqual({ ready: true });
  });

  it("fails the handshake with the close reason instead of waiting out the timeout", async () => {
    // Mirrors the plugin refusing a connection at maxConnections: it accepts,
    // then closes without ever sending a welcome frame.
    const bridge = await startBridge(null);
    const client = newClient();
    const started = Date.now();
    const err = await client.connect(bridge.port, 3000).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/bridge connection (closed|error)/);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("BridgeClient teardown", () => {
  it("reports an in-flight request lost with the socket as an unknown outcome", async () => {
    // The pump may already have executed the command; only the res frame was
    // lost. Claiming otherwise would break the spec section 12 retry contract.
    const bridge = await startBridge((socket, frame, send) => {
      handshake(socket, frame, send);
      if (frame.kind === "req") socket.destroy();
    });
    const client = newClient();
    await client.connect(bridge.port);
    await client.authenticate(Buffer.alloc(32, 7));

    const err = await client.request("txn.commit", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeRequestError);
    const rpc = (err as BridgeRequestError).rpcError;
    expect(rpc.code).toBe("RACK_DISCONNECTED");
    expect(rpc.mutationMayHaveOccurred).toBe(true);
    expect(rpc.retrySafe).toBe(false);
    expect(pendingCount(client)).toBe(0);
  });

  it("rejects an explicit close() the same way", async () => {
    const bridge = await startBridge(handshake);
    const client = newClient();
    await client.connect(bridge.port);
    await client.authenticate(Buffer.alloc(32, 7));
    const inFlight = client.request("txn.commit", {});
    client.close();
    const err = await inFlight.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeRequestError);
    expect((err as BridgeRequestError).rpcError.mutationMayHaveOccurred).toBe(true);
  });
});

describe("BridgeClient request", () => {
  it("drops the pending entry and its timer when the frame cannot be sent", async () => {
    const bridge = await startBridge(handshake);
    const client = newClient();
    await client.connect(bridge.port);

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const oversize = { blob: "x".repeat(LIMITS.bridgeFrameBytes + 16) };
      await expect(client.request("txn.commit", oversize, { deadlineMs: 50 })).rejects.toThrow(
        /frame exceeds/,
      );
      expect(pendingCount(client)).toBe(0);
      // Past the deadline timer (deadlineMs + 1000) the abandoned promise
      // would otherwise reject with nobody listening.
      await new Promise((r) => setTimeout(r, 1300));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
