# MCP host configuration

Rack MCP runs as a local stdio MCP server. A host launches it with Node.js 20 or
newer and talks to it over stdin/stdout; there is no port to open and no network
configuration. The server finds Rack through a manifest directory under the Rack
user dir, so the only thing a host has to get right is the command line.

## Which file to launch

There are two launch targets and they are not interchangeable.

| Target | Path | Use it when |
| --- | --- | --- |
| Bundle | `apps/mcp-server/dist/bundle/rack-mcp-server.mjs` | You installed a release, or you want one file with no `node_modules` around it. Produced by `pnpm --filter @rackmcp/mcp-server run bundle`. |
| Workspace build | `apps/mcp-server/dist/index.js` | You are working in a clone. Produced by `pnpm -r build`, and it needs the repo's `node_modules` to stay in place. |

Both need **`rackwright.md` next to the module that reads it** — the bundle keeps
it in `dist/bundle/`, the workspace build in `dist/prompts/`. Each build step puts
it there for you. If it goes missing the server does not start with degraded
prompts, it fails to start at all: `prompts/index.ts` reads the file at module
load, so the import throws and the host reports a server that exited immediately.
Copy the `.mjs` somewhere on its own and you will see exactly that.

## Generic stdio config

Every host that speaks MCP over stdio accepts some spelling of this. Use an
**absolute** path — hosts do not agree on what the working directory is.

```json
{
  "mcpServers": {
    "rack-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/dist/bundle/rack-mcp-server.mjs"],
      "env": {
        "RACKMCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

## Where that config goes

| Host | Configuration | Notes |
| --- | --- | --- |
| Claude Code | `.mcp.json` in the project root | This repo ships one, pointing at the workspace build. Open the repo and approve the server when prompted. |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` | Restart the app after editing; it launches servers at startup. |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` | As above. |
| Anything else | Consult the host's own documentation | The JSON above is the whole contract: a command, its arguments, and an environment. If a host can launch a stdio MCP server it can launch this one. |

Only the first three rows have been exercised against this server. The last is a
statement about the protocol, not a claim of testing.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `RACKMCP_RACK_USER_DIR` | Platform Rack 2 user dir | Override the Rack user directory. Discovery, patches, checkpoints and the audit log all derive from it, so this is the one variable that changes which Rack you talk to. |
| `RACK_USER_DIR` | — | Rack's own variable, honoured as a fallback when `RACKMCP_RACK_USER_DIR` is unset. Set the Rack MCP one to disagree with Rack deliberately. |
| `RACKMCP_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`. Diagnostics go to stderr only — stdout carries the MCP transport, so anything written there would corrupt the session. |
| `RACKMCP_REQUEST_DEADLINE_MS` | `5000` | Default bridge request deadline. |
| `RACKMCP_AUDIT_MAX_BYTES` | `8388608` | Size at which the audit log rotates to `audit.log.1`. `0` disables rotation. |
| `RACKMCP_AUDIT_MAX_AGE_DAYS` | `30` | How long a rotated audit generation is kept. `0` keeps it indefinitely. |

Default Rack user directory:

- macOS: `~/Library/Application Support/Rack2`
- Windows: `%LOCALAPPDATA%\Rack2`
- Linux: `~/.local/share/Rack2`

## Before the tools will do anything

1. VCV Rack 2.6.6 (Free or Pro), standalone GUI, running. Rack Pro inside a DAW
   and headless Rack are not supported.
2. The RackMCP plugin installed, with at least one **RackMCP-Bridge** module in
   the patch. The module is what attaches the command pump; without one the
   server discovers nothing.
3. The pairing secret at `<RackUserDir>/RackMCP/secret`, created by the plugin on
   first load. The server reads it to authenticate over loopback. You never enter
   it anywhere.

## Usage notes

- With exactly one Rack instance running, tools auto-select it. With more than
  one, call `select_rack_instance` first; `list_rack_instances` shows the
  choices.
- Mutating tools require the writer lease. The server acquires it as needed and
  the Bridge module's panel shows when it is held, so you can see from Rack
  whether something else is holding the patch.

If the server starts but finds no Rack, work through
[the troubleshooting guide](./troubleshooting.md) — the first connection is where
almost every problem is.
