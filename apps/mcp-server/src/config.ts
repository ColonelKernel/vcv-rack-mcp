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

/** Rack's default user directory per platform (Rack 2). */
export function defaultRackUserDir(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Rack2");
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Rack2");
    default:
      return join(home, ".Rack2");
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rackUserDir = env.RACKMCP_RACK_USER_DIR ?? defaultRackUserDir();
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
