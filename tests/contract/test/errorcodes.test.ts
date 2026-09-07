import { describe as suite, expect, test } from "vitest";
import { ERROR_CODES } from "@rackmcp/schemas";
import { emittedCodes, undeclaredCodes, unemittedCodes } from "../src/errorcodes.js";

suite("plugin error codes", () => {
  test("every code the plugin emits is declared in ERROR_CODES", () => {
    const bad = undeclaredCodes().map((e) => `${e.file}:${e.line} -> "${e.code}"`);
    expect(
      bad,
      "the plugin writes error codes as string literals rather than through the generated " +
        "ErrorCode enum, so a typo compiles and reaches a client that branches on the code.",
    ).toEqual([]);
  });

  test("the scan actually finds the plugin's error codes", () => {
    // Without this the gate passes when the patterns stop matching: an empty
    // population has no violations.
    const found = emittedCodes();
    expect(found.length).toBeGreaterThan(40);
    const codes = new Set(found.map((e) => e.code));
    for (const expected of ["BAD_REQUEST", "MODULE_NOT_FOUND", "PATCH_CONFLICT", "INTERNAL"]) {
      expect([...codes], `expected the scan to see ${expected}`).toContain(expected);
    }
    // All three shapes must be represented, or a whole family is unscanned.
    expect(found.some((e) => e.file.includes("service.cpp"))).toBe(true);
    expect(found.some((e) => e.file.includes("Transaction.cpp"))).toBe(true);
  });

  test("reports which declared codes the plugin never raises", () => {
    // Not an assertion: several codes belong to the server. This keeps the
    // number visible so it can be read against the census rather than guessed.
    const unused = unemittedCodes();
    expect(unused.length).toBeLessThan(ERROR_CODES.length);
    console.error(`     codes never raised by the plugin: ${unused.join(", ") || "none"}`);
  });
});
