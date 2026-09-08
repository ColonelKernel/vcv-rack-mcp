import { z } from "zod";
import { CableColor, CableRef, GridPosition, ModuleRef, PortRef, SmallIndex, Slug } from "./refs.js";

/**
 * The PatchOperation discriminated union (spec section 7).
 * There is deliberately no generic `set_module_data` operation: opaque module
 * state is never mutated without a matching adapter, and adapters express
 * their needs through these typed operations only.
 */

/** Exactly one of raw `value`, `normalized` [0..1], or a supported `display` string. */
const paramTarget = {
  value: z.number().finite().optional(),
  normalized: z.number().min(0).max(1).optional(),
  display: z.string().max(256).optional(),
};

function exactlyOneTarget(v: {
  value?: number | undefined;
  normalized?: number | undefined;
  display?: string | undefined;
}): boolean {
  return [v.value, v.normalized, v.display].filter((x) => x !== undefined).length === 1;
}

export const InitialParamValue = z
  .object({ paramId: SmallIndex, ...paramTarget })
  .strict()
  .refine(exactlyOneTarget, { message: "exactly one of value, normalized, display" });

export const PlacementPolicy = z.enum(["auto", "at"]);

export const AddModuleOp = z
  .object({
    op: z.literal("add_module"),
    pluginSlug: Slug,
    modelSlug: Slug,
    /** Transaction-local alias later operations can use to reference this module. */
    alias: z.string().min(1).max(64),
    placement: PlacementPolicy.default("auto"),
    /** Required when placement is "at". */
    position: GridPosition.optional(),
    initialParams: z.array(InitialParamValue).max(256).optional(),
    bypassed: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.placement !== "at" || v.position !== undefined, {
    message: "position required when placement is 'at'",
  });

export const CableRemovalPolicy = z.enum(["remove_attached", "fail_if_connected"]);

export const RemoveModuleOp = z
  .object({
    op: z.literal("remove_module"),
    module: ModuleRef,
    cablePolicy: CableRemovalPolicy,
    /** Removal of the last RackMCP-Bridge module is refused unless explicitly allowed. */
    allowLastBridge: z.boolean().default(false),
  })
  .strict();

export const CollisionPolicy = z.enum(["fail", "nearest", "force", "squeeze"]);

export const MoveModuleOp = z
  .object({
    op: z.literal("move_module"),
    module: ModuleRef,
    position: GridPosition,
    collision: CollisionPolicy,
  })
  .strict();

export const DuplicateModuleOp = z
  .object({
    op: z.literal("duplicate_module"),
    module: ModuleRef,
    /** Alias for the newly created copy. */
    alias: z.string().min(1).max(64),
    copyCables: z.boolean(),
    placement: PlacementPolicy.default("auto"),
    position: GridPosition.optional(),
  })
  .strict()
  .refine((v) => v.placement !== "at" || v.position !== undefined, {
    message: "position required when placement is 'at'",
  });

export const SetParameterOp = z
  .object({
    op: z.literal("set_parameter"),
    module: ModuleRef,
    paramId: SmallIndex,
    ...paramTarget,
    /** Optional non-audio-rate smoothing duration; ramped by the UI pump. */
    smoothMs: z.number().min(0).max(10_000).optional(),
  })
  .strict()
  .refine(exactlyOneTarget, { message: "exactly one of value, normalized, display" });

export const SetBypassOp = z
  .object({
    op: z.literal("set_bypass"),
    module: ModuleRef,
    bypassed: z.boolean(),
  })
  .strict();

export const InputPolicy = z.enum(["fail_if_connected", "stack", "replace_all"]);

export const ConnectOp = z
  .object({
    op: z.literal("connect"),
    output: PortRef,
    input: PortRef,
    color: CableColor.optional(),
    inputPolicy: InputPolicy,
  })
  .strict();

export const DisconnectOp = z
  .object({
    op: z.literal("disconnect"),
    cable: CableRef,
  })
  .strict();

/**
 * Which cables `disconnect_port` removes.
 *
 * `"all"` is the one with a stable meaning. `"top"` removes a single cable, and
 * the description says which one because the wire should not imply a choice the
 * engine does not offer: Rack keeps its cable vector sorted on (destination
 * module pointer, destination port), so among several cables leaving one output
 * port, "top" is decided by a heap address. Deterministic in a session, not
 * across restarts, and not the visually topmost cable.
 */
export const DisconnectPortPolicy = z
  .enum(["top", "all"])
  .describe(
    'Which cables to remove from the port. "all" removes every cable on it. ' +
      '"top" removes exactly one: the last in Rack\'s internal cable order, which is ' +
      "sorted by destination module and port rather than by when the cables were made, " +
      "so on an output port with several cables it is not the newest or the visually " +
      'topmost one. To remove a specific cable, use the "disconnect" operation with its id.',
  );

export const DisconnectPortOp = z
  .object({
    op: z.literal("disconnect_port"),
    port: PortRef,
    policy: DisconnectPortPolicy,
  })
  .strict();

export const ResetModuleOp = z
  .object({
    op: z.literal("reset_module"),
    module: ModuleRef,
  })
  .strict();

/** Always classified as requiring confirmation. */
export const RandomizeModuleOp = z
  .object({
    op: z.literal("randomize_module"),
    module: ModuleRef,
  })
  .strict();

export const PatchOperation = z.discriminatedUnion("op", [
  AddModuleOp,
  RemoveModuleOp,
  MoveModuleOp,
  DuplicateModuleOp,
  SetParameterOp,
  SetBypassOp,
  ConnectOp,
  DisconnectOp,
  DisconnectPortOp,
  ResetModuleOp,
  RandomizeModuleOp,
]);
export type PatchOperation = z.infer<typeof PatchOperation>;

export const OPERATION_TYPES = [
  "add_module",
  "remove_module",
  "move_module",
  "duplicate_module",
  "set_parameter",
  "set_bypass",
  "connect",
  "disconnect",
  "disconnect_port",
  "reset_module",
  "randomize_module",
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

/** Risk classification determined at preview time. */
export const RiskLevel = z.enum(["low", "destructive", "high"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const RiskFlag = z.enum([
  "removes_bridge",
  "affects_audio_path",
  "randomize",
  "removes_modules",
  "removes_cables",
  "replaces_cables",
  "stacks_inputs",
  "possible_feedback",
  "adapter_uncertainty",
  "missing_modules",
  "large_transaction",
  /** Whole-patch operations: everything currently loaded goes away. */
  "clears_patch",
  "replaces_patch",
]);
export type RiskFlag = z.infer<typeof RiskFlag>;
