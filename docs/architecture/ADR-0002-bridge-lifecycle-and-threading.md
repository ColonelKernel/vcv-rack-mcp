# ADR-0002: Bridge service lifecycle and the UI-thread command-pump threading model

- Status: Accepted
- Date: 2026-08-29
- Deciders: Rack MCP project

## Context

[ADR-0001](./ADR-0001-execution-model.md) fixed the four-component execution
model and the top-level rule that socket threads never call Rack APIs. This
record specifies how that rule is actually enforced in the plugin: the exact
lifecycle of the loopback bridge service (listener, per-connection sessions,
authentication, writer lease, manifest heartbeat, and shutdown), and the
threading model that routes every Rack API call onto the UI thread.

The forces are concrete and Rack-specific:

- Rack's engine, `history::State`, `patch::Manager`, and the widget tree are
  UI-thread-owned. They are not designed for mutation from arbitrary threads,
  and a plugin that touches them off-thread produces intermittent corruption,
  not clean errors.
- `Module::process()` runs on the real-time audio thread. Blocking, locking,
  allocating, or doing I/O there causes audible dropouts.
- The bridge must accept TCP connections, frame and parse untrusted JSON, run a
  challenge-response handshake, and keep a discovery manifest fresh — none of
  which may stall the audio thread or the UI, and all of which must tear down
  deterministically when the plugin is unloaded (patch reload, quit, or plugin
  reset), because Rack calls the plugin's `destroy()` synchronously.

The relevant implementation lives in
`plugins/RackMCP/src/rackside/RackBridge.cpp` (the plugin-global singleton and
its lifecycle) and `plugins/RackMCP/src/core/service.cpp` (`BridgeServer`, the
transport and session state machine).

## Decision

### Three thread classes, one owner per Rack API

We partition all work into three disjoint thread classes and let exactly one of
them call Rack APIs.

| Thread class | Members | May call Rack APIs? | What it does |
| --- | --- | --- | --- |
| Network | accept thread, one reader + one writer thread per connection, heartbeat thread | **No** | frame/parse/validate/auth, lease bookkeeping, enqueue commands, write responses, refresh the manifest (filesystem + cached state only) |
| UI | the command-pump widget on `APP->scene` | **Yes — exclusively** | drains the bounded command queue with a per-frame budget, runs every engine/history/patch/widget call, publishes a UI-state snapshot back for the network threads |
| Audio | `Module::process()` for Bridge and Probe | **No** | atomic-flag reads only; the Probe publishes telemetry through a lock-free double buffer |

