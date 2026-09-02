# Local bridge protocol

The **bridge protocol** is the private wire protocol between the Rack MCP
TypeScript server and the `RackMCP` C++ plugin running inside VCV Rack. It is a
versioned, length-prefixed JSON protocol carried over a loopback-only TCP
connection. The MCP server is the only supported client; it translates the
public [MCP tool surface](../tools/tool-reference.md) into the internal RPC
calls described here.

> **Scope.** The 19 RPC methods in this document are the plugin's *internal*
> bridge API. They are **not** the 29 MCP tools. One MCP tool can map to several
> bridge calls (for example `build_patch` drives `txn.preview` then
> `txn.commit`), and several bridge methods (`patch.fingerprint`, `metrics.get`)
> are plumbing that no single tool exposes directly. Never confuse a bridge
> method name with a tool name.

This specification is derived from the reference implementation:

- Framing codec: `plugins/RackMCP/src/core/framing.hpp`, `framing.cpp` (C++);
  `packages/protocol/src/framing.ts` (TypeScript).
- Frame builders and the auth message: `plugins/RackMCP/src/core/frames.hpp`,
  `frames.cpp`.
- Server state machine and dispatch: `plugins/RackMCP/src/core/service.cpp`,
  `service.hpp`.
- Loopback listener: `plugins/RackMCP/src/core/tcp.cpp`.
- Wire schemas (Zod): `packages/schemas/src/bridge.ts`.
- Client: `packages/protocol/src/client.ts`.

It corresponds to section 3.3 of the [full specification](../spec/rack-mcp-spec.md).

## 1. Transport

The plugin's `BridgeServer` opens a TCP listener bound **only** to the IPv4
loopback address:

- The socket binds `INADDR_LOOPBACK` (`127.0.0.1`), never `INADDR_ANY`. It is
  never reachable from another host.
- The port is **ephemeral**: the server calls `listen(0)` and reads the assigned
  port back with `getsockname`. Clients learn the port from the discovery
  manifest (`<RackUserDir>/RackMCP/instances/<instanceId>.json`), never by
  guessing.
- As defense in depth, `accept()` re-checks the peer address and immediately
  closes any connection whose source is not `127.0.0.1`, even though the bind
  should already prevent non-loopback peers.
- `TCP_NODELAY` is set on every accepted connection; the client connects with
  `noDelay: true`.
- The listen backlog is 8. Concurrent connections are capped by
  `maxConnections` (default **8**). A connection accepted past the cap is closed
  immediately and counted in `connectionsRefused`.

Each connection is served by a dedicated reader thread and writer thread inside
the plugin. Network threads never call Rack APIs — they frame, parse, validate,
authenticate, and enqueue; all Rack work happens later on the UI thread (see the
[execution model ADR](./ADR-0001-execution-model.md)).

## 2. Framing

Every frame on the wire is:

```
+---------------------------+------------------------------+
| length  (4 bytes, BE u32) | body (length bytes, UTF-8)   |
+---------------------------+------------------------------+
```

- **Length prefix**: a 4-byte **big-endian unsigned 32-bit** integer giving the
  byte length of the body that follows.
- **Body**: exactly that many bytes of **UTF-8 JSON** (a single JSON object).
- **Frame cap**: the body must not exceed **1 MiB** (`1 * 1024 * 1024` bytes,
  `LIMITS.bridgeFrameBytes`). The length prefix itself is not counted against the
  cap.

Encoding rejects any payload larger than the cap rather than emitting it
(`encodeFrame` returns `false` in C++, throws in TypeScript).

Decoding is incremental and identical on both sides (the C++ and TypeScript
decoders are line-for-line equivalent):

- Chunks are appended to a buffer; complete frames are pulled out one at a time.
- If a declared length exceeds the 1 MiB cap, the decoder enters a **permanent
  error state and the connection is dropped**. Resynchronizing inside a byte
  stream is not safe, so there is no recovery — the peer must reconnect.
- The receive buffer is memory-bounded: it may hold at most `2 * (maxFrameBytes
  + 4)` bytes of undrained input. Exceeding that bound is also a permanent error
  that drops the connection.

## 3. Connection lifecycle and handshake

A connection moves through three states on the server:
`ExpectHello -> ExpectAuth -> Ready`. Any frame that does not fit the current
state closes the connection.

