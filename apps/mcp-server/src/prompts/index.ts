import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROMPTS, type PromptArgumentSpec } from "@rackmcp/schemas";

/**
 * MCP prompts (spec section 9), grounded in the Rackwright identity. Each prompt
 * returns a single user message that combines the Rackwright behavioral
 * foundation with a task framing. The identity is the canonical rackwright.md,
 * copied next to this module at build time (see copy-assets.mjs).
 */

const RACKWRIGHT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "rackwright.md"),
  "utf8",
).trim();

/** The words each prompt frames its task with. Keyed by PromptSpec.name. */
type PromptBody = (args: Record<string, string | undefined>) => string;

function shapeOf(args: readonly PromptArgumentSpec[]): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const a of args) {
    // .describe() must come LAST. Applied before .optional() it lands on the
    // inner ZodString, and the SDK reads the description off the outer
    // ZodOptional -- so prompts/list advertises the argument with no
    // description at all, silently, for every optional argument.
    const base = z.string();
    shape[a.name] = a.required ? base.describe(a.description) : base.optional().describe(a.description);
  }
  return shape;
}

function userMessage(task: string) {
  return {
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: `${RACKWRIGHT}\n\n# Task\n\n${task}` },
      },
    ],
  };
}

export const BODIES: Record<string, PromptBody> = {
  design_patch: (a) =>
    [
      `Design and build a patch that achieves this goal: ${a.goal}.`,
      a.constraints ? `Constraints: ${a.constraints}.` : "",
      "Start by inspecting the selected instance and current patch. Propose a plan and preview it with preview_patch_transaction (or build_patch), grounded in the adapter pack and the recipe library. Prefer a matching recipe and report any unresolved functional roles instead of substituting unknown modules. Show the plan and its risk summary, then commit only after confirmation. Acquire the writer lease before mutating and release it when done.",
    ]
      .filter(Boolean)
      .join(" "),

  troubleshoot_silence: (a) =>
    [
      "The patch is producing no sound, or much less than expected. Diagnose the cause with evidence.",
      "Trace from the Core Audio destination back toward the sources. Check for bypassed modules, disconnected or missing cables, a fully closed filter cutoff, a VCA at zero level, or an envelope that never opens. Use validate_patch and describe_patch first.",
      a.suspectModuleId ? `Focus especially on module ${a.suspectModuleId}.` : "",
      "Attach a Probe to the suspect signal and read it (peak, RMS, DC, clipped/non-finite counts) to confirm where the signal dies. Telemetry needs a running engine — if engineFrame is not advancing, say the engine is idle and reason from the graph instead. Report the root cause and the smallest fix.",
    ]
      .filter(Boolean)
      .join(" "),

  add_effect_safely: (a) =>
    [
      `Add this effect to the patch without breaking the existing signal path: ${a.effect}.`,
      a.insertAfterModuleId
        ? `Insert it immediately after module ${a.insertAfterModuleId}.`
        : "Identify the right place in the chain from the current routing.",
      "Preview the insertion: add the effect module, reroute the affected cables through it, and keep a sensible dry/master path. Classify the risk (this reroutes audio), show the plan, and confirm before committing. Use adapter-verified port roles so audio meets audio and CV meets CV.",
    ].join(" "),

  explain_signal_flow: () =>
    "Explain how the current patch works, in musical terms. Use describe_patch and the adapter pack to name each module's role and each cable's signal type (pitch/1V-oct, gate, trigger, clock, audio, unipolar/bipolar CV). Trace the signal from its sources to the audio output, and call out anything notable: bypassed modules, disconnected cables, stacked inputs, or feedback paths. Distinguish certain, adapter, and heuristic claims; do not overclaim third-party module semantics.",

  prepare_live_performance_patch: () =>
    "Prepare the current patch for live performance. First create a recovery checkpoint. Run validate_patch and resolve any errors, explaining each. Ensure a RackMCP-Bridge module is present so control survives a Rack restart, disclosing if one must be added. Inspect the master output chain for safe headroom — attach a Probe to the signal feeding the Audio module and confirm it is not clipping (peak below ~10V) when the engine is running. Summarize every change you made and what to keep an eye on during the set. Acquire the writer lease for changes and release it when finished.",
};

export function registerPrompts(server: McpServer): void {
  for (const spec of PROMPTS) {
    const body = BODIES[spec.name];
    // Refusing to start beats serving a prompt with no task in it: a prompt
    // added to the registry and forgotten here would otherwise answer with the
    // identity and an empty task section, which reads like a working prompt.
    if (!body) throw new Error(`prompt "${spec.name}" is declared but has no body`);
    const { title, description } = spec;

    // The two registration shapes are kept apart deliberately. Passing
    // `argsSchema` at all -- even `{}` -- changes both what prompts/list
    // advertises and whether a call omitting `arguments` is accepted; see
    // PromptSpec.arguments. The SDK also overloads the callback on this: with
    // no argsSchema the first parameter is the request extra, not the args.
    if (spec.arguments) {
      server.registerPrompt(
        spec.name,
        { title, description, argsSchema: shapeOf(spec.arguments) },
        (args) => userMessage(body(args as Record<string, string | undefined>)),
      );
    } else {
      server.registerPrompt(spec.name, { title, description }, () => userMessage(body({})));
    }
  }
}
