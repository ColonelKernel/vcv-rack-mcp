# Installation guide

This guide installs Rack MCP on a single machine: the **RackMCP plugin** (Bridge +
Probe modules) into VCV Rack, and the **MCP server** (a stdio process your MCP host
launches). Both halves are built from this monorepo.

Covered platforms:

| Platform | Status |
| --- | --- |
| macOS arm64 | Verified live on Rack 2.6.6 |
| macOS x64 | CI-built only |
| Windows x64 | CI-built only |
| Linux x64 | CI-built only |

Only **VCV Rack 2.6.6 Free or Pro in standalone GUI mode** is supported. Rack Pro
inside a DAW, headless Rack, and other Rack versions are explicitly unsupported.

The whole flow is:

1. Fetch the pinned Rack SDK 2.6.6.
2. Build and package the plugin into a `.vcvplugin`.
3. Install the `.vcvplugin` into your Rack user directory.
4. Build and bundle the MCP server.
5. Point your MCP host at the bundled server.

## 1. Prerequisites

Install these on the build machine before starting.

### Common (all platforms)

- **VCV Rack 2.6.6** (Free or Pro) installed and runnable in standalone mode.
- **Node.js 20 or newer** (the server bundle targets `node20`; the repo declares
  `"node": ">=20"`).
- **pnpm** (the repo pins `pnpm@11.21.0` via `packageManager`; any recent pnpm 8+
  works). Install with `npm install -g pnpm` or Corepack.
- **curl** and **unzip** — `scripts/fetch-rack-sdk.sh` uses `curl` to download the
  SDK and `unzip` to extract it, and `shasum` to verify it.
- A **C++11 toolchain** and **GNU make** for the plugin (see per-OS notes below).

### Per-OS toolchain

