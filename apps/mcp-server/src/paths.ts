import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
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

/**
 * Canonical form of a configured root, for reporting rather than for policy.
 *
 * Same answer as `canonicalDir` when the directory is there, but it neither
 * creates it nor throws when it is not: a listing of a root that does not exist
 * is empty, not an error.
 */
export function canonicalRoot(dir: string): string {
  try {
    return realCanonical(dir);
  } catch {
    return dir;
  }
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
  if (opts.mustExist && statSync(canonical).size === 0) {
    // A zero-byte .vcv is not a patch, and loading one is worse than refusing:
    // Rack's `Manager::load()` clears the patch before it reads the archive, so
    // the throw leaves an EMPTY rack behind (PatchFiles.cpp says so, and bumps
    // the epoch to prove it). The file can exist: a checkpoint reservation
    // whose write never landed, an interrupted copy, a full disk. Refusing on
    // the read side is what keeps such a file from being offered as something
    // restorable.
    throw new ToolError(
      "PATH_NOT_ALLOWED",
      "patch file is empty, so it holds no patch to load; it is most likely a write that never " +
        "completed",
    );
  }
  return { absolute: canonical, root, exists };
}

/**
 * Timestamped checkpoint path inside the checkpoints root.
 *
 * The name is a lossy encoding of (stamp, label) in three separate ways, so
 * distinct calls really can land on one path: the stamp has millisecond
 * resolution, sanitisation maps every character outside `[A-Za-z0-9_-]` to `_`
 * (`a/b` and `a:b` collide), and the label is cut to 40 characters. Use
 * `reserveCheckpointPath` rather than this directly for anything that will be
 * written -- nothing downstream refuses to overwrite, and a lost checkpoint has
 * no second copy anywhere.
 */
export function checkpointPath(config: ServerConfig, label: string | undefined, stampMs: number): string {
  const stamp = new Date(stampMs).toISOString().replace(/[:.]/g, "-");
  const safeLabel = (label ?? "checkpoint").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const root = canonicalDir(config.checkpointsDir);
  return resolve(root, `${stamp}_${safeLabel}.vcv`);
}

/** Distinct names tried before a checkpoint reservation gives up. */
const MAX_CHECKPOINT_ATTEMPTS = 100;

/**
 * Claims a checkpoint path by creating the file exclusively, and returns the
 * name it actually got.
 *
 * Checking `existsSync` and then handing the path to the plugin would leave a
 * window in which a second caller checks the same free name: both write, and
 * `savePatchAtomic` renames over whatever is there, so one recovery point is
 * gone with no trace. `wx` moves the decision into the kernel, which is where
 * "does this name exist yet" can be answered and acted on at once.
 *
 * The reservation is a zero-byte file, replaced by the plugin's atomic rename.
 * It is briefly visible to `list_patch_files` -- deliberately, since the
 * alternative is a name that is free until someone else takes it. Pass it to
 * `releaseCheckpointReservation` when the write does not happen.
 */
export function reserveCheckpointPath(
  config: ServerConfig,
  label: string | undefined,
  stampMs: number,
): string {
  const base = checkpointPath(config, label, stampMs);
  const stem = base.slice(0, -".vcv".length);
  for (let n = 1; n <= MAX_CHECKPOINT_ATTEMPTS; n++) {
    const candidate = n === 1 ? base : `${stem}-${n}.vcv`;
    let fd: number;
    try {
      fd = openSync(candidate, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      // INTERNAL, not PATH_NOT_ALLOWED: the path is inside the root and passed
      // policy, and the published meaning of PATH_NOT_ALLOWED is "outside the
      // allowed locations -- use a path within the configured roots", which is
      // advice that cannot fix a full or read-only directory.
      throw new ToolError(
        "INTERNAL",
        `the checkpoint file could not be created (${(err as NodeJS.ErrnoException).code ?? "unknown error"}); ` +
          "make the checkpoints directory writable with free space, then retry",
        true,
      );
    }
    closeSync(fd);
    return candidate;
  }
  throw new ToolError(
    "INTERNAL",
    `${MAX_CHECKPOINT_ATTEMPTS} checkpoints already exist for this label and millisecond; ` +
      "use a different label",
    true,
  );
}

/**
 * Gives a reservation back when the patch was never written into it.
 *
 * Only an empty file is removed. That is a necessary guard and not a sufficient
 * one: `statSync` then `unlinkSync` is two syscalls, so a write landing between
 * them would be deleted. **Call this only when the plugin has reported a
 * failure**, which is the one outcome that proves it is not still writing --
 * `savePatchAtomic` archives into a sibling temp and only then renames, so any
 * error it reports leaves the destination untouched. After a timeout or a
 * dropped connection the write may still be in flight; leave the reservation
 * instead, and let `resolvePatchPath`'s empty-file refusal make it harmless.
 */
export function releaseCheckpointReservation(path: string): void {
  try {
    if (statSync(path).size === 0) unlinkSync(path);
  } catch {
    // Already replaced, already gone, or not inspectable: leave it.
  }
}
