# Compatibility Matrix

This document states exactly what Rack MCP supports, what it does **not**
support, and what "supported" means for each row. It is the single source of
truth for the version, platform, toolchain, protocol, and knowledge-layer
boundaries of Rack MCP. When a claim here conflicts with an aspirational
statement elsewhere, the values recorded in the source files
(`plugins/RackMCP/plugin.json`, `package.json`, `apps/mcp-server/package.json`,
`packages/schemas/src/bridge.ts`, `.github/workflows/ci.yml`) win.

Two words recur below and mean different things:

- **Verified live** — exercised against a real, running VCV Rack 2.6.6 GUI on
  actual hardware, including the integration suite in
  [`ADR-0001`](../architecture/ADR-0001-execution-model.md).
- **CI-built** — compiled and unit/contract-tested by
  [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), and (for the
  plugin) packaged into a `.vcvplugin`, but never launched against a live Rack
  on that platform. A green CI run is not a live-verification claim.

## Rack edition and version

Rack MCP targets exactly one host version. The bridge reports the running
edition and version in every `welcome` frame and in `status.get`
(`rackEdition`, `rackVersion`), and the discovery manifest records them per
instance.

| Host | Edition | Mode | Status |
| --- | --- | --- | --- |
| VCV Rack 2.6.6 | Free | Standalone GUI | Supported |
| VCV Rack 2.6.6 | Pro | Standalone GUI | Supported |
| VCV Rack 2.6.6 | Pro | DAW plugin (VST3 / AU / CLAP) | **Not supported** |
| VCV Rack 2.6.6 | Free / Pro | Headless (`Rack -h`) | **Not supported** |
| Rack ≤ 2.6.5 or ≥ 2.7.x | any | any | **Not supported** |

The plugin is built against Rack SDK 2.6.6 and declares Rack plugin major
version 2. Because the canonical patch fingerprint is a SHA-256 over
`patch::Manager::toJson()`, any change Rack makes to its serialization across
versions changes fingerprints; fingerprints are therefore scoped per session
and never persisted across Rack versions. There is no compatibility shim for
other 2.x point releases — run 2.6.6.

### Why DAW-hosted and headless are unsupported

Both are excluded deliberately, not by omission. The bridge reports
`mode: "standalone-gui"` (a `z.literal` in `StatusResult` and in the discovery
manifest), and the server refuses to claim any other mode.

- **DAW plugin (VST3 / AU / CLAP).** The execution model in
  [`ADR-0001`](../architecture/ADR-0001-execution-model.md) attaches a
  persistent command-pump widget to `APP->scene` and runs every Rack API call
  on Rack's own UI thread. A DAW host owns the run loop and window lifecycle
  differently, so that model is unproven there. DAW hosting needs its own
  tested execution adapter before any support claim.
- **Headless (`Rack -h`).** There is no scene and no UI thread to attach the
  command pump to, so the mutation path has nowhere to run. Headless also needs
  its own tested adapter.

Until each mode ships a tested adapter, pointing the server at one is out of
scope; the honest failure mode is the server declining to operate rather than
guessing.

## Operating systems and architectures

Only **macOS arm64** is verified live. Every other platform is CI-built and
packaged but not locally verified against a running Rack.

| Platform | Arch | Plugin build | Server build | Status |
| --- | --- | --- | --- | --- |
| macOS | arm64 (Apple Silicon) | CI (`mac-arm64`) | CI (macos-latest) | **Verified live** |
| macOS | x64 (Intel) | CI (`mac-x64`, macos-13) | CI (macos-latest) | CI-built only |
| Linux | x64 | CI (`lin-x64`, ubuntu-latest) | CI (ubuntu-latest) | CI-built only |
| Windows | x64 | CI (`win-x64`, windows-latest, MSYS2 MINGW64) | CI (windows-latest) | CI-built only |

Notes on the CI matrix, from
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml):

- The **plugin** job fetches the platform SDK with
  `scripts/fetch-rack-sdk.sh <sdk>`, runs
  `make -C plugins/RackMCP RACK_DIR=../../vendor/Rack-SDK`, then `make dist`,
  and uploads each `plugins/RackMCP/dist/*.vcvplugin` artifact. Windows builds
  under MSYS2 MINGW64 (`mingw-w64-x86_64-gcc`); Linux installs
  `libglu1-mesa-dev` first.
