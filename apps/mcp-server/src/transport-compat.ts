import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { log } from "./logger.js";

/**
 * Treats an omitted `arguments` member as an empty object on the two requests
 * that carry one.
 *
 * The MCP schema makes `arguments` optional on both `prompts/get` and
 * `tools/call`, and a client invoking something that needs no arguments
 * naturally omits it. The SDK (1.30.0) builds a Zod object from the declared
 * argument/input shape and parses `request.params.arguments` through it
 * unconditionally -- `validateToolInput` and the prompt handler both do -- and a
 * Zod object rejects `undefined`. So the spec-legal
 *
 *     {"method":"tools/call","params":{"name":"list_rack_instances"}}
 *
 * came back as `-32602 Invalid input: expected object, received undefined`
 * instead of the instance list. Six tools here take no arguments at all
 * (list_rack_instances, get_rack_status, acquire_writer_lease,
 * release_writer_lease, preview_clear_patch, list_probes) and five more have
 * none that are required, so eleven of twenty-nine tools were unreachable by
 * that spelling. Every prompt was affected too.
 *
 * Prompts that take no arguments are additionally fixed at the source, by
 * declaring no argument shape at all (see prompts/index.ts). This covers the
 * rest: something whose arguments are all optional becomes callable with none,
 * and something with required arguments now reports which argument is missing
 * instead of complaining about the container.
 *
 * Applied at the transport rather than by reaching into the SDK's handler map:
 * `onmessage` is part of the public Transport interface, so this does not
 * depend on SDK internals that can be renamed. Wrap AFTER `server.connect`,
 * which is when the protocol installs its own handler.
 */

/** Requests whose `params.arguments` the MCP schema marks optional. */
const OPTIONAL_ARGUMENTS_METHODS = new Set(["prompts/get", "tools/call"]);

/** Marks a handler this module already wrapped, so wrapping twice is a no-op. */
const WRAPPED = Symbol.for("rackmcp.argumentsCompat");

export function normalizeOmittedArguments(transport: Transport): void {
  const inner = transport.onmessage as
    | (Transport["onmessage"] & { [WRAPPED]?: true })
    | undefined;
  if (!inner) {
    // connect() should have installed one; without it there is nothing to wrap
    // and silently doing nothing would hide the fact that this never ran.
    log.warn("argument compatibility not installed: transport has no onmessage handler");
    return;
  }
  if (inner[WRAPPED]) return;

  const wrapped: Transport["onmessage"] & { [WRAPPED]?: true } = (message, extra) => {
    const m = message as { method?: unknown; params?: Record<string, unknown> } | null;
    if (
      m &&
      typeof m.method === "string" &&
      OPTIONAL_ARGUMENTS_METHODS.has(m.method) &&
      m.params &&
      // `null` gets the same treatment as omitted: it is not spec-legal, but a
      // client that means "no arguments" by it deserves the call to work rather
      // than an error about the container's type.
      (m.params.arguments === undefined || m.params.arguments === null)
    ) {
      m.params.arguments = {};
    }
    inner(message, extra);
  };
  wrapped[WRAPPED] = true;
  transport.onmessage = wrapped;
}
