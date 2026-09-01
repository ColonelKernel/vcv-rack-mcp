import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { InstanceManifest, LIMITS } from "@rackmcp/schemas";

export interface DiscoveredInstance {
  manifest: InstanceManifest;
  manifestPath: string;
  stale: boolean;
  pidAlive: boolean;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Scans <rackUserDir>/RackMCP/instances for discovery manifests. Invalid
 * manifests are skipped (untrusted input); staleness combines heartbeat age
 * with a process-liveness check.
 */
export function scanInstances(discoveryDir: string): DiscoveredInstance[] {
  let entries: string[];
  try {
    entries = readdirSync(discoveryDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const found: DiscoveredInstance[] = [];
  for (const entry of entries) {
    const manifestPath = join(discoveryDir, entry);
    try {
      if (statSync(manifestPath).size > 64 * 1024) continue;
      const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      const parsed = InstanceManifest.safeParse(raw);
      if (!parsed.success) continue;
      const manifest = parsed.data;
      const age = Date.now() - Date.parse(manifest.lastHeartbeat);
      const alive = pidAlive(manifest.pid);
      found.push({
        manifest,
        manifestPath,
        stale: !alive || age > LIMITS.instanceStaleAfterMs,
        pidAlive: alive,
      });
    } catch {
      continue;
    }
  }
  return found;
}

/** Reads the pairing secret (raw 32 bytes) from <rackUserDir>/RackMCP/secret. */
export function loadPairingSecret(rackmcpDir: string): Buffer {
  const hex = readFileSync(join(rackmcpDir, "secret"), "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("pairing secret file is malformed");
  }
  return Buffer.from(hex, "hex");
}
