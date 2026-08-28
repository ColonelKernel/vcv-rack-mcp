/**
 * Generates the C++11 protocol header for the Rack plugin from the canonical
 * schema source. Emitted to plugins/RackMCP/src/gen/rackmcp_protocol_gen.hpp
 * and committed; CI fails when stale (`pnpm run check:gen`).
 *
 * The plugin works on jansson json_t values; this header supplies constants,
 * enums, and required-field validation tables rather than full typed structs.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_METHOD_NAMES,
  BRIDGE_METHODS,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_PROTOCOL_MIN_SUPPORTED,
  ERROR_CODES,
  LIMITS,
  OPERATION_TYPES,
} from "../packages/schemas/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jsonDir = join(root, "packages", "schemas", "json");
const outDir = join(root, "plugins", "RackMCP", "src", "gen");
mkdirSync(outDir, { recursive: true });

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
};

function jsonTypeOf(s: JsonSchema | undefined): string {
  if (!s) return "any";
  if (typeof s.const === "string") return "string";
  if (typeof s.const === "number") return "number";
  if (typeof s.const === "boolean") return "boolean";
  if (Array.isArray(s.enum)) {
    const kinds = new Set(s.enum.map((v) => typeof v));
    if (kinds.size === 1 && kinds.has("string")) return "string";
  }
  // Collapse unions whose branches all share one JSON type (e.g. ModuleRef
  // is always an object) so the C++ validator keeps the type check.
  const branches = s.anyOf ?? s.oneOf;
  if (branches && branches.length > 0) {
    const kinds = new Set(branches.map((b) => jsonTypeOf(b)));
    if (kinds.size === 1) return [...kinds][0] as string;
    return "any";
  }
  const t = Array.isArray(s.type) ? undefined : s.type;
  switch (t) {
    case "string":
    case "boolean":
    case "object":
    case "array":
      return t;
    case "integer":
      return "integer";
    case "number":
      return "number";
    default:
      return "any";
  }
}

interface FieldRow {
  name: string;
  type: string;
}
function requiredFields(schema: JsonSchema): FieldRow[] {
  const req = schema.required ?? [];
  const props = schema.properties ?? {};
  return req
    .filter((r) => r !== "kind")
    .sort()
    .map((r) => ({ name: r, type: jsonTypeOf(props[r]) }));
}

// Frame kinds from the bridge-frame schema (a discriminated union).
const frameSchema = JSON.parse(readFileSync(join(jsonDir, "bridge-frame.schema.json"), "utf8"));
const variants: JsonSchema[] = frameSchema.anyOf ?? frameSchema.oneOf ?? [];
const frameRows: { kind: string; fields: FieldRow[] }[] = [];
for (const v of variants) {
  const kindSchema = v.properties?.kind;
  const kind = (kindSchema?.const ?? kindSchema?.enum?.[0]) as string | undefined;
  if (!kind) throw new Error("bridge frame variant without kind const");
  frameRows.push({ kind, fields: requiredFields(v) });
}
frameRows.sort((a, b) => a.kind.localeCompare(b.kind));

// Method request required fields from bridge-methods schema.
const methodsDoc = JSON.parse(readFileSync(join(jsonDir, "bridge-methods.schema.json"), "utf8"));
const methodRows: { method: string; mutating: boolean; fields: FieldRow[] }[] = [];
for (const m of BRIDGE_METHOD_NAMES) {
  const entry = methodsDoc.methods[m];
  if (!entry) throw new Error(`bridge-methods.schema.json missing ${m}`);
  methodRows.push({ method: m, mutating: BRIDGE_METHODS[m].mutating, fields: requiredFields(entry.request) });
}

// Operation required fields from patch-operation schema.
const opSchema = JSON.parse(readFileSync(join(jsonDir, "patch-operation.schema.json"), "utf8"));
const opVariants: JsonSchema[] = opSchema.anyOf ?? opSchema.oneOf ?? [];
const opRows: { op: string; fields: FieldRow[] }[] = [];
for (const v of opVariants) {
  const opProp = v.properties?.op;
  const op = (opProp?.const ?? opProp?.enum?.[0]) as string | undefined;
  if (!op) throw new Error("operation variant without op const");
  opRows.push({
    op,
    fields: (v.required ?? [])
      .filter((r) => r !== "op")
      .sort()
      .map((r) => ({ name: r, type: jsonTypeOf(v.properties?.[r]) })),
  });
}
opRows.sort((a, b) => a.op.localeCompare(b.op));
{
  const fromSchema = opRows.map((o) => o.op).sort();
  const declared = [...OPERATION_TYPES].sort();
  if (JSON.stringify(fromSchema) !== JSON.stringify(declared)) {
    throw new Error(
      `operation name sets disagree: schema=[${fromSchema}] declared=[${declared}]`,
    );
  }
}

const lines: string[] = [];
const P = (s = "") => lines.push(s);

P("// GENERATED FILE - DO NOT EDIT.");
P("// Source of truth: packages/schemas (Zod). Regenerate with `pnpm run gen`.");
P("#pragma once");
P("#include <cstddef>");
P("#include <cstdint>");
P("");
P("namespace rackmcp {");
P("namespace gen {");
P("");
P(`static const int BRIDGE_PROTOCOL_VERSION = ${BRIDGE_PROTOCOL_VERSION};`);
P(`static const int BRIDGE_PROTOCOL_MIN_SUPPORTED = ${BRIDGE_PROTOCOL_MIN_SUPPORTED};`);
P("");
P("// Limits (spec section 13)");
for (const [k, v] of Object.entries(LIMITS)) {
  const name = k.replace(/([A-Z])/g, "_$1").toUpperCase();
  P(`static const int64_t LIMIT_${name} = ${v};`);
}
P("");
P("// Stable error codes (spec section 12)");
P("enum class ErrorCode {");
for (const c of ERROR_CODES) P(`\t${c},`);
P("\tCOUNT_");
P("};");
P("");
P("inline const char* errorCodeToString(ErrorCode c) {");
P("\tswitch (c) {");
for (const c of ERROR_CODES) P(`\t\tcase ErrorCode::${c}: return "${c}";`);
P('\t\tdefault: return "INTERNAL";');
P("\t}");
P("}");
P("");
P("// Frame kinds and their required non-discriminator fields");
P("struct FieldSpec { const char* name; const char* jsonType; };");
P("struct FrameSpec { const char* kind; const FieldSpec* fields; size_t fieldCount; };");
P("");
for (const f of frameRows) {
  const id = f.kind.replace(/[^a-zA-Z0-9]/g, "_");
  P(`static const FieldSpec FRAME_FIELDS_${id}[] = {`);
  for (const fd of f.fields) P(`\t{"${fd.name}", "${fd.type}"},`);
  P('\t{nullptr, nullptr}');
  P("};");
}
P("static const FrameSpec FRAME_SPECS[] = {");
for (const f of frameRows) {
  const id = f.kind.replace(/[^a-zA-Z0-9]/g, "_");
  P(`\t{"${f.kind}", FRAME_FIELDS_${id}, ${f.fields.length}},`);
}
P("};");
P(`static const size_t FRAME_SPEC_COUNT = ${frameRows.length};`);
P("");
P("// Bridge methods, whether they mutate, and required request fields");
P("struct MethodSpec { const char* method; bool mutating; const FieldSpec* fields; size_t fieldCount; };");
P("");
methodRows.forEach((m, i) => {
  P(`static const FieldSpec METHOD_FIELDS_${i}[] = {`);
  for (const fd of m.fields) P(`\t{"${fd.name}", "${fd.type}"},`);
  P('\t{nullptr, nullptr}');
  P("};");
});
P("static const MethodSpec METHOD_SPECS[] = {");
methodRows.forEach((m, i) => {
  P(`\t{"${m.method}", ${m.mutating ? "true" : "false"}, METHOD_FIELDS_${i}, ${m.fields.length}},`);
});
P("};");
P(`static const size_t METHOD_SPEC_COUNT = ${methodRows.length};`);
P("");
P("// Patch operations and required fields");
P("struct OperationSpec { const char* op; const FieldSpec* fields; size_t fieldCount; };");
P("");
opRows.forEach((o, i) => {
  P(`static const FieldSpec OP_FIELDS_${i}[] = {`);
  for (const fd of o.fields) P(`\t{"${fd.name}", "${fd.type}"},`);
  P('\t{nullptr, nullptr}');
  P("};");
});
P("static const OperationSpec OPERATION_SPECS[] = {");
opRows.forEach((o, i) => {
  P(`\t{"${o.op}", OP_FIELDS_${i}, ${o.fields.length}},`);
});
P("};");
P(`static const size_t OPERATION_SPEC_COUNT = ${opRows.length};`);
P("");
P("} // namespace gen");
P("} // namespace rackmcp");

writeFileSync(join(outDir, "rackmcp_protocol_gen.hpp"), lines.join("\n") + "\n");
console.error(`wrote rackmcp_protocol_gen.hpp (${lines.length} lines)`);
