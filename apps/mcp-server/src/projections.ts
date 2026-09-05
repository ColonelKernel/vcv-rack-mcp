import type { ConnectionManager } from "./connection.js";

/**
 * Projections shared by the tool surface and the `rack://` resources.
 *
 * Both surfaces publish the same two documents, and both hold them to the same
 * strict schemas (StatusResult, InstanceSummary). While each had its own copy
 * of the projection they could drift: the resource returned the raw
 * `status.get` payload where the tool filtered it, so the first field the
 * plugin added would have failed the resource against `.strict()` while the
 * tool went on passing. One projection, two callers.
 */

/** Whitelist projection of a `status.get` payload onto StatusResult. */
export function mapStatus(s: Record<string, unknown>): Record<string, unknown> {
  return {
    instanceId: s.instanceId,
    sessionId: s.sessionId,
    patchEpoch: s.patchEpoch,
    rackVersion: s.rackVersion,
    rackEdition: s.rackEdition,
    bridgeVersion: s.bridgeVersion,
    bridgeProtocolVersion: s.bridgeProtocolVersion,
    mode: s.mode,
    sampleRate: s.sampleRate,
    patchName: s.patchName ?? null,
    saved: s.saved,
    bridgeModulePresent: s.bridgeModulePresent,
    commandPumpPresent: s.commandPumpPresent,
    writerLease: s.writerLease,
  };
}

/** Discovered instances projected onto InstanceSummary. */
export function listInstanceSummaries(conn: ConnectionManager): Array<Record<string, unknown>> {
  const selectedId = conn.selectedInstance?.instanceId ?? null;
  return conn.listInstances().map((i) => ({
    instanceId: i.manifest.instanceId,
    pid: i.manifest.pid,
    rackVersion: i.manifest.rackVersion,
    rackEdition: i.manifest.rackEdition,
    bridgeVersion: i.manifest.bridgeVersion,
    port: i.manifest.port,
    startTime: i.manifest.startTime,
    lastHeartbeat: i.manifest.lastHeartbeat,
    mode: i.manifest.mode,
    patchName: i.manifest.patchName,
    commandPumpPresent: i.manifest.commandPumpPresent,
    bridgeModulePresent: i.manifest.bridgeModulePresent,
    stale: i.stale,
    selected: i.manifest.instanceId === selectedId,
  }));
}
