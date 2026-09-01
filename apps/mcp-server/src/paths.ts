import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import type { ServerConfig } from "./config.js";
import { ToolError } from "./errors.js";

/**
 * Patch-path policy (spec section 8): paths are constrained to the configured
 * roots (Rack patches dir, RackMCP checkpoints dir), canonicalized, symlink-
 * resolved, `.vcv`-only, traversal-rejected, never URLs.
 */
export type PatchRoot = "patches" | "checkpoints";

function isUrl(p: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(p) || p.startsWith("file:");
}

/** Real, canonical path of an existing directory (resolves symlinks). */
function canonicalDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return realpathSync(dir);
}

function within(root: string, target: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep;
  return target === root || target.startsWith(r);
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

  const patchesRoot = canonicalDir(config.patchesDir);
  const checkpointsRoot = canonicalDir(config.checkpointsDir);

  const absolute = resolve(requested);
  // Resolve symlinks on the existing portion (the parent must exist).
  let canonical: string;
  const exists = existsSync(absolute);
  if (exists) {
    canonical = realpathSync(absolute);
    if (!statSync(canonical).isFile()) {
      throw new ToolError("PATH_NOT_ALLOWED", "path is not a regular file");
    }
  } else {
    // Canonicalize the parent, then re-attach the basename.
    const parent = resolve(absolute, "..");
    if (!existsSync(parent)) {
      throw new ToolError("PATH_NOT_ALLOWED", "parent directory does not exist");
    }
    canonical = resolve(realpathSync(parent), basename(absolute));
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
