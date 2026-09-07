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
  RiskFlag,
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
  minimum?: number;
  maximum?: number;
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
  /**
   * The exact strings a string-enum field admits, or undefined when the field
   * is not an enum. Without these the C++ checker can confirm a policy field is
   * a string and nothing more -- and every policy field in patch-operation
   * defaults, in the plugin, to the destructive choice when the value is not
   * recognised.
   */
  allowed?: readonly string[];
}

/** The string enum a schema declares, if it declares one. */
function stringEnumOf(s: JsonSchema | undefined): readonly string[] | undefined {
  if (!s) return undefined;
  if (Array.isArray(s.enum) && s.enum.every((v) => typeof v === "string"))
    return s.enum as string[];
  if (typeof s.const === "string") return [s.const];
  return undefined;
}
function requiredFields(schema: JsonSchema): FieldRow[] {
  const req = schema.required ?? [];
  const props = schema.properties ?? {};
  return req
    .filter((r) => r !== "kind")
    .sort()
    .map((r) => ({ name: r, type: jsonTypeOf(props[r]), allowed: stringEnumOf(props[r]) }));
}


/**
 * Emits a NULL-terminated `const char*` array for a field's enum values and
 * returns its identifier, or "nullptr" when the field is not an enum. Names are
 * derived from the owning table entry so two fields called "policy" in
 * different operations cannot collide.
 */
function emitAllowed(owner: string, f: FieldRow): string {
  if (!f.allowed || f.allowed.length === 0) return "nullptr";
  const id = `ALLOWED_${owner}_${f.name.replace(/[^a-zA-Z0-9]/g, "_")}`;
  P(`static const char* const ${id}[] = {`);
  for (const v of f.allowed) P(`\t"${v}",`);
  P("\tnullptr");
  P("};");
  return id;
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
      .map((r) => ({
        name: r,
        type: jsonTypeOf(v.properties?.[r]),
        allowed: stringEnumOf(v.properties?.[r]),
      })),
  });
}
/**
 * The GridPosition domain, harvested from every `position` property in the
 * patch-operation schema rather than retyped here.
 *
 * `readIntField` bounds a position to a C++ `int`, which is five orders of
 * magnitude looser than the schema declares. A lease holder can therefore send
 * `{"x": 2147483647}` to `move_module`, and `layout::gridToPixel` adds Rack's
 * 2000-column origin to it -- signed overflow, which is undefined behaviour
 * inside Rack's own process. `docs/security/threat-model.md` draws boundary 2
 * at the bridge socket and promises the plugin re-validates every frame, so the
 * domain has to reach C++ as a number rather than as prose in a Zod schema the
 * plugin never sees.
 *
 * Every occurrence must agree. A second, divergent grid domain would otherwise
 * generate one pair of constants and silently apply it to both.
 */