```
client                                   plugin (BridgeServer)
  |                                              |
  |------------------ hello -------------------->|  ExpectHello
  |                                              |  (version negotiation)
  |<----------------- welcome -------------------|  -> ExpectAuth
  |                    (carries nonce)           |
  |------------------ auth ---------------------->|  ExpectAuth
  |                    (hmac over nonce)          |  (constant-time compare)
  |<---------------- authResult -----------------|  -> Ready
  |                                              |
  |=== req/res, ping/pong, evt (multiplexed) ===>|  Ready
```

### 3.1 hello and version negotiation

The client opens the exchange with a `hello` frame listing every bridge protocol
version it can speak:

```json
{"kind":"hello","versions":[1],"client":{"name":"rack-mcp-server","version":"2.0.0"}}
```

The only defined version is `BRIDGE_PROTOCOL_VERSION = 1`. The server scans the
`versions` array for a value equal to its own supported version. If none
matches, it replies with a `PROTOCOL_VERSION_MISMATCH` error frame (shaped like
an `authResult` failure) and closes the connection:

```json
{"kind":"authResult","ok":false,"error":{"code":"PROTOCOL_VERSION_MISMATCH","message":"no mutually supported bridge protocol version","retrySafe":false,"mutationMayHaveOccurred":false}}
```

### 3.2 welcome

On a successful version match the server generates a fresh 32-byte random nonce
(64 lowercase hex characters), sends a `welcome` frame, and advances to
`ExpectAuth`:

```json
{"kind":"welcome","version":1,"instanceId":"7f1c...","sessionId":"a904...","bridgeVersion":"2.0.0","rackVersion":"2.6.6","rackEdition":"Pro","patchEpoch":3,"nonce":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","authRequired":true}
```

| Field | Meaning |
| --- | --- |
| `version` | Negotiated bridge protocol version (always `1`). |
| `instanceId` | UUID identifying this Rack launch. |
| `sessionId` | UUID identifying this bridge service run. |
| `bridgeVersion` | Plugin version string. |
| `rackVersion` | Rack version string (e.g. `2.6.6`). |
| `rackEdition` | `Free`, `Pro`, or `unknown`. |
| `patchEpoch` | Current patch-epoch counter (bumped on load/clear/restore/replace). |
| `nonce` | 64-hex challenge for authentication. |
| `authRequired` | Always `true`; the client must authenticate before any RPC. |

The `nonce`, `instanceId`, and `sessionId` fed the HMAC in the next step; they
are used exactly once each per connection.

## 4. Authentication

Authentication is an HMAC-SHA256 challenge-response over the 256-bit pairing
secret stored at `<RackUserDir>/RackMCP/secret` (directory `0700`, file `0600`).
**The secret never crosses the wire and is never logged.**

The client computes the HMAC over the canonical auth message — the nonce and the
two identifiers joined with `|`:

```
authMessage = nonce + "|" + instanceId + "|" + sessionId
hmac        = HMAC-SHA256(pairingSecret, utf8(authMessage))   // 64 hex chars
```

and sends an `auth` frame:

```json
{"kind":"auth","hmac":"3b8f...<64 hex>...c1a2"}
```

The server recomputes the expected HMAC from its own copy of the secret and
compares it against the client value with a **constant-time** equality check.
The nonce is cleared immediately on receipt, so it is **single-use**: a second
auth attempt requires a brand-new connection.