| Platform | Toolchain to install |
| --- | --- |
| macOS (arm64/x64) | Xcode Command Line Tools (`xcode-select --install`) provide `clang` and `make`. Node/pnpm via Homebrew or the official installer. |
| Windows x64 | [MSYS2](https://www.msys2.org/) with the **MINGW64** environment. In an MSYS2 MINGW64 shell: `pacman -S mingw-w64-x86_64-gcc mingw-w64-x86_64-cmake make unzip zip curl`. Run the plugin build from that shell. |
| Linux x64 | `gcc`/`g++` and `make` (e.g. `build-essential`), plus the GLU dev headers Rack needs: `sudo apt-get install -y libglu1-mesa-dev`. |

The toolchain lists mirror what CI installs in `.github/workflows/ci.yml`.

## 2. Fetch the Rack SDK 2.6.6

The plugin builds against the pinned SDK, not against your Rack installation.
`scripts/fetch-rack-sdk.sh` downloads and unpacks it into `vendor/Rack-SDK`.

```bash
# From the repo root. With no argument it auto-detects via uname:
./scripts/fetch-rack-sdk.sh

# Or pass an explicit platform token:
./scripts/fetch-rack-sdk.sh mac-arm64   # or: mac-x64 | lin-x64 | win-x64
```

The script downloads `Rack-SDK-2.6.6-<platform>.zip` from `vcvrack.com`. All four
platform archives carry a pinned SHA-256, and a mismatch exits non-zero before
anything is unzipped. The unpinned-checksum warning path in the script is dead
code kept for a platform that does not currently exist. If `vendor/Rack-SDK`
already exists the script is a no-op, so delete that directory to re-fetch.

On success it prints `Rack SDK 2.6.6 (<platform>) ready at vendor/Rack-SDK`.

## 3. Build and package the plugin

The plugin `Makefile` includes the SDK's `plugin.mk`. Build against the fetched SDK
via `RACK_DIR` (which defaults to `../../vendor/Rack-SDK`, so it usually needs no
override):

```bash
# Compile the plugin.
make -C plugins/RackMCP RACK_DIR=../../vendor/Rack-SDK

# Package it into a distributable .vcvplugin (a zstd tarball, per Rack SDK convention).
make -C plugins/RackMCP dist RACK_DIR=../../vendor/Rack-SDK
```

`make dist` writes the package to `plugins/RackMCP/dist/`:

```
plugins/RackMCP/dist/RackMCP-2.0.0-<os>-<arch>.vcvplugin
```

The `<os>-<arch>` suffix matches the SDK platform — for example
`RackMCP-2.0.0-mac-arm64.vcvplugin`. The `plugin.json` version is `2.0.0`.

> **Windows:** run both `make` commands from the MSYS2 **MINGW64** shell so the
> MinGW `gcc`, `make`, and `unzip`/`zip` are on `PATH`.

## 4. Install the plugin into Rack

Rack loads user plugins from the `plugins/` subdirectory of the **Rack user
directory** (see the [table below](#rack-user-directory)). Two equivalent options:

- **Copy the package in.** Place the `.vcvplugin` file in `<RackUserDir>/plugins/`.
  Rack unpacks and loads it on the next launch.
- **Double-click the `.vcvplugin`.** With Rack installed, opening the file hands it
  to Rack, which installs it into the same `plugins/` directory.

For example, on macOS:

```bash
cp plugins/RackMCP/dist/RackMCP-2.0.0-mac-arm64.vcvplugin \
  "$HOME/Library/Application Support/Rack2/plugins/"
```

Then (re)launch Rack, add a **RackMCP-Bridge** module to your patch, and — the first
time the plugin loads — it creates the pairing secret at
`<RackUserDir>/RackMCP/secret`. At least one Bridge module must be present for the
bridge service and pairing to be active. See the [pairing and multi-instance
guide](../security/pairing-and-multi-instance.md) for details.

## 5. Build the MCP server

The server is a TypeScript workspace. Install dependencies, build every package,
then produce the single-file bundle:

```bash
# From the repo root.
pnpm install
pnpm -r build
pnpm --filter @rackmcp/mcp-server run bundle
```

The bundle step (`apps/mcp-server/bundle.mjs`) uses esbuild to inline every
dependency — the MCP SDK, zod, and the `@rackmcp/*` workspace packages — into one
self-contained ESM file:

```
apps/mcp-server/dist/bundle/rack-mcp-server.mjs
```

It also copies `rackwright.md` into the same directory. The server reads that prompt
at runtime relative to the bundle, so **keep `rackwright.md` beside the `.mjs`** if
you move the bundle elsewhere. `pnpm -r build` must run before the bundle, because
esbuild resolves the `@rackmcp/*` packages through their built `dist`.

Diagnostics go to **stderr**; **stdout is reserved for the MCP protocol**.

## 6. Point your MCP host at the server

Configure your host to launch the server with `node` and an **absolute path** to the
bundled `rack-mcp-server.mjs`. A generic stdio-host entry:

```json
{
  "mcpServers": {
    "rack-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/apps/mcp-server/dist/bundle/rack-mcp-server.mjs"],
      "env": {
        "RACKMCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Set environment variables only as needed (read in `apps/mcp-server/src/config.ts`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `RACKMCP_RACK_USER_DIR` | Platform Rack 2 user dir | Point the server at a non-default Rack user directory. Discovery, checkpoints, patches, and audit all derive from it. |
| `RACKMCP_REQUEST_DEADLINE_MS` | `5000` | Default bridge request deadline, in ms. |
| `RACKMCP_AUDIT_MAX_BYTES` | `8388608` | Size at which the audit log rotates to `audit.log.1`. `0` disables rotation. |
| `RACKMCP_AUDIT_MAX_AGE_DAYS` | `30` | How long a rotated audit generation is kept. `0` keeps it indefinitely. |
| `RACKMCP_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. |

There is no separate discovery-directory variable — the server derives
`RackMCP/instances`, `RackMCP/checkpoints`, `patches`, and `RackMCP/audit` from the
Rack user directory. Set `RACKMCP_RACK_USER_DIR` only when Rack itself runs with a
non-default user directory; otherwise omit it and the server uses the platform
default below.

See the [MCP host configuration examples](./configuration-examples.md) for
host-specific entries and the full environment-variable reference.

## Rack user directory

`defaultRackUserDir()` in `apps/mcp-server/src/config.ts` resolves the Rack user
directory per platform. The plugin, and the server when `RACKMCP_RACK_USER_DIR` is
unset, use these locations:

| Platform | Default Rack user directory | Plugins go in |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Rack2` | `<dir>/plugins/` |
| Windows | `%LOCALAPPDATA%\Rack2` (falls back to `~\AppData\Local\Rack2` if `LOCALAPPDATA` is unset) | `<dir>\plugins\` |
| Linux / other | `$XDG_DATA_HOME/Rack2` (default `~/.local/share/Rack2`) | `<dir>/plugins/` |

> These match Rack 2.6.6's own defaults (`asset.cpp`). Rack 2.5+ moved the Linux
> directory from `~/.Rack2` to the XDG data dir and migrates the old folder itself.
> The server also honours Rack's `RACK_USER_DIR` environment variable; its own
> `RACKMCP_RACK_USER_DIR` takes precedence over both.

## Verifying the install

1. Launch Rack 2.6.6 with a **RackMCP-Bridge** module in the patch. The Bridge panel
   shows connection status and the writer-lease owner.
2. Start your MCP host so it launches the server.
3. From the host, call `list_rack_instances` — the running instance should appear.
   `get_rack_status` confirms the bridge is connected. If exactly one instance is
   running, tools auto-select it; otherwise call `select_rack_instance` first.

If a tool returns `RACK_NOT_FOUND` or `BRIDGE_NOT_READY`, confirm Rack is running
with a Bridge module and that `RACKMCP_RACK_USER_DIR` (if set) matches Rack's actual
user directory. The full code list is in the [tool reference](./tool-reference.md).

## Next steps

Add a **RackMCP-Tutorial** module to your rack. It walks the nine checkpoints
between here and a patch you can hear, and each one is checked against the live
rack rather than ticked off by hand:

| # | Checkpoint | What it verifies |
| --- | --- | --- |
| 1 | `bridge_running` | The plugin's loopback listener is up |
| 2 | `bridge_module` | A Bridge module is in the patch and the command pump attached |
| 3 | `host_connected` | A client completed the pairing handshake |
| 4 | `patch_read` | The assistant has run at least one bridge method |
| 5 | `lease_acquired` | The writer lease is held |
| 6 | `transaction_committed` | A transaction has been applied |
| 7 | `modules_added` | Three or more non-RackMCP modules, two or more cables |
| 8 | `audio_path` | A cable reaches an audio destination |
| 9 | `patch_saved` | The patch is saved and has a filename |

The panel is not a copy of this guide: it never prints a command, and it can say
things a document cannot — that a client is failing the handshake because its
pairing secret is stale, or which host is currently holding the writer lease.
The commands stay here; the live state stays there.

- [MCP host configuration examples](./configuration-examples.md)
- [Pairing and multi-instance guide](../security/pairing-and-multi-instance.md)
- [Tool reference](./tool-reference.md)
