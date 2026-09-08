import { PROMPT_NAMES, RESOURCE_URIS, TOOL_NAMES } from "@rackmcp/schemas";
import { ADAPTER_COUNT } from "@rackmcp/adapters";
import { loadDocs } from "./docs.js";

/**
 * Gate I — a number written into prose matches the registry it counts.
 *
 * Gate C proves every path a doc names exists. It says nothing about the
 * counts, and counts are what actually rot: the surface grew from 29 tools to
 * 32 and four documents still said 29, including the threat model's own index
 * and the compatibility matrix. `README.md` and the generated tool reference
 * were right, which is worse than uniformly wrong -- a reader has no way to
 * tell which number to believe.
 *
 * The counts come from the registries, so this cannot itself go stale: adding a
 * tool fails every doc that still names the old total, and the fix is to update
 * the prose rather than the gate.
 */
export interface CountRule {
  /** What is being counted, for the failure message. */
  readonly what: string;
  /** The true count, read from the registry. */
  readonly expected: number;
  /**
   * Matches a prose claim, capturing the number in group 1. Deliberately
   * anchored on the noun so "32 tools" is checked and "section 6" is not.
   */
  readonly pattern: RegExp;
}

export function countRules(): readonly CountRule[] {
  return [
    {
      what: "MCP tools",
      expected: TOOL_NAMES.length,
      pattern: /\*{0,2}(\d+)\*{0,2} (?:MCP )?tools\b/g,
    },
    {
      what: "MCP resources",
      expected: RESOURCE_URIS.length,
      pattern: /\*{0,2}(\d+)\*{0,2} (?:MCP )?resources\b/g,
    },
    {
      what: "MCP prompts",
      expected: PROMPT_NAMES.length,
      pattern: /\*{0,2}(\d+)\*{0,2} (?:MCP )?prompts\b/g,
    },
    {
      what: "module adapters",
      expected: ADAPTER_COUNT,
      pattern: /\*{0,2}(\d+)\*{0,2} adapters\b/g,
    },
  ];
}

export interface WrongCount {
  readonly file: string;
  readonly line: number;
  readonly what: string;
  readonly claimed: number;
  readonly expected: number;
  readonly text: string;
}

/**
 * Prose that names a count and gets it wrong.
 *
 * Fenced code blocks are skipped: a transcript or a sample response is a record
 * of what something printed, not a claim about today, and rewriting one to
 * satisfy a gate would falsify it.
 */
export function wrongCounts(): WrongCount[] {
  const out: WrongCount[] = [];
  const rules = countRules();
  for (const doc of loadDocs()) {
    let fenced = false;
    doc.text.split("\n").forEach((text, i) => {
      if (/^\s*```/.test(text)) {
        fenced = !fenced;
        return;
      }
      if (fenced) return;
      for (const rule of rules) {
        rule.pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.pattern.exec(text))) {
          const claimed = Number(m[1]);
          if (claimed === rule.expected) continue;
          out.push({
            file: doc.path,
            line: i + 1,
            what: rule.what,
            claimed,
            expected: rule.expected,
            text: text.trim(),
          });
        }
      }
    });
  }
  return out;
}

/** Every count claim the scan found, right or wrong, so the gate can prove it looked. */
export function countClaims(): { file: string; what: string; claimed: number }[] {
  const out: { file: string; what: string; claimed: number }[] = [];
  const rules = countRules();
  for (const doc of loadDocs()) {
    let fenced = false;
    for (const text of doc.text.split("\n")) {
      if (/^\s*```/.test(text)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      for (const rule of rules) {
        rule.pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.pattern.exec(text))) {
          out.push({ file: doc.path, what: rule.what, claimed: Number(m[1]) });
        }
      }
    }
  }
  return out;
}
