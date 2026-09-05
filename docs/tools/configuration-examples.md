# MCP host configuration

Rack MCP runs as a local stdio MCP server. Configure your MCP host to launch it
with Node.js 20+. The server discovers Rack via the local manifest directory;
no network configuration is required.

## Generic stdio config

```json
{
  "mcpServers": {
    "rack-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/apps/mcp-server/dist/index.js"],
      "env": {
        "RACKMCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `RACKMCP_RACK_USER_DIR` | Platform Rack 2 user dir | Override the Rack user directory (discovery, patches, checkpoints, audit all derive from it). |
| `RACKMCP_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`. Logs go to stderr only. |
| `RACKMCP_REQUEST_DEADLINE_MS` | `5000` | Default bridge request deadline. |
| `RACKMCP_AUDIT_MAX_BYTES` | `8388608` | Size at which the audit log rotates to `audit.log.1`. `0` disables rotation. |
| `RACKMCP_AUDIT_MAX_AGE_DAYS` | `30` | How long a rotated audit generation is kept. `0` keeps it indefinitely. |

Default Rack user directory:

- macOS: `~/Library/Application Support/Rack2`
- Windows: `%LOCALAPPDATA%\Rack2`
- Linux: `~/.local/share/Rack2`

## Prerequisites

1. VCV Rack 2.6.6 (Free or Pro), standalone GUI mode, running.
2. The RackMCP plugin installed and at least one **RackMCP-Bridge** module in
   the patch (this attaches the command pump and enables pairing after restart).
3. The pairing secret at `<RackUserDir>/RackMCP/secret` is created automatically
   on first plugin load; the server reads it to authenticate locally.

## Usage notes

- If exactly one Rack instance is running, tools auto-select it. With multiple
  instances, call `select_rack_instance` first (`list_rack_instances` shows the
  choices).
- Mutating tools require the writer lease; the server acquires it as needed and
  it is visible on the Bridge module's panel.
