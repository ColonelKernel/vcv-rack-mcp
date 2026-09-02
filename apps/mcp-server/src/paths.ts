import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { platform } from "node:os";
import type { ServerConfig } from "./config.js";
import { ToolError } from "./errors.js";

/**
 * Patch-path policy (spec section 8): paths are constrained to the configured
 * roots (Rack patches dir, RackMCP checkpoints dir), canonicalized, symlink-
 * resolved, `.vcv`-only, traversal-rejected, never URLs.
 */
export type PatchRoot = "patches" | "checkpoints";

const IS_WINDOWS = platform() === "win32";

/**
 * URL detector. A scheme must be at least two characters: a single letter
 * followed by "://" is a Windows drive path with doubled slashes (C://x), not a URL.
 */
export function isUrl(p: string): boolean {
  return /^[a-z][a-z0-9+.-]+:\/\//i.test(p) || /^file:/i.test(p);
}

/**
 * Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) name a
 * DEVICE in any directory and with any extension, so saving to `nul.vcv` would
 * silently discard the patch. Win32 also strips trailing dots and spaces, so
 * such names never round-trip. Enforced on Windows only.
 */
export function isReservedWindowsName(name: string): boolean {
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name) || /[. ]$/.test(name);
}

/**
 * Canonical form of an existing path: symlinks and junctions resolved, and on
 * Windows the on-disk casing and long (non-8.3) form. The native realpath is
 * required for that: the JS implementation never case-canonicalizes on Windows.
 */
function realCanonical(p: string): string {
  return realpathSync.native(p);
}

/** Real, canonical path of an existing directory (created if missing). */
function canonicalDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return realCanonical(dir);
}

/** Root containment with a separator boundary; case-insensitive on Windows. */
export function within(root: string, target: string, caseInsensitive: boolean = IS_WINDOWS): boolean {
  const norm = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
  const r = norm(root.endsWith(sep) ? root : root + sep);
  const t = norm(target);
  return t === norm(root) || t.startsWith(r);
}

export interface ResolvedPath {
  /** Canonical absolute path (parent resolved via realpath). */
  absolute: string;
  root: PatchRoot;
  exists: boolean;
}

/**
 * Validates and canonicalizes a requested patch path against the roots.
 * `mustExist` controls whether a missing file is an error (load) or allowed
 * (save target). Throws ToolError(PATH_NOT_ALLOWED) on any policy violation.
 */
export function resolvePatchPath(
  config: ServerConfig,
  requested: string,
  opts: { mustExist: boolean },
): ResolvedPath {
  if (!requested || isUrl(requested)) {
    throw new ToolError("PATH_NOT_ALLOWED", "path must be a local filesystem path, not a URL");
  }
  if (requested.includes("\0")) {
    throw new ToolError("PATH_NOT_ALLOWED", "path contains a null byte");
  }
  if (!requested.toLowerCase().endsWith(".vcv")) {
    throw new ToolError("PATH_NOT_ALLOWED", "only .vcv patch files are permitted");
  }
  if (IS_WINDOWS && isReservedWindowsName(basename(requested))) {
    throw new ToolError(
      "PATH_NOT_ALLOWED",
      "file name is a reserved Windows device name or ends with a dot or space",
    );
  }

  const patchesRoot = canonicalDir(config.patchesDir);
  const checkpointsRoot = canonicalDir(config.checkpointsDir);

  const absolute = resolve(requested);
  // Resolve symlinks on the existing portion (the parent must exist).
  let canonical: string;
  const exists = existsSync(absolute);
  if (exists) {
    canonical = realCanonical(absolute);
    if (!statSync(canonical).isFile()) {
      throw new ToolError("PATH_NOT_ALLOWED", "path is not a regular file");
    }
  } else {
    // Canonicalize the parent, then re-attach the basename.
    const parent = resolve(absolute, "..");
    if (!existsSync(parent)) {
      throw new ToolError("PATH_NOT_ALLOWED", "parent directory does not exist");
    }
    canonical = resolve(realCanonical(parent), basename(absolute));
  }

  let root: PatchRoot | null = null;
  if (within(patchesRoot, canonical)) root = "patches";
  else if (within(checkpointsRoot, canonical)) root = "checkpoints";
  if (!root) {
    throw new ToolError(
      "PATH_NOT_ALLOWED",
      "path is outside the configured patch and checkpoint roots",
    );
  }
  if (opts.mustExist && !exists) {
    throw new ToolError("PATH_NOT_ALLOWED", "patch file does not exist");
  }
  return { absolute: canonical, root, exists };
}

/** Timestamped checkpoint path inside the checkpoints root. */
export function checkpointPath(config: ServerConfig, label: string | undefined, stampMs: number): string {
  const stamp = new Date(stampMs).toISOString().replace(/[:.]/g, "-");
  const safeLabel = (label ?? "checkpoint").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const root = canonicalDir(config.checkpointsDir);
  return resolve(root, `${stamp}_${safeLabel}.vcv`);
}
