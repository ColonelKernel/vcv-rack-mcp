/**
 * Minimal valid inputs for every MCP tool. Used by contract tests (a valid
 * sample must parse; the sample plus one unknown key must fail) and doubles
 * as the examples source for tool documentation.
 */
const UUID = "6c5c48b2-3b0f-4f2a-9df9-1f4a30f10a10";
const HASH = "a".repeat(64);
const TOKEN = "t".repeat(32);

export const ADD_MODULE_SAMPLE = {
  op: "add_module",
  pluginSlug: "Fundamental",
  modelSlug: "VCO",
  alias: "osc1",
};

export const VALID_TOOL_INPUTS: Record<string, object> = {
  list_rack_instances: {},
  select_rack_instance: { instanceId: UUID },
  get_rack_status: {},
  acquire_writer_lease: {},
  release_writer_lease: {},
  list_installed_models: { limit: 50 },
  inspect_model: { pluginSlug: "Fundamental", modelSlug: "VCO" },
  get_patch_snapshot: {},
  inspect_module: { moduleId: "12" },
  inspect_parameter: { moduleId: "12", paramId: 0 },
  describe_patch: {},
  validate_patch: {},
  preview_patch_transaction: { label: "Add oscillator", operations: [ADD_MODULE_SAMPLE] },
  commit_patch_transaction: { operationId: UUID, planHash: HASH, expectedFingerprint: HASH },
  undo_last_mcp_transaction: { operationId: UUID },
  build_patch: { label: "Add oscillator", operations: [ADD_MODULE_SAMPLE], operationId: UUID },
  list_patch_files: {},
  create_checkpoint: { operationId: UUID },
  save_patch: { operationId: UUID },
  preview_load_patch: { path: "/patches/demo.vcv" },
  commit_load_patch: { confirmationToken: TOKEN, operationId: UUID },
  preview_clear_patch: {},
  commit_clear_patch: { confirmationToken: TOKEN, operationId: UUID },
  restore_checkpoint: { checkpointPath: "/checkpoints/demo.vcv", operationId: UUID },
  list_probes: {},
  preview_attach_probe: {
    source: { module: { moduleId: "3" }, portType: "output", portId: 0 },
  },
  commit_attach_probe: { operationId: UUID, planHash: HASH, expectedFingerprint: HASH },
  read_probe: { probeModuleId: "5", probeInputId: 0 },
  read_user_notes: { sinceSeq: 0 },
  post_chat_message: { text: "Cutoff 8.0 -> 4.2 kHz. Undo with undo_last_mcp_transaction.", ackThroughSeq: 3 },
  detach_probe: { probeModuleId: "5", probeInputId: 0, operationId: UUID, expectedPatchEpoch: 1 },
};
