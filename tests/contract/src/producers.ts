import { loadSources, type SourceFile } from "./sources.js";

/**
 * A JSON key the plugin emits, and every value expression it is emitted with.
 *
 * The symbol census is token-based and therefore blind to this: the plugin
 * builds its payloads with jansson literals, so
 * `json_object_set_new(payload, "undoable", json_true())` credits "undoable"
 * with a producer while saying nothing about whether the value can vary. A
 * field that is always the same constant is a claim with no information in it.
 */
export interface KeyProducer {
  readonly key: string;
  readonly sites: readonly ProducerSite[];
}

export interface ProducerSite {
  readonly file: string;
  readonly line: number;
  /** `json_true()`, `json_false()`, `json_null()`, or undefined when dynamic. */
  readonly literal: string | undefined;
}

/**
 * Matches a single-line `json_object_set_new(obj, "key", value)` call.
 *
 * Deliberately single-line and deliberately not a C++ parser: the point is a
 * syntactic signature with no false positives, not full coverage. Multi-line
 * calls and `json_object_set` are outside what this can see, which is stated in
 * the generated census document.
 */
const CALL = /json_object_set_new\s*\(\s*[^,()]+,\s*"([^"]+)"\s*,\s*([^;]*?)\)\s*;/g;

const LITERAL = /^json_(true|false|null)\(\)$/;

function scanFile(file: SourceFile, out: Map<string, ProducerSite[]>): void {
  const lines = file.code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    CALL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL.exec(line)) !== null) {
      const key = m[1]!;
      const value = m[2]!.trim();
      const literal = LITERAL.test(value) ? value : undefined;
      const sites = out.get(key) ?? [];
      sites.push({ file: file.path, line: i + 1, literal });
      out.set(key, sites);
    }
  }
}

let cache: readonly KeyProducer[] | undefined;

export function keyProducers(): readonly KeyProducer[] {
  if (cache) return cache;
  const found = new Map<string, ProducerSite[]>();
  for (const file of loadSources()) {
    if (file.root.kind !== "producer") continue;
    scanFile(file, found);
  }
  cache = [...found]
    .map(([key, sites]) => ({ key, sites }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return cache;
}

/**
 * Keys whose every producer is the same jansson literal, so the field can only
 * ever carry one value. A key with any dynamic producer is excluded, even if it
 * also has literal ones: `snapped` is `json_boolean(pq->snapEnabled)` on the
 * real path and `json_false()` only in a fallback, and that is not a constant.
 */
export function alwaysConstantKeys(): readonly KeyProducer[] {
  return keyProducers().filter((p) => {
    if (p.sites.some((s) => s.literal === undefined)) return false;
    const distinct = new Set(p.sites.map((s) => s.literal));
    return distinct.size === 1;
  });
}

export function describeProducer(p: KeyProducer): string {
  const literal = p.sites[0]?.literal ?? "?";
  const where = p.sites.map((s) => `${s.file}:${s.line}`).join(", ");
  return `"${p.key}" is always ${literal} — ${where}`;
}
