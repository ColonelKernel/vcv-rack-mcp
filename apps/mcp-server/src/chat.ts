/**
 * The in-Rack chat surface.
 *
 * Nothing here can be pushed. The bridge is request/response with this server
 * as the requester, and this server has no way to push to its own host either,
 * so a note typed in Rack reaches the assistant only when the assistant next
 * calls a tool. The plugin emits a `user_note_pending` event as a hint, and the
 * connection manager records it — but the note itself is always fetched with an
 * ordinary request, so losing the event costs latency and never a note.
 */
import type { ChatPollResult, ChatPostResult } from "@rackmcp/schemas";
import type { ToolHandler } from "./tools.js";

export const readUserNotes: ToolHandler = async (args, ctx) => {
  await ctx.conn.ensureConnected();
  const result = await ctx.conn.request<ChatPollResult>("chat.poll", {
    sinceSeq: (args.sinceSeq as number | undefined) ?? 0,
  });
  ctx.conn.clearPendingUserNotes();
  return result;
};

export const postChatMessage: ToolHandler = async (args, ctx) => {
  await ctx.conn.ensureConnected();
  return ctx.conn.request<ChatPostResult>("chat.post", {
    text: args.text,
    ackThroughSeq: (args.ackThroughSeq as number | undefined) ?? 0,
  });
};
