import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listAdapters } from "@rackmcp/adapters";
import { listRecipes, resolveRecipe, type InstalledModel } from "@rackmcp/recipes";
import { RESOURCES, type ResourceSpec } from "@rackmcp/schemas";
import type { ConnectionManager } from "./connection.js";
import type { AuditLog } from "./audit.js";
import { ToolError, toErrorPayload } from "./errors.js";
import { log } from "./logger.js";
import { listInstanceSummaries, mapStatus } from "./projections.js";

/**
 * MCP resources (spec section 9): rack://status, rack://patch/current,
 * rack://catalog/models, rack://adapters, rack://recipes, rack://audit/recent.
 *
 * Every body is an envelope naming its own `state` (see packages/schemas
 * resources.ts). Resources that need a live instance still degrade rather than
 * erroring -- that is deliberate -- but they now say which situation they are
 * in with a code a client can branch on, instead of three unannounced shapes
 * sharing one URI.
 */

export interface ResourceDeps {
  conn: ConnectionManager;
  audit: AuditLog;
  resultLimitBytes: number;
}

const MODELS_PAGE = 300;
const AUDIT_RECENT = 50;
/** Pages of MODELS_PAGE scanned when resolving recipes against the catalog. */
const MAX_CATALOG_PAGES = 4;

interface ModelsPage {
  models: Array<{ pluginSlug: string; modelSlug: string }>;
  totalModels: number;
  nextCursor: string | null;
}

interface CatalogScan {
  models: InstalledModel[];
  /** False when paging stopped with a live cursor still outstanding. */
  complete: boolean;
  totalModels: number | null;
}

/**
 * Collects installed models across catalog pages as recipe role targets.
 *
 * Bounded, and the bound is reported. Resolving a recipe against a partial
 * catalog does not produce a missing answer, it produces a WRONG one: the
 * bridge orders the catalog by plugin slug then model slug, so stopping early
 * cuts the alphabet, and every role whose module sits past the cut comes back
 * as "not installed" on a machine where it is installed. The caller needs to
 * know the scan was truncated before it trusts an unresolved role.
 */
async function scanInstalledModels(conn: ConnectionManager): Promise<CatalogScan> {
  const models: InstalledModel[] = [];
  let cursor: string | null = null;
  let totalModels: number | null = null;
  for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
    const res: ModelsPage = await conn.request<ModelsPage>("catalog.listModels", {
      limit: MODELS_PAGE,
      cursor: cursor ?? undefined,
    });
    if (typeof res.totalModels === "number") totalModels = res.totalModels;
    for (const m of res.models) models.push({ pluginSlug: m.pluginSlug, modelSlug: m.modelSlug });
    cursor = res.nextCursor;
    if (!cursor) return { models, complete: true, totalModels };
  }
  return { models, complete: false, totalModels };
}

/**
 * Degradation body for a resource that needs an instance it cannot get.
 *
 * The trigger is serviceability, not whether a selection happens to be
 * recorded: conn.request() auto-selects when exactly one live instance exists,
 * so gating on `selectedInstance` made the resources answer "select an
 * instance first" in precisely the state where the equivalent tools returned
 * data -- and made a URI's shape depend on call history rather than on what is
 * running.
 */
function unavailable(spec: ResourceSpec, conn: ConnectionManager, err: unknown) {
  const live = conn.listInstances().filter((i) => !i.stale).length;
  const code =
    err instanceof ToolError &&
    (err.code === "INSTANCE_NOT_SELECTED" || err.code === "RACK_DISCONNECTED")
      ? err.code
      : "RACK_NOT_FOUND";
  // The hint follows `live`, not the code alone: the selected instance can go
  // away while others keep running, and telling someone to start Rack while
  // one is listed in the same body is advice that cannot help them.
  const hint =
    live > 0
      ? `${live} Rack instance${live === 1 ? " is" : "s are"} running but none is connected; ` +
        `call select_rack_instance to choose one`
      : code === "RACK_DISCONNECTED"
        ? "the bridge session was lost; the instance may have quit"
        : "start Rack with the RackMCP Bridge module in the patch";
  return { state: "unavailable" as const, uri: spec.uri, code, discoveredInstances: live, hint };
}

