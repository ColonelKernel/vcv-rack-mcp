# Definition-of-done audit

This document audits Rack MCP against the fourteen completion criteria in
[section 19 of the normative spec](../spec/rack-mcp-spec.md). Each criterion is
marked **Met**, **Met (CI-only)**, or **Partially met** with the concrete
evidence — a test, a live smoke, or the code that enforces it — and any honest
caveat.

Verification tiers used below:
- **Unit** — `pnpm -r test` (219 TypeScript tests across schemas, protocol,
  adapters, recipes, and the server) and the C++ `ctest` suite (71 doctest
  cases: framing, queues, crypto, canonical/JSON-limits/UTF-8 clamping,
  telemetry math, protocol-gen, service, secret/manifest files).
- **Live** — integration smokes in `tests/integration/` that launch the
  installed VCV Rack 2 Pro 2.6.6 against an isolated user directory and drive it
  through the real MCP server over stdio. Verified on **macOS arm64**.
  `contract-smoke` is the output-contract gate: it calls all 29 tools and
  strict-parses every result against that tool's declared output schema, and
  fails if a tool in the registry goes unexercised. The server's own output
  validation is deliberately non-fatal, so without this gate a producer whose
  payload no longer matches the published schema still shows a green build.
- **Wire fixtures** — that gate needs the installed Rack on macOS, so it cannot
  run in CI. `tests/fixtures/bridge/` holds a captured real response for each of
  the 19 bridge methods, and `packages/schemas/test/bridge-fixtures.test.ts`
  strict-parses each against the `result` schema `BRIDGE_METHODS` declares for
  it — a table that existed from the start but was read only by the code
  generator. That check runs on every CI platform. It covers one direction: a
  schema edited away from the real wire. It cannot cover the other, because the
  fixtures are frozen files that a drifting producer never touches — so the
  producer direction is checked live by
  `pnpm --filter @rackmcp/integration run verify:fixtures`, which re-captures
  against a running Rack and compares the key/type structure of every response,
  ignoring the ids, fingerprints and durations that differ on every run.
  Refresh the fixtures with `... run capture`; they are captured, never
  hand-written, because a fixture edited to make CI pass proves nothing.
  The telemetry schemas that the fixtures cannot reach — the engine does not
  step under the harness, so `channels` and `slots` come back thin — are pinned
  directly by `packages/schemas/test/telemetry.test.ts`.
- **CI** — `.github/workflows/ci.yml` builds and tests TypeScript and C++ on
  ubuntu/macos/windows, runs a 60 s libFuzzer smoke of the frame decoder on
  Linux, and packages the plugin for mac-arm64, mac-x64, lin-x64, and win-x64.

## Summary

| # | Criterion | Status | Primary evidence |
| --- | --- | --- | --- |
| 1 | Client launches the server over stdio | Met | bundle handshake; all integration smokes connect via `StdioClientTransport` |
| 2 | Secure discovery and pairing with Rack 2.6.6 | Met | `recipes-smoke`/`mcp-smoke` discover + select; HMAC auth (`crypto.test.cpp`, `service.test.cpp`) |
| 3 | Audio thread does no networking/filesystem/logging/JSON | Met | `BridgeModule::process` (atomics only), `ProbeModule::process` (fixed-cost); `telemetry.test.cpp` |
| 4 | Inspection reflects real Rack state | Met | `snapshot-smoke`, `describe_patch`/`validate_patch` live in `recipes-smoke` |
| 5 | Subtractive synth preview→commit→validate→save→reload→undo | Met | `write-smoke` (28 checks) + `files-smoke` |
| 6 | Destructive ops require a valid preview-bound confirmation | Met | confirmation-token store; `write-smoke` stale/refusal checks; token-lifecycle cases in `transactions.test.ts` / `patchfiles.test.ts` |
| 7 | Retried mutations cannot execute twice | Met | idempotency cache; `write-smoke` idempotent-retry check |
| 8 | Manual patch changes make stale commits fail | Met | fingerprint conflict → `PATCH_CONFLICT`; `write-smoke` |
| 9 | Failed transactions roll back without orphans | Met | inverse actions; `write-smoke` rollback (module count preserved) |
| 10 | Arbitrary signal monitoring only via the Probe | Met | no generic signal-read tool; `probe-smoke`; Probe DSP tests |
| 11 | Unknown third-party state never mutated speculatively | Met | no `set_module_data` tool; adapter-gated; `validate_patch` reports coverage gaps |
| 12 | Full suite passes on every supported platform | Met (CI-only) | mac-arm64 verified locally; other three platforms build+test in CI |
| 13 | Install + recovery followed from a clean machine | Partially met | reproduced on the development macOS arm64 machine; see caveat |
| 14 | Unsupported environments and limitations stated plainly | Met | [compatibility matrix](../tools/compatibility-matrix.md), [ADR-0001](./ADR-0001-execution-model.md), this audit |