- The **TypeScript** and **C++ core** jobs run on `ubuntu-latest`,
  `macos-latest`, and `windows-latest`.
- The **fuzz smoke** job runs only on Linux (clang): a 60-second libFuzzer run
  of the bridge frame decoder (`fuzz_frame_decoder -max_total_time=60`).

CI packaging proves the plugin compiles and links on all four platforms. It
does **not** prove that pairing, the command pump, telemetry, or the
integration suite behave on Intel macOS, Linux, or Windows — those have not
been run against a live Rack. Treat non-arm64-macOS as "should work, unverified"
and report issues.

## Toolchain

### Server (TypeScript)

| Component | Requirement | Source |
| --- | --- | --- |
| Node.js | `>=20` (CI validates on 22) | `package.json` `engines.node`; CI `node-version: 22` |
| Package manager | pnpm `11.21.0` | `package.json` `packageManager` |
| TypeScript | `^7.0.2` | `package.json` devDependencies |
| Zod | `4.4.3` (pinned) | `package.json`, `apps/mcp-server/package.json` |
| Bundler | esbuild `0.28.2` | `apps/mcp-server/package.json` devDependencies |
| Test runner | Vitest `^4.1.11` | `package.json` devDependencies |

Node 20 is the supported floor; the CI runners use Node 22, so both are known
good. The server bundles to a single self-contained ESM file
(`apps/mcp-server/dist/bundle/rack-mcp-server.mjs`) via
`pnpm --filter @rackmcp/mcp-server run bundle`; keep `rackwright.md` beside it.
A host launches it with command `node` and args `["/abs/path/rack-mcp-server.mjs"]`.
stdout is reserved for MCP traffic; diagnostics go to stderr.

### Plugin (C++)

| Component | Requirement | Source |
| --- | --- | --- |
| Language standard | C++11 | `ADR-0001`, spec §2 |
| Rack SDK | 2.6.6 | `scripts/fetch-rack-sdk.sh`, `ADR-0001` |
| JSON library | jansson (bundled with the Rack SDK) | `ADR-0001` |
| Plugin version | `2.0.0` | `plugins/RackMCP/plugin.json` |
| Build | `make` + Rack SDK plugin Makefile | CI plugin job |

The plugin uses only public Rack SDK 2.6.6 headers (the load-bearing API table
is in [`ADR-0001`](../architecture/ADR-0001-execution-model.md)); no
`PRIVATE`-annotated or `Internal` symbols. C++11 is a hard floor — do not rely
on C++14/17 features.

## Bridge protocol and MCP SDK

Two independent version numbers matter, and they are negotiated at different
layers.

| Layer | Identifier | Value | How it is negotiated |
| --- | --- | --- | --- |
| Local bridge (server ↔ plugin) | `BRIDGE_PROTOCOL_VERSION` | `1` | `hello` → `welcome` handshake |
| MCP (host ↔ server) | `@modelcontextprotocol/sdk` | `1.30.0` | MCP `initialize` revision negotiation |

### Bridge protocol version 1

The bridge is a versioned, length-prefixed JSON protocol over loopback TCP
(`127.0.0.1` only, ephemeral port): a 4-byte big-endian length prefix followed
by UTF-8 JSON, capped at a **1 MiB** frame. `BRIDGE_PROTOCOL_VERSION` is `1`
(`packages/schemas/src/limits.ts`).

Version negotiation is explicit and lives in the handshake defined in
[`packages/schemas/src/bridge.ts`](../../packages/schemas/src/bridge.ts):

- The client sends `hello` with `versions: number[]` — every bridge protocol
  version it can speak.
- The plugin replies with `welcome` whose `version` is a `z.literal(1)`; a
  client that cannot speak version 1 is rejected. `welcome` also carries
  `bridgeProtocolVersion` in `status.get`, and the discovery manifest records
  it per instance, so a stale server and a new plugin (or vice versa) fail
  fast rather than mis-parsing frames.

