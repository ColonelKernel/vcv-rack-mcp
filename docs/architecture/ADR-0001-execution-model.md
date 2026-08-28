# ADR-0001: Execution model, Rack API boundaries, bridge lifecycle, licensing, supported modes

- Status: Accepted
- Date: 2026-08-28
- Deciders: Rack MCP project

## Context

Rack MCP integrates an MCP server with VCV Rack 2.6.6 through a Rack plugin.
The spec (normative) requires a decision record before implementation code
covering the execution model, Rack API boundaries, bridge lifecycle, licensing,
and the exact supported operating modes.

## Decision

### Supported operating modes

- **Supported:** VCV Rack **Free or Pro 2.6.6, standalone GUI mode**, on
  macOS arm64/x64, Windows x64, Linux x64.
- **Not supported (stated, not implied):** Rack Pro as a DAW plugin (VST/AU/CLAP)
  and headless Rack. Each requires its own tested execution adapter before any
  support claim. The bridge reports `mode: "standalone-gui"` and the server
  refuses to claim other modes.

### Execution model

Four components (spec section 3): a stdio **MCP server** (TypeScript,
`@modelcontextprotocol/server@2.0.0`, Node >= 20), a **Rack plugin**
(`RackMCP`, C++11, Rack SDK 2.6.6) containing the Bridge and Probe modules and
a plugin-global bridge service, a versioned **loopback TCP bridge protocol**
(127.0.0.1 only, 4-byte big-endian length-prefixed JSON, 1 MiB frames), and a
**knowledge layer** of versioned adapters and recipes.

Threading (spec section 4):

- Socket/service threads never call Rack APIs. They authenticate, frame,
  parse, validate, enqueue commands, and write completed responses.
- All Rack API work executes in a persistent **command-pump widget** attached
  to `APP->scene` (not `scene->rack`, so it survives patch load/clear), added
  lazily from the first Bridge `ModuleWidget::step()` and drained with a
  per-frame budget.
- `Module::process()` does no networking, JSON, logging, filesystem access,
  locking, allocation, or patch serialization. Probe DSP is fixed-cost
  accumulation published through a lock-free double buffer.
- Patch load/clear/restore are owned by the pump, never by a module widget
  (a widget must not destroy itself mid-call).

### Rack API boundaries

Only public Rack SDK 2.6.6 headers are used. The load-bearing APIs, verified
against the SDK headers, are:

| Area | API | Header |
| --- | --- | --- |
| Context | `APP` / `contextGet()`, `Context{scene, engine, history, patch}` | `context.hpp` |
| Patch | `patch::Manager::{toJson, fromJson, save, load, loadAction, clear, path, autosavePath}` | `patch.hpp` |
| History | `history::State::{push, undo, canUndo, getUndoName, actions, actionIndex}`, `ComplexAction`, `ModuleAdd/Remove`, `CableAdd/Remove`, `ParamChange`, `ModuleMove`, `ModuleBypass`, `ModuleChange` | `history.hpp` |
| Engine | `Engine::{addModule, removeModule, getModule, getModuleIds, addCable, removeCable, getCable, getCableIds, setParamValue, getSampleRate, moduleToJson, prepareSave}` | `engine/Engine.hpp` |
| Modules | `Module::{id, model, params, inputs, outputs, paramQuantities, inputInfos, outputInfos, isBypassed, toJson, getPatchStorageDirectory, createPatchStorageDirectory}` | `engine/Module.hpp` |
| Params | `ParamQuantity::{setValue, getValue, setImmediateValue, getDisplayValueString, setDisplayValueString, minValue, maxValue, defaultValue, name, unit}` | `engine/ParamQuantity.hpp` |
| Widgets | `RackWidget::{addModule, removeModule, getModule, getModules, requestModulePos, setModulePosNearest, setModulePosForce, setModulePosSqueeze, addCable, removeCable, getCompleteCables...}`, `ModuleWidget::{toJson, fromJson, box}`, `CableWidget` | `app/*.hpp` |
| Plugins | `plugin::plugins`, `plugin::getModel`, `Model::{createModule, createModuleWidget, slug, name}` | `plugin.hpp`, `plugin/Model.hpp` |
| Misc | `system::`, `string::`, `random::`, `asset::user` | various |

