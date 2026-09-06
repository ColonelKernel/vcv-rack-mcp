import { z } from "zod";
import { BRIDGE_PROTOCOL_MIN_SUPPORTED, BRIDGE_PROTOCOL_VERSION } from "./limits.js";
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
    /**
     * The version both sides settled on: the highest the client offered that
     * the plugin still supports. A range rather than a literal so that raising
     * BRIDGE_PROTOCOL_VERSION without raising the floor keeps older clients
     * working, which is the entire point of having a floor.
     */
    version: z
      .number()
      .int()
      .min(BRIDGE_PROTOCOL_MIN_SUPPORTED)
      .max(BRIDGE_PROTOCOL_VERSION),
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
  "chat.poll",
  "chat.post",
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
    /**
     * `user_note_pending` is a doorbell, not a message: it carries no payload,
     * and the note itself is fetched with an ordinary `chat.poll`. Keeping the
     * payload empty is deliberate — an event is fire-and-forget with no id, no
     * ack and no retry, so anything delivered only that way can be lost.
     */
    event: z.enum([
      "shutting_down",
      "patch_epoch_changed",
      "lease_revoked",
      "user_note_pending",
    ]),
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
    /** Commands whose deadline expired while queued for the UI thread. */
    requestTimeouts: z.number().int().min(0),
    /** Transactions whose apply failed and whose inverses were run. */
    rollbacks: z.number().int().min(0),
    authFailures: z.number().int().min(0),
    /**
     * Always zero, and correct: telemetry is pull-based -- `probe.read` is a
     * request -- so no telemetry frame is ever pushed and none can be dropped.
     * Published because spec section 13 names it. Not the same thing as an
     * unimplemented counter: there is no event here to count.
     */
    droppedTelemetryFrames: z.number().int().min(0),
    /** Connections accepted over this service's lifetime, first one included. */
    bridgeReconnects: z.number().int().min(0),
    uiPumpLastDrainMs: z.number().min(0),
    uiPumpMaxDrainMs: z.number().min(0),
    /**
     * Smoothed queue wait plus execution for commands the UI pump drains
     * (alpha = 1/8). Requests answered inline on the reader thread -- leases,
     * ping -- never queue and are not sampled, so this measures the path where
     * the time actually goes.
     */
    requestLatencyEwmaMs: z.number().min(0),
    // Engine progress counters. Advance only while the audio/fallback engine
    // thread is stepping; a stalled engine (e.g. no master module and paused)
    // holds them constant. Useful for troubleshoot-silence diagnostics.
    engineBlock: z.number().int().min(0).optional(),
    engineFrame: z.number().int().min(0).optional(),
    /**
     * Frames the bridge could not put on the wire, and results too large to
     * try. `oversizedResults` counts replies answered with RESULT_TOO_LARGE
     * instead of being dropped; a non-zero `responseDrops` or `protocolErrors`
     * means a frame was discarded with no reply at all, which a caller can
     * otherwise only observe as an unexplained timeout.
     */
    protocolErrors: z.number().int().min(0),
    responseDrops: z.number().int().min(0),
    oversizedResults: z.number().int().min(0),
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

/**
 * Concurrency control only. Whether the patch has unsaved changes is not part
 * of this result: `status.get` owns that, and duplicating it here would give
 * two sources of truth that can disagree between calls.
 */
export const FingerprintResult = z
  .object({ fingerprint: HexHash, patchEpoch: PatchEpoch })
  .strict();

/** module.inspect wraps the snapshot: `{ module: ... }` on the wire. */
export const ModuleInspectResult = z.object({ module: ModuleSnapshot }).strict();

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
    /**
     * The path the CURRENT patch now lives at, resolved plugin-side. `save`
     * with no request path means "save where this patch already lives", and
     * only the plugin knows where that is. Empty after a clear, which genuinely
     * leaves the patch pathless, and unchanged by `saveCopy`, which writes a
     * copy without adopting its path -- so it reports where the live patch
     * still points, not where the copy went (the caller supplied that).
     */
    path: z.string().max(4096),
    saved: z.boolean(),
    bridgeModulePresent: z.boolean(),
    warnings: z.array(z.string().max(1024)).max(64),
    replayed: z.boolean(),
  })
  .strict();
