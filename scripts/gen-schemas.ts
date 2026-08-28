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

type IoMode = "input" | "output";

function toSchema(schema: z.ZodType, io: IoMode): Record<string, unknown> {
  // io:"input" keeps `.default()` fields optional on the wire (they are filled
  // in at parse time); io:"output" marks them required. Request-side schemas
  // must always be emitted in input mode.
  return z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any", io }) as Record<
    string,
    unknown
  >;
}

function emit(name: string, schema: z.ZodType, description: string, io: IoMode): void {
  const js = toSchema(schema, io);
  if (name === "patch-operation") augmentOperationInvariants(js);
  const doc = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://rackmcp.local/schemas/${name}.schema.json`,
    description,
    ...js,
  };
  writeFileSync(join(outDir, `${name}.schema.json`), JSON.stringify(doc, null, 2) + "\n");
  console.error(`wrote ${name}.schema.json`);
}

/**
 * Zod refine() invariants are not representable by z.toJSONSchema. Re-encode
 * the three cross-field invariants of the PatchOperation union explicitly so
 * downstream validators (and the C++ tables' consumers) see them:
 *  - set_parameter: exactly one of value | normalized | display
 *  - add_module / duplicate_module: position required when placement == "at"
 * The C++ plugin additionally hand-implements these checks (opvalidate).
 */
function augmentOperationInvariants(js: Record<string, unknown>): void {
  const variants = (js.anyOf ?? js.oneOf) as Array<Record<string, unknown>> | undefined;
  if (!variants) throw new Error("patch-operation schema has no union variants");
  const exactlyOne = {
    oneOf: [
      { required: ["value"], not: { anyOf: [{ required: ["normalized"] }, { required: ["display"] }] } },
      { required: ["normalized"], not: { anyOf: [{ required: ["value"] }, { required: ["display"] }] } },
      { required: ["display"], not: { anyOf: [{ required: ["value"] }, { required: ["normalized"] }] } },
    ],
  };
  const positionWhenAt = {
    if: { properties: { placement: { const: "at" } }, required: ["placement"] },
    then: { required: ["position"] },
  };
  let augmented = 0;
  for (const v of variants) {
    const props = v.properties as Record<string, { const?: unknown }> | undefined;
    const op = props?.op?.const;
    if (op === "set_parameter") {
      v.allOf = [...((v.allOf as unknown[]) ?? []), exactlyOne];
      augmented++;
    }
    if (op === "add_module" || op === "duplicate_module") {
      v.allOf = [...((v.allOf as unknown[]) ?? []), positionWhenAt];
      augmented++;
    }
  }
  if (augmented !== 3) throw new Error(`expected to augment 3 operation variants, got ${augmented}`);
}

// Input mode: schemas validating data ARRIVING at a boundary (client frames,
// operations, adapter/recipe documents). Output mode: schemas describing data
// PRODUCED by this system (snapshots, telemetry, errors, manifests).
emit("bridge-frame", BridgeFrame, "Rack MCP bridge protocol frame (length-prefixed JSON over loopback TCP)", "input");
emit("patch-operation", PatchOperation, "Rack MCP patch operation (discriminated union)", "input");
emit("instance-manifest", InstanceManifest, "Rack MCP instance discovery manifest", "output");
emit("patch-snapshot", PatchSnapshot, "Rack MCP patch snapshot", "output");
emit("probe-reading", ProbeReading, "Rack MCP probe telemetry reading", "output");
emit("module-adapter", ModuleAdapter, "Rack MCP module adapter document", "input");
emit("recipe", Recipe, "Rack MCP recipe document", "input");
emit("error", RackMcpError, "Rack MCP structured error", "output");
emit("validation-finding", ValidationFinding, "Rack MCP validation finding", "output");

// Bridge method payload/result schemas in one document.
{
  const methods: Record<string, unknown> = {};
  for (const m of BRIDGE_METHOD_NAMES) {
    const spec = BRIDGE_METHODS[m];
    methods[m] = {
      mutating: spec.mutating,
      request: toSchema(spec.request as z.ZodType, "input"),
      result: toSchema(spec.result as z.ZodType, "output"),
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
      input: toSchema(t.input as z.ZodType, "input"),
      output: toSchema(t.output as z.ZodType, "output"),
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
