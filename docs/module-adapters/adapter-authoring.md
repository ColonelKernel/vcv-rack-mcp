# Authoring a ModuleAdapter

A **ModuleAdapter** is a small, versioned document that records the *verified*
semantics of one Rack model: what each parameter means, what each port carries,
how the module behaves polyphonically, and how it is normally wired. Rack MCP
ships **22 adapters** today (`ADAPTER_COUNT`), covering the Core, Fundamental,
and RackMCP models that its recipes and analysis lean on.

This guide explains what an adapter is for, the schema fields you fill in, the
authoring workflow, and how the unit test keeps every adapter honest against
captured ground truth.

## Why adapters exist

Rack exposes parameters and ports as bare integer indices with human-facing
names. Nothing in the patch tells an MCP client that VCF port `0` is a 1V/oct
pitch input rather than audio, or that turning a "Level" knob past `1` clips the
interface. Adapters supply that missing layer of **verified per-model
semantics**, and the rest of the server depends on them in three ways:

- **Musical interpretation.** [`describe_patch`](../tools/tool-reference.md) and the
  design [prompts](../tools/tool-reference.md) use signal roles and connection
  recipes to reason about a patch as a signal chain, not just a graph of ids.
- **Heuristic fallback for unknown modules.** A module with no adapter is still
  fully usable — you can add it, cable it, and set its parameters — but its
  semantics are reported with confidence `"heuristic"` instead of verified.
  Adapters are the *only* way to promote a model out of guesswork.
- **Opaque state safety.** Rack MCP never mutates a module's opaque internal
  state (context-menu options, custom serialized data) unless a matching adapter
  declares the exact field. There is deliberately **no `set_module_data` tool**;
  `opaqueStateFields` is the sole channel for verified opaque state, and it stays
  empty unless a value has actually been confirmed.

Because so much rides on them, adapters are treated as data that must be proven,
not asserted. Every document is validated against a Zod schema at load, and every
id is cross-checked against captured `inspect_model` output by the test suite.

## The ModuleAdapter schema

The schema lives in
[`packages/schemas/src/adapters.ts`](../../packages/schemas/src/adapters.ts) and
is `.strict()` — unknown fields are rejected.

### Top-level fields

| Field | Type | Notes |
| --- | --- | --- |
| `adapterVersion` | literal `1` | Adapter document schema version. |
| `pluginSlug` | string (1–255) | Plugin slug, e.g. `"Fundamental"`. |
| `modelSlug` | string (1–255) | Model slug, e.g. `"VCA-1"`. `(pluginSlug, modelSlug)` must be unique across the registry. |
| `pluginVersionRange` | string (≤128) | Semver range the semantics were verified against, e.g. `">=2.6.0 <3.0.0"`. |
| `displayName` | string (≤256) | Human name shown to clients, e.g. `"VCA"`. |
| `summary` | string (≤2048) | What the module does and its role in a patch. |
| `params` | `AdapterParamSemantics[]` (≤1024) | One entry per documented parameter. |
| `inputs` | `AdapterPortSemantics[]` (≤256) | One entry per input port. |
| `outputs` | `AdapterPortSemantics[]` (≤256) | One entry per output port. |
| `polyphony` | `PolyphonyBehavior` | `monophonic` \| `polyphonic` \| `poly_from_input` \| `unknown` (default `unknown`). |
| `opaqueStateFields` | array (≤64) | Verified context-menu / opaque-state fields; default `[]`. |
| `validationRules` | `string[]` (each ≤128) | Named rules validation applies; default `[]`. |
| `connectionRecipes` | `AdapterConnectionRecipe[]` (≤64) | Suggested wirings from this module's outputs; default `[]`. |
| `provenance` | `string[]` (each ≤1024) | **At least one** entry recording where the semantics were verified. |

### Params — `AdapterParamSemantics`

