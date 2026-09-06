import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BRIDGE_METHOD_NAMES,
  ERROR_CODES,
  LIMITS,
  OPERATION_TYPES,
  RESOURCE_URIS,
  RiskFlag,
  TOOL_NAMES,
} from "@rackmcp/schemas";
import { REPO_ROOT } from "./sources.js";

/**
 * A symbol this codebase publishes as part of its contract, and therefore owes
 * an implementation.
 */
export interface DeclaredSymbol {
  readonly symbol: string;
  readonly kind: DeclaredKind;
  /** Human-readable origin, used in failure messages. */
  readonly origin: string;
  /**
   * Other spellings that count as a reference to the same contract symbol.
   *
   * Codegen renames things on the way into C++: `LIMITS.jsonMaxDepth` is read
   * as `gen::LIMIT_JSON_MAX_DEPTH`. A census that only looked for the camelCase
   * name would report seven limits as unread when their only readers are in the
   * plugin, which is the opposite of the truth.
   */
  readonly aliases: readonly string[];
  /**
   * The one file that declares this symbol, when a mention anywhere else — even
   * elsewhere in `packages/schemas` — is a genuine use.
   *
   * `LIMITS.txnMaxOperations` is the case this exists for. Substituting it into
   * the tool input schema is exactly what "the limit has a reader" should mean:
   * the published number and the enforced number become one expression. But
   * tools.ts lives in the declaration root, so without this the census would
   * demand the reader be moved somewhere worse to satisfy the gate.
   *
   * Field names get no such treatment: a property named in two schema modules
   * is still only declared.
   */
  readonly declaredIn?: string;
}

export type DeclaredKind =
  | "error_code"
  | "risk_flag"
  | "operation_type"
  | "bridge_method"
  | "limit"
  | "tool"
  | "resource"
  | "schema_property";

function collect(
  values: readonly string[],
  kind: DeclaredKind,
  origin: string,
  aliasesOf: (symbol: string) => string[] = () => [],
  declaredIn?: string,
): DeclaredSymbol[] {
  return values.map((symbol) => ({
    symbol,
    kind,
    origin,
    aliases: aliasesOf(symbol),
    ...(declaredIn ? { declaredIn } : {}),
  }));
}

/**
 * The generated C++ constant name for a `LIMITS` key, mirroring the transform
 * in `scripts/gen-cpp.ts:148`. Kept in lockstep by a test in this package.
 */
export function generatedLimitName(key: string): string {
  return `LIMIT_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`;
}

/**
 * Every leaf property name in the generated JSON Schemas.
 *
 * Reading the generated JSON rather than walking the Zod objects keeps this
 * gate honest about what is actually published to clients: if a field never
 * reaches `packages/schemas/json`, it is not part of the contract.
 */
export function schemaPropertyNames(): DeclaredSymbol[] {
  const dir = join(REPO_ROOT, "packages/schemas/json");
  const found = new Map<string, string>();
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".json")) continue;
    const doc: unknown = JSON.parse(readFileSync(join(dir, entry), "utf8"));
    walkProperties(doc, entry, found);
  }
  return [...found].map(([symbol, origin]) => ({
    symbol,
    kind: "schema_property" as const,
    origin,
    aliases: [],
  }));
}

function walkProperties(node: unknown, origin: string, out: Map<string, string>): void {
  if (Array.isArray(node)) {
    for (const item of node) walkProperties(item, origin, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const props = obj["properties"];
  if (props && typeof props === "object" && !Array.isArray(props)) {
    for (const name of Object.keys(props as Record<string, unknown>)) {
      if (!out.has(name)) out.set(name, origin);
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    // "properties" itself is descended below via its values, not its keys.
    if (key === "properties" && value && typeof value === "object") {
      for (const child of Object.values(value as Record<string, unknown>)) {
        walkProperties(child, origin, out);
      }
      continue;
    }
    walkProperties(value, origin, out);
  }
}

let cache: readonly DeclaredSymbol[] | undefined;

/** The full declared contract surface, deduplicated by symbol+kind. */
export function declaredSymbols(): readonly DeclaredSymbol[] {
  if (cache) return cache;
  const all = [
    ...collect(ERROR_CODES, "error_code", "packages/schemas/src/errors.ts ERROR_CODES"),
    ...collect(RiskFlag.options, "risk_flag", "packages/schemas/src/operations.ts RiskFlag"),
    ...collect(
      OPERATION_TYPES,
      "operation_type",
      "packages/schemas/src/operations.ts OPERATION_TYPES",
    ),
    ...collect(
      BRIDGE_METHOD_NAMES,
      "bridge_method",
      "packages/schemas/src/bridge.ts BRIDGE_METHOD_NAMES",
    ),
    ...collect(
      Object.keys(LIMITS),
      "limit",
      "packages/schemas/src/limits.ts LIMITS",
      (k) => [generatedLimitName(k)],
      "packages/schemas/src/limits.ts",
    ),
    ...collect(TOOL_NAMES, "tool", "packages/schemas/src/tools.ts TOOLS"),
    ...collect(RESOURCE_URIS, "resource", "packages/schemas/src/resources.ts RESOURCES"),
    ...schemaPropertyNames(),
  ];
  const seen = new Set<string>();
  cache = all.filter((d) => {
    const key = `${d.kind}:${d.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return cache;
}
