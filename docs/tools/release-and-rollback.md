# Release and Rollback Procedure

This runbook covers cutting a Rack MCP release — the Rack plugin
(`plugins/RackMCP`) and the TypeScript MCP server (`apps/mcp-server`) — and
rolling one back cleanly. It assumes you have the repository checked out, `pnpm`
and Node 20+ installed, and, for local plugin builds, a C++11 toolchain.

Rack MCP is verified live only on macOS arm64. The other three targets
(macOS x64, Linux x64, Windows x64) are **CI-built and tested only**; treat their
artifacts as CI-built, not field-verified. Rack MCP supports VCV Rack 2.6.6 in
standalone GUI mode only.

## 1. What has a version

A release moves several independent version numbers. Know which is which before
you bump anything.

| Version | Where it lives | Current | What it means | Bump when |
| --- | --- | --- | --- | --- |
| Plugin version | `plugins/RackMCP/plugin.json` (`version`) | `2.0.0` | The Rack-facing plugin version. It names the `.vcvplugin` file and is what Rack (and the VCV Library) shows. | Every plugin release, following semver against the plugin's own behavior. |
| Bridge protocol version | `packages/schemas/src/limits.ts` (`BRIDGE_PROTOCOL_VERSION`, `BRIDGE_PROTOCOL_MIN_SUPPORTED`) → generated into `plugins/RackMCP/src/gen/rackmcp_protocol_gen.hpp` | `1` (min supported `1`) | The wire contract negotiated over the loopback bridge. A single integer. | Only on a wire-incompatible change (see §6). |
| Bridge service version | `plugins/RackMCP/src/rackmcp_plugin.hpp` (`RACKMCP_BRIDGE_VERSION`) | `0.1.0` | Informational build tag for the bridge service, reported in the `welcome` frame and the discovery manifest. Not used for compatibility gating. | At your discretion, per bridge-service change. |
| npm package versions | root `package.json` and each `apps/*` / `packages/*` `package.json` | `0.1.0` | Workspace versions: `rack-mcp` (root, private), `@rackmcp/mcp-server`, `@rackmcp/schemas`, `@rackmcp/protocol`, `@rackmcp/adapters`, `@rackmcp/recipes`. All private (not published to npm). The server bundle stamps `@rackmcp/mcp-server`'s version into `process.env.RACKMCP_SERVER_VERSION` at bundle time. | Per server/package release, following semver. |

Key point: the **plugin version** (`2.0.0`) and the **bridge protocol version**
(`1`) are unrelated. You can ship many plugin releases without ever touching the
protocol version, and you should — the protocol version only changes when the
framed JSON contract itself changes in a way an older peer cannot parse.

Because the C++ protocol constant is generated from the TypeScript source of
truth, the two never drift: `scripts/gen-cpp.ts` writes
`plugins/RackMCP/src/gen/rackmcp_protocol_gen.hpp` from
`packages/schemas/src/limits.ts`, and `pnpm run check:gen` fails CI if the
committed generated files are stale. See
[canonical schema codegen](../architecture/ADR-0003-canonical-schema-codegen.md).

## 2. Pre-release checklist

Everything below must be green on the release commit before you tag. Run it
locally, and confirm the same jobs are green in CI on that commit.

```bash
# From the repository root.

# 1. Install exactly the locked dependencies.
pnpm install --frozen-lockfile

# 2. Build every workspace package and app.
pnpm run build            # -> pnpm -r build

# 3. Run the full TypeScript test suite (vitest across all packages).
pnpm run test             # -> pnpm -r test

# 4. Generated artifacts are fresh (schemas + C++ headers match the source).
#    Regenerates and fails if `packages/schemas/json` or
#    `plugins/RackMCP/src/gen` would change.
pnpm run check:gen
```

```bash
# 5. C++ core tests (framing, queues, validation, telemetry math, inverse
#    actions). Same steps CI runs in the `cpp-core` job.
cmake -S tests/cpp -B tests/cpp-build
cmake --build tests/cpp-build --config Debug
ctest --test-dir tests/cpp-build --output-on-failure -C Debug
```

