import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe as suite, expect, test } from "vitest";
import { CENSUS_EXCEPTIONS, LIMITS } from "@rackmcp/schemas";
import { REPO_ROOT } from "../src/sources.js";
import { describe, runCensus } from "../src/census.js";
import { declaredSymbols, generatedLimitName } from "../src/declared.js";
import { stripComments } from "../src/sources.js";

suite("comment stripping", () => {
  test("removes line and block comments but keeps string contents", () => {
    const src = [
      'const a = "keep // this";',
      "// drop undoEligible",
      "/* drop targetBridgeModulePresent */",
      "const b = keepThis;",
    ].join("\n");
    const out = stripComments(src, false);
    expect(out).toContain("keep // this");
    expect(out).toContain("keepThis");
    expect(out).not.toContain("undoEligible");
    expect(out).not.toContain("targetBridgeModulePresent");
  });

  test("preserves offsets so line numbers stay usable", () => {
    const src = "a\n// comment\nb\n";
    expect(stripComments(src, false)).toHaveLength(src.length);
    expect(stripComments(src, false).split("\n")).toHaveLength(4);
  });

  test("leaves JSON untouched", () => {
    const src = '{"a": "http://example.com"}';
    expect(stripComments(src, true)).toBe(src);
  });
});

suite("codegen name lockstep", () => {
  // The census credits a C++ reader of `gen::LIMIT_JSON_MAX_DEPTH` to the
  // `jsonMaxDepth` limit. If scripts/gen-cpp.ts ever spells the constant
  // differently, that credit silently stops and the census starts reporting
  // live limits as dead.
  const header = readFileSync(
    join(REPO_ROOT, "plugins/RackMCP/src/gen/rackmcp_protocol_gen.hpp"),
    "utf8",
  );

  test("every LIMITS key maps to a constant that exists in the generated header", () => {
    const missing = Object.keys(LIMITS).filter(
      (k) => !new RegExp(`\\b${generatedLimitName(k)}\\b`).test(header),
    );
    expect(
      missing.map((k) => `${k} -> ${generatedLimitName(k)}`),
      "the census's name transform no longer matches scripts/gen-cpp.ts",
    ).toEqual([]);
  });

  test("the header declares no LIMIT_ constant the census cannot name", () => {
    const emitted = [...header.matchAll(/\bLIMIT_[A-Z0-9_]+\b/g)].map((m) => m[0]);
    const known = new Set(Object.keys(LIMITS).map(generatedLimitName));
    expect([...new Set(emitted)].filter((n) => !known.has(n))).toEqual([]);
  });
});

suite("contract census", () => {
  const results = runCensus();

  test("finds a non-trivial declared surface", () => {
    // Guards against the census silently scanning nothing and passing.
    expect(declaredSymbols().length).toBeGreaterThan(200);
  });

  test("every declared symbol is implemented or has a stated disposition", () => {
    const orphans = results.filter((r) => !r.implemented && !r.exception);
    expect(
      orphans.map(describe).sort(),
      `${orphans.length} declared symbols have no producer or consumer. Either implement ` +
        `them, delete them, or add a CENSUS_EXCEPTIONS entry in ` +
        `packages/schemas/src/census.ts saying why the symbol is published anyway.`,
    ).toEqual([]);
  });

  test("no exception is stale", () => {
    const stale = results.filter((r) => r.exception && r.implemented);
    expect(
      stale.map((r) => `${r.declared.kind} "${r.declared.symbol}" — ${r.exception?.reason}`).sort(),
      "these now have real implementations; delete their CENSUS_EXCEPTIONS entries",
    ).toEqual([]);
  });

  test("every exception names a symbol that is still declared", () => {
    const declared = new Set(declaredSymbols().map((d) => `${d.kind}:${d.symbol}`));
    const kinds = new Set(declaredSymbols().map((d) => d.kind as string));
    const dangling = CENSUS_EXCEPTIONS.filter(
      // Exceptions for other gates (constant_field, doc_referent) carry kinds
      // that the symbol census does not declare; each is checked by its own gate.
      (e) => kinds.has(e.kind) && !declared.has(`${e.kind}:${e.symbol}`),
    );
    expect(
      dangling.map((e) => `${e.kind} "${e.symbol}"`),
      "these exceptions cover symbols that no longer exist; delete them",
    ).toEqual([]);
  });

  test("every exception gives a real reason", () => {
    const weak = CENSUS_EXCEPTIONS.filter((e) => e.reason.trim().length < 30);
    expect(weak.map((e) => e.symbol), "a disposition needs a reason, not a label").toEqual([]);
  });
});
