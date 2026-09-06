# Clean-machine install (macOS arm64)

This is a single, ordered checklist that takes a **fresh macOS arm64 machine** from
nothing to a working, verified Rack MCP setup. Follow it top to bottom. Each step
is a real command with real paths; nothing here is optional unless it says so.

Rack MCP is verified live only on **macOS arm64**. Windows, Linux, and macOS x64
are built and tested in CI but not verified beyond "CI-built," and several steps
below (SDK checksum, plugin folder name, Rack user directory, prerequisites) differ
on those platforms. Where a step is macOS-arm64-specific it is flagged
**[macOS arm64]**; for the other platforms follow [installation](./installation.md)
instead of this document.

## What you will end up with

- The RackMCP plugin (`Bridge` + `Probe` modules) installed in your Rack user dir.
- A single self-contained server bundle, `rack-mcp-server.mjs`, launched by your MCP host.
- A verified vertical slice: the host lists your running Rack, selects it,
  `get_rack_status` reports connected, `list_installed_models` returns Core and
  Fundamental, and a recipe builds live into the patch.

Rack MCP supports **VCV Rack 2.6.6, standalone GUI mode only**. Rack Pro inside a
DAW and headless Rack are unsupported.

---

## 1. Install prerequisites

**[macOS arm64]** The fastest path is [Homebrew](https://brew.sh) plus the Xcode
command-line tools (which provide `clang`/`make` for the C++ plugin and the SDK
fetch tools).

```bash
# Apple toolchain (clang, make, git, curl, unzip, shasum)
xcode-select --install

# Build + runtime tooling
brew install node pnpm cmake git
```

Requirements this satisfies:

| Tool | Why | Minimum |
| --- | --- | --- |
| Node.js | Runs the MCP server and the TS build | **20+** (`"node": ">=20"`; CI uses 22) |
| pnpm | Monorepo package manager | current |
| CMake + a C++11 compiler | Builds and runs the C++ core tests | current |
| `git`, `curl`, `unzip`, `shasum` | Clone; fetch + verify the Rack SDK | shipped with the CLT |

You also need **VCV Rack 2.6.6** (Free or Pro) installed as a standalone app from
<https://vcvrack.com>. Install it now but do not launch it until step 10.

## 2. Clone the repository

```bash
git clone https://github.com/ColonelKernel/vcv-rack-mcp.git
cd vcv-rack-mcp
```

The monorepo layout: `apps/mcp-server` (TS stdio server), `plugins/RackMCP` (C++11
plugin), `packages/{schemas,protocol,adapters,recipes,test-client}`,
`tests/{cpp,integration}`, `docs/`, `scripts/`.

## 3. Install JavaScript dependencies

```bash
pnpm install
```

## 4. Fetch the pinned Rack SDK

The plugin builds against Rack SDK 2.6.6, fetched into `vendor/Rack-SDK`.

```bash
# [macOS arm64]
./scripts/fetch-rack-sdk.sh mac-arm64
```

`scripts/fetch-rack-sdk.sh` downloads
`https://vcvrack.com/downloads/Rack-SDK-2.6.6-mac-arm64.zip` and verifies it against
the pinned SHA-256 before unzipping. All four platforms — `mac-arm64`, `mac-x64`,
`lin-x64` and `win-x64` — are pinned, and a mismatch stops the script before
anything is unpacked.

## 5. Build and test everything

```bash
# TypeScript: build every package + app, then run unit/contract tests
pnpm -r build
pnpm -r test

# C++ core tests (frame decoder, planHash canonicalization, telemetry math, ...)
cmake -S tests/cpp -B tests/cpp-build
cmake --build tests/cpp-build
ctest --test-dir tests/cpp-build --output-on-failure
```

`pnpm -r test` runs each workspace's own tests (the `@rackmcp/integration` package's
`test` script is a no-op on purpose — its live smoke tests are run explicitly and
are covered in step 11). All three commands should finish green before you continue.

