import { describe, expect, it } from "vitest";
import { ChatPollResult, ChatPostResult, TOOL_NAMES } from "@rackmcp/schemas";
import { postChatMessage, readUserNotes } from "../src/chat.js";
import type { ToolContext } from "../src/tools.js";

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

function fakeCtx(reply: unknown): { ctx: ToolContext; calls: Call[]; cleared: () => number } {
  const calls: Call[] = [];
  let clears = 0;
  let pending = true;
  const conn = {
    ensureConnected: async () => ({ instanceId: "i", sessionId: "s", patchEpoch: 1 }),
    request: async (method: string, payload: Record<string, unknown>) => {
      calls.push({ method, payload });
      return reply;
    },
    hasPendingUserNotes: () => pending,
    clearPendingUserNotes: () => {
      clears++;
      pending = false;
    },
  };
  return {
    ctx: { conn, txns: {}, serverVersion: "0.0.0", bridgeProtocolVersion: 1 } as unknown as ToolContext,
    calls,
    cleared: () => clears,
  };
}

describe("in-Rack chat tools", () => {
  it("are registered on the MCP surface", () => {
    expect(TOOL_NAMES).toContain("read_user_notes");
    expect(TOOL_NAMES).toContain("post_chat_message");
  });

  it("reads notes from a sequence number and returns the bridge result", async () => {
    const reply = { notes: [{ seq: 4, text: "too dark", clock: "14:25:01" }], lastSeq: 4, dropped: 0 };
    const { ctx, calls } = fakeCtx(reply);
    const out = await readUserNotes({ sinceSeq: 3 }, ctx);
    expect(calls).toEqual([{ method: "chat.poll", payload: { sinceSeq: 3 } }]);
    expect(ChatPollResult.parse(out)).toEqual(reply);
  });

  it("defaults to reading everything retained", async () => {
    const { ctx, calls } = fakeCtx({ notes: [], lastSeq: 0, dropped: 0 });
    await readUserNotes({}, ctx);
    expect(calls[0]!.payload).toEqual({ sinceSeq: 0 });
  });

  it("clears the pending flag once notes have been read", async () => {
    // The flag exists so an assistant that never calls read_user_notes still
    // learns from get_rack_status that something is waiting. Leaving it set
    // after a read would make it permanently true and therefore useless.
    const { ctx, cleared } = fakeCtx({ notes: [], lastSeq: 0, dropped: 0 });
    expect(ctx.conn.hasPendingUserNotes()).toBe(true);
    await readUserNotes({}, ctx);
    expect(cleared()).toBe(1);
    expect(ctx.conn.hasPendingUserNotes()).toBe(false);
  });

  it("posts a reply and forwards the acknowledgement cursor", async () => {
    const reply = { seq: 2, acknowledged: 1 };
    const { ctx, calls } = fakeCtx(reply);
    const out = await postChatMessage({ text: "cutoff lowered", ackThroughSeq: 4 }, ctx);
    expect(calls).toEqual([
      { method: "chat.post", payload: { text: "cutoff lowered", ackThroughSeq: 4 } },
    ]);
    expect(ChatPostResult.parse(out)).toEqual(reply);
  });

  it("acknowledges nothing when no cursor is given", async () => {
    // Silently acknowledging everything would mark notes delivered that the
    // assistant has not actually seen, which is the one thing the pending
    // marker exists to prevent.
    const { ctx, calls } = fakeCtx({ seq: 1, acknowledged: 0 });
    await postChatMessage({ text: "hello" }, ctx);
    expect(calls[0]!.payload.ackThroughSeq).toBe(0);
  });
});
