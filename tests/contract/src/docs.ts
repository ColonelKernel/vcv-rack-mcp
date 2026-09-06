import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { CENSUS_EXCEPTIONS } from "@rackmcp/schemas";
import { REPO_ROOT } from "./sources.js";

let tracked: ReadonlySet<string> | undefined;

/**
 * Every path a fresh clone contains: tracked files plus their ancestor
 * directories.
 *
 * Deliberately not `existsSync`. An untracked directory is present for whoever
 * created it and absent for everyone else, so a filesystem check makes a doc
 * that names one pass locally and mislead every reader. `packages/test-client`
 * is exactly that: an empty untracked directory that README.md describes as a
 * shipped package.
 */
export function trackedPaths(): ReadonlySet<string> {
  if (tracked) return tracked;
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const paths = new Set<string>();
  for (const file of out.split("\0")) {
    if (!file) continue;
    paths.add(file);
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join("/"));
  }
  tracked = paths;
  return tracked;
}

export interface DocFile {
  readonly path: string;
  readonly text: string;
}

const DOC_DIRS = ["docs"] as const;
const DOC_FILES = ["README.md", "CHANGELOG.md", "LICENSE.md"] as const;

function walkMarkdown(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkMarkdown(full, out);
    else if (entry.endsWith(".md")) out.push(full);
  }
}

let cache: readonly DocFile[] | undefined;

export function loadDocs(): readonly DocFile[] {
  if (cache) return cache;
  const found: string[] = [];
  for (const dir of DOC_DIRS) walkMarkdown(join(REPO_ROOT, dir), found);
  for (const file of DOC_FILES) {
    const full = join(REPO_ROOT, file);
    if (existsSync(full)) found.push(full);
  }
  cache = found
    .sort()
    .map((full) => ({
      path: relative(REPO_ROOT, full).split(sep).join("/"),
      text: readFileSync(full, "utf8"),
    }));
  return cache;
}

let ignored: ReadonlySet<string> | undefined;

/**
 * Of `candidates`, those git deliberately ignores.
 *
 * A doc may legitimately name a path that no clone contains, as long as a
 * documented step produces it: `vendor/Rack-SDK` after fetch-rack-sdk.sh,
 * `apps/mcp-server/dist/bundle/rack-mcp-server.mjs` after a build. Those are in
 * .gitignore, which makes "ignored" the exact test for "build artifact" and
 * keeps this gate from needing a hand-maintained allowlist that would drift.
 */
export function ignoredPaths(candidates: readonly string[]): ReadonlySet<string> {
  if (ignored) return ignored;
  if (candidates.length === 0) return (ignored = new Set());
  let out = "";
  try {
    out = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      input: candidates.join("\n"),
    });
  } catch (err) {
    // git check-ignore exits 1 when nothing matches, which is not an error.
    const e = err as { status?: number; stdout?: string };
    if (e.status !== 1) throw err;
    out = e.stdout ?? "";
  }
  ignored = new Set(out.split("\n").filter(Boolean));
  return ignored;
}

export interface BrokenRef {
  readonly doc: string;
  readonly line: number;
  readonly ref: string;
  readonly resolved: string;
}

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Relative markdown links that do not resolve to a file in the repo. */
export function brokenLinks(): BrokenRef[] {
  const broken: BrokenRef[] = [];
  for (const doc of loadDocs()) {
    const lines = doc.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      LINK.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = LINK.exec(lines[i]!)) !== null) {
        const href = m[1]!;
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // http:, mailto:, ...
        if (href.startsWith("#")) continue; // in-page anchor
        const target = href.split("#")[0]!;
        if (!target) continue;
        const abs = normalize(join(dirname(join(REPO_ROOT, doc.path)), target));
        const resolved = relative(REPO_ROOT, abs).split(sep).join("/");
        if (!trackedPaths().has(resolved)) {
          broken.push({ doc: doc.path, line: i + 1, ref: href, resolved });
        }
      }
    }
  }
  return broken;
}

/** Top-level directories a backticked token must start with to be read as a path. */
const REPO_DIRS = [
  "apps/",
  "docs/",
  "packages/",
  "plugins/",
  "scripts/",
  "tests/",
  "vendor/",
  ".github/",
];

const CODE_SPAN = /`([^`\n]+)`/g;

/**
 * Backticked repo-relative paths that do not exist.
 *
 * Only tokens beginning with a known top-level directory are treated as path
 * claims, so `pnpm run test` and `json_object_set_new(...)` are not mistaken
 * for files. A trailing `:123` line reference is stripped, and glob segments
 * are resolved back to their last literal directory.
 */
export function missingPaths(): BrokenRef[] {
  const candidates: BrokenRef[] = [];
  for (const doc of loadDocs()) {
    const lines = doc.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      CODE_SPAN.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CODE_SPAN.exec(lines[i]!)) !== null) {
        const raw = m[1]!.trim();
        if (!REPO_DIRS.some((d) => raw.startsWith(d))) continue;
        if (!/^[A-Za-z0-9_./*-]+$/.test(raw)) continue;
        const target = literalPrefix(raw.replace(/:\d+(?:-\d+)?$/, "").replace(/\/$/, ""));
        if (!target) continue;
        if (!trackedPaths().has(target)) {
          candidates.push({ doc: doc.path, line: i + 1, ref: raw, resolved: target });
        }
      }
    }
  }
  const buildOutputs = ignoredPaths([...new Set(candidates.map((c) => c.resolved))]);
  const excused = new Set(
    CENSUS_EXCEPTIONS.filter((e) => e.kind === "doc_referent").map((e) => e.symbol),
  );
  return candidates.filter((c) => !buildOutputs.has(c.resolved) && !excused.has(c.resolved));
}

/** `plugins/RackMCP/src/rackside/**` -> `plugins/RackMCP/src/rackside`. */
function literalPrefix(path: string): string {
  const parts = path.split("/");
  const stop = parts.findIndex((p) => p.includes("*"));
  return (stop === -1 ? parts : parts.slice(0, stop)).join("/");
}

export function describeRef(r: BrokenRef): string {
  return `${r.doc}:${r.line} -> ${r.ref}`;
}
