/**
 * Screenshot HOLD driver (not a test). Launches the installed VCV Rack 2.6.6
 * against an isolated user directory, builds the basic subtractive-synth recipe
 * through the real MCP server, brings Rack to the front, then HOLDS the window
 * open so a human can capture it (Cmd+Shift+4, Space, click the Rack window).
 * On SIGTERM/SIGINT it closes the MCP client and quits Rack cleanly.
 *
 *   pnpm --filter @rackmcp/integration run screenshot:hold
 */
import { spawnSync } from "node:child_process";
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
const scratch = process.env.RACKMCP_TEST_DIR ?? mkdtempSync(join(tmpdir(), "rackmcp-shot-"));

const log = (s: string) => process.stderr.write(s + "\n");
const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });
const sc = (r: unknown) => (r as { structuredContent: Record<string, unknown> }).structuredContent;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const harness = new RackHarness({ baseDir: scratch, name: "shot" });
harness.prepare();
harness.launch();
const client = new Client({ name: "rack-mcp-shot", version: "0.1.0" });
let transport: StdioClientTransport | null = null;
let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down: quitting Rack…");
  try { await client.close(); } catch { /* closed */ }
  await harness.quit();
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });

try {
  await harness.waitForInstance();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env, RACKMCP_RACK_USER_DIR: harness.userDir },
    stderr: "pipe",
  });
  await client.connect(transport);

  const insts = sc(await call(client, "list_rack_instances", {})).instances as Array<Record<string, unknown>>;
  const inst = insts.find((i) => !i.stale)!;
  await call(client, "select_rack_instance", { instanceId: inst.instanceId });
  const models = sc(await call(client, "list_installed_models", { limit: 300 }));
  const recipe = getRecipe("basic_mono_subtractive")!;
  const installed: InstalledModel[] = (models.models as Array<{ pluginSlug: string; modelSlug: string }>).map(
    (m) => ({ pluginSlug: m.pluginSlug, modelSlug: m.modelSlug }),
  );
  const resolution = resolveRecipe(recipe, installed);
  const ops = expandRecipeOperations(recipe, resolution);
  const built = sc(await call(client, "build_patch", { label: recipe.name, operations: ops, operationId: randomUUID() }));
  log(`build_patch: ${String(built.phase)} (${(built.commit as { applied?: unknown[] })?.applied?.length ?? ops.length} ops)`);

  // Let the GL window paint the new modules, then bring Rack to the front so
  // it's the obvious target for a window capture.
  await sleep(2500);
  spawnSync("open", ["-a", "VCV Rack 2 Pro"]);
  await sleep(1200);

  process.stdout.write(
    "\n========================================================================\n" +
      "READY — Rack is open with the built subtractive-synth patch.\n" +
      `  Rack PID: ${harness.rackPid}\n` +
      "  Capture just the window:  Cmd+Shift+4, then Space, then click the\n" +
      "  Rack window. macOS saves it to your Desktop as 'Screen Shot …png'.\n" +
      "  Rack will stay open until Claude signals shutdown.\n" +
      "========================================================================\n",
  );

  // Hold open until a signal arrives.
  await new Promise<void>(() => {});
} catch (e) {
  process.stderr.write("HOLD FAILURE: " + String(e) + "\n" + harness.logTail() + "\n");
  await harness.quit();
  process.exitCode = 1;
}
