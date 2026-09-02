# VCV Licensing Note

Rack MCP is a split-license project. The VCV Rack plugin is copyleft; the
TypeScript server and every published package are permissive. This note
explains which license applies where, why the split exists, and what it means
for distributing the plugin through the VCV Library or anywhere else.

> **Not legal advice.** This document records the project's licensing intent and
> the practical constraints VCV places on Rack plugins. It is written for a
> technical audience installing, operating, or extending Rack MCP — not as a
> legal opinion. If you plan to redistribute, sell, or relicense any part of
> this project, confirm your obligations with a qualified attorney and with VCV.

## Who this note is for

- People **using** Rack MCP: nothing here changes how you run it. Both licenses
  permit private use freely.
- People **redistributing** the plugin (mirroring builds, packaging it, or
  submitting it to the VCV Library): read the [GPL obligations](#gpl-obligations)
  and [VCV Library](#distributing-through-the-vcv-library) sections.
- People **selling** the plugin or shipping it under non-GPL terms: read
  [Commercial and non-GPL distribution](#commercial-and-non-gpl-distribution)
  first — you must arrange VCV commercial licensing before release.

## License by component

The repository is licensed by component. The split follows the monorepo
boundary between the C++ Rack plugin and everything else.

| Component | Path | License | Reference |
| --- | --- | --- | --- |
| Rack plugin (Bridge + Probe modules, bridge service) | `plugins/RackMCP/` | **GPL-3.0-or-later** | [`plugins/RackMCP/LICENSE`](../../plugins/RackMCP/LICENSE) |
| MCP stdio server | `apps/mcp-server/` | **MIT** | [`LICENSE-MIT`](../../LICENSE-MIT) |
| Schemas, protocol, adapters, recipes, test client | `packages/*` | **MIT** | [`LICENSE-MIT`](../../LICENSE-MIT) |
| Scripts, tests, docs | `scripts/`, `tests/`, `docs/` | **MIT** | [`LICENSE-MIT`](../../LICENSE-MIT) |

The top-level [`LICENSE.md`](../../LICENSE.md) is the authoritative summary of
this split. The plugin manifest [`plugins/RackMCP/plugin.json`](../../plugins/RackMCP/plugin.json)
declares `"license": "GPL-3.0-or-later"` (plugin version `2.0.0`), which is the
value Rack and the VCV Library read.

Nothing under `apps/` or `packages/` contains Rack code, so the MIT components
carry no GPL obligation. Only `plugins/RackMCP/` links the Rack SDK, and only it
is GPL.

## Why the plugin is GPL and the rest is MIT

VCV Rack itself is licensed GPLv3. A Rack plugin is built against the Rack SDK
and links the Rack application at runtime, so the plugin and Rack form a single
combined work in the GPL sense. Rack plugins that link the GPL Rack application
are therefore themselves required to be GPL-compatible, and the project licenses
`plugins/RackMCP/` as **GPL-3.0-or-later** to satisfy that requirement cleanly.

The MCP server and the `packages/*` libraries are a different story. They are
ordinary TypeScript that talks to the plugin over a loopback TCP bridge (a
length-prefixed JSON protocol on `127.0.0.1`). They do not link Rack, include no
Rack source, and are useful independently of it, so they are released under the
permissive **MIT** license ([`LICENSE-MIT`](../../LICENSE-MIT)). Keeping the
server and packages MIT lets them be embedded, adapted, or reused with minimal
friction, while the copyleft obligation stays contained to the one component
that actually links Rack.

## GPL obligations

When you **distribute** the plugin (the built `.vcvplugin`, or its source), the
GPL-3.0-or-later terms in [`plugins/RackMCP/LICENSE`](../../plugins/RackMCP/LICENSE)
apply. In practical terms:

- **Provide corresponding source.** Recipients of a binary must be able to get
  the complete source for that plugin under the GPL.
- **Preserve license and copyright notices.** Keep the GPL notice and author
  attribution intact.
- **Downstream keeps the same freedoms.** Anyone you convey the plugin to
  receives the same GPL rights to run, study, modify, and redistribute it.
- **No further restrictions.** You cannot add terms that restrict the rights the
  GPL grants.

Merely **running** the plugin, or building it for your own use, triggers none of
these — the obligations attach to conveying copies to others.

## Distributing through the VCV Library

Distributing the plugin **free of charge under GPL is fully compatible** with
the VCV Library and with VCV's rules for Rack plugins. The GPL-3.0-or-later
license was chosen precisely so that a free-of-charge release "just works": it is
GPL-compatible, the source is available, and no separate arrangement with VCV is
required for a gratis, open-source plugin.

If you build and submit the plugin to the Library, the standard packaging path
applies:

```bash
# Fetch the Rack SDK for your platform, then build and package.
scripts/fetch-rack-sdk.sh mac-arm64
make -C plugins/RackMCP RACK_DIR=../../vendor/Rack-SDK
make -C plugins/RackMCP dist
# Produces plugins/RackMCP/dist/RackMCP-<version>-<os>-<arch>.vcvplugin
```

The resulting `.vcvplugin` is a zstd tarball following the Rack SDK convention.
Distributing it for free carries only the ordinary [GPL obligations](#gpl-obligations)
above.

## Commercial and non-GPL distribution

The compatibility above holds **only for free-of-charge GPL distribution**. If
the plugin were ever:

- **sold** (offered for a price through the VCV Library or elsewhere), or
- **distributed under non-GPL or otherwise commercial terms**,

then **VCV commercial licensing must be arranged with VCV before release.** This
is a VCV requirement for paid or non-GPL Rack plugins, and it is separate from —
and in addition to — the copyright license on this repository. Do not sell or
relicense the plugin, or ship a non-GPL build, until that arrangement is in place.

This constraint applies to the `plugins/RackMCP/` component only. The MIT-licensed
server and packages are not Rack plugins and are not subject to VCV's plugin
distribution rules; the MIT license already permits commercial use, sale, and
sublicensing of those parts.

## What this project does and does not bundle

Rack MCP ships **only its own plugin** (`plugins/RackMCP/`, containing the
`Bridge` and `Probe` modules) and its own MIT-licensed server and packages. It
does **not** redistribute any VCV property:

- **VCV Rack itself** — the application and SDK — is VCV's. You obtain Rack from
  VCV. This repository builds against the Rack SDK (fetched at build time into
  `vendor/Rack-SDK`); it does not vendor or ship Rack.
- **The Core and Fundamental modules** shipped with Rack are VCV's. Rack MCP's
  [module adapters](../module-adapters/) describe the *semantics* of some Core
  and Fundamental models so the server can operate them safely, but they contain
  no VCV code or assets and do not redistribute those modules.
- **VCV Pro** and any other proprietary VCV assets are never bundled, copied, or
  redistributed by this project.

In short: this project distributes its own GPL plugin plus its own MIT tooling,
and nothing that belongs to VCV.

## Related documents

- [`LICENSE.md`](../../LICENSE.md) — the authoritative license split for the repo.
- [`LICENSE-MIT`](../../LICENSE-MIT) — MIT text covering the server and packages.
- [`plugins/RackMCP/LICENSE`](../../plugins/RackMCP/LICENSE) — full GPL-3.0 text
  for the plugin.
- [`plugins/RackMCP/plugin.json`](../../plugins/RackMCP/plugin.json) — the plugin
  manifest that declares the GPL license to Rack.
- [Rack MCP specification, section 14](../spec/rack-mcp-spec.md) — the
  requirement to document these licensing implications.