```bash
# 6. Fuzz smoke of the frame decoder (Linux + clang; CI runs this on the
#    `fuzz-smoke` job — reproduce locally if you have clang).
CC=clang CXX=clang++ cmake -S tests/cpp -B tests/cpp-build -DRACKMCP_BUILD_FUZZERS=ON
cmake --build tests/cpp-build
./tests/cpp-build/fuzz_frame_decoder -max_total_time=60 -rss_limit_mb=1024
```

Checklist summary — do not tag until each is satisfied:

- [ ] `pnpm run build` and `pnpm run test` green on all three CI OSes.
- [ ] `pnpm run check:gen` clean (no schema/codegen drift). CI skips this on
      Windows; it must pass on Linux/macOS.
- [ ] C++ `ctest` green (macOS, Linux, Windows).
- [ ] Fuzz smoke green (60s frame-decoder run, no crashes).
- [ ] Integration smokes against Rack 2.6.6 exercised (connect/inspect,
      add/remove, cables, params, save/reload, checkpoint recovery, probe
      telemetry, rediscovery — the scenarios in
      [the spec, §16](../spec/rack-mcp-spec.md)). These run live and are not part
      of the headless CI matrix.
- [ ] Version numbers bumped as intended (§1) and the protocol-version decision
      (§6) made deliberately.
- [ ] Docs updated: [tool reference](./tool-reference.md),
      [compatibility matrix](./compatibility-matrix.md),
      [installation](./installation.md), and this runbook reflect the release.

## 3. The release build (CI, all four platforms)

CI is defined in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) and
runs on every push to `main` and every pull request. It has four jobs:

| Job | Runners | What it does |
| --- | --- | --- |
| `typescript` | ubuntu, macos, windows | `pnpm install --frozen-lockfile`, `pnpm run build`, `pnpm run test`, and `pnpm run check:gen` (skipped on Windows). |
| `cpp-core` | ubuntu, macos, windows | Configures `tests/cpp` with CMake, builds Debug, runs `ctest`. |
| `fuzz-smoke` | ubuntu (clang) | Builds with `-DRACKMCP_BUILD_FUZZERS=ON` and runs the frame decoder for 60s. |
| `plugin` | mac-arm64, mac-x64, lin-x64, win-x64 | Fetches the pinned Rack SDK, builds and packages the plugin, uploads the `.vcvplugin`. |

The `plugin` job is the one that produces shippable binaries. Its matrix maps
each platform to an SDK target and a runner:

| `platform.name` | Runner | SDK target | `ARCH_NAME` in the filename |
| --- | --- | --- | --- |
| `mac-arm64` | `macos-latest` | `mac-arm64` | `mac-arm64` |
| `mac-x64` | `macos-15-intel` | `mac-x64` | `mac-x64` |
| `lin-x64` | `ubuntu-latest` | `lin-x64` | `lin-x64` |
| `win-x64` | `windows-latest` (MSYS2 MINGW64) | `win-x64` | `win-x64` |

For each, CI runs the same commands you would run locally:

```bash
./scripts/fetch-rack-sdk.sh <sdk-target>                       # into vendor/Rack-SDK
make -C plugins/RackMCP -j4 RACK_DIR=../../vendor/Rack-SDK     # build
make -C plugins/RackMCP dist  RACK_DIR=../../vendor/Rack-SDK   # package
```

`make dist` produces a zstd tarball following the Rack SDK convention at
`plugins/RackMCP/dist/<SLUG>-<VERSION>-<ARCH_NAME>.vcvplugin`. With
`plugin.json` at version `2.0.0` the four artifacts are:

```
RackMCP-2.0.0-mac-arm64.vcvplugin
RackMCP-2.0.0-mac-x64.vcvplugin
RackMCP-2.0.0-lin-x64.vcvplugin
RackMCP-2.0.0-win-x64.vcvplugin
```

Each is uploaded as a workflow artifact named `RackMCP-<platform.name>` (e.g.
`RackMCP-mac-arm64`) containing `dist/*.vcvplugin`.

### The reproducible server bundle

