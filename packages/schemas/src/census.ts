/**
 * Dispositions for contract symbols that are declared here but deliberately
 * have no implementation reference.
 *
 * The contract census (`tests/contract`) fails on any published symbol that no
 * producer or consumer names. That is the point: a field in a JSON Schema, an
 * error code in an enum, or a limit in `LIMITS` is a promise to a client, and a
 * promise nothing implements is a lie the client cannot detect.
 *
 * Some symbols legitimately have no reference, and each one needs a reason
 * stated here rather than an exclusion buried in a test:
 *
 * - `structurally-fixed` — the value can only ever be one thing, because of how
 *   the system is built rather than because of a runtime check. Publishing the
 *   field is still right; implementing a branch for it would be dead code.
 * - `client-consumed` — produced for the MCP client and never read by this
 *   codebase. The census cannot see the consumer, so it must be declared.
 * - `reserved` — deliberately declared ahead of its implementation, with the
 *   implementation planned. Every `reserved` entry is a debt.
 *
 * This list is exported so a client can read the dispositions rather than
 * discovering them by experiment.
 */
export type CensusDisposition = "structurally-fixed" | "client-consumed" | "reserved";

export interface CensusException {
  /** The declared symbol, spelled exactly as it is published. */
  readonly symbol: string;
  /** Which declared surface it belongs to, so homonyms stay distinguishable. */
  readonly kind: string;
  readonly disposition: CensusDisposition;
  /**
   * Why this symbol has no implementation reference. Must say something a
   * reader could disagree with; "not used" is not a reason.
   */
  readonly reason: string;
}

export const CENSUS_EXCEPTIONS: readonly CensusException[] = [
  {
    symbol: "OPAQUE_STATE_UNSUPPORTED",
    kind: "error_code",
    disposition: "structurally-fixed",
    reason:
      "No operation writes opaque module state, so nothing can reach the condition this code " +
      "reports. It stays published because its absence is the guarantee: a client that sees the " +
      "code defined and never returned knows the boundary is enforced by there being no such " +
      "operation at all, not by a runtime check that might be missed.",
  },
  {
    symbol: "large_transaction",
    kind: "risk_flag",
    disposition: "reserved",
    reason:
      "TODO: phase 2 — give it a producer in Transaction.cpp, thresholded on " +
      "gen::LIMIT_TXN_MAX_OPERATIONS. A client is told this flag exists and can reasonably " +
      "assume big plans are marked; today nothing marks them.",
  },
  {
    symbol: "txnMaxOperations",
    kind: "limit",
    disposition: "reserved",
    reason:
      "TODO: phase 2 — substitute for the hardcoded .max(128) in tools.ts, so the published limit " +
      "and the enforced limit cannot drift apart.",
  },
  {
    symbol: "patchIoTimeoutMs",
    kind: "limit",
    disposition: "reserved",
    reason:
      "TODO: phase 2 — becomes a ServerConfig field, replacing hardcoded 60_000 literals. " +
      "Published as configurable while nothing reads it.",
  },
  {
    symbol: "probeMaxHz",
    kind: "limit",
    disposition: "reserved",
    reason:
      "TODO: phase 2 — interpolate into read_probe's description, which currently states the " +
      "number in prose where it can drift from the constant.",
  },
  {
    symbol: "probeInputsPerModule",
    kind: "limit",
    disposition: "reserved",
    reason:
      "TODO: phase 2 — deduplicate the three independent copies of the value (here, " +
      "ProbeModule.hpp and telemetry.ts) behind gen::LIMIT_PROBE_INPUTS_PER_MODULE.",
  },
  {
    symbol: "smoothMs",
    kind: "schema_property",
    disposition: "reserved",
    reason:
      "TODO: phase 4 — implement parameter ramping. This is the worst kind of dead field: it is " +
      "accepted by the schema and silently ignored, so a client asking for a smooth change gets " +
      "a jump and no error.",
  },
  {
    symbol: "packages/test-client",
    kind: "doc_referent",
    disposition: "reserved",
    reason:
      "TODO: phase 3 — build it. README.md and the spec both list a scriptable MCP test client " +
      "as a shipped package; the directory is empty and untracked, so a reader who goes looking " +
      "finds nothing. The code exists, duplicated across ten files in tests/integration/src.",
  },
  {
    symbol: "tests/fuzz",
    kind: "doc_referent",
    disposition: "reserved",
    reason:
      "TODO: phase 8 — populate it. It is listed in pnpm-workspace.yaml and in the spec's " +
      "monorepo layout, but is an empty untracked directory: the fast-check properties live in " +
      "packages/schemas/test and the libFuzzer targets in tests/cpp.",
  },
  {
    symbol: "opaqueStateDisclosed",
    kind: "constant_field",
    disposition: "structurally-fixed",
    reason:
      "Emitted only inside the includeOpaqueState branch, so its false case is unreachable. Kept " +
      "as an explicit label because a client deciding whether state was disclosed should read a " +
      "field that says so, not infer it from whether a sibling key happens to be present.",
  },
  {
    symbol: "undoable",
    kind: "constant_field",
    disposition: "structurally-fixed",
    reason:
      "A transaction is applied as a single history::ComplexAction, so a committed plan is always " +
      "undoable. The field is published because the guarantee is worth stating to a client that " +
      "would otherwise have to assume the weaker case.",
  },
  {
    symbol: "undone",
    kind: "constant_field",
    disposition: "structurally-fixed",
    reason:
      "The undo handler emits a payload only on success and returns an error otherwise, so a " +
      "false value can never be constructed. Present so the success result is self-describing.",
  },
  {
    symbol: "undoEligible",
    kind: "constant_field",
    disposition: "reserved",
    reason:
      "TODO: phase 6 — delete. It is a second copy of the same always-true claim as undoable, on " +
      "the commit result rather than the preview result.",
  },
  {
    symbol: "requiredTemporaryInstantiation",
    kind: "constant_field",
    disposition: "reserved",
    reason:
      "TODO: phase 6 — delete. Metadata can only be produced by instantiating the model once, so " +
      "this is true in every response, including cache hits which replay the stored payload " +
      "verbatim. The field that actually varies, and that a client should read, is cached.",
  },
  {
    symbol: "copyCables",
    kind: "schema_property",
    disposition: "reserved",
    reason:
      "TODO: phase 4 — implement duplicate_module, whose operation this field belongs to. The " +
      "operation is currently refused outright, so the field cannot be reached.",
  },
];
