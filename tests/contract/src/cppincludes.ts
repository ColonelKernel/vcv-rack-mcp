/**
 * Gate D -- every C++ standard type used in plugins/RackMCP/src/core is backed
 * by an explicit include of the header that declares it.
 *
 * This exists because the failure mode is invisible on the machine that writes
 * the code. libc++ (macOS) pulls <cstdint> in transitively through <map> and
 * <vector>; libstdc++ (Linux) does not. So a header using int64_t with no
 * #include <cstdint> compiles cleanly on the author's Mac, passes every local
 * test, and fails only in the ubuntu and windows CI jobs -- which is exactly
 * what core/layout.hpp did, and what five older core headers were one
 * transitive include away from doing.
 *
 * It is a text scan, deliberately: it runs in the TypeScript job on all three
 * platforms and, more to the point, in under a second on the author's machine
 * before anything is pushed. A compiler cannot answer this question without
 * the toolchain that would have caught it anyway.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, stripComments } from "./sources.js";

const CORE_DIR = join(REPO_ROOT, "plugins", "RackMCP", "src", "core");

/** Identifier patterns and the header that must be included to use them. */
export const INCLUDE_RULES: ReadonlyArray<{
  header: string;
  pattern: RegExp;
  what: string;
}> = [
  { header: "cstdint", pattern: /\bu?int(?:8|16|32|64)_t\b/, what: "fixed-width integer types" },
  { header: "cstddef", pattern: /\bsize_t\b/, what: "size_t" },
  { header: "string", pattern: /\bstd::string\b/, what: "std::string" },
  { header: "vector", pattern: /\bstd::vector\b/, what: "std::vector" },
  { header: "map", pattern: /\bstd::map\b/, what: "std::map" },
  { header: "set", pattern: /\bstd::set\b/, what: "std::set" },
  {
    header: "mutex",
    pattern: /\bstd::(?:mutex|lock_guard|unique_lock)\b/,
    what: "mutex primitives",
  },
  { header: "atomic", pattern: /\bstd::atomic\b/, what: "std::atomic" },
  { header: "memory", pattern: /\bstd::(?:unique_ptr|shared_ptr)\b/, what: "smart pointers" },
  { header: "functional", pattern: /\bstd::function\b/, what: "std::function" },
  { header: "cstring", pattern: /\b(?:memcpy|memset|memcmp|strlen)\s*\(/, what: "C string/memory" },
];

export interface CoreUnit {
  /** Repo-relative path. */
  readonly path: string;
  /** Standard headers this unit includes, directly or via a core/ header. */
  readonly includes: ReadonlySet<string>;
  /** Source with comments removed, so prose naming a type does not count. */
  readonly body: string;
}

function standardIncludes(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^\s*#\s*include\s*<([^>]+)>/gm)) out.add(m[1]!);
  return out;
}

function coreIncludes(text: string): string[] {
  return [...text.matchAll(/^\s*#\s*include\s*"core\/([A-Za-z0-9_]+\.hpp)"/gm)].map((m) => m[1]!);
}

/**
 * Every translation unit and header under core/.
 *
 * A .cpp inherits the standard includes of the core/ headers it includes: a
 * .cpp using int64_t is fine when its own header already declares the types it
 * defines. Only one level is followed, which is enough for this layout and
 * keeps the rule explicable.
 */
export function loadCoreUnits(): CoreUnit[] {
  const names = readdirSync(CORE_DIR).filter((n) => n.endsWith(".hpp") || n.endsWith(".cpp"));
  const raw = new Map<string, string>();
  for (const n of names) raw.set(n, readFileSync(join(CORE_DIR, n), "utf8"));

  return names.map((n) => {
    const text = raw.get(n)!;
    const includes = standardIncludes(text);
    for (const dep of coreIncludes(text)) {
      const depText = raw.get(dep);
      if (depText) for (const h of standardIncludes(depText)) includes.add(h);
    }
    return {
      path: `plugins/RackMCP/src/core/${n}`,
      includes,
      body: stripComments(text, false),
    };
  });
}

export interface MissingInclude {
  readonly path: string;
  readonly header: string;
  readonly what: string;
}

export function missingIncludes(): MissingInclude[] {
  const out: MissingInclude[] = [];
  for (const unit of loadCoreUnits()) {
    // Ignore the #include lines themselves, or <cstdint> would match cstdint.
    const code = unit.body.replace(/^\s*#\s*include\s*[<"][^>"]+[>"]/gm, "");
    for (const rule of INCLUDE_RULES) {
      if (rule.pattern.test(code) && !unit.includes.has(rule.header)) {
        out.push({ path: unit.path, header: rule.header, what: rule.what });
      }
    }
  }
  return out;
}
