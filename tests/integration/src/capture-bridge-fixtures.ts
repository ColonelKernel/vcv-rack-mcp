/**
 * Captures a real response for every bridge method into tests/fixtures/bridge/,
 * so CI can check the wire contract on platforms that have no Rack.
 *
 * The tool-level gate (contract-smoke) needs live Rack on macOS, which means
 * the one class of defect it catches — a producer drifting away from its
 * declared schema — is invisible to CI on every platform. These fixtures close
 * that: packages/schemas/test/bridge-fixtures.test.ts strict-parses each one
 * against BRIDGE_METHODS[method].result, which until now was declared for all
 * 19 methods and used only by codegen. That catches drift from either side —
 * a producer that stops matching its schema, and a schema edit that stops
 * matching the real wire.
 *
 * Refresh with: pnpm --filter @rackmcp/integration run capture
 * (requires the installed Rack; the fixtures are committed).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { BridgeClient, BridgeRequestError, loadPairingSecret } from "@rackmcp/protocol";
import { BRIDGE_METHODS } from "@rackmcp/schemas";
import { RackHarness } from "./harness.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "bridge");
const scratch = process.env.RACKMCP_TEST_DIR ?? mkdtempSync(join(tmpdir(), "rackmcp-"));

let failures = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    failures++;
  } else {
    console.error(`ok   ${name}${detail ? ` (${detail})` : ""}`);
  }
}

/**
 * `--verify` re-captures and compares against the committed fixtures instead of
 * overwriting them. Comparison is structural: ids, fingerprints, epochs and
 * durations differ on every run, so a raw diff would always be dirty and would
 * therefore be ignored. Reducing each payload to its key/type skeleton makes a
 * producer that drops, renames or retypes a field fail loudly, while the noise
 * stays out. This is the half of the contract CI cannot see: the committed
 * fixtures are frozen files, so CI catches a schema edited away from the wire,
 * and this catches the wire drifting away from the fixtures.
 */
const VERIFY = process.argv.includes("--verify");

type Shape = string | Shape[] | { [k: string]: Shape };

function shapeOf(value: unknown): Shape {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (typeof value === "object") {
    const out: { [k: string]: Shape } = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = shapeOf((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return typeof value;
}

/**
 * An array empty on one side and populated on the other is a coverage
 * difference, not drift — the engine is idle under this harness, so telemetry
 * arrays come back empty. Report those separately rather than failing.
 */
function compareShapes(a: Shape, b: Shape, path: string, diffs: string[], notes: string[]): void {
  const aEmpty = Array.isArray(a) && a.length === 0;
  const bEmpty = Array.isArray(b) && b.length === 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (aEmpty !== bEmpty) {
      notes.push(`${path}: one side empty, the other populated`);
      return;
    }
    if (!aEmpty && !bEmpty) compareShapes(a[0]!, b[0]!, `${path}[]`, diffs, notes);
    return;
  }
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) diffs.push(`${path}.${k}: in the fixture, no longer on the wire`);
      else if (!(k in b)) diffs.push(`${path}.${k}: new on the wire, absent from the fixture`);
      else compareShapes(a[k]!, b[k]!, `${path}.${k}`, diffs, notes);
    }
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${path}: ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
}

const captured = new Set<string>();
const coverageNotes: string[] = [];

/**
 * Replaces this run's throwaway Rack user dir with a stable placeholder.
 *
 * These fixtures are committed to a public repository, and patchfile results
 * carry real absolute paths. On macOS the harness dir sits under
 * /var/folders/<hash>/T/, where the hash is derived from the user account --
 * nothing anyone needs, and not ours to publish. The schemas check the shape of
 * a path, not its value, so a placeholder tests exactly as well.
 */
function redactPaths(payload: unknown): unknown {
  const roots = [harness.userDir, scratch].filter((r) => r && r.length > 1);
  if (roots.length === 0) return payload;
  let text = JSON.stringify(payload);
  for (const root of roots) {
    text = text.split(JSON.stringify(root).slice(1, -1)).join("<RACK_USER_DIR>");
  }
  return JSON.parse(text);
}

function save(method: string, rawPayload: unknown): void {
  captured.add(method);
  const payload = redactPaths(rawPayload);
  const file = join(FIXTURE_DIR, `${method}.json`);
  if (!VERIFY) {
    writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  let committed: unknown;
  try {
    committed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    ok(`${method} has a committed fixture`, false, "missing — run without --verify to capture it");
    return;
  }
  const diffs: string[] = [];
  const notes: string[] = [];
  compareShapes(shapeOf(payload), shapeOf(committed), method, diffs, notes);
  coverageNotes.push(...notes);
  ok(`${method} still matches its committed fixture`, diffs.length === 0, diffs.join(" | "));
}

const harness = new RackHarness({ baseDir: scratch, name: "capture" });
harness.prepare();
harness.launch();

async function waitReady(client: BridgeClient): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      return (await client.request("status.get", {})) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof BridgeRequestError && e.rpcError.code === "BRIDGE_NOT_READY") {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw e;
    }
  }
  throw new Error("bridge never became ready");
}

