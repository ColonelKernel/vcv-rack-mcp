#pragma once
// Two-phase patch transactions (spec section 6). UI thread only.
//
// Preview validates operations without mutating and returns a normalized plan,
// diff, risk summary, plan hash, and base fingerprint. Commit re-checks the
// fingerprint immediately before mutating, applies the plan as ONE named Rack
// history ComplexAction, and rolls back via the ComplexAction's own inverse
// machinery if any operation fails — leaving no orphan engine or UI objects.
#include <string>

typedef struct json_t json_t;

namespace rackmcp {

/** Result of a transaction phase: an owned response payload or an error code. */
struct TxnOutcome {
    json_t* payload = nullptr; // owned by caller on success
    std::string errorCode;     // empty on success
    std::string errorMessage;
    bool retrySafe = false;
    bool mutationMayHaveOccurred = false;
};

/** Validate-only. `payload` matches TxnPreviewResult. Never mutates Rack. */
TxnOutcome txnPreview(json_t* request);

/**
 * Apply a previewed plan atomically. `payload` matches TxnCommitResult.
 * Enforces plan-hash integrity, fingerprint concurrency, and full rollback.
 *
 * On failure `payload` carries a `rollback` RollbackReport and `errorCode` is
 * VALIDATION_FAILED only when the post-rollback fingerprint proves the patch
 * is back to its pre-transaction state; otherwise the report says
 * "indeterminate" and the outcome is ROLLBACK_FAILED with
 * `mutationMayHaveOccurred` set (spec section 6).
 */
TxnOutcome txnCommit(json_t* request);

/** Undo the most recent MCP transaction when it is still safely on top. */
TxnOutcome txnUndoLast(json_t* request);

} // namespace rackmcp
