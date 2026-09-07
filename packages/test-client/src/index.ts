/**
 * `@rackmcp/test-client` -- the scriptable MCP client the README and the spec
 * both list as a shipped package.
 *
 * It exists to be *used by* the live smokes in `tests/integration`, which
 * cannot run in CI (they need a real Rack). The pure parts -- result
 * unwrapping and assertion tallying -- are unit tested here, so the half of
 * this package that can be gated, is.
 */
export { Checks } from "./checks.js";
export { RackTestClient, defaultServerEntry } from "./client.js";
export type { RackTestClientOptions } from "./client.js";
export { structured, toolError, succeeded } from "./results.js";
export type { ToolError } from "./results.js";
