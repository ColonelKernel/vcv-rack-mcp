import { LIMITS } from "@rackmcp/schemas";

/** Encodes one bridge frame: 4-byte big-endian length + UTF-8 JSON. */
export function encodeFrame(payload: string, maxFrameBytes = LIMITS.bridgeFrameBytes): Buffer {
  const body = Buffer.from(payload, "utf8");
  if (body.length > maxFrameBytes) {
    throw new Error(`frame exceeds ${maxFrameBytes} bytes`);
  }
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/**
 * Incremental decoder mirroring the C++ implementation: a declared length
 * beyond the limit is a permanent error (the connection must be dropped).
 */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private failed = false;

  constructor(private readonly maxFrameBytes = LIMITS.bridgeFrameBytes) {}

  get error(): boolean {
    return this.failed;
  }

  push(chunk: Buffer): boolean {
    if (this.failed) return false;
    if (this.buffered + chunk.length > 2 * (this.maxFrameBytes + 4)) {
      this.failed = true;
      return false;
    }
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    return true;
  }

  next(): string | null {
    if (this.failed || this.buffered < 4) return null;
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    this.chunks = [all];
    const length = all.readUInt32BE(0);
    if (length > this.maxFrameBytes) {
      this.failed = true;
      return null;
    }
    if (all.length < 4 + length) return null;
    const frame = all.subarray(4, 4 + length).toString("utf8");
    const rest = all.subarray(4 + length);
    this.chunks = rest.length > 0 ? [Buffer.from(rest)] : [];
    this.buffered = rest.length;
    return frame;
  }
}
