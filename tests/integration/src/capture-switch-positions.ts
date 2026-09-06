/**
 * Captures the DISPLAY NAME OF EVERY POSITION of each snapped two-position
 * switch on the Core/Fundamental models the adapter pack documents.
 *
 * `dump-metadata.ts` inspects a freshly instantiated model, so it only ever
 * sees the default position: `model-metadata.json` records that Fundamental
 * LFO paramId 0 "Offset" displays as `Unipolar`, and nothing about what 0
 * displays as. Three adapters were written from that gap and got the default
 * backwards -- documenting the LFO's outputs as bipolar "by default", VCA-1's
 * response curve as "exponential (default)", the Scope's trigger as "on by
 * default" -- while the complementary position names were inferred from the
 * parameter's name rather than measured.
 *
 * This walks each switch through both positions in a live Rack and records
 * what Rack itself renders, so the adapter test can check both halves of the
 * claim rather than only the half a default-state capture happens to reveal.
 *
 * Run: `pnpm --filter @rackmcp/integration exec tsx src/capture-switch-positions.ts`
 * Writes tests/fixtures/adapters/switch-positions.json (or --verify to check
 * the committed fixture still matches this machine's Rack without rewriting).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RackHarness } from "./harness.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const SERVER_ENTRY = join(REPO_ROOT, "apps", "mcp-server", "dist", "index.js");
const OUT = join(REPO_ROOT, "tests", "fixtures", "adapters", "switch-positions.json");
const VERIFY = process.argv.includes("--verify");

/**
 * Every snapped two-position switch on a documented model, derived from the
 * captured metadata rather than hand-listed -- a hand-listed set silently falls
 * behind when Fundamental gains a switch, and the adapter test's coverage check
 * would then fail with no way to fix it but editing this file.
 */
interface GtParam {
  paramId: number;
  name: string;
  minValue: number;
  maxValue: number;
  snapped: boolean;
}
interface GtModel {
  pluginSlug: string;
  modelSlug: string;
  params: GtParam[];
}
const METADATA: GtModel[] = JSON.parse(
  readFileSync(
    join(REPO_ROOT, "packages", "adapters", "test", "fixtures", "model-metadata.json"),
    "utf8",
  ),
);
/**
 * RackMCP's own modules are excluded, not skipped by accident.
 *
 * This script drives every switch it finds from one position to the other, and
 * RackMCP/Bridge paramId 0 is "Reset pairing secret" -- a momentary button
 * whose action rotates the pairing secret and restarts the bridge server. That
 * is the control channel this script is talking over: pressing it would sever
 * the connection mid-capture and leave the isolated Rack unreachable.
 *
 * A first version of this file did press it, and got away with it only because
 * the audio engine does not step under the automated harness, so
 * BridgeModule::process() -- which is what arms the trigger -- never ran. That
 * is an accident of the environment, not a guarantee. Do not press the buttons
 * of the module you are using as the control channel.
 */
const EXCLUDED_PLUGINS = new Set(["RackMCP"]);

const TARGETS: Array<{ pluginSlug: string; modelSlug: string; paramId: number }> = METADATA.filter(
  (m) => !EXCLUDED_PLUGINS.has(m.pluginSlug),
).flatMap((m) =>
  m.params
    .filter((p) => p.snapped && p.maxValue - p.minValue === 1)
    .map((p) => ({ pluginSlug: m.pluginSlug, modelSlug: m.modelSlug, paramId: p.paramId })),
);

interface Position {
  value: number;
  displayValue: string | null;
}
interface SwitchRecord {
  pluginSlug: string;
  modelSlug: string;
  paramId: number;
  name: string;
  minValue: number;
  maxValue: number;
  defaultValue: number;
  snapped: boolean;
  positions: Position[];
}

interface ParamS {
  paramId: number;
  name: string;
  value: number;
  minValue: number;
  maxValue: number;
  defaultValue: number;
  displayValue: string | null;
  snapped: boolean;
}

const scratch = process.env.RACKMCP_TEST_DIR ?? mkdtempSync(join(tmpdir(), "rackmcp-sw-"));
function sc(r: unknown): Record<string, unknown> {
  return (r as { structuredContent: Record<string, unknown> }).structuredContent;
}
const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

