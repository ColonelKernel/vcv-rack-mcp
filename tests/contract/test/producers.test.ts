import { describe as suite, expect, test } from "vitest";
import { CENSUS_EXCEPTIONS } from "@rackmcp/schemas";
import { alwaysConstantKeys, describeProducer, keyProducers } from "../src/producers.js";

suite("always-constant producers", () => {
  test("the scanner sees a realistic number of emitted keys", () => {
    // If the regex stops matching, every gate below passes vacuously.
    expect(keyProducers().length).toBeGreaterThan(100);
  });

  test("a key with a dynamic producer is not called constant", () => {
    // "snapped" is json_boolean(pq->snapEnabled) on the real path and
    // json_false() only in the no-ParamQuantity fallback.
    const constant = new Set(alwaysConstantKeys().map((p) => p.key));
    expect(constant.has("snapped")).toBe(false);
    expect(keyProducers().find((p) => p.key === "snapped")?.sites.length).toBeGreaterThan(1);
  });

  test("every always-constant field has a stated disposition", () => {
    const excused = new Set(
      CENSUS_EXCEPTIONS.filter((e) => e.kind === "constant_field").map((e) => e.symbol),
    );
    const undisclosed = alwaysConstantKeys().filter((p) => !excused.has(p.key));
    expect(
      undisclosed.map(describeProducer),
      "these fields can only ever carry one value. Either make them vary, delete them, or add " +
        'a CENSUS_EXCEPTIONS entry with kind "constant_field" saying why a client should still ' +
        "be told.",
    ).toEqual([]);
  });

  test("no constant_field exception is stale", () => {
    const constant = new Set(alwaysConstantKeys().map((p) => p.key));
    const stale = CENSUS_EXCEPTIONS.filter(
      (e) => e.kind === "constant_field" && !constant.has(e.symbol),
    );
    expect(
      stale.map((e) => e.symbol),
      "these fields now vary, or are no longer emitted; delete their exceptions",
    ).toEqual([]);
  });
});
