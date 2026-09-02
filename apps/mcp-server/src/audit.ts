import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  /** Returns up to `limit` most-recent audit entries, newest last. Never throws. */
  recent(limit = 50): Array<Record<string, unknown>> {
    const file = this.ensureFile();
    if (!file) return [];
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const tail = lines.slice(-Math.max(0, limit));
    const out: Array<Record<string, unknown>> = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  }
}