function gridDomain(axis: "x" | "y"): { min: number; max: number } {
  const found: { min: number; max: number }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const s = node as JsonSchema;
    const pos = s.properties?.position;
    if (pos?.properties?.x && pos.properties?.y) {
      const a = pos.properties[axis];
      if (typeof a.minimum !== "number" || typeof a.maximum !== "number") {
        throw new Error(
          `GridPosition.${axis} carries no numeric bounds in ` +
            `patch-operation.schema.json; the C++ domain check would be generated ` +
            `from nothing.`,
        );
      }
      found.push({ min: a.minimum, max: a.maximum });
    }
    for (const v of Object.values(s)) walk(v);
  };
  walk(opSchema);
  if (found.length === 0) {
    throw new Error(
      "no `position` property found in patch-operation.schema.json; the grid " +
        "domain constants would be generated from nothing.",
    );
  }
  for (const d of found) {
    if (d.min !== found[0].min || d.max !== found[0].max) {
      throw new Error(
        `GridPosition.${axis} is declared with more than one domain ` +
          `([${found[0].min}, ${found[0].max}] and [${d.min}, ${d.max}]). One ` +
          `pair of constants cannot describe both.`,
      );
    }
  }
  return found[0];
}
const gridX = gridDomain("x");
const gridY = gridDomain("y");

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
  // Every limit lands in an int64_t. A fractional value would narrow silently
  // here -- copy-initialisation permits it -- leaving C++ with a truncated
  // constant and TypeScript with the fraction, which is exactly the kind of
  // disagreement this generator exists to prevent. probeMaxHz is computed
  // (1000 / probeWindowMs), so this is reachable by editing one number.
  if (!Number.isSafeInteger(v) || (v as number) < 0) {
    throw new Error(
      `LIMITS.${k} is ${String(v)}, which is not a safe non-negative integer. ` +
        `Limits are generated into int64_t constants and a fractional or ` +
        `out-of-range value would silently truncate in C++ while TypeScript ` +
        `kept the original.`,
    );
  }
  P(`static const int64_t LIMIT_${name} = ${v};`);
}
P("");
P("// Grid position domain (packages/schemas/src/refs.ts GridPosition).");
P("//");
P("// Rack's own origin is added to a grid column before it becomes a pixel");
P("// coordinate, so an unbounded column is a signed overflow rather than a");
P("// module in a strange place. These are the bounds the schema declares.");
P(`static const int GRID_POSITION_X_MIN = ${gridX.min};`);
P(`static const int GRID_POSITION_X_MAX = ${gridX.max};`);
P(`static const int GRID_POSITION_Y_MIN = ${gridY.min};`);
P(`static const int GRID_POSITION_Y_MAX = ${gridY.max};`);
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
P("// Risk flags (packages/schemas/src/operations.ts RiskFlag).");
P("//");
P("// The plugin spelled these as string literals, so a flag renamed in the");
P("// schema stayed compilable and simply stopped matching the vocabulary the");
P("// client branches on. As an enum, the rename is a build error at the site");
P("// that emits it.");
P("enum class RiskFlag {");
for (const f of RiskFlag.options) P(`\t${f},`);
P("\tCOUNT_");
P("};");
P("");
P("inline const char* riskFlagToString(RiskFlag f) {");
P("\tswitch (f) {");
for (const f of RiskFlag.options) P(`\t\tcase RiskFlag::${f}: return "${f}";`);
P('\t\tdefault: return "";');
P("\t}");
P("}");
P("");
P("// Frame kinds and their required non-discriminator fields");
P("// `allowed` is a NULL-terminated list of the exact strings a string-enum");
P("// field admits, or NULL when the field is not an enum.");
P("struct FieldSpec { const char* name; const char* jsonType; const char* const* allowed; };");
P("struct FrameSpec { const char* kind; const FieldSpec* fields; size_t fieldCount; };");
P("");
for (const f of frameRows) {
  const id = f.kind.replace(/[^a-zA-Z0-9]/g, "_");
  const frameAllowed = f.fields.map((fd) => emitAllowed(`FRAME_${id}`, fd));
  P(`static const FieldSpec FRAME_FIELDS_${id}[] = {`);
  f.fields.forEach((fd, k) => P(`\t{"${fd.name}", "${fd.type}", ${frameAllowed[k]}},`));
  P('\t{nullptr, nullptr, nullptr}');
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
  const methodAllowed = m.fields.map((fd) => emitAllowed(`METHOD_${i}`, fd));
  P(`static const FieldSpec METHOD_FIELDS_${i}[] = {`);
  m.fields.forEach((fd, k) => P(`\t{"${fd.name}", "${fd.type}", ${methodAllowed[k]}},`));
  P('\t{nullptr, nullptr, nullptr}');
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
  const opAllowed = o.fields.map((fd) => emitAllowed(`OP_${i}`, fd));
  P(`static const FieldSpec OP_FIELDS_${i}[] = {`);
  o.fields.forEach((fd, k) => P(`\t{"${fd.name}", "${fd.type}", ${opAllowed[k]}},`));
  P('\t{nullptr, nullptr, nullptr}');
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
