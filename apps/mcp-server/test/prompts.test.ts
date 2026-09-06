import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PROMPTS, TOOLS } from "@rackmcp/schemas";
import { BODIES, registerPrompts } from "../src/prompts/index.js";
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

describe("the served surface against the PROMPTS registry", () => {
  /**
   * `registerPrompts` builds its registrations from `PROMPTS`, so these bind
   * the declaration to what a client is actually handed. Without them the
   * registry is decoration: a title corrected in one place and not the other
   * would go unnoticed, which is exactly the drift the registry exists to make
   * impossible.
   */
  it("registers every declared prompt, and only those", async () => {
    // This guards the registration loop, not the strings: it reds if the loop
    // ever skips an entry. Asserting the served title equals `spec.title` would
    // NOT red for a bad title -- the registrar passes it straight through, so
    // both sides move together. That check was written, confirmed vacuous by
    // changing a title and watching the suite stay green, and removed. What
    // guards the names themselves is the independent hardcoded list in
    // "advertises all five prompts", which has to be edited by hand.
    const { prompts } = await (await connected()).listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(PROMPTS.map((p) => p.name).sort());
  });

  it("declares a usable title, description and argument list for each prompt", async () => {
    // Invariants of the registry itself, which a registry-only edit can break
    // and a lockstep comparison never would.
    const seen = new Set<string>();
    for (const spec of PROMPTS) {
      expect(seen.has(spec.name), `duplicate prompt name ${spec.name}`).toBe(false);
      seen.add(spec.name);
      expect(spec.title.trim(), spec.name).not.toBe("");
      expect(spec.description.trim().length, spec.name).toBeGreaterThan(20);
      const argNames = new Set<string>();
      for (const a of spec.arguments ?? []) {
        expect(argNames.has(a.name), `${spec.name}: duplicate argument ${a.name}`).toBe(false);
        argNames.add(a.name);
        expect(a.description.trim(), `${spec.name}.${a.name}`).not.toBe("");
      }
    }
  });

  it("serves each declared argument, and no list at all where none is declared", async () => {
    // The `null` vs `[]` distinction in PromptSpec.arguments is the whole
    // reason the field is not just an array. Asserting it here is what keeps
    // someone from "simplifying" it back to an empty array, which would make
    // both zero-argument prompts uncallable by a spec-legal client.
    const { prompts } = await (await connected()).listPrompts();
    for (const spec of PROMPTS) {
      const served = prompts.find((p) => p.name === spec.name)!;
      if (spec.arguments === null) {
        expect(served.arguments, `${spec.name} must declare no argument list`).toBeUndefined();
        continue;
      }
      expect(served.arguments?.map((a) => a.name), spec.name).toEqual(
        spec.arguments.map((a) => a.name),
      );
      for (const arg of spec.arguments) {
        const servedArg = served.arguments!.find((a) => a.name === arg.name)!;
        expect(Boolean(servedArg.required), `${spec.name}.${arg.name}`).toBe(arg.required);
        expect(servedArg.description, `${spec.name}.${arg.name}`).toBe(arg.description);
      }
    }
  });

  it("never declares an empty argument list", () => {
    // Not lockstep, deliberately. Every other assertion here compares the
    // registry against what is served, so changing `null` to `[]` would change
    // both sides together and pass -- while making the prompt uncallable by a
    // client that omits the `arguments` member. `[]` has to be illegal at the
    // declaration or nothing catches it.
    for (const spec of PROMPTS) {
      expect(
        spec.arguments,
        `${spec.name}: declare null, not [], for a prompt that takes no arguments`,
      ).not.toEqual([]);
    }
  });

  it("has no body without a declaration, and no declaration without a body", async () => {
    // Registration already throws for a declared prompt with no body; this is
    // the other direction, where the prose is simply never reachable.
    expect(Object.keys(BODIES).sort()).toEqual(PROMPTS.map((p) => p.name).sort());
  });

  it("names only tools that exist, in every prompt", async () => {
    // The pre-existing version of this checked troubleshoot_silence alone.
    // Driving it from the registry means a prompt added later is covered the
    // day it is added rather than the day someone remembers.
    const client = await connected();
    const names = new Set(TOOLS.map((t) => t.name));
    for (const spec of PROMPTS) {
      const args = Object.fromEntries(
        (spec.arguments ?? []).filter((a) => a.required).map((a) => [a.name, "x"]),
      );
      const res = await client.getPrompt({ name: spec.name, arguments: args });
      const text = (res.messages[0]!.content as { text: string }).text;
      const referenced = [...new Set(text.match(/\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/g) ?? [])].filter(
        (w) =>
          /^(get|list|set|preview|commit|create|save|load|restore|attach|detach|read|build|validate|describe|inspect|undo|select|acquire|release|clear)_/.test(
            w,
          ),
      );
      expect(referenced.filter((w) => !names.has(w)), spec.name).toEqual([]);
    }
  });
});
