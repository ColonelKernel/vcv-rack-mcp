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
| Linux | `~/.Rack2` | `~/.Rack2/log.txt` |

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
  so you can reason about routing statically.

### The Probe for signal-level diagnosis

When the graph looks correct but the sound is wrong, attach a
[Probe](./tool-reference.md) to the suspect signal and read it. `read_probe` returns
per-channel statistics — `min`, `max`, `peakAbs`, `rms`, `mean` (the DC component),
`clippedCount`, `nonFiniteCount`, and an optional gate `edgeCount` — plus `channelCount`,
`sampleRate`, `windowFrames`, `droppedFrames`, and a monotonic `sequence`. That tells you
exactly where a signal dies: a `peakAbs` of zero at a probe point means nothing is
arriving there; a rising `nonFiniteCount` means NaN/Inf is being produced upstream.

Probe telemetry is only meaningful while the engine is running. If `read_probe` returns
`TELEMETRY_UNAVAILABLE`, or every stat is zero while `engineFrame` is not advancing, the
engine is idle — reason from `validate_patch` / `describe_patch` instead of the numbers.

## Error codes

Every code below is stable and will never be renumbered or renamed. `Retry safe` and
`Mutation may have occurred` are the defaults the server attaches to each code.

| Code | Retry safe | Mutation may have occurred | Meaning and resolution |
| --- | --- | --- | --- |
| `RACK_NOT_FOUND` | yes | no | No live Rack instance with the RackMCP plugin was discovered. Confirm Rack is running with a Bridge module loaded, and that the server points at the same Rack user directory. See [discovery](#the-server-cant-find-my-rack-instance). |
| `BRIDGE_NOT_READY` | yes | no | The instance was found but its bridge service is not yet accepting requests. Wait briefly and retry; check the Bridge panel for connection status. |
| `INSTANCE_NOT_SELECTED` | yes | no | A tool needing an instance was called before one was selected. Call `select_rack_instance` (after `list_rack_instances`) and retry. |
| `WRITER_LEASE_REQUIRED` | yes | no | A mutating tool was called without holding the single-writer lease. Call `acquire_writer_lease`, then retry. |
| `LEASE_HELD` | yes | no | Another client already holds the writer lease. Wait for it to be released (lease ownership is shown on the Bridge panel) and retry. |
| `AUTHENTICATION_FAILED` | no | no | The HMAC-SHA256 pairing challenge did not match. The server and plugin must resolve the same `<RackUserDir>/RackMCP/secret`. If the secret was rotated, use **Reset pairing** on the Bridge panel and reconnect. |
| `PROTOCOL_VERSION_MISMATCH` | no | no | The plugin and server speak different protocol versions. Update both to a matching release (plugin `plugin.json` and the server bundle). |
| `STALE_PATCH_EPOCH` | no | no | A ref was bound to an older `patchEpoch` (the patch was loaded, cleared, restored, or replaced). Re-snapshot the patch and rebuild your refs, then retry. |
| `PATCH_CONFLICT` | no | no | At commit time the patch's `baseFingerprint` no longer matched what `preview_patch_transaction` saw (the patch changed in between). Re-run the preview and commit the fresh plan. See [stale commits](#my-commit-was-rejected-as-stale). |
| `CONFIRMATION_EXPIRED` | no | no | The confirmation token from a preview is older than its 5-minute lifetime. Re-run the preview to obtain a fresh token, then commit promptly. |
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
