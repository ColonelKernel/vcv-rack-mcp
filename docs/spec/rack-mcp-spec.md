# Rack MCP — Normative Specification

This specification is normative. Do not reduce it to a demo, conceptual
scaffold, or collection of pseudocode. The Rackwright identity prompt is the
default instruction resource exposed by the MCP server.

## 1. Product objective

Create a safe local integration through which an MCP client can:

- Discover running VCV Rack instances.
- Inspect loaded plugins, models, modules, parameters, ports, cables, and patch metadata.
- Explain and validate patch signal flow.
- Preview and atomically apply structured patch changes.
- Add, remove, duplicate, position, bypass, and configure modules.
- Connect, stack, replace, and disconnect cables deliberately.
- Save, load, checkpoint, and restore patches safely.
- Undo the latest eligible MCP transaction.
- Obtain supported signal telemetry through a dedicated Probe module.
- Build reliable high-level patches using versioned module adapters and recipes.

The first supported host is VCV Rack Free or Pro 2.6.6 in standalone GUI mode.
Do not claim production support for Rack Pro running inside a DAW or for
headless Rack until each receives its own tested execution adapter.

## 2. Verified platform baseline

Target:

- VCV Rack SDK 2.6.6.
- Rack plugin major version 2.
- C++11-compatible plugin code.
- MCP TypeScript SDK v2.
- MCP protocol revision 2026-07-28, while accepting supported 2025-era clients through the SDK's compatibility path.
- Node.js 20 or newer.
- macOS x64 and arm64. Windows x64. Linux x64.

Pin exact dependency versions and commit the lockfile. Record the Rack SDK
version and bridge protocol version in every build.

Do not depend on private Rack implementation symbols when a public header API
exists. Document every unavoidable app-level API dependency and protect it
with compatibility tests.

## 3. Required architecture

Implement four components.

### 3.1 MCP server

A TypeScript process launched locally by an MCP host over stdio.
Responsibilities: MCP protocol handling; input and output schema validation;
Rack-instance discovery and selection; bridge authentication; tool, resource,
and prompt registration; preview and confirmation-token management; path
policy enforcement; adapter and recipe loading; error normalization; audit
logging; client-facing timeouts and idempotency.

Use `serveStdio()` from the MCP TypeScript SDK v2 so modern and supported
legacy protocol eras work correctly. Never write logs to stdout; stdout is
reserved for MCP traffic. Write diagnostic logs to stderr.

### 3.2 Rack plugin

A Rack 2 plugin containing:

- `RackMCP-Bridge`: a control/status module.
- `RackMCP-Probe`: a signal-analysis module.
- A plugin-global bridge service with clean `init()` and `destroy()` lifecycle handling.
- An invisible command-pump widget attached to the Rack scene after the first Bridge module is instantiated.
- A bounded network-to-UI command queue.
- A bounded UI-to-network response queue.
- A lock-free DSP-to-telemetry buffer owned by each Probe module.

The Bridge module must display: connection status; selected instance name;
read-only versus writer-lease state; last operation status; a pairing/reset
control; a warning when the current patch would not reconnect after restart
because it lacks a Bridge module.

The MCP must refuse to delete the last Bridge module by default.

### 3.3 Local bridge protocol

Use a versioned, length-prefixed JSON protocol over loopback TCP.
Requirements:

- Bind only to `127.0.0.1`. Never listen on all interfaces.
- Maximum frame size: 1 MiB by default.
- Explicit bridge protocol version negotiation.
- Random request IDs. Per-request deadlines. Structured errors.
- Heartbeats and stale-instance detection.
- A single writer lease per Rack instance. Multiple read-only clients may be supported.
- Every mutating request must carry a caller-generated UUID operation ID.
- Cache mutation results by operation ID for at least ten minutes so retries cannot apply the same operation twice.

Create a 256-bit random pairing secret. Store it beneath the Rack user folder
in a RackMCP-owned directory. Use mode `0700` for the directory and `0600` for
secret files on POSIX. Apply an equivalent user-only ACL on Windows. Compare
secrets in constant time and never log them.

Support multiple Rack processes. Each instance writes a protected discovery
manifest containing: instance ID; process ID; Rack version and edition; bridge
version; port; start time; last heartbeat; operating mode; patch name when
available; whether a command pump and Bridge module are present.

