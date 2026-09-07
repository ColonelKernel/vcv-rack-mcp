import { describe as suite, expect, test } from "vitest";
import {
  GEN_SYMBOL_EXCEPTIONS,
  generatedSymbols,
  unreadGeneratedSymbols,
} from "../src/cppgen.js";

suite("generated C++ symbols", () => {
  test("every generated symbol is read by hand-written C++", () => {
    const exempt = new Set(GEN_SYMBOL_EXCEPTIONS.map((e) => e.symbol));
    const unread = unreadGeneratedSymbols().filter((s) => !exempt.has(s));
    expect(
      unread,
      "the C++ generator emits these and nothing reads them. A generated symbol nobody " +
        "reads is worse than a missing one: it reads as a check that exists. Add the reader, " +
        "stop generating it, or add it to GEN_SYMBOL_EXCEPTIONS with a real reason.",
    ).toEqual([]);
  });

  test("the exception list is not stale", () => {
    // A symbol that gains a reader must lose its exception, or the list slowly
    // becomes a record of what used to be true.
    const unread = new Set(unreadGeneratedSymbols());
    const nowRead = GEN_SYMBOL_EXCEPTIONS.filter((e) => !unread.has(e.symbol)).map((e) => e.symbol);
    expect(nowRead, "these are exempted but now have readers; drop the exception").toEqual([]);
  });

  test("every exception carries a reason, and not a placeholder one", () => {
    for (const e of GEN_SYMBOL_EXCEPTIONS) {
      expect(e.reason.length, e.symbol).toBeGreaterThan(40);
      expect(e.reason.startsWith("TODO"), e.symbol).toBe(false);
    }
  });

  test("the scan finds the symbols it is supposed to be checking", () => {
    // Without this the gate passes when the header is renamed, the regexes stop
    // matching, or the generator changes shape -- an empty list of symbols has
    // an empty list of violations.
    const symbols = generatedSymbols();
    expect(symbols.length).toBeGreaterThan(30);
    for (const expected of [
      "OPERATION_SPECS",
      "METHOD_SPECS",
      "FRAME_SPECS",
      "FieldSpec",
      "ErrorCode",
      "BRIDGE_PROTOCOL_VERSION",
      "LIMIT_TXN_MAX_OPERATIONS",
    ]) {
      expect(symbols, `expected ${expected} among the generated symbols`).toContain(expected);
    }
    // The per-field arrays are pointed at by their table and are not separately
    // consumable, so they must not be in the population being checked.
    expect(symbols.filter((s) => s.startsWith("OP_FIELDS_"))).toEqual([]);
  });
});
