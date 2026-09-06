import { z } from "zod";
import {
  BridgeMetrics,
  CatalogListResult,
  InspectModelResult,
  ProbeListResult,
  StatusResult,
  TxnCommitResult,
  TxnPreviewResult,
  TxnRisk,
} from "./bridge.js";
import { LIMITS } from "./limits.js";
import { PatchOperation } from "./operations.js";
import { DecimalId, HexHash, PatchEpoch, PortRef, SmallIndex, Uuid } from "./refs.js";
import { ModuleSnapshot, ParamSnapshot, PatchSnapshot } from "./snapshot.js";
import { ProbeReading } from "./telemetry.js";
import { ValidationReport } from "./validation.js";

/**
 * MCP tool contracts (spec section 8). One registry shared by the server,
 * contract tests, and documentation generation. Every tool has strict input
 * and output schemas and explicit behavior hints.
 *
 * Scoping note: the server owns the selected instance, its sessionId and its
 * current patchEpoch, and attaches the full Scope to every bridge request.
 * Tool inputs accept an optional expectedPatchEpoch guard; confirmation
 * tokens bind instance, session, epoch, fingerprint and plan hash.
 */

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  annotations: ToolAnnotations;
}

const RO: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const MUT = (destructive: boolean, idempotent: boolean): ToolAnnotations => ({
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: false,
});

const ExpectedEpoch = {
  /** Optional guard: fail with STALE_PATCH_EPOCH when the live epoch differs. */
  expectedPatchEpoch: PatchEpoch.optional(),
};

const ConfirmationTokenField = z.string().min(16).max(512);

