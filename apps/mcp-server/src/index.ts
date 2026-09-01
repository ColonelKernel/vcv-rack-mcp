#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { log } from "./logger.js";

/**
 * Entry point: launched by an MCP host over stdio. Never writes to stdout
 * except MCP protocol traffic (the SDK owns stdout; diagnostics go to stderr).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const { server, conn } = createServer(config);

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    try {
      await conn.releaseLease();
    } catch {
      // best effort
    }
    conn.disconnect();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("rack-mcp-server listening on stdio", {
    rackUserDir: config.rackUserDir,
  });
}

main().catch((err) => {
  log.error("fatal", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
