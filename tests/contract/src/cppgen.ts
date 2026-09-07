import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, escapeRegExp, loadSources, stripComments } from "./sources.js";

/**
 * Gate F — every symbol the C++ generator emits has a reader.
 *
 * `scripts/gen-cpp.ts` writes a header of constants and tables derived from
 * `packages/schemas`. Two of those tables shipped with no consumer at all:
 * `OPERATION_SPECS` and `METHOD_SPECS` described every declared field and its
 * JSON type, while the plugin read payloads with accessors that substitute a
 * default for anything unexpected -- including, for `set_bypass`, a default
 * that silenced the module. The information needed to refuse those frames had
 * been in the header the whole time, and adding the reader immediately turned
 * up two divergences nobody had noticed.
 *
 * A generated symbol nobody reads is worse than a missing one: it reads as a
 * check that exists. This is the argument Gate A makes about schema symbols,
 * turned on the generator's own output.
 */
export const GENERATED_HEADER = "plugins/RackMCP/src/gen/rackmcp_protocol_gen.hpp";

/**
 * Symbols deliberately left unread, with the reason.
 *
 * Keep this short and specific. "It might be useful later" is not a reason --
 * that is precisely the state this gate exists to make visible.
 */
/**
 * Enforcement for these lives on the MCP server. The generator emits every
 * entry of `LIMITS` uniformly so the two sides cannot disagree about a value,
 * which necessarily produces C++ constants with no C++ reader.
 */
const LIMIT_ENFORCED_SERVER_SIDE =
  "Enforced on the MCP server, not in the plugin. The generator emits every entry of LIMITS uniformly so the two sides cannot disagree about a value; a limit whose enforcement lives server-side therefore has a C++ constant with no C++ reader, and that is the intended shape rather than a gap.";

/**
 * Symbols deliberately left unread, with the reason.
 *
 * Keep these specific. "It might be useful later" is not a reason -- that is
 * precisely the state this gate exists to make visible.
 */
export const GEN_SYMBOL_EXCEPTIONS: ReadonlyArray<{ symbol: string; reason: string }> = [
  {
    symbol: "FRAME_SPECS",
    reason:
      "Reserved. The five bridge frame kinds validate the fields they actually read at the " +
      "point of use -- selectProtocolVersion checks hello.versions, the auth path checks " +
      "hmac -- and the only declared-but-unread field is hello.client. Enforcing the table " +
      "would reject a client omitting a field nothing consults: a behaviour change with no " +
      "safety benefit. Revisit when a frame kind gains a field a handler reads.",
  },
  { symbol: "FRAME_SPEC_COUNT", reason: "Only meaningful alongside FRAME_SPECS; same disposition." },
  { symbol: "FrameSpec", reason: "The element type of FRAME_SPECS; same disposition." },
  { symbol: "LIMIT_COMMAND_TIMEOUT_MS", reason: LIMIT_ENFORCED_SERVER_SIDE },
  { symbol: "LIMIT_CONFIRMATION_LIFETIME_MS", reason: LIMIT_ENFORCED_SERVER_SIDE },
  { symbol: "LIMIT_INSTANCE_STALE_AFTER_MS", reason: LIMIT_ENFORCED_SERVER_SIDE },
  { symbol: "LIMIT_MAX_ACTIVE_PROBES", reason: LIMIT_ENFORCED_SERVER_SIDE },
  { symbol: "LIMIT_MCP_RESULT_BYTES", reason: LIMIT_ENFORCED_SERVER_SIDE },
  { symbol: "LIMIT_PARAM_CHANGES_PER_SECOND", reason: LIMIT_ENFORCED_SERVER_SIDE },
  { symbol: "LIMIT_PATCH_IO_TIMEOUT_MS", reason: LIMIT_ENFORCED_SERVER_SIDE },
  { symbol: "LIMIT_PROBE_MAX_HZ", reason: LIMIT_ENFORCED_SERVER_SIDE },
  { symbol: "LIMIT_TXN_COMMIT_TIMEOUT_MS", reason: LIMIT_ENFORCED_SERVER_SIDE },
  { symbol: "LIMIT_TXN_MAX_ADDED_MODULES", reason: LIMIT_ENFORCED_SERVER_SIDE },
  {
    symbol: "ErrorCode",
    reason:
      "Known gap, not a decision. The plugin passes error codes to buildResError as string " +
      "literals, so a typo compiles and ships a code no client recognises, and ERROR_CODES is " +
      "a vocabulary clients branch on. Converting every call site is a large mechanical " +
      "change; the literals are checked against ERROR_CODES by errorcodes.ts instead, which " +
      "catches the same class without touching them.",
  },
  {
    symbol: "errorCodeToString",
    reason: "Only useful once ErrorCode has C++ callers; same disposition as ErrorCode.",
  },
];

/**
 * Per-field arrays exist only to be pointed at by their table literal in the
 * same header. The table is what a reader consumes.
 */
const PER_FIELD_ARRAY = /^(FRAME_FIELDS_|METHOD_FIELDS_|OP_FIELDS_|ALLOWED_)/;

/** Top-level symbols the generated header defines. */
export function generatedSymbols(
  source = readFileSync(join(REPO_ROOT, GENERATED_HEADER), "utf8"),
): string[] {
  const body = stripComments(source, false);
  const found = new Set<string>();
  const patterns = [
    /^static const [A-Za-z_][A-Za-z0-9_:<>*\s]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[\]|=)/gm,
    /^struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm,
    /^enum class\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm,
    /^inline\s+[A-Za-z_][A-Za-z0-9_:<>*\s]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) if (m[1]) found.add(m[1]);
  }
  return [...found].filter((s) => !PER_FIELD_ARRAY.test(s)).sort();
}

/** Symbols with no whole-token reference in hand-written C++. */
export function unreadGeneratedSymbols(symbols: readonly string[] = generatedSymbols()): string[] {
  // Hand-written C++ only: the generated root is excluded because a hit there
  // is the definition, and TypeScript is excluded because the generator names
  // every symbol it emits.
  // Producer roots only -- the plugin's own hand-written C++. A symbol read
  // solely by tests/cpp is still unread in production, which sources.ts states
  // outright for the `support` kind: "a symbol that lives only in its own
  // round-trip test is still dead". FRAME_SPEC_COUNT is exactly that; it is
  // asserted to equal 9 and used nowhere.
  const corpus = loadSources()
    .filter((f) => f.root.kind === "producer" && /\.(cpp|hpp|h)$/.test(f.path))
    .map((f) => f.code)
    .join("\n");
  return symbols.filter((s) => !new RegExp(`\\b${escapeRegExp(s)}\\b`).test(corpus)).sort();
}
