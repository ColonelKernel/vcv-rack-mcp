import { z } from "zod";
import { DecimalId, GridPosition, HexHash, PatchEpoch, SmallIndex, Slug, Uuid } from "./refs.js";

/**
 * Patch snapshot model (spec section 5).
 *
 * These schemas are the canonical description of the wire payload the Rack
 * plugin emits from `patch.snapshot` and `module.inspect`
 * (plugins/RackMCP/src/rackside/Snapshot.cpp). The MCP server passes that
 * payload through unchanged (get_patch_snapshot, the rack://patch/current
 * resource), apps/mcp-server/src/analysis.ts reads it directly, and the server
 * validates tool output against these schemas. Field names and shapes MUST
 * therefore match `buildOneModule` / `buildPatchSnapshot` exactly — keep this
 * file and Snapshot.cpp in lockstep. The live snapshot-smoke integration test
 * asserts `PatchSnapshot.parse` against real Rack output to catch drift.
 */

export const ParamSnapshot = z
  .object({
    paramId: SmallIndex,
    name: z.string().max(256),
    /** Null for a non-finite live value, which JSON cannot represent. */
    value: z.number().nullable(),
    /**
     * Range/display are null when the module exposes the param without a
     * ParamQuantity, or when the bound is non-finite (Rack allows unbounded
     * params); Snapshot.cpp emits null rather than dropping the key.
     */
    minValue: z.number().nullable(),
    maxValue: z.number().nullable(),
    defaultValue: z.number().nullable(),
    normalizedValue: z.number().nullable(),
    displayValue: z.string().max(256).nullable(),
    unit: z.string().max(64),
    /** Whether the parameter snaps to integer positions (switches/selectors). */
    snapped: z.boolean(),
  })
  .strict();
export type ParamSnapshot = z.infer<typeof ParamSnapshot>;

export const PortSnapshot = z
  .object({
    portId: SmallIndex,
    type: z.enum(["input", "output"]),
    name: z.string().max(256),
    /** Live channel count (0 when unpatched; Rack polyphony caps at 16). */
    channels: z.number().int().min(0).max(16),
    connected: z.boolean(),
  })
  .strict();
export type PortSnapshot = z.infer<typeof PortSnapshot>;

export const ModuleSnapshot = z
  .object({
    moduleId: DecimalId,
    pluginSlug: Slug,
    pluginVersion: z.string().max(64),
    modelSlug: Slug,
    modelName: z.string().max(256),
    bypassed: z.boolean(),
    isBridge: z.boolean(),
    isProbe: z.boolean(),
    /** Grid column (x) / row (y); null when the module has no widget. */
    gridPosition: GridPosition.nullable(),
    /** Width in HP; null when the module has no widget. */
    gridWidth: z.number().int().min(0).max(1024).nullable(),
    params: z.array(ParamSnapshot).max(4096),
    inputs: z.array(PortSnapshot).max(1024),
    outputs: z.array(PortSnapshot).max(1024),
    /** Immediate expander neighbor module ids (null when none). */
    expanders: z
      .object({ left: DecimalId.nullable(), right: DecimalId.nullable() })
      .strict(),
    /**
     * Opaque module `data` (dataToJson) and its disclosure flag, present only
     * when explicitly requested with includeOpaqueState and within the size
     * limit. Untrusted content.
     */
    opaqueState: z.unknown().optional(),
    opaqueStateDisclosed: z.boolean().optional(),
  })
  .strict();
export type ModuleSnapshot = z.infer<typeof ModuleSnapshot>;

/**
 * Cable color exactly as Rack's `color::toHexString` emits it: `#rrggbb`, or
 * `#rrggbbaa` when the color carries a non-opaque alpha, or "" when the cable
 * has no widget. Broader than the strict `CableColor` used for operation input.
 */
export const SnapshotCableColor = z.union([
  z.literal(""),
  z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/, "hex color"),
]);
export type SnapshotCableColor = z.infer<typeof SnapshotCableColor>;

export const CableSnapshot = z
  .object({
    cableId: DecimalId,
    outputModuleId: DecimalId,
    outputId: SmallIndex,
    inputModuleId: DecimalId,
    inputId: SmallIndex,
    color: SnapshotCableColor,
  })
  .strict();
export type CableSnapshot = z.infer<typeof CableSnapshot>;

export const PatchSnapshot = z
  .object({
    rackVersion: z.string().max(64),
    rackEdition: z.enum(["Free", "Pro", "unknown"]),
    instanceId: Uuid,
    sessionId: Uuid,
    patchEpoch: PatchEpoch,
    /** Current patch name; null when the patch is untitled. */
    patchName: z.string().max(512).nullable(),
    saved: z.boolean(),
    /** Engine sample rate in Hz; 0 when no engine is running. */
    sampleRate: z.number().nonnegative(),
    modules: z.array(ModuleSnapshot).max(4096),
    cables: z.array(CableSnapshot).max(16384),
    /** Count of RackMCP-Bridge / RackMCP-Probe modules present in the patch. */
    bridgeModuleCount: z.number().int().min(0),
    probeModuleCount: z.number().int().min(0),
    fingerprint: HexHash,
    warnings: z.array(z.string().max(512)),
  })
  .strict();
export type PatchSnapshot = z.infer<typeof PatchSnapshot>;