## 6. Build and package the plugin

```bash
make -C plugins/RackMCP RACK_DIR=../../vendor/Rack-SDK
make -C plugins/RackMCP dist RACK_DIR=../../vendor/Rack-SDK
```

`make` produces `plugins/RackMCP/plugin.dylib`. `make dist` packages it (with
`plugin.json` and `res/`) into
`plugins/RackMCP/dist/RackMCP-2.0.0-mac-arm64.vcvplugin` — a zstd tarball following
the Rack SDK convention. `plugin.json` version is `2.0.0`.

## 7. Install the plugin into the Rack user dir

**[macOS arm64]** Rack loads unpacked plugins from
`<RackUserDir>/plugins-mac-arm64/<slug>/`. The macOS Rack user directory is
`~/Library/Application Support/Rack2`. Copy the freshly built plugin files into
place:

```bash
RACK_USER_DIR="$HOME/Library/Application Support/Rack2"
DEST="$RACK_USER_DIR/plugins-mac-arm64/RackMCP"
mkdir -p "$DEST"
cp plugins/RackMCP/plugin.dylib plugins/RackMCP/plugin.json "$DEST/"
cp -R plugins/RackMCP/res "$DEST/"
```

This is exactly the layout the integration harness installs and verifies. The
`.vcvplugin` from step 6 is the redistributable form of the same three items; on
other platforms the folder is `plugins-mac-x64`, `plugins-lin-x64`, or
`plugins-win-x64` and the user dir differs (see
[installation](./installation.md)).

> On first plugin load Rack creates the pairing secret at
> `<RackUserDir>/RackMCP/secret` (directory `0700`, file `0600`). The secret never
> crosses the wire and is not in the discovery manifest; the server reads it locally
> to authenticate.

## 8. Build the server bundle

```bash
pnpm --filter @rackmcp/mcp-server run bundle
```

This produces `apps/mcp-server/dist/bundle/rack-mcp-server.mjs`, a single
self-contained ESM file you run with `node`. **Keep `rackwright.md` beside it** — the
performance/design prompts are grounded in it. `stdout` is reserved for the MCP
protocol; all diagnostics go to `stderr`.

## 9. Configure your MCP host

Point your host at the bundle with `command: "node"` and the **absolute** path to
`rack-mcp-server.mjs`. Generic stdio config:

```json
{
  "mcpServers": {
    "rack-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/rack-mcp/apps/mcp-server/dist/bundle/rack-mcp-server.mjs"],
      "env": {
        "RACKMCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

The server discovers Rack through the local manifest directory under the Rack user
dir, so no network configuration is required. On macOS the default user dir
(`~/Library/Application Support/Rack2`) is auto-detected; set
`RACKMCP_RACK_USER_DIR` in `env` only if you installed the plugin into a
non-default dir. Other env vars: `RACKMCP_REQUEST_DEADLINE_MS` (default `5000`),
`RACKMCP_AUDIT_MAX_BYTES` (default `8388608`), `RACKMCP_AUDIT_MAX_AGE_DAYS`
(default `30`) and
`RACKMCP_LOG_LEVEL`. See [configuration examples](./configuration-examples.md) for
the full table and the exact config-file location for your host (for example,
Claude Desktop on macOS reads
`~/Library/Application Support/Claude/claude_desktop_config.json`).

Restart the host so it launches the server.

## 10. Start VCV Rack and add a Bridge module

1. Launch **VCV Rack 2.6.6** as a normal standalone app (double-click / Launchpad).
   Do this with the display awake — Rack creates its GL window at startup and will
   fail if the Mac display is asleep.
2. Add a **RackMCP-Bridge** module to the patch (right-click the rack → search
   `RackMCP-Bridge`). The Bridge attaches the command pump, starts the loopback
   bridge service, and shows connection status, writer-lease ownership, and pairing
   controls on its panel. MCP refuses to remove the last Bridge module by default.
3. Optionally add a **RackMCP-Probe** module (8 probe inputs) if you plan to read
   telemetry.

Within a couple of seconds the plugin writes a discovery manifest to
`<RackUserDir>/RackMCP/instances/<instanceId>.json` and heartbeats it every ~2s
(stale after 10s). That is what the server scans to find your instance.

## 11. Verify the vertical slice

Drive your MCP host to run the read path, then a build. With **exactly one** Rack
running the tools auto-select it; the writer lease needed for the build is acquired
by the server on demand and shown on the Bridge panel.

| # | Ask the host to call | Pass condition |
| --- | --- | --- |
| 1 | `list_rack_instances` | Your instance appears and is not stale |
| 2 | `select_rack_instance` (with its `instanceId`) | Selected without error |
| 3 | `get_rack_status` | Reports **connected** |
| 4 | `list_installed_models` | Returns models including **Core** and **Fundamental** |
| 5 | `build_patch` for recipe `basic_mono_subtractive` | Result `phase` is `committed` |

For step 5 the host reads `rack://recipes`, resolves the recipe against your
installed models, expands it to operations, and calls `build_patch`. Follow with
`describe_patch` (finds a signal chain into the audio output) and `validate_patch`
(zero structural errors) to confirm the built patch is sound.