CI validates the TypeScript (build, test, `check:gen`) but does **not** produce
the server bundle. Build it deterministically on the release commit, after
`pnpm -r build` (esbuild resolves `@rackmcp/*` through each package's built
`dist`):

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm --filter @rackmcp/mcp-server run bundle    # -> node apps/mcp-server/bundle.mjs
```

This writes, under `apps/mcp-server/dist/bundle/`:

- `rack-mcp-server.mjs` — a single self-contained ESM file with every dependency
  (the MCP SDK, zod, and the `@rackmcp/*` workspace packages) inlined. The build
  is deterministic: no minification, no source maps, `legalComments: "none"`.
- `rackwright.md` — the Rackwright prompt identity, read at runtime from beside
  the bundle. **It must ship alongside `rack-mcp-server.mjs`.**
- `bundle-metafile.json` — the esbuild input set, recorded for reproducibility
  auditing.

A host launches the server with command `node` and args
`["/abs/path/rack-mcp-server.mjs"]`; stdout is reserved for the MCP transport and
diagnostics go to stderr. See
[configuration examples](./configuration-examples.md).

## 4. Publishing

1. **Freeze the release commit.** Ensure §2 is green on it and version numbers
   are final.

2. **Tag.** Use distinct tags because the plugin and server version
   independently. For this release:

   ```bash
   git tag -a plugin-v2.0.0  -m "RackMCP plugin 2.0.0 (bridge protocol v1)"
   git tag -a server-v0.1.0  -m "rack-mcp-server 0.1.0 (bridge protocol v1)"
   git push origin plugin-v2.0.0 server-v0.1.0
   ```

   Record the negotiated **bridge protocol version** in the tag message and the
   release notes; rollback compatibility (§6) depends on it.

3. **Collect the four `.vcvplugin` artifacts** from the green CI run for the
   tagged commit. With the GitHub CLI:

   ```bash
   gh run download <run-id> \
     --dir release-artifacts \
     --pattern 'RackMCP-*'
   # -> release-artifacts/RackMCP-mac-arm64/RackMCP-2.0.0-mac-arm64.vcvplugin
   #    release-artifacts/RackMCP-mac-x64/RackMCP-2.0.0-mac-x64.vcvplugin
   #    release-artifacts/RackMCP-lin-x64/RackMCP-2.0.0-lin-x64.vcvplugin
   #    release-artifacts/RackMCP-win-x64/RackMCP-2.0.0-win-x64.vcvplugin
   ```

4. **Create the release and attach the binaries.** Attach all four
   `.vcvplugin` files and the server bundle set
   (`rack-mcp-server.mjs`, `rackwright.md`, `bundle-metafile.json`).

   ```bash
   gh release create plugin-v2.0.0 \
     release-artifacts/RackMCP-*/RackMCP-2.0.0-*.vcvplugin \
     apps/mcp-server/dist/bundle/rack-mcp-server.mjs \
     apps/mcp-server/dist/bundle/rackwright.md \
     apps/mcp-server/dist/bundle/bundle-metafile.json \
     --title "Rack MCP 2.0.0" \
     --notes "Plugin 2.0.0, server 0.1.0, bridge protocol v1. See release-and-rollback.md."
   ```

   Publish checksums for every attached file so operators can verify downloads.

5. **VCV Library (optional).** You may submit `RackMCP` to the VCV Library.
   **Licensing gate:** the plugin is GPL-3.0-or-later (`LICENSE.md`). Submitting
   the GPL plugin to the VCV Library is fine. If the plugin is ever to be
   distributed under non-GPL or commercial terms, VCV commercial licensing must
   be arranged **first**. The TypeScript server and packages are MIT
   (`LICENSE-MIT`) and are not part of a VCV Library submission. See the
   [licensing note](../security/licensing.md).

## 5. Rollback

Rolling back means putting the previous **plugin** and previous **server bundle**
back in place. The two roll back independently; check §6 first to confirm the
pair you land on shares a bridge protocol version.

### Roll back the plugin

1. Quit Rack (the plugin is loaded at Rack startup).
2. Remove the current plugin and install the previous `.vcvplugin`. Rack unpacks
   `.vcvplugin` files placed in the user plugins directory
   (`<RackUserDir>/plugins-<os>-<arch>/`); the installed plugin lives at
   `<RackUserDir>/plugins-<os>-<arch>/RackMCP/`.

   ```bash
   # Example, macOS arm64. Adjust <RackUserDir> and the arch suffix per platform.
   RACK_USER_DIR="$HOME/Library/Application Support/Rack2"
   PLUGINS_DIR="$RACK_USER_DIR/plugins-mac-arm64"
   rm -rf "$PLUGINS_DIR/RackMCP"
   cp RackMCP-<previous-version>-mac-arm64.vcvplugin "$PLUGINS_DIR/"
   ```

3. Relaunch Rack. Confirm on the RackMCP-Bridge module panel that the previous
   plugin loaded and the bridge came up.

### Roll back the server bundle

The server is just a file a host launches. Point the host back at the previous
bundle (and its sibling `rackwright.md`), then restart the host / MCP connection:

```bash
# Whatever directory your host launches the bundle from:
cp <previous>/rack-mcp-server.mjs ./rack-mcp-server.mjs
cp <previous>/rackwright.md       ./rackwright.md
```

Keep the previous release's bundle set archived precisely so a rollback is a file
copy, never a rebuild. The running server reports its version via
`process.env.RACKMCP_SERVER_VERSION` (stamped at bundle time), so you can confirm
which bundle is live.

### Recovering patches after a rollback

A rollback does not touch patch content, but if a release interaction left a
patch in an unwanted state, users recover through **checkpoints**, not the
plugin binary. Checkpoints are created with `create_checkpoint` and restored with
`restore_checkpoint`; they live under `<RackUserDir>/RackMCP/`. In-Rack `.vcv`
saves (`save_patch`) are the other recovery path. Full procedure:
[backup and recovery](./backup-and-recovery.md). MCP transactions committed
against the rolled-back software can still be reversed one step with
`undo_last_mcp_transaction`, subject to its normal staleness rules.

## 6. Protocol compatibility across a rollback

The bridge negotiates its protocol version at connect time, so plugin and server
do **not** have to be the same release — they have to agree on the protocol
version.

- The server (TS) sends a `hello` frame offering the versions it supports:
  currently `[BRIDGE_PROTOCOL_VERSION]` = `[1]`.
- The plugin accepts only if one offered version **exactly equals** its own
  `gen::BRIDGE_PROTOCOL_VERSION` (currently `1`). On a match it replies `welcome`
  and proceeds to authentication; on no match it returns
  `PROTOCOL_VERSION_MISMATCH` and closes the connection.

Compatibility expectations:

- **Same protocol version on both sides → compatible.** Because every release so
  far pins protocol version `1`, any released plugin pairs with any released
  server today. You can roll back the plugin, the server, or both, in any
  combination, and the bridge still connects.
- **Different protocol version on one side → refused, not silently degraded.** If
  a future release bumps `BRIDGE_PROTOCOL_VERSION`, a peer that offers or accepts
  only the other version fails the handshake with `PROTOCOL_VERSION_MISMATCH`.
  There is no partial mode: the connection is closed before auth. So if you roll
  back across a protocol bump, roll back **both** sides to a pair that shares a
  version.
- `BRIDGE_PROTOCOL_MIN_SUPPORTED` (currently `1`) is the floor: it records the
  oldest protocol version this build still speaks. Widening backward
  compatibility means a peer offering/accepting a range that includes the other
  side's version; today both the floor and the current version are `1`, so the
  set is exactly `{1}`.

Bump policy: change `BRIDGE_PROTOCOL_VERSION` (and, only when dropping old-peer
support, `BRIDGE_PROTOCOL_MIN_SUPPORTED`) in `packages/schemas/src/limits.ts`,
then regenerate so TypeScript and C++ move together:

```bash
pnpm run gen        # rewrites plugins/RackMCP/src/gen/rackmcp_protocol_gen.hpp
pnpm run check:gen  # must be clean; commit the regenerated generated files
```

Never edit the generated C++ header by hand — it is overwritten from the schema
source of truth. A protocol bump is a coordinated plugin + server release; note
it prominently in the release notes and in the tag messages so operators know
which plugin/server pairs are cross-compatible. See the
[bridge protocol specification](../architecture/bridge-protocol.md) and the
[compatibility matrix](./compatibility-matrix.md).
