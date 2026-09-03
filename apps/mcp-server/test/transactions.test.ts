import { describe, expect, it } from "vitest";
import type { ConnectionManager, SelectedInstance } from "../src/connection.js";
import { ToolError } from "../src/errors.js";
import { TransactionManager } from "../src/transactions.js";

/**
 * Confirmation-token and preview-guard behaviour (spec section 6). The bridge
 * is faked: only the manager's own checks are under test.
 */

const INSTANCE: SelectedInstance = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  rackVersion: "2.6.6",
  rackEdition: "Free",
  port: 4000,
  pid: 42,
};

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);
const PLAN_HASH = "c".repeat(64);

/** Asserts the thunk throws a ToolError with the given code. */
async function expectCode(p: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    expect((e as ToolError).code).toBe(code);
    return;
  }
  throw new Error(`expected a ToolError(${code})`);
}

/** A ConnectionManager stand-in that answers txn.preview from fixed state. */
function fakeConn(state: { fingerprint?: string; patchEpoch?: number } = {}) {
  return {
    async request(method: string) {
      if (method === "txn.preview") {
        return {
          plan: { label: "l", operations: [] },
          planHash: PLAN_HASH,
          baseFingerprint: state.fingerprint ?? FP_A,
          patchEpoch: state.patchEpoch ?? 7,
          diff: {},
          risk: { level: "low", flags: [], reasons: [], confirmationRequired: false },
          undoable: true,
          warnings: [],
        };
      }
      throw new Error(`unexpected bridge method ${method}`);
    },
    async ensureLease() {},
  };
}

function managerFor(state?: { fingerprint?: string; patchEpoch?: number }): TransactionManager {
  return new TransactionManager(fakeConn(state) as unknown as ConnectionManager);
}

describe("preview stale-state guards", () => {
  it("accepts a preview whose live state matches both guards", async () => {
    const txns = managerFor({ fingerprint: FP_A, patchEpoch: 7 });
    const res = await txns.preview("l", [{}], INSTANCE, { fingerprint: FP_A, patchEpoch: 7 });
    expect(res.preview.planHash).toBe(PLAN_HASH);
    expect(txns.cachedPlan(PLAN_HASH)).not.toBeNull();
  });

  it("rejects a stale expectedPatchEpoch with STALE_PATCH_EPOCH", async () => {
    const txns = managerFor({ patchEpoch: 9 });
    await expectCode(txns.preview("l", [{}], INSTANCE, { patchEpoch: 7 }), "STALE_PATCH_EPOCH");
  });

  it("rejects a stale expectedFingerprint with PATCH_CONFLICT", async () => {
    const txns = managerFor({ fingerprint: FP_A });
    await expectCode(txns.preview("l", [{}], INSTANCE, { fingerprint: FP_B }), "PATCH_CONFLICT");
  });

  it("caches no plan and mints no token for a rejected preview", async () => {
    const txns = managerFor({ fingerprint: FP_A, patchEpoch: 9 });
    await expectCode(txns.preview("l", [{}], INSTANCE, { patchEpoch: 7 }), "STALE_PATCH_EPOCH");
    expect(txns.cachedPlan(PLAN_HASH)).toBeNull();
  });

  it("ignores absent guards (both are optional)", async () => {
    const txns = managerFor({ fingerprint: FP_A, patchEpoch: 9 });
    await expect(txns.preview("l", [{}], INSTANCE)).resolves.toBeDefined();
    await expect(txns.preview("l", [{}], INSTANCE, {})).resolves.toBeDefined();
  });
});

describe("load/clear/restore confirmation tokens", () => {
  const binding = {
    instanceId: INSTANCE.instanceId,
    sessionId: INSTANCE.sessionId,
    kind: "load" as const,
    path: "/patches/a.vcv",
    patchEpoch: 4,
    fingerprint: FP_A,
  };

  it("round-trips the full binding, including the patch state it was previewed against", () => {
    const txns = managerFor();
    const token = txns.mintLoadToken(binding);
    expect(txns.verifyLoadToken(token)).toEqual(binding);
  });

  it("is single-use once consumed", async () => {
    const txns = managerFor();
    const token = txns.mintLoadToken(binding);
    expect(txns.consumeLoadToken(token)).toEqual(binding);
    await expectCode(() => txns.consumeLoadToken(token), "CONFIRMATION_EXPIRED");
    await expectCode(() => txns.verifyLoadToken(token), "CONFIRMATION_EXPIRED");
  });

  it("verifying does not consume", () => {
    const txns = managerFor();
    const token = txns.mintLoadToken(binding);
    txns.verifyLoadToken(token);
    expect(() => txns.verifyLoadToken(token)).not.toThrow();
  });

  it("rejects a tampered MAC and a malformed token", async () => {
    const txns = managerFor();
    const token = txns.mintLoadToken(binding);
    const id = token.slice(0, token.indexOf("."));
    await expectCode(() => txns.verifyLoadToken(`${id}.deadbeef`), "CONFIRMATION_REQUIRED");
    await expectCode(() => txns.verifyLoadToken("nodot"), "CONFIRMATION_REQUIRED");
  });

  it("keeps restore bindings distinguishable from load bindings", () => {
    const txns = managerFor();
    const restore = txns.mintLoadToken({ ...binding, kind: "restore", path: "/checkpoints/c.vcv" });
    expect(txns.verifyLoadToken(restore).kind).toBe("restore");
    expect(txns.verifyLoadToken(txns.mintLoadToken(binding)).kind).toBe("load");
  });
});
