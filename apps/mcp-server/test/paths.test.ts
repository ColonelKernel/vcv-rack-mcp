import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { platform, tmpdir } from "node:os";
import type { ServerConfig } from "../src/config.js";
import { ToolError } from "../src/errors.js";
import { isReservedWindowsName, isUrl, resolvePatchPath, within } from "../src/paths.js";

describe("path policy helpers", () => {
  it("rejects URLs but not Windows drive paths with doubled slashes", () => {
    expect(isUrl("https://example.com/a.vcv")).toBe(true);
    expect(isUrl("file:///tmp/a.vcv")).toBe(true);
    expect(isUrl("FILE:///tmp/a.vcv")).toBe(true);
    expect(isUrl("smb://host/share/a.vcv")).toBe(true);
    expect(isUrl("C://Users/x/a.vcv")).toBe(false);
    expect(isUrl("C:\\Users\\x\\a.vcv")).toBe(false);
    expect(isUrl("/tmp/a.vcv")).toBe(false);
  });

  it("flags reserved Windows device names regardless of extension or case", () => {
    for (const n of ["nul.vcv", "NUL", "con.vcv", "Com1.vcv", "lpt9.vcv", "aux", "prn.VCV"]) {
      expect(isReservedWindowsName(n), n).toBe(true);
    }
    for (const n of ["null.vcv", "console.vcv", "com0.vcv", "com10.vcv", "lpt.vcv", "patch.vcv"]) {
      expect(isReservedWindowsName(n), n).toBe(false);
    }
    expect(isReservedWindowsName("trailing.vcv.")).toBe(true);
    expect(isReservedWindowsName("trailing ")).toBe(true);
  });

  it("containment needs a separator boundary and honours case sensitivity", () => {
    const root = ["", "r", "patches"].join(sep);
    const under = [root, "a.vcv"].join(sep);
    expect(within(root, root, false)).toBe(true);
    expect(within(root, under, false)).toBe(true);
    expect(within(root, root + "-evil" + sep + "a.vcv", false)).toBe(false);
    expect(within(root, under.toUpperCase(), false)).toBe(false);
    expect(within(root, under.toUpperCase(), true)).toBe(true);
  });
});

/** Minimal config: only the two roots matter to `resolvePatchPath`. */
function configFor(root: string): ServerConfig {
  return {
    rackUserDir: root,
    rackmcpDir: join(root, "RackMCP"),
    discoveryDir: join(root, "RackMCP", "instances"),
    checkpointsDir: join(root, "RackMCP", "checkpoints"),
    patchesDir: join(root, "patches"),
    auditDir: join(root, "RackMCP", "audit"),
    requestDeadlineMs: 5000,
  };
}

/** Unprivileged symlink creation fails on Windows; skip those cases there. */
const symlinks = platform() === "win32" ? describe.skip : describe;

