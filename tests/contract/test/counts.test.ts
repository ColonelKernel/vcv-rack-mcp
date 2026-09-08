import { describe as suite, expect, test } from "vitest";
import { countClaims, countRules, wrongCounts } from "../src/counts.js";

suite("counts written into prose", () => {
  test("every documented count matches its registry", () => {
    const bad = wrongCounts().map(
      (c) => `${c.file}:${c.line} says ${c.claimed} ${c.what}, but there are ${c.expected} — ${c.text}`,
    );
    expect(
      bad,
      "a count in prose is a claim about the current surface. Update the sentence, not this gate: " +
        "the expected numbers are read from TOOL_NAMES, RESOURCE_URIS, PROMPT_NAMES and ADAPTER_COUNT.",
    ).toEqual([]);
  });

  test("the scan actually finds count claims", () => {
    // Without this the gate passes when the patterns stop matching: nothing
    // claimed is nothing wrong. This is the failure mode that let four docs
    // sit at 29 tools while the surface was 32.
    const claims = countClaims();
    expect(claims.length).toBeGreaterThan(5);
    const kinds = new Set(claims.map((c) => c.what));
    expect([...kinds]).toContain("MCP tools");
    expect(claims.some((c) => c.file === "README.md")).toBe(true);
  });

  test("the expected counts come from the registries, not from literals", () => {
    for (const rule of countRules()) {
      expect(rule.expected, `${rule.what} count should be positive`).toBeGreaterThan(0);
    }
  });
});
