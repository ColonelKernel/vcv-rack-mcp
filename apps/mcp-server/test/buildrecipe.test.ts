import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BuildRecipeOutput, getTool } from "@rackmcp/schemas";
import { getRecipe } from "@rackmcp/recipes";
import { buildToolTable, type ToolContext } from "../src/tools.js";
import { ToolError } from "../src/errors.js";

/**
 * build_recipe is the first caller of expandRecipeOperations anywhere in the
 * server. Until it existed, `rack://recipes` published the recipes and a client
 * wanting to build one had to re-implement role substitution itself, so the
 * whole expansion half of packages/recipes was unreachable from any client.
 *
 * These drive the real handler through the real registry. The interesting
 * cases are the ones where it must NOT build: an unknown id, a role this Rack
 * cannot fill, and a plan that needs confirming.
 */

const RECIPE_ID = "basic_mono_subtractive";
const UUID = "33333333-3333-4333-8333-333333333333";
const INSTANCE = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
};

/**
 * Real captured bridge payloads rather than hand-written stubs. A stub only
 * proves the handler matches whatever the test author imagined -- the first
 * version of this file invented a preview with no `plan` field and the output
 * schema caught it. These are the bytes a live Rack emitted.
 */
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../tests/fixtures/bridge/${name}.json`, import.meta.url)),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

const PREVIEW = fixture("txn.preview");
const COMMIT = fixture("txn.commit");

interface Opts {
  /** Models the catalog reports as installed. */
  installed?: Array<{ pluginSlug: string; modelSlug: string }>;
  /** Report a truncated catalog scan. */
  truncate?: boolean;
  confirmationRequired?: boolean;
}

/** Every model the recipe's roles ask for. */
function allRolesInstalled() {
  const recipe = getRecipe(RECIPE_ID)!;
  return recipe.roles.map((r) => ({ ...r.preferred }));
}

function ctxFor(opts: Opts = {}): { ctx: ToolContext; committed: string[] } {
  const committed: string[] = [];
  const installed = opts.installed ?? allRolesInstalled();
  let page = 0;
  const conn = {
    async ensureConnected() {
      return INSTANCE;
    },
    async request(method: string) {
      if (method !== "catalog.listModels") throw new Error(`unexpected method ${method}`);
      // One page, then either stop or keep claiming there is more, which is
      // how a scan hits its bound.
      page++;
      return {
        models: page === 1 ? installed : [],
        totalModels: installed.length,
        nextCursor: opts.truncate ? `cursor-${page}` : null,
      };
    },
  };
  // A token is minted on EVERY preview, not only the ones that need
  // confirming (transactions.ts:170), so the stand-in mints one too --
  // an earlier version omitted it and produced a confirmation the output
  // schema rejects, which is not a shape the server can ever return.
  const confirmationFor = (required: boolean) => ({
    confirmationToken: "0000000000000000.0000000000000000",
    confirmationExpiresAt: "2026-01-01T00:05:00.000Z",
    confirmationRequired: required,
  });

  const txns = {
    async preview() {
      return {
        preview: PREVIEW,
        confirmation: confirmationFor(opts.confirmationRequired ?? false),
      };
    },
    async commit(args: { operationId: string }) {
      committed.push(args.operationId);
      return COMMIT;
    },
  };
  return { ctx: { conn, txns } as unknown as ToolContext, committed };
}

function handler() {
  const entry = buildToolTable().find((t) => t.spec.name === "build_recipe");
  expect(entry, "build_recipe must be in the tool table").toBeDefined();
  return entry!.handler;
}

async function run(args: Record<string, unknown>, opts: Opts = {}) {
  const { ctx, committed } = ctxFor(opts);
  const result = await handler()(args, ctx);
  return { result: result as Record<string, unknown>, committed };
}

describe("build_recipe", () => {
  it("is declared as a mutating tool", () => {
    const spec = getTool("build_recipe")!;
    expect(spec).toBeDefined();
    expect(spec.annotations.readOnlyHint).toBe(false);
    expect(spec.annotations.destructiveHint).toBe(true);
  });

  it("builds a fully resolved recipe and commits it", async () => {
    const { result, committed } = await run({ recipeId: RECIPE_ID, operationId: UUID });
    expect(result.phase).toBe("committed");
    expect(result.recipeId).toBe(RECIPE_ID);
    expect((result.resolution as { resolved: boolean }).resolved).toBe(true);
    expect(result.catalogComplete).toBe(true);
    expect(committed).toEqual([UUID]);
    expect(
      BuildRecipeOutput.safeParse(result).error?.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ) ?? [],
    ).toEqual([]);
  });

  it("expands the recipe into as many operations as it declares", async () => {
    // The point of the tool: the client does not reconstruct these itself.
    const recipe = getRecipe(RECIPE_ID)!;
    let seen = -1;
    const { ctx } = ctxFor();
    (ctx.txns as unknown as { preview: unknown }).preview = async (
      _label: string,
      operations: unknown[],
    ) => {
      seen = operations.length;
      return {
        preview: PREVIEW,
        confirmation: {
          confirmationToken: "0000000000000000.0000000000000000",
          confirmationExpiresAt: "2026-01-01T00:05:00.000Z",
          confirmationRequired: false,
        },
      };
    };
    await handler()({ recipeId: RECIPE_ID, operationId: UUID }, ctx);
    expect(seen).toBe(recipe.operations.length);
    expect(seen).toBeGreaterThan(0);
  });

  it("labels the transaction with the recipe name when none is given", async () => {
    let label = "";
    const { ctx } = ctxFor();
    (ctx.txns as unknown as { preview: unknown }).preview = async (l: string) => {
      label = l;
      return {
        preview: PREVIEW,
        confirmation: {
          confirmationToken: "0000000000000000.0000000000000000",
          confirmationExpiresAt: "2026-01-01T00:05:00.000Z",
          confirmationRequired: false,
        },
      };
    };
    await handler()({ recipeId: RECIPE_ID, operationId: UUID }, ctx);
    expect(label).toBe(getRecipe(RECIPE_ID)!.name);
  });

  it("refuses an unknown recipe id without touching the patch", async () => {
    const { ctx, committed } = ctxFor();
    await expect(handler()({ recipeId: "not_a_recipe", operationId: UUID }, ctx)).rejects.toThrow(
      ToolError,
    );
    await expect(
      handler()({ recipeId: "not_a_recipe", operationId: UUID }, ctx),
    ).rejects.toThrow(/not_a_recipe/);
    expect(committed).toEqual([]);
  });

  it("reports an unresolved role instead of substituting a different module", async () => {
    // Substitution would be actively harmful: expansion rewrites add_module
    // slugs but keeps the port and parameter ids chosen for the preferred
    // model, so a swapped-in module builds without error and is wired wrong.
    const partial = allRolesInstalled().slice(0, 2);
    const { result, committed } = await run(
      { recipeId: RECIPE_ID, operationId: UUID },
      { installed: partial },
    );
    expect(result.phase).toBe("unresolved");
    expect(committed).toEqual([]);
    const resolution = result.resolution as {
      resolved: boolean;
      unresolvedRoles: Array<{ role: string; preferred: { modelSlug: string } }>;
    };
    expect(resolution.resolved).toBe(false);
    expect(resolution.unresolvedRoles.length).toBeGreaterThan(0);
    // It names what to install, which is the actionable part.
    expect(resolution.unresolvedRoles[0]!.preferred.modelSlug).toBeTruthy();
    expect(
      BuildRecipeOutput.safeParse(result).error?.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ) ?? [],
    ).toEqual([]);
  });

  it("says the catalog scan was truncated, so 'not installed' can be doubted", async () => {
    // The catalog is ordered by plugin then model slug, so a truncated scan
    // cuts the alphabet and reports modules missing on a machine that has
    // them. Without this flag a client would tell the user to install
    // something they already have.
    const partial = allRolesInstalled().slice(0, 2);
    const { result } = await run(
      { recipeId: RECIPE_ID, operationId: UUID },
      { installed: partial, truncate: true },
    );
    expect(result.phase).toBe("unresolved");
    expect(result.catalogComplete).toBe(false);
  });

  it("a truncated scan does not by itself stop a recipe that resolved", async () => {
    // catalogComplete qualifies "unresolved" and nothing else. Everything the
    // recipe needs was found before the scan hit its bound, so there is
    // nothing to doubt and no reason to refuse.
    const { result, committed } = await run(
      { recipeId: RECIPE_ID, operationId: UUID },
      { truncate: true },
    );
    expect(result.phase).toBe("committed");
    expect(result.catalogComplete).toBe(false);
    expect(committed).toEqual([UUID]);
  });

  it("stops at the preview when the plan needs confirming", async () => {
    // The whole safety model in one assertion: a recipe is a convenience, not
    // a way around the confirmation gate.
    const { result, committed } = await run(
      { recipeId: RECIPE_ID, operationId: UUID },
      { confirmationRequired: true },
    );
    expect(result.phase).toBe("previewed");
    expect(committed).toEqual([]);
    expect((result.confirmation as { confirmationRequired: boolean }).confirmationRequired).toBe(
      true,
    );
  });

  it("stops at the preview when autoCommit is false", async () => {
    const { result, committed } = await run({
      recipeId: RECIPE_ID,
      operationId: UUID,
      autoCommit: false,
    });
    expect(result.phase).toBe("previewed");
    expect(committed).toEqual([]);
  });
});