Do not put the secret in the discovery manifest.

### 3.4 Knowledge and adapter layer

Generic Rack metadata is insufficient for reliable musical interpretation.
Implement a versioned adapter registry. Each adapter may define: supported
plugin and model slug; compatible plugin-version range; parameter semantics;
input and output signal roles; polyphony behavior; important context-menu or
opaque-state fields, only when verified; safe initial values; validation
rules; common connection recipes; documentation provenance.

Ship an initial adapter pack for the Core and Fundamental modules needed to
create and troubleshoot a basic subtractive synthesizer. Unknown modules must
remain usable through generic graph operations, but semantic claims about them
must be marked as heuristic.

Never mutate opaque `data` fields without a matching adapter.

## 4. Threading and real-time safety

Mandatory rules:

- The socket thread must never call Rack APIs.
- Network threads may only authenticate, parse, validate bridge envelopes, enqueue commands, and return completed responses.
- GUI patch mutations must run through the persistent command-pump widget on Rack's UI thread.
- The command pump must apply engine state, module widgets, cable widgets, positions, expander updates, and history entries coherently.
- No networking, JSON parsing, logging, filesystem access, mutex locking, allocation, or patch serialization may occur in `Module::process()`.
- Probe DSP code must perform fixed-cost numeric accumulation and publish results through a lock-free double buffer or bounded single-producer/single-consumer ring.
- Limit work drained by the UI command pump per frame. Large operations may use a bounded transaction job, but must not expose a partially committed patch.
- Do not attempt audio-rate control through the command queue.
- Stop all bridge threads and close sockets deterministically during plugin destruction.
- The scene command pump must tolerate the Bridge module being removed during the current Rack session.
- Never call a patch load operation from a Bridge module widget in a way that destroys the currently executing object. Patch load and clear must be owned by the persistent global command pump.

## 5. Rack state model

Represent Rack IDs as decimal strings at the TypeScript boundary.
Every live reference must be scoped by `instanceId`, `sessionId`,
`patchEpoch`, and `moduleId` or `cableId`.

Increment `patchEpoch` after load, clear, restore, or any full patch
replacement. Reject stale references from older epochs.

A patch snapshot must include: Rack and bridge versions; instance, session,
and patch epoch; patch path only when disclosure is permitted; saved/unsaved
state; modules; module grid positions and sizes; plugin/model identity and
versions; bypass state; parameters and display metadata; named input and
output ports; cables and cable colors; expander relationships; Bridge and
Probe presence; warnings about unavailable or partially inspected modules.

Exclude opaque module state by default. Permit it only with
`includeOpaqueState: true`, a strict response-size limit, and appropriate
disclosure labeling.

Compute a canonical SHA-256 patch fingerprint from Rack's complete serialized
patch state, including opaque data, positions, cables, and relevant UI state.
Canonicalize object keys and entity ordering before hashing. The fingerprint
is for concurrency control; it does not need to expose the serialized state.

## 6. Transaction model

Use two-phase mutation.

**Preview phase.** `preview_patch_transaction` must:

1. Resolve every reference and transaction-local alias.
2. Recompute the base fingerprint.
3. Reject stale input fingerprints.
4. Validate every operation without mutating Rack.
5. Determine added, removed, moved, and modified entities.
6. Identify input stacking or replacement.
7. Identify Bridge removal, Audio-path changes, missing modules, adapter uncertainty, and possible feedback.
8. Estimate whether the operation can be rolled back through Rack history.
9. Return a normalized plan, risk summary, plan hash, base fingerprint, and expiring confirmation token.

The confirmation token must bind: instance and session; patch epoch; base
fingerprint; canonical plan hash; risk classification; expiration time.

**Commit phase.** `commit_patch_transaction` must require: the confirmation
token for destructive or high-risk plans; a unique operation ID; the exact
plan hash; the expected base fingerprint.

Immediately before mutation, recompute the fingerprint. Reject the commit if
it differs. Prevalidate the entire transaction before applying it. Apply it as
one named Rack history action whenever possible:
`Rack MCP: <label> [<short operation ID>]`.

Build inverse actions as work proceeds. If an operation fails: execute
inverses in reverse order; remove any incomplete widgets, engine objects,
cables, or copied patch-storage files; do not push a history entry; return a
rollback report; mark the result as indeterminate if complete rollback cannot
be proven.

