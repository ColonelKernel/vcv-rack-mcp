import { z } from "zod";

/** Rack 64-bit IDs cross the TypeScript boundary as decimal strings. */
export const DecimalId = z.string().regex(/^(0|[1-9][0-9]{0,18})$/, "decimal id string");
export type DecimalId = z.infer<typeof DecimalId>;

export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;

export const HexHash = z.string().regex(/^[0-9a-f]{64}$/, "lowercase sha-256 hex");
export type HexHash = z.infer<typeof HexHash>;

/** Slugs are untrusted plugin metadata; constrain length and charset loosely. */
export const Slug = z.string().min(1).max(255);

/** Non-negative small integer (port ids, param ids...). */
export const SmallIndex = z.number().int().min(0).max(65535);

/** A patch epoch. Incremented after load, clear, restore or full replacement. */
export const PatchEpoch = z.number().int().min(1);

/** Scope that every live entity reference must carry (spec section 5). */
export const Scope = z
  .object({
    instanceId: Uuid,
    sessionId: Uuid,
    patchEpoch: PatchEpoch,
  })
  .strict();
export type Scope = z.infer<typeof Scope>;

/**
 * A module reference: either a live module id, or a transaction-local alias
 * naming a module created by an earlier `add_module`/`duplicate_module`
 * operation in the same transaction.
 */
export const ModuleRef = z.union([
  z.object({ moduleId: DecimalId }).strict(),
  z.object({ alias: z.string().min(1).max(64) }).strict(),
]);
export type ModuleRef = z.infer<typeof ModuleRef>;

export const CableRef = z.object({ cableId: DecimalId }).strict();
export type CableRef = z.infer<typeof CableRef>;

export const PortType = z.enum(["input", "output"]);
export type PortType = z.infer<typeof PortType>;

export const PortRef = z
  .object({
    module: ModuleRef,
    portType: PortType,
    portId: SmallIndex,
  })
  .strict();
export type PortRef = z.infer<typeof PortRef>;

/** Grid position in HP columns (x) and row index (y), matching Rack's rack grid. */
export const GridPosition = z
  .object({ x: z.number().int().min(-4096).max(4096), y: z.number().int().min(-256).max(256) })
  .strict();
export type GridPosition = z.infer<typeof GridPosition>;

/** Cable colors as #rrggbb; Rack default palette used when omitted. */
export const CableColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
