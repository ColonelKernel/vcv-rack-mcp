/**
 * Phase 3/4 MCP-level test: launch the actual stdio MCP server as a subprocess,
 * connect with the MCP SDK client, and drive real tools against real Rack.
 * This is the spec's "supported MCP client can launch the server over stdio"
 * end-to-end path.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RackHarness } from "./harness.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const SERVER_ENTRY = join(REPO_ROOT, "apps", "mcp-server", "dist", "index.js");

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

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

const harness = new RackHarness({ baseDir: scratch, name: "mcp" });
harness.prepare();
harness.launch();

const client = new Client({ name: "rackmcp-test-client", version: "0.1.0" });
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
  ok("mcp connect over stdio", true);

  // Tool discovery: all 29 spec tools advertised with correct hints.
  const tools = await client.listTools();
  ok("lists 29 tools", tools.tools.length === 29, `${tools.tools.length}`);
  const snapshotTool = tools.tools.find((t) => t.name === "get_patch_snapshot");
  ok("snapshot tool is read-only", snapshotTool?.annotations?.readOnlyHint === true);
  const commitTool = tools.tools.find((t) => t.name === "commit_patch_transaction");
  ok("commit tool is destructive", commitTool?.annotations?.destructiveHint === true);

  // Discovery through the server.
  const listed = structured(await client.callTool({ name: "list_rack_instances", arguments: {} }));
  const instances = listed.instances as Array<Record<string, unknown>>;
  ok("server discovers instance", instances.length >= 1);
  const target = instances.find((i) => !i.stale);
  ok("has a live instance", target !== undefined);

  // Select it.
  const selected = structured(
    await client.callTool({ name: "select_rack_instance", arguments: { instanceId: target!.instanceId } }),
  );
  ok("select succeeds", selected.connected === true);

  // Status.
  const statusRes = structured(await client.callTool({ name: "get_rack_status", arguments: {} }));
  ok("status connected", statusRes.connected === true);
  const status = statusRes.status as Record<string, unknown>;
  ok("status rackVersion", status.rackVersion === "2.6.6", String(status.rackVersion));

  // Catalog.
  const catalog = structured(
    await client.callTool({ name: "list_installed_models", arguments: { limit: 10 } }),
  );
  ok("catalog via MCP", (catalog.total as number) > 10, `total ${catalog.total}`);

  // Snapshot.
  const snap = structured(await client.callTool({ name: "get_patch_snapshot", arguments: {} }));
  ok("snapshot via MCP", Array.isArray(snap.modules) && (snap.modules as unknown[]).length >= 1);

  // describe_patch (server-side analysis).
  const describe = structured(await client.callTool({ name: "describe_patch", arguments: {} }));
  ok("describe_patch summary", typeof describe.summary === "string" && (describe.summary as string).length > 0);
  ok("describe_patch warns no audio", (describe.warnings as string[]).some((w) => /audio/i.test(w)));

  // validate_patch (server-side structural).
  const validation = structured(await client.callTool({ name: "validate_patch", arguments: {} }));
  ok("validate_patch runs", Array.isArray(validation.findings));
  ok(
    "validate_patch flags missing audio destination",
    (validation.findings as Array<Record<string, unknown>>).some((f) => /audio/i.test(String(f.ruleId))),
  );

  // A tool that cannot proceed returns a structured error with a stable code:
  // save_patch with no path, against a patch that has never been saved, has
  // nowhere to write.
  const noPathResult = await client.callTool({
    name: "save_patch",
    arguments: { operationId: "6c5c48b2-3b0f-4f2a-9df9-1f4a30f10a10" },
  });
  ok("pathless save returns isError", (noPathResult as { isError?: boolean }).isError === true);
  const errStruct = structured(noPathResult).error as Record<string, unknown>;
  ok("pathless save error code", errStruct.code === "PATH_NOT_ALLOWED", String(errStruct?.code));
  ok("pathless save explains itself", /provide one/i.test(String(errStruct.message)), String(errStruct.message));

  // Lease acquire/release round trip via MCP.
  const lease = structured(await client.callTool({ name: "acquire_writer_lease", arguments: {} }));
  ok("acquire lease via MCP", typeof lease.leaseId === "string");
  const released = structured(await client.callTool({ name: "release_writer_lease", arguments: {} }));
  ok("release lease via MCP", released.released === true);

  await client.close();
} catch (e) {
  console.error("MCP SMOKE FAILURE:", e);
  console.error("Rack log tail:\n" + harness.logTail());
  failures++;
} finally {
  try {
    await client.close();
  } catch {
    // already closed
  }
  await harness.quit();
}
console.error(failures ? `MCP SMOKE: FAILED (${failures})` : "MCP SMOKE: PASSED");
process.exitCode = failures ? 1 : 0;
