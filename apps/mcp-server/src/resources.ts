import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listAdapters } from "@rackmcp/adapters";
import { listRecipes, resolveRecipe, type InstalledModel } from "@rackmcp/recipes";
import type { ConnectionManager } from "./connection.js";
import type { AuditLog } from "./audit.js";

/**
 * MCP resources (spec section 9): rack://status, rack://patch/current,
 * rack://catalog/models, rack://adapters, rack://recipes, rack://audit/recent.
 * Read-only projections with response-size caps and pagination. Resources that
 * need a live instance degrade to a {connected:false} hint rather than erroring.
 */

export interface ResourceDeps {
  conn: ConnectionManager;
  audit: AuditLog;
  resultLimitBytes: number;
}

const MODELS_PAGE = 300;
const AUDIT_RECENT = 50;

function json(uri: string, payload: unknown, limitBytes: number) {
  let text = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(text, "utf8") > limitBytes) {
    text = JSON.stringify(
      { truncated: true, reason: `resource exceeds ${limitBytes} bytes`, uri },
      null,
      2,
    );
  }
  return { contents: [{ uri, mimeType: "application/json", text }] };
}

/** Collect installed models across catalog pages, bounded, as role targets. */
interface ModelsPage {
  items: Array<{ pluginSlug: string; modelSlug: string }>;
  nextCursor: string | null;
}

async function installedModels(conn: ConnectionManager, maxPages = 4): Promise<InstalledModel[]> {
  const out: InstalledModel[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res: ModelsPage = await conn.request<ModelsPage>("catalog.listModels", {
      limit: MODELS_PAGE,
      cursor: cursor ?? undefined,
    });
    for (const m of res.items) out.push({ pluginSlug: m.pluginSlug, modelSlug: m.modelSlug });
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return out;
}

export function registerResources(server: McpServer, deps: ResourceDeps): void {
  const { conn, audit, resultLimitBytes: limit } = deps;

  server.registerResource(
    "rack-status",
    "rack://status",
    { title: "Rack status", description: "Discovery and connection status for the selected Rack instance.", mimeType: "application/json" },
    async (uri) => {
      const instances = conn.listInstances().map((i) => ({
        instanceId: i.manifest.instanceId,
        patchName: i.manifest.patchName,
        rackEdition: i.manifest.rackEdition,
        stale: i.stale,
      }));
      const selected = conn.selectedInstance;
      let status: unknown = null;
      let metrics: unknown = null;
      if (selected) {
        try {
          status = await conn.request("status.get", {});
          metrics = await conn.request("metrics.get", {});
        } catch {
          /* leave null on transient failure */
        }
      }
      return json(uri.href, {
        connected: !!selected,
        selectedInstanceId: selected?.instanceId ?? null,
        instances,
        status,
        metrics,
      }, limit);
    },
  );

  server.registerResource(
    "rack-patch-current",
    "rack://patch/current",
    { title: "Current patch", description: "Structured snapshot of the current patch (opaque state excluded).", mimeType: "application/json" },
    async (uri) => {
      if (!conn.selectedInstance) {
        return json(uri.href, { connected: false, hint: "select a Rack instance first" }, limit);
      }
      try {
        const snap = await conn.request("patch.snapshot", { includeOpaqueState: false });
        return json(uri.href, snap, limit);
      } catch (e) {
        return json(uri.href, { connected: true, error: String(e) }, limit);
      }
    },
  );

  server.registerResource(
    "rack-catalog-models",
    "rack://catalog/models",
    { title: "Installed models", description: "First page of installed plugin models for the selected instance.", mimeType: "application/json" },
    async (uri) => {
      if (!conn.selectedInstance) {
        return json(uri.href, { connected: false, hint: "select a Rack instance first" }, limit);
      }
      try {
        const res = await conn.request<{ items: unknown[]; total: number; nextCursor: string | null }>(
          "catalog.listModels",
          { limit: MODELS_PAGE },
        );
        return json(uri.href, { models: res.items, total: res.total, nextCursor: res.nextCursor }, limit);
      } catch (e) {
        return json(uri.href, { connected: true, error: String(e) }, limit);
      }
    },
  );

  server.registerResource(
    "rack-adapters",
    "rack://adapters",
    { title: "Adapter pack", description: "Verified module adapters (semantics, port roles, safe values).", mimeType: "application/json" },
    (uri) => json(uri.href, { adapters: listAdapters() }, limit),
  );

  server.registerResource(
    "rack-recipes",
    "rack://recipes",
    { title: "Recipe library", description: "High-level recipes; resolved against installed models when connected.", mimeType: "application/json" },
    async (uri) => {
      const recipes = listRecipes();
      let resolutions: Record<string, unknown> | null = null;
      if (conn.selectedInstance) {
        try {
          const installed = await installedModels(conn);
          resolutions = {};
          for (const r of recipes) resolutions[r.id] = resolveRecipe(r, installed);
        } catch {
          resolutions = null;
        }
      }
      return json(uri.href, { recipes, resolutions }, limit);
    },
  );

  server.registerResource(
    "rack-audit-recent",
    "rack://audit/recent",
    { title: "Recent audit", description: "Most-recent tool invocations recorded by this server.", mimeType: "application/json" },
    (uri) => json(uri.href, { entries: audit.recent(AUDIT_RECENT) }, limit),
  );
}
