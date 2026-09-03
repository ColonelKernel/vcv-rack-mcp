import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { LIMITS } from "@rackmcp/schemas";
import type { ConnectionManager, SelectedInstance } from "./connection.js";
import { ToolError } from "./errors.js";

/**
 * Confirmation-token minting/validation and preview-plan caching (spec section
 * 6). Tokens bind instance, session, patch epoch, base fingerprint, plan hash,
 * risk classification and expiry via an HMAC keyed by a per-process secret, so
 * a commit can only proceed against the exact plan and state that was
 * previewed. The plan itself is cached here (the commit tool receives only the
 * plan hash) and forwarded to the plugin.
 */

interface CachedPlan {
  plan: unknown;
  baseFingerprint: string;
  patchEpoch: number;
  riskLevel: string;
  confirmationRequired: boolean;
  instanceId: string;
  sessionId: string;
  expiresAt: number;
}

interface TokenBinding {
  instanceId: string;
  sessionId: string;
  patchEpoch: number;
  baseFingerprint: string;
  planHash: string;
  riskLevel: string;
  expiresAt: number;
}

interface LoadBinding {
  instanceId: string;
  sessionId: string;
  kind: "load" | "clear" | "restore";
  path: string | null;
  /** Live patch state at preview time; re-verified before the destructive step. */
  patchEpoch: number;
  fingerprint: string;
  expiresAt: number;
}

/** A load/clear/restore binding as handed to the commit path (single use). */
export type LoadTokenBinding = Omit<LoadBinding, "expiresAt">;

export class TransactionManager {
  private readonly key = randomBytes(32);
  private plans = new Map<string, CachedPlan>();
  private loadBindings = new Map<string, LoadBinding>();

  constructor(private readonly conn: ConnectionManager) {}

  private mintToken(binding: TokenBinding): string {
    const body = Buffer.from(JSON.stringify(binding), "utf8").toString("base64url");
    const mac = createHmac("sha256", this.key).update(body).digest("base64url");
    return `${body}.${mac}`;
  }