There is exactly one bridge protocol version today. When it changes, the
`hello`/`welcome` exchange is where old and new endpoints detect the mismatch;
a `PROTOCOL_VERSION_MISMATCH` error is reserved for that case.

### MCP SDK 1.30.0 and MCP protocol revision negotiation

The server depends on `@modelcontextprotocol/sdk` version `1.30.0`
(`apps/mcp-server/package.json`) and speaks MCP to the host over stdio.

The **MCP protocol revision** is a separate concept from the SDK version. At
`initialize` time the SDK and the connecting host negotiate which MCP protocol
revision to use, and the SDK selects a revision both sides support from those
bundled with 1.30.0 — this is handled by the SDK, not by application code in
this repository. Consequently:

- Rack MCP does not hard-code or advertise a single MCP protocol revision;
  compatibility with a given host is whatever SDK 1.30.0 can negotiate with it.
- Tools declare strict JSON Schema 2020-12 input and output schemas and
  structured output, with backward-compatible text content where needed, so
  both modern and supported legacy MCP eras handled by the SDK work.

If you need a specific MCP protocol revision for a particular host, upgrade or
pin the SDK deliberately and re-run the suite; do not assume a revision this
document does not name.

## Adapter coverage (knowledge layer)

Rack MCP works with **any** installed Rack module through generic graph
operations. What differs by module is the *confidence* of the semantic claims
the server will make about it. Every validation finding and snapshot carries a
confidence level — `certain`, `adapter`, or `heuristic` — so the distinction is
visible in results.

| Module source | Adapter coverage | Semantic confidence | What is allowed |
| --- | --- | --- | --- |
| Core, Fundamental, RackMCP | Verified adapter (22 total in `packages/adapters`) | `adapter` / `certain` | Full: verified port/param roles, safe initial values, recipe use |
| Any other plugin | None | `heuristic` | Generic graph ops (add/move/connect/set param); semantic claims marked heuristic |

Rules that hold regardless of adapter, from the spec and
[`ADR-0001`](../architecture/ADR-0001-execution-model.md):

- Modules with **no** adapter stay fully usable for structural operations —
  adding, moving, bypassing, connecting, disconnecting, and setting parameters
  within declared ranges. Only the *interpretation* (what a port means, whether
  a level is dangerous) is downgraded to heuristic.
- **Opaque module `data` is never mutated without a matching adapter.** There is
  deliberately no `set_module_data` operation. Opaque state is excluded from
  snapshots by default and only surfaced with `includeOpaqueState: true` under a
  size limit.
- The knowledge layer also ships **8 recipes** (`packages/recipes`). Recipes
  resolve against installed models; a missing dependency returns the unresolved
  functional role rather than silently substituting an unknown module.

## What is explicitly NOT supported

Stated plainly, so there is no ambiguity:

- **Rack versions other than 2.6.6** — earlier or later 2.x point releases, and
  any 3.x, are out of scope.
- **DAW-hosted Rack Pro** (VST3 / AU / CLAP) and **headless Rack** — both need
  their own tested execution adapter first; the bridge only ever reports
  `mode: "standalone-gui"`.
- **Live operation on any platform except macOS arm64** — macOS x64, Linux x64,
  and Windows x64 are CI-built and packaged only, never live-verified here.
- **Node older than 20**, and any package manager other than the pinned pnpm
  `11.21.0` for reproducible installs.
- **Bridge protocol versions other than 1**, and **MCP protocol revisions that
  SDK 1.30.0 cannot negotiate** with the host.
- **Mutating opaque module state** for modules without a verified adapter, and
  any `set_module_data`-style generic state write (it does not exist).
- **Non-loopback networking** — the bridge binds `127.0.0.1` only and exposes no
  public HTTP endpoint; remote control is not a supported configuration.

## See also

- [Tool reference](./tool-reference.md) — the 29 MCP tools and their schemas.
- [ADR-0001: execution model](../architecture/ADR-0001-execution-model.md) —
  supported modes, Rack API boundaries, and licensing.
- [Normative specification](../spec/rack-mcp-spec.md) — §2 verified platform
  baseline.
