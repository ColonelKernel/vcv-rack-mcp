import { homedir, platform } from "node:os";
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
  /** Default request deadline forwarded to the bridge. */
  requestDeadlineMs: number;
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
    requestDeadlineMs: Number(env.RACKMCP_REQUEST_DEADLINE_MS ?? 5000),
  };
}
