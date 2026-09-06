/**
 * The five MCP prompts (spec section 9), declared where `TOOLS` and `RESOURCES`
 * are declared and read by `registerPrompts` the same way they are read by the
 * tool and resource registrars.
 *
 * Prompts were the one published surface with no structural declaration at all:
 * names, titles, descriptions and argument lists existed only as literals
 * inside `apps/mcp-server/src/prompts/index.ts`, so nothing could enumerate
 * them, the contract census could not see them, and a renamed prompt was
 * invisible until a client asked for one that had moved.
 *
 * The interesting field is `arguments`, and the interesting value is `null`.
 */

/** One declared argument of a prompt, as `prompts/list` advertises it. */
export interface PromptArgumentSpec {
  name: string;
  description: string;
  /** `false` registers the argument as `.optional()`. */
  required: boolean;
}

export interface PromptSpec {
  /** Registration name passed to server.registerPrompt, and the wire name. */
  name: string;
  title: string;
  description: string;
  /**
   * `null` means the prompt declares no argument list **at all** -- which is
   * not the same as declaring an empty one, and the difference is load-bearing
   * in both directions.
   *
   * On the way in, the SDK builds a Zod object from whatever shape it is given,
   * and a Zod object rejects `undefined`. So `argsSchema: {}` makes a
   * zero-argument prompt reject the spec-legal `prompts/get` that omits the
   * `arguments` member -- the natural call for a prompt that takes none.
   *
   * On the way out, `argsSchema: {}` makes `prompts/list` advertise
   * `arguments: []`, telling a client the prompt has an argument list that
   * happens to be empty rather than that it takes no arguments. A client
   * building a form from the list renders an empty form instead of a button.
   *
   * Hence `null` rather than `[]`: the registrar branches on it and omits
   * `argsSchema` entirely, and `prompts.test.ts` asserts the served surface
   * still distinguishes the two cases.
   */
  arguments: readonly PromptArgumentSpec[] | null;
}

export const PROMPTS: readonly PromptSpec[] = [
  {
    name: "design_patch",
    title: "Design a patch",
    description:
      "Design and safely build a VCV Rack patch that achieves a musical goal, grounded in the adapter pack and recipes.",
    arguments: [
      { name: "goal", description: "What the patch should do, musically.", required: true },
      {
        name: "constraints",
        description: "Optional constraints (modules to use/avoid, size, style).",
        required: false,
      },
    ],
  },
  {
    name: "troubleshoot_silence",
    title: "Troubleshoot silence",
    description: "Diagnose why a patch produces no sound (or too little), with evidence.",
    arguments: [
      {
        name: "suspectModuleId",
        description: "Optional module id to focus the investigation on.",
        required: false,
      },
    ],
  },
  {
    name: "add_effect_safely",
    title: "Add an effect safely",
    description: "Insert an effect into the signal path without breaking the existing routing.",
    arguments: [
      {
        name: "effect",
        description: "The effect to add (e.g. 'stereo delay', 'lowpass filter').",
        required: true,
      },
      {
        name: "insertAfterModuleId",
        description: "Optional module id after which to insert the effect.",
        required: false,
      },
    ],
  },
  {
    name: "explain_signal_flow",
    title: "Explain signal flow",
    description: "Explain how the current patch works, in musical terms.",
    arguments: null,
  },
  {
    name: "prepare_live_performance_patch",
    title: "Prepare a live performance patch",
    description: "Make the current patch safe and robust for live performance.",
    arguments: null,
  },
] as const;

export const PROMPT_NAMES: readonly string[] = PROMPTS.map((p) => p.name);

export function getPrompt(name: string): PromptSpec | undefined {
  return PROMPTS.find((p) => p.name === name);
}
