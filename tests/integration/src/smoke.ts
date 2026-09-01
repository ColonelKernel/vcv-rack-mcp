/**
 * Phase 2/3 live smoke test: launch isolated Rack, discover, authenticate,
 * exercise leases + status.get + metrics.get, verify auth failure behavior.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeClient, BridgeRequestError, loadPairingSecret } from "@rackmcp/protocol";
import { RackHarness } from "./harness.js";

const scratch = process.env.RACKMCP_TEST_DIR ?? mkdtempSync(join(tmpdir(), "rackmcp-"));

function ok(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exitCode = 1;
  } else {
    console.error(`ok   ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const harness = new RackHarness({ baseDir: scratch, name: "smoke" });
harness.prepare();
console.error(`user dir: ${harness.userDir}`);
harness.launch();

try {
  const instance = await harness.waitForInstance();
  ok("discovery", true, `port ${instance.manifest.port} pid ${instance.manifest.pid}`);
  ok("manifest mode", instance.manifest.mode === "standalone-gui");
  ok("manifest has no secret", !JSON.stringify(instance.manifest).includes("secret"));

  const secret = loadPairingSecret(harness.rackmcpDir);

  // Wrong-secret auth must fail.
  {
    const bad = new BridgeClient({ clientName: "smoke-bad", clientVersion: "0" });
    await bad.connect(instance.manifest.port);
    let failed = false;
    try {
      await bad.authenticate(Buffer.alloc(32, 7));
    } catch (e) {
      failed = e instanceof BridgeRequestError && e.rpcError.code === "AUTHENTICATION_FAILED";
    }
    ok("wrong secret rejected", failed);
    bad.close();
  }

  const client = new BridgeClient({ clientName: "smoke", clientVersion: "0.1.0" });
  const welcome = await client.connect(instance.manifest.port);
  ok("welcome", welcome.rackVersion.startsWith("2.6"), welcome.rackVersion);
  await client.authenticate(secret);
  ok("authenticated", true);

  // Wait for the command pump (Bridge module widget must step once).
  let status: Record<string, unknown> | null = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      status = await client.request("status.get", {});
      break;
    } catch (e) {
      if (e instanceof BridgeRequestError && e.rpcError.code === "BRIDGE_NOT_READY") {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw e;
    }
  }
  ok("status.get", status !== null);
  if (status) {
    ok("status: pump present", status.commandPumpPresent === true);
    ok("status: bridge module present", status.bridgeModulePresent === true);
    ok("status: mode", status.mode === "standalone-gui");
    ok("status: epoch", status.patchEpoch === 1);
    ok(
      "status: sampleRate",
      typeof status.sampleRate === "number" && status.sampleRate > 0,
      String(status.sampleRate),
    );
    const lease = status.writerLease as Record<string, unknown>;
    ok("status: no lease initially", lease.held === false);
  }

  // Mutating call without lease -> WRITER_LEASE_REQUIRED (from network thread).
  {
    let code = "";
    try {
      await client.request("txn.commit", {}, { operationId: "6c5c48b2-3b0f-4f2a-9df9-1f4a30f10a10" });
    } catch (e) {
      if (e instanceof BridgeRequestError) code = e.rpcError.code;
    }
    ok("mutation without lease refused", code === "WRITER_LEASE_REQUIRED", code);
  }

  // Lease flow.
  const acquired = (await client.request("lease.acquire", { clientName: "smoke" })) as {
    leaseId: string;
  };
  ok("lease acquired", typeof acquired.leaseId === "string");
  const status2 = (await client.request("status.get", {})) as Record<string, unknown>;
  ok("status shows lease", (status2.writerLease as { held: boolean }).held === true);

  const metrics = (await client.request("metrics.get", {})) as Record<string, unknown>;
  ok("metrics.get", typeof metrics.requestsHandled === "number", JSON.stringify(metrics));

  await client.request("lease.release", { leaseId: acquired.leaseId });
  ok("lease released", true);

  client.close();
} catch (e) {
  console.error("SMOKE FAILURE:", e);
  console.error("Rack log tail:\n" + harness.logTail());
  process.exitCode = 1;
} finally {
  await harness.quit();
}
console.error(process.exitCode ? "SMOKE: FAILED" : "SMOKE: PASSED");
