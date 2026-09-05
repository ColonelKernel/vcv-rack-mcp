import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { AuditEntry } from "@rackmcp/schemas";
import { log } from "./logger.js";

/**
 * Append-only audit log of tool invocations (spec sections 3.1, 14). Secrets
 * and opaque module data are never recorded. One JSON object per line.
 *
 * Retention is by size and age, as spec section 13 requires. The live log is
 * rotated to `audit.log.1` once it passes `maxBytes`, and a rotated generation
 * is deleted once it is older than `maxAgeDays`. Keeping one previous
 * generation matters for the troubleshooting use this log exists for:
 * rotating straight to nothing would blank the recent view at the exact moment
 * a busy session had produced the most history.
 */

/**
 * Bytes read from the end of a log when answering `recent()`.
 *
 * Enough for far more than any sane `limit` of JSON lines, and bounded so the
 * cost of the read does not grow with the history. Reading the whole file to
 * return the last 50 lines meant an installation that had been running for
 * months loaded its entire audit history into memory on every read of
 * `rack://audit/recent`.
 */
const TAIL_BYTES = 256 * 1024;

export interface AuditRetention {
  /** Rotate the live log once it exceeds this. 0 disables rotation. */
  maxBytes: number;
  /** Delete a rotated generation older than this. 0 keeps it indefinitely. */
  maxAgeDays: number;
}

const DEFAULT_RETENTION: AuditRetention = { maxBytes: 8 * 1024 * 1024, maxAgeDays: 30 };

export class AuditLog {
  private file: string | null = null;
  private readonly retention: AuditRetention;
  /**
   * Bytes appended since the last size check. Rotation is checked against this
   * rather than by stat()ing on every append: one extra syscall per tool call
   * to learn a number we already know is waste, and the check only needs to be
   * timely, not exact.
   */
  private sinceCheck = 0;

  constructor(
    private readonly auditDir: string,
    retention: Partial<AuditRetention> = {},
  ) {
    this.retention = { ...DEFAULT_RETENTION, ...retention };
  }

  private ensureFile(): string | null {
    if (this.file) return this.file;
    try {
      mkdirSync(this.auditDir, { recursive: true, mode: 0o700 });
      this.file = join(this.auditDir, "audit.log");
      this.expireRotated();
      return this.file;
    } catch (e) {
      log.warn("audit log unavailable", { error: String(e) });
      return null;
    }
  }

  private rotatedPath(): string {
    return join(this.auditDir, "audit.log.1");
  }

  /** Drops a rotated generation past its age limit. Never throws. */
  private expireRotated(): void {
    const days = this.retention.maxAgeDays;
    if (days <= 0) return;
    const rotated = this.rotatedPath();
    try {
      if (!existsSync(rotated)) return;
      const ageMs = Date.now() - statSync(rotated).mtimeMs;
      if (ageMs > days * 24 * 60 * 60 * 1000) {
        rmSync(rotated, { force: true });
        log.info("expired rotated audit log", { path: rotated, ageDays: Math.floor(ageMs / 86400000) });
      }
    } catch (e) {
      log.warn("audit expiry failed", { error: String(e) });
    }
  }

  /** Rotates the live log when it has grown past the size limit. Never throws. */
  private rotateIfLarge(file: string): void {
    const max = this.retention.maxBytes;
    if (max <= 0) return;
    // Only stat once enough has been written that the limit could plausibly
    // have been crossed since the last check.
    if (this.sinceCheck < Math.min(64 * 1024, Math.max(1, max))) return;
    this.sinceCheck = 0;
    try {
      if (statSync(file).size <= max) return;
      this.expireRotated();
      // rename replaces any existing generation, so exactly one is kept.
      renameSync(file, this.rotatedPath());
      log.info("rotated audit log", { path: file, maxBytes: max });
    } catch (e) {
      log.warn("audit rotation failed", { error: String(e) });
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
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
      appendFileSync(file, line);
      this.sinceCheck += Buffer.byteLength(line, "utf8");
      this.rotateIfLarge(file);
    } catch (e) {
      log.warn("audit append failed", { error: String(e) });
    }
  }

  /**
   * Reads at most the last TAIL_BYTES of a file, dropping a leading partial
   * line. Returns an empty array for a missing or unreadable file.
   */
  private tailLines(file: string): string[] {
    let fd: number | null = null;
    try {
      fd = openSync(file, "r");
      const size = fstatSync(fd).size;
      const length = Math.min(size, TAIL_BYTES);
      const buf = Buffer.allocUnsafe(length);
      readSync(fd, buf, 0, length, size - length);
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      // Starting mid-file almost certainly starts mid-line; that fragment is
      // not a record and must not be counted as a malformed one.
      if (size > length && lines.length > 0) lines.shift();
      return lines.filter((l) => l.trim().length > 0);
    } catch {
      return [];
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
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
    const want = Math.max(0, limit);
    let lines = this.tailLines(file);
    // Immediately after a rotation the live log is nearly empty, which would
    // otherwise make the recent view go blank right when a busy session has
    // produced the most history. Top up from the rotated generation.
    if (lines.length < want) {
      const older = this.tailLines(this.rotatedPath());
      lines = older.concat(lines);
    }
    const tail = lines.slice(-want);
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
