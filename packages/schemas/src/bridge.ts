import { z } from "zod";
import { BRIDGE_PROTOCOL_VERSION } from "./limits.js";
import { RackMcpError } from "./errors.js";
import { PatchOperation, RiskFlag, RiskLevel } from "./operations.js";
import { DecimalId, HexHash, PatchEpoch, Scope, SmallIndex, Uuid } from "./refs.js";
import { ModuleSnapshot, PatchSnapshot } from "./snapshot.js";
import { ProbeReading, ProbeSlotInfo } from "./telemetry.js";

/**
 * Bridge wire protocol (spec section 3.3): versioned, length-prefixed JSON over
 * loopback TCP. Frames are UTF-8 JSON preceded by a 4-byte big-endian length.
 */

export const RequestId = z.string().regex(/^[0-9a-f]{16}$/, "8-byte random hex request id");
export const Nonce = z.string().regex(/^[0-9a-f]{64}$/, "32-byte hex nonce");
export const HmacHex = z.string().regex(/^[0-9a-f]{64}$/, "hmac-sha256 hex");

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

export const HelloFrame = z
  .object({
    kind: z.literal("hello"),
    /** Bridge protocol versions the client can speak. */
    versions: z.array(z.number().int().min(1)).min(1).max(16),
    client: z.object({ name: z.string().max(128), version: z.string().max(64) }).strict(),
  })
  .strict();

export const WelcomeFrame = z
  .object({
    kind: z.literal("welcome"),
    /** Negotiated protocol version. */
    version: z.literal(BRIDGE_PROTOCOL_VERSION),
    instanceId: Uuid,
    sessionId: Uuid,
    bridgeVersion: z.string().max(64),
    rackVersion: z.string().max(64),
    rackEdition: z.enum(["Free", "Pro", "unknown"]),
    patchEpoch: PatchEpoch,
    /** Fresh random nonce for HMAC challenge-response authentication. */
    nonce: Nonce,
    authRequired: z.literal(true),
  })
  .strict();

/** hmac = HMAC-SHA256(pairingSecret, utf8(nonce + "|" + instanceId + "|" + sessionId)). */
export const AuthFrame = z
  .object({
    kind: z.literal("auth"),
    hmac: HmacHex,
  })
  .strict();