A successful response must contain: operation ID; old and new fingerprints;
patch epoch; applied operations; transaction alias-to-module-ID mappings;
warnings; undo eligibility; duration.

## 7. Supported patch operations

Implement a discriminated `PatchOperation` union with strict JSON Schema.
Required operations:

- `add_module`: plugin slug; model slug; transaction alias; grid position or automatic placement policy; optional supported initial parameter values; optional bypass state.
- `remove_module`: module reference; explicit cable-removal policy; refuse removal of the last Bridge by default.
- `move_module`: module reference; grid coordinates; collision policy `fail`, `nearest`, `force`, or `squeeze`.
- `duplicate_module`: module reference; whether to copy attached cables; preserve module patch storage using Rack-compatible behavior.
- `set_parameter`: module reference; parameter ID; exactly one of raw value, normalized value, or supported display value; optional transition duration for non-audio-rate smoothing.
- `set_bypass`.
- `connect`: output and input references; cable color; input policy `fail_if_connected`, `stack`, or `replace_all`.
- `disconnect`: cable reference.
- `disconnect_port`: port reference; policy top cable or all cables.
- `reset_module`.
- `randomize_module`: always classified as requiring confirmation.

Do not expose a generic `set_module_data` operation.

## 8. Required MCP tools

Every tool must define: human-readable title and description; strict JSON
Schema 2020-12 input; strict output schema; structured output;
backward-compatible text content where needed; correct `readOnlyHint`,
`destructiveHint`, `idempotentHint`, and `openWorldHint`; stable error codes;
examples and tests.

Implement:

- Connection and discovery: `list_rack_instances`, `select_rack_instance`, `get_rack_status`, `acquire_writer_lease`, `release_writer_lease`.
- Catalog and inspection: `list_installed_models`, `inspect_model`, `get_patch_snapshot`, `inspect_module`, `inspect_parameter`, `describe_patch`, `validate_patch`. Catalog calls must be paginated.
- Mutation: `preview_patch_transaction`, `commit_patch_transaction`, `undo_last_mcp_transaction`, `build_patch`.
- Patch files and recovery: `list_patch_files`, `create_checkpoint`, `save_patch`, `preview_load_patch`, `commit_load_patch`, `preview_clear_patch`, `commit_clear_patch`, `restore_checkpoint`.
- Telemetry: `list_probes`, `preview_attach_probe`, `commit_attach_probe`, `read_probe`, `detach_probe`.

`inspect_model` may instantiate a temporary engine module on the UI thread to
obtain parameter and port metadata. It must never add that module to the
patch, must clean up all temporary objects, and must disclose that metadata
inspection required temporary instantiation. Cache results by
plugin/model/version.

`build_patch` is a high-level convenience tool that accepts the same
structured operation graph and delegates to the preview/commit machinery. It
must not bypass validation or confirmation.

`undo_last_mcp_transaction` may proceed only when: the top Rack history entry
is the identified MCP transaction; no subsequent manual action exists; the
current fingerprint matches the recorded post-transaction fingerprint.
Otherwise, refuse rather than undoing unrelated user work.

Before load, clear, or restore, automatically create a recovery checkpoint
unless the preview explicitly reports why that is impossible.

Patch paths must be constrained to configured roots. Defaults: Rack's patches
directory; RackMCP's checkpoint directory. Canonicalize paths, resolve
symlinks, enforce the `.vcv` extension, reject traversal, and never accept
URLs. Use Rack's patch manager for `.vcv` operations. Do not rewrite `.vcv`
archives directly.

After loading or clearing, ensure the resulting patch contains a Bridge module
before permitting a save intended to reconnect after restart. If insertion is
required, disclose it in the preview.

A Probe input must report: channel count; per-channel minimum and maximum;
peak absolute voltage; RMS voltage; mean/DC component; clipped or non-finite
sample count; optional gate/trigger edge count; measurement window and sample
rate; dropped telemetry frame count.

Do not advertise arbitrary output-port sampling without an explicit Probe
cable.

## 9. MCP resources and prompts

Expose resources: `rack://status`, `rack://patch/current`,
`rack://catalog/models`, `rack://adapters`, `rack://recipes`,
`rack://audit/recent`. Apply pagination and response-size limits.

