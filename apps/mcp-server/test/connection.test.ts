import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "@rackmcp/protocol";
import { ConnectionManager } from "../src/connection.js";
import type { ServerConfig } from "../src/config.js";

/**
 * Drives the manager against loopback bridges and real discovery manifests:
 * the connect races it has to survive are only observable over a real socket.
 */

const INSTANCE_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const INSTANCE_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SESSION = "cccccccc-3333-4333-8333-cccccccccccc";

interface FakeBridge {
  port: number;
  /** One entry per accepted connection; the leak we guard against shows up here. */
  sockets: Socket[];
  server: Server;
}

let dir: string;
let config: ServerConfig;
let conn: ConnectionManager;
const bridges: FakeBridge[] = [];

/** A bridge that welcomes, optionally authenticates, and answers every req. */
async function startBridge(opts: { instanceId: string; authOk?: boolean }): Promise<FakeBridge> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    const decoder = new FrameDecoder();
    const send = (f: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(f)));
    };
    socket.on("data", (chunk) => {
      decoder.push(chunk);
      let raw: string | null;
      while ((raw = decoder.next()) !== null) {
        const frame = JSON.parse(raw) as Record<string, unknown>;
        if (frame.kind === "hello") {
          send({
            kind: "welcome",
            instanceId: opts.instanceId,
            sessionId: SESSION,
            bridgeVersion: "0.1.0",
            rackVersion: "2.6.6",
            rackEdition: "Free",
            patchEpoch: 1,
            nonce: "0f0f0f0f",
          });
        } else if (frame.kind === "auth") {
          if (opts.authOk === false) {
            send({
              kind: "authResult",
              ok: false,
              error: {
                code: "AUTHENTICATION_FAILED",
                message: "bad hmac",
                retrySafe: false,
                mutationMayHaveOccurred: false,
              },
            });
          } else {
            send({ kind: "authResult", ok: true });
          }
        } else if (frame.kind === "req") {
          send({ kind: "res", id: frame.id, ok: true, payload: {} });
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bridge: FakeBridge = { port: (server.address() as AddressInfo).port, sockets, server };
  bridges.push(bridge);
  return bridge;
}

function writeManifest(instanceId: string, port: number): void {
  const now = new Date().toISOString();
  writeFileSync(
    join(config.discoveryDir, `${instanceId}.json`),
    JSON.stringify({
      manifestVersion: 1,
      instanceId,
      pid: process.pid,
      rackVersion: "2.6.6",
      rackEdition: "Free",
      bridgeVersion: "0.1.0",
      bridgeProtocolVersion: 1,
      port,
      startTime: now,
      lastHeartbeat: now,
      mode: "standalone-gui",
      patchName: null,
      commandPumpPresent: true,
      bridgeModulePresent: true,
      userDir: config.rackUserDir,
      patchesDir: config.patchesDir,
      checkpointsDir: config.checkpointsDir,
    }),
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rackmcp-conn-"));
  const rackmcpDir = join(dir, "RackMCP");
  const discoveryDir = join(rackmcpDir, "instances");
  mkdirSync(discoveryDir, { recursive: true });
  writeFileSync(join(rackmcpDir, "secret"), `${"ab".repeat(32)}\n`);
  config = {
    rackUserDir: dir,
    rackmcpDir,
    discoveryDir,
    checkpointsDir: join(rackmcpDir, "checkpoints"),
    patchesDir: join(dir, "patches"),
    auditDir: join(rackmcpDir, "audit"),
    requestDeadlineMs: 2000,
  };
  conn = new ConnectionManager(config);
});

afterEach(async () => {
  conn.disconnect();
  for (const b of bridges.splice(0)) {
    for (const s of b.sockets) s.destroy();
    await new Promise<void>((resolve) => b.server.close(() => resolve()));
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("ConnectionManager connect serialization", () => {
  it("opens one bridge session for concurrent ensureConnected() calls", async () => {
    // The MCP SDK dispatches tool handlers concurrently; two overlapping
    // connects used to leave the loser's socket, heartbeat and lease orphaned
    // on the plugin, which caps out at 8 connections.
    const bridge = await startBridge({ instanceId: INSTANCE_A });
    writeManifest(INSTANCE_A, bridge.port);

    const [a, b] = await Promise.all([conn.ensureConnected(), conn.ensureConnected()]);
    expect(a.instanceId).toBe(INSTANCE_A);
    expect(b).toEqual(a);
    expect(bridge.sockets.length).toBe(1);
  });

  it("reconnects to the selected instance after the session drops", async () => {
    const bridge = await startBridge({ instanceId: INSTANCE_A });
    writeManifest(INSTANCE_A, bridge.port);
    await conn.select(INSTANCE_A);
    expect(bridge.sockets.length).toBe(1);

    for (const s of bridge.sockets) s.destroy();
    await waitFor(() => !conn.connected);

    await expect(conn.request("status.get", {})).resolves.toEqual({});
    expect(bridge.sockets.length).toBe(2);
  });
});

describe("ConnectionManager failed selection", () => {
  it("leaves nothing selected when the requested instance cannot be reached", async () => {
    const bridgeA = await startBridge({ instanceId: INSTANCE_A });
    const bridgeB = await startBridge({ instanceId: INSTANCE_B, authOk: false });
    writeManifest(INSTANCE_A, bridgeA.port);
    await conn.select(INSTANCE_A);
    expect(conn.selectedInstance?.instanceId).toBe(INSTANCE_A);

    writeManifest(INSTANCE_B, bridgeB.port);
    await expect(conn.select(INSTANCE_B)).rejects.toThrow(/AUTHENTICATION_FAILED/);

    // The user asked for B; silently falling back to A would operate on a
    // patch they did not choose.
    expect(conn.selectedInstance).toBeNull();
    expect(conn.connected).toBe(false);
    await expect(conn.ensureConnected()).rejects.toThrow(/instances available/);
  });
});
