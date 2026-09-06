import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "@rackmcp/schemas";
import { buildToolTable } from "../src/tools.js";
import { normalizeOmittedArguments } from "../src/transport-compat.js";

/**
 * `arguments` is optional on both `prompts/get` and `tools/call`, so a client
 * invoking something that needs none omits it. The SDK parses
 * `request.params.arguments` through a Zod object built from the declared
 * shape, and a Zod object rejects `undefined` -- so the natural call to a
 * zero-argument tool came back as
 * `-32602 ... Invalid input: expected object, received undefined`.
 *
 * Driven through a real Client/Server pair over an in-memory transport, using
 * the real tools' real input schemas, and issuing the request at the raw
 * request level: `client.callTool()` always fills in `arguments`, so it cannot
 * express the omission this is about.
 */

/** Tools a spec-legal client may call with no `arguments` member at all. */
function zeroArgumentTools(): string[] {
  return TOOLS.filter((t) => t.input.safeParse({}).success).map((t) => t.name);
}

/** A server exposing the real input schemas, with handlers stubbed out. */
async function connected(options: { withCompat: boolean }): Promise<Client> {
  const server = new McpServer({ name: "rack-mcp-test", version: "0.1.0" });
  for (const tool of buildToolTable()) {
    server.registerTool(
      tool.spec.name,
      { title: tool.spec.title, description: tool.spec.description, inputSchema: tool.inputShape },
      // The defect is in argument validation, which runs before the handler.
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "compat-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  if (options.withCompat) normalizeOmittedArguments(serverTransport);
  return client;
}

/** Flattens a CallToolResult's content to text for message assertions. */
function text(res: { content?: unknown }): string {
  return JSON.stringify(res.content ?? "");
}

/** tools/call with the `arguments` member genuinely absent from params. */
function callWithoutArguments(client: Client, name: string) {
  return client.request({ method: "tools/call", params: { name } }, CallToolResultSchema);
}

describe("tools/call with the arguments member omitted", () => {
  it("finds tools that are legitimately callable with no arguments", () => {
    // If this ever drops to zero the suite below stops proving anything.
    const names = zeroArgumentTools();
    expect(names).toContain("list_rack_instances");
    expect(names).toContain("get_rack_status");
    expect(names.length).toBeGreaterThanOrEqual(6);
  });

  it("rejects every one of them without the compatibility shim", async () => {
    // The defect, reproduced. Asserting it here is what stops the shim being
    // quietly deleted as dead code: remove it and this test starts failing.
    // The SDK reports this as an error RESULT rather than a JSON-RPC error,
    // so a client sees isError with a message about the container's type --
    // nothing it could act on.
    const client = await connected({ withCompat: false });
    for (const name of zeroArgumentTools()) {
      const res = await callWithoutArguments(client, name);
      expect(res.isError, name).toBe(true);
      expect(text(res), name).toMatch(/expected object, received undefined/);
    }
  });

  it("accepts every one of them with the shim installed", async () => {
    const client = await connected({ withCompat: true });
    for (const name of zeroArgumentTools()) {
      const res = await callWithoutArguments(client, name);
      expect(res.isError, name).toBeFalsy();
    }
  });

  it("still rejects a tool whose arguments are required, naming the argument", async () => {
    // Tolerating an omitted container must not tolerate a missing argument --
    // and the complaint must name the argument, not the container.
    const client = await connected({ withCompat: true });
    const res = await callWithoutArguments(client, "select_rack_instance");
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/instanceId/);
    expect(text(res)).not.toMatch(/expected object, received undefined/);
  });

  it("leaves arguments that were supplied untouched", async () => {
    const client = await connected({ withCompat: true });
    const res = await client.callTool({
      name: "inspect_module",
      arguments: { moduleId: "4360803558046751" },
    });
    expect(res.isError).toBeFalsy();
  });

  it("does not disturb a request that carries no arguments member by design", async () => {
    // tools/list has no `arguments`; the shim must not invent one or throw.
    const client = await connected({ withCompat: true });
    const { tools } = await client.listTools();
    expect(tools.length).toBe(TOOLS.length);
  });

  it("is idempotent, so wrapping twice does not double-normalize", async () => {
    const server = new McpServer({ name: "rack-mcp-test", version: "0.1.0" });
    server.registerTool(
      "noargs",
      { description: "takes nothing", inputSchema: {} },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "compat-test", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    normalizeOmittedArguments(serverTransport);
    normalizeOmittedArguments(serverTransport);
    const res = await callWithoutArguments(client, "noargs");
    expect(res.isError).toBeFalsy();
  });

  it("treats an explicit null the same as an omission", async () => {
    const client = await connected({ withCompat: true });
    const res = await client.request(
      { method: "tools/call", params: { name: "list_rack_instances", arguments: null } },
      CallToolResultSchema,
    );
    expect(res.isError).toBeFalsy();
  });
});

describe("registered input schemas", () => {
  it("registers each tool with the schema the published contract declares", () => {
    // The shim defaults a missing container; it must not be papering over a
    // registration that lost its schema, which would accept anything.
    for (const tool of buildToolTable()) {
      const spec = TOOLS.find((t) => t.name === tool.spec.name)!;
      expect(Object.keys(tool.inputShape).sort(), tool.spec.name).toEqual(
        Object.keys((spec.input as z.ZodObject<z.ZodRawShape>).shape).sort(),
      );
    }
  });
});
