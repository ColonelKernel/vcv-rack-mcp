import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "design_patch",
    {
      title: "Design a patch",
      description:
        "Design and safely build a VCV Rack patch that achieves a musical goal, grounded in the adapter pack and recipes.",
      argsSchema: {
        goal: z.string().describe("What the patch should do, musically."),
        constraints: z
          .string()
          .optional()
          .describe("Optional constraints (modules to use/avoid, size, style)."),
      },
    },
    (args) =>
      userMessage(
        [
          `Design and build a patch that achieves this goal: ${args.goal}.`,
          args.constraints ? `Constraints: ${args.constraints}.` : "",
          "Start by inspecting the selected instance and current patch. Propose a plan and preview it with preview_patch_transaction (or build_patch), grounded in the adapter pack and the recipe library. Prefer a matching recipe and report any unresolved functional roles instead of substituting unknown modules. Show the plan and its risk summary, then commit only after confirmation. Acquire the writer lease before mutating and release it when done.",
        ]
          .filter(Boolean)
          .join(" "),
      ),
  );

  server.registerPrompt(
    "troubleshoot_silence",
    {
      title: "Troubleshoot silence",
      description: "Diagnose why a patch produces no sound (or too little), with evidence.",
      argsSchema: {
        suspectModuleId: z
          .string()
          .optional()
          .describe("Optional module id to focus the investigation on."),
      },
    },
    (args) =>
      userMessage(
        [
          "The patch is producing no sound, or much less than expected. Diagnose the cause with evidence.",
          "Trace from the Core Audio destination back toward the sources. Check for bypassed modules, disconnected or missing cables, a fully closed filter cutoff, a VCA at zero level, or an envelope that never opens. Use validate_patch and describe_patch first.",
          args.suspectModuleId ? `Focus especially on module ${args.suspectModuleId}.` : "",
          "Attach a Probe to the suspect signal and read it (peak, RMS, DC, clipped/non-finite counts) to confirm where the signal dies. Telemetry needs a running engine — if engineFrame is not advancing, say the engine is idle and reason from the graph instead. Report the root cause and the smallest fix.",
        ]
          .filter(Boolean)
          .join(" "),
      ),
  );

  server.registerPrompt(
    "add_effect_safely",
    {
      title: "Add an effect safely",
      description: "Insert an effect into the signal path without breaking the existing routing.",
      argsSchema: {
        effect: z.string().describe("The effect to add (e.g. 'stereo delay', 'lowpass filter')."),
        insertAfterModuleId: z
          .string()
          .optional()
          .describe("Optional module id after which to insert the effect."),
      },
    },
    (args) =>
      userMessage(
        [
          `Add this effect to the patch without breaking the existing signal path: ${args.effect}.`,
          args.insertAfterModuleId
            ? `Insert it immediately after module ${args.insertAfterModuleId}.`
            : "Identify the right place in the chain from the current routing.",
          "Preview the insertion: add the effect module, reroute the affected cables through it, and keep a sensible dry/master path. Classify the risk (this reroutes audio), show the plan, and confirm before committing. Use adapter-verified port roles so audio meets audio and CV meets CV.",
        ].join(" "),
      ),
  );

  server.registerPrompt(
    "explain_signal_flow",
    {
      title: "Explain signal flow",
      description: "Explain how the current patch works, in musical terms.",
      argsSchema: {},
    },
    () =>
      userMessage(
        "Explain how the current patch works, in musical terms. Use describe_patch and the adapter pack to name each module's role and each cable's signal type (pitch/1V-oct, gate, trigger, clock, audio, unipolar/bipolar CV). Trace the signal from its sources to the audio output, and call out anything notable: bypassed modules, disconnected cables, stacked inputs, or feedback paths. Distinguish certain, adapter, and heuristic claims; do not overclaim third-party module semantics.",
      ),
  );

  server.registerPrompt(
    "prepare_live_performance_patch",
    {
      title: "Prepare a live performance patch",
      description: "Make the current patch safe and robust for live performance.",
      argsSchema: {},
    },
    () =>
      userMessage(
        "Prepare the current patch for live performance. First create a recovery checkpoint. Run validate_patch and resolve any errors, explaining each. Ensure a RackMCP-Bridge module is present so control survives a Rack restart, disclosing if one must be added. Inspect the master output chain for safe headroom — attach a Probe to the signal feeding the Audio module and confirm it is not clipping (peak below ~10V) when the engine is running. Summarize every change you made and what to keep an eye on during the set. Acquire the writer lease for changes and release it when finished.",
      ),
  );
}
