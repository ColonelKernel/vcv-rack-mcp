import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditEntry } from "@rackmcp/schemas";
import { AuditLog } from "../src/audit.js";

/**
 * `AuditLog.recent()` feeds `rack://audit/recent`, so what it returns is
 * published. It validates every line through AuditEntry rather than passing
 * whatever JSON is on disk straight into a resource body -- a log written by
 * another server version, or a partial line from an interrupted append, must
 * not reach a client as an entry the published schema rejects.
 *
 * The resource tests stub AuditLog out entirely and the live smokes only ever
 * read lines the same build just wrote, so without these the validation path
 * and the writer/schema agreement were never executed by anything.
 */

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rackmcp-audit-"));
}

describe("AuditLog.recent", () => {
  it("returns what record() wrote, with nothing skipped", () => {
    const dir = scratch();
    const audit = new AuditLog(dir);
    audit.record({ tool: "get_rack_status", outcome: "ok", durationMs: 4 });
    audit.record({
      tool: "commit_patch_transaction",
      outcome: "error",
      errorCode: "PATCH_CONFLICT",
      instanceId: "11111111-1111-4111-8111-111111111111",
      operationId: "22222222-2222-4222-8222-222222222222",
      durationMs: 41,
    });
    const { entries, skipped } = audit.recent(50);
    expect(skipped).toBe(0);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.tool).toBe("get_rack_status");
    expect(entries[1]!.errorCode).toBe("PATCH_CONFLICT");
  });

  it("accepts every field record() can write, so the writer cannot drift from the schema", () => {
    // The round trip is the drift guard: if record() gains a field AuditEntry
    // does not declare, this fails here rather than silently counting the
    // entry as skipped in a published resource body.
    const dir = scratch();
    const audit = new AuditLog(dir);
    audit.record({
      tool: "resource:rack://status",
      outcome: "ok",
      instanceId: "11111111-1111-4111-8111-111111111111",
      operationId: "22222222-2222-4222-8222-222222222222",
      errorCode: "INTERNAL",
      durationMs: 0,
      schemaValid: false,
    });
    const lines = readFileSync(join(dir, "audit.log"), "utf8")
      .split("\n")
      .filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    const parsed = AuditEntry.safeParse(JSON.parse(lines[0]!));
    const issues = parsed.success
      ? []
      : parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    expect(issues).toEqual([]);
  });

  it("counts a malformed line instead of returning it", () => {
    const dir = scratch();
    const audit = new AuditLog(dir);
    audit.record({ tool: "get_rack_status", outcome: "ok" });
    // A half-written line, as an interrupted append leaves behind.
    writeFileSync(join(dir, "audit.log"), `{"ts":"2026-01-01T00:00:00.000Z","to\n`, { flag: "a" });
    const { entries, skipped } = audit.recent(50);
    expect(entries).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("counts a line another version wrote rather than publishing it", () => {
    const dir = scratch();
    const audit = new AuditLog(dir);
    audit.record({ tool: "get_rack_status", outcome: "ok" });
    writeFileSync(
      join(dir, "audit.log"),
      JSON.stringify({
        ts: "2026-01-01T00:00:00.000Z",
        tool: "some_future_tool",
        outcome: "ok",
        somethingThisBuildDoesNotKnow: true,
      }) + "\n",
      { flag: "a" },
    );
    const { entries, skipped } = audit.recent(50);
    expect(entries).toHaveLength(1);
    expect(skipped).toBe(1);
    // AuditEntry is strict on purpose: an unknown field means the writer and
    // this published reader disagree, which is exactly what must not pass
    // silently into a resource body.
    expect(entries[0]!.tool).toBe("get_rack_status");
  });

  it("returns an empty view rather than throwing when no log exists", () => {
    const audit = new AuditLog(join(scratch(), "never", "created"));
    expect(audit.recent(50)).toEqual({ entries: [], skipped: 0 });
  });

  it("honours the limit, keeping the newest entries", () => {
    const dir = scratch();
    const audit = new AuditLog(dir);
    for (let i = 0; i < 10; i++) audit.record({ tool: `tool_${i}`, outcome: "ok" });
    const { entries } = audit.recent(3);
    expect(entries.map((e) => e.tool)).toEqual(["tool_7", "tool_8", "tool_9"]);
  });
});

/**
 * Spec section 13 requires audit retention "configurable by size and age".
 * Nothing implemented it: record() appended forever and recent() read the whole
 * file to return the last 50 lines, so both the disk cost and the cost of every
 * `rack://audit/recent` read grew without bound for the life of the install.
 */
describe("AuditLog retention", () => {
  // AuditEntry caps `tool` at 128 characters, so lines are padded up to that
  // and volume comes from the record count rather than from longer names.
  const pad = (i: number) => `tool_${i}_`.padEnd(110, "x");

  it("rotates the live log once it passes maxBytes, keeping one generation", () => {
    const dir = scratch();
    const audit = new AuditLog(dir, { maxBytes: 4096, maxAgeDays: 30 });
    for (let i = 0; i < 200; i++) audit.record({ tool: pad(i), outcome: "ok" });
    expect(existsSync(join(dir, "audit.log.1"))).toBe(true);
    // Rotation renames, so the live log does not exist again until the next
    // append -- recent() reads the rotated generation in the gap.
    audit.record({ tool: "after_rotation", outcome: "ok" });
    // Everything retained is now bounded by roughly one generation plus the
    // live log, not by everything ever written.
    const live = statSync(join(dir, "audit.log")).size;
    const rotated = statSync(join(dir, "audit.log.1")).size;
    expect(live).toBeLessThan(4096);
    expect(live + rotated).toBeLessThan(200 * 130);
  });

  it("keeps answering with recent history across a rotation", () => {
    // Rotating straight to nothing would blank the view at the moment a busy
    // session had produced the most history -- the opposite of what this log
    // is for.
    const dir = scratch();
    // One generation has to be able to hold what recent() asks for; at 4 KB it
    // holds ~25 lines, and retention genuinely means the rest is gone.
    const audit = new AuditLog(dir, { maxBytes: 32 * 1024, maxAgeDays: 30 });
    for (let i = 0; i < 400; i++) audit.record({ tool: pad(i), outcome: "ok" });
    expect(existsSync(join(dir, "audit.log.1"))).toBe(true);
    const { entries } = audit.recent(50);
    expect(entries).toHaveLength(50);
    expect(entries[entries.length - 1]!.tool).toContain("tool_399_");
  });

  it("deletes a rotated generation past maxAgeDays", () => {
    const dir = scratch();
    const audit = new AuditLog(dir, { maxBytes: 2048, maxAgeDays: 7 });
    for (let i = 0; i < 100; i++) audit.record({ tool: pad(i), outcome: "ok" });
    const rotated = join(dir, "audit.log.1");
    expect(existsSync(rotated)).toBe(true);
    // Age it past the limit and force another rotation.
    const old = new Date(Date.now() - 30 * 86400000);
    utimesSync(rotated, old, old);
    const before = readFileSync(rotated, "utf8");
    for (let i = 0; i < 100; i++) audit.record({ tool: pad(10000 + i), outcome: "ok" });
    // The aged generation was expired, not carried forward.
    expect(readFileSync(rotated, "utf8")).not.toBe(before);
  });

  it("keeps everything when retention is disabled", () => {
    const dir = scratch();
    const audit = new AuditLog(dir, { maxBytes: 0, maxAgeDays: 0 });
    for (let i = 0; i < 200; i++) audit.record({ tool: pad(i), outcome: "ok" });
    expect(existsSync(join(dir, "audit.log.1"))).toBe(false);
    expect(audit.recent(10).entries).toHaveLength(10);
  });

  it("reads a bounded tail rather than the whole log", () => {
    // A log far larger than the tail window must still answer, and must answer
    // with the NEWEST entries -- reading from the front would return the oldest.
    const dir = scratch();
    const audit = new AuditLog(dir, { maxBytes: 0, maxAgeDays: 0 });
    for (let i = 0; i < 8000; i++) audit.record({ tool: pad(i), outcome: "ok" });
    expect(statSync(join(dir, "audit.log")).size).toBeGreaterThan(1024 * 1024);
    const { entries, skipped } = audit.recent(20);
    expect(entries).toHaveLength(20);
    expect(entries[entries.length - 1]!.tool).toContain("tool_7999_");
    // The tail read starts mid-file, so it starts mid-line; that fragment is
    // not a record and must not be counted as a malformed one.
    expect(skipped).toBe(0);
  });
});
