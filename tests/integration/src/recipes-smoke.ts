/**
 * Phase 10 live test: exercise the adapter/recipe/validation/resource surface
 * against real Rack.
 *   - inspect_model reports adapter availability + version range from the pack
 *   - a recipe resolves against installed models, expands, and builds live
 *   - validate_patch / describe_patch run over the built patch
 *   - the six rack:// resources read back correctly
 *
 * Live voltages are not asserted (the harness-launched engine does not step; see
 * probe-smoke.ts) — this test covers the read/analysis/build plumbing only.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listAdapters, hasAdapter } from "@rackmcp/adapters";
import { getRecipe, resolveRecipe, expandRecipeOperations, type InstalledModel } from "@rackmcp/recipes";
import { RackHarness } from "./harness.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const SERVER_ENTRY = join(REPO_ROOT, "apps", "mcp-server", "dist", "index.js");
const scratch = process.env.RACKMCP_TEST_DIR ?? mkdtempSync(join(tmpdir(), "rackmcp-"));

let failures = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (!cond) { console.error(`FAIL ${name} ${detail}`); failures++; }
  else console.error(`ok   ${name}${detail ? ` (${detail})` : ""}`);
}
function sc(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}
async function readJsonResource(client: Client, uri: string): Promise<Record<string, unknown>> {
  const res = await client.readResource({ uri });
  const first = (res.contents as Array<{ text?: string }>)[0];
  return JSON.parse(first?.text ?? "{}") as Record<string, unknown>;
}

const harness = new RackHarness({ baseDir: scratch, name: "recipes" });
harness.prepare();
harness.launch();
const client = new Client({ name: "recipes-test", version: "0.1.0" });
let transport: StdioClientTransport | null = null;

try {
  await harness.waitForInstance();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env, RACKMCP_RACK_USER_DIR: harness.userDir },
    stderr: "pipe",
  });
  await client.connect(transport);
  const inst = sc(await call(client, "list_rack_instances", {})).instances as Array<Record<string, unknown>>;
  await call(client, "select_rack_instance", { instanceId: inst.find((i) => !i.stale)!.instanceId });

  // --- inspect_model adapter wiring ---
  const vcoMeta = sc(await call(client, "inspect_model", { pluginSlug: "Fundamental", modelSlug: "VCO" }));
  ok("inspect_model VCO reports adapter available", vcoMeta.adapterAvailable === true);
  ok("inspect_model VCO reports a version range", typeof vcoMeta.adapterVersionRange === "string" && (vcoMeta.adapterVersionRange as string).length > 0,
    String(vcoMeta.adapterVersionRange));

  // --- installed models + an unadaptered example ---
  const installed: InstalledModel[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 6; page++) {
    const res = sc(await call(client, "list_installed_models", { limit: 300, cursor: cursor ?? undefined }));
    for (const m of res.models as Array<{ pluginSlug: string; modelSlug: string }>) {
      installed.push({ pluginSlug: m.pluginSlug, modelSlug: m.modelSlug });
    }
    cursor = (res.nextCursor as string | null) ?? null;
    if (!cursor) break;
  }
  ok("list_installed_models returned models", installed.length > 0, `${installed.length}`);

  const unadaptered = installed.find((m) => !hasAdapter(m.pluginSlug, m.modelSlug));
  if (unadaptered) {
    const meta = sc(await call(client, "inspect_model", { pluginSlug: unadaptered.pluginSlug, modelSlug: unadaptered.modelSlug }));
    ok("inspect_model on an unadaptered model reports adapterAvailable=false",
      meta.adapterAvailable === false, `${unadaptered.pluginSlug}/${unadaptered.modelSlug}`);
  } else {
    ok("inspect_model on an unadaptered model reports adapterAvailable=false", true, "no unadaptered model installed; skipped");
  }

  // --- resolve + expand + build a recipe live ---
  const recipe = getRecipe("basic_mono_subtractive")!;
  const resolution = resolveRecipe(recipe, installed);
  ok("basic_mono_subtractive resolves against installed models", resolution.resolved === true,
    resolution.resolved ? "" : `unresolved: ${resolution.unresolvedRoles.map((u) => u.role).join(",")}`);

  if (resolution.resolved) {
    const ops = expandRecipeOperations(recipe, resolution);
    ok("no $role placeholder survives expansion",
      !ops.some((o) => o.op === "add_module" && (o as { pluginSlug: string }).pluginSlug === "$role"));
    const built = sc(await call(client, "build_patch", { label: "Recipe: basic mono", operations: ops, operationId: randomUUID() }));
    ok("recipe build committed", built.phase === "committed", String(built.phase));

    // --- validate + describe the built patch ---
    const val = sc(await call(client, "validate_patch", {}));
    const findings = (val.findings as Array<Record<string, unknown>>) ?? [];
    ok("validate_patch has no structural errors on the recipe patch",
      (val.errorCount as number) === 0, `errors=${val.errorCount}`);
    ok("validate_patch returns confidence-tagged findings",
      findings.every((f) => typeof f.confidence === "string" && ["certain", "adapter", "heuristic"].includes(f.confidence as string)));
    // The harness patch already contains a RackMCP-Bridge, so bridge persistence
    // must be detected as satisfied (no bridge.missing warning). The missing-Bridge
    // path is covered by the analysis unit tests.
    ok("validate_patch detects the present Bridge (no persistence warning)",
      !findings.some((f) => f.ruleId === "bridge.missing"));

    const desc = sc(await call(client, "describe_patch", {}));
    ok("describe_patch found a signal chain into the audio output",
      Array.isArray(desc.chains) && (desc.chains as unknown[]).length > 0);
  }

  // --- rack:// resources ---
  // Every body is an envelope: {state, uri, data, ...}. Contract conformance is
  // checked in contract-smoke; these are the behavioural assertions.
  const body = async (uri: string) => {
    const b = await readJsonResource(client, uri);
    ok(`${uri} reports state "ok"`, b.state === "ok", String(b.state));
    return (b.data ?? {}) as Record<string, unknown>;
  };

  const adaptersRes = await body("rack://adapters");
  ok("rack://adapters lists the full adapter pack",
    Array.isArray(adaptersRes.adapters) && (adaptersRes.adapters as unknown[]).length === listAdapters().length,
    `${(adaptersRes.adapters as unknown[])?.length}/${listAdapters().length}`);

  const recipesRes = await body("rack://recipes");
  const recipesList = recipesRes.recipes as Array<{ id: string }>;
  ok("rack://recipes lists all recipes", Array.isArray(recipesList) && recipesList.length === 8, `${recipesList?.length}`);
  const resolutions = recipesRes.resolutions as Record<string, { resolved: boolean }> | null;
  ok("rack://recipes includes live resolutions when connected",
    !!resolutions && resolutions["basic_mono_subtractive"]?.resolved === true);
  // A partial catalog scan makes an unresolved role a wrong answer rather than
  // a missing one, so the body has to say the scan finished.
  ok("rack://recipes resolved against the whole catalog", recipesRes.catalogComplete === true,
    `scanned ${recipesRes.modelsScanned} of ${recipesRes.totalModels}`);

  const statusRes = await body("rack://status");
  ok("rack://status reports connected", statusRes.connected === true);
  ok("rack://status carries no error next to a live status",
    statusRes.status !== null && statusRes.statusError === null);

  const catalogRes = await body("rack://catalog/models");
  ok("rack://catalog/models returns models", Array.isArray(catalogRes.models) && (catalogRes.models as unknown[]).length > 0);

  const patchRes = await body("rack://patch/current");
  ok("rack://patch/current returns a snapshot", Array.isArray((patchRes as { modules?: unknown[] }).modules));

  const auditRes = await body("rack://audit/recent");
  ok("rack://audit/recent returns entries", Array.isArray(auditRes.entries) && (auditRes.entries as unknown[]).length > 0);
  ok("rack://audit/recent parsed every line it read", auditRes.skipped === 0, `${auditRes.skipped} skipped`);

  await client.close();
} catch (e) {
  console.error("RECIPES SMOKE FAILURE:", e);
  console.error("Rack log tail:\n" + harness.logTail());
  failures++;
} finally {
  try { await client.close(); } catch { /* closed */ }
  await harness.quit();
}
console.error(failures ? `RECIPES SMOKE: FAILED (${failures})` : "RECIPES SMOKE: PASSED");
process.exitCode = failures ? 1 : 0;