Expose prompts: `design_patch`, `troubleshoot_silence`, `add_effect_safely`,
`explain_signal_flow`, `prepare_live_performance_patch`. The Rackwright
identity is the behavioral foundation for these prompts.

## 10. Validation system

Validation findings must contain: stable rule ID; severity `error`, `warning`,
or `info`; confidence `certain`, `adapter`, or `heuristic`; affected entity
references; evidence; human-readable explanation; suggested repair when
appropriate.

Required structural checks: missing modules; invalid or stale IDs; port index
bounds; output-to-input direction; duplicate identical cables;
module-position collisions; broken expander adjacency; missing Bridge
persistence; parameter values outside declared ranges; non-finite values;
invalid polyphony assumptions from supported adapters.

Required advisory checks: no apparent signal path to an Audio destination;
apparent source-to-output path interrupted by bypass or disconnected cables;
stacked inputs and possible voltage summing; possible feedback cycles; audio
or CV role mismatches inferred from adapters or names; pitch/gate confusion;
polyphonic source feeding a known monophonic path; excessive output level
where telemetry or an adapter provides evidence; unverified third-party
module semantics.

Never call a graph cycle inherently invalid. Never claim semantic
incompatibility solely because two port names differ.

## 11. High-level recipes

Provide versioned recipes for at least: basic monophonic subtractive synth;
polyphonic MIDI-controlled subtractive synth; clocked eight-step sequence;
stereo send/return delay; safe master-output chain; LFO modulation path;
sidechain-style envelope-following modulation where supported; Probe-assisted
diagnosis of a silent patch.

Recipes must resolve against installed models. If an exact dependency is
missing: return the unresolved functional role; list compatible installed
alternatives only when an adapter proves compatibility; never silently
substitute an unknown module.

## 12. Error contract

Use stable error codes including: `RACK_NOT_FOUND`, `RACK_DISCONNECTED`,
`BRIDGE_NOT_READY`, `WRITER_LEASE_REQUIRED`, `AUTHENTICATION_FAILED`,
`PROTOCOL_VERSION_MISMATCH`, `STALE_SESSION`, `STALE_PATCH_EPOCH`,
`PATCH_CONFLICT`, `MODEL_NOT_INSTALLED`, `MODULE_NOT_FOUND`,
`CABLE_NOT_FOUND`, `PARAMETER_NOT_FOUND`, `PORT_NOT_FOUND`,
`VALIDATION_FAILED`, `CONFIRMATION_REQUIRED`, `CONFIRMATION_EXPIRED`,
`PATH_NOT_ALLOWED`, `TRANSACTION_TOO_LARGE`, `ROLLBACK_FAILED`, `TIMEOUT`,
`UNSUPPORTED_OPERATION`, `OPAQUE_STATE_UNSUPPORTED`, `TELEMETRY_UNAVAILABLE`.

Errors must say whether retrying is safe and whether the mutation may already
have occurred. Mutating retries must use the same operation ID.

## 13. Limits and performance

Defaults: bridge frame 1 MiB; MCP structured result 4 MiB; transaction 128
operations; added modules per transaction 32; active probes 16; probe
reporting rate max 20 Hz; parameter-control rate max 30 changes/s per client;
confirmation lifetime 5 minutes; command timeout 5 s; patch load/save timeout
configurable, default 60 s; audit retention configurable by size and age.

When idle, Bridge DSP work must allocate nothing and perform no locks. Probe
processing must have fixed bounded cost.

Measure and report: queue depth; request latency; UI execution duration;
timeouts; rollbacks; authentication failures; dropped telemetry frames;
bridge reconnects.

## 14. Security and privacy

The system must: operate locally by default; expose no public HTTP endpoint;
execute no arbitrary code or shell commands; install no Rack modules; fetch no
URLs; read and write only configured patch, checkpoint, configuration, and
audit locations; redact secrets and opaque module data from logs; treat plugin
and model metadata as untrusted text; enforce length, depth, number, and
string-size limits before processing JSON; reject NaN and infinity at the JSON
boundary; fuzz the bridge decoder and all discriminated-operation schemas;
prevent a read-only connection from obtaining a writer lease without
authentication; make writer-lease ownership visible on the Bridge panel.

Document VCV licensing implications. If the Rack plugin is distributed free of
charge, select and document a compatible license. If it will be sold under
non-GPL terms, flag that VCV commercial licensing must be arranged before
release.