- **Success** promotes the connection to `Ready` and replies:

  ```json
  {"kind":"authResult","ok":true,"role":"readonly"}
  ```

  Every authenticated connection starts **read-only**. Mutation additionally
  requires the single-writer lease (see [§6](#6-requestresponse-envelope)).

- **Failure** increments `authFailures`, replies with an `AUTHENTICATION_FAILED`
  error frame, and closes the connection:

  ```json
  {"kind":"authResult","ok":false,"error":{"code":"AUTHENTICATION_FAILED","message":"pairing secret mismatch","retrySafe":false,"mutationMayHaveOccurred":false}}
  ```

## 5. JSON boundary limits

Before any frame body is interpreted, the server parses it with duplicate object
keys rejected (`JSON_REJECT_DUPLICATES`) and applies hard structural limits.
A frame that violates any of them is a protocol error that drops the connection:

| Limit | Value |
| --- | --- |
| Maximum nesting depth | 64 |
| Maximum total JSON nodes | 250,000 |
| Maximum single string length | 256 KiB (`256 * 1024` bytes) |

These bounds are enforced independently of, and in addition to, the 1 MiB frame
cap. They exist so that an adversarial or malformed frame cannot exhaust memory
or stack before schema validation even begins.

## 6. Request/response envelope

Once `Ready`, the connection multiplexes requests. Each request is a `req`
frame; each reply is a `res` frame carrying the same `id`.

**Request** (`req`):

```json
{"kind":"req","id":"4d2f9a01bc7e5510","method":"catalog.listModels","deadlineMs":5000,"payload":{"limit":100}}
```

| Field | Rules |
| --- | --- |
| `id` | 8 random bytes as **16 lowercase hex** characters. Malformed ids drop the connection. |
| `method` | One of the [19 bridge methods](#8-rpc-method-list). Unknown methods return `UNSUPPORTED_OPERATION`. |
| `deadlineMs` | Integer in `[1, 600000]`. Out-of-range values return `BAD_REQUEST`. The server converts it to an absolute monotonic deadline. |
| `operationId` | A 36-character UUID. **Required** on mutating methods; absent/short values return `BAD_REQUEST`. Used for idempotency (results cached at least 10 minutes so a retry cannot double-apply). |
| `payload` | Method-specific object, validated against the method's schema in `packages/schemas/src/bridge.ts`. |

**Success response** (`res`):

```json
{"kind":"res","id":"4d2f9a01bc7e5510","ok":true,"payload":{"models":[],"nextCursor":null,"totalModels":0}}
```

**Error response** (`res`):

```json
{"kind":"res","id":"4d2f9a01bc7e5510","ok":false,"error":{"code":"WRITER_LEASE_REQUIRED","message":"acquire the writer lease before mutating","retrySafe":true,"mutationMayHaveOccurred":false}}
```

Every error object carries a stable `code` (see the
[error contract](../spec/rack-mcp-spec.md)), a human `message`, and two
retry-safety booleans: `retrySafe` (retrying carries no risk of duplicate
effects) and `mutationMayHaveOccurred` (the mutation may already have landed, so
retry only with the same `operationId`). Failed commits may additionally embed a
`rollback` report and arbitrary `details`.

### Dispatch and mutation gating

For each `req`, the server:

1. Validates `id`, `method`, and `deadlineMs`.
2. Handles `lease.*` methods **inline** on the network thread (no Rack APIs are
   touched, so they never enter the UI queue).
3. For a **mutating** method (`txn.commit`, `txn.undoLast`, `patchfile.save`,
   `patchfile.saveCopy`, `patchfile.load`, `patchfile.clear`), requires both a
   36-char `operationId` (`BAD_REQUEST` otherwise) and current ownership of the
   writer lease (`WRITER_LEASE_REQUIRED` otherwise).
4. Enqueues the command onto the bounded UI command pump. If that queue is full
   or unavailable, it returns `BRIDGE_NOT_READY`.

Requests are answered asynchronously as the UI thread drains the queue, so
responses for a connection may arrive in an order different from the request
order; the client correlates strictly by `id`.

## 7. Heartbeats and events

**Heartbeat.** After authenticating, the client sends a `ping` on an interval of
`bridgeHeartbeatIntervalMs` (**2000 ms**) to keep the connection warm and detect
a dead peer. The server echoes the `id` back in a `pong`:

```json
{"kind":"ping","id":"a1b2c3d4e5f60718"}
{"kind":"pong","id":"a1b2c3d4e5f60718"}
```

This connection-level heartbeat is distinct from the ~2 s **discovery-manifest**
heartbeat used for instance liveness (a manifest older than 10 s is stale). One
keeps a live TCP session warm; the other advertises the process to servers that
have not yet connected.

**Events.** The server may push unsolicited `evt` frames to every authenticated
connection:

```json
{"kind":"evt","event":"patch_epoch_changed"}
```

Defined events are `shutting_down`, `patch_epoch_changed`, and `lease_revoked`.
Events let the client invalidate cached refs (a bumped patch epoch invalidates
outstanding fingerprints and confirmation tokens) and shut down cleanly.

## 8. RPC method list

The 19 internal bridge methods, from `BRIDGE_METHOD_NAMES` in
`packages/schemas/src/bridge.ts`. Mutating methods require `operationId` **and**
the writer lease. `lease.*` methods are served inline on the network thread; all
others run on Rack's UI thread.

| Method | Mutating | Purpose |
| --- | --- | --- |
| `status.get` | no | Instance status: ids, epoch, version/edition, sample rate, patch name, lease. |
| `metrics.get` | no | Bridge/engine counters (queue depth, timeouts, rollbacks, telemetry drops, ...). |
| `catalog.listModels` | no | Paginated list of installed plugin models. |
| `catalog.inspectModel` | no | Params, inputs, and outputs for one model. |
| `module.inspect` | no | Live state of a placed module (optionally opaque state). |
| `patch.snapshot` | no | Full patch snapshot (optionally opaque state, size-capped). |
| `patch.fingerprint` | no | SHA-256 fingerprint of the current patch, plus epoch and saved flag. |
| `txn.preview` | no | Resolve + validate operations without mutating; returns normalized plan, `planHash`, `baseFingerprint`, diff, and risk. |
| `txn.commit` | **yes** | Apply a previewed plan as one history action; re-checks the fingerprint first. |
| `txn.undoLast` | **yes** | Undo the last MCP transaction (guarded by `expectedOperationId`). |
| `patchfile.save` | **yes** | Save the current patch to a policy-checked path. |
| `patchfile.saveCopy` | **yes** | Save a copy without changing the current patch path. |
| `patchfile.load` | **yes** | Load a patch file (bumps the patch epoch). |
| `patchfile.clear` | **yes** | Clear to an empty patch (bumps the patch epoch). |
| `probe.list` | no | List active probe slots. |
| `probe.read` | no | Read one probe channel's telemetry window. |
| `lease.acquire` | no* | Acquire the single writer lease; returns `leaseId` + `expiresInMs`. |
| `lease.renew` | no* | Renew a held lease before it expires. |
| `lease.release` | no* | Release a held lease. |

\* `lease.*` methods do not mutate the patch and so are not gated by the writer
lease, but `lease.acquire` is how a client *becomes* the writer. The lease TTL
defaults to 30 s (`leaseTtlMs`) and must be renewed to stay held.

## 9. Worked example: two frames

A read-only status request and its response:

```json
{"kind":"req","id":"91af03d7c6e2b400","method":"status.get","deadlineMs":5000,"payload":{}}
```

```json
{"kind":"res","id":"91af03d7c6e2b400","ok":true,"payload":{"instanceId":"7f1c...","sessionId":"a904...","patchEpoch":3,"rackVersion":"2.6.6","rackEdition":"Pro","bridgeVersion":"2.0.0","bridgeProtocolVersion":1,"mode":"standalone-gui","sampleRate":44100,"patchName":"subtractive.vcv","saved":true,"bridgeModulePresent":true,"commandPumpPresent":true,"writerLease":{"held":false}}}
```

A mutating commit carries an `operationId` and requires the writer lease:

```json
{"kind":"req","id":"5c7b1e9a0d3f4622","method":"txn.commit","deadlineMs":5000,"operationId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","payload":{"scope":"...","plan":{"label":"add filter","operations":[]},"planHash":"<64 hex>","expectedFingerprint":"<64 hex>"}}
```

## 10. Constant reference

| Constant | Value | Source |
| --- | --- | --- |
| `BRIDGE_PROTOCOL_VERSION` | 1 | `packages/schemas/src/limits.ts` |
| Frame body cap | 1 MiB | `LIMITS.bridgeFrameBytes` |
| Request id | 8 bytes / 16 hex | `bridge.ts`, `service.cpp` |
| Nonce | 32 bytes / 64 hex | `frames.hpp`, `service.cpp` |
| HMAC | HMAC-SHA256 / 64 hex | `frames.cpp`, `client.ts` |
| `operationId` | 36-char UUID | `service.cpp` |
| `deadlineMs` range | 1 – 600000 | `bridge.ts`, `service.cpp` |
| Heartbeat interval | 2000 ms | `LIMITS.bridgeHeartbeatIntervalMs` |
| JSON max depth / nodes / string | 64 / 250000 / 256 KiB | `LIMITS` |
| Max connections | 8 | `ServiceConfig.maxConnections` |
| Lease TTL | 30000 ms | `ServiceConfig.leaseTtlMs` |
| Idempotency retention | ≥ 10 min | `LIMITS.idempotencyCacheMs` |

## Related documents

- [Execution model ADR](./ADR-0001-execution-model.md) — why every Rack API call
  runs on the UI thread and what the network threads may and may not do.
- [Tool reference](../tools/tool-reference.md) — the 29 public MCP tools that sit
  above these bridge methods.
- [Full specification](../spec/rack-mcp-spec.md) — section 3.3 (bridge protocol)
  and section 12 (error contract).