| Field | Type | Notes |
| --- | --- | --- |
| `paramId` | integer 0–65535 | Must match a real parameter index. |
| `role` | string (≤64) | Stable semantic key, e.g. `"frequency"`, `"cutoff"`, `"level"`. Roles **may repeat** across params (per-channel/per-step roles). |
| `description` | string (≤1024), optional | |
| `safeInitial` | number, optional | Value to use when initializing a fresh patch. Must lie inside the parameter's real `[minValue, maxValue]` and inside its own `safeRange`. |
| `safeRange` | `[number, number]`, optional | Values outside are flagged by validation. Must be ordered `lo <= hi` and contained in the real `[minValue, maxValue]`. |

#### Switch positions must be named with their default

`packages/adapters/test/adapters.test.ts` cross-checks these against captured
`inspect_model` ground truth, so all three bounds above are enforced, not
advisory.

One more rule is enforced there, against a second fixture:
`tests/fixtures/adapters/switch-positions.json`. `model-metadata.json` inspects
a *freshly instantiated* module, so it only ever records what the **default**
position displays as — it says Fundamental LFO paramId 0 `Offset` shows
`Unipolar`, and nothing about position 0. The switch fixture walks every snapped
two-position parameter through **both** positions in a live Rack and records
what Rack renders for each:

```bash
pnpm --filter @rackmcp/integration run capture:switches   # rewrite the fixture
pnpm --filter @rackmcp/integration run verify:switches    # check it still holds
```

For a switch that names at least one position, the `description` must contain a
clause per named position and one for the default:

```
<value> = "<displayValue>"        for each named position
default is <defaultValue>
```

for example:

```
"Offset toggle. Snapped two-position switch: 0 = \"Bipolar\", waveform outputs
 swing approx. +/-5 V; 1 = \"Unipolar\", approx. 0..10 V. Ground-truth default
 is 1, so a freshly added LFO modulates positive-only unless this is switched
 to 0."
```

The rest of the description stays free prose; those clauses are the part a test
can check. Switches Rack names nothing for (a momentary push button, a mute
toggle) are exempt from the clause — there is no name to get backwards — but
they are still captured, because proving a switch is unnamed takes the same
measurement as reading its name.

And on a model that has any named switch, the words **“by default”** and
**“(default)”** are rejected everywhere in the adapter — summary, port
descriptions, connection recipes, and the params table alike. State the default
in the clause above, where the measured fixture checks it; everywhere else,
point at the controlling parameter instead:

```
"Sine waveform output. Unipolar (approx. 0..10 V) at the default Offset
 position (paramId 0 = 1, \"Unipolar\"); set Offset to 0 for bipolar approx.
 +/-5 V."
```

That rule is not decoration. The original LFO defect was not in a param
description at all — it was in the four `outputs[].description` texts and in the
module `summary`, which no clause rule reads:

```
"Sine waveform output. Bipolar modulation signal by default (approx. +/-5 V);
 the Offset switch can shift it unipolar."     <- wrong, and outside the clause
```

RackMCP's own modules are exempt from the capture, and therefore from the
coverage requirement: `Bridge` paramId 0 is “Reset pairing secret”, and the
capture talks to Rack over that very bridge.

This exists because three adapters shipped descriptions asserting the *opposite*
default: the LFO's outputs were called bipolar "by default" against a
ground-truth `Unipolar`, VCA-1's response curve "exponential (default)" against
`Linear`, and the Scope's trigger "on by default" against `Disabled`. Every
id-and-count test passed the whole time. Merely mentioning the position name is
not sufficient — the wrong descriptions mentioned it too, as the value the
switch is *not* set to.

Sibling modules are not a safe guide either, which is why this is measured
rather than reasoned about: Fundamental VCO's `Sync mode` is `Soft`/`Hard` for
0/1, and the Wavetable VCO's (modelSlug `VCO2`) `Sync` is `Hard`/`Soft` for the
same values.

### Ports — `AdapterPortSemantics` (both `inputs` and `outputs`)

