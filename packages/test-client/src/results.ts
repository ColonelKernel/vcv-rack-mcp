/**
 * Unwrapping an MCP tool result.
 *
 * Every smoke carried `const sc = (r: unknown) => (r as { structuredContent: ... }).structuredContent`,
 * an unchecked cast. When a call failed in a way that produced no structured
 * content, the next property access threw `Cannot read properties of undefined`
 * with no mention of which tool was called -- so the diagnostic pointed at the
 * assertion rather than at the tool that broke. These functions look first.
 */

/** The error shape every tool uses: `structuredContent.error`. */
export interface ToolError {
  code: string;
  message: string;
}

interface RawResult {
  structuredContent?: unknown;
  isError?: boolean;
  content?: unknown;
}

function raw(result: unknown): RawResult {
  return (result ?? {}) as RawResult;
}

/**
 * A best-effort rendering for the failure message.
 *
 * `JSON.stringify` *throws* on a cycle rather than returning undefined, so the
 * obvious `JSON.stringify(x) ?? String(x)` makes this function die while
 * producing the diagnostic it exists to produce -- replacing a message that
 * names the tool with "Converting circular structure to JSON". A wire result
 * cannot be cyclic, having just been parsed from JSON; a caller passing a
 * hand-built object can be, and so can one carrying a BigInt or a throwing
 * `toJSON`.
 */
function describe(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json.slice(0, 400);
  } catch {
    /* fall through to the untyped rendering */
  }
  return String(value);
}

/**
 * The structured payload, or a thrown error naming the tool.
 *
 * @param toolName only used in the failure message, which is the entire point.
 */
export function structured(result: unknown, toolName = "tool"): Record<string, unknown> {
  const r = raw(result);
  const sc = r.structuredContent;
  if (sc === null || typeof sc !== "object") {
    throw new Error(
      `${toolName} returned no structuredContent (isError=${String(r.isError)}); ` +
        `raw result: ${describe(result)}`,
    );
  }
  return sc as Record<string, unknown>;
}

/**
 * The tool's error, or null if it succeeded.
 *
 * `isError` alone is not the test: a tool can report a domain error inside
 * `structuredContent.error` and the transport-level flag is what the SDK sets.
 * A result counts as an error if either says so, which is how the smokes were
 * already reading it -- inconsistently, some checking `isError` and some
 * reaching straight for `.error.code`.
 */
export function toolError(result: unknown): ToolError | null {
  const r = raw(result);
  const sc = (r.structuredContent ?? {}) as { error?: unknown };
  const err = sc.error;
  if (err !== null && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown };
    return {
      code: typeof e.code === "string" ? e.code : "",
      message: typeof e.message === "string" ? e.message : "",
    };
  }
  return r.isError === true ? { code: "", message: "" } : null;
}

/** True when the call neither set `isError` nor carried an `error` payload. */
export function succeeded(result: unknown): boolean {
  return toolError(result) === null;
}
