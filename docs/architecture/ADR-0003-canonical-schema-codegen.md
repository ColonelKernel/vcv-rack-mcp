# ADR-0003: One canonical Zod schema source, generated JSON Schema and C++ tables

- Status: Accepted
- Date: 2026-08-30
- Deciders: Rack MCP project

## Context

Rack MCP spans two languages that must agree byte-for-byte on a wire protocol:
the TypeScript MCP server and the C++11 Rack plugin. Both validate the same
bridge frames, patch operations, method payloads, error codes, and numeric
limits. [ADR-0001](./ADR-0001-execution-model.md) already committed to a single
canonical schema source and rejected full C++ struct generation; this record
specifies the pipeline that implements that decision, why it stops at validator
tables on the C++ side, and how CI keeps the two languages from drifting.

The failure mode we are designing against is silent divergence: the server
accepting a frame the plugin rejects, the two sides disagreeing on which
operations exist, or a hand-maintained C++ mirror of the schema falling behind
the TypeScript definitions. Any of these turns a validation guarantee into a
runtime surprise.

The pipeline is implemented in `scripts/gen-schemas.ts` (Zod → JSON Schema) and
`scripts/gen-cpp.ts` (JSON Schema → C++ header), with the Zod definitions living
in `packages/schemas`.

## Decision

### Zod is the single source of truth

The Zod v4 definitions in `packages/schemas` are canonical. Everything else is
**generated and committed**, and nothing downstream is hand-authored:

```
packages/schemas/src/*.ts   (Zod — the only hand-written schema)
        │  scripts/gen-schemas.ts  (z.toJSONSchema, draft-2020-12)
        ▼
packages/schemas/json/*.schema.json   (committed JSON Schema 2020-12)
        │  scripts/gen-cpp.ts
        ▼
plugins/RackMCP/src/gen/rackmcp_protocol_gen.hpp   (committed C++11 header)
```

The two stages run under `pnpm run gen`; CI runs `pnpm run check:gen` and fails
the build if either committed artifact differs from a fresh regeneration.

### Stage 1 — JSON Schema from Zod

`scripts/gen-schemas.ts` emits one JSON Schema 2020-12 document per top-level
type via `z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable:
"any" })`, plus three aggregate documents: `bridge-methods.schema.json`
(per-method `mutating` flag with request and result schemas),
`tools.schema.json` (the MCP tool contracts) and `resources.schema.json` (the
`rack://` resource contracts). The resource document exists because MCP has no
`outputSchema` field on a resource the way it has one on a tool, so nothing
carries those shapes to a client at runtime -- the artifact and the resource
description are the only published record of them. The emitted set covers
`bridge-frame`, `patch-operation`, `instance-manifest`, `patch-snapshot`,
`probe-reading`, `module-adapter`, `recipe`, `error`, and `validation-finding`.

Two details matter for cross-language fidelity:

- **Input vs. output mode.** Schemas are emitted in `input` mode for data
  *arriving* at a boundary (client frames, operations, adapter/recipe documents,
  method requests) and `output` mode for data the system *produces* (snapshots,
  telemetry, errors, manifests, method results). Input mode keeps `.default()`
  fields optional on the wire — they are filled at parse time — while output
  mode marks them required. Request-side schemas are always input mode, so the
  plugin never rejects a client for omitting a defaultable field.
- **Cross-field invariants that JSON Schema cannot express from Zod.** Zod
  `refine()` predicates are dropped by `z.toJSONSchema`. `gen-schemas.ts`
  re-encodes the three `PatchOperation` invariants explicitly with
  `oneOf`/`if`/`then` and asserts it augmented exactly three variants
  (`set_parameter` must carry exactly one of `value` / `normalized` / `display`;
  `add_module` and `duplicate_module` require `position` when `placement ==
  "at"`). The plugin additionally hand-implements these same checks, so the
  invariant is enforced on both sides rather than trusted to one.

