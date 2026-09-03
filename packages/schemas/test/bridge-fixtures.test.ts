import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRIDGE_METHODS, BRIDGE_METHOD_NAMES } from "../src/bridge.js";

/**
 * Strict-parses a recorded real response for every bridge method against the
 * `result` schema BRIDGE_METHODS declares for it.
 *
 * BRIDGE_METHODS has always declared a result schema per method, but nothing
 * used it at runtime — the protocol client casts, and the server validates only
 * at the tool boundary. That is how eight tools came to return payloads their
 * own published schemas rejected on every call. The live gate that catches this
 * (tests/integration contract-smoke) needs the installed Rack on macOS, so CI
 * could not see the drift on any platform.
 *
 * These fixtures are real captured wire payloads, so this runs everywhere and
 * fails in both directions: a producer that stops matching its schema, and a
 * schema edit that stops matching the real wire. Refresh them against live Rack
 * with `pnpm --filter @rackmcp/integration run capture` — deliberately not
 * hand-editable, because a fixture bent to make CI pass proves nothing.
 */
const FIXTURE_DIR = fileURLToPath(new URL("../../../tests/fixtures/bridge", import.meta.url));

function fixture(method: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${method}.json`), "utf8"));
}

describe("bridge response fixtures match their declared result schemas", () => {
  it("has a fixture for every bridge method", () => {
    const present = readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
    expect(present).toEqual([...BRIDGE_METHOD_NAMES].sort());
  });

  for (const method of BRIDGE_METHOD_NAMES) {
    it(`${method} result matches its schema`, () => {
      const parsed = BRIDGE_METHODS[method].result.safeParse(fixture(method));
      const issues = parsed.success
        ? []
        : parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
      expect(issues).toEqual([]);
    });
  }
});
