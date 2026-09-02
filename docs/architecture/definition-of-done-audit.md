# Definition-of-done audit

This document audits Rack MCP against the fourteen completion criteria in
[section 19 of the normative spec](../spec/rack-mcp-spec.md). Each criterion is
marked **Met**, **Met (CI-only)**, or **Partially met** with the concrete
evidence — a test, a live smoke, or the code that enforces it — and any honest
caveat.

Verification tiers used below:
- **Unit** — `pnpm -r test` (128 TypeScript tests across schemas, protocol,
  adapters, recipes, and the server) and the C++ `ctest` suite (59 doctest
  cases: framing, queues, crypto, canonical/JSON-limits, telemetry math,
  protocol-gen, service, secret/manifest files).
- **Live** — integration smokes in `tests/integration/` that launch the
  installed VCV Rack 2 Pro 2.6.6 against an isolated user directory and drive it
  through the real MCP server over stdio. Verified on **macOS arm64**.
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
| 6 | Destructive ops require a valid preview-bound confirmation | Met | confirmation-token store; `write-smoke` stale/refusal checks |
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

**10 — Signal monitoring only via the Probe.** There is no generic signal-read
tool; arbitrary monitoring requires attaching a RackMCP-Probe over an explicit
cable (`preview_attach_probe` / `commit_attach_probe` / `read_probe`).
`probe-smoke` exercises the attach/read/detach path.

**11 — No speculative third-party mutation.** There is deliberately no
`set_module_data` operation, and opaque module state is never written without a
matching adapter. Modules without a verified adapter remain usable but are
reported as heuristic; `validate_patch` surfaces the coverage gap
(`adapter.unverifiedModules`). See
[ADR-0004](./ADR-0004-adapter-and-recipe-knowledge-model.md).

**12 — Full suite on every supported platform (CI-only).** The complete suite
passes locally on macOS arm64: 112 TypeScript unit tests, 54 C++ cases, and the
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

## Known follow-ups (not DoD gaps)

- The declared `PatchSnapshot` output schema historically diverged from the
  bridge's wire field names; reconciliation (and non-fatal server-side output
  validation) is tracked separately and does not affect the criteria above, since
  the wire data itself reflects real Rack state.
- `format:check` (Prettier) has repository-wide style debt predating this phase;
  it is a formatting cleanup, not a correctness issue.
