import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { encodeFrame, FrameDecoder } from "../src/framing.js";

describe("TS framing", () => {
  it("round trips", () => {
    const d = new FrameDecoder();
    expect(d.push(encodeFrame('{"kind":"ping"}'))).toBe(true);
    expect(d.next()).toBe('{"kind":"ping"}');
    expect(d.next()).toBeNull();
  });

  it("handles split delivery and batches", () => {
    const d = new FrameDecoder();
    const wire = Buffer.concat([encodeFrame("aaa"), encodeFrame("bbbb")]);
    for (const byte of wire) {
      d.push(Buffer.from([byte]));
    }
    expect(d.next()).toBe("aaa");
    expect(d.next()).toBe("bbbb");
    expect(d.next()).toBeNull();
  });

  it("rejects oversize declarations permanently", () => {
    const d = new FrameDecoder(1024);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(2048, 0);
    d.push(header);
    expect(d.next()).toBeNull();
    expect(d.error).toBe(true);
  });

  it("encode rejects oversize payloads", () => {
    expect(() => encodeFrame("x".repeat(2048), 1024)).toThrow();
  });

  it("fuzz: chunked round trips always reassemble", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 200 }), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 1, max: 7 }),
        (payloads, chunkSize) => {
          const wire = Buffer.concat(payloads.map((p) => encodeFrame(p)));
          const d = new FrameDecoder();
          const out: string[] = [];
          for (let i = 0; i < wire.length; i += chunkSize) {
            expect(d.push(wire.subarray(i, i + chunkSize))).toBe(true);
            let f: string | null;
            while ((f = d.next()) !== null) out.push(f);
          }
          expect(out).toEqual(payloads);
        },
      ),
      { numRuns: 200 },
    );
  });
});
