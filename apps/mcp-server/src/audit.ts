import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditEntry } from "@rackmcp/schemas";
import { log } from "./logger.js";

/**
 * Append-only audit log of tool invocations (spec sections 3.1, 14). Secrets
 * and opaque module data are never recorded. One JSON object per line.
 */
export class AuditLog {
  private file: string | null = null;

  constructor(private readonly auditDir: string) {}

  private ensureFile(): string | null {
    if (this.file) return this.file;
    try {
      mkdirSync(this.auditDir, { recursive: true, mode: 0o700 });
      this.file = join(this.auditDir, "audit.log");
      return this.file;
    } catch (e) {
      log.warn("audit log unavailable", { error: String(e) });
      return null;
    }
  }

  record(entry: {
    tool: string;
    outcome: "ok" | "error";
    instanceId?: string | undefined;
    operationId?: string | undefined;
    errorCode?: string | undefined;
    durationMs?: number | undefined;
    /**
     * False when the tool result failed validation against its declared output
     * schema (see server.ts). Omitted when the result validated. Recorded so
     * schema drift between the bridge and packages/schemas is auditable.
     */
    schemaValid?: boolean | undefined;
  }): void {
    const file = this.ensureFile();
    if (!file) return;
    try {
      appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    } catch (e) {
      log.warn("audit append failed", { error: String(e) });
    }
  }

  /**
   * Returns up to `limit` most-recent audit entries, newest last, alongside a
   * count of lines this build could not accept. Never throws.
   *
   * Every line is validated against AuditEntry rather than passed through as
   * whatever JSON is on disk: this feeds `rack://audit/recent`, and a log
   * written by another server version (or a partial line from an interrupted
   * append) must not reach a client as an entry the published schema rejects.
   * Rejected lines are counted, not hidden -- a caller can see that the view
   * is incomplete.
   */
  recent(limit = 50): { entries: AuditEntry[]; skipped: number } {
    const file = this.ensureFile();
    if (!file) return { entries: [], skipped: 0 };
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return { entries: [], skipped: 0 };
    }
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const tail = lines.slice(-Math.max(0, limit));
    const entries: AuditEntry[] = [];
    let skipped = 0;
    for (const line of tail) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        skipped++;
        continue;
      }
      const parsed = AuditEntry.safeParse(raw);
      if (parsed.success) entries.push(parsed.data);
      else skipped++;
    }
    return { entries, skipped };
  }
}
