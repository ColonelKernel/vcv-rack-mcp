import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getResource, RESOURCES } from "@rackmcp/schemas";
import { registerResources } from "../src/resources.js";
import { ToolError } from "../src/errors.js";

/**
 * The `rack://` resources published no output schema at all, and three of them
 * returned three different unannounced shapes on one URI. These tests drive the
 * real handlers -- captured through a recording stand-in for McpServer -- and
 * strict-parse every body against the contract the resource now declares, so
 * each reachable state is proved reachable and proved on-contract.
 *
 * The handlers validate their own bodies non-fatally at runtime (a schema
 * complaint must not turn a working read into a hard error), so that check
 * cannot fail a build. This is the gate that can.
 */

type Handler = () => unknown | Promise<unknown>;

/** Captures what registerResources registers, in place of a real McpServer. */
function capture(deps: Parameters<typeof registerResources>[1]) {
  const handlers = new Map<string, Handler>();
  const meta = new Map<string, Record<string, unknown>>();
  const server = {
    registerResource(name: string, uri: string, m: Record<string, unknown>, handler: Handler) {
      handlers.set(uri, handler);
      meta.set(uri, { ...m, name });
    },
  };
  registerResources(server as never, deps);
  return { handlers, meta };
}

/** Runs one resource handler and returns its parsed JSON body. */
async function read(handlers: Map<string, Handler>, uri: string): Promise<Record<string, unknown>> {
  const handler = handlers.get(uri);
  if (!handler) throw new Error(`no handler registered for ${uri}`);
  const result = (await handler()) as { contents: Array<{ text: string; uri: string }> };
  expect(result.contents).toHaveLength(1);
  expect(result.contents[0]!.uri).toBe(uri);
  return JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
}

/** Strict-parses a body against the schema its own registry entry declares. */
function onContract(uri: string, body: unknown): string[] {
  const spec = getResource(uri);
  if (!spec) return [`no registry entry for ${uri}`];
  const parsed = spec.output.safeParse(body);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}

const MANIFEST = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  pid: 4321,
  rackVersion: "2.6.6",
  rackEdition: "Pro" as const,
  bridgeVersion: "0.1.0",
  port: 51515,
  startTime: "2026-01-01T00:00:00.000Z",
  lastHeartbeat: "2026-01-01T00:00:02.000Z",
  mode: "standalone-gui" as const,
  patchName: "demo",
  commandPumpPresent: true,
  bridgeModulePresent: true,
};

const STATUS = {
  instanceId: MANIFEST.instanceId,
  sessionId: "22222222-2222-4222-8222-222222222222",
  patchEpoch: 3,
  rackVersion: "2.6.6",
  rackEdition: "Pro",
  bridgeVersion: "0.1.0",
  bridgeProtocolVersion: 1,
  mode: "standalone-gui",
  sampleRate: 44100,
  patchName: "demo",
  saved: true,
  bridgeModulePresent: true,
  commandPumpPresent: true,
  writerLease: { held: false },
  // A field this build does not know about. mapStatus drops it; without that
  // projection StatusResult.strict() would reject the whole body.
  somethingNewThePluginAdded: 7,
};

const METRICS = {
  commandQueueDepth: 0,
  commandQueueMaxDepth: 1,
  requestsHandled: 5,
  requestTimeouts: 0,
  rollbacks: 0,
  authFailures: 0,
  droppedTelemetryFrames: 0,
  bridgeReconnects: 1,
  uiPumpLastDrainMs: 0,
  uiPumpMaxDrainMs: 0,
  requestLatencyEwmaMs: 0,
  engineBlock: 0,
  engineFrame: 0,
  protocolErrors: 0,
  responseDrops: 0,
  oversizedResults: 0,
};

/**
 * A real captured `patch.snapshot` payload rather than a hand-written stub: a
 * stub only proves the resource matches whatever the test author imagined, and
 * this body is republished verbatim under `data`.
 */
const SNAPSHOT = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../tests/fixtures/bridge/patch.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, unknown>;

