# Troubleshooting Rack MCP

This guide covers how to diagnose problems with Rack MCP using its logs, the MCP
diagnostic surfaces, and the Probe. It also lists the error codes you are most likely
to hit and how to resolve each one, followed by walkthroughs for the most common
failure scenarios.

Every tool error carries a stable [error code](#error-codes), a `retrySafe` flag
(safe to retry with no risk of a duplicate effect), and a `mutationMayHaveOccurred`
flag (the change may already have landed — only retry with the **same** `operationId`
so the idempotency cache can suppress reapplication). Read those two flags before you
retry anything.

Two more things to read on a failed mutating call:

- **The same `operationId` must mean the same request.** The plugin's idempotency
  cache is keyed by the operation id *and* a fingerprint of the request (method plus
  the payload minus the `scope`/`expectedFingerprint`/`expectedPatchEpoch` guards, so
  a legitimate retry that lands after an unrelated patch change still replays).
  Reusing an id for a *different* request is refused with `BAD_REQUEST` and nothing
  is executed or replayed.
- **A failed `commit_patch_transaction` carries a rollback report.** The structured
  error now includes a `rollback` object with `rolledBack` (`"complete"` or
  `"indeterminate"`), `failedOperationIndex`, `inversesExecuted`, and `detail`.
  `"complete"` means the plugin proved the patch fingerprint is back to its
  pre-transaction value; `"indeterminate"` (which comes with `ROLLBACK_FAILED` and
  `mutationMayHaveOccurred: true`) means it could not, and the patch may be partly
  changed — re-read the snapshot before doing anything else.

For the full tool contract see the [tool reference](./tool-reference.md); for server
setup see the [configuration examples](./configuration-examples.md).

## Where to look first

There are five diagnostic surfaces. In rough order of how often they help:

| Surface | What it tells you | How to read it |
| --- | --- | --- |
| MCP tool error | Which stable code failed, and its retry semantics | The `code`, `message`, `retrySafe`, `mutationMayHaveOccurred` fields on the failed call |
| `rack://status` resource | Discovery + connection + live metrics in one read | Read the resource from your MCP client, or call `get_rack_status` |
| Server stderr | Server-side diagnostics (discovery, bridge, auth, config) | The process's stderr stream, as JSON lines |
| Audit log | The recent history of tool calls and their outcomes | `<RackUserDir>/RackMCP/audit/audit.log`, or the `rack://audit/recent` resource |
| Rack `log.txt` | Plugin- and engine-side events inside Rack itself | `<RackUserDir>/log.txt` |

### Rack's `log.txt`

Rack writes its own log at the root of the Rack user directory. The plugin logs bridge
startup, pairing, and persistence events there. Default locations (Rack 2):

| Platform | Rack user directory | Log file |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Rack2` | `~/Library/Application Support/Rack2/log.txt` |
| Windows | `%LOCALAPPDATA%\Rack2` | `%LOCALAPPDATA%\Rack2\log.txt` |
| Linux | `~/.local/share/Rack2` | `~/.local/share/Rack2/log.txt` |

If you launched Rack against a non-default user directory, `log.txt` lives under **that**
directory. The MCP server must be pointed at the same directory (see
[isolated user dirs](#the-server-cant-find-my-rack-instance)).

The secret at `<RackUserDir>/RackMCP/secret` and opaque module data are never written to
any log.

### The server's stderr diagnostics

The MCP server reserves stdout for MCP protocol traffic; **all** diagnostics go to
stderr as one JSON object per line:

```json
{"ts":"2026-09-01T18:22:04.117Z","level":"warn","msg":"discovery manifest stale","instanceId":"…"}
```

Raise verbosity with `RACKMCP_LOG_LEVEL` (`debug` | `info` | `warn` | `error`; default
`info`). How you capture stderr depends on the host — most MCP hosts route a launched
server's stderr into their own log files. To see it directly, run the bundle yourself and
redirect:

```bash
RACKMCP_LOG_LEVEL=debug node /abs/path/rack-mcp-server.mjs 2> rack-mcp.stderr.log
```

### The audit log

Every tool invocation is appended to an audit log at
`<RackUserDir>/RackMCP/audit/audit.log` (directory mode `0700`), one JSON object per line.
Each entry records the timestamp, tool name, outcome, and — when present — the instance
id, operation id, error code, and duration:

```json
{"ts":"2026-09-01T18:22:07.902Z","tool":"commit_patch_transaction","outcome":"error","instanceId":"…","operationId":"…","errorCode":"PATCH_CONFLICT","durationMs":41}
```

Secrets and opaque module data are never recorded. The most recent 50 entries are also
available without touching the filesystem through the `rack://audit/recent` resource — use
it to see, in order, which tool failed and with which `errorCode`.

### `rack://status` and `get_rack_status` metrics

`rack://status` returns discovery + connection state plus a `status` and `metrics` block
for the selected instance (it degrades to `connected:false` with a hint when no instance
is selected). The same data is available as a tool via `get_rack_status`. The metrics are
the fastest way to tell a stuck queue from an idle engine:

| Metric | Reading it |
| --- | --- |
| `commandQueueDepth`, `commandQueueMaxDepth` | Backlog on the UI-thread command pump; a persistently high depth means work is not draining |
| `uiPumpLastDrainMs`, `uiPumpMaxDrainMs` | How long the last / worst UI-thread drain took |
| `requestLatencyEwmaMs` | Smoothed round-trip latency |
| `requestsHandled`, `requestTimeouts` | Throughput and how many calls hit the deadline |
| `rollbacks` | Failed commits that were inverted |
| `authFailures` | Rejected pairing challenges |
| `droppedTelemetryFrames`, `bridgeReconnects` | Telemetry backpressure and bridge churn |
| `engineFrame`, `engineBlock` | Whether the audio **engine is actually running** — see below |

If `engineFrame` is not advancing between two reads, the Rack engine is idle: no audio is
being processed, so Probe telemetry will read zero regardless of the patch. This is
central to the [silent-patch](#the-patch-is-silent) and
[automated-launch](#no-sound-or-the-probe-reads-zero-on-an-automated-launch) scenarios.

### `validate_patch` and `describe_patch`

Two read-only analysis tools should be your first move on any "the patch is wrong"
report, because neither needs a running engine:

- `validate_patch` runs the rule set and returns structured findings (e.g. dangling
  cables, missing audio destination, unresolved roles). Start here.
- `describe_patch` gives a human-readable account of the modules, cables, and signal flow
  so you can reason about routing statically. Each chain reads
  `Signal path into <destination>: A → B → C`, where **every arrow is a real cable**;
  anything else feeding that destination is listed separately after
  `; also feeding it:` as individual `X → Y` edges rather than being folded into the
  arrow chain. So a name missing from the headline chain is not missing from the
  patch — look at the "also feeding it" clause and at `moduleIds` before concluding a
  module is unconnected.

### The Probe for signal-level diagnosis

When the graph looks correct but the sound is wrong, attach a
[Probe](./tool-reference.md) to the suspect signal and read it. `read_probe` returns
per-channel statistics — `min`, `max`, `peakAbs`, `rms`, `mean` (the DC component),
`clippedCount`, `nonFiniteCount`, and an optional gate `edgeCount` — plus `channelCount`,
`sampleRate`, `windowFrames`, `droppedFrames`, and a monotonic `sequence`. That tells you
exactly where a signal dies: a `peakAbs` of zero at a probe point means nothing is
arriving there; a rising `nonFiniteCount` means NaN/Inf is being produced upstream.

`min` and `max` cover only the samples that actually arrived on that channel, so a cable
patched (or a polyphonic channel appearing) part-way through a window reports the real
range rather than one stretched to include 0 V. `mean` and `rms` are still divided by the
whole window, so for such a partial window they read low — a steady +5 V that arrives a
fifth of the way in reports `min` and `max` of 5 with a `mean` near 4. Compare the next
full window before drawing conclusions from `mean` or `rms`.

Probe telemetry is only meaningful while the engine is running. If `read_probe` returns
`TELEMETRY_UNAVAILABLE`, or every stat is zero while `engineFrame` is not advancing, the
engine is idle — reason from `validate_patch` / `describe_patch` instead of the numbers.

## Error codes

Every code below is stable and will never be renumbered or renamed. `Retry safe` and
`Mutation may have occurred` are the usual semantics for each code; a particular
failure can carry different flags (a refused destructive commit is retry-safe even
when its code normally is not), so read the flags on the error you actually got.

| Code | Retry safe | Mutation may have occurred | Meaning and resolution |
| --- | --- | --- | --- |
| `RACK_NOT_FOUND` | yes | no | No live Rack instance with the RackMCP plugin was discovered. Confirm Rack is running with a Bridge module loaded, and that the server points at the same Rack user directory. See [discovery](#the-server-cant-find-my-rack-instance). |
| `BRIDGE_NOT_READY` | yes | no | The instance was found but its bridge service is not yet accepting requests. Wait briefly and retry; check the Bridge panel for connection status. |
| `INSTANCE_NOT_SELECTED` | no | no | A tool needing an instance was called with more than one live instance and none selected. Call `select_rack_instance` (after `list_rack_instances`) and retry. A `select_rack_instance` that fails after its pre-checks (refused handshake, auth failure) now leaves **no** instance selected rather than the previous one, so the next call lands here (or auto-selects, if only one instance is live). |
| `RACK_DISCONNECTED` | no | yes | The bridge connection dropped while this request was in flight. The server cannot know whether the UI thread applied it, so this is reported as an unknown outcome: retry a mutating tool only with the **same** `operationId`. The next tool call reconnects on its own. |
| `WRITER_LEASE_REQUIRED` | yes | no | A mutating tool was called without holding the single-writer lease — either at enqueue, or because the lease lapsed or moved to another connection while the command sat in the UI-thread queue (it is re-checked immediately before execution, so nothing runs on a lease you no longer hold). Call `acquire_writer_lease`, then retry. |
| `LEASE_HELD` | yes | no | Another client already holds the writer lease. Wait for it to be released (lease ownership is shown on the Bridge panel) and retry. |
| `AUTHENTICATION_FAILED` | no | no | The HMAC-SHA256 pairing challenge did not match. The server and plugin must resolve the same `<RackUserDir>/RackMCP/secret`. If the secret was rotated, use **Reset pairing** on the Bridge panel and reconnect. |
| `PROTOCOL_VERSION_MISMATCH` | no | no | The plugin and server speak different protocol versions. Update both to a matching release (plugin `plugin.json` and the server bundle). |
| `STALE_PATCH_EPOCH` | no | no | A ref was bound to an older `patchEpoch` (the patch was loaded, cleared, restored, or replaced), or an `expectedPatchEpoch` you supplied no longer matches. A replacement made in **Rack's own UI** (File > New / Open / Revert, drag-and-drop) now bumps the epoch too — the plugin polls for it about twice a second — so refs taken before the user opened another patch stop validating. Re-snapshot the patch and rebuild your refs, then retry. |
| `PATCH_CONFLICT` | no | no | The patch changed between the state you expected and the one the server found — at a transaction commit, at a `preview_patch_transaction` / `build_patch` that declared `expectedFingerprint`, or at a load/clear/restore commit. Re-run the preview and commit the fresh plan. See [stale commits](#my-commit-was-rejected-as-stale). |
| `CONFIRMATION_REQUIRED` | no | no | The commit was sent without a token, or with one that does not bind it: wrong instance or session, wrong kind (a `preview_load_patch` token handed to `restore_checkpoint`, or vice versa), or a `checkpointPath` the token was not issued for. Re-run the matching preview and use its token. |
| `CONFIRMATION_EXPIRED` | no | no | The confirmation token is past its 5-minute lifetime, **or** it has already been used: load, clear, and restore tokens are single-use. Re-run the preview to obtain a fresh token, then commit promptly. |
| `VALIDATION_FAILED` | no | no | A previewed operation cannot be applied to the current patch — e.g. `remove_module` with `cablePolicy: "fail_if_connected"` on a module that still has cables attached. Fix the plan and preview again. Also reported when a transaction failed mid-apply and was **fully rolled back**. |
| `UNSUPPORTED_OPERATION` | no | no | The plan contains an operation the plugin cannot execute; `duplicate_module` is currently one of them, and is now rejected at preview rather than failing at commit. Also raised when a plan would remove the last RackMCP-Bridge module without `allowLastBridge`. |
| `BAD_REQUEST` | no | no | The `operationId` was already used for a different request. Retry the original request unchanged, or use a fresh id. Note that `create_checkpoint` computes a new timestamped path on every call, so a same-id retry of it always lands here. |
| `ROLLBACK_FAILED` | no | yes | A commit failed and the plugin could not prove the rollback was complete. Read the `rollback` report on the error, then take a fresh `get_patch_snapshot` before doing anything else. |
| `PATH_NOT_ALLOWED` | no | no | A patch-file path fell outside the allowed patch/checkpoint locations under the Rack user directory. Use a path within the configured roots. |
| `TRANSACTION_TOO_LARGE` | no | no | The plan exceeded 128 operations or 32 added modules. Split it into smaller transactions and preview/commit each. |
| `RATE_LIMITED` | yes | no | You exceeded a rate limit (30 parameter changes/s per client, or the ≤20 Hz probe reporting rate). Back off and retry. |
| `TIMEOUT` | no | yes | The command did not complete within its deadline (5 s default; 60 s for patch load/save). Because a mutation may already have landed, retry mutating tools only with the **same** `operationId`. Check `commandQueueDepth` and whether the engine is stalled. |

Two related codes worth knowing: `RESULT_TOO_LARGE` (a structured result exceeded the
4 MiB cap — narrow the request or paginate) and `TELEMETRY_UNAVAILABLE` (no telemetry for
a probe read; usually an idle engine). The full list lives in the
[error contract](../spec/rack-mcp-spec.md#12-error-contract).

## Common scenarios

### The server can't find my Rack instance

Symptom: `list_rack_instances` returns nothing, or tools fail with `RACK_NOT_FOUND`.

Discovery works through a per-launch manifest that Rack writes to
`<RackUserDir>/RackMCP/instances/<instanceId>.json` and refreshes with a heartbeat about
every 2 seconds. The server treats a manifest as stale after 10 seconds and also checks
that the owning process is still alive, so a crashed or exited Rack disappears from the
list.

Work through this checklist:

1. **Is Rack actually running with a Bridge module?** The manifest is only written while a
   Bridge module is loaded. Open the Bridge panel and confirm it reports a listening
   service.
2. **Do the server and Rack share one user directory?** This is the most common cause. The
   server derives discovery, checkpoints, and audit from a single Rack user directory. If
   Rack runs against an isolated or non-default directory, point the server at it with
   `RACKMCP_RACK_USER_DIR`:

   ```bash
   RACKMCP_RACK_USER_DIR="/path/to/Rack2" node /abs/path/rack-mcp-server.mjs
   ```

   There is no separate discovery-directory setting — the instances, checkpoints, and
   audit directories are all derived from the user directory.
3. **Is the manifest fresh?** List `<RackUserDir>/RackMCP/instances/` and check the
   modification time. A file older than ~10 seconds is stale (Rack is not heartbeating);
   a missing file means the plugin never started its discovery writer. The server's stderr
   logs a `discovery manifest stale` line in this case.

### My commit was rejected as stale

Symptom: `commit_patch_transaction` (or `commit_load_patch` / `commit_clear_patch`) fails
with `PATCH_CONFLICT`, or a ref-bearing call fails with `STALE_PATCH_EPOCH`.

The transaction model is two-phase for exactly this reason. `preview_patch_transaction`
computes a `baseFingerprint` (a SHA-256 over a canonical dump of the whole patch) and a
`planHash`, and the server issues a confirmation token bound to
`{instance, session, epoch, baseFingerprint, planHash}`. At commit the plugin re-hashes
the current patch and refuses if the fingerprint changed. So if **anything** altered the
patch between preview and commit — you dragged a cable, turned a knob, or another edit
landed — the fingerprint no longer matches and the commit is correctly rejected rather
than applied on top of an unexpected state.

Resolution: re-run the preview against the current patch and commit the fresh plan. If the
patch was loaded, cleared, or restored (which bumps `patchEpoch`), you will see
`STALE_PATCH_EPOCH` instead — take a new `get_patch_snapshot`, rebuild refs from it, and
preview again. Neither code is `retrySafe` with the old token: do not reuse the stale
confirmation.

Three places the same two codes now surface that they did not before:

- **At the preview.** `preview_patch_transaction` and `build_patch` enforce the
  `expectedFingerprint` / `expectedPatchEpoch` guards you declare, instead of ignoring
  them. A mismatch is rejected before a plan is cached or a token minted, so a rejected
  preview leaves nothing committable.
- **At a load, clear, or restore commit.** Those confirmations are now bound to the patch
  epoch and fingerprint the preview saw and re-verified before anything is destroyed, so
  `commit_load_patch` / `commit_clear_patch` / `restore_checkpoint` fail with
  `PATCH_CONFLICT` or `STALE_PATCH_EPOCH` if the patch moved in between. The fingerprint
  covers the whole serialized patch including UI state, so a knob turned while a human
  considers the confirmation is enough to invalidate it.
- **On a second use of the same token.** Load, clear, and restore tokens are single-use;
  re-sending one (a retry after a lost response included) gives `CONFIRMATION_EXPIRED`.
  Re-run the preview — it reports the true current state, so a lost response is never
  ambiguous.

### My plan stopped at a preview instead of committing

Symptom: `build_patch` returns `phase: "previewed"` with a confirmation token even though
you passed `autoCommit: true`, or a preview that used to pass now fails outright.

`build_patch` never bypasses a confirmation: if the preview's
`risk.confirmationRequired` is true, it stops and hands you the token regardless of
`autoCommit`. That flag is true whenever the plan removes modules or cables, replaces the
cables on an input, removes a RackMCP-Bridge module, or randomizes a module. Two cases are
stricter than they used to be:

- **A plan that only disconnects ports now requires confirmation.** `disconnect_port`
  enumerates the cables it will cut at preview time, so those cables show up in
  `removedCableIds` and the plan is classified destructive. Previously a
  disconnect-only plan looked non-destructive and auto-committed. Commit it with the
  token from the preview.
- **`remove_module` with `cablePolicy: "fail_if_connected"` is now genuinely refused.**
  The preview fails with `VALIDATION_FAILED` ("has attached cables") when the module
  still has cables. The policy string used to be compared against a value the schema
  never emits, so the cables were cut anyway. If cutting them is what you want, pass
  `cablePolicy: "remove_attached"`.

Two related preview refusals arrived at the same time: `move_module` honours its
`collision` field again (with `collision: "fail"`, a target cell occupied by a module the
plan leaves in place is rejected at preview), and `duplicate_module` is rejected with
`UNSUPPORTED_OPERATION` at preview rather than mutating the patch and then throwing at
commit.

### A load failed and my rack is now empty

Symptom: `commit_load_patch` (or `restore_checkpoint`) fails with `INTERNAL` and a message
saying that Rack cleared the patch before reading the file, that the rack is now empty,
and at which patch epoch — and the rack really is empty apart from a Bridge module.

This is honest reporting, not a second fault. Rack's patch manager clears the current
patch before it reads the archive, so a load that throws (corrupt or unreadable `.vcv`)
leaves nothing behind. The plugin bumps the patch epoch — which is why every ref you held
now fails with `STALE_PATCH_EPOCH` — and reinserts a Bridge module so the instance stays
reachable.

The recovery checkpoint was written **before** the load, so your previous patch is safe;
its path is not carried on the error, so find it with `list_patch_files`
(`root: "checkpoints"`, newest `..._recovery.vcv`) and follow the
[recover-from-a-bad-load](./backup-and-recovery.md#procedure-recover-from-a-bad-load)
procedure. A failure *before* the load — most often the recovery checkpoint itself failing
to write — leaves the patch untouched instead; see [automatic recovery
checkpoints](./backup-and-recovery.md#automatic-recovery-checkpoints).

### The patch is silent

Symptom: the patch loads and looks right, but there is no sound (or far too little).

Use the `troubleshoot_silence` prompt, which drives this exact sequence, or run it by
hand:

1. **Analyze statically first.** Run `validate_patch` for structural faults (no path to
   the audio destination, dangling or missing cables) and `describe_patch` to read the
   signal flow. Common culprits: a bypassed module, a fully closed filter cutoff, a VCA at
   zero level, or an envelope that never opens.
2. **Confirm the engine is running.** Read `get_rack_status` (or `rack://status`) and
   check that `engineFrame` advances between two reads. If it does not, the engine is idle
   and no probe will read a signal — jump to the [automated-launch
   scenario](#no-sound-or-the-probe-reads-zero-on-an-automated-launch).
3. **Probe the signal path.** Attach a Probe near the suspected break and `read_probe`.
   Trace from the Core Audio destination back toward the sources: the first probe point
   whose `peakAbs` is zero (while an upstream point is non-zero) brackets where the signal
   dies. A climbing `nonFiniteCount` points to a NaN/Inf source; a high `clippedCount`
   points to overload rather than silence.

Report the root cause and the smallest fix, and apply it through the normal
preview/commit path.

### No sound, or the Probe reads zero, on an automated launch

Symptom: under a scripted or harness launch, every Probe stat is zero and the patch is
silent even though the graph is correct.

This is a known limitation of launching Rack non-interactively, not a Rack MCP fault. When
Rack is started by an automated harness, its audio **engine may never step** — the DSP
loop stays idle — so `engineFrame` does not advance and there is no signal for the Probe
to measure. Telemetry math is verified in the plugin's C++ tests instead of against live
voltages for this reason.

How to tell this apart from a real silence bug:

- `engineFrame` in `get_rack_status` metrics is flat across reads.
- `read_probe` returns all-zero stats, or the code `TELEMETRY_UNAVAILABLE`.
- `validate_patch` reports **no** structural problem.

When all three hold, the patch is almost certainly fine and the engine is simply idle.
Diagnose the graph from `validate_patch` / `describe_patch` rather than the telemetry
numbers, and verify audio interactively in a normally launched, foreground Rack session
where the engine runs. (A related environment note: Rack's standalone GUI can crash if the
Mac display is asleep during an automated launch, which also leaves the engine from ever
stepping — keep the display awake.)

Rack MCP is supported only in standalone GUI mode; DAW-hosted and headless Rack are
unsupported, and the idle-engine behavior above is specific to non-interactive standalone
launches.
