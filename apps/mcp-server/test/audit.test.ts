import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