export const AuthResultFrame = z
  .object({
    kind: z.literal("authResult"),
    ok: z.boolean(),
    /** All authenticated connections start read-only; mutation requires a writer lease. */
    role: z.enum(["readonly"]).optional(),
    error: RackMcpError.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

export const BRIDGE_METHOD_NAMES = [
  "status.get",
  "lease.acquire",
  "lease.renew",
  "lease.release",
  "catalog.listModels",
  "catalog.inspectModel",
  "patch.snapshot",
  "patch.fingerprint",
  "module.inspect",
  "txn.preview",
  "txn.commit",
  "txn.undoLast",
  "patchfile.save",
  "patchfile.saveCopy",
  "patchfile.load",
  "patchfile.clear",
  "probe.list",
  "probe.read",
  "metrics.get",
] as const;
export const BridgeMethod = z.enum(BRIDGE_METHOD_NAMES);
export type BridgeMethod = z.infer<typeof BridgeMethod>;

export const RequestFrame = z
  .object({
    kind: z.literal("req"),
    id: RequestId,
    method: BridgeMethod,
    /** Per-request deadline in milliseconds. */
    deadlineMs: z.number().int().min(1).max(600_000),
    /** Caller-generated UUID; required on all mutating methods for idempotency. */
    operationId: Uuid.optional(),
    payload: z.unknown(),
  })
  .strict();

export const ResponseFrame = z
  .object({
    kind: z.literal("res"),
    id: RequestId,
    ok: z.boolean(),
    payload: z.unknown().optional(),
    error: RackMcpError.optional(),
  })
  .strict();

export const PingFrame = z.object({ kind: z.literal("ping"), id: RequestId }).strict();
export const PongFrame = z.object({ kind: z.literal("pong"), id: RequestId }).strict();

export const EventFrame = z
  .object({
    kind: z.literal("evt"),
    event: z.enum(["shutting_down", "patch_epoch_changed", "lease_revoked"]),
    payload: z.unknown().optional(),
  })
  .strict();

export const BridgeFrame = z.discriminatedUnion("kind", [
  HelloFrame,
  WelcomeFrame,
  AuthFrame,
  AuthResultFrame,
  RequestFrame,
  ResponseFrame,
  PingFrame,
  PongFrame,
  EventFrame,
]);
export type BridgeFrame = z.infer<typeof BridgeFrame>;

// ---------------------------------------------------------------------------
// Method payloads and results
// ---------------------------------------------------------------------------

export const WriterLeaseInfo = z
  .object({
    held: z.boolean(),
    holderClientName: z.string().max(128).optional(),
    leaseId: Uuid.optional(),
    expiresInMs: z.number().int().min(0).optional(),
  })
  .strict();

export const BridgeMetrics = z
  .object({
    commandQueueDepth: z.number().int().min(0),
    commandQueueMaxDepth: z.number().int().min(0),
    requestsHandled: z.number().int().min(0),
    requestTimeouts: z.number().int().min(0),
    rollbacks: z.number().int().min(0),
    authFailures: z.number().int().min(0),
    droppedTelemetryFrames: z.number().int().min(0),
    bridgeReconnects: z.number().int().min(0),
    uiPumpLastDrainMs: z.number().min(0),
    uiPumpMaxDrainMs: z.number().min(0),
    requestLatencyEwmaMs: z.number().min(0),
    // Engine progress counters. Advance only while the audio/fallback engine
    // thread is stepping; a stalled engine (e.g. no master module and paused)
    // holds them constant. Useful for troubleshoot-silence diagnostics.
    engineBlock: z.number().int().min(0).optional(),
    engineFrame: z.number().int().min(0).optional(),
  })
  .strict();
export type BridgeMetrics = z.infer<typeof BridgeMetrics>;

export const StatusResult = z
  .object({
    instanceId: Uuid,
    sessionId: Uuid,
    patchEpoch: PatchEpoch,
    rackVersion: z.string().max(64),
    rackEdition: z.enum(["Free", "Pro", "unknown"]),
    bridgeVersion: z.string().max(64),
    bridgeProtocolVersion: z.number().int().min(1),
    mode: z.literal("standalone-gui"),
    sampleRate: z.number().positive(),
    patchName: z.string().max(512).nullable(),
    saved: z.boolean(),
    bridgeModulePresent: z.boolean(),
    commandPumpPresent: z.boolean(),
    writerLease: WriterLeaseInfo,
  })
  .strict();
export type StatusResult = z.infer<typeof StatusResult>;

export const LeaseAcquirePayload = z
  .object({ clientName: z.string().max(128) })
  .strict();
export const LeaseAcquireResult = z
  .object({ leaseId: Uuid, expiresInMs: z.number().int().min(1) })
  .strict();
export const LeaseRenewPayload = z.object({ leaseId: Uuid }).strict();
export const LeaseRenewResult = z
  .object({ expiresInMs: z.number().int().min(1) })
  .strict();
export const LeaseReleasePayload = z.object({ leaseId: Uuid }).strict();
export const EmptyObject = z.object({}).strict();

export const CatalogListPayload = z
  .object({
    cursor: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();
export const CatalogModelInfo = z
  .object({
    pluginSlug: z.string().max(255),
    pluginName: z.string().max(256),
    pluginVersion: z.string().max(64),
    modelSlug: z.string().max(255),
    modelName: z.string().max(256),
    description: z.string().max(2048),
    tags: z.array(z.string().max(64)).max(32),
  })
  .strict();
export const CatalogListResult = z
  .object({
    models: z.array(CatalogModelInfo).max(500),
    nextCursor: z.string().max(256).nullable(),
    totalModels: z.number().int().min(0),
  })
  .strict();

export const InspectModelPayload = z
  .object({ pluginSlug: z.string().max(255), modelSlug: z.string().max(255) })
  .strict();
export const InspectModelResult = z
  .object({
    model: CatalogModelInfo,
    params: z
      .array(
        z
          .object({
            paramId: SmallIndex,
            name: z.string().max(256),
            unit: z.string().max(64),
            /** Null for an unbounded param (Rack allows +/-INFINITY bounds). */
            minValue: z.number().nullable(),
            maxValue: z.number().nullable(),
            defaultValue: z.number().nullable(),
            labels: z.array(z.string().max(128)).max(64).optional(),
          })
          .strict(),
      )
      .max(4096),
    inputs: z
      .array(z.object({ portId: SmallIndex, name: z.string().max(256) }).strict())
      .max(1024),
    outputs: z
      .array(z.object({ portId: SmallIndex, name: z.string().max(256) }).strict())
      .max(1024),
    /** Metadata inspection required temporary engine-module instantiation. */
    requiredTemporaryInstantiation: z.boolean(),
    cached: z.boolean(),
  })
  .strict();

export const SnapshotPayload = z
  .object({
    includeOpaqueState: z.boolean().default(false),
    /** Hard cap on the serialized snapshot size. */
    maxBytes: z.number().int().min(1024).max(4 * 1024 * 1024).optional(),
  })
  .strict();

export const FingerprintResult = z
  .object({ fingerprint: HexHash, patchEpoch: PatchEpoch, saved: z.boolean() })
  .strict();

export const ModuleInspectPayload = z
  .object({
    scope: Scope,
    moduleId: DecimalId,
    includeOpaqueState: z.boolean().default(false),
  })
  .strict();

// --- Transactions ----------------------------------------------------------

export const NormalizedPlan = z
  .object({
    label: z.string().min(1).max(128),
    operations: z.array(PatchOperation).min(1).max(128),
  })
  .strict();
export type NormalizedPlan = z.infer<typeof NormalizedPlan>;

export const TxnDiff = z
  .object({
    addedModules: z
      .array(
        z
          .object({
            alias: z.string().max(64),
            pluginSlug: z.string().max(255),
            modelSlug: z.string().max(255),
          })
          .strict(),
      )
      .max(128),
    removedModuleIds: z.array(DecimalId).max(4096),
    movedModuleIds: z.array(DecimalId).max(4096),
    modifiedModuleIds: z.array(DecimalId).max(4096),
    addedCableCount: z.number().int().min(0),
    removedCableIds: z.array(DecimalId).max(16384),
    replacedInputPorts: z
      .array(
        z
          .object({ moduleId: DecimalId, portId: SmallIndex })
          .strict(),
      )
      .max(4096),
    stackedInputPorts: z
      .array(
        z
          .object({ moduleId: DecimalId, portId: SmallIndex })
          .strict(),
      )
      .max(4096),
  })
  .strict();
export type TxnDiff = z.infer<typeof TxnDiff>;

export const TxnRisk = z
  .object({
    level: RiskLevel,
    flags: z.array(RiskFlag).max(32),
    reasons: z.array(z.string().max(512)).max(64),
    confirmationRequired: z.boolean(),
  })
  .strict();
export type TxnRisk = z.infer<typeof TxnRisk>;

export const TxnPreviewPayload = z
  .object({
    scope: Scope,
    label: z.string().min(1).max(128),
    operations: z.array(PatchOperation).min(1).max(128),
  })
  .strict();

export const TxnPreviewResult = z
  .object({
    plan: NormalizedPlan,
    /** SHA-256 of the canonical JSON encoding of `plan`, computed plugin-side. */
    planHash: HexHash,
    baseFingerprint: HexHash,
    patchEpoch: PatchEpoch,
    diff: TxnDiff,
    risk: TxnRisk,
    /** Whether Rack history can roll this transaction back after commit. */
    undoable: z.boolean(),
    warnings: z.array(z.string().max(1024)).max(128),
  })
  .strict();
export type TxnPreviewResult = z.infer<typeof TxnPreviewResult>;

export const TxnCommitPayload = z
  .object({
    scope: Scope,
    operationId: Uuid,
    plan: NormalizedPlan,
    planHash: HexHash,
    expectedFingerprint: HexHash,
  })
  .strict();

export const AppliedOperation = z
  .object({
    op: z.string().max(64),
    summary: z.string().max(512),
  })
  .strict();

export const TxnCommitResult = z
  .object({
    operationId: Uuid,
    oldFingerprint: HexHash,
    newFingerprint: HexHash,
    patchEpoch: PatchEpoch,
    applied: z.array(AppliedOperation).max(128),
    aliasToModuleId: z.record(z.string(), DecimalId),
    warnings: z.array(z.string().max(1024)).max(128),
    undoEligible: z.boolean(),
    durationMs: z.number().min(0),
    /** True when this result was served from the idempotency cache. */
    replayed: z.boolean(),
  })
  .strict();
export type TxnCommitResult = z.infer<typeof TxnCommitResult>;

export const TxnUndoPayload = z
  .object({
    scope: Scope,
    /** Operation id of the MCP transaction expected on top of Rack history. */
    expectedOperationId: Uuid,
    operationId: Uuid,
  })
  .strict();
export const TxnUndoResult = z
  .object({
    undone: z.literal(true),
    newFingerprint: HexHash,
    patchEpoch: PatchEpoch,
  })
  .strict();

// --- Patch files -----------------------------------------------------------

export const PatchFilePathPayload = z
  .object({
    scope: Scope,
    /** Absolute, canonicalized, policy-checked server-side AND plugin-side. */
    path: z.string().min(1).max(4096),
    operationId: Uuid,
  })
  .strict();

export const PatchFileLoadPayload = z
  .object({
    scope: Scope,
    path: z.string().min(1).max(4096),
    /** When true the loaded path becomes the current patch path. */
    setPath: z.boolean().default(true),
    operationId: Uuid,
  })
  .strict();

export const PatchFileClearPayload = z
  .object({
    scope: Scope,
    operationId: Uuid,
  })
  .strict();

export const PatchFileResult = z
  .object({
    fingerprint: HexHash,
    patchEpoch: PatchEpoch,
    patchName: z.string().max(512).nullable(),
    saved: z.boolean(),
    bridgeModulePresent: z.boolean(),
    warnings: z.array(z.string().max(1024)).max(64),
    replayed: z.boolean(),
  })
  .strict();

// --- Probes ----------------------------------------------------------------

export const ProbeListResult = z
  .object({ slots: z.array(ProbeSlotInfo).max(128) })
  .strict();

export const ProbeReadPayload = z
  .object({
    scope: Scope,
    probeModuleId: DecimalId,
    probeInputId: SmallIndex,
  })
  .strict();

// ---------------------------------------------------------------------------
// Method table: request/result schema for every bridge method, plus whether
// the method mutates (mutating methods require operationId + writer lease).
// ---------------------------------------------------------------------------

export interface BridgeMethodSpec {
  request: z.ZodType;
  result: z.ZodType;
  mutating: boolean;
}

export const BRIDGE_METHODS: Record<BridgeMethod, BridgeMethodSpec> = {
  "status.get": { request: EmptyObject, result: StatusResult, mutating: false },
  "lease.acquire": { request: LeaseAcquirePayload, result: LeaseAcquireResult, mutating: false },
  "lease.renew": { request: LeaseRenewPayload, result: LeaseRenewResult, mutating: false },
  "lease.release": { request: LeaseReleasePayload, result: EmptyObject, mutating: false },
  "catalog.listModels": { request: CatalogListPayload, result: CatalogListResult, mutating: false },
  "catalog.inspectModel": { request: InspectModelPayload, result: InspectModelResult, mutating: false },
  "patch.snapshot": { request: SnapshotPayload, result: PatchSnapshot, mutating: false },
  "patch.fingerprint": { request: EmptyObject, result: FingerprintResult, mutating: false },
  "module.inspect": { request: ModuleInspectPayload, result: ModuleSnapshot, mutating: false },
  "txn.preview": { request: TxnPreviewPayload, result: TxnPreviewResult, mutating: false },
  "txn.commit": { request: TxnCommitPayload, result: TxnCommitResult, mutating: true },
  "txn.undoLast": { request: TxnUndoPayload, result: TxnUndoResult, mutating: true },
  "patchfile.save": { request: PatchFilePathPayload, result: PatchFileResult, mutating: true },
  "patchfile.saveCopy": { request: PatchFilePathPayload, result: PatchFileResult, mutating: true },
  "patchfile.load": { request: PatchFileLoadPayload, result: PatchFileResult, mutating: true },
  "patchfile.clear": { request: PatchFileClearPayload, result: PatchFileResult, mutating: true },
  "probe.list": { request: EmptyObject, result: ProbeListResult, mutating: false },
  "probe.read": { request: ProbeReadPayload, result: ProbeReading, mutating: false },
  "metrics.get": { request: EmptyObject, result: BridgeMetrics, mutating: false },
};

// ---------------------------------------------------------------------------
// Discovery manifest (spec section 3.3). Never contains the pairing secret.
// ---------------------------------------------------------------------------

export const InstanceManifest = z
  .object({
    manifestVersion: z.literal(1),
    instanceId: Uuid,
    pid: z.number().int().min(1),
    rackVersion: z.string().max(64),
    rackEdition: z.enum(["Free", "Pro", "unknown"]),
    bridgeVersion: z.string().max(64),
    bridgeProtocolVersion: z.number().int().min(1),
    /** Loopback TCP port the bridge listens on (127.0.0.1 only). */
    port: z.number().int().min(1).max(65535),
    startTime: z.iso.datetime(),
    lastHeartbeat: z.iso.datetime(),
    mode: z.literal("standalone-gui"),
    patchName: z.string().max(512).nullable(),
    commandPumpPresent: z.boolean(),
    bridgeModulePresent: z.boolean(),
    /** Directories the MCP server needs for path policy and file listing. */
    userDir: z.string().max(4096),
    patchesDir: z.string().max(4096),
    checkpointsDir: z.string().max(4096),
  })
  .strict();
export type InstanceManifest = z.infer<typeof InstanceManifest>;