| Field | Type | Notes |
| --- | --- | --- |
| `portId` | integer 0–65535 | Must match a real port index. |
| `role` | `SignalRole` | One of `audio`, `cv_unipolar`, `cv_bipolar`, `pitch_voct`, `gate`, `trigger`, `clock`, `unknown`. |
| `key` | string (≤64) | Stable, addressable semantic key, e.g. `"pitch_in"`, `"audio_out_l"`. **Unique within the input set and within the output set.** |
| `description` | string (≤1024), optional | |
| `polyphony` | `PolyphonyBehavior` | Per-port behavior; default `unknown`. |

### Connection recipes — `AdapterConnectionRecipe`

Each recipe suggests wiring one of *this* module's outputs into another module's
semantic input role: `name` (≤128), `description` (≤2048), `fromOutputKey`
(≤64 — must be an `outputs[].key` this module actually exposes), and `toRole`
(a `SignalRole`).

### Opaque state fields

Each entry is `{ key (≤128), type: "boolean" | "integer" | "number" | "string",
description (≤1024) }`. Leave `opaqueStateFields` as `[]` unless a field has been
verified — this is the boundary that keeps opaque module state untouched.

## A concrete example

Here is the committed adapter for Fundamental's single-channel VCA, `VCA-1`
(from [`packages/adapters/src/data.ts`](../../packages/adapters/src/data.ts);
descriptions trimmed here for brevity). Two params, two inputs, one output — a
compact but complete adapter.

```json
{
  "adapterVersion": 1,
  "pluginSlug": "Fundamental",
  "modelSlug": "VCA-1",
  "pluginVersionRange": ">=2.6.0 <3.0.0",
  "displayName": "VCA",
  "summary": "A single-channel voltage-controlled amplifier that scales its input by the Level knob multiplied by the CV input. In a subtractive voice it is the dynamics stage.",
  "params": [
    { "paramId": 0, "role": "level", "safeInitial": 1,
      "description": "Manual gain/attenuation; scales the CV input's effect. 1 passes unity gain, 0 fully mutes." },
    { "paramId": 1, "role": "response_mode", "safeInitial": 1,
      "description": "Amplitude response curve. Snapped two-position switch: 0 = \"Exponential\", a natural, perceptually smooth taper; 1 = \"Linear\", direct proportional gain. Ground-truth default is 1, so set this to 0 if an envelope should taper exponentially." }
  ],
  "inputs": [
    { "portId": 0, "role": "cv_unipolar", "key": "gain_cv", "polyphony": "poly_from_input",
      "description": "Gain control voltage (unipolar 0-10V), typically an envelope or LFO." },
    { "portId": 1, "role": "audio", "key": "audio_in", "polyphony": "poly_from_input",
      "description": "Signal/audio input to be amplified or attenuated." }
  ],
  "outputs": [
    { "portId": 0, "role": "audio", "key": "audio_out", "polyphony": "poly_from_input",
      "description": "Amplitude-scaled output after the Level knob and gain CV are applied." }
  ],
  "polyphony": "poly_from_input",
  "opaqueStateFields": [],
  "validationRules": [],
  "connectionRecipes": [
    { "name": "VCA to output or mixer",
      "description": "Send the amplitude-shaped signal to an audio output, mixer channel, or the next voice stage.",
      "fromOutputKey": "audio_out", "toRole": "audio" }
  ],
  "provenance": [
    "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; port and parameter ids/names verified",
    "Semantics derived from Fundamental VCA-1 param/port names (Level, Response mode, CV, Channel) and documented behavior",
    "Adversarial verification against ground truth: paramIds (0,1), input portIds (0,1), output portId (0) confirmed present"
  ]
}
```

## Authoring workflow

### 1. Capture ground truth from the live module

Never hand-type ids. Read them from a running Rack via the read-only inspection
tools — [`list_installed_models`](../tools/tool-reference.md) then
[`inspect_model`](../tools/tool-reference.md) — which return the real
`paramId`/`portId` indices and names for a `(pluginSlug, modelSlug)` pair.

The dev utility
[`tests/integration/src/dump-metadata.ts`](../../tests/integration/src/dump-metadata.ts)
automates this against a live Rack 2.6.6: it launches the harness, enumerates all
`Core`/`Fundamental`/`RackMCP` models (following pagination), calls `inspect_model`
for each, and writes a `model-metadata.json` record with `params`, `inputs`, and
`outputs`.

