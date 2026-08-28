import { z } from "zod";
import { CableColor, DecimalId, GridPosition, HexHash, PatchEpoch, SmallIndex, Slug, Uuid } from "./refs.js";

/** Patch snapshot model (spec section 5). */

export const ParamSnapshot = z
  .object({
    paramId: SmallIndex,
    name: z.string().max(256),
    unit: z.string().max(64),
    value: z.number(),
    minValue: z.number(),
    maxValue: z.number(),
    defaultValue: z.number(),
    displayValue: z.string().max(256),
    /** Discrete switch labels when the parameter is a switch. */
    labels: z.array(z.string().max(128)).max(64).optional(),
    warnings: z.array(z.string().max(512)).optional(),
  })
  .strict();
export type ParamSnapshot = z.infer<typeof ParamSnapshot>;

export const PortSnapshot = z
  .object({
    portId: SmallIndex,
    name: z.string().max(256),
    description: z.string().max(1024).optional(),
    connectedCableIds: z.array(DecimalId).max(1024),
  })
  .strict();
export type PortSnapshot = z.infer<typeof PortSnapshot>;

export const ModuleSnapshot = z
  .object({
    moduleId: DecimalId,
    pluginSlug: Slug,
    modelSlug: Slug,
    pluginVersion: z.string().max(64),
    name: z.string().max(256),
    position: GridPosition,
    /** Width in HP. */
    sizeHp: z.number().int().min(0).max(1024),
    bypassed: z.boolean(),
    params: z.array(ParamSnapshot).max(4096),
    inputs: z.array(PortSnapshot).max(1024),
    outputs: z.array(PortSnapshot).max(1024),
    leftExpanderModuleId: DecimalId.nullable(),
    rightExpanderModuleId: DecimalId.nullable(),
    isBridge: z.boolean(),
    isProbe: z.boolean(),
    /**
     * Opaque module `data` (dataToJson), present only when explicitly requested
     * with includeOpaqueState and within the size limit. Untrusted content.
     */
    opaqueState: z.unknown().optional(),
    warnings: z.array(z.string().max(512)),
  })
  .strict();
export type ModuleSnapshot = z.infer<typeof ModuleSnapshot>;

export const CableSnapshot = z
  .object({
    cableId: DecimalId,
    outputModuleId: DecimalId,
    outputPortId: SmallIndex,
    inputModuleId: DecimalId,
    inputPortId: SmallIndex,
    color: CableColor,
  })
  .strict();
export type CableSnapshot = z.infer<typeof CableSnapshot>;

export const PatchSnapshot = z
  .object({
    rackVersion: z.string().max(64),
    rackEdition: z.enum(["Free", "Pro", "unknown"]),
    bridgeVersion: z.string().max(64),
    instanceId: Uuid,
    sessionId: Uuid,
    patchEpoch: PatchEpoch,
    /** Null when no path or when disclosure is not permitted. */
    patchPath: z.string().max(4096).nullable(),
    pathDisclosed: z.boolean(),
    saved: z.boolean(),
    fingerprint: HexHash,
    modules: z.array(ModuleSnapshot).max(4096),
    cables: z.array(CableSnapshot).max(16384),
    bridgePresent: z.boolean(),
    probeModuleIds: z.array(DecimalId).max(64),
    includesOpaqueState: z.boolean(),
    warnings: z.array(z.string().max(512)),
  })
  .strict();
export type PatchSnapshot = z.infer<typeof PatchSnapshot>;
