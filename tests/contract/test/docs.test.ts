import { describe as suite, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CENSUS_EXCEPTIONS } from "@rackmcp/schemas";
import {
  brokenLinks,
  describeRef,
  gitIgnored,
  loadDocs,
  missingPaths,
  trackedPaths,
} from "../src/docs.js";
import { REPO_ROOT } from "../src/sources.js";
import { INCLUDE_RULES, loadCoreUnits, missingIncludes } from "../src/cppincludes.js";

suite("documentation referents", () => {
  test("the scanner reads the documentation set", () => {
    expect(loadDocs().length).toBeGreaterThan(15);
  });

  test("existence is judged against git, not the working tree", () => {
    const paths = trackedPaths();
    expect(paths.has("README.md")).toBe(true);
    expect(paths.has("docs/spec")).toBe(true);
    // A path that is only ever present as build output must not count as real.
    expect(paths.has("node_modules")).toBe(false);
  });

  test("every relative link resolves", () => {
    expect(
      brokenLinks().map(describeRef),
      "a documentation link points at a file that does not exist",
    ).toEqual([]);
  });

  test("every backticked repo path exists", () => {
    expect(
      missingPaths().map(describeRef),
      "the docs name a file or directory that is not in the repo. A path in backticks reads as " +
        "a fact about the tree, and a reader will go looking for it.",
    ).toEqual([]);
  });
});

suite("doc referent exceptions", () => {
  test("no exception excuses a path that now exists", () => {
    const stale = CENSUS_EXCEPTIONS.filter(
      (e) => e.kind === "doc_referent" && trackedPaths().has(e.symbol),
    );
    expect(
      stale.map((e) => e.symbol),
      "these paths are in the repo now; delete their CENSUS_EXCEPTIONS entries",
    ).toEqual([]);
  });

  test("every excused path is actually named by a doc", () => {
    const named = new Set(
      loadDocs().flatMap((d) => [...d.text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.trim())),
    );
    const orphans = CENSUS_EXCEPTIONS.filter(
      (e) =>
        e.kind === "doc_referent" && !named.has(e.symbol) && !named.has(`${e.symbol}/`),
    );
    expect(
      orphans.map((e) => e.symbol),
      "no doc names these any more, so the exception is dead weight",
    ).toEqual([]);
  });
});

suite("the ignore check does not depend on what happens to be on disk", () => {
  /**
   * This gate was red in CI and green on the author's laptop for four commits.
   *
   * A directory-only .gitignore pattern (`vendor/Rack-SDK/`) matches a
   * slashless path only when git can see the path IS a directory, which it
   * learns from the filesystem. So `git check-ignore vendor/Rack-SDK` answered
   * "ignored" on a machine that had fetched the SDK and "not ignored" on a
   * clean checkout -- same repo, same commit, same .gitignore, opposite
   * verdict. Every doc naming `vendor/Rack-SDK` then failed the referent check
   * on CI only.
   *
   * The scratch repository is the whole point: it has a .gitignore and NO
   * files, which is the state CI is in and the author's machine never is.
   */
  const patterns = ["vendor/Rack-SDK/", "plugins/RackMCP/dist/", "dist/"];
  const absent = [
    "vendor/Rack-SDK",
    "vendor/Rack-SDK/include/rack.hpp",
    "plugins/RackMCP/dist",
    "plugins/RackMCP/dist/RackMCP-2.0.0-mac-arm64.vcvplugin",
  ];

  function scratchRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "rackmcp-ignore-"));
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    writeFileSync(join(dir, ".gitignore"), patterns.join("\n") + "\n");
    return dir;
  }

  test("excuses a build output whose directory has never been created", () => {
    const dir = scratchRepo();
    const ignored = gitIgnored(dir, absent);
    for (const p of absent) {
      expect(ignored.has(p), `${p} must be recognised as ignored with nothing on disk`).toBe(true);
    }
  });

  test("still refuses a path no .gitignore rule covers", () => {
    // The fix must not buy disk-independence by excusing everything: appending
    // a slash to any path at all would make this pass too.
    const dir = scratchRepo();
    const ignored = gitIgnored(dir, ["docs/tutorial/first-patch.md", "src/nope.ts"]);
    expect([...ignored]).toEqual([]);
  });

  test("agrees with the live repository, which has the files", () => {
    // Same question asked of the real tree, where the directories DO exist.
    // Both answers must be "ignored"; before the fix they differed.
    expect(gitIgnored(REPO_ROOT, ["vendor/Rack-SDK"]).has("vendor/Rack-SDK")).toBe(true);
  });
});

suite("core/ standard includes", () => {
  test("every standard type used in core/ is explicitly included", () => {
    // See src/cppincludes.ts: this is the check that would have caught
    // core/layout.hpp using int64_t with no <cstdint>, which built on macOS
    // and broke the ubuntu and windows jobs.
    expect(
      missingIncludes().map((m) => `${m.path} uses ${m.what} without <${m.header}>`),
      "a core/ file relies on a standard header arriving transitively, which libc++ does and libstdc++ does not",
    ).toEqual([]);
  });

  test("the rules actually match the code they are about", () => {
    // A rule whose pattern matches nothing in the tree is not protecting
    // anything, and would not be noticed: the suite above passes either way.
    // This does not require every rule to fire -- some are there for types the
    // repo has not used yet -- but it does require the load-bearing ones to.
    const units = loadCoreUnits();
    for (const header of ["cstdint", "size_t", "std::string", "std::vector"]) {
      const rule = INCLUDE_RULES.find((r) => r.header === header || r.what.includes(header));
      expect(rule, `no rule covers ${header}`).toBeDefined();
      expect(
        units.some((u) => rule!.pattern.test(u.body)),
        `no core/ file uses ${rule!.what}, so that rule is vacuous`,
      ).toBe(true);
    }
  });
});