### Stage 2 — C++ tables, not structs

`scripts/gen-cpp.ts` reads the committed JSON Schema documents (not the Zod
source directly) and emits `plugins/RackMCP/src/gen/rackmcp_protocol_gen.hpp`.
Because the plugin operates on jansson `json_t` values, the header supplies
**constants, enums, and required-field validator tables**, not typed structs:

| Emitted artifact | Contents |
| --- | --- |
| `BRIDGE_PROTOCOL_VERSION`, `BRIDGE_PROTOCOL_MIN_SUPPORTED` | protocol version constants |
| `LIMIT_*` constants | every entry of `LIMITS`, macro-cased (e.g. `LIMIT_JSON_MAX_DEPTH`) |
| `enum class ErrorCode` + `errorCodeToString` | the stable error-code set |
| `FrameSpec[]` / `FieldSpec[]` | each frame kind and its required non-discriminator fields, with JSON type |
| `MethodSpec[]` | each bridge method, its `mutating` flag, and required request fields |
| `OperationSpec[]` | each patch operation and its required fields |

Field types are collapsed to a small JSON vocabulary by `jsonTypeOf` (which, for
example, folds a union whose branches all share one JSON type — like a
`ModuleRef` that is always an object — back to that single type so the C++
validator keeps the type check). Discriminator fields (`kind`, `op`) are
filtered out of the required-field lists and the remaining names are sorted for
a stable, diff-friendly emission.

These tables are exactly what `service.cpp` consumes: `findMethod` scans
`gen::METHOD_SPECS`, request handling reads `MethodSpec.mutating`, and frame
limits come from the `gen::LIMIT_*` constants (see
[ADR-0002](./ADR-0002-bridge-lifecycle-and-threading.md)).

### Codegen self-checks

`gen-cpp.ts` does not just transcribe — it cross-validates while generating and
throws on any inconsistency, so a bad schema cannot produce a header:

- Every bridge frame and operation variant must declare a `kind`/`op` const.
- Every method named in `BRIDGE_METHOD_NAMES` must have an entry in
  `bridge-methods.schema.json`.
- The set of operation names discovered in `patch-operation.schema.json` must
  exactly equal the declared `OPERATION_TYPES`; a mismatch aborts generation
  with both sets printed.

### Why not generate full C++ structs

Full struct generation was considered and rejected. The plugin already parses
and serializes with jansson, so generated structs would either duplicate the
`json_t` layer or force a second parse into strongly-typed objects — extra code,
extra copies, and a second place for bugs, all inside the audio-adjacent plugin.
Required-field validator tables give the same boundary safety (presence and
coarse JSON type of every required field, enforced before dispatch) without the
struct machinery. The generated header is a header of `const` tables and an
enum: cheap to compile, trivial to review, and consumed directly by the existing
jansson code paths.

## Consequences

- Adding or changing a wire type is a one-file edit in `packages/schemas`
  followed by `pnpm run gen`; the JSON Schema and C++ header regenerate, and
  `check:gen` in CI guarantees the committed artifacts match. A stale header
  cannot merge.
- The TypeScript and C++ validators cannot disagree on which methods or
  operations exist, on required fields, or on error codes and limits, because
  all of those originate from one Zod source and the codegen aborts on any
  internal mismatch.
- The generated header is intentionally coarse: it checks required-field
  presence and JSON type, not full value semantics. Deep semantic validation
  (cross-field invariants, ranges, canonicalization for the planHash and
  fingerprint) still lives in hand-written plugin code — the tables are a first
  gate, not the whole validator.
- The two-stage pipeline (Zod → JSON Schema → C++) means the C++ generator
  consumes the same committed JSON Schema that external tooling can also read,
  so the JSON Schema files are a genuine published contract, not a throwaway
  intermediate.
- Generated files carry a `DO NOT EDIT` banner and regenerate deterministically
  (sorted fields, stable ordering), keeping diffs reviewable and merge conflicts
  rare.