interface FakeOpts {
  selected?: boolean;
  connected?: boolean;
  instances?: number;
  /** Per-method behaviour; a thrown value is thrown to the handler. */
  respond?: (method: string, payload: Record<string, unknown>) => unknown;
}

function fakeDeps(opts: FakeOpts = {}, limitBytes = 4 * 1024 * 1024) {
  const count = opts.instances ?? 1;
  const conn = {
    get selectedInstance() {
      return opts.selected === false ? null : { instanceId: MANIFEST.instanceId };
    },
    get connected() {
      return opts.connected ?? true;
    },
    listInstances() {
      return Array.from({ length: count }, (_, i) => ({
        manifest: { ...MANIFEST, instanceId: `1111111${i}-1111-4111-8111-111111111111` },
        stale: false,
      }));
    },
    async request(method: string, payload: Record<string, unknown>) {
      if (opts.respond) return opts.respond(method, payload);
      if (method === "status.get") return STATUS;
      if (method === "metrics.get") return METRICS;
      if (method === "patch.snapshot") return SNAPSHOT;
      if (method === "catalog.listModels") return { models: [], totalModels: 0, nextCursor: null };
      throw new Error(`unexpected method ${method}`);
    },
  };
  const audit = {
    record() {},
    recent() {
      return {
        entries: [
          {
            ts: "2026-01-01T00:00:00.000Z",
            tool: "get_rack_status",
            outcome: "ok" as const,
            durationMs: 4,
          },
        ],
        skipped: 0,
      };
    },
  };
  return { conn, audit, resultLimitBytes: limitBytes } as unknown as Parameters<
    typeof registerResources
  >[1];
}

describe("resource registry", () => {
  it("registers exactly the declared resources, with the declared metadata", async () => {
    const { handlers, meta } = capture(fakeDeps());
    expect([...handlers.keys()].sort()).toEqual(RESOURCES.map((r) => r.uri).sort());
    for (const spec of RESOURCES) {
      // Title and description come from the registry, so what a host advertises
      // and what the body is validated against cannot drift apart.
      expect(meta.get(spec.uri)).toMatchObject({
        name: spec.name,
        title: spec.title,
        description: spec.description,
        mimeType: "application/json",
      });
    }
  });

  it("every resource returns a body its own schema accepts", async () => {
    const { handlers } = capture(fakeDeps());
    for (const spec of RESOURCES) {
      const body = await read(handlers, spec.uri);
      expect({ uri: spec.uri, issues: onContract(spec.uri, body) }).toEqual({
        uri: spec.uri,
        issues: [],
      });
      expect(body.state).toBe("ok");
    }
  });
});

describe("rack://status", () => {
  it("reports the live session, not a remembered selection", async () => {
    // Rack quit: the selection survives in the ConnectionManager, the session
    // does not. Deriving `connected` from the selection alone reported a live
    // instance indefinitely, contradicting get_rack_status on the same state.
    const { handlers } = capture(
      fakeDeps({
        connected: false,
        respond: (m) => {
          if (m === "status.get" || m === "metrics.get")
            throw new ToolError("RACK_NOT_FOUND", "no discoverable Rack instance", true);
          throw new Error(`unexpected ${m}`);
        },
      }),
    );
    const body = await read(handlers, "rack://status");
    expect(onContract("rack://status", body)).toEqual([]);
    const data = body.data as Record<string, unknown>;
    expect(data.connected).toBe(false);
    expect(data.selectedInstanceId).toBe(MANIFEST.instanceId);
    expect((data.statusError as { code: string }).code).toBe("RACK_NOT_FOUND");
  });

  it("distinguishes a metrics failure from a status failure", async () => {
    // One shared catch reported a metrics-only failure as "both unavailable".
    const { handlers } = capture(
      fakeDeps({
        respond: (m) => {
          if (m === "status.get") return STATUS;
          throw new ToolError("TELEMETRY_UNAVAILABLE", "metrics off", true);
        },
      }),
    );
    const data = (await read(handlers, "rack://status")).data as Record<string, unknown>;
    expect(data.status).not.toBeNull();
    expect(data.statusError).toBeNull();
    expect(data.metrics).toBeNull();
    expect((data.metricsError as { code: string }).code).toBe("TELEMETRY_UNAVAILABLE");
  });

  it("projects status through mapStatus so an unknown plugin field cannot break it", async () => {
    const { handlers } = capture(fakeDeps());
    const body = await read(handlers, "rack://status");
    expect(onContract("rack://status", body)).toEqual([]);
    const status = (body.data as { status: Record<string, unknown> }).status;
    expect(status.somethingNewThePluginAdded).toBeUndefined();
    expect(status.patchEpoch).toBe(3);
  });

  it("reports no connection and no error when nothing is selected", async () => {
    const { handlers } = capture(fakeDeps({ selected: false }));
    const body = await read(handlers, "rack://status");
    expect(onContract("rack://status", body)).toEqual([]);
    const data = body.data as Record<string, unknown>;
    expect(data.connected).toBe(false);
    expect(data.status).toBeNull();
    // Never attempted, so there is nothing to report as a failure.
    expect(data.statusError).toBeNull();
    expect(data.metricsError).toBeNull();
  });
});