try {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const instance = await harness.waitForInstance();
  const secret = loadPairingSecret(harness.rackmcpDir);
  const client = new BridgeClient({ clientName: "capture", clientVersion: "0.1.0" });
  await client.connect(instance.manifest.port);
  await client.authenticate(secret);

  // Read early for the scope, but do not record it: the fixture is captured
  // below with the writer lease held, which is the state that exercises
  // WriterLeaseInfo's optional fields.
  const status = await waitReady(client);
  const scope = () => ({
    instanceId: status.instanceId as string,
    sessionId: status.sessionId as string,
    patchEpoch: 1,
  });

  save("metrics.get", await client.request("metrics.get", {}));
  save("catalog.listModels", await client.request("catalog.listModels", { limit: 3 }));
  save(
    "catalog.inspectModel",
    await client.request("catalog.inspectModel", { pluginSlug: "Fundamental", modelSlug: "VCO" }),
  );
  save("patch.fingerprint", await client.request("patch.fingerprint", {}));

  // Writer lease: acquire, renew, and hold it for the mutating methods below.
  const lease = (await client.request("lease.acquire", { clientName: "capture" })) as {
    leaseId: string;
  };
  save("lease.acquire", lease);
  save("lease.renew", await client.request("lease.renew", { leaseId: lease.leaseId }));

  // Re-capture status while the lease is held: WriterLeaseInfo's optional
  // holder/expiry fields are absent from a lease-free status, so capturing only
  // the idle one would leave them unexercised.
  save("status.get", await client.request("status.get", {}));

  // A module to inspect, and a plan to preview and commit.
  const addOps = [
    { op: "add_module", pluginSlug: "Fundamental", modelSlug: "VCO", alias: "vco", placement: "auto" },
  ];
  const preview = (await client.request("txn.preview", {
    scope: scope(),
    label: "Capture fixture",
    operations: addOps,
  })) as { plan: unknown; planHash: string; baseFingerprint: string };
  save("txn.preview", preview);

  const commitOpId = randomUUID();
  const commit = (await client.request(
    "txn.commit",
    {
      scope: scope(),
      operationId: commitOpId,
      plan: preview.plan,
      planHash: preview.planHash,
      expectedFingerprint: preview.baseFingerprint,
    },
    { operationId: commitOpId },
  )) as { aliasToModuleId?: Record<string, string> };
  save("txn.commit", commit);

  // Read to locate the VCO; the recorded snapshot is taken further down, once a
  // cable exists, so CableSnapshot is exercised too.
  const snapshot = (await client.request("patch.snapshot", {})) as {
    modules: Array<{ moduleId: string; modelSlug: string }>;
  };
  const vco = snapshot.modules.find((m) => m.modelSlug === "VCO");
  ok("captured a VCO to inspect", vco !== undefined);
  if (vco) {
    save(
      "module.inspect",
      await client.request("module.inspect", { scope: scope(), moduleId: vco.moduleId }),
    );
  }

  // A Probe wired to the VCO. The cable matters: buildProbeList only emits
  // sourceModuleId/sourcePortId inside its `if (connected)` branch, so an
  // unconnected probe would leave those fields — and every populated
  // ProbeSlotInfo — out of the fixture entirely.
  const probePreview = (await client.request("txn.preview", {
    scope: scope(),
    label: "Capture probe",
    operations: [
      { op: "add_module", pluginSlug: "RackMCP", modelSlug: "Probe", alias: "probe", placement: "auto" },
      ...(vco
        ? [
            {
              op: "connect",
              output: { module: { moduleId: vco.moduleId }, portType: "output", portId: 0 },
              input: { module: { alias: "probe" }, portType: "input", portId: 0 },
              inputPolicy: "fail_if_connected",
            },
          ]
        : []),
    ],
  })) as { plan: unknown; planHash: string; baseFingerprint: string };
  const probeOpId = randomUUID();
  const probeCommit = (await client.request(
    "txn.commit",
    {
      scope: scope(),
      operationId: probeOpId,
      plan: probePreview.plan,
      planHash: probePreview.planHash,
      expectedFingerprint: probePreview.baseFingerprint,
    },
    { operationId: probeOpId },
  )) as { aliasToModuleId?: Record<string, string> };
  const probeModuleId = probeCommit.aliasToModuleId?.probe;
  ok("captured a Probe module", typeof probeModuleId === "string");
  // Now that a Probe exists and is cabled, its slots are worth recording.
  const probeList = (await client.request("probe.list", {})) as {
    slots: Array<{ connected: boolean }>;
  };
  save("probe.list", probeList);
  // Re-capture the snapshot now that a cable exists: taken before the probe was
  // wired, `cables` was empty and CableSnapshot went unexercised by the gate.
  const cabledSnapshot = (await client.request("patch.snapshot", {})) as { cables: unknown[] };
  save("patch.snapshot", cabledSnapshot);
  ok("snapshot fixture has a cable", cabledSnapshot.cables.length > 0, `${cabledSnapshot.cables.length}`);
  ok(
    "probe.list fixture has a connected slot",
    probeList.slots.some((sl) => sl.connected),
    `${probeList.slots.length} slots`,
  );
  if (probeModuleId) {
    save(
      "probe.read",
      await client.request("probe.read", {
        scope: scope(),
        probeModuleId,
        probeInputId: 0,
      }),
    );
  }

  // Chat methods. There is no way to type into the panel from here, so the
  // poll is captured empty first, then a reply is posted and the poll repeated
  // — which is also the only shape a client will ever see before the user has
  // said anything.
  save("chat.poll", await client.request("chat.poll", { scope: scope(), sinceSeq: 0 }));
  save(
    "chat.post",
    await client.request("chat.post", {
      scope: scope(),
      text: "captured by capture-bridge-fixtures",
      ackThroughSeq: 0,
    }),
  );

  // Patch-file methods. saveCopy leaves the current patch path alone; save,
  // load and clear each bump the epoch, so re-read the scope as we go.
  // Talking to the bridge directly skips the MCP server, which is what
  // normally ensures the patches root exists.
  mkdirSync(join(harness.userDir, "patches"), { recursive: true });
  const savePath = join(harness.userDir, "patches", "capture.vcv");
  const copyPath = join(harness.userDir, "patches", "capture-copy.vcv");
  save(
    "patchfile.saveCopy",
    await client.request(
      "patchfile.saveCopy",
      { scope: scope(), path: copyPath, operationId: randomUUID() },
      { operationId: randomUUID() },
    ),
  );
  save(
    "patchfile.save",
    await client.request(
      "patchfile.save",
      { scope: scope(), path: savePath, operationId: randomUUID() },
      { operationId: randomUUID() },
    ),
  );
  const cleared = (await client.request(
    "patchfile.clear",
    { scope: scope(), operationId: randomUUID() },
    { operationId: randomUUID() },
  )) as { patchEpoch?: number };
  save("patchfile.clear", cleared);
  const loadScope = { ...scope(), patchEpoch: cleared.patchEpoch ?? 1 };
  save(
    "patchfile.load",
    await client.request(
      "patchfile.load",
      { scope: loadScope, path: savePath, operationId: randomUUID() },
      { operationId: randomUUID() },
    ),
  );

  // txn.undoLast needs a transaction at the top of history: the load replaced
  // the patch, so make a fresh one and immediately undo it.
  const afterLoad = (await client.request("status.get", {})) as { patchEpoch: number };
  const undoScope = { ...scope(), patchEpoch: afterLoad.patchEpoch };
  const undoPrev = (await client.request("txn.preview", {
    scope: undoScope,
    label: "Capture undo",
    operations: addOps,
  })) as { plan: unknown; planHash: string; baseFingerprint: string };
  const undoTarget = randomUUID();
  await client.request(
    "txn.commit",
    {
      scope: undoScope,
      operationId: undoTarget,
      plan: undoPrev.plan,
      planHash: undoPrev.planHash,
      expectedFingerprint: undoPrev.baseFingerprint,
    },
    { operationId: undoTarget },
  );
  save(
    "txn.undoLast",
    await client.request(
      "txn.undoLast",
      { scope: undoScope, expectedOperationId: undoTarget, operationId: randomUUID() },
      { operationId: randomUUID() },
    ),
  );

  save("lease.release", await client.request("lease.release", { leaseId: lease.leaseId }));

  // Coverage: a method with no fixture is a silent hole in the CI check.
  const missing = Object.keys(BRIDGE_METHODS).filter((m) => !captured.has(m));
  ok(
    `captured every bridge method (${captured.size}/${Object.keys(BRIDGE_METHODS).length})`,
    missing.length === 0,
    missing.join(", "),
  );

  client.close();
} catch (e) {
  console.error("CAPTURE FAILURE:", e);
  console.error("Rack log tail:\n" + harness.logTail());
  failures++;
} finally {
  await harness.quit();
}
console.error(failures ? `BRIDGE CAPTURE: FAILED (${failures})` : "BRIDGE CAPTURE: PASSED");
process.exitCode = failures ? 1 : 0;