These are all app-level but public APIs. Every dependency in this table is
exercised by the integration suite against real Rack 2.6.6, which serves as
the compatibility test required by the spec. No private symbols
(`PRIVATE`-annotated or `Internal`) are referenced. JSON uses **jansson**
(bundled with the Rack SDK).

The collision policies map 1:1 to Rack APIs: `fail` -> `requestModulePos`,
`nearest` -> `setModulePosNearest`, `force` -> `setModulePosForce`,
`squeeze` -> `setModulePosSqueeze`.

`patch::Manager::save(path)` "saves the patch and nothing else" (does not
change `path`), which makes checkpoint-copies safe without touching the
current patch identity. `toJson()` provides the complete serialized patch
state used for the canonical SHA-256 fingerprint.

### Bridge lifecycle

1. Plugin `init()` starts the bridge service: creates/validates the pairing
   secret (`<userDir>/RackMCP/secret`, dir 0700 / file 0600), binds a loopback
   listener on an ephemeral port, generates `instanceId` + `sessionId`, and
   writes the discovery manifest (atomic rename) with ~2 s heartbeats.
2. The command pump attaches to the scene when the first Bridge module widget
   steps. The manifest advertises `commandPumpPresent` and
   `bridgeModulePresent`; mutation commands require the pump.
3. Connections: `hello` -> `welcome` (version negotiation + nonce) -> `auth`
   (HMAC-SHA256 challenge-response, constant-time compare; the secret never
   crosses the wire) -> authenticated read-only session. A single writer lease
   gates mutations; lease state is shown on the Bridge panel.
4. Plugin `destroy()` deterministically: stops accepting, notifies clients
   (`evt: shutting_down`), joins all threads, closes sockets, removes the
   manifest.
5. `patchEpoch` increments on load/clear/restore/full replacement; stale
   scoped references are rejected with `STALE_PATCH_EPOCH`.

### Idempotency and transactions

Mutating bridge methods carry a caller-generated UUID `operationId`; results
are cached (>= 10 min LRU+TTL) and replayed on retry. Transactions are
two-phase (preview -> commit) with plan hashes and patch fingerprints computed
**plugin-side** over canonical JSON (jansson `JSON_COMPACT | JSON_SORT_KEYS`
with fixed real precision) so the two languages can never canonicalize
differently. Commits apply as one named `history::ComplexAction`
(`Rack MCP: <label> [<op8>]`) with inverse actions built as work proceeds.

### Licensing

- `plugins/RackMCP`: **GPL-3.0-or-later** (free distribution; satisfies VCV's
  requirement that Rack plugins be GPLv3-compatible without a commercial
  license).
- `apps/`, `packages/`, `scripts/`, `tests/`, `docs/`: **MIT** (no Rack code).
- If the plugin is ever sold under non-GPL terms, VCV commercial licensing
  must be arranged before release (documented in `docs/security/licensing.md`).

### Canonical schema source

Zod v4 definitions in `packages/schemas` are canonical. Committed generated
artifacts: JSON Schema 2020-12 (`packages/schemas/json/`) and a C++11 header
(`plugins/RackMCP/src/gen/rackmcp_protocol_gen.hpp`) with constants, error
codes, and required-field validator tables. CI fails when generated artifacts
are stale. Full C++ struct generation was rejected as impractical for a
jansson-based plugin; validator tables give equivalent boundary safety.

## Consequences

- The integration suite must run against the real Rack 2.6.6 GUI; CI covers
  build + unit layers, and the live suite runs on developer machines
  (documented in `docs/architecture/testing.md`).
- Because fingerprints hash `patch::Manager::toJson()`, any Rack change to
  serialization across versions changes fingerprints; fingerprints are scoped
  per session and never persisted across Rack versions.
- The single-writer lease means two MCP clients cannot mutate concurrently by
  design; read-only clients are unlimited.
