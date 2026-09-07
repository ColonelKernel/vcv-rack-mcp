import { describe as suite, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { committedSvg, firstDifference, readmeTranscript } from "../src/demo.js";
import { REPO_ROOT } from "../src/sources.js";
import { renderDemoSvg } from "../../../scripts/gen-demo-svg.js";

suite("demo transcript", () => {
  test("the committed SVG is exactly what the README's transcript renders to", () => {
    // If this fails, do NOT edit either artifact by hand. Recapture:
    //   pnpm --filter @rackmcp/integration run demo 2>/dev/null > /tmp/demo.txt
    //   npx tsx scripts/gen-demo-svg.ts < /tmp/demo.txt > docs/assets/demo.svg
    // then paste /tmp/demo.txt into the README block and re-render the PNG.
    const diff = firstDifference(renderDemoSvg(readmeTranscript()), committedSvg());
    expect(diff, `README.md's demo transcript and docs/assets/demo.svg disagree at ${diff}`).toBeNull();
  });

  test("the transcript block is found by structure, not by luck", () => {
    // A parser that silently returned "" would make the check above vacuous:
    // an empty transcript renders to a fixed SVG that simply would not match.
    // Assert the content instead of trusting the extraction.
    const t = readmeTranscript();
    expect(t.split("\n").length).toBeGreaterThan(10);
    expect(t).toContain("list_rack_instances");
    expect(t).toContain("models installed");
  });

  test("a CRLF checkout is read the same as an LF one", () => {
    // The repo ships no .gitattributes, so a Windows clone gets CRLF and every
    // "\n"-anchored search in the extractor misses. This gate failed exactly
    // that way on windows-latest the first time it ran.
    const lf = readFileSync(join(REPO_ROOT, "README.md"), "utf8").replace(/\r\n/g, "\n");
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(readmeTranscript(crlf)).toBe(readmeTranscript(lf));
  });

  test("a malformed README is reported rather than silently accepted", () => {
    expect(() => readmeTranscript("# no transcript here")).toThrow(/no "<summary>/);
    expect(() => readmeTranscript(`x\n${"<summary>Transcript (text)</summary>"}\nno fence`)).toThrow(
      /no ```text block/,
    );
  });
});