```bash
cd tests/integration
pnpm exec tsx src/dump-metadata.ts          # writes ./model-metadata.json
RACKMCP_METADATA_OUT=/abs/out.json pnpm exec tsx src/dump-metadata.ts
```

Fold the new model's record into the committed ground-truth fixture,
[`packages/adapters/test/fixtures/model-metadata.json`](../../packages/adapters/test/fixtures/model-metadata.json).
That fixture is the test's source of truth, so it and your adapter must agree.

### 2. Fill in the adapter document

Add your document to the `ADAPTER_DOCS` array in
[`packages/adapters/src/data.ts`](../../packages/adapters/src/data.ts). Fill
`paramId`/`portId` from the captured metadata, assign stable `role`s and port
`key`s, write descriptions, and record **at least one** `provenance` entry naming
how you verified the semantics. Only claim `safeRange`, `opaqueStateFields`, or
non-obvious roles you can actually justify — when unsure, omit rather than guess.

### 3. Let the registry validate at load

[`packages/adapters/src/index.ts`](../../packages/adapters/src/index.ts) parses
every entry with `ModuleAdapter.safeParse` when the module is imported and throws
on the first malformed document, so a bad adapter fails fast instead of silently
degrading interpretation:

```ts
const ADAPTERS: ReadonlyArray<ModuleAdapter> = ADAPTER_DOCS.map((doc, i) => {
  const parsed = ModuleAdapter.safeParse(doc);
  if (!parsed.success) {
    throw new Error(`Invalid module adapter at index ${i}: ...`);
  }
  return parsed.data;
});
```

It also builds a `(pluginSlug, modelSlug)` map and throws on any duplicate key.
Accessors then expose the pack: `listAdapters()`, `ADAPTER_COUNT`, `getAdapter`,
`hasAdapter`, `inputRole`, `outputRole`, and `paramSemantics`.

## How the unit test cross-checks your adapter

[`packages/adapters/test/adapters.test.ts`](../../packages/adapters/test/adapters.test.ts)
loads the committed ground-truth fixture and, for **every** registered adapter,
verifies it against reality:

- **Counts match exactly.** `inputs.length`, `outputs.length`, and `params.length`
  must equal the fixture's counts for that model — adapters describe the whole
  wiring surface, no more and no less.
- **Every id is real.** Each `paramId`, input `portId`, and output `portId` must
  exist in the fixture's id sets for that model.
- **No duplicate ids** within the param, input, or output set.
- **Port keys are unique** within `inputs` and within `outputs` (param `role`s may
  repeat and are not required to be unique).
- **Recipes resolve.** Every `connectionRecipes[].fromOutputKey` must name an
  actual output key on the module.
- **`safeRange` is ordered** — `safeRange[0] <= safeRange[1]`.

Separate cases assert the registry has no duplicate `(pluginSlug, modelSlug)`
keys, that a fixed set of models is present (Core `AudioInterface`,
`AudioInterface2`, `MIDIToCVInterface`; Fundamental `VCO`, `VCF`, `VCA`, `VCA-1`,
`ADSR`, `LFO`; RackMCP `Bridge`, `Probe`), and that accessors resolve roles
correctly (for example, `outputRole("Core", "MIDIToCVInterface", 0)` is
`pitch_voct`).

Run the suite before committing:

```bash
pnpm --filter @rackmcp/adapters test
```

If you added a model whose ground truth is not in the fixture, the
"present in ground-truth fixture" assertion fails — regenerate and commit the
fixture (step 1) so the adapter and captured metadata stay in lockstep.

## Related documents

- [Tool reference](../tools/tool-reference.md) — `inspect_model`,
  `list_installed_models`, `describe_patch`, and the full tool set.
- [Execution model (ADR-0001)](../architecture/ADR-0001-execution-model.md) — how
  the server and plugin cooperate to apply changes safely.
