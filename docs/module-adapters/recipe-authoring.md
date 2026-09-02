# Authoring a recipe

A **recipe** is a high-level, model-agnostic patch template. Instead of naming
concrete modules up front, a recipe declares the functional *roles* a patch needs
(an oscillator, a filter, an audio output) plus an operation template that wires
those roles together. At use time the recipe is *resolved* against the models
actually installed in a running Rack, then *expanded* into concrete
[`PatchOperation`](../../packages/schemas/src/operations.ts)s that flow through the
normal transactional write path.

This separation is what makes a recipe portable: the same
`basic_mono_subtractive` template produces a working voice whether the user's
oscillator is `Fundamental/VCO` or an adapter-verified equivalent — and if no
compatible model is installed, the recipe reports the gap rather than silently
guessing.

Recipes live in [`packages/recipes`](../../packages/recipes). The registry and
the resolve/expand helpers are in
[`src/index.ts`](../../packages/recipes/src/index.ts); the eight built-in recipe
documents are in [`src/data.ts`](../../packages/recipes/src/data.ts); the schema
is [`Recipe`](../../packages/schemas/src/recipes.ts) in `@rackmcp/schemas`. The
compiled recipes are also surfaced read-only to MCP clients through the
`rack://recipes` resource.

## The Recipe schema

Every recipe is a single object validated by the `Recipe` Zod schema. The schema
is `strict()`, so unknown keys are rejected.

| Field | Type | Constraint |
| --- | --- | --- |
| `recipeVersion` | literal | must be `1` |
| `id` | string | `^[a-z0-9_]+$`, max 64 chars, unique in the registry |
| `name` | string | max 256 chars |
| `description` | string | max 4096 chars |
| `roles` | `RecipeRoleRequirement[]` | max 64 entries |
| `operations` | `PatchOperation[]` | max 128 entries (the template) |
| `notes` | `string[]` | each max 1024 chars, defaults to `[]` |

### Role requirements

Each entry in `roles` is a `RecipeRoleRequirement` (also `strict()`):

| Field | Type | Meaning |
| --- | --- | --- |
| `role` | string, max 64 | The role **key**, e.g. `oscillator`, `filter`, `midi_input`. This key is what the operation template references. |
| `description` | string, max 1024 | Human-readable purpose of the role, surfaced when the role is unresolved. |
| `preferred` | `{ pluginSlug, modelSlug }` | The concrete model bound to this role when it is installed. |
| `adapterVerifiedAlternatives` | `{ pluginSlug, modelSlug }[]`, max 32 | Fallbacks offered **only** when an adapter proves compatibility. Defaults to `[]`. |
| `signalRoles` | `SignalRole[]` | Signal semantics carried by the role, drawn from the `SignalRole` enum: `audio`, `cv_unipolar`, `cv_bipolar`, `pitch_voct`, `gate`, `trigger`, `clock`, `unknown`. Defaults to `[]`. |

### The operation template

`operations` is an ordinary array of `PatchOperation`s — the same union the
transaction tools consume — with one templating convention:

- **`add_module` operations** that create a role's module use the placeholder
  `pluginSlug: "$role"` and set `modelSlug` to the **role key**. For example,
  `{ op: "add_module", pluginSlug: "$role", modelSlug: "oscillator", alias: "vco", placement: "auto" }`
  means "add whatever model resolved to the `oscillator` role, and call it `vco`
  inside this transaction."
- **Every other operation** (`connect`, `set_parameter`, `set_bypass`, …) refers
  to modules by their **transaction-local alias** — the `alias` string given to
  the `add_module` that created them — via a `ModuleRef` of the form
  `{ alias: "vco" }`. These operations are copied through expansion untouched, so
  they never contain a `$role` placeholder.

Because connect and parameter operations bind to aliases rather than to concrete
models, the wiring in a recipe is written once and stays valid across every model
that can fill a role. Port ids and parameter ids in the built-in recipes are
taken from verified `inspect_model` ground truth and cross-checked against the
adapter pack by the [recipes unit test](../../packages/recipes/test/recipes.test.ts),
so a typo cannot silently ship a mis-wired template.

