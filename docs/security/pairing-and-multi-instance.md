# Pairing and running multiple Rack instances

Rack MCP is a **local-only** integration. The MCP server (TypeScript) reaches a
running VCV Rack 2.6.6 through the RackMCP plugin's loopback bridge — a TCP
listener bound to `127.0.0.1` on an ephemeral port. Because anything on the
local machine can open a loopback socket, the bridge does not trust a connection
just because it connected. It requires proof that the client can read a shared
**pairing secret** that lives, with owner-only permissions, under the Rack user
directory. This document explains how that secret is created and protected, how
the challenge-response handshake works, how the server discovers and selects a
Rack instance, how the single writer lease behaves when more than one client is
attached, and how to run two Rack instances side by side with isolated user
directories.

For the wider defensive picture, see the [threat model](./threat-model.md). For
the bridge frame format and method table, see the
[bridge protocol](../architecture/bridge-protocol.md) and the
[tool reference](../tools/tool-reference.md).

## The pairing secret

The secret is a **256-bit (32-byte) random value**. The plugin generates it on
first bridge start via the platform CSPRNG — `/dev/urandom` on POSIX,
`BCryptGenRandom` on Windows (`plugins/RackMCP/src/core/crypto.cpp`,
`randomBytes`). It is stored hex-encoded (64 lowercase hex characters plus a
trailing newline) at:

```
<RackUserDir>/RackMCP/secret
```

where `<RackUserDir>` is Rack 2's user directory (see
[configuration examples](../tools/configuration-examples.md) for the per-platform
defaults, e.g. `~/Library/Application Support/Rack2` on macOS).

### Storage protections

`loadOrCreateSecret` (`plugins/RackMCP/src/core/secret.cpp`) enforces
owner-only access before it reads or writes anything:

| Object | POSIX | Windows |
| --- | --- | --- |
| `RackMCP/` directory | `0700` (created, then `chmod` tightened) | Protected owner-only ACL `D:P(A;OICI;FA;;;OW)` |
| `secret` file | `0600` (created and re-`chmod`ed on every load) | Same owner-only ACL |

The file is written atomically: contents go to `secret.tmp`, are `fsync`ed, then
`rename`d over the final path (POSIX) or moved with `MoveFileEx` +
`MOVEFILE_REPLACE_EXISTING` (Windows). On read the plugin trims trailing
whitespace and rejects anything that is not exactly 64 hex characters decoding to
32 raw bytes.

### What the secret never does

- **It never crosses the wire.** Only an HMAC derived from it is transmitted (see
  the handshake below). The server reads the secret from disk with
  `loadPairingSecret` (`packages/protocol/src/discovery.ts`), uses it to compute
  one HMAC, then scrubs its in-memory copy with `secret.fill(0)`
  (`apps/mcp-server/src/connection.ts`).
- **It is never logged.** Secrets and opaque module data are redacted from all
  diagnostics; server logs go to stderr only.