/** True when the throwable means "no instance to serve this", not "the read failed". */
function isUnavailable(err: unknown): boolean {
  return (
    err instanceof ToolError &&
    (err.code === "RACK_NOT_FOUND" ||
      err.code === "INSTANCE_NOT_SELECTED" ||
      err.code === "RACK_DISCONNECTED")
  );
}

export function registerResources(server: McpServer, deps: ResourceDeps): void {
  const { conn, audit, resultLimitBytes: limit } = deps;

  /**
   * Serializes a body, enforces the size cap, and validates against the
   * resource's declared schema.
   *
   * Validation is non-fatal for the same reason tool-output validation is
   * (server.ts): a schema complaint must never turn a working read into a hard
   * error, and the bridge is the producer for three of these bodies. It is
   * logged to stderr and audited with `schemaValid: false` in the same shape
   * the tool surface uses, so one grep finds drift on either surface.
   */
  function body(spec: ResourceSpec, payload: unknown) {
    let text = JSON.stringify(payload, null, 2);
    const size = Buffer.byteLength(text, "utf8");
    if (size > limit) {
      payload = {
        state: "truncated" as const,
        uri: spec.uri,
        sizeBytes: size,
        limitBytes: limit,
        useTool: spec.truncationTool,
        reason: `resource body is ${size} bytes; the cap is ${limit}`,
      };
      text = JSON.stringify(payload, null, 2);
      log.warn("resource body exceeded the size cap", {
        uri: spec.uri,
        sizeBytes: size,
        limitBytes: limit,
      });
    }
    const parsed = spec.output.safeParse(payload);
    if (!parsed.success) {
      log.error("resource body failed schema validation", {
        uri: spec.uri,
        issueCount: parsed.error.issues.length,
        issues: parsed.error.issues
          .slice(0, 8)
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
      });
      audit.record({ tool: `resource:${spec.uri}`, outcome: "ok", schemaValid: false });
    }
    return { contents: [{ uri: spec.uri, mimeType: "application/json", text }] };
  }

  const meta = (spec: ResourceSpec) => ({
    title: spec.title,
    description: spec.description,
    mimeType: "application/json",
  });
  const spec = (uri: string): ResourceSpec => {
    const found = RESOURCES.find((r) => r.uri === uri);
    if (!found) throw new Error(`no resource spec for ${uri}`);
    return found;
  };

  // --- rack://status -------------------------------------------------------
  const statusSpec = spec("rack://status");
  server.registerResource(statusSpec.name, statusSpec.uri, meta(statusSpec), async () => {
    // Reads what is, rather than making it so. The other live resources call
    // through conn.request() and let it auto-select, because their job is to
    // serve data. This one's job is to report the connection, and a status
    // read that establishes the connection it is reporting on would both
    // change state as a side effect and make `connected` always true. The cost
    // is that `connected` is false until something else selects -- which is
    // the honest answer (`instances` lists the live Rack that is available),
    // and is exactly what get_rack_status returns on the same state.
    const selected = conn.selectedInstance;
    let status: unknown = null;
    let statusError: unknown = null;
    let metrics: unknown = null;
    let metricsError: unknown = null;
    // Attempted separately: status.get can succeed while metrics.get fails,
    // and one shared catch reported that as "both unavailable".
    if (selected) {
      try {
        status = mapStatus(await conn.request<Record<string, unknown>>("status.get", {}));
      } catch (e) {
        statusError = toErrorPayload(e);
      }
      try {
        metrics = await conn.request("metrics.get", {});
      } catch (e) {
        metricsError = toErrorPayload(e);
      }
    }
    return body(statusSpec, {
      state: "ok",
      uri: statusSpec.uri,
      data: {
        // The live session, not the remembered selection: a selection outlives
        // the instance, so deriving this from `selected` alone reported a
        // connection indefinitely after Rack quit.
        connected: !!selected && conn.connected,
        selectedInstanceId: selected?.instanceId ?? null,
        instances: listInstanceSummaries(conn),
        status,
        statusError,
        metrics,
        metricsError,
      },
    });
  });

  // --- rack://patch/current ------------------------------------------------
  const patchSpec = spec("rack://patch/current");
  server.registerResource(patchSpec.name, patchSpec.uri, meta(patchSpec), async () => {
    try {
      const snap = await conn.request("patch.snapshot", { includeOpaqueState: false });
      return body(patchSpec, { state: "ok", uri: patchSpec.uri, data: snap });
    } catch (e) {
      if (isUnavailable(e)) return body(patchSpec, unavailable(patchSpec, conn, e));
      return body(patchSpec, { state: "error", uri: patchSpec.uri, error: toErrorPayload(e) });
    }
  });

  // --- rack://catalog/models ----------------------------------------------
  const catalogSpec = spec("rack://catalog/models");
  server.registerResource(catalogSpec.name, catalogSpec.uri, meta(catalogSpec), async () => {
    try {
      const res = await conn.request<{ nextCursor: string | null }>("catalog.listModels", {
        limit: MODELS_PAGE,
      });
      return body(catalogSpec, {
        state: "ok",
        uri: catalogSpec.uri,
        data: res,
        continueWith: { tool: "list_installed_models", cursor: res.nextCursor ?? null },
      });
    } catch (e) {
      if (isUnavailable(e)) return body(catalogSpec, unavailable(catalogSpec, conn, e));
      return body(catalogSpec, { state: "error", uri: catalogSpec.uri, error: toErrorPayload(e) });
    }
  });

  // --- rack://adapters -----------------------------------------------------
  const adaptersSpec = spec("rack://adapters");
  server.registerResource(adaptersSpec.name, adaptersSpec.uri, meta(adaptersSpec), () =>
    body(adaptersSpec, {
      state: "ok",
      uri: adaptersSpec.uri,
      data: { adapters: listAdapters() },
    }),
  );

  // --- rack://recipes ------------------------------------------------------
  const recipesSpec = spec("rack://recipes");
  server.registerResource(recipesSpec.name, recipesSpec.uri, meta(recipesSpec), async () => {
    const recipes = listRecipes();
    let resolutions: Record<string, unknown> | null = null;
    let resolutionState: "resolved" | "partial" | "unavailable" | "failed" = "unavailable";
    let resolutionError: unknown = null;
    // Starts incomplete: if the scan throws, "complete" would otherwise be a
    // claim about a scan that never finished -- and `catalogComplete: true`
    // beside `modelsScanned: 0` is exactly the false reassurance this field
    // exists to prevent.
    let scan: CatalogScan = { models: [], complete: false, totalModels: null };
    try {
      scan = await scanInstalledModels(conn);
      resolutions = {};
      for (const r of recipes) resolutions[r.id] = resolveRecipe(r, scan.models);
      // "resolved" would assert these verdicts are trustworthy. Against a
      // truncated catalog an unresolved role may name a module that is in fact
      // installed, so the discriminant has to carry that doubt too -- a client
      // branching on it must not have to read `data.catalogComplete` to learn
      // the answer might be wrong.
      resolutionState = scan.complete ? "resolved" : "partial";
    } catch (e) {
      resolutions = null;
      resolutionState = isUnavailable(e) ? "unavailable" : "failed";
      if (resolutionState === "failed") resolutionError = toErrorPayload(e);
    }
    return body(recipesSpec, {
      state: "ok",
      uri: recipesSpec.uri,
      data: {
        recipes,
        resolutions,
        catalogComplete: scan.complete,
        modelsScanned: scan.models.length,
        totalModels: scan.totalModels,
      },
      resolutionState,
      resolutionError,
    });
  });

  // --- rack://audit/recent -------------------------------------------------
  const auditSpec = spec("rack://audit/recent");
  server.registerResource(auditSpec.name, auditSpec.uri, meta(auditSpec), () => {
    const { entries, skipped } = audit.recent(AUDIT_RECENT);
    return body(auditSpec, {
      state: "ok",
      uri: auditSpec.uri,
      data: { entries, skipped },
    });
  });
}