describe("degradation and failure states", () => {
  const liveRead = ["rack://patch/current", "rack://catalog/models"];

  it.each(liveRead)("%s degrades with a code when no instance is running", async (uri) => {
    const { handlers } = capture(
      fakeDeps({
        instances: 0,
        respond: () => {
          throw new ToolError("RACK_NOT_FOUND", "no running Rack instance", true);
        },
      }),
    );
    const body = await read(handlers, uri);
    expect(onContract(uri, body)).toEqual([]);
    expect(body.state).toBe("unavailable");
    expect(body.code).toBe("RACK_NOT_FOUND");
    expect(body.discoveredInstances).toBe(0);
  });

  it.each(liveRead)("%s says which instance to pick when several are live", async (uri) => {
    const { handlers } = capture(
      fakeDeps({
        instances: 3,
        respond: () => {
          throw new ToolError("INSTANCE_NOT_SELECTED", "3 instances available", false);
        },
      }),
    );
    const body = await read(handlers, uri);
    expect(onContract(uri, body)).toEqual([]);
    expect(body.state).toBe("unavailable");
    expect(body.code).toBe("INSTANCE_NOT_SELECTED");
    expect(body.discoveredInstances).toBe(3);
  });

  it.each(liveRead)("%s reports a failed read as a structured error", async (uri) => {
    // Previously `{connected: true, error: String(e)}` -- which asserted a
    // connection the failure itself disproves, and dropped code and retrySafe.
    const { handlers } = capture(
      fakeDeps({
        respond: () => {
          throw new ToolError("BRIDGE_NOT_READY", "no command pump yet", true);
        },
      }),
    );
    const body = await read(handlers, uri);
    expect(onContract(uri, body)).toEqual([]);
    expect(body.state).toBe("error");
    const error = body.error as Record<string, unknown>;
    expect(error.code).toBe("BRIDGE_NOT_READY");
    expect(error.retrySafe).toBe(true);
    expect(typeof error.message).toBe("string");
  });
});

describe("rack://catalog/models", () => {
  it("hands the cursor to the tool that can accept it", async () => {
    const { handlers } = capture(
      fakeDeps({
        respond: () => ({ models: [], totalModels: 900, nextCursor: "300" }),
      }),
    );
    const body = await read(handlers, "rack://catalog/models");
    expect(onContract("rack://catalog/models", body)).toEqual([]);
    // A static rack:// URI takes no cursor; without this the client is handed
    // a cursor with nowhere to spend it.
    expect(body.continueWith).toEqual({ tool: "list_installed_models", cursor: "300" });
  });
});

