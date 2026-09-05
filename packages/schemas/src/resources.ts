import { z } from "zod";
import { BridgeMetrics, CatalogListResult, StatusResult } from "./bridge.js";
import { ErrorCode, RackMcpError } from "./errors.js";
import { ModuleAdapter } from "./adapters.js";
import { Recipe, RecipeResolution } from "./recipes.js";
import { PatchSnapshot } from "./snapshot.js";
import { Uuid } from "./refs.js";
import { InstanceSummary } from "./tools.js";

/**
 * Output contracts for the six `rack://` MCP resources (spec section 9).
 *
 * The tool surface publishes an `outputSchema` per tool, which the host reads
 * and a client can rely on. MCP has no equivalent field on a resource, so
 * nothing carries these shapes to the client automatically. That makes the
 * discriminant the whole contract: a resource body always names its own
 * `state`, and a client branches on that value rather than sniffing for
 * `models` / `modules` / `error` to work out what it received.
 *
 * Before this module the six resources declared only `mimeType`, and three of
 * them returned three different unannounced shapes on one URI. The bodies were
 * not pass-throughs of already-schematized data either: `rack://status`
 * composes a projection of its own, and every failure and degradation path was
 * ad hoc.
 *
 * Success payloads nest under `data` and reuse the existing document schemas
 * verbatim, so `PatchSnapshot.parse(body.data)` keeps working and a field later
 * added to one of those documents can never collide with an envelope key.
 */

const ResourceUri = z.string().max(256);

/**
 * No live instance can serve this resource. Deliberate graceful degradation,
 * not a failure: `rack://patch/current` answers this rather than erroring when
 * Rack is not running.
 *
 * `code` distinguishes the two situations a caller must act on differently --
 * RACK_NOT_FOUND means start Rack, INSTANCE_NOT_SELECTED means several are
 * running and one must be chosen -- and `discoveredInstances` says how many
 * discovery can see, so a host can explain which case it is in.
 */
export const ResourceUnavailable = z
  .object({
    state: z.literal("unavailable"),
    uri: ResourceUri,
    code: z.enum(["RACK_NOT_FOUND", "INSTANCE_NOT_SELECTED", "RACK_DISCONNECTED"]),
    discoveredInstances: z.number().int().min(0),
    hint: z.string().max(512),
  })
  .strict();
export type ResourceUnavailable = z.infer<typeof ResourceUnavailable>;

/**
 * A live read was attempted and failed. Carries the same structured error the
 * whole tool surface returns, so a client can branch on `code` and honour
 * `retrySafe` instead of pattern-matching English prose.
 */
export const ResourceError = z
  .object({ state: z.literal("error"), uri: ResourceUri, error: RackMcpError })
  .strict();
export type ResourceError = z.infer<typeof ResourceError>;

/**
 * The body did not fit the response-size cap. Names both sizes and, where one
 * exists, the paginated tool serving the same data -- a static `rack://` URI
 * takes no cursor, so without `useTool` a client has nowhere to go.
 */
export const ResourceTruncated = z
  .object({
    state: z.literal("truncated"),
    uri: ResourceUri,
    sizeBytes: z.number().int().min(0),
    limitBytes: z.number().int().min(1),
    useTool: z.string().max(64).nullable(),
    reason: z.string().max(512),
  })
  .strict();
export type ResourceTruncated = z.infer<typeof ResourceTruncated>;

/** Success envelope: `state`/`uri` plus the payload under `data`. */
function ok<T extends z.ZodTypeAny>(uri: string, data: T, extra: z.ZodRawShape = {}) {
  return z.object({ state: z.literal("ok"), uri: z.literal(uri), data, ...extra }).strict();
}

// ---------------------------------------------------------------------------
// rack://status
// ---------------------------------------------------------------------------

/**
 * `connected` reports the live bridge session, not merely that an instance was
 * selected at some point: a selection survives Rack quitting, so deriving it
 * from the selection made this field claim `true` indefinitely after the
 * instance was gone -- while `get_rack_status`, reading the same server state,
 * said `false`.
 *
 * `statusError` and `metricsError` are separate because the two reads fail
 * separately: `status.get` can succeed and `metrics.get` fail, and a single
 * combined flag cannot express that. A null error next to a null payload means
 * the read was never attempted (nothing connected); a non-null error says why
 * it was attempted and failed.
 */
export const RackStatusData = z
  .object({
    connected: z.boolean(),
    selectedInstanceId: Uuid.nullable(),
    instances: z.array(InstanceSummary).max(64),
    status: StatusResult.nullable(),
    statusError: RackMcpError.nullable(),
    metrics: BridgeMetrics.nullable(),
    metricsError: RackMcpError.nullable(),
  })
  .strict();
export type RackStatusData = z.infer<typeof RackStatusData>;

export const RackStatusResource = z.discriminatedUnion("state", [
  ok("rack://status", RackStatusData),
  ResourceTruncated,
]);

// ---------------------------------------------------------------------------
// rack://patch/current
// ---------------------------------------------------------------------------

export const PatchCurrentResource = z.discriminatedUnion("state", [
  ok("rack://patch/current", PatchSnapshot),
  ResourceUnavailable,
  ResourceError,
  ResourceTruncated,
]);

// ---------------------------------------------------------------------------
// rack://catalog/models
// ---------------------------------------------------------------------------

