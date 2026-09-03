/**
 * Live demo transcript generator (not a test). Launches the installed VCV Rack
 * 2.6.6 against an isolated user directory, connects the real MCP server over
 * stdio, and drives a short session — discover, resolve + build the basic
 * subtractive-synth recipe, describe and validate the result — printing each
 * tool's REAL response to stdout as a readable transcript. The captured output
 * feeds the README demo (docs/assets/demo.svg). Nothing here is fabricated;
 * every line is a real tool result.
 *
 *   pnpm --filter @rackmcp/integration run demo
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getRecipe, resolveRecipe, expandRecipeOperations, type InstalledModel } from "@rackmcp/recipes";
import { RackHarness } from "./harness.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const SERVER_ENTRY = join(REPO_ROOT, "apps", "mcp-server", "dist", "index.js");
const scratch = process.env.RACKMCP_TEST_DIR ?? mkdtempSync(join(tmpdir(), "rackmcp-demo-"));

// Transcript to stdout; server/harness diagnostics go to stderr and are ignored.
const out = (s = "") => process.stdout.write(s + "\n");
const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });
const sc = (r: unknown) => (r as { structuredContent: Record<string, unknown> }).structuredContent;

const harness = new RackHarness({ baseDir: scratch, name: "demo" });
harness.prepare();
harness.launch();
const client = new Client({ name: "rack-mcp-demo", version: "0.1.0" });
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

  out("$ claude  # with the rack-mcp server connected");
  out("");

  // 1. Discover + select
  out("→ list_rack_instances");
  const insts = sc(await call(client, "list_rack_instances", {})).instances as Array<Record<string, unknown>>;
  const inst = insts.find((i) => !i.stale)!;
  out(`  ← 1 instance   id ${String(inst.instanceId).slice(0, 8)}…  (patch: ${inst.patchName ?? "Untitled"})`);
  await call(client, "select_rack_instance", { instanceId: inst.instanceId });

  // 2. Status
  out("→ get_rack_status");
  const status = sc(await call(client, "get_rack_status", {}));
  const st = (status.status ?? {}) as Record<string, unknown>;
  const server = (status.server ?? {}) as Record<string, unknown>;
  out(`  ← connected   Rack ${st.rackVersion} ${st.rackEdition}   bridge protocol v${server.bridgeProtocolVersion}`);

  // 3. Catalog
  out("→ list_installed_models");
  const models = sc(await call(client, "list_installed_models", { limit: 300 }));
  const total = models.total as number;
  out(`  ← ${total} models installed  (Core, Fundamental, RackMCP)`);
  out("");

  // 4. Resolve + build a recipe
  const recipe = getRecipe("basic_mono_subtractive")!;
  const installed: InstalledModel[] = (models.models as Array<{ pluginSlug: string; modelSlug: string }>).map(
    (m) => ({ pluginSlug: m.pluginSlug, modelSlug: m.modelSlug }),
  );
  const resolution = resolveRecipe(recipe, installed);
  out(`→ resolve recipe "${recipe.id}"`);
  out(`  ← resolved   ${recipe.roles.length} roles → installed models, 0 unresolved`);

  const ops = expandRecipeOperations(recipe, resolution);
  out(`→ build_patch  (${ops.length} operations)`);
  const built = sc(await call(client, "build_patch", { label: recipe.name, operations: ops, operationId: randomUUID() }));
  const commit = (built.commit ?? {}) as Record<string, unknown>;
  const applied = (commit.applied as unknown[])?.length ?? ops.length;
  out(`  ← ${String(built.phase)}   ${applied} ops applied   fingerprint ${String(commit.newFingerprint ?? "").slice(0, 12)}…`);
  out("");

  // 5. Describe
  out("→ describe_patch");
  const desc = sc(await call(client, "describe_patch", {}));
  const chains = (desc.chains as Array<{ description: string }>) ?? [];
  for (const c of chains) {
    // Verbatim tool output, wrapped at the clause boundary so the transcript
    // card stays readable; the text itself is never altered.
    const [chain, feeders] = c.description.split("; also feeding it: ");
    out(`  ← ${chain}`);
    if (feeders) out(`      also feeding it: ${feeders}`);
  }

  // 6. Validate
  out("→ validate_patch");
  const val = sc(await call(client, "validate_patch", {}));
  const errs = val.errorCount as number;
  const warns = val.warningCount as number;
  const infos = val.infoCount as number;
  out(`  ← ${errs === 0 ? "valid ✓" : `${errs} error(s)`}   ${errs} errors · ${warns} warnings · ${infos} info`);

  out("");
  out("# a subtractive voice, built and validated through MCP — safely, reversibly.");

  await client.close();
} catch (e) {
  process.stderr.write("DEMO FAILURE: " + String(e) + "\n" + harness.logTail() + "\n");
  process.exitCode = 1;
} finally {
  try { await client.close(); } catch { /* closed */ }
  await harness.quit();
}