### Automated end-to-end check (optional) **[macOS arm64]**

The repository ships the same slice as a live smoke test:

```bash
pnpm --filter @rackmcp/integration run recipes
```

It launches Rack in an **isolated** user dir (never your real one), builds the
recipe, validates and describes it, and reads back all six `rack://` resources,
printing `RECIPES SMOKE: PASSED`. Note its constraints: it is macOS-arm64-only and
currently expects Rack Pro at `/Applications/VCV Rack 2 Pro.app`.

## Known limitation: a harness-launched engine may not step

Read, analysis, and build (steps 1–5) work whenever Rack is connected. **Probe
telemetry is different**: `read_probe` reflects live signal only while Rack's audio
engine is actually processing frames. Under an automated or background launch (as
in the integration harness) the engine may never step, so `list_probes` /
`read_probe` can report no motion even though attach/detach and the telemetry
plumbing are working. On a normal interactive launch with audio running the engine
steps and telemetry updates (probe reporting is capped at ≤ 20 Hz). If probes look
frozen, confirm Rack's engine is running and an audio/output path is active before
suspecting the bridge.

## Troubleshooting the first connection

| Symptom / error code | Likely cause | Fix |
| --- | --- | --- |
| `RACK_NOT_FOUND` / no instances | No live manifest | Confirm a Bridge module is in the patch and Rack has been running > 2s |
| `BRIDGE_NOT_READY` | Bridge service still starting | Wait a moment; check the Bridge panel status |
| `AUTHENTICATION_FAILED` | Server reading a different user dir than Rack | Ensure `RACKMCP_RACK_USER_DIR` (if set) matches the dir holding `RackMCP/secret` |
| `INSTANCE_NOT_SELECTED` | Multiple Rack instances | Call `select_rack_instance` first |
| `WRITER_LEASE_REQUIRED` / `LEASE_HELD` | Another client holds the single writer lease | Release it there, or check lease ownership on the Bridge panel |
| Host shows no tools | Wrong bundle path or `rackwright.md` missing | Use an absolute path to `rack-mcp-server.mjs`; keep `rackwright.md` beside it |

## Other platforms

Windows, Linux, and macOS x64 are CI-built and packaged but not verified live.
The differences from this walkthrough are the prerequisites, the SDK platform
argument to `scripts/fetch-rack-sdk.sh` (which has no pinned checksum off
mac-arm64), the plugin folder name, and the Rack user directory. Follow
[installation](./installation.md) for those, and see the
[tool reference](./tool-reference.md) for the full tool surface once connected.