  private verifyToken(token: string): TokenBinding {
    const dot = token.indexOf(".");
    if (dot < 0) throw new ToolError("CONFIRMATION_REQUIRED", "malformed confirmation token");
    const body = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const expected = createHmac("sha256", this.key).update(body).digest("base64url");
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ToolError("CONFIRMATION_REQUIRED", "invalid confirmation token");
    }
    const binding = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenBinding;
    if (Date.now() > binding.expiresAt) {
      throw new ToolError("CONFIRMATION_EXPIRED", "confirmation token has expired");
    }
    return binding;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.plans) if (v.expiresAt < now) this.plans.delete(k);
  }

  async preview(
    label: string,
    operations: unknown[],
    instance: SelectedInstance,
    expected: { fingerprint?: string | undefined; patchEpoch?: number | undefined } = {},
  ) {
    this.pruneExpired();
    const scope = {
      instanceId: instance.instanceId,
      sessionId: instance.sessionId,
      patchEpoch: 0, // plugin reads live epoch; scope epoch is advisory here
    };
    const result = await this.conn.request<{
      plan: unknown;
      planHash: string;
      baseFingerprint: string;
      patchEpoch: number;
      diff: unknown;
      risk: { level: string; flags: string[]; reasons: string[]; confirmationRequired: boolean };
      undoable: boolean;
      warnings: string[];
    }>("txn.preview", { scope, label, operations });

    // Spec section 6 step 3: reject a preview built on state the caller did not
    // expect. The plugin reads neither guard on the preview path, so compare
    // here against the live epoch and fingerprint it just reported — before a
    // plan is cached or a token minted, so nothing stale can be committed.
    if (expected.patchEpoch !== undefined && result.patchEpoch !== expected.patchEpoch) {
      throw new ToolError(
        "STALE_PATCH_EPOCH",
        `patch epoch is ${result.patchEpoch}, not the expected ${expected.patchEpoch}; re-read the snapshot`,
      );
    }
    if (expected.fingerprint !== undefined && result.baseFingerprint !== expected.fingerprint) {
      throw new ToolError(
        "PATCH_CONFLICT",
        "the patch changed since the fingerprint you supplied; re-read the snapshot",
      );
    }

    const expiresAt = Date.now() + LIMITS.confirmationLifetimeMs;
    this.plans.set(result.planHash, {
      plan: result.plan,
      baseFingerprint: result.baseFingerprint,
      patchEpoch: result.patchEpoch,
      riskLevel: result.risk.level,
      confirmationRequired: result.risk.confirmationRequired,
      instanceId: instance.instanceId,
      sessionId: instance.sessionId,
      expiresAt,
    });

    const token = this.mintToken({
      instanceId: instance.instanceId,
      sessionId: instance.sessionId,
      patchEpoch: result.patchEpoch,
      baseFingerprint: result.baseFingerprint,
      planHash: result.planHash,
      riskLevel: result.risk.level,
      expiresAt,
    });

    return {
      preview: result,
      confirmation: {
        confirmationToken: token,
        confirmationExpiresAt: new Date(expiresAt).toISOString(),
        confirmationRequired: result.risk.confirmationRequired,
      },
    };
  }

  async commit(args: {
    operationId: string;
    planHash: string;
    expectedFingerprint: string;
    confirmationToken?: string | undefined;
    instance: SelectedInstance;
  }) {
    this.pruneExpired();
    const cached = this.plans.get(args.planHash);
    if (!cached) {
      throw new ToolError(
        "CONFIRMATION_EXPIRED",
        "no cached plan for this plan hash; re-run preview",
        true,
      );
    }
    if (cached.instanceId !== args.instance.instanceId || cached.sessionId !== args.instance.sessionId) {
      throw new ToolError("STALE_SESSION", "plan was previewed against a different session");
    }
    if (cached.confirmationRequired) {
      if (!args.confirmationToken) {
        throw new ToolError("CONFIRMATION_REQUIRED", "this plan requires a confirmation token");
      }
      const binding = this.verifyToken(args.confirmationToken);
      if (
        binding.planHash !== args.planHash ||
        binding.baseFingerprint !== args.expectedFingerprint ||
        binding.instanceId !== args.instance.instanceId ||
        binding.sessionId !== args.instance.sessionId
      ) {
        throw new ToolError("CONFIRMATION_REQUIRED", "confirmation token does not bind this commit");
      }
    }

    await this.conn.ensureLease();
    const scope = {
      instanceId: args.instance.instanceId,
      sessionId: args.instance.sessionId,
      patchEpoch: cached.patchEpoch,
    };
    const result = await this.conn.request(
      "txn.commit",
      {
        scope,
        operationId: args.operationId,
        plan: cached.plan,
        planHash: args.planHash,
        expectedFingerprint: args.expectedFingerprint,
      },
      { operationId: args.operationId, deadlineMs: 30_000 },
    );
    this.plans.delete(args.planHash);
    return result;
  }

  cachedPlan(planHash: string): { baseFingerprint: string; confirmationRequired: boolean } | null {
    const c = this.plans.get(planHash);
    return c ? { baseFingerprint: c.baseFingerprint, confirmationRequired: c.confirmationRequired } : null;
  }

  /**
   * Mints a confirmation token for a load/clear/restore operation. The binding
   * (including the possibly-long path) is held server-side and keyed by a short
   * random id, so the token stays opaque and well under the size cap. Like a
   * transaction token it binds instance, session, kind, target path and the
   * patch state the preview described; it is single-use (see consumeLoadToken).
   */
  mintLoadToken(binding: LoadTokenBinding): string {
    const now = Date.now();
    for (const [k, v] of this.loadBindings) if (v.expiresAt < now) this.loadBindings.delete(k);
    const id = randomBytes(18).toString("base64url");
    this.loadBindings.set(id, { ...binding, expiresAt: now + LIMITS.confirmationLifetimeMs });
    const mac = createHmac("sha256", this.key).update(id).digest("base64url");
    return `${id}.${mac}`;
  }

  /** Validates a load/clear/restore token and returns its binding, unchanged. */
  verifyLoadToken(token: string): LoadTokenBinding {
    const { binding } = this.lookupLoadToken(token);
    return {
      instanceId: binding.instanceId,
      sessionId: binding.sessionId,
      kind: binding.kind,
      path: binding.path,
      patchEpoch: binding.patchEpoch,
      fingerprint: binding.fingerprint,
    };
  }

  /**
   * Validates a load/clear/restore token and burns it, so one previewed
   * confirmation authorises exactly one destructive commit (the transaction
   * path gets this from deleting the cached plan on commit). Call immediately
   * before the destructive request.
   */
  consumeLoadToken(token: string): LoadTokenBinding {
    const { id, binding } = this.lookupLoadToken(token);
    this.loadBindings.delete(id);
    return {
      instanceId: binding.instanceId,
      sessionId: binding.sessionId,
      kind: binding.kind,
      path: binding.path,
      patchEpoch: binding.patchEpoch,
      fingerprint: binding.fingerprint,
    };
  }

  private lookupLoadToken(token: string): { id: string; binding: LoadBinding } {
    const dot = token.indexOf(".");
    if (dot < 0) throw new ToolError("CONFIRMATION_REQUIRED", "malformed confirmation token");
    const id = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const expected = createHmac("sha256", this.key).update(id).digest("base64url");
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ToolError("CONFIRMATION_REQUIRED", "invalid confirmation token");
    }
    const binding = this.loadBindings.get(id);
    if (!binding) {
      throw new ToolError(
        "CONFIRMATION_EXPIRED",
        "confirmation token is unknown, already used, or expired; re-run the preview",
      );
    }
    if (Date.now() > binding.expiresAt) {
      this.loadBindings.delete(id);
      throw new ToolError("CONFIRMATION_EXPIRED", "confirmation token has expired");
    }
    return { id, binding };
  }
}