## Resolution: binding roles to installed models

`resolveRecipe(recipe, installed)` binds each role to a concrete model and
returns a `RecipeResolution`. The `installed` argument is the set of installed
models (each `{ pluginSlug, modelSlug }`); a client obtains it from
[`list_installed_models`](../tools/tool-reference.md).

For each role:

1. If the role's `preferred` model is installed, it is bound — the assignment is
   recorded in `assignments[roleKey]`.
2. Otherwise the role is **unresolved**. Its `adapterVerifiedAlternatives` are
   filtered down to those that are both installed **and** have a verified adapter
   (`hasAdapter(pluginSlug, modelSlug)`), and that filtered list is returned as
   `installedAlternatives`. An installed alternative with no adapter is *not*
   offered, because its port/parameter semantics are unverified.

The recipe **never substitutes an unknown module silently**. An installed
alternative surfaces only as a suggestion for a human (or client) to choose
deliberately; resolution itself will not swap it in.

`RecipeResolution` (from [`recipes.ts`](../../packages/schemas/src/recipes.ts)):

| Field | Meaning |
| --- | --- |
| `recipeId` | the recipe's `id` |
| `resolved` | `true` only when `unresolvedRoles` is empty |
| `unresolvedRoles` | `[{ role, description, installedAlternatives }]` for each gap |
| `assignments` | `roleKey -> { pluginSlug, modelSlug }` for the bound roles |

## Expansion: template to concrete operations

`expandRecipeOperations(recipe, resolution)` turns a fully-resolved recipe into a
concrete `PatchOperation[]`:

- It **throws** if `resolution.resolved` is `false`, so a partially-resolved
  recipe can never reach the mutation path.
- For each `add_module` whose `pluginSlug` is `"$role"`, it looks up
  `resolution.assignments[modelSlug]` (the role key) and replaces `pluginSlug`
  and `modelSlug` with the assigned concrete model. If a referenced role has no
  assignment it throws.
- All non-`add_module` operations pass through unchanged — their alias-based
  refs already point at the modules the substituted `add_module`s create.

The result is a plain operation list with no `$role` placeholders: exactly what
`build_patch` or `preview_patch_transaction` expects.

## Using a resolved recipe from a client

The end-to-end path an MCP client follows:

```text
rack://recipes  ─▶  list_installed_models  ─▶  resolveRecipe
                                                   │
                        resolved? ──no──▶ show unresolvedRoles + installedAlternatives, stop
                                                   │ yes
                                          expandRecipeOperations
                                                   │
                                    ┌──────────────┴───────────────┐
                                 build_patch          preview_patch_transaction
                                (convenience)                 │
                                                     commit_patch_transaction
```

1. Read the recipe (from `rack://recipes`, or `getRecipe(id)` inside the server).
2. Call `list_installed_models` to learn what is installed, and resolve.
3. If `resolved` is `false`, present the `unresolvedRoles` — each carries a
   `description` and any `installedAlternatives` — and stop. Do not fabricate a
   substitution.
4. If `resolved` is `true`, expand to operations, then either:
   - pass them to [`build_patch`](../tools/tool-reference.md), the convenience
     tool that previews and commits a construction in one call; or
   - drive the two-phase path yourself:
     [`preview_patch_transaction`](../tools/tool-reference.md) to get a normalized
     plan, risks, and a confirmation token, then
     [`commit_patch_transaction`](../tools/tool-reference.md) with that token. See
     the [execution model ADR](../architecture/ADR-0001-execution-model.md) for
     the fingerprint and confirmation-token contract.

Either path enforces the standard limits — 128 operations and 32 added modules
per transaction — which is why the recipe schema also caps `operations` at 128.

## The eight built-in recipes

The registry ships exactly these ids
([`data.ts`](../../packages/recipes/src/data.ts), asserted by the unit test):

