import { describe, expect, it, vi } from "vitest";
import { Checks } from "../src/checks.js";
import { structured, succeeded, toolError } from "../src/results.js";

describe("structured", () => {
  it("returns the payload when there is one", () => {
    expect(structured({ structuredContent: { ok: 1 } }, "save_patch")).toEqual({ ok: 1 });
  });

  it("names the tool in the failure, which is the whole reason it exists", () => {
    // The old `sc()` cast let a missing payload flow on and blow up several
    // lines later at the assertion, pointing at the wrong thing.
    expect(() => structured({ isError: true }, "commit_clear_patch")).toThrow(
      /commit_clear_patch/,
    );
  });

  it("treats null as absent rather than as an empty object", () => {
    // typeof null === "object", so a naive check would return null here and
    // the caller's first property read would throw instead.
    expect(() => structured({ structuredContent: null }, "t")).toThrow(/no structuredContent/);
  });

  it("still names the tool when the result cannot be stringified", () => {
    // JSON.stringify THROWS on a cycle, so the diagnostic used to die while
    // producing itself and the caller saw "Converting circular structure to
    // JSON" with no mention of which tool failed.
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => structured({ content: cyclic }, "list_patch_files")).toThrow(
      /list_patch_files returned no structuredContent/,
    );
  });
});

describe("toolError", () => {
  it("reports a domain error carried in structuredContent", () => {
    expect(toolError({ structuredContent: { error: { code: "PATH_NOT_ALLOWED", message: "no" } } }))
      .toEqual({ code: "PATH_NOT_ALLOWED", message: "no" });
  });

  it("reports a transport error that carries no error payload", () => {
    // The smokes disagreed about this: some checked `isError`, some reached
    // straight for `.error.code`. A result flagged isError with no payload was
    // read as success by half of them.
    expect(toolError({ isError: true, structuredContent: {} })).toEqual({ code: "", message: "" });
  });

  it("is null for a plain success", () => {
    expect(toolError({ structuredContent: { saved: true } })).toBeNull();
    expect(succeeded({ structuredContent: { saved: true } })).toBe(true);
  });

  it("does not mistake a field literally named error-ish for an error", () => {
    // `describe_patch` returns findings, not errors; only the `error` key counts.
    expect(toolError({ structuredContent: { errors: [], errorCount: 0 } })).toBeNull();
  });

  it("tolerates an error object with a non-string code", () => {
    expect(toolError({ structuredContent: { error: { code: 42 } } })).toEqual({
      code: "",
      message: "",
    });
  });
});

describe("Checks", () => {
  it("counts and reports both ways", () => {
    const lines: string[] = [];
    const c = new Checks("T", (l) => lines.push(l));
    expect(c.ok("a", true)).toBe(true);
    expect(c.ok("b", false, "detail")).toBe(false);
    c.fail("threw", "boom");
    expect(c.passes).toBe(1);
    expect(c.failures).toBe(2);
    expect(lines[0]).toBe("ok   a");
    expect(lines[1]).toContain("FAIL b");
    expect(lines[2]).toContain("FAIL threw");
  });

  it("sets the exit code rather than exiting, so cleanup can still run", () => {
    // A smoke that called process.exit() here would leave Rack running,
    // because harness.quit() is awaited after the summary.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const before = process.exitCode;
    try {
      const lines: string[] = [];
      new Checks("T", (l) => lines.push(l)).finish();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
      expect(lines[0]).toBe("T: PASSED (0)");

      const failing = new Checks("U", (l) => lines.push(l));
      failing.ok("x", false);
      expect(failing.finish()).toBe(1);
      expect(process.exitCode).toBe(1);
      expect(lines[2]).toBe("U: FAILED (1 of 1)");
    } finally {
      process.exitCode = before;
      exitSpy.mockRestore();
    }
  });
});

describe("defaultServerEntry", () => {
  it("returns a real filesystem path, not a percent-encoded URL pathname", async () => {
    // This repository's own checkout is "/Users/.../VCV Rack MCP". URL.pathname
    // would return "VCV%20Rack%20MCP" -- a string that reads correctly in an
    // error message and does not exist on disk.
    const { defaultServerEntry } = await import("../src/client.js");
    const entry = defaultServerEntry();
    expect(entry).not.toContain("%20");
    expect(entry).not.toContain("%");
    // Compared separator-agnostically: fileURLToPath returns backslashes on
    // Windows, so asserting an endsWith on a "/" path reds in the win-latest
    // TypeScript job only -- which is exactly how this test first failed.
    expect(entry.split(/[\\/]/).slice(-4).join("/")).toBe("apps/mcp-server/dist/index.js");
  });
});
