import { appendFileSync, mkdirSync } from "node:fs";
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
  }): void {
    const file = this.ensureFile();
    if (!file) return;
    try {
      appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    } catch (e) {
      log.warn("audit append failed", { error: String(e) });
    }
  }
}