## Criterion detail

**1 — Client launches the server over stdio.** The server entry
(`apps/mcp-server/src/index.ts`) speaks MCP over stdio and reserves stdout for
protocol traffic (diagnostics go to stderr). The reproducible single-file bundle
(`apps/mcp-server/dist/bundle/rack-mcp-server.mjs`) answers an MCP `initialize`
handshake and advertises tools, resources, and prompts; every integration smoke
connects through `StdioClientTransport`.

**2 — Secure discovery and pairing.** A per-launch manifest under
`<RackUserDir>/RackMCP/instances/` is discovered and filtered by heartbeat age
and PID liveness; `select_rack_instance` connects. Authentication is HMAC-SHA256
challenge-response with a 256-bit secret that never crosses the wire, compared in
constant time — unit-tested in `crypto.test.cpp` and `service.test.cpp` and
exercised live whenever a smoke connects. See the
[threat model](../security/threat-model.md) and
[pairing guide](../security/pairing-and-multi-instance.md).

**3 — Audio-thread real-time safety.** `Module::process` for the Bridge performs
only atomic-flag reads and light writes; the Probe performs fixed-cost,
allocation-free, lock-free accumulation and publishes through a seqlock double
buffer. No networking, filesystem, logging, or JSON occurs on the audio thread.
The telemetry math (RMS/min/max/DC/peak, non-finite handling, ring behavior) is
verified deterministically in `telemetry.test.cpp`, independent of a running
engine. See the [threading model](./threading-model.md).

**4 — Inspection reflects real Rack state.** `get_patch_snapshot`,
`inspect_module`, `inspect_parameter`, `describe_patch`, and `validate_patch`
read live engine and widget state through the command pump. `snapshot-smoke`
validates the live snapshot, and `recipes-smoke` runs `describe_patch` /
`validate_patch` over a freshly built patch.

**5–9 — The transaction lifecycle.** `write-smoke` builds the reference
subtractive voice (MIDI-CV → VCO → VCF → VCA(+ADSR) → Audio) end to end and
asserts: preview returns a plan + `planHash` + `baseFingerprint`; `build_patch`
commits; `validate_patch` finds no errors; a parameter change commits; a commit
against a stale fingerprint is rejected as `PATCH_CONFLICT`; a retried
`operationId` is replayed rather than reapplied; `undo_last_mcp_transaction`
reverts the last MCP transaction; an injected mid-transaction failure rolls back
leaving the module count unchanged (no orphans); and undoing a non-top
transaction is refused. `files-smoke` covers save and reload of a `.vcv`
containing module storage.

The load / clear / restore confirmations are now as strong as a transaction
token: each binds instance, session, kind, target path, patch epoch, and base
fingerprint, is re-verified against live state immediately before the
irreversible request, and is burned on use. Two consequences are visible to
callers and are stricter than before. A commit whose patch changed at all since
the preview — including UI-only changes such as dragging a module, since the
fingerprint covers serialized UI state — is refused with `PATCH_CONFLICT` or
`STALE_PATCH_EPOCH`, so an agent that previews and then waits on a slow human
confirmation must re-preview. And retrying a commit with the same token after a
lost response now returns `CONFIRMATION_EXPIRED` rather than a replayed result;
re-previewing shows the true post-state. Separately, a failed recovery
checkpoint now aborts the load/clear instead of proceeding without one.

**10 — Signal monitoring only via the Probe.** There is no generic signal-read
tool; arbitrary monitoring requires attaching a RackMCP-Probe over an explicit
cable (`preview_attach_probe` / `commit_attach_probe` / `read_probe`).
`probe-smoke` exercises the attach/read/detach path.

**11 — No speculative third-party mutation.** There is deliberately no
`set_module_data` operation, and opaque module state is never written without a
matching adapter. Modules without a verified adapter remain usable but are
reported as heuristic; `validate_patch` surfaces the coverage gap
(`adapter.unverified_modules`). See
[ADR-0004](./ADR-0004-adapter-and-recipe-knowledge-model.md).

**12 — Full suite on every supported platform (CI-only).** The complete suite
passes locally on macOS arm64: 219 TypeScript unit tests, 71 C++ cases, and the
integration smokes. Windows x64, Linux x64, and macOS x64 are built and tested by
CI (`.github/workflows/ci.yml`) but have not been verified on local hardware in
this project; treat them as CI-green, not hand-verified, until a maintainer runs
them on those platforms. This is stated as a limitation, per criterion 14.

