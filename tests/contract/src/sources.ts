import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, resolved from this file rather than from process.cwd(). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Source roots the census reads. `kind` decides what a hit there proves:
 *
 * - `declaration` — where the contract is written down. A symbol appearing only
 *   here is declared and unimplemented, which is the whole point of the census.
 * - `generated` — derived from `declaration` by `pnpm run gen`. Hits here are
 *   circular and never count as evidence.
 * - `producer` / `consumer` — real implementation. A wire vocabulary the client
 *   branches on needs one of each.
 * - `support` — tests, scripts and tooling. Real code, but a symbol that lives
 *   only in its own round-trip test is still dead in production.
 */
export type RootKind = "declaration" | "generated" | "producer" | "consumer" | "support";

export interface SourceRoot {
  readonly id: string;
  readonly kind: RootKind;
  readonly dir: string;
  readonly extensions: readonly string[];
}

const CODE = [".ts", ".tsx", ".mjs", ".js"] as const;
const CPP = [".cpp", ".hpp", ".h"] as const;

export const SOURCE_ROOTS: readonly SourceRoot[] = [
  { id: "schemas", kind: "declaration", dir: "packages/schemas/src", extensions: CODE },
  { id: "schemas-json", kind: "generated", dir: "packages/schemas/json", extensions: [".json"] },
  { id: "plugin-gen", kind: "generated", dir: "plugins/RackMCP/src/gen", extensions: CPP },
  { id: "plugin-rackside", kind: "producer", dir: "plugins/RackMCP/src/rackside", extensions: CPP },
  { id: "plugin-core", kind: "producer", dir: "plugins/RackMCP/src/core", extensions: CPP },
  { id: "server", kind: "consumer", dir: "apps/mcp-server/src", extensions: CODE },
  { id: "adapters", kind: "consumer", dir: "packages/adapters/src", extensions: CODE },
  { id: "recipes", kind: "consumer", dir: "packages/recipes/src", extensions: CODE },
  { id: "protocol", kind: "consumer", dir: "packages/protocol/src", extensions: CODE },
  { id: "scripts", kind: "support", dir: "scripts", extensions: CODE },
  { id: "integration", kind: "support", dir: "tests/integration/src", extensions: CODE },
  { id: "cpp-tests", kind: "support", dir: "tests/cpp", extensions: CPP },
];

/** Directory names never descended into, anywhere. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "cpp-build"]);

function walk(dir: string, extensions: readonly string[], out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, extensions, out);
    else if (extensions.some((e) => entry.endsWith(e))) out.push(full);
  }
}

export interface SourceFile {
  /** Repo-relative path with forward slashes, stable across platforms. */
  readonly path: string;
  readonly root: SourceRoot;
  readonly text: string;
  /** `text` with comments replaced by spaces, so offsets are preserved. */
  readonly code: string;
}

/**
 * Replaces every `//` and block comment with spaces of equal length, leaving
 * string and character literals untouched.
 *
 * Comment stripping is not a nicety here: this codebase's comments name every
 * symbol they discuss, so a census run over raw text passes on prose alone and
 * proves nothing. JSON has no comments and is returned unchanged.
 */
export function stripComments(text: string, isJson: boolean): string {
  if (isJson) return text;
  const out = text.split("");
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    const next = i + 1 < n ? text[i + 1] : "";
    if (c === "/" && next === "/") {
      while (i < n && text[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      while (i < stop) {
        if (text[i] !== "\n") out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        const d = text[i]!;
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

let cache: readonly SourceFile[] | undefined;

/** Every scanned source file, read and comment-stripped once per process. */
export function loadSources(): readonly SourceFile[] {
  if (cache) return cache;
  const files: SourceFile[] = [];
  for (const root of SOURCE_ROOTS) {
    const abs = join(REPO_ROOT, root.dir);
    const found: string[] = [];
    walk(abs, root.extensions, found);
    for (const full of found) {
      const text = readFileSync(full, "utf8");
      files.push({
        path: relative(REPO_ROOT, full).split(sep).join("/"),
        root,
        text,
        code: stripComments(text, full.endsWith(".json")),
      });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  cache = files;
  return cache;
}

/**
 * Roots in which `symbol` appears as a whole token in comment-stripped source.
 *
 * Matching is token-based rather than substring-based so that `probeMaxHz` is
 * not credited to a mention of `probeMaxHzDefault`, and so a snake_case wire
 * value is not credited to a longer identifier that contains it.
 */
export function rootsMentioning(
  symbols: readonly string[],
  options: { readonly ignoreFile?: string } = {},
): Set<string> {
  const hit = new Set<string>();
  const patterns = symbols.map(
    (s) => new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(s)}(?![A-Za-z0-9_$])`),
  );
  for (const file of loadSources()) {
    if (file.path === options.ignoreFile) continue;
    if (hit.has(file.root.id)) continue;
    if (patterns.some((p) => p.test(file.code))) hit.add(file.root.id);
  }
  return hit;
}

/** Repo-relative paths of files mentioning `symbol`, for failure messages. */
export function filesMentioning(symbols: readonly string[], kinds?: readonly RootKind[]): string[] {
  const patterns = symbols.map(
    (s) => new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(s)}(?![A-Za-z0-9_$])`),
  );
  return loadSources()
    .filter((f) => (kinds ? kinds.includes(f.root.kind) : true))
    .filter((f) => patterns.some((p) => p.test(f.code)))
    .map((f) => f.path);
}

export function kindsOf(rootIds: Iterable<string>): Set<RootKind> {
  const byId = new Map(SOURCE_ROOTS.map((r) => [r.id, r.kind] as const));
  const out = new Set<RootKind>();
  for (const id of rootIds) {
    const kind = byId.get(id);
    if (kind) out.add(kind);
  }
  return out;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
