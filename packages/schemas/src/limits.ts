/**
 * Default limits for Rack MCP (spec section 13). All limits are defaults and,
 * where noted, configurable at server startup. These constants are the single
 * source of truth: the C++ header `plugins/RackMCP/src/gen/rackmcp_protocol_gen.hpp`
 * is generated from this module (`pnpm run gen`).
 */
export const BRIDGE_PROTOCOL_VERSION = 1;
/** Oldest bridge protocol version this codebase can still speak. */
export const BRIDGE_PROTOCOL_MIN_SUPPORTED = 1;

export const LIMITS = {
  /** Maximum bridge frame size in bytes (length prefix must not exceed this). */
  bridgeFrameBytes: 1 * 1024 * 1024,
  /** Maximum MCP structured result size in bytes. */
  mcpResultBytes: 4 * 1024 * 1024,
  /** Maximum operations per patch transaction. */
  txnMaxOperations: 128,
  /** Maximum modules added per transaction. */
  txnMaxAddedModules: 32,
  /** Maximum simultaneously attached probe channels per instance. */
  maxActiveProbes: 16,
  /**
   * Rate at which the probe telemetry window is republished (Hz). Derived from
   * probeWindowMs below, not chosen independently: a "max rate" that disagreed
   * with how often a new window exists would be describing nothing.
   */
  probeMaxHz: 20,
  /** Maximum parameter changes per second per client. */
  paramChangesPerSecond: 30,
  /** Confirmation token lifetime (ms). */
  confirmationLifetimeMs: 5 * 60 * 1000,
  /** Default bridge command timeout (ms). */
  commandTimeoutMs: 5 * 1000,
  /** Default patch load/save timeout (ms); configurable. */
  patchIoTimeoutMs: 60 * 1000,
  /** Default transaction commit timeout (ms); configurable. */
  txnCommitTimeoutMs: 30 * 1000,
  /** Minimum retention of mutation results keyed by operation ID (ms). */
  idempotencyCacheMs: 10 * 60 * 1000,
  /** JSON boundary limits enforced before any processing. */
  jsonMaxDepth: 64,
  jsonMaxStringBytes: 256 * 1024,
  jsonMaxTotalNodes: 250_000,
  /** Bridge heartbeat / discovery-manifest refresh interval (ms). */
  bridgeHeartbeatIntervalMs: 2_000,
  /** A manifest whose heartbeat is older than this is considered stale (ms). */
  instanceStaleAfterMs: 10_000,
  /** Commands drained by the UI command pump per frame. */
  pumpCommandsPerFrame: 4,
  /** Soft time budget for the UI command pump per frame (ms). */
  pumpFrameBudgetMs: 4,
  /** Probe telemetry window length (ms). */
  probeWindowMs: 50,
  /** Probe inputs on one RackMCP-Probe module. */
  probeInputsPerModule: 8,
} as const;

export type Limits = typeof LIMITS;
