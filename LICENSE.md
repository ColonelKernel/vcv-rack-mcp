# Rack MCP licensing

Rack MCP is a monorepo with two licensing zones:

- **`plugins/RackMCP/`** (the VCV Rack plugin) is licensed under the
  **GNU General Public License v3.0 or later** (GPL-3.0-or-later).
  See `plugins/RackMCP/LICENSE`.
  It links against the VCV Rack SDK / Rack application API. VCV requires Rack
  plugins to be distributed under a GPLv3-compatible license unless a commercial
  license is arranged with VCV. This plugin is distributed free of charge under
  the GPL, which satisfies that requirement. If this plugin is ever sold under
  non-GPL terms, VCV commercial licensing must be arranged before release.

- **Everything else** (`apps/`, `packages/`, `scripts/`, `tests/`, `docs/`) is
  licensed under the **MIT License**. See `LICENSE-MIT`. These components do not
  link against or include any VCV Rack code; they communicate with the plugin
  only over a local socket protocol.

Panel artwork under `plugins/RackMCP/res/` is original to this project and
licensed with the plugin (GPL-3.0-or-later). The "VCV" name and Rack component
graphics remain the property of VCV; this project uses only the Rack SDK's
public component library at build time.

See `docs/security/licensing.md` for the full licensing note.