**13 — Clean-machine install and recovery (partially met).**
[The clean-machine walkthrough](../tools/clean-machine-install.md) was followed
successfully on the development macOS arm64 machine: prerequisites, build and
test, plugin packaging (`make dist` → `RackMCP-2.0.0-mac-arm64.vcvplugin`),
server bundling, launching the isolated Rack instance, and building a recipe
through the MCP path all succeed. **Caveat:** this was reproduced on the
development machine rather than a freshly imaged OS, so host-level prerequisites
(Xcode command-line tools, Node, pnpm) were already present. Recovery is covered
by the checkpoint flow and verified by `files-smoke`; see
[backup and recovery](../tools/backup-and-recovery.md).

**14 — Limitations stated plainly.** Supported and unsupported environments are
enumerated in the [compatibility matrix](../tools/compatibility-matrix.md) and
[ADR-0001](./ADR-0001-execution-model.md): Rack Free/Pro 2.6.6 **standalone GUI
only**; DAW-hosted and headless are unsupported. A documented environment
limitation is that a Rack instance launched non-interactively by the test harness
does not step its audio engine, so live telemetry reads zero until a real
interactive session runs the engine — the Probe DSP math is therefore verified in
C++ rather than against live voltages under the harness.

## Divergences from the normative spec

The completion criteria in section 19 are met as recorded above, but the
implementation does not do everything the rest of the spec asks for. These gaps
are deliberate and recorded here rather than papered over.

- **`duplicate_module` is not implemented.** [Spec section
  7](../spec/rack-mcp-spec.md) lists it as a required patch operation. The
  plugin rejects it during preview with `UNSUPPORTED_OPERATION`
  (`plugins/RackMCP/src/rackside/Transaction.cpp`), which is a deliberate
  narrowing: previously a plan containing it previewed successfully and then
  threw at commit, so preview and commit now agree exactly, at the cost of the
  operation being unavailable. Implementing it undoably inside one history action
  is not settled by the vendored Rack SDK headers — `ModuleWidget::cloneAction`
  pushes its own action straight onto `APP->history`, which would escape the
  transaction's rollback, and whether `Module::fromJson` overwrites the module id
  cannot be determined from headers alone; guessing risked corrupting the engine
  id map. Duplicating a module today means `add_module` plus explicit
  `set_parameter` / `connect` operations, which does not carry over opaque module
  storage. Callers that previously sent `duplicate_module` will now fail at
  preview instead of at commit.
- **`set_parameter`'s `smoothMs` is accepted and ignored.** Spec section 7 asks
  for an optional transition duration for non-audio-rate smoothing, and
  `packages/schemas/src/operations.ts` declares the field, but no plugin code
  reads it. The applier writes through `ParamQuantity::setImmediateValue`, so the
  committed value, the `ParamChange` history entry, and the returned fingerprint
  all agree — a smoothed parameter steps to its new value rather than ramping.
  Implementing `smoothMs` would have to be a UI-pump ramp that still leaves the
  history entry and the fingerprint at the final value.
- **Preview validates the plan, but does not fully simulate it.** Spec section 6
  step 4 asks preview to validate every operation without mutating Rack. Preview
  now tracks plan-local state — modules removed earlier in the plan, cables
  removed earlier, input ports already claimed — but a module the plan has not
  created yet has no live counterpart to inspect, so parameter IDs and port
  bounds against a transaction alias remain apply-time failures that are caught
  by rollback rather than at preview. The collision check for `collision: "fail"`
  has the same shape: it sees only live module widgets, so it can reject a
  placement a later `force`/`squeeze` operation would have made room for, and it
  cannot see a module added earlier in the same plan. `requestModulePos` at apply
  time remains the authority.
- **The Rack-GUI patch-replacement detector has two blind spots.** Spec section 5
  requires the patch epoch to be incremented after "any full patch replacement".
  The plugin now detects replacements made in Rack's own UI (File > New / Open /
  Revert, drag-and-drop) by polling for a cleared undo history or a swapped
  module set, and bumps the epoch, but two cases are undetected by design: a
  File > Revert with no edits since the load (the reverted patch is
  content-identical), and a GUI replacement that lands inside the ~500 ms poll
  window and is immediately followed by a user edit, which reads as ordinary
  editing. The detector deliberately over-bumps in ambiguous cases, so
  `patchEpoch` is no longer reliably 1 on a fresh session.

## Known follow-ups (not DoD gaps)

- The declared `PatchSnapshot` output schema historically diverged from the
  bridge's wire field names; reconciliation (and non-fatal server-side output
  validation) is tracked separately and does not affect the criteria above, since
  the wire data itself reflects real Rack state.
- `format:check` (Prettier) has repository-wide style debt predating this phase;
  it is a formatting cleanup, not a correctness issue.
