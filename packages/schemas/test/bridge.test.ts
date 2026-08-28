import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  BRIDGE_METHOD_NAMES,
  BRIDGE_METHODS,
  BridgeFrame,
  InstanceManifest,
} from "../src/bridge.js";
import { BRIDGE_PROTOCOL_VERSION } from "../src/limits.js";

describe("bridge frames", () => {
  it("parses a valid hello", () => {
    const r = BridgeFrame.safeParse({
      kind: "hello",
      versions: [1],
      client: { name: "rack-mcp-server", version: "0.1.0" },
    });
    expect(r.success).toBe(true);
  });

  it("parses a valid req and rejects bad methods", () => {
    const req = {
      kind: "req",
      id: "0123456789abcdef",
      method: "status.get",
      deadlineMs: 5000,
      payload: {},
    };
    expect(BridgeFrame.safeParse(req).success).toBe(true);
    expect(BridgeFrame.safeParse({ ...req, method: "rm -rf" }).success).toBe(false);
    expect(BridgeFrame.safeParse({ ...req, id: "xyz" }).success).toBe(false);
  });

  it("welcome pins the negotiated protocol version", () => {
    const welcome = {
      kind: "welcome",
      version: BRIDGE_PROTOCOL_VERSION,
      instanceId: "6c5c48b2-3b0f-4f2a-9df9-1f4a30f10a10",
      sessionId: "6c5c48b2-3b0f-4f2a-9df9-1f4a30f10a11",
      bridgeVersion: "0.1.0",
      rackVersion: "2.6.6",
      rackEdition: "Pro",
      patchEpoch: 1,
      nonce: "a".repeat(64),
      authRequired: true,
    };
    expect(BridgeFrame.safeParse(welcome).success).toBe(true);
    expect(BridgeFrame.safeParse({ ...welcome, version: 999 }).success).toBe(false);
  });

  it("every declared method has request and result schemas", () => {
    for (const m of BRIDGE_METHOD_NAMES) {
      const spec = BRIDGE_METHODS[m];
      expect(spec).toBeDefined();
      expect(typeof spec.mutating).toBe("boolean");
    }
    expect(Object.keys(BRIDGE_METHODS).sort()).toEqual([...BRIDGE_METHOD_NAMES].sort());
  });

  it("mutating methods are exactly the expected set", () => {
    const mutating = BRIDGE_METHOD_NAMES.filter((m) => BRIDGE_METHODS[m].mutating).sort();
    expect(mutating).toEqual(
      [
        "txn.commit",
        "txn.undoLast",
        "patchfile.save",
        "patchfile.saveCopy",
        "patchfile.load",
        "patchfile.clear",
      ].sort(),
    );
  });

  it("fuzz: arbitrary JSON never crashes the frame parser", () => {
    fc.assert(
      fc.property(fc.json(), (raw) => {
        BridgeFrame.safeParse(JSON.parse(raw));
      }),
      { numRuns: 500 },
    );
  });
});

describe("instance manifest", () => {
  const manifest = {
    manifestVersion: 1,
    instanceId: "6c5c48b2-3b0f-4f2a-9df9-1f4a30f10a10",
    pid: 1234,
    rackVersion: "2.6.6",
    rackEdition: "Pro",
    bridgeVersion: "0.1.0",
    bridgeProtocolVersion: 1,
    port: 51234,
    startTime: "2026-08-28T12:00:00Z",
    lastHeartbeat: "2026-08-28T12:00:02Z",
    mode: "standalone-gui",
    patchName: null,
    commandPumpPresent: true,
    bridgeModulePresent: true,
    userDir: "/tmp/rack",
    patchesDir: "/tmp/rack/patches",
    checkpointsDir: "/tmp/rack/RackMCP/checkpoints",
  };

  it("parses a valid manifest", () => {
    expect(InstanceManifest.safeParse(manifest).success).toBe(true);
  });

  it("never contains a secret field", () => {
    expect(InstanceManifest.safeParse({ ...manifest, secret: "deadbeef" }).success).toBe(false);
    expect(InstanceManifest.safeParse({ ...manifest, pairingSecret: "x" }).success).toBe(false);
  });

  it("rejects non-loopback-representable ports", () => {
    expect(InstanceManifest.safeParse({ ...manifest, port: 0 }).success).toBe(false);
    expect(InstanceManifest.safeParse({ ...manifest, port: 70000 }).success).toBe(false);
  });
});