const harness = new RackHarness({ baseDir: scratch, name: "switches" });
harness.prepare();
harness.launch();
const client = new Client({ name: "switch-capture", version: "0.1.0" });
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
  const inst = sc(await call(client, "list_rack_instances", {})).instances as Array<
    Record<string, unknown>
  >;
  await call(client, "select_rack_instance", {
    instanceId: inst.find((i) => !i.stale)!.instanceId,
  });

  // One instance per distinct model, all in a single transaction.
  const models = [...new Set(TARGETS.map((t) => `${t.pluginSlug}/${t.modelSlug}`))];
  const built = sc(
    await call(client, "build_patch", {
      label: "Switch position capture",
      operationId: randomUUID(),
      operations: models.map((m, i) => ({
        op: "add_module",
        pluginSlug: m.split("/")[0],
        modelSlug: m.split("/")[1],
        alias: `m${i}`,
        placement: "auto",
      })),
    }),
  );
  if (built.phase !== "committed") throw new Error(`build_patch did not commit: ${String(built.phase)}`);
  const aliasToId = (built.commit as { aliasToModuleId: Record<string, string> }).aliasToModuleId;
  const idOf = new Map(models.map((m, i) => [m, aliasToId[`m${i}`]!]));

  async function paramsOf(moduleId: string): Promise<ParamS[]> {
    const m = sc(await call(client, "inspect_module", { moduleId })).module as { params: ParamS[] };
    return m.params;
  }

  const out: SwitchRecord[] = [];
  for (const t of TARGETS) {
    const key = `${t.pluginSlug}/${t.modelSlug}`;
    const moduleId = idOf.get(key)!;
    const base = (await paramsOf(moduleId)).find((p) => p.paramId === t.paramId);
    if (!base) throw new Error(`${key} has no paramId ${t.paramId}`);
    if (!base.snapped || base.maxValue - base.minValue !== 1) {
      throw new Error(
        `${key} p${t.paramId} is not a snapped two-position switch ` +
          `(snapped=${base.snapped}, range [${base.minValue}, ${base.maxValue}])`,
      );
    }

    const positions: Position[] = [];
    for (const value of [base.minValue, base.maxValue]) {
      const res = sc(
        await call(client, "build_patch", {
          label: `${key} p${t.paramId} = ${value}`,
          operationId: randomUUID(),
          operations: [{ op: "set_parameter", module: { moduleId }, paramId: t.paramId, value }],
        }),
      );
      if (res.phase !== "committed") {
        throw new Error(`set ${key} p${t.paramId}=${value} did not commit: ${String(res.phase)}`);
      }
      const now = (await paramsOf(moduleId)).find((p) => p.paramId === t.paramId)!;
      if (now.value !== value) {
        throw new Error(`${key} p${t.paramId} read back ${now.value}, expected ${value}`);
      }
      positions.push({ value, displayValue: now.displayValue });
      console.error(`  ${key} p${t.paramId} "${now.name}" = ${value} -> ${JSON.stringify(now.displayValue)}`);
    }
    // Leave the switch where Rack put it, so later targets on the same module
    // are read against an otherwise-default module.
    await call(client, "build_patch", {
      label: `${key} p${t.paramId} restore`,
      operationId: randomUUID(),
      operations: [
        { op: "set_parameter", module: { moduleId }, paramId: t.paramId, value: base.defaultValue },
      ],
    });

    out.push({
      pluginSlug: t.pluginSlug,
      modelSlug: t.modelSlug,
      paramId: t.paramId,
      name: base.name,
      minValue: base.minValue,
      maxValue: base.maxValue,
      defaultValue: base.defaultValue,
      snapped: base.snapped,
      positions,
    });
  }

  const text = JSON.stringify(out, null, 2) + "\n";
  if (VERIFY) {
    const committed = readFileSync(OUT, "utf8");
    if (committed !== text) {
      console.error("SWITCH POSITION FIXTURE DRIFT: live Rack disagrees with the committed fixture.");
      console.error("--- live ---\n" + text);
      process.exitCode = 1;
    } else {
      console.error(`fixture matches live Rack (${out.length} switches)`);
    }
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, text);
    console.error(`Wrote ${out.length} switch records to ${OUT}`);
  }
} catch (e) {
  console.error("SWITCH CAPTURE FAILURE:", e);
  console.error("Rack log tail:\n" + harness.logTail());
  process.exitCode = 1;
} finally {
  try {
    await client.close();
  } catch {
    /* closed */
  }
  await harness.quit();
}
