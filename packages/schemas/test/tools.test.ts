import { describe, expect, it } from "vitest";
import { TOOLS, TOOL_NAMES, getTool } from "../src/tools.js";

const SPEC_TOOLS = [
  // Connection and discovery
  "list_rack_instances",
  "select_rack_instance",
  "get_rack_status",
  "acquire_writer_lease",
  "release_writer_lease",
  // Catalog and inspection
  "list_installed_models",
  "inspect_model",
  "get_patch_snapshot",
  "inspect_module",
  "inspect_parameter",
  "describe_patch",
  "validate_patch",
  // Mutation
  "preview_patch_transaction",
  "commit_patch_transaction",
  "undo_last_mcp_transaction",
  "build_patch",
  // Patch files and recovery
  "list_patch_files",
  "create_checkpoint",
  "save_patch",
  "preview_load_patch",
  "commit_load_patch",
  "preview_clear_patch",
  "commit_clear_patch",
  "restore_checkpoint",
  // Telemetry
  "list_probes",
  "preview_attach_probe",
  "commit_attach_probe",
  "read_probe",
  "detach_probe",
];

describe("tool registry", () => {
  it("contains exactly the spec-required tools", () => {
    expect([...TOOL_NAMES].sort()).toEqual([...SPEC_TOOLS].sort());
  });

  it("has unique names, titles and descriptions", () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOLS.length);
    for (const t of TOOLS) {
      expect(t.title.length).toBeGreaterThan(3);
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it("read-only tools are never destructive", () => {
    for (const t of TOOLS) {
      if (t.annotations.readOnlyHint) {
        expect(t.annotations.destructiveHint).toBe(false);
      }
      expect(t.annotations.openWorldHint).toBe(false);
    }
  });

  it("previews and inspections are read-only; commits are not", () => {
    for (const name of [
      "preview_patch_transaction",
      "preview_load_patch",
      "preview_clear_patch",
      "preview_attach_probe",
      "get_patch_snapshot",
      "validate_patch",
    ]) {
      expect(getTool(name)?.annotations.readOnlyHint, name).toBe(true);
    }
    for (const name of [
      "commit_patch_transaction",
      "commit_load_patch",
      "commit_clear_patch",
      "commit_attach_probe",
      "undo_last_mcp_transaction",
      "save_patch",
    ]) {
      expect(getTool(name)?.annotations.readOnlyHint, name).toBe(false);
    }
  });

  it("every tool input rejects unknown keys", () => {
    for (const t of TOOLS) {
      const probe = { __definitely_not_a_field__: 1 };
      const res = t.input.safeParse(probe);
      expect(res.success, `${t.name} should reject unknown keys`).toBe(false);
    }
  });

  it("there is no generic set_module_data tool", () => {
    expect(getTool("set_module_data")).toBeUndefined();
  });
});
