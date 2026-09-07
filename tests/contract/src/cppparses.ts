/**
 * Gate E -- no ad-hoc string-to-number parsing in the plugin.
 *
 * Ids cross the bridge as decimal strings, and every one of them was parsed
 * with a hand-rolled strtoll call. The four sites disagreed with each other and
 * all four disagreed with the schema: one had an endptr check and no sign
 * check, one had no check at all, one rejected the empty string and the fourth
 * read it as id 0. `{"moduleId": ""}` acted on module 0; `{"cableId": ""}`
 * disconnected cable 0; `probe.read` with an empty id read module 0. And the
 * commit path parsed cable ids differently from the preview that validated
 * them, so the two would drift the moment either was touched.
 *
 * They now all go through core/plan.cpp's parseDecimalId, which accepts exactly
 * refs.ts DecimalId and is unit tested. This keeps them there: comments are
 * stripped first, so describing the old behaviour does not trip it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, stripComments } from "./sources.js";

const PLUGIN_SRC = join(REPO_ROOT, "plugins", "RackMCP", "src");

/** Parsers that silently accept more than a decimal id, or clamp on overflow. */
export const BANNED_PARSERS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /\bstrtoll\s*\(/, name: "strtoll" },
  { pattern: /\bstrtol\s*\(/, name: "strtol" },
  { pattern: /\bstrtoull\s*\(/, name: "strtoull" },
  { pattern: /\batoi\s*\(/, name: "atoi" },
  { pattern: /\batoll?\s*\(/, name: "atol/atoll" },
  { pattern: /\bstd::sto(?:i|l|ll|ul|ull)\s*\(/, name: "std::sto*" },
  { pattern: /\bsscanf\s*\(/, name: "sscanf" },
];

/**
 * The one file allowed to parse a number from a string by hand: it IS the
 * strict parser, and its overflow check has to do the arithmetic itself.
 */
const PARSER_IMPLEMENTATION = "plugins/RackMCP/src/core/plan.cpp";

export interface BannedParse {
  readonly path: string;
  readonly parser: string;
  readonly line: number;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".cpp") || entry.name.endsWith(".hpp")) out.push(full);
  }
  return out;
}

export function bannedParses(): BannedParse[] {
  const out: BannedParse[] = [];
  for (const abs of walk(PLUGIN_SRC)) {
    // REPO_ROOT already ends with a path separator.
    const rel = abs.slice(REPO_ROOT.length).split("\\").join("/");
    if (rel === PARSER_IMPLEMENTATION) continue;
    // Generated code is codegen's problem, not a hand-written parse.
    if (rel.includes("/gen/")) continue;
    const lines = stripComments(readFileSync(abs, "utf8"), false).split("\n");
    lines.forEach((text, i) => {
      for (const p of BANNED_PARSERS) {
        if (p.pattern.test(text)) out.push({ path: rel, parser: p.name, line: i + 1 });
      }
    });
  }
  return out;
}
