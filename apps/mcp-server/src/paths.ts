import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
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

/** Symlink hops tolerated while canonicalizing a path that does not exist yet. */
const MAX_LINK_HOPS = 32;

/**
 * Canonical form of a path that need not exist: the deepest EXISTING ancestor is
 * resolved with realpath and the missing remainder re-attached. A dangling
 * symlink is still followed via `readlink` — `realpathSync` fails on it, and
 * judging it by its own (contained) name would let a link pointing out of the
 * roots smuggle a write out. Anything that cannot be resolved at all (symlink
 * loop, non-directory component, unreadable ancestor) is refused: containment
 * cannot be decided for it.
 */
function canonicalAllowingMissing(p: string, hops: number): string {
  try {
    return realCanonical(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ToolError("PATH_NOT_ALLOWED", "path could not be resolved");
    }
  }
  const parent = resolve(p, "..");
  if (parent === p) {
    throw new ToolError("PATH_NOT_ALLOWED", "path could not be resolved");
  }
  const canonicalParent = canonicalAllowingMissing(parent, hops);
  const child = resolve(canonicalParent, basename(p));
  let target: string | null = null;
  try {
    if (lstatSync(child).isSymbolicLink()) target = readlinkSync(child);
  } catch {
    // Nothing at `child`: a genuinely missing name, canonical as computed.
  }
  if (target === null) return child;
  if (hops >= MAX_LINK_HOPS) {
    throw new ToolError("PATH_NOT_ALLOWED", "path could not be resolved");
  }
  return canonicalAllowingMissing(resolve(canonicalParent, target), hops + 1);
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
  /** Canonical absolute path (symlinks resolved, missing remainder re-attached). */
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
  // Resolve symlinks over the whole path, including a link whose target does
  // not exist yet, so containment is always judged on the real write target.
  const canonical = canonicalAllowingMissing(absolute, 0);
  const exists = existsSync(canonical);
  if (exists && !statSync(canonical).isFile()) {
    throw new ToolError("PATH_NOT_ALLOWED", "path is not a regular file");
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
  if (!exists && !existsSync(resolve(canonical, ".."))) {
    throw new ToolError("PATH_NOT_ALLOWED", "parent directory does not exist");
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
