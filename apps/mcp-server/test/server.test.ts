import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { platform } from "node:os";
import { TOOLS } from "@rackmcp/schemas";
import { buildToolTable } from "../src/tools.js";
import { toErrorPayload, ToolError } from "../src/errors.js";
import { loadConfig, defaultRackUserDir } from "../src/config.js";

describe("tool table", () => {
  it("registers a handler for every spec tool", () => {
    const table = buildToolTable();
    expect(table.length).toBe(TOOLS.length);
    expect(new Set(table.map((t) => t.spec.name)).size).toBe(TOOLS.length);
  });

  it("exposes an input shape usable by the MCP SDK", () => {
    for (const t of buildToolTable()) {
      expect(t.inputShape).toBeDefined();
      expect(typeof t.inputShape).toBe("object");
    }
  });
});

describe("error normalization", () => {
  it("preserves ToolError code and retry semantics", () => {
    const p = toErrorPayload(new ToolError("STALE_PATCH_EPOCH", "stale", true, false));
    expect(p.code).toBe("STALE_PATCH_EPOCH");
    expect(p.retrySafe).toBe(true);
    expect(p.mutationMayHaveOccurred).toBe(false);
  });

  it("maps unknown throwables to INTERNAL", () => {
    expect(toErrorPayload(new Error("boom")).code).toBe("INTERNAL");
    expect(toErrorPayload("just a string").code).toBe("INTERNAL");
  });

  it("includes details only when present", () => {
    expect(toErrorPayload(new ToolError("RACK_NOT_FOUND", "x")).details).toBeUndefined();
    expect(
      toErrorPayload(new ToolError("INSTANCE_NOT_SELECTED", "x", false, false, { a: 1 })).details,
    ).toEqual({ a: 1 });
  });
});

describe("config", () => {
  it("derives all roots under the Rack user dir", () => {
    const cfg = loadConfig({ RACKMCP_RACK_USER_DIR: "/tmp/rack" } as NodeJS.ProcessEnv);
    expect(cfg.rackUserDir).toBe("/tmp/rack");
    // Derived roots are joined with the platform separator (backslashes on Windows).
    expect(cfg.discoveryDir).toBe(join("/tmp/rack", "RackMCP", "instances"));
    expect(cfg.checkpointsDir).toBe(join("/tmp/rack", "RackMCP", "checkpoints"));
    expect(cfg.patchesDir).toBe(join("/tmp/rack", "patches"));
  });

  it("has a platform default", () => {
    expect(defaultRackUserDir().length).toBeGreaterThan(0);
  });

  it("honours Rack's own RACK_USER_DIR, below RACKMCP_RACK_USER_DIR", () => {
    expect(loadConfig({ RACK_USER_DIR: "/r1" } as NodeJS.ProcessEnv).rackUserDir).toBe("/r1");
    expect(
      loadConfig({ RACK_USER_DIR: "/r1", RACKMCP_RACK_USER_DIR: "/r2" } as NodeJS.ProcessEnv).rackUserDir,
    ).toBe("/r2");
  });

  it("uses $XDG_DATA_HOME/Rack2 on Linux-like platforms (Rack 2.5+)", () => {
    if (platform() === "darwin" || platform() === "win32") return;
    expect(defaultRackUserDir({ XDG_DATA_HOME: "/xdg" } as NodeJS.ProcessEnv)).toBe(join("/xdg", "Rack2"));
    expect(defaultRackUserDir({} as NodeJS.ProcessEnv).endsWith(join(".local", "share", "Rack2"))).toBe(true);
  });
});
