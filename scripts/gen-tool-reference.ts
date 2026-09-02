/**
 * Generates docs/tools/tool-reference.md from the canonical tool schemas
 * (packages/schemas/json/tools.schema.json). The reference is derived, never
 * hand-written, so tool names, hints, and parameter shapes cannot drift from
 * the schema. Re-run with: pnpm tsx scripts/gen-tool-reference.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const schema = JSON.parse(
  readFileSync(join(root, "packages/schemas/json/tools.schema.json"), "utf8"),
) as { tools: Record<string, ToolSchema> };

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  description?: string;
  nullable?: boolean;
}
interface ToolSchema {
  title: string;
  description: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  input: JsonSchema;
  output: JsonSchema;
}

// Curated grouping + ordering for readability. Any tool not listed here is
// appended under "Other" so nothing is silently dropped.
const GROUPS: Array<{ title: string; tools: string[] }> = [
  { title: "Instances, status, and writer lease", tools: [
    "list_rack_instances", "select_rack_instance", "get_rack_status",
    "acquire_writer_lease", "release_writer_lease",
  ] },
  { title: "Catalog and inspection (read-only)", tools: [
    "list_installed_models", "inspect_model", "get_patch_snapshot",
    "inspect_module", "inspect_parameter",
  ] },
  { title: "Analysis (read-only)", tools: ["describe_patch", "validate_patch"] },
  { title: "Transactions", tools: [
    "preview_patch_transaction", "commit_patch_transaction", "build_patch",
    "undo_last_mcp_transaction",
  ] },
  { title: "Patch files and recovery", tools: [
    "list_patch_files", "create_checkpoint", "save_patch",
    "preview_load_patch", "commit_load_patch",
    "preview_clear_patch", "commit_clear_patch", "restore_checkpoint",
  ] },
  { title: "Probe telemetry", tools: [
    "list_probes", "preview_attach_probe", "commit_attach_probe",
    "read_probe", "detach_probe",
  ] },
];

function typeStr(s: JsonSchema | undefined): string {
  if (!s) return "any";
  if (s.$ref) return s.$ref.split("/").pop() ?? "object";
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((e) => JSON.stringify(e)).join(" | ");
  if (s.anyOf || s.oneOf) {
    const union = (s.anyOf ?? s.oneOf)!;
    // Collapse the common `T | null` nullable pattern.
    const parts = union.map(typeStr);
    return parts.join(" | ");
  }
  if (s.allOf && s.allOf.length) return typeStr(s.allOf[0]);
  const base = Array.isArray(s.type) ? s.type.join(" | ") : s.type ?? "object";
  if (base === "array") return `${typeStr(s.items)}[]`;
  if (s.format) return `${base} (${s.format})`;
  return base;
}

function constraints(s: JsonSchema): string {
  const c: string[] = [];
  if (s.minimum !== undefined) c.push(`≥ ${s.minimum}`);
  if (s.maximum !== undefined) c.push(`≤ ${s.maximum}`);
  if (s.minLength !== undefined) c.push(`min length ${s.minLength}`);
  if (s.maxLength !== undefined) c.push(`max length ${s.maxLength}`);
  return c.length ? ` _(${c.join(", ")})_` : "";
}

function renderProps(s: JsonSchema, kind: "input" | "output"): string {
  const props = s.properties ?? {};
  const names = Object.keys(props);
  if (names.length === 0) {
    return kind === "input" ? "_No parameters._\n" : "_See the patch schema for the full shape._\n";
  }
  const required = new Set(s.required ?? []);
  const lines = names.map((n) => {
    const p = props[n]!;
    const req = kind === "input" ? (required.has(n) ? "required" : "optional") : "";
    const desc = p.description ? ` — ${p.description}` : "";
    const reqTag = req ? ` _(${req})_` : "";
    return `- \`${n}\`: ${typeStr(p)}${constraints(p)}${reqTag}${desc}`;
  });
  return lines.join("\n") + "\n";
}

function hintBadges(a: ToolSchema["annotations"]): string {
  const b: string[] = [];
  b.push(a.readOnlyHint ? "read-only" : "**mutating**");
  if (a.destructiveHint) b.push("**destructive** (needs confirmation)");
  if (a.idempotentHint) b.push("idempotent");
  if (a.openWorldHint) b.push("open-world");
  return b.join(" · ");
}

const out: string[] = [];
out.push("# MCP tool reference");
out.push("");
out.push(
  "> Generated from the canonical tool schemas (`packages/schemas/json/tools.schema.json`) by",
  "> `scripts/gen-tool-reference.ts`. Do not edit by hand — re-run the generator.",
);
out.push("");
out.push(
  `Rack MCP exposes **${Object.keys(schema.tools).length} tools**. Every tool has a strict input`,
  "schema and structured output. Destructive tools mutate the patch and require a valid,",
  "preview-bound confirmation (see the transaction model). Read-only tools never mutate Rack",
  "state. All 64-bit Rack ids cross the boundary as decimal strings.",
);
out.push("");

const seen = new Set<string>();
for (const group of GROUPS) {
  out.push(`## ${group.title}`);
  out.push("");
  for (const name of group.tools) {
    const t = schema.tools[name];
    if (!t) throw new Error(`tool-reference: unknown tool in grouping: ${name}`);
    seen.add(name);
    out.push(`### \`${name}\``);
    out.push("");
    out.push(`*${t.title}* — ${hintBadges(t.annotations)}`);
    out.push("");
    out.push(t.description);
    out.push("");
    out.push("**Input**");
    out.push("");
    out.push(renderProps(t.input, "input"));
    out.push("**Output**");
    out.push("");
    out.push(renderProps(t.output, "output"));
  }
}

const leftover = Object.keys(schema.tools).filter((n) => !seen.has(n));
if (leftover.length) {
  out.push("## Other");
  out.push("");
  for (const name of leftover) {
    const t = schema.tools[name]!;
    out.push(`### \`${name}\``, "", `*${t.title}* — ${hintBadges(t.annotations)}`, "", t.description, "");
    out.push("**Input**", "", renderProps(t.input, "input"), "**Output**", "", renderProps(t.output, "output"));
  }
}

writeFileSync(join(root, "docs/tools/tool-reference.md"), out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
console.error(`wrote docs/tools/tool-reference.md (${Object.keys(schema.tools).length} tools)`);