## 15. Repository structure

Monorepo: `apps/mcp-server/`, `plugins/RackMCP/`, `packages/protocol/`,
`packages/schemas/`, `packages/adapters/`, `packages/recipes/`,
`packages/test-client/`, `tests/contract/`, `tests/integration/`,
`tests/fuzz/`, `docs/architecture/`, `docs/security/`, `docs/tools/`,
`docs/module-adapters/`, `scripts/`, `.github/workflows/`.

Generate TypeScript types and C++ protocol models from one canonical schema
source where practical. CI must fail when generated protocol artifacts are
stale.

## 16. Testing requirements

**Unit tests** cover: every input and output schema; canonical fingerprint
generation; confirmation-token binding and expiry; path containment and
symlink attacks; operation-ID deduplication; adapter version selection;
recipe resolution; error normalization; frame parsing and size limits;
authentication and writer leases.

**C++ tests**: extract bridge framing, queues, validation helpers, and
telemetry math into testable libraries. Test: queue saturation; shutdown while
requests are active; constant-time credential comparison; probe
RMS/min/max/DC calculations; non-finite signal handling; ring-buffer overruns;
module and cable inverse actions.

**Integration tests** against Rack 2.6.6:

1. Connect and inspect an empty patch.
2. Enumerate installed Core and Fundamental models.
3. Add modules and verify both engine and widget state.
4. Connect and disconnect cables.
5. Exercise stacked inputs.
6. Change raw, normalized, snapped, and smoothed parameters.
7. Duplicate a module containing patch storage.
8. Undo one MCP transaction.
9. Refuse undo after a manual history action.
10. Detect a fingerprint conflict.
11. Save and reload a `.vcv` containing module storage.
12. Recover from a failed load using a checkpoint.
13. Preserve or reinsert the Bridge.
14. Attach a Probe and verify telemetry against known generated voltages.
15. Disconnect the MCP server mid-transaction.
16. Restart Rack and rediscover the instance.
17. Run two Rack instances and select each independently.

**Real-time tests** at common sample rates and block sizes: idle Bridge
overhead; Probe overhead with 1 and 16 channels; parameter changes under
audio load; patch transactions under audio load; no network or filesystem
calls from DSP; no allocations in the steady-state Probe process path.

**Cross-platform CI**: build and test on macOS arm64, macOS x64 where
infrastructure permits, Windows x64, Linux x64. Package the Rack plugin using
Rack SDK conventions and build the MCP server as a reproducible distributable.

## 17. Documentation deliverables

Architecture decision records; threat model; threading model diagram; bridge
protocol specification; complete MCP tool reference; adapter authoring guide;
recipe authoring guide; installation guide per supported OS; pairing and
multi-instance guide; backup and recovery guide; VCV licensing note;
troubleshooting guide using `log.txt` and MCP diagnostics; compatibility
matrix; release and rollback procedure. Include configuration examples for
major MCP hosts without hard-coding one vendor.

## 18. Delivery phases

1. Repository, schemas, and test infrastructure.
2. Rack plugin lifecycle, instance manifest, authentication, and status.
3. Stdio MCP server and connection discovery.
4. Read-only Rack snapshot and catalog.
5. Parameter mutation with history and idempotency.
6. Module and cable transactions.
7. Fingerprints, preview, confirmation, and rollback.
8. Save, checkpoint, load, clear, and restore.
9. Probe telemetry.
10. Core/Fundamental adapters and recipes.
11. Security hardening, fuzzing, packaging, and cross-platform verification.

Each phase must leave the repository runnable and tested.

## 19. Definition of done

The project is complete only when: a supported MCP client can launch the
server over stdio; the server can securely discover and pair with Rack 2.6.6;
Rack audio processing never performs bridge networking, filesystem access,
logging, or JSON work; patch inspection reflects real Rack state; a
subtractive synth can be previewed, committed, validated, saved, reloaded, and
undone; destructive operations require a valid preview-bound confirmation;
retried mutations cannot execute twice; manual patch changes cause stale
commits to fail; failed supported transactions roll back without leaving
orphan engine or UI objects; arbitrary signal monitoring is available only
through the Probe; unknown third-party state is never mutated speculatively;
the complete test suite passes on every supported platform; installation and
recovery procedures have been followed successfully from a clean machine;
unsupported environments and limitations are stated plainly.