describe("resolvePatchPath containment", () => {
  let dir: string;
  let cfg: ServerConfig;
  let patches: string;

  beforeEach(() => {
    // realpath the temp dir: on macOS /var is itself a symlink to /private/var.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "rackmcp-paths-")));
    cfg = configFor(join(dir, "rack"));
    mkdirSync(cfg.patchesDir, { recursive: true });
    patches = cfg.patchesDir;
    mkdirSync(join(dir, "outside"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a new file inside the patches root", () => {
    const r = resolvePatchPath(cfg, join(patches, "new.vcv"), { mustExist: false });
    expect(r.root).toBe("patches");
    expect(r.exists).toBe(false);
    expect(r.absolute).toBe(join(patches, "new.vcv"));
  });

  it("rejects a path outside both roots", () => {
    expect(() =>
      resolvePatchPath(cfg, join(dir, "outside", "a.vcv"), { mustExist: false }),
    ).toThrow(/outside the configured/);
  });

  symlinks("with symlinks", () => {
    it("rejects a dangling link inside the root whose target is outside it", () => {
      const link = join(patches, "live.vcv");
      symlinkSync(join(dir, "outside", "gone.vcv"), link);
      expect(existsSync(link)).toBe(false); // dangling: the old existsSync gate said "new file"
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(() => resolvePatchPath(cfg, link, { mustExist: false })).toThrow(
        /outside the configured/,
      );
    });

    it("rejects a dangling link out of the root reached through a relative target", () => {
      const link = join(patches, "rel.vcv");
      symlinkSync(join("..", "..", "outside", "gone.vcv"), link);
      expect(() => resolvePatchPath(cfg, link, { mustExist: false })).toThrow(
        /outside the configured/,
      );
    });

    it("rejects a link inside the root pointing at an existing file outside it", () => {
      const outside = join(dir, "outside", "there.vcv");
      writeFileSync(outside, "x");
      const link = join(patches, "there.vcv");
      symlinkSync(outside, link);
      for (const mustExist of [false, true]) {
        expect(() => resolvePatchPath(cfg, link, { mustExist })).toThrow(/outside the configured/);
      }
    });

    it("accepts a link inside the root pointing at an existing file inside it", () => {
      const real = join(patches, "real.vcv");
      writeFileSync(real, "x");
      const link = join(patches, "alias.vcv");
      symlinkSync(real, link);
      const r = resolvePatchPath(cfg, link, { mustExist: true });
      expect(r.root).toBe("patches");
      expect(r.exists).toBe(true);
      expect(r.absolute).toBe(real);
    });

    it("accepts a dangling link inside the root whose target is also inside it", () => {
      const link = join(patches, "pending.vcv");
      symlinkSync(join(patches, "target.vcv"), link);
      const r = resolvePatchPath(cfg, link, { mustExist: false });
      expect(r.root).toBe("patches");
      expect(r.exists).toBe(false);
      expect(r.absolute).toBe(join(patches, "target.vcv"));
      // ...but load-style callers still get "does not exist", not a silent pass.
      expect(() => resolvePatchPath(cfg, link, { mustExist: true })).toThrow(/does not exist/);
    });

    it("follows a chain of dangling links and judges the final target", () => {
      symlinkSync(join(dir, "outside", "gone.vcv"), join(patches, "b.vcv"));
      symlinkSync(join(patches, "b.vcv"), join(patches, "a.vcv"));
      expect(() => resolvePatchPath(cfg, join(patches, "a.vcv"), { mustExist: false })).toThrow(
        /outside the configured/,
      );
    });

    it("refuses a link loop rather than treating it as a new file", () => {
      symlinkSync(join(patches, "y.vcv"), join(patches, "x.vcv"));
      symlinkSync(join(patches, "x.vcv"), join(patches, "y.vcv"));
      expect(() => resolvePatchPath(cfg, join(patches, "x.vcv"), { mustExist: false })).toThrow(
        ToolError,
      );
    });

    it("resolves a symlinked checkpoints root to the checkpoints root", () => {
      // A root that is itself a link must still classify files under it.
      const realCheckpoints = join(dir, "real-checkpoints");
      mkdirSync(realCheckpoints, { recursive: true });
      mkdirSync(join(dir, "rack", "RackMCP"), { recursive: true });
      const linked = { ...cfg, checkpointsDir: join(dir, "rack", "RackMCP", "checkpoints") };
      symlinkSync(realCheckpoints, linked.checkpointsDir);
      const r = resolvePatchPath(linked, join(linked.checkpointsDir, "c.vcv"), {
        mustExist: false,
      });
      expect(r.root).toBe("checkpoints");
      expect(r.absolute).toBe(join(realCheckpoints, "c.vcv"));
    });
  });

  it("rejects a missing parent directory inside the root", () => {
    expect(() =>
      resolvePatchPath(cfg, join(patches, "nope", "a.vcv"), { mustExist: false }),
    ).toThrow(/parent directory does not exist/);
  });

  it("rejects a directory that exists at the target path", () => {
    mkdirSync(join(patches, "dir.vcv"), { recursive: true });
    expect(() => resolvePatchPath(cfg, join(patches, "dir.vcv"), { mustExist: false })).toThrow(
      /not a regular file/,
    );
  });
});
