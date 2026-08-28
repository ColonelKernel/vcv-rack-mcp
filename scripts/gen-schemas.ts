/**
 * Emits canonical JSON Schema 2020-12 artifacts from the Zod source of truth
 * in packages/schemas. Committed under packages/schemas/json/; CI fails when
 * these are stale (`pnpm run check:gen`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BridgeFrame,
  BRIDGE_METHOD_NAMES,
  BRIDGE_METHODS,
  InstanceManifest,
  PatchOperation,
  PatchSnapshot,
  ProbeReading,
  ModuleAdapter,
  Recipe,
  RackMcpError,
  ValidationFinding,
  TOOLS,
} from "../packages/schemas/dist/index.js";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "schemas", "json");
mkdirSync(outDir, { recursive: true });

function emit(name: string, schema: z.ZodType, description: string): void {
  const js = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" });
  const doc = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://rackmcp.local/schemas/${name}.schema.json`,
    description,
    ...js,
  };
  writeFileSync(join(outDir, `${name}.schema.json`), JSON.stringify(doc, null, 2) + "\n");
  console.error(`wrote ${name}.schema.json`);
}

emit("bridge-frame", BridgeFrame, "Rack MCP bridge protocol frame (length-prefixed JSON over loopback TCP)");
emit("patch-operation", PatchOperation, "Rack MCP patch operation (discriminated union)");
emit("instance-manifest", InstanceManifest, "Rack MCP instance discovery manifest");
emit("patch-snapshot", PatchSnapshot, "Rack MCP patch snapshot");
emit("probe-reading", ProbeReading, "Rack MCP probe telemetry reading");
emit("module-adapter", ModuleAdapter, "Rack MCP module adapter document");
emit("recipe", Recipe, "Rack MCP recipe document");
emit("error", RackMcpError, "Rack MCP structured error");
emit("validation-finding", ValidationFinding, "Rack MCP validation finding");

// Bridge method payload/result schemas in one document.
{
  const methods: Record<string, unknown> = {};
  for (const m of BRIDGE_METHOD_NAMES) {
    const spec = BRIDGE_METHODS[m];
    methods[m] = {
      mutating: spec.mutating,
      request: z.toJSONSchema(spec.request as z.ZodType, { target: "draft-2020-12", unrepresentable: "any" }),
      result: z.toJSONSchema(spec.result as z.ZodType, { target: "draft-2020-12", unrepresentable: "any" }),
    };
  }
  const doc = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://rackmcp.local/schemas/bridge-methods.schema.json",
    description: "Request/result schema per bridge method",
    methods,
  };
  writeFileSync(join(outDir, "bridge-methods.schema.json"), JSON.stringify(doc, null, 2) + "\n");
  console.error("wrote bridge-methods.schema.json");
}

// MCP tool contracts in one document.
{
  const tools: Record<string, unknown> = {};
  for (const t of TOOLS) {
    tools[t.name] = {
      title: t.title,
      description: t.description,
      annotations: t.annotations,
      input: z.toJSONSchema(t.input as z.ZodType, { target: "draft-2020-12", unrepresentable: "any" }),
      output: z.toJSONSchema(t.output as z.ZodType, { target: "draft-2020-12", unrepresentable: "any" }),
    };
  }
  const doc = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://rackmcp.local/schemas/tools.schema.json",
    description: "Rack MCP tool contracts",
    tools,
  };
  writeFileSync(join(outDir, "tools.schema.json"), JSON.stringify(doc, null, 2) + "\n");
  console.error("wrote tools.schema.json");
}
