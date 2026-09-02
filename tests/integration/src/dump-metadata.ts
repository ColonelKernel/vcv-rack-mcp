/**
 * Dev utility: dump verified param/port metadata for all Core + Fundamental
 * models from a live Rack 2.6.6 via inspect_model. This is the provenance source
 * for the adapter pack (packages/adapters) — adapters must only claim semantics
 * for parameters/ports that exist here. Run: `pnpm exec tsx src/dump-metadata.ts`
 * (writes model-metadata.json in the CWD, or RACKMCP_METADATA_OUT).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RackHarness } from "./harness.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const SERVER_ENTRY = join(REPO_ROOT, "apps", "mcp-server", "dist", "index.js");
const scratch = mkdtempSync(join(tmpdir(), "rackmcp-meta-"));
const OUT = process.env.RACKMCP_METADATA_OUT ?? join(process.cwd(), "model-metadata.json");
const PLUGINS = new Set(["Core", "Fundamental", "RackMCP"]);

function sc(r: unknown): Record<string, unknown> {
  return (r as { structuredContent: Record<string, unknown> }).structuredContent;
}
const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

const harness = new RackHarness({ baseDir: scratch, name: "meta" });
harness.prepare();
harness.launch();
const client = new Client({ name: "meta-dump", version: "0.1.0" });
let transport: StdioClientTransport | null = null;

try {
  await harness.waitForInstance();
  transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER_ENTRY],
    env: { ...process.env, RACKMCP_RACK_USER_DIR: harness.userDir }, stderr: "pipe",
  });
  await client.connect(transport);
  const inst = sc(await call(client, "list_rack_instances", {})).instances as Array<Record<string, unknown>>;
  await call(client, "select_rack_instance", { instanceId: inst.find((i) => !i.stale)!.instanceId });

  // Enumerate all models, following pagination.
  const models: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  do {
    const page = sc(await call(client, "list_installed_models", { limit: 100, ...(cursor ? { cursor } : {}) }));
    models.push(...(page.models as Array<Record<string, unknown>>));
    cursor = (page.nextCursor as string | null) ?? null;
  } while (cursor);

  const targets = models.filter((m) => PLUGINS.has(m.pluginSlug as string));
  console.error(`Found ${models.length} models total, ${targets.length} in ${[...PLUGINS].join("/")}`);

  const out: Record<string, unknown>[] = [];
  for (const m of targets) {
    const meta = sc(await call(client, "inspect_model", {
      pluginSlug: m.pluginSlug, modelSlug: m.modelSlug,
    }));
    out.push({
      pluginSlug: m.pluginSlug, modelSlug: m.modelSlug, modelName: m.modelName,
      pluginVersion: (meta.model as any)?.pluginVersion ?? m.pluginVersion,
      description: m.description, tags: m.tags,
      params: meta.params, inputs: meta.inputs, outputs: meta.outputs,
    });
    console.error(`  inspected ${m.pluginSlug}/${m.modelSlug} — ${(meta.params as unknown[]).length}p ${(meta.inputs as unknown[]).length}in ${(meta.outputs as unknown[]).length}out`);
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(`Wrote ${out.length} model metadata records to ${OUT}`);
} catch (e) {
  console.error("METADATA DUMP FAILURE:", e);
  console.error("Rack log tail:\n" + harness.logTail());
  process.exitCode = 1;
} finally {
  try { await client.close(); } catch { /* closed */ }
  await harness.quit();
}