export const ConfirmationInfo = z
  .object({
    confirmationToken: ConfirmationTokenField,
    confirmationExpiresAt: z.iso.datetime(),
    confirmationRequired: z.boolean(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Connection and discovery
// ---------------------------------------------------------------------------

export const InstanceSummary = z
  .object({
    instanceId: Uuid,
    pid: z.number().int().min(1),
    rackVersion: z.string().max(64),
    rackEdition: z.enum(["Free", "Pro", "unknown"]),
    bridgeVersion: z.string().max(64),
    port: z.number().int().min(1).max(65535),
    startTime: z.iso.datetime(),
    lastHeartbeat: z.iso.datetime(),
    mode: z.literal("standalone-gui"),
    patchName: z.string().max(512).nullable(),
    commandPumpPresent: z.boolean(),
    bridgeModulePresent: z.boolean(),
    stale: z.boolean(),
    selected: z.boolean(),
  })
  .strict();

export const ListRackInstancesInput = z.object({}).strict();
export const ListRackInstancesOutput = z
  .object({
    instances: z.array(InstanceSummary).max(64),
    discoveryDir: z.string().max(4096),
  })
  .strict();

export const SelectRackInstanceInput = z.object({ instanceId: Uuid }).strict();
export const SelectRackInstanceOutput = z
  .object({ status: StatusResult, connected: z.literal(true) })
  .strict();

export const GetRackStatusInput = z.object({}).strict();
export const GetRackStatusOutput = z
  .object({
    status: StatusResult.nullable(),
    connected: z.boolean(),
    selectedInstanceId: Uuid.nullable(),
    server: z
      .object({
        serverVersion: z.string().max(64),
        bridgeProtocolVersion: z.number().int().min(1),
        supportedRackVersions: z.array(z.string().max(64)),
        metrics: BridgeMetrics.optional(),
      })
      .strict(),
  })
  .strict();

export const AcquireWriterLeaseInput = z.object({}).strict();
export const AcquireWriterLeaseOutput = z
  .object({ leaseId: Uuid, expiresInMs: z.number().int().min(1) })
  .strict();

export const ReleaseWriterLeaseInput = z.object({}).strict();
export const ReleaseWriterLeaseOutput = z.object({ released: z.boolean() }).strict();

// ---------------------------------------------------------------------------
// Catalog and inspection
// ---------------------------------------------------------------------------

export const ListInstalledModelsInput = z
  .object({
    cursor: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(500).default(100),
    /** Case-insensitive substring filter on plugin/model name or slug. */
    query: z.string().max(256).optional(),
  })
  .strict();
export const ListInstalledModelsOutput = CatalogListResult;

export const InspectModelInput = z
  .object({ pluginSlug: z.string().max(255), modelSlug: z.string().max(255) })
  .strict();
export const InspectModelOutput = InspectModelResult.safeExtend({
  adapterAvailable: z.boolean(),
  adapterVersionRange: z.string().max(128).nullable(),
});

export const GetPatchSnapshotInput = z
  .object({
    includeOpaqueState: z.boolean().default(false),
    ...ExpectedEpoch,
  })
  .strict();
export const GetPatchSnapshotOutput = PatchSnapshot;

export const InspectModuleInput = z
  .object({
    moduleId: DecimalId,
    includeOpaqueState: z.boolean().default(false),
    ...ExpectedEpoch,
  })
  .strict();
export const InspectModuleOutput = z
  .object({
    module: ModuleSnapshot,
    adapterAvailable: z.boolean(),
    /** Adapter port/param semantics when available; heuristic hints otherwise. */
    semanticsConfidence: z.enum(["adapter", "heuristic", "none"]),
  })
  .strict();

export const InspectParameterInput = z
  .object({
    moduleId: DecimalId,
    paramId: SmallIndex,
    ...ExpectedEpoch,
  })
  .strict();
export const InspectParameterOutput = z
  .object({
    param: ParamSnapshot,
    moduleId: DecimalId,
    adapterRole: z.string().max(64).nullable(),
    semanticsConfidence: z.enum(["adapter", "heuristic", "none"]),
  })
  .strict();

export const SignalChain = z
  .object({
    description: z.string().max(1024),
    moduleIds: z.array(DecimalId).max(256),
    confidence: z.enum(["certain", "adapter", "heuristic"]),
  })
  .strict();

export const DescribePatchInput = z.object({ ...ExpectedEpoch }).strict();
export const DescribePatchOutput = z
  .object({
    summary: z.string().max(8192),
    moduleCount: z.number().int().min(0),
    cableCount: z.number().int().min(0),
    chains: z.array(SignalChain).max(128),
    unknownModuleCount: z.number().int().min(0),
    warnings: z.array(z.string().max(1024)).max(128),
  })
  .strict();

export const ValidatePatchInput = z.object({ ...ExpectedEpoch }).strict();
export const ValidatePatchOutput = ValidationReport;

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

export const PreviewPatchTransactionInput = z
  .object({
    label: z.string().min(1).max(128),
    operations: z.array(PatchOperation).min(1).max(LIMITS.txnMaxOperations),
    /** Reject the preview when the live fingerprint differs. */
    expectedFingerprint: HexHash.optional(),
    ...ExpectedEpoch,
  })
  .strict();
export const PreviewPatchTransactionOutput = z
  .object({
    preview: TxnPreviewResult,
    confirmation: ConfirmationInfo,
  })
  .strict();

export const CommitPatchTransactionInput = z
  .object({
    /** Caller-generated UUID; retries MUST reuse it. */
    operationId: Uuid,
    planHash: HexHash,
    expectedFingerprint: HexHash,
    /** Required when the preview reported confirmationRequired. */
    confirmationToken: ConfirmationTokenField.optional(),
  })
  .strict();
export const CommitPatchTransactionOutput = TxnCommitResult;

export const UndoLastMcpTransactionInput = z
  .object({ operationId: Uuid })
  .strict();
export const UndoLastMcpTransactionOutput = z
  .object({
    undone: z.literal(true),
    undoneOperationId: Uuid,
    newFingerprint: HexHash,
    patchEpoch: PatchEpoch,
  })
  .strict();

export const BuildPatchInput = z
  .object({
    label: z.string().min(1).max(128),
    operations: z.array(PatchOperation).min(1).max(LIMITS.txnMaxOperations),
    /** Commit automatically when no confirmation is required. */
    autoCommit: z.boolean().default(true),
    operationId: Uuid,
    ...ExpectedEpoch,
  })
  .strict();
export const BuildPatchOutput = z
  .object({
    phase: z.enum(["previewed", "committed"]),
    preview: TxnPreviewResult,
    confirmation: ConfirmationInfo,
    commit: TxnCommitResult.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Patch files and recovery
// ---------------------------------------------------------------------------

export const PatchFileEntry = z
  .object({
    path: z.string().max(4096),
    name: z.string().max(512),
    sizeBytes: z.number().int().min(0),
    modifiedAt: z.iso.datetime(),
    root: z.enum(["patches", "checkpoints"]),
  })
  .strict();

export const ListPatchFilesInput = z
  .object({
    root: z.enum(["patches", "checkpoints", "all"]).default("all"),
    cursor: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();
export const ListPatchFilesOutput = z
  .object({
    files: z.array(PatchFileEntry).max(500),
    nextCursor: z.string().max(256).nullable(),
    roots: z.object({ patches: z.string().max(4096), checkpoints: z.string().max(4096) }).strict(),
  })
  .strict();

export const CreateCheckpointInput = z
  .object({
    label: z.string().max(64).optional(),
    operationId: Uuid,
  })
  .strict();
export const CreateCheckpointOutput = z
  .object({
    checkpointPath: z.string().max(4096),
    fingerprint: HexHash,
    createdAt: z.iso.datetime(),
    replayed: z.boolean(),
  })
  .strict();

export const SavePatchInput = z
  .object({
    /** Defaults to the current patch path; error when the patch has no path. */
    path: z.string().max(4096).optional(),
    operationId: Uuid,
  })
  .strict();
export const SavePatchOutput = z
  .object({
    /**
     * Where the patch was written. Never empty: `save_patch` with no `path`
     * saves where the patch already lives, and a save with no current path is
     * refused plugin-side (PATH_NOT_ALLOWED) rather than succeeding namelessly.
     */
    path: z.string().min(1).max(4096),
    fingerprint: HexHash,
    saved: z.literal(true),
    bridgeModulePresent: z.boolean(),
    /** Warnings, e.g. the saved patch lacks a Bridge module and cannot reconnect after restart. */
    warnings: z.array(z.string().max(1024)).max(64),
    replayed: z.boolean(),
  })
  .strict();

export const LoadPreviewInfo = z
  .object({
    path: z.string().max(4096).nullable(),
    exists: z.boolean(),
    sizeBytes: z.number().int().min(0).nullable(),
    currentPatchSaved: z.boolean(),
    willCreateRecoveryCheckpoint: z.boolean(),
    /** Reason when a recovery checkpoint cannot be created. */
    recoveryCheckpointImpossibleReason: z.string().max(1024).nullable(),
    /**
     * Whether the target patch already contains a RackMCP-Bridge module
     * (null when that cannot be determined without loading, e.g. clear).
     */
    /**
     * Disclosure required by the spec: the commit will insert a Bridge module
     * so the resulting patch can reconnect after restart.
     */
    willInsertBridgeModule: z.boolean(),
    risk: TxnRisk,
    warnings: z.array(z.string().max(1024)).max(64),
  })
  .strict();

export const PreviewLoadPatchInput = z.object({ path: z.string().min(1).max(4096) }).strict();
export const PreviewLoadPatchOutput = z
  .object({ preview: LoadPreviewInfo, confirmation: ConfirmationInfo })
  .strict();

export const CommitLoadPatchInput = z
  .object({
    confirmationToken: ConfirmationTokenField,
    operationId: Uuid,
  })
  .strict();
export const PatchFileCommitOutput = z
  .object({
    fingerprint: HexHash,
    patchEpoch: PatchEpoch,
    patchName: z.string().max(512).nullable(),
    saved: z.boolean(),
    bridgeModulePresent: z.boolean(),
    recoveryCheckpointPath: z.string().max(4096).nullable(),
    warnings: z.array(z.string().max(1024)).max(64),
    replayed: z.boolean(),
  })
  .strict();
export const CommitLoadPatchOutput = PatchFileCommitOutput;

export const PreviewClearPatchInput = z.object({}).strict();
export const PreviewClearPatchOutput = z
  .object({ preview: LoadPreviewInfo, confirmation: ConfirmationInfo })
  .strict();
export const CommitClearPatchInput = CommitLoadPatchInput;
export const CommitClearPatchOutput = PatchFileCommitOutput;

export const RestoreCheckpointInput = z
  .object({
    checkpointPath: z.string().min(1).max(4096),
    /** Without a token this returns phase "preview" and mutates nothing. */
    confirmationToken: ConfirmationTokenField.optional(),
    operationId: Uuid,
  })
  .strict();
export const RestoreCheckpointOutput = z
  .object({
    phase: z.enum(["preview", "restored"]),
    preview: LoadPreviewInfo.optional(),
    confirmation: ConfirmationInfo.optional(),
    result: PatchFileCommitOutput.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export const ListProbesInput = z.object({}).strict();
export const ListProbesOutput = ProbeListResult.safeExtend({
  attachedCount: z.number().int().min(0),
  maxActiveProbes: z.number().int().min(1),
});

export const PreviewAttachProbeInput = z
  .object({
    /** Output port to observe. Probes attach only via an explicit Probe cable. */
    source: PortRef,
    /** Specific probe slot; a free slot is chosen automatically when omitted. */
    probe: z
      .object({ probeModuleId: DecimalId, probeInputId: SmallIndex })
      .strict()
      .optional(),
    ...ExpectedEpoch,
  })
  .strict();
export const PreviewAttachProbeOutput = z
  .object({
    preview: TxnPreviewResult,
    confirmation: ConfirmationInfo,
    /** Slot that will be used; the plan may include adding a Probe module. */
    slot: z
      .object({
        probeModuleId: DecimalId.nullable(),
        probeInputId: SmallIndex,
        addsProbeModule: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const CommitAttachProbeInput = z
  .object({
    operationId: Uuid,
    planHash: HexHash,
    expectedFingerprint: HexHash,
    confirmationToken: ConfirmationTokenField.optional(),
  })
  .strict();
export const CommitAttachProbeOutput = z
  .object({
    commit: TxnCommitResult,
    probeModuleId: DecimalId,
    probeInputId: SmallIndex,
    cableId: DecimalId,
  })
  .strict();

export const ReadProbeInput = z
  .object({
    probeModuleId: DecimalId,
    probeInputId: SmallIndex,
    ...ExpectedEpoch,
  })
  .strict();
export const ReadProbeOutput = ProbeReading;

export const DetachProbeInput = z
  .object({
    probeModuleId: DecimalId,
    probeInputId: SmallIndex,
    operationId: Uuid,
    /**
     * Required (unlike read-only tools): a mutating reference must be bound to
     * the epoch it was minted in so stale probe references are rejected
     * instead of resolving against a different patch (spec section 5).
     */
    expectedPatchEpoch: PatchEpoch,
  })
  .strict();
export const DetachProbeOutput = z
  .object({
    detached: z.literal(true),
    removedCableIds: z.array(DecimalId).max(64),
    newFingerprint: HexHash,
    replayed: z.boolean(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "list_rack_instances",
    title: "List Rack instances",
    description:
      "Discover running VCV Rack instances with the RackMCP plugin loaded, via their local discovery manifests. Reports staleness and which instance is currently selected.",
    input: ListRackInstancesInput,
    output: ListRackInstancesOutput,
    annotations: RO,
  },
  {
    name: "select_rack_instance",
    title: "Select Rack instance",
    description:
      "Connect to a specific running Rack instance and make it the target of all subsequent tools. Authenticates with the local pairing secret.",
    input: SelectRackInstanceInput,
    output: SelectRackInstanceOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_rack_status",
    title: "Get Rack status",
    description:
      "Report connection state, Rack version/edition, patch epoch, patch name, save state, writer-lease ownership, and bridge metrics for the selected instance.",
    input: GetRackStatusInput,
    output: GetRackStatusOutput,
    annotations: RO,
  },
  {
    name: "acquire_writer_lease",
    title: "Acquire writer lease",
    description:
      "Acquire the single writer lease for the selected Rack instance. All mutations require the lease. Fails with LEASE_HELD when another client holds it.",
    input: AcquireWriterLeaseInput,
    output: AcquireWriterLeaseOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "release_writer_lease",
    title: "Release writer lease",
    description: "Release the writer lease held by this client.",
    input: ReleaseWriterLeaseInput,
    output: ReleaseWriterLeaseOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_installed_models",
    title: "List installed models",
    description:
      "Enumerate installed plugins and modules (models) in the selected Rack instance, paginated, with optional name filtering.",
    input: ListInstalledModelsInput,
    output: ListInstalledModelsOutput,
    annotations: RO,
  },
  {
    name: "inspect_model",
    title: "Inspect model",
    description:
      "Return parameter and port metadata for an installed model. Metadata inspection may require temporary engine-module instantiation on the UI thread; this is disclosed and the module is never added to the patch. Results are cached by plugin/model/version.",
    input: InspectModelInput,
    output: InspectModelOutput,
    annotations: RO,
  },
  {
    name: "get_patch_snapshot",
    title: "Get patch snapshot",
    description:
      "Return the full structured state of the current patch: modules, parameters, ports, cables, positions, expanders, bypass state, fingerprint and warnings. Opaque module state is excluded unless explicitly requested.",
    input: GetPatchSnapshotInput,
    output: GetPatchSnapshotOutput,
    annotations: RO,
  },
  {
    name: "inspect_module",
    title: "Inspect module",
    description:
      "Return detailed state for one module, including parameters with display values, ports with connections, and adapter-backed semantics when available.",
    input: InspectModuleInput,
    output: InspectModuleOutput,
    annotations: RO,
  },
  {
    name: "inspect_parameter",
    title: "Inspect parameter",
    description:
      "Return detailed state for one parameter: raw value, range, default, display value and unit, plus adapter semantics when available.",
    input: InspectParameterInput,
    output: InspectParameterOutput,
    annotations: RO,
  },
  {
    name: "describe_patch",
    title: "Describe patch",
    description:
      "Explain the current patch's signal flow in plain language: chains from sources to audio destinations, modulation paths, and notable structure. Confidence is labeled; unknown third-party modules are described heuristically.",
    input: DescribePatchInput,
    output: DescribePatchOutput,
    annotations: RO,
  },
  {
    name: "validate_patch",
    title: "Validate patch",
    description:
      "Run structural and advisory validation of the current patch. Findings carry stable rule ids, severity, confidence (certain/adapter/heuristic), evidence and suggested repairs.",
    input: ValidatePatchInput,
    output: ValidatePatchOutput,
    annotations: RO,
  },
  {
    name: "preview_patch_transaction",
    title: "Preview patch transaction",
    description:
      "Validate a structured patch transaction without mutating Rack. Returns the normalized plan, a diff, risk summary, plan hash, base fingerprint and an expiring confirmation token. Nothing is applied.",
    input: PreviewPatchTransactionInput,
    output: PreviewPatchTransactionOutput,
    annotations: RO,
  },
  {
    name: "commit_patch_transaction",
    title: "Commit patch transaction",
    description:
      "Atomically apply a previously previewed transaction. Requires the exact plan hash and expected base fingerprint; destructive or high-risk plans additionally require the confirmation token. Applies as a single named Rack history action with full rollback on failure. Retries must reuse the same operationId.",
    input: CommitPatchTransactionInput,
    output: CommitPatchTransactionOutput,
    annotations: MUT(true, true),
  },
  {
    name: "undo_last_mcp_transaction",
    title: "Undo last MCP transaction",
    description:
      "Undo the most recent MCP transaction, only when it is still the top Rack history entry, no manual action followed it, and the current fingerprint matches the recorded post-transaction fingerprint. Refuses rather than undoing unrelated user work.",
    input: UndoLastMcpTransactionInput,
    output: UndoLastMcpTransactionOutput,
    annotations: MUT(true, true),
  },
  {
    name: "build_patch",
    title: "Build patch",
    description:
      "High-level convenience: preview a structured operation graph and, when no confirmation is required, commit it in one call. Never bypasses validation or confirmation; risky plans return a token instead of committing.",
    input: BuildPatchInput,
    output: BuildPatchOutput,
    annotations: MUT(true, true),
  },
  {
    name: "list_patch_files",
    title: "List patch files",
    description:
      "List .vcv patch files inside the configured roots (Rack patches directory and RackMCP checkpoints directory), paginated.",
    input: ListPatchFilesInput,
    output: ListPatchFilesOutput,
    annotations: RO,
  },
  {
    name: "create_checkpoint",
    title: "Create checkpoint",
    description:
      "Save a checkpoint copy of the current patch into the RackMCP checkpoints directory without changing the current patch path or save state.",
    input: CreateCheckpointInput,
    output: CreateCheckpointOutput,
    annotations: MUT(false, true),
  },
  {
    name: "save_patch",
    title: "Save patch",
    description:
      "Save the current patch to its current path or a policy-checked .vcv path. Warns when the saved patch lacks a Bridge module and therefore cannot reconnect after restart.",
    input: SavePatchInput,
    output: SavePatchOutput,
    annotations: MUT(true, true),
  },
  {
    name: "preview_load_patch",
    title: "Preview load patch",
    description:
      "Preview loading a .vcv patch: path policy, unsaved-work risk, recovery-checkpoint plan and a confirmation token. Nothing is loaded.",
    input: PreviewLoadPatchInput,
    output: PreviewLoadPatchOutput,
    annotations: RO,
  },
  {
    name: "commit_load_patch",
    title: "Commit load patch",
    description:
      "Load the previewed patch after automatically creating a recovery checkpoint (unless the preview reported why that is impossible). Replaces the current patch; increments the patch epoch.",
    input: CommitLoadPatchInput,
    output: CommitLoadPatchOutput,
    annotations: MUT(true, true),
  },
  {
    name: "preview_clear_patch",
    title: "Preview clear patch",
    description:
      "Preview clearing the current patch, including the recovery-checkpoint plan and a confirmation token. Nothing is cleared.",
    input: PreviewClearPatchInput,
    output: PreviewClearPatchOutput,
    annotations: RO,
  },
  {
    name: "commit_clear_patch",
    title: "Commit clear patch",
    description:
      "Clear the patch after automatically creating a recovery checkpoint (unless the preview reported why that is impossible). Increments the patch epoch.",
    input: CommitClearPatchInput,
    output: CommitClearPatchOutput,
    annotations: MUT(true, true),
  },
  {
    name: "restore_checkpoint",
    title: "Restore checkpoint",
    description:
      "Restore a previously created checkpoint. Called without a confirmation token it returns a preview and token only; called with the token it creates a recovery checkpoint of the current state and then loads the checkpoint.",
    input: RestoreCheckpointInput,
    output: RestoreCheckpointOutput,
    annotations: MUT(true, true),
  },
  {
    name: "list_probes",
    title: "List probes",
    description:
      "List RackMCP-Probe modules and their input slots, showing which are connected and to which source ports.",
    input: ListProbesInput,
    output: ListProbesOutput,
    annotations: RO,
  },
  {
    name: "preview_attach_probe",
    title: "Preview attach probe",
    description:
      "Preview attaching a Probe input to a source output port via an explicit cable, adding a Probe module if none has a free slot. Returns a plan and confirmation info; nothing is mutated.",
    input: PreviewAttachProbeInput,
    output: PreviewAttachProbeOutput,
    annotations: RO,
  },
  {
    name: "commit_attach_probe",
    title: "Commit attach probe",
    description:
      "Apply a previously previewed probe attachment. Signal telemetry is only available through an explicit Probe cable.",
    input: CommitAttachProbeInput,
    output: CommitAttachProbeOutput,
    annotations: MUT(false, true),
  },
  {
    name: "read_probe",
    title: "Read probe",
    description:
      `Read the latest telemetry window from an attached Probe input: per-channel min/max, peak, RMS, DC, clipped and non-finite counts, edge count, window and sample rate. A new window is published every ${LIMITS.probeWindowMs} ms (${LIMITS.probeMaxHz} Hz); reading faster is allowed and simply returns the current window again.`,
    input: ReadProbeInput,
    output: ReadProbeOutput,
    annotations: RO,
  },
  {
    name: "detach_probe",
    title: "Detach probe",
    description: "Disconnect a Probe input's cable(s). The Probe module itself is left in place.",
    input: DetachProbeInput,
    output: DetachProbeOutput,
    annotations: MUT(false, true),
  },
] as const;

export const TOOL_NAMES = TOOLS.map((t) => t.name);
export function getTool(name: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name);
}
