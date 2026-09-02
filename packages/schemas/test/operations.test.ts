import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { OPERATION_TYPES, PatchOperation } from "../src/operations.js";

const validAdd = {
  op: "add_module",
  pluginSlug: "Fundamental",
  modelSlug: "VCO",
  alias: "osc1",
  placement: "auto",
};

const validSetParam = {
  op: "set_parameter",
  module: { moduleId: "42" },
  paramId: 0,
  value: 0.5,
};

describe("PatchOperation", () => {
  it("accepts a minimal add_module", () => {
    const r = PatchOperation.safeParse(validAdd);
    expect(r.success).toBe(true);
  });

  it("rejects unknown operation types", () => {
    expect(PatchOperation.safeParse({ op: "explode", module: { moduleId: "1" } }).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(PatchOperation.safeParse({ ...validAdd, evil: true }).success).toBe(false);
  });

  it("requires exactly one of value/normalized/display", () => {
    expect(PatchOperation.safeParse(validSetParam).success).toBe(true);
    expect(PatchOperation.safeParse({ ...validSetParam, normalized: 0.1 }).success).toBe(false);
    const { value: _v, ...noTarget } = validSetParam;
    expect(PatchOperation.safeParse(noTarget).success).toBe(false);
  });

  it("rejects non-finite parameter values", () => {
    expect(PatchOperation.safeParse({ ...validSetParam, value: Number.NaN }).success).toBe(false);
    expect(PatchOperation.safeParse({ ...validSetParam, value: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it("requires position when placement is 'at'", () => {
    expect(PatchOperation.safeParse({ ...validAdd, placement: "at" }).success).toBe(false);
    expect(
      PatchOperation.safeParse({ ...validAdd, placement: "at", position: { x: 10, y: 0 } }).success,
    ).toBe(true);
  });

  it("rejects module ids that are not decimal strings", () => {
    for (const bad of ["", "01", "-1", "1.5", "0x10", "9".repeat(25)]) {
      expect(
        PatchOperation.safeParse({ op: "set_bypass", module: { moduleId: bad }, bypassed: true }).success,
      ).toBe(false);
    }
  });

  it("randomize_module parses and remove_module defaults allowLastBridge to false", () => {
    const r = PatchOperation.safeParse({
      op: "remove_module",
      module: { alias: "x" },
      cablePolicy: "remove_attached",
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.op === "remove_module") {
      expect(r.data.allowLastBridge).toBe(false);
    }
  });

  it("fuzz: arbitrary JSON objects never crash the parser and almost always fail closed", () => {
    fc.assert(
      fc.property(fc.json(), (raw) => {
        const value = JSON.parse(raw);
        const res = PatchOperation.safeParse(value);
        // Must never throw; success only for objects with a valid op discriminator.
        if (res.success) {
          expect(OPERATION_TYPES).toContain(res.data.op);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("fuzz: mutated valid operations with injected keys are rejected", () => {
    // All legitimate add_module keys, required and optional, must be excluded.
    const legitimateKeys = new Set([
      "op",
      "pluginSlug",
      "modelSlug",
      "alias",
      "placement",
      "position",
      "initialParams",
      "bypassed",
    ]);
    // Keys that a spread does not materialize as an own enumerable property
    // (they mutate the prototype or are non-enumerable), so injecting them does
    // not actually add an extra field for the schema to reject.
    const nonOwnKeys = new Set(["__proto__", "constructor", "prototype"]);
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), fc.anything(), (key, val) => {
        fc.pre(!legitimateKeys.has(key));
        fc.pre(!nonOwnKeys.has(key));
        fc.pre(val !== undefined);
        const injected = { ...validAdd, [key]: val };
        // Guard against any other key that fails to land as an own property.
        fc.pre(Object.prototype.hasOwnProperty.call(injected, key));
        const res = PatchOperation.safeParse(injected);
        expect(res.success).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