export const CatalogModelsResource = z.discriminatedUnion("state", [
  ok("rack://catalog/models", CatalogListResult, {
    /**
     * `data.nextCursor` cannot be fed back to a static URI. Naming the tool
     * that does accept it keeps the resource from handing out a cursor with
     * nowhere to spend it.
     */
    continueWith: z
      .object({
        tool: z.literal("list_installed_models"),
        cursor: z.string().max(256).nullable(),
      })
      .strict(),
  }),
  ResourceUnavailable,
  ResourceError,
  ResourceTruncated,
]);

// ---------------------------------------------------------------------------
// rack://adapters
// ---------------------------------------------------------------------------

export const AdaptersData = z.object({ adapters: z.array(ModuleAdapter).max(512) }).strict();

export const AdaptersResource = z.discriminatedUnion("state", [
  ok("rack://adapters", AdaptersData),
  ResourceTruncated,
]);

// ---------------------------------------------------------------------------
// rack://recipes
// ---------------------------------------------------------------------------

/**
 * `resolutionState` splits the situations a single `resolutions: null` used to
 * collapse: resolved against the whole installed catalog, resolved against
 * only part of it, no instance to resolve against, and the catalog read failed.
 *
 * `partial` is a distinct state rather than a flag on `resolved` because
 * resolving against a truncated catalog gives a WRONG answer rather than an
 * absent one -- an unresolved role reads as "that module is not installed",
 * which is a claim the server cannot support when it stopped paging early. A
 * client branching on the discriminant must not be told "resolved" about
 * verdicts that may be wrong; `catalogComplete`, `modelsScanned` and
 * `totalModels` then say how much of the catalog they rest on.
 */
export const RecipesData = z
  .object({
    recipes: z.array(Recipe).max(256),
    resolutions: z.record(z.string().max(64), RecipeResolution).nullable(),
    catalogComplete: z.boolean(),
    modelsScanned: z.number().int().min(0),
    totalModels: z.number().int().min(0).nullable(),
  })
  .strict();
export type RecipesData = z.infer<typeof RecipesData>;

export const RecipesResource = z.discriminatedUnion("state", [
  ok("rack://recipes", RecipesData, {
    resolutionState: z.enum(["resolved", "partial", "unavailable", "failed"]),
    resolutionError: RackMcpError.nullable(),
  }),
  ResourceTruncated,
]);

// ---------------------------------------------------------------------------
// rack://audit/recent
// ---------------------------------------------------------------------------

/**
 * One line of the audit log. Mirrors what AuditLog.record() writes, so the
 * writer and this published reader cannot drift apart silently: `recent()`
 * parses every line through this schema and counts what it could not accept
 * rather than passing raw on-disk JSON straight into a resource body.
 */
export const AuditEntry = z
  .object({
    ts: z.iso.datetime(),
    tool: z.string().max(128),
    outcome: z.enum(["ok", "error"]),
    instanceId: Uuid.optional(),
    operationId: Uuid.optional(),
    errorCode: ErrorCode.optional(),
    durationMs: z.number().int().min(0).optional(),
    schemaValid: z.boolean().optional(),
  })
  .strict();
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditRecentData = z
  .object({
    entries: z.array(AuditEntry).max(200),
    /** Lines on disk this build could not parse or accept. */
    skipped: z.number().int().min(0),
  })
  .strict();

export const AuditRecentResource = z.discriminatedUnion("state", [
  ok("rack://audit/recent", AuditRecentData),
  ResourceTruncated,
]);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ResourceSpec {
  /** Registration name passed to server.registerResource. */
  name: string;
  uri: string;
  title: string;
  description: string;
  output: z.ZodType;
  /** Paginated tool serving the same data, named in a truncated body. */
  truncationTool: string | null;
}

/**
 * The resource census, mirroring TOOLS. Registration reads title, description
 * and mimeType from here, so what a host advertises and what the body is
 * validated against come from one place.
 */
export const RESOURCES: readonly ResourceSpec[] = [
  {
    name: "rack-status",
    uri: "rack://status",
    title: "Rack status",
    description: "Discovery and connection status for the selected Rack instance.",
    output: RackStatusResource,
    truncationTool: "get_rack_status",
  },
  {
    name: "rack-patch-current",
    uri: "rack://patch/current",
    title: "Current patch",
    description: "Structured snapshot of the current patch (opaque state excluded).",
    output: PatchCurrentResource,
    truncationTool: "get_patch_snapshot",
  },
  {
    name: "rack-catalog-models",
    uri: "rack://catalog/models",
    title: "Installed models",
    description: "First page of installed plugin models for the selected instance.",
    output: CatalogModelsResource,
    truncationTool: "list_installed_models",
  },
  {
    name: "rack-adapters",
    uri: "rack://adapters",
    title: "Adapter pack",
    description: "Verified module adapters (semantics, port roles, safe values).",
    output: AdaptersResource,
    truncationTool: null,
  },
  {
    name: "rack-recipes",
    uri: "rack://recipes",
    title: "Recipe library",
    description: "High-level recipes; resolved against installed models when connected.",
    output: RecipesResource,
    truncationTool: null,
  },
  {
    name: "rack-audit-recent",
    uri: "rack://audit/recent",
    title: "Recent audit",
    description: "Most-recent tool invocations recorded by this server.",
    output: AuditRecentResource,
    truncationTool: null,
  },
] as const;

export const RESOURCE_URIS: readonly string[] = RESOURCES.map((r) => r.uri);

export function getResource(uri: string): ResourceSpec | undefined {
  return RESOURCES.find((r) => r.uri === uri);
}
