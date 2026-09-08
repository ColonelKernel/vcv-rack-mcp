import { expect } from "vitest";
import { BRIDGE_METHODS } from "@rackmcp/schemas";

/**
 * Every bridge request this server builds must satisfy the request schema the
 * same package declares for that method.
 *
 * Nothing validates outbound frames at runtime. The plugin checks the generated
 * required-field table, which tests presence and JSON type but neither domain
 * nor nested shape, so a server that sends a value its own schema forbids ships
 * silently -- as three already had: `module.inspect` with no `scope` (38e0b40),
 * `patchfile.save` with `path: ""` against a `.min(1)`, and every `scope` with a
 * `patchEpoch` of 0.
 *
 * The fakes in these tests already receive every payload the handlers build, so
 * this is free coverage: record the calls, and check them once per test.
 *
 * Applied where the payload is genuinely server-constructed -- `patchfiles`,
 * whose handlers build every field from paths, uuids and a scope. Deliberately
 * NOT applied to `transactions`, where `TransactionManager.preview` takes
 * `operations: unknown[]` and forwards it verbatim (the operation schema is
 * enforced at the tool input, not here), so the tests pass `[{}]` on purpose
 * and the only field the manager itself builds is the scope. There the gate
 * would report the placeholder rather than a defect.
 */
export interface RecordedCall {
  readonly method: string;
  readonly payload: unknown;
}

/**
 * Divergences between what this server sends and what `BRIDGE_METHODS`
 * declares, each with the reason it is not fixed. Keyed by the JSON path of the
 * offending field, so an entry excuses that field wherever it appears.
 *
 * A stale entry fails, like `CENSUS_EXCEPTIONS`: fixing a divergence means
 * removing its excuse in the same commit, or the next one to appear at that
 * path is silently excused too.
 */
export const KNOWN_REQUEST_DIVERGENCES: readonly { path: string; reason: string }[] = [
  {
    path: "scope.patchEpoch",
    reason:
      "every scopeFor() hardcodes 0 (patchfiles.ts, telemetry.ts, transactions.ts, the last with " +
      "a comment calling the scope epoch advisory), while Scope declares PatchEpoch = min(1). " +
      "The plugin never reads scope, and the real guard is the separate expectedPatchEpoch that " +
      "Handlers.cpp checks -- but spec section 5 requires the epoch in every scope and requires " +
      "stale references to be rejected, so this is unimplemented rather than speculative. " +
      "Sending the live epoch changes the wire and needs a fixture recapture: it is Phase 6.",
  },
];

const EXCUSED = new Set(KNOWN_REQUEST_DIVERGENCES.map((d) => d.path));

/** Paths excused at least once across the whole run, for the staleness check. */
const seen = new Set<string>();

/** Asserts every recorded call matches its declared request schema. */
export function expectDeclaredRequests(calls: readonly RecordedCall[]): void {
  for (const call of calls) {
    const spec = BRIDGE_METHODS[call.method as keyof typeof BRIDGE_METHODS];
    expect(spec, `${call.method} is not a declared bridge method`).toBeDefined();
    const res = spec.request.safeParse(call.payload);
    if (res.success) continue;
    const unexcused = res.error.issues.filter((i) => {
      const at = i.path.join(".");
      if (!EXCUSED.has(at)) return true;
      seen.add(at);
      return false;
    });
    expect(unexcused, `${call.method} request does not match its declared schema`).toEqual([]);
  }
}

/**
 * Fails when an excused divergence no longer occurs. Call from an `afterAll` in
 * the one file that exercises every excused path -- checking per test would red
 * on tests that never build a payload carrying the field.
 */
export function expectNoStaleDivergences(): void {
  for (const d of KNOWN_REQUEST_DIVERGENCES) {
    expect(
      seen.has(d.path),
      `${d.path} no longer diverges from its declared schema; remove it from ` +
        `KNOWN_REQUEST_DIVERGENCES`,
    ).toBe(true);
  }
}