describe("rack://recipes", () => {
  it("reports resolutions against a complete catalog", async () => {
    const { handlers } = capture(
      fakeDeps({
        respond: () => ({
          models: [{ pluginSlug: "Fundamental", modelSlug: "VCO" }],
          totalModels: 1,
          nextCursor: null,
        }),
      }),
    );
    const body = await read(handlers, "rack://recipes");
    expect(onContract("rack://recipes", body)).toEqual([]);
    expect(body.resolutionState).toBe("resolved");
    const data = body.data as Record<string, unknown>;
    expect(data.catalogComplete).toBe(true);
    expect(data.resolutions).not.toBeNull();
  });

  it("says so when the catalog scan stopped short of the end", async () => {
    // Resolving against a partial catalog yields a WRONG verdict, not a missing
    // one: the bridge orders by plugin slug, so an early stop cuts the alphabet
    // and every role past the cut reads as "not installed".
    let page = 0;
    const { handlers } = capture(
      fakeDeps({
        respond: () => {
          page++;
          return {
            models: [{ pluginSlug: `Plugin${page}`, modelSlug: "M" }],
            totalModels: 5000,
            nextCursor: String(page * 300),
          };
        },
      }),
    );
    const body = await read(handlers, "rack://recipes");
    expect(onContract("rack://recipes", body)).toEqual([]);
    const data = body.data as Record<string, unknown>;
    expect(data.catalogComplete).toBe(false);
    expect(data.totalModels).toBe(5000);
    expect(data.modelsScanned).toBe(4);
    // Not "resolved": the discriminant a client branches on must carry the
    // doubt, rather than leaving it in a field one level deeper.
    expect(body.resolutionState).toBe("partial");
  });

  it("does not claim a completed scan when the catalog read failed", async () => {
    const { handlers } = capture(
      fakeDeps({
        respond: () => {
          throw new ToolError("TIMEOUT", "catalog read timed out", true);
        },
      }),
    );
    const body = await read(handlers, "rack://recipes");
    expect(onContract("rack://recipes", body)).toEqual([]);
    const data = body.data as Record<string, unknown>;
    // `catalogComplete: true` beside `modelsScanned: 0` would assert that the
    // whole catalog was scanned and found empty.
    expect(data.catalogComplete).toBe(false);
    expect(data.modelsScanned).toBe(0);
  });

  it("separates 'no instance' from 'the catalog read failed'", async () => {
    const noInstance = capture(
      fakeDeps({
        respond: () => {
          throw new ToolError("RACK_NOT_FOUND", "no running Rack instance", true);
        },
      }),
    );
    const a = await read(noInstance.handlers, "rack://recipes");
    expect(onContract("rack://recipes", a)).toEqual([]);
    expect(a.resolutionState).toBe("unavailable");
    expect(a.resolutionError).toBeNull();

    const failed = capture(
      fakeDeps({
        respond: () => {
          throw new ToolError("TIMEOUT", "catalog read timed out", true);
        },
      }),
    );
    const b = await read(failed.handlers, "rack://recipes");
    expect(onContract("rack://recipes", b)).toEqual([]);
    expect(b.resolutionState).toBe("failed");
    expect((b.resolutionError as { code: string }).code).toBe("TIMEOUT");
  });
});

describe("the size cap", () => {
  it("replaces an oversized body with a truncated one that names where to go", async () => {
    // The 4 MiB cap is unreachable in practice -- the 1 MiB bridge frame cap
    // rejects a big payload first -- so this branch had never executed. Force
    // it with a small limit so the path is exercised rather than assumed.
    const { handlers } = capture(fakeDeps({}, 200));
    for (const spec of RESOURCES) {
      const body = await read(handlers, spec.uri);
      expect({ uri: spec.uri, issues: onContract(spec.uri, body) }).toEqual({
        uri: spec.uri,
        issues: [],
      });
      expect(body.state).toBe("truncated");
      expect(body.limitBytes).toBe(200);
      expect(body.sizeBytes as number).toBeGreaterThan(200);
      expect(body.useTool).toBe(spec.truncationTool);
    }
  });

  it("leaves a body that fits alone", async () => {
    const { handlers } = capture(fakeDeps({}, 4 * 1024 * 1024));
    expect((await read(handlers, "rack://status")).state).toBe("ok");
  });
});
