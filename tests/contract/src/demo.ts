import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./sources.js";

/**
 * The README's demo and `docs/assets/demo.svg` are ONE captured transcript
 * rendered twice. Nothing checked that they still agreed.
 *
 * That matters more here than a usual doc/asset pair, because the README says
 * of this block: "This is **real tool output**". The rule the repo works to is
 * that such a transcript is never hand-edited -- it is recaptured with
 * `pnpm --filter @rackmcp/integration run demo`. A hand edit to the README left
 * no evidence: the SVG kept the old number, and the two disagreeing was
 * something a reader would have to notice by eye.
 *
 * `demo.png` is a raster of the SVG and cannot be compared this way; it stays a
 * manual step, documented in scripts/gen-demo-svg.ts.
 */
const START = "<summary>Transcript (text)</summary>";

/**
 * Line endings normalised before anything else looks at the text.
 *
 * The repo has no `.gitattributes`, so a Windows checkout gets CRLF and every
 * `"...\n"` search here misses. That is not hypothetical: this gate reported
 * "README.md's transcript section has no ```text block" in the
 * `TypeScript (windows-latest)` job on its first run, having passed on macOS
 * and Linux. Normalising is the right fix for a comparison of *content*
 * regardless of what the repo later decides about `.gitattributes`.
 */
const lf = (text: string): string => text.replace(/\r\n/g, "\n");

/** The transcript exactly as the README carries it, or throws saying why not. */
export function readmeTranscript(
  readme: string = readFileSync(join(REPO_ROOT, "README.md"), "utf8"),
): string {
  readme = lf(readme);
  const summary = readme.indexOf(START);
  if (summary < 0) throw new Error(`README.md has no "${START}" section`);
  const open = readme.indexOf("```text\n", summary);
  if (open < 0) throw new Error("README.md's transcript section has no ```text block");
  const bodyStart = open + "```text\n".length;
  const close = readme.indexOf("\n```", bodyStart);
  if (close < 0) throw new Error("README.md's transcript block is not closed");
  return readme.slice(bodyStart, close);
}

export function committedSvg(): string {
  return lf(readFileSync(join(REPO_ROOT, "docs", "assets", "demo.svg"), "utf8"));
}

/**
 * The first line that differs between two renderings, as a human-readable
 * report -- an equality assertion on a 27-line SVG otherwise prints the whole
 * thing twice and buries the one changed number.
 */
export function firstDifference(a: string, b: string): string | null {
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return `line ${i + 1}\n  from README: ${la[i] ?? "(no such line)"}\n  committed:   ${lb[i] ?? "(no such line)"}`;
    }
  }
  return null;
}
