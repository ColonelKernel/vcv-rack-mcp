import { describe as suite, expect, test } from "vitest";
import { CENSUS_EXCEPTIONS } from "@rackmcp/schemas";
import { brokenLinks, describeRef, loadDocs, missingPaths, trackedPaths } from "../src/docs.js";

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
