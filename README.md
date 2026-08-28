# Rack MCP

A production-quality, safety-first [Model Context Protocol](https://modelcontextprotocol.io)
integration for [VCV Rack](https://vcvrack.com) 2.6.6 (Free or Pro, standalone GUI mode).

Rack MCP lets an MCP client (Claude and other MCP hosts) discover running Rack
instances, inspect patches, explain and validate signal flow, preview and
atomically apply structured patch changes, manage patch files with checkpoints
and recovery, and read signal telemetry through a dedicated Probe module —
all locally, with explicit confirmation for destructive changes.

## Components

| Path | What | License |
| --- | --- | --- |
| `apps/mcp-server` | Stdio MCP server (TypeScript, MCP SDK v2) | MIT |
| `plugins/RackMCP` | Rack 2 plugin: Bridge + Probe modules, loopback bridge service | GPL-3.0-or-later |
| `packages/schemas` | Canonical Zod schemas -> JSON Schema + C++ codegen | MIT |
| `packages/protocol` | Bridge framing + client (TypeScript side) | MIT |
| `packages/adapters` | Versioned module adapters (Core + Fundamental pack) | MIT |
| `packages/recipes` | Versioned high-level patch recipes | MIT |
| `packages/test-client` | Scriptable MCP test client | MIT |

See `LICENSE.md` for the licensing layout and `docs/` for architecture,
security, tools and guides. Start with
`docs/architecture/ADR-0001-execution-model.md`.

## Status

Under active phased development. Each phase leaves the repository runnable and
tested; see the phase plan in ADR-0001 and the spec-mapped test suites under
`tests/`.

## Development

```
pnpm install
pnpm run build     # build all TS packages
pnpm run test      # unit + contract tests
pnpm run gen       # regenerate JSON Schema + C++ protocol artifacts
cmake -S tests/cpp -B tests/cpp-build && cmake --build tests/cpp-build && ctest --test-dir tests/cpp-build
./scripts/fetch-rack-sdk.sh          # pinned Rack SDK 2.6.6
make -C plugins/RackMCP RACK_DIR=../../vendor/Rack-SDK
```

Unsupported environments (stated plainly): Rack Pro inside a DAW, headless
Rack, and Rack versions other than 2.6.6 are not production-supported until
each gains its own tested execution adapter.