export type PatchFileResult = z.infer<typeof PatchFileResult>;

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

// ---------------------------------------------------------------------------
// In-Rack chat (RackMCP-Chat panel)
// ---------------------------------------------------------------------------

/**
 * A note the user typed into the Chat module's panel.
 *
 * Nothing inside Rack can wake the assistant — the bridge is request/response
 * with the server as the requester, and the server cannot push to its host
 * either. So a note waits in the plugin until the assistant next calls a tool,
 * and `seq` exists so a client can resume without re-reading what it has
 * already seen.
 */
export const UserNote = z
  .object({
    seq: z.number().int().positive(),
    text: z.string().min(1).max(2000),
    /** hh:mm:ss local time, as it was shown on the panel. */
    clock: z.string().max(16),
  })
  .strict();
export type UserNote = z.infer<typeof UserNote>;

export const ChatPollPayload = z
  .object({
    /** Return only notes newer than this. 0 asks for everything retained. */
    sinceSeq: z.number().int().min(0).default(0),
  })
  .strict();

export const ChatPollResult = z
  .object({
    notes: z.array(UserNote).max(32),
    /** Highest sequence the plugin has ever issued, retained or not. */
    lastSeq: z.number().int().min(0),
    /**
     * Notes dropped to stay inside the ring. Reported rather than hidden: a
     * client that has been away long enough to miss notes should be able to
     * say so instead of silently answering the wrong question.
     */
    dropped: z.number().int().min(0),
  })
  .strict();
export type ChatPollResult = z.infer<typeof ChatPollResult>;

export const ChatPostPayload = z
  .object({
    /** Shown in the panel as the assistant's reply. */
    text: z.string().min(1).max(2000),
    /**
     * Mark every note up to here as delivered. The panel shows undelivered
     * notes as pending, which is the honest UI for "the assistant has not had
     * a turn yet".
     */
    ackThroughSeq: z.number().int().min(0).default(0),
  })
  .strict();

export const ChatPostResult = z
  .object({
    seq: z.number().int().positive(),
    /** How many pending notes this post marked delivered. */
    acknowledged: z.number().int().min(0),
  })
  .strict();
export type ChatPostResult = z.infer<typeof ChatPostResult>;

export const BRIDGE_METHODS: Record<BridgeMethod, BridgeMethodSpec> = {
  "status.get": { request: EmptyObject, result: StatusResult, mutating: false },
  "lease.acquire": { request: LeaseAcquirePayload, result: LeaseAcquireResult, mutating: false },
  "lease.renew": { request: LeaseRenewPayload, result: LeaseRenewResult, mutating: false },
  "lease.release": { request: LeaseReleasePayload, result: EmptyObject, mutating: false },
  "catalog.listModels": { request: CatalogListPayload, result: CatalogListResult, mutating: false },
  "catalog.inspectModel": { request: InspectModelPayload, result: InspectModelResult, mutating: false },
  "patch.snapshot": { request: SnapshotPayload, result: PatchSnapshot, mutating: false },
  "patch.fingerprint": { request: EmptyObject, result: FingerprintResult, mutating: false },
  "module.inspect": { request: ModuleInspectPayload, result: ModuleInspectResult, mutating: false },
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
  // Neither chat method touches the patch, so neither needs the writer lease:
  // requiring it would mean the user could not leave a note while another
  // client held the lease, which is exactly when they would most want to.
  "chat.poll": { request: ChatPollPayload, result: ChatPollResult, mutating: false },
  "chat.post": { request: ChatPostPayload, result: ChatPostResult, mutating: false },
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
