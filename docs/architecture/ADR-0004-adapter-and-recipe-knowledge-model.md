# ADR-0004: The versioned adapter pack and recipe library

- Status: Accepted
- Date: 2026-08-31
- Deciders: Rack MCP project

## Context

An MCP client asked to "build a subtractive synth" or "explain this patch" needs
musical semantics that Rack does not expose: which output port is a pitch (V/Oct)
signal, which parameter is a filter cutoff and what a safe value for it is, and
which modules can stand in for one another. Rack's engine exposes port and
parameter *indices* and display strings, but not stable semantic meaning, and it
exposes plenty of **opaque module state** (context-menu options, internal
buffers) that has no safe, model-independent interpretation.

The risk is a plausible-sounding but wrong interpretation: treating an arbitrary
CV output as a pitch, driving a parameter past a safe range, mutating an opaque
field on a module whose format we have not verified, or silently swapping in a
"similar" module that behaves differently. Any of these can produce a broken or
even speaker-damaging patch while looking confident.

This record specifies the knowledge layer that bounds that risk: a versioned
**adapter pack** carrying verified per-model semantics, and a **recipe library**
that assembles known-good patches from functional roles. The schemas live in
`packages/schemas/src/adapters.ts` and `packages/schemas/src/recipes.ts`; the
registries and resolution logic live in `packages/adapters/src/index.ts` and
`packages/recipes/src/index.ts`.

## Decision

### Adapters carry verified, versioned per-model semantics

A `ModuleAdapter` (schema in `adapters.ts`) is a document keyed by
`(pluginSlug, modelSlug)` and pinned to a `pluginVersionRange` it has been
verified against. It records:

- **Port semantics** (`inputs` / `outputs`): each port's `SignalRole` — one of
  `audio`, `cv_unipolar`, `cv_bipolar`, `pitch_voct`, `gate`, `trigger`,
  `clock`, `unknown` — a stable `key` (e.g. `pitch_in`, `audio_out_l`), and its
  `polyphony` behavior.
- **Parameter semantics** (`params`): a semantic `role` (e.g. `frequency`,
  `cutoff`, `attack`), an optional `safeInitial` value for fresh patches, and an
  optional `safeRange` in raw units that validation uses to flag out-of-range
  settings.
- **Opaque state** (`opaqueStateFields`): only the context-menu / opaque-state
  fields that have actually been verified, each with a `key`, a scalar `type`,
  and a description. This array is **empty unless verified**.
- **Provenance** (`provenance`, `min(1)`): where the semantics were confirmed
  (manual verification, source inspection, etc.). An adapter with no provenance
  fails schema validation.

The registry (`packages/adapters/src/index.ts`) validates every document against
the `ModuleAdapter` schema at load with `safeParse` and **throws on the first
invalid or duplicate `(pluginSlug, modelSlug)`** — a malformed adapter fails the
build rather than silently degrading an interpretation. The pack currently
covers 22 Core / Fundamental / RackMCP models. Lookups are exact:
`getAdapter`, `hasAdapter`, `inputRole`, `outputRole`, and `paramSemantics` all
key on the concrete model.

### Unknown modules are heuristic, never guessed into certainty

A module with no adapter is simply **absent** from the registry. It stays fully
usable — it can be added, cabled, and have its (public) parameters set — but any
semantic claim about it is marked with confidence `heuristic` rather than
presented as verified. The knowledge layer never fabricates a `SignalRole` or a
safe range for a model it has not verified.

### Opaque module state is never mutated without an adapter

This is the load-bearing safety rule, and it is enforced structurally: there is
deliberately **no `set_module_data` tool**, and no operation in `OPERATION_TYPES`
writes opaque state. The rule holds because there is nothing to call, not because
a check might catch it.

Adapters previously published an `opaqueStateFields` array, empty in all of them,
which read as the gate that decides whether a write is allowed. That was
misleading in the more dangerous direction: it implied a mechanism existed and
was simply unpopulated, when in fact no write path exists at all. The field is
gone. `OPAQUE_STATE_UNSUPPORTED` stays in `ERROR_CODES` — see the census entry
for it — as the name of a boundary a client can rely on never being crossed.

If an opaque-write operation is ever added, this ADR must be revisited first and
the per-field verification list re-added with it.

### Recipes resolve roles against installed models, with no silent substitution

A `Recipe` (schema in `recipes.ts`) declares the functional `roles` it needs
(e.g. `oscillator`, `filter`, `midi_input`), each with a `preferred` concrete
model, an optional list of `adapterVerifiedAlternatives`, and an operation
template. The template's `add_module` operations reference roles with the
placeholder `pluginSlug "$role"` and `modelSlug "<roleKey>"`, resolved to
concrete models only at expansion time. The library ships 8 recipes.

Resolution (`resolveRecipe` in `packages/recipes/src/index.ts`) is strict:

1. A role whose `preferred` model is installed binds to it.
2. Otherwise the role is reported **unresolved**, together with any installed
   alternatives — and an alternative is offered only when it is both installed
   *and* has a verified adapter (`hasAdapter`). An installed look-alike with no
   adapter is not offered.
3. A recipe with any unresolved role has `resolved === false`.

`expandRecipeOperations` refuses to expand a recipe that is not fully resolved or
that references an unassigned role, and it substitutes the resolved models into
the operation template. A partial or unresolved recipe therefore **cannot reach
the preview/commit mutation path** — the failure is at expansion, before any
transaction is built. There is no code path that quietly picks a "close enough"
module.

### How the layer is surfaced

Adapters and recipes are read-only knowledge, exposed through the `rack://adapters`
and `rack://recipes` MCP resources and consulted by the analysis tools
(`describe_patch`, `validate_patch`) and the transaction planners. They inform
interpretation and validation; they never bypass the two-phase transaction model
of [ADR-0001](./ADR-0001-execution-model.md).

## Consequences

- Musical interpretation is only as confident as the verification behind it.
  Adapter-covered models get verified port roles, parameter semantics, and safe
  ranges; everything else is explicitly heuristic. Callers can distinguish the
  two rather than being handed uniform-looking guesses.
- Coverage is a maintenance surface: new or updated plugins need new adapters,
  and an adapter's `pluginVersionRange` scopes its claims to versions actually
  verified. The load-time schema validation and duplicate check make an
  incorrect or conflicting adapter a build failure, not a silent regression.
- Refusing opaque-state writes without an adapter (and shipping no
  `set_module_data` tool) means some legitimate edits are simply unavailable
  until a field is verified. That is the intended trade: an unavailable edit is
  recoverable, a corrupted opaque blob often is not.
- Recipes degrade by reporting exactly which roles are missing and which
  installed, adapter-verified alternatives exist, instead of substituting
  silently. Users get an actionable gap ("install this, or pick a verified
  alternative") rather than a patch that looks assembled but behaves wrongly.
- The knowledge layer is versioned data (`adapterVersion`, `recipeVersion`,
  `pluginVersionRange`) validated by the same Zod-generated schemas as the wire
  protocol (see [ADR-0003](./ADR-0003-canonical-schema-codegen.md)), so adapter
  and recipe documents are held to the same fail-fast standard as everything
  else on a boundary.