- **It is never in the discovery manifest.** The manifest is a separate,
  secret-free file (see [Instance discovery](#instance-discovery)).

### Resetting (re-pairing)

The **RackMCP-Bridge** module's panel exposes a pairing reset. This calls
`rotateSecret`, which generates a fresh 32-byte secret and atomically replaces
the file. After a reset, any client still holding the old secret fails
authentication; the server simply re-reads `secret` on its next
`select_rack_instance` and re-pairs. Use a reset if you suspect the secret was
exposed, or to revoke a previously paired host.

## The challenge-response handshake

Authentication is an HMAC-SHA256 challenge-response layered on top of the bridge
handshake (`packages/schemas/src/bridge.ts`,
`packages/protocol/src/client.ts`). No password or secret material is ever sent;
the client proves knowledge of the secret by answering a fresh nonce.

```
client → hello      { versions, client:{name,version} }
server → welcome    { version, instanceId, sessionId, nonce, patchEpoch,
                      rackVersion, rackEdition, authRequired:true }
client → auth       { hmac }
server → authResult { ok, role:"readonly" | error }
```

1. **`welcome`** carries a **fresh random `nonce`** (a 32-byte value, 64 hex
   characters), plus the per-launch `instanceId` and the per-connection
   `sessionId`. A new nonce is issued for every connection, so a captured
   response cannot be replayed against a later session.
2. The client computes:

   ```
   hmac = HMAC-SHA256(pairingSecret, utf8(nonce + "|" + instanceId + "|" + sessionId))
   ```

   binding the answer to that specific nonce, instance, and session.
3. The plugin recomputes the same HMAC with its own copy of the secret and
   compares the two in **constant time** (`constantTimeEqual` in
   `crypto.cpp`, which ORs together per-byte differences and never short-circuits)
   so a timing side channel cannot leak the expected value byte by byte.
4. On success the server replies `authResult { ok:true, role:"readonly" }`. **All
   authenticated connections begin read-only.** Mutating anything requires the
   writer lease described below.

A failed handshake yields `AUTHENTICATION_FAILED` (or
`PROTOCOL_VERSION_MISMATCH` if version negotiation fails); the socket is closed.

## Instance discovery

Every Rack launch is a distinct instance. On bridge start the plugin writes a
protected **discovery manifest** whose filename is the per-launch `instanceId`
(a UUID):

```
<RackUserDir>/RackMCP/instances/<instanceId>.json
```

The `instances/` directory is created `0700` and the manifest is written with the
same atomic + owner-only path as the secret (`writeManifest` in
`plugins/RackMCP/src/core/manifest.cpp`). The manifest (`manifestVersion` 1,
validated by `InstanceManifest` in `packages/schemas/src/bridge.ts`) contains:

| Field | Meaning |
| --- | --- |
| `instanceId` | UUID, one per Rack launch |
| `pid` | Rack process id (used for liveness) |
| `rackVersion`, `rackEdition` | e.g. `2.6.6`, `Free`/`Pro`/`unknown` |
| `bridgeVersion`, `bridgeProtocolVersion` | plugin + protocol versions |
| `port` | loopback TCP port the bridge listens on (`127.0.0.1` only) |
| `startTime`, `lastHeartbeat` | ISO-8601 UTC timestamps |
| `mode` | always `standalone-gui` |
| `patchName` | current patch name, or `null` |
| `commandPumpPresent`, `bridgeModulePresent` | readiness flags |
| `userDir`, `patchesDir`, `checkpointsDir` | directories the server needs for path policy |

The manifest **never contains the secret or the port's connection credential** —
knowing the port is not enough to command Rack, because the handshake still
requires the HMAC.

### Heartbeat and staleness

The plugin rewrites `lastHeartbeat` roughly every **2 seconds**. The server side
(`scanInstances` in `packages/protocol/src/discovery.ts`) reads every `*.json`
in the discovery directory, skips any file over 64 KiB or failing
`InstanceManifest` validation (manifests are untrusted input), and marks an
instance **stale** when *either* condition holds:

- the heartbeat is older than **10 seconds** (`instanceStaleAfterMs`), or
- the manifest's `pid` is not alive — checked with `process.kill(pid, 0)`.

The PID-liveness check catches a Rack that crashed without removing its manifest:
even inside the 10-second window, a dead PID marks the instance stale
immediately. On a clean shutdown the plugin removes its own manifest
(`removeManifest`).

## Listing and selecting an instance

Two tools drive discovery and selection (full schemas in the
[tool reference](../tools/tool-reference.md)):

- **`list_rack_instances`** returns the `discoveryDir` the server is scanning and
  an `instances[]` array — each entry echoes the manifest fields above plus
  `stale` and `selected` booleans. It performs no network I/O; it only reads the
  manifests.
- **`select_rack_instance`** takes an `instanceId`, opens the loopback socket to
  that instance's `port`, runs the hello/welcome/auth handshake, and returns the
  live `status`.

```jsonc
// list_rack_instances → (abridged)
{
  "discoveryDir": "/Users/me/Library/Application Support/Rack2/RackMCP/instances",
  "instances": [
    { "instanceId": "7f3c…", "port": 51544, "pid": 8123, "rackEdition": "Pro",
      "patchName": "subtractive.vcv", "stale": false, "selected": false }
  ]
}
```

Selection rules (`apps/mcp-server/src/connection.ts`):

- Selecting an unknown `instanceId` raises `RACK_NOT_FOUND`; selecting a stale one
  raises `RACK_DISCONNECTED`.
- If **exactly one** live instance exists, the server auto-selects it on the first
  tool call — you can skip `select_rack_instance` entirely.
- If **more than one** live instance exists and none is selected, the server
  raises `INSTANCE_NOT_SELECTED` (its data lists the candidate `instanceIds`), so
  you must call `select_rack_instance` first.
- A selection that fails *after* those checks — the handshake is refused, or
  authentication fails — leaves **no instance selected** rather than silently
  keeping the previous one. The next tool call therefore auto-selects a lone live
  instance, or raises `INSTANCE_NOT_SELECTED` when several are running. This is
  deliberate: a failed `select_rack_instance` must never leave later calls
  talking to an instance you did not choose.

After selecting, the server briefly waits for the command pump to attach,
swallowing the transient `BRIDGE_NOT_READY` a freshly launched instance returns
until its Bridge widget has stepped.

## The writer lease with multiple clients

The bridge allows **many authenticated read-only connections** but only **one
writer** per Rack instance at a time. The lease is a token with a TTL:

- **`acquire_writer_lease`** → `lease.acquire`, returning `{ leaseId, expiresInMs }`.
- **`release_writer_lease`** → `lease.release`.
- The server renews automatically before each mutation (`lease.renew`); a lapsed
  lease renews or re-acquires transparently.

If another client already holds the lease, `lease.acquire` fails with
**`LEASE_HELD`** and a message naming the current holder
(`plugins/RackMCP/src/core/service.cpp`, `"writer lease held by <clientName>"`).
`LEASE_HELD` is retry-safe — no mutation occurred — so a client can back off and
retry once the holder releases. A renewal against an expired or foreign lease
returns `WRITER_LEASE_REQUIRED` instead. Every read-only tool
(`get_patch_snapshot`, `describe_patch`, `read_probe`, etc.) works without any
lease; only the transactional and patch-file tools need it.

Lease ownership is **visible on the RackMCP-Bridge module's panel**, so a human at
the Rack window can always see which client holds the writer.

## Running two Rack instances

There are two supported topologies. Both rely on the fact that everything the
server touches — discovery, checkpoints, audit, and the pairing secret — is
**derived from one Rack user directory** (`apps/mcp-server/src/config.ts`) and can
be repointed with the single environment variable `RACKMCP_RACK_USER_DIR`. There
is no separate discovery-directory variable.

### Option A — one shared user directory, one server

If both Rack processes resolve to the **same** user directory, each still writes
its own `<instanceId>.json` into the shared `instances/` folder and both share the
one pairing secret. A single MCP server discovers both:

```
list_rack_instances        # shows two live instances
select_rack_instance A      # drive instance A …
# later
select_rack_instance B      # … then switch to instance B
```

Because two live instances are present, the server will not auto-select — you must
`select_rack_instance` before mutating, and re-select to switch targets. This is
the lightest setup when you occasionally hop between two Racks from one client.

### Option B — isolated user directories, one server each

For full isolation — separate secrets, separate discovery, separate
checkpoints/audit — give each Rack process its **own** user directory, then run a
**separate MCP server per instance** with `RACKMCP_RACK_USER_DIR` pointed at the
matching directory:

```bash
# Server bound to Rack instance #1
RACKMCP_RACK_USER_DIR="$HOME/RackA" \
  node /abs/path/rack-mcp-server.mjs

# Server bound to Rack instance #2 (separate host/process)
RACKMCP_RACK_USER_DIR="$HOME/RackB" \
  node /abs/path/rack-mcp-server.mjs
```

Each server sees only the instance registered under its own
`<userDir>/RackMCP/instances/`, so each auto-selects its single live instance and
never sees the other. Point each Rack process at the corresponding user directory
(`RackA`, `RackB`) so its plugin writes its secret and manifest there; the two
`RACKMCP_RACK_USER_DIR` values must match those directories exactly. Configure the
two servers as distinct entries in your MCP host so each client conversation talks
to one Rack.

Isolated directories are the right choice when the two Racks belong to different
projects or trust boundaries: a pairing reset on one does not affect the other,
and neither server can discover or command the other's instance.

## Quick reference

| Symptom | Likely cause | Resolution |
| --- | --- | --- |
| `AUTHENTICATION_FAILED` on select | secret missing, malformed, or reset since last pairing | Confirm `<RackUserDir>/RackMCP/secret` exists (64 hex chars); re-select to re-read it |
| `RACK_NOT_FOUND` | no manifest for that `instanceId` | Run `list_rack_instances`; confirm the Rack is running with a Bridge module |
| `RACK_DISCONNECTED` on select | instance stale (heartbeat > 10s or dead PID) | Restart/refocus Rack; re-list |
| `INSTANCE_NOT_SELECTED` | two or more live instances, none selected | Call `select_rack_instance` first |
| `LEASE_HELD` | another client holds the writer lease | Wait and retry; check the holder named on the Bridge panel |

## See also

- [Threat model](./threat-model.md) — attacker classes and the loopback trust boundary
- [Bridge protocol](../architecture/bridge-protocol.md) — framing, handshake, and method table
- [Threading model](../architecture/threading-model.md) — the command pump and real-time safety
- [Tool reference](../tools/tool-reference.md) — full schemas for the instance and lease tools
- [Configuration examples](../tools/configuration-examples.md) — environment variables and defaults
