import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOLS } from "@rackmcp/schemas";
import { registerPrompts } from "../src/prompts/index.js";
import { normalizeOmittedArguments } from "../src/transport-compat.js";

/**
 * The prompt surface had no test of any kind, and every one of the five prompts
 * rejected a spec-legal `prompts/get` that omitted the optional `arguments`
 * member: the SDK parses `request.params.arguments` through a Zod object built
 * from the declared argument shape, and a Zod object rejects `undefined`. A
 * client calling a prompt that needs no arguments -- the natural call -- got
 * `-32602 Invalid input: expected object, received undefined`.
 *
 * Driven through a real Client/Server pair over an in-memory transport, so this
 * exercises the actual SDK request path (where the defect lived) rather than
 * calling the handlers directly, and still runs anywhere with no Rack.
 */

async function connected(): Promise<Client> {
  const server = new McpServer({ name: "rack-mcp-test", version: "0.1.0" });
  registerPrompts(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "prompt-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  // Wrapped after connect, exactly as index.ts does it.
  normalizeOmittedArguments(serverTransport);
  return client;
}

/** Prompts callable with no arguments: none declared, or all optional. */
const NO_ARGS_REQUIRED = [
  "explain_signal_flow",
  "prepare_live_performance_patch",
  "troubleshoot_silence",
];

describe("prompt registry", () => {
  it("advertises all five prompts with a title and description", async () => {
    const { prompts } = await (await connected()).listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      "add_effect_safely",
      "design_patch",
      "explain_signal_flow",
      "prepare_live_performance_patch",
      "troubleshoot_silence",
    ]);
    for (const p of prompts) {
      expect(p.description, p.name).toBeTruthy();
      expect(p.title, p.name).toBeTruthy();
    }
  });

  it("advertises no argument list for the prompts that take none", async () => {
    // The transport shim alone would make these callable, so without this the
    // source half of the fix -- dropping `argsSchema: {}` from the two
    // zero-argument prompts -- is unverified and can be reverted with the suite
    // still green. `argsSchema: {}` builds a Zod object that rejects
    // `undefined`, AND makes prompts/list advertise an empty `arguments: []`,
    // which tells a client the prompt has an argument list that happens to be
    // empty rather than that it takes none.
    const { prompts } = await (await connected()).listPrompts();
    for (const name of ["explain_signal_flow", "prepare_live_performance_patch"]) {
      const p = prompts.find((x) => x.name === name)!;
      expect(p, name).toBeDefined();
      expect(p.arguments, `${name} must declare no argument list at all`).toBeUndefined();
    }
  });

  it("still advertises the optional argument on troubleshoot_silence", async () => {
    // The fix must not buy callability by dropping discoverability.
    const { prompts } = await (await connected()).listPrompts();
    const p = prompts.find((x) => x.name === "troubleshoot_silence")!;
    expect(p.arguments?.map((a) => a.name)).toEqual(["suspectModuleId"]);
    expect(p.arguments?.[0]!.required).toBeFalsy();
  });
});

describe("prompts/get with the arguments member omitted", () => {
  it.each(NO_ARGS_REQUIRED)("%s is callable with no arguments at all", async (name) => {
    const client = await connected();
    const res = await client.getPrompt({ name });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]!.role).toBe("user");
    const text = (res.messages[0]!.content as { text: string }).text;
    expect(text.length).toBeGreaterThan(200);
  });

  it("reports the missing argument by name when one is genuinely required", async () => {
    // Failing is right here; complaining about the container is not. The old
    // error said "expected object, received undefined", which named neither the
    // prompt's requirement nor anything the caller could act on.
    const client = await connected();
    await expect(client.getPrompt({ name: "design_patch" })).rejects.toThrow(/goal/);
  });
});

describe("prompt content", () => {
  it("carries the Rackwright identity into every prompt", async () => {
    const client = await connected();
    for (const name of NO_ARGS_REQUIRED) {
      const res = await client.getPrompt({ name });
      const text = (res.messages[0]!.content as { text: string }).text;
      // The identity is read from rackwright.md at import time; if packaging
      // ever drops the asset this fails here rather than serving a prompt with
      // no behavioural grounding.
      expect(text, name).toContain("Rackwright");
      expect(text, name).toContain("# Task");
    }
  });

  it("names only tools that actually exist", async () => {
    // A prompt that tells a model to call a renamed tool sends it somewhere
    // there is nothing to call.
    const client = await connected();
    const names = new Set(TOOLS.map((t) => t.name));
    const res = await client.getPrompt({ name: "troubleshoot_silence" });
    const text = (res.messages[0]!.content as { text: string }).text;
    const referenced = [...new Set(text.match(/\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/g) ?? [])].filter(
      (w) => /^(get|list|set|preview|commit|create|save|load|restore|attach|detach|read|build|validate|describe|inspect|undo|select|acquire|release|clear)_/.test(w),
    );
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((w) => !names.has(w))).toEqual([]);
  });

  it("passes an optional argument through into the message", async () => {
    const client = await connected();
    const res = await client.getPrompt({
      name: "troubleshoot_silence",
      arguments: { suspectModuleId: "4360803558046751" },
    });
    expect((res.messages[0]!.content as { text: string }).text).toContain("4360803558046751");
  });
});
