import { ERROR_CODES } from "@rackmcp/schemas";
import { loadSources } from "./sources.js";

/**
 * Gate G — every error code the plugin emits is one the schema declares.
 *
 * `ERROR_CODES` is generated into the C++ header as an `ErrorCode` enum with an
 * `errorCodeToString`, and the plugin uses neither: it passes codes to
 * `buildResError` and friends as bare string literals. So `"UNSUPORTED_OPERATION"`
 * compiles, ships, and reaches a client that branches on the code and has never
 * heard of it -- and `ERROR_CODES` is exactly a wire vocabulary clients branch
 * on (spec section 12: "Never renumber or rename; only append").
 *
 * Converting every call site to the enum is a large mechanical change with its
 * own risk of introducing the typo it is meant to prevent. This checks the
 * literals where they are instead, which catches the same class.
 */
export interface EmittedCode {
  readonly file: string;
  readonly line: number;
  readonly code: string;
}

/**
 * The three shapes the plugin writes an error code in. Anything computed --
 * `errorCode.c_str()`, a variable -- is not matched and not checked; this gate
 * is about literals, which is where a typo hides.
 */
const PATTERNS: readonly RegExp[] = [
  /buildResError\s*\(\s*[^,]+,\s*"([A-Z_][A-Z0-9_]*)"/g,
  /\berrorCode\s*=\s*"([A-Z_][A-Z0-9_]*)"/g,
  /\berr\s*=\s*\{\s*"([A-Z_][A-Z0-9_]*)"/g,
];

/** Every error-code literal the plugin emits, with where it is. */
export function emittedCodes(): EmittedCode[] {
  const out: EmittedCode[] = [];
  for (const file of loadSources()) {
    if (file.root.kind !== "producer" || !/\.(cpp|hpp|h)$/.test(file.path)) continue;
    // Comment-stripped, for Gate A's reason: this codebase's comments name the
    // codes they discuss, so an unstripped scan would credit prose.
    const lines = file.code.split("\n");
    lines.forEach((text, i) => {
      for (const re of PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) if (m[1]) out.push({ file: file.path, line: i + 1, code: m[1] });
      }
    });
  }
  return out;
}

/** Emitted codes the schema does not declare. */
export function undeclaredCodes(): EmittedCode[] {
  const declared = new Set<string>(ERROR_CODES);
  return emittedCodes().filter((e) => !declared.has(e.code));
}

/**
 * Declared codes the plugin never emits.
 *
 * Reported, not asserted: several codes are the server's to raise, so an unused
 * one is information rather than a defect.
 */
export function unemittedCodes(): string[] {
  const emitted = new Set(emittedCodes().map((e) => e.code));
  return ERROR_CODES.filter((c) => !emitted.has(c));
}