| `id` | What it builds |
| --- | --- |
| `basic_mono_subtractive` | Canonical single-voice subtractive synth: MIDI → VCO → VCF → VCA to output, ADSR on amplitude. |
| `poly_midi_subtractive` | The subtractive voice driven by a polyphonic MIDI-to-CV interface; polyphony flows through the cables. |
| `clocked_8_step_sequence` | An LFO clocks an 8-step sequencer that pitches the oscillator and triggers the envelope. |
| `stereo_delay_send_return` | One source into two Fundamental Delay lines at different times, one per output channel, for stereo width. |
| `safe_master_output` | A master VCA at 0.7 before the audio device for headroom against clipping. |
| `lfo_filter_modulation` | A slow LFO sweeps the filter cutoff via its CV input and attenuverter. |
| `sidechain_envelope_follow` | A trigger drives an ADSR that shapes a separate signal's amplitude through a VCA. |
| `probe_silence_diagnosis` | The basic voice plus a RackMCP Probe tapping the oscillator, filter, and amplifier outputs for silence debugging. |

## A concrete example

A minimal recipe with two roles — an oscillator straight into the audio output.
The port ids used here (`VCO` saw output `2`, `AudioInterface2` inputs `0` and
`1`) are the same verified ids the built-in recipes use.

```ts
import type { Recipe } from "@rackmcp/schemas";

const toneToOutput: Recipe = {
  recipeVersion: 1,
  id: "tone_to_output",
  name: "Bare oscillator tone to output",
  description: "The smallest audible patch: one oscillator's saw output feeds both channels of the audio device.",
  roles: [
    {
      role: "oscillator",
      description: "Tone generator sent to the output.",
      preferred: { pluginSlug: "Fundamental", modelSlug: "VCO" },
      adapterVerifiedAlternatives: [],
      signalRoles: ["audio"],
    },
    {
      role: "audio_output",
      description: "Audio sink to the sound device.",
      preferred: { pluginSlug: "Core", modelSlug: "AudioInterface2" },
      adapterVerifiedAlternatives: [],
      signalRoles: ["audio"],
    },
  ],
  operations: [
    { op: "add_module", pluginSlug: "$role", modelSlug: "oscillator", alias: "vco", placement: "auto" },
    { op: "add_module", pluginSlug: "$role", modelSlug: "audio_output", alias: "audio", placement: "auto" },
    { op: "set_parameter", module: { alias: "vco" }, paramId: 1, normalized: 0.5 },
    {
      op: "connect",
      output: { module: { alias: "vco" }, portType: "output", portId: 2 },
      input: { module: { alias: "audio" }, portType: "input", portId: 0 },
      inputPolicy: "fail_if_connected",
    },
    {
      op: "connect",
      output: { module: { alias: "vco" }, portType: "output", portId: 2 },
      input: { module: { alias: "audio" }, portType: "input", portId: 1 },
      inputPolicy: "fail_if_connected",
    },
  ],
  notes: ["A bare oscillator is loud and static; add a VCA and envelope for a musical voice."],
};
```

When resolved on a Rack that has both preferred models installed, the first
`add_module` expands from the placeholder to a concrete model — the alias-based
`connect` and `set_parameter` operations are unchanged:

```json
{ "op": "add_module", "pluginSlug": "Fundamental", "modelSlug": "VCO", "alias": "vco", "placement": "auto" }
```

## Authoring checklist

- **One `add_module` per role**, using `pluginSlug: "$role"` and `modelSlug` set
  to the role key, each with a unique transaction-local `alias`.
- **Wire by alias.** `connect`, `set_parameter`, and friends reference
  `{ alias: "…" }`, never a `moduleId` (the modules don't exist yet) and never a
  `$role` placeholder.
- **Prefer normalized parameter targets** (`normalized` in `[0,1]`) over raw
  `value`, so a setting is portable across models whose raw units differ.
- **Give every preferred model a verified adapter.** The unit test asserts that
  each role's `preferred` model has an adapter and that every wired port and
  parameter exists on it — an unverified port id fails the build.
- **List alternatives, don't inline them.** If a role has interchangeable models,
  put them in `adapterVerifiedAlternatives` so resolution can surface them; never
  hard-code a second model into the operation template.
- **Keep the template within limits**: at most 128 operations and 32 added
  modules, matching the transaction caps.

See also the [tool reference](../tools/tool-reference.md) and the
[execution model ADR](../architecture/ADR-0001-execution-model.md).