The network threads and the UI thread communicate through two lock-free/bounded
queues: a **command queue** (network → UI) and each session's **outbound queue**
(UI or network → that connection's writer). No shared Rack object is touched
from more than one thread.

### Bridge service lifecycle

Startup is driven by `RackBridge::start()`, guarded by an atomic `started_` flag
so it runs once per Rack launch:

1. Resolve paths from `rack::asset::userDir`: `<userDir>/RackMCP`,
   `<userDir>/RackMCP/instances`, `<userDir>/RackMCP/checkpoints`, and
   `<userDir>/patches`. Read `rack::APP_VERSION` and `rack::APP_EDITION`
   (normalized to `Free` / `Pro` / `unknown`).
2. Create the private directory tree (`0700`) and load-or-create the 256-bit
   pairing secret via `loadOrCreateSecret`. If either fails the bridge stays
   disabled and logs a `WARN` — Rack keeps running normally.
3. Mint `instanceId = uuid4()` and `sessionId = uuid4()`, record an ISO start
   time, and hand a `ServiceConfig` (secret, ids, bridge/rack versions,
   edition) to `BridgeServer::start()`.
4. `BridgeServer::start()` validates the secret length (32 bytes),
   initializes sockets, binds a loopback listener on an **ephemeral** port
   (`listener_.listen(0)`), records the OS-assigned port, and spawns the accept
   thread.
5. Start the heartbeat thread, which writes the discovery manifest immediately
   and then every ~2 s.

The accept loop (`BridgeServer::acceptLoop`) polls `accept` with a 250 ms
timeout so it can observe the `stopping_` flag, reaps any defunct sessions,
enforces `maxConnections` **and** `maxUnauthConnections` (over-limit clients are
counted in `connectionsRefused` and closed immediately), and otherwise creates a
`Session` with its own reader and writer thread, stamping `connectedAtMs` at
accept.

Two limits bound what a peer that does not hold the pairing secret can consume.
`maxUnauthConnections` (default 4 of `maxConnections`'s 8) counts sessions that
have not yet flipped `authed`, so half the slots stay reserved for peers that
completed the handshake. `handshakeTimeoutMs` (default 10 s; the first-party
client allows 5 s each for `connect` and `authenticate`, so it never fires for a
healthy peer) bounds how long one of those slots can be held: the reader loop
checks the deadline at the top of every
iteration, so a peer that idles *or* dribbles bytes without finishing
`hello`/`auth` is dropped and counted in `handshakeTimeouts`. The check is
evaluated at `readPollMs` (250 ms) granularity, so the effective deadline can be
one poll late, and it only ever applies before `Ready` — a long-lived idle
authenticated session is untouched.

### Per-connection session state machine

Each connection is a small state machine driven entirely on its reader thread by
`BridgeServer::handleFrame`, with no Rack API involved:

```
ExpectHello ──hello (versions ∋ BRIDGE_PROTOCOL_VERSION)──▶ ExpectAuth ──auth (HMAC ok)──▶ Ready
     │ else                                                     │ else
     ▼                                                          ▼
  PROTOCOL_VERSION_MISMATCH, close                        AUTHENTICATION_FAILED, close
```

- **`hello` → `welcome`.** The client's `versions` array must contain
  `gen::BRIDGE_PROTOCOL_VERSION`; otherwise the session is closed with
  `PROTOCOL_VERSION_MISMATCH`. On success the server generates a per-connection
  32-byte hex `nonce` and replies with a `welcome` carrying the protocol
  version, `instanceId`, `sessionId`, bridge/rack versions, edition, the current
  `patchEpoch`, and the nonce.
- **`auth`.** The client returns `hmac = HMAC-SHA256(secret, authMessage(nonce,
  instanceId, sessionId))` as 64 hex chars. The server recomputes the expected
  value and compares with `constantTimeEqual`. The nonce is single-use (cleared
  before the comparison), so a second attempt requires a fresh connection. The
  secret never crosses the wire. Success flips the session to `Ready` and
  increments `authedSessions_`; failure increments `authFailures` and closes.
- **`Ready`.** `ping` → `pong`; `req` → `handleRequest`; anything else is a
  protocol error and closes the connection. Every request frame carries a
  16-hex `id`, a known `method` (looked up in the generated `gen::METHOD_SPECS`
  table), and a `deadlineMs` in `[1, 600000]`.

Frames are validated against the generated protocol tables and JSON limits
(`checkJsonLimits` with `gen::LIMIT_JSON_MAX_DEPTH`,
`gen::LIMIT_JSON_MAX_TOTAL_NODES`, `gen::LIMIT_JSON_MAX_STRING_BYTES`) before any
dispatch — see [ADR-0003](./ADR-0003-canonical-schema-codegen.md) for where
those tables come from.

### Writer lease and command handoff

The single-writer lease (ADR-0001) is enforced on the reader thread, before any
command reaches the UI:

- `lease.acquire` / `lease.renew` / `lease.release` are handled **inline** on
  the network thread (`handleLeaseRequest`) — they touch only the
  `LeaseManager`, never Rack. Acquisition returns a `leaseId` and TTL, or
  `LEASE_HELD` naming the current holder. The Bridge panel reads a cached
  `leaseHeldHint_`/holder for display.
- A request whose `MethodSpec.mutating` flag is set must carry a 36-char UUID
  `operationId` (else `BAD_REQUEST`) and must come from the current writer
  (`leases_.holder(now)` must be held by this connection, else
  `WRITER_LEASE_REQUIRED`). Read-only requests skip both checks.
- A validated command becomes a `BridgeCommand` (connection id, request id,
  method, operationId, deadline, the method's `mutating` flag, the `leaseId`
  that authorized it, and an incref'd `payload`) and is pushed to the
  command queue via `callbacks_->enqueueCommand`. `RackBridge::enqueueCommand`
  fails fast with `BRIDGE_NOT_READY` when no command pump is attached, so a
  client sees an immediate error rather than a timeout when there is no Bridge
  module in the patch to drain the queue.
- The enqueue-time gate is **not** the last word. A command can sit in the queue
  while the lease lapses, is released, or is acquired by another connection, so
  `CommandPumpWidget::step` calls `BridgeServer::commandLeaseStillValid(cmd)`
  immediately before executing and replies `WRITER_LEASE_REQUIRED`
  (`retrySafe: true`) instead of mutating when the lease no longer matches the
  recorded `leaseId` *and* connection. Non-mutating commands always pass. This
  sits next to the pump's existing deadline check, which answers `TIMEOUT`
  without executing a command whose `deadlineAtMs` has already passed.

Responses and events flow the other way through UI-thread entry points:
`sendFrame` targets one connection's outbound queue; `broadcastEvent` fans out
to all authenticated sessions; a full outbound queue drops the frame and counts
it in `responseDrops` rather than blocking.

### Manifest heartbeat

The heartbeat thread (`heartbeatLoop`) does filesystem and cached-state work
only. Every ~2 s it snapshots the UI-published `UiStateCache` and writes the
discovery manifest via an atomic rename (`writeManifest`), carrying
`instanceId`, PID, rack/bridge versions, `bridgeProtocolVersion`, the ephemeral
`port`, start and last-heartbeat timestamps, patch name, the
`commandPumpPresent` / `bridgeModulePresent` flags, and the user/patches/
checkpoints directories. It never reads Rack state directly — the UI thread
pushes state into the cache through `publishUiState`, and the heartbeat thread
only reads that cache under a mutex. This is what lets discovery survive even
while the audio engine is busy.

### Deterministic shutdown in `destroy()`

> **Only `destroy()` may join threads.** An earlier implementation stopped the
> bridge from a namespace-scope static destructor instead, on the mistaken
> premise that Rack had no plugin-level `destroy()`. That was wrong twice over:
> the function-local `RackBridge` singleton is destroyed *before* such a static
> (so `~std::thread` on the still-running heartbeat thread called
> `std::terminate()` on every quit), and on Windows the static destructor runs
> inside `FreeLibrary`/`DllMain` under the loader lock, where a join deadlocks.
> `tests/integration/src/quit-smoke.ts` exercises the real quit path.

`RackBridge::stop()` (called from the plugin's `destroy()`) is ordered so no
thread can touch a freed resource:

1. `started_.exchange(false)` guards against double-stop.
2. Broadcast a `shutting_down` event to connected clients.
3. Signal and join the heartbeat thread.
4. `commandQueue_.close()`, then `BridgeServer::stop()`: set `stopping_`, close
   the listener, join the accept thread, and take the session map. Then, for
   **all** sessions in this order: close every outbound queue, wait for the
   writers against one *shared* ~1 s deadline, and only afterwards close each
   stream and join its reader and writer threads.

   The ordering matters. Closing the queue is what makes a writer drain and
   exit, so it has to come first; closing the stream first would discard the
   `shutting_down` event and any in-flight responses still queued. The deadline
   is shared across sessions rather than per session, so total shutdown stays
   bounded no matter how many connections are open. A session's own reader has
   the same ~1 s flush window for its last frame (e.g. an auth error) when it
   exits on its own.
5. Remove the discovery manifest.
6. Drain any commands the pump never got to and `json_decref` their payloads.
7. Scrub the in-memory secret (`std::fill(secret_.begin(), secret_.end(),
   '\0')`).

`resetPairing()` reuses the same stop/restart sequence: it rotates the secret on
disk, broadcasts `shutting_down`, restarts `BridgeServer` with the new secret
(same `instanceId`/`sessionId`), and rewrites the manifest — existing clients
are forced to re-pair.

## Consequences

- Because only the command-pump widget calls Rack APIs, correctness does not
  depend on Rack internals being thread-safe. The cost is that every mutation
  takes a queue hop and is bounded by the per-frame drain budget; throughput is
  deliberately capped in favor of never stalling audio or the UI.
- A patch with no Bridge module has no command pump, so mutating requests fail
  immediately with `BRIDGE_NOT_READY` (`commandPumpPresent` is advertised in the
  manifest and status). Read-only discovery and authentication still work,
  since those never enqueue Rack work.
- The heartbeat's reliance on a cached UI snapshot means the manifest can lag
  real state by up to one publish/heartbeat interval; consumers already treat a
  manifest as stale after 10 s and re-check PID liveness, so the small lag is
  acceptable.
- The join-based shutdown blocks `destroy()` briefly (accept-poll timeout plus
  the ~1 s writer flush window). This is intentional: a deterministic teardown
  that removes the manifest and scrubs the secret is worth a short, bounded
  pause at unload.
- Refusals and drops are *counted* rather than silently swallowed:
  `connectionsRefused`, `handshakeTimeouts`, `responseDrops`, `protocolErrors`.
  Of the `ServiceCounters`, however, only `authFailures` and
  `connectionsAccepted` (reported as `bridgeReconnects`) currently reach a
  client through `metrics.get`; the rest are plugin-internal, so an overloaded
  or over-connected bridge is not yet observable through `get_rack_status` (see
  the [tool reference](../tools/tool-reference.md)).
