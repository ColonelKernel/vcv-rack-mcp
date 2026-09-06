import { homedir, platform } from "node:os";
import { LIMITS } from "@rackmcp/schemas";
import { join } from "node:path";

/**
 * Server configuration. All roots default to the Rack user directory; nothing
 * outside the configured patch/checkpoint/audit locations is ever touched.
 */
export interface ServerConfig {
  /** Rack user directory (holds RackMCP/, patches/, autosave/). */
  rackUserDir: string;
  rackmcpDir: string;
  discoveryDir: string;
  checkpointsDir: string;
  patchesDir: string;
  auditDir: string;
  /**
   * Audit retention (spec section 13: "configurable by size and age").
   * `auditMaxBytes` is the size at which the live log is rotated to
   * `audit.log.1`; `auditMaxAgeDays` is how long a rotated generation is kept.
   * Either set to 0 disables that half of the policy.
   */
  auditMaxBytes: number;
  auditMaxAgeDays: number;
  /** Default request deadline forwarded to the bridge. */
  requestDeadlineMs: number;
  /**
   * Deadlines for the two operations that can legitimately take much longer
   * than a normal bridge request: patch file I/O, and applying a transaction.
   * Both are published in LIMITS and were previously hardcoded at the six call
   * sites, so the documented limit and the enforced one could drift apart
   * silently.
   */
  patchIoTimeoutMs: number;
  txnCommitTimeoutMs: number;
}

/** Parses a non-negative numeric env var, falling back on anything unusable. */
function numeric(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Rack's default user directory per platform, matching Rack 2.6.6's asset.cpp:
 * macOS `~/Library/Application Support/Rack2`, Windows `%LOCALAPPDATA%\Rack2`,
 * Linux `$XDG_DATA_HOME/Rack2` (default `~/.local/share/Rack2`; Rack migrates the
 * pre-2.5 `~/.Rack2` itself).
 */
export function defaultRackUserDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Rack2");
    case "win32":
      return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Rack2");
    default:
      return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "Rack2");
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // Rack itself honours RACK_USER_DIR (asset.cpp); ours takes precedence, then Rack's.
  const rackUserDir = env.RACKMCP_RACK_USER_DIR ?? env.RACK_USER_DIR ?? defaultRackUserDir(env);
  const rackmcpDir = join(rackUserDir, "RackMCP");
  return {
    rackUserDir,
    rackmcpDir,
    discoveryDir: join(rackmcpDir, "instances"),
    checkpointsDir: join(rackmcpDir, "checkpoints"),
    patchesDir: join(rackUserDir, "patches"),
    auditDir: join(rackmcpDir, "audit"),
    auditMaxBytes: numeric(env.RACKMCP_AUDIT_MAX_BYTES, 8 * 1024 * 1024),
    auditMaxAgeDays: numeric(env.RACKMCP_AUDIT_MAX_AGE_DAYS, 30),
    requestDeadlineMs: numeric(env.RACKMCP_REQUEST_DEADLINE_MS, LIMITS.commandTimeoutMs),
    patchIoTimeoutMs: numeric(env.RACKMCP_PATCH_IO_TIMEOUT_MS, LIMITS.patchIoTimeoutMs),
    txnCommitTimeoutMs: numeric(env.RACKMCP_TXN_COMMIT_TIMEOUT_MS, LIMITS.txnCommitTimeoutMs),
  };
}
