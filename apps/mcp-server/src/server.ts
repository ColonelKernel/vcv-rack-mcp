import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BRIDGE_PROTOCOL_VERSION } from "@rackmcp/schemas";
import type { ServerConfig } from "./config.js";
import { ConnectionManager } from "./connection.js";
import { TransactionManager } from "./transactions.js";
import { AuditLog } from "./audit.js";
import { toErrorPayload } from "./errors.js";
import { log } from "./logger.js";
import { bindServerConfig, buildToolTable, RESULT_LIMIT_BYTES, type ToolContext } from "./tools.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources.js";

export const SERVER_VERSION = "0.1.0";

/**
 * Builds the MCP server, registering all tools with strict input schemas,
 * structured output, error normalization, audit logging, and result-size
 * enforcement. stdout is reserved for MCP; diagnostics go to stderr.
 */
export function createServer(config: ServerConfig): {
  server: McpServer;
  conn: ConnectionManager;
} {
  const conn = new ConnectionManager(config);
  const txns = new TransactionManager(conn);
  const audit = new AuditLog(config.auditDir);
  const ctx: ToolContext = {
    conn,
    txns,
    serverVersion: SERVER_VERSION,
    bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
  };
  bindServerConfig(ctx, config);

  const server = new McpServer(
    { name: "rack-mcp-server", version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  for (const tool of buildToolTable()) {
    server.registerTool(
      tool.spec.name,
      {
        title: tool.spec.title,
        description: tool.spec.description,
        inputSchema: tool.inputShape,
        annotations: {
          title: tool.spec.title,
          readOnlyHint: tool.spec.annotations.readOnlyHint,
          destructiveHint: tool.spec.annotations.destructiveHint,
          idempotentHint: tool.spec.annotations.idempotentHint,
          openWorldHint: tool.spec.annotations.openWorldHint,
        },
      },
      async (args: Record<string, unknown>) => {
        const started = Date.now();
        try {
          // Re-validate against the full strict schema (defense in depth).
          const parsed = tool.spec.input.parse(args ?? {});
          const result = await tool.handler(parsed as Record<string, unknown>, ctx);

          const structured = result as Record<string, unknown>;
          const serialized = JSON.stringify(structured);
          if (Buffer.byteLength(serialized, "utf8") > RESULT_LIMIT_BYTES) {
            throw new Error(`result exceeds ${RESULT_LIMIT_BYTES} bytes`);
          }
          audit.record({
            tool: tool.spec.name,
            outcome: "ok",
            instanceId: conn.selectedInstance?.instanceId,
            durationMs: Date.now() - started,
          });
          return {
            content: [{ type: "text" as const, text: serialized }],
            structuredContent: structured,
          };
        } catch (err) {
          const payload = toErrorPayload(err);
          audit.record({
            tool: tool.spec.name,
            outcome: "error",
            instanceId: conn.selectedInstance?.instanceId,
            errorCode: payload.code,
            durationMs: Date.now() - started,
          });
          log.warn("tool error", { tool: tool.spec.name, code: payload.code, message: payload.message });
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `${payload.code}: ${payload.message}`,
              },
            ],
            structuredContent: { error: payload },
          };
        }
      },
    );
  }

  registerPrompts(server);
  registerResources(server, { conn, audit, resultLimitBytes: RESULT_LIMIT_BYTES });

  log.info("rack-mcp-server built", { tools: buildToolTable().length });
  return { server, conn };
}
