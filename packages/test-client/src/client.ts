/**
 * A scriptable MCP client for the live smokes.
 *
 * Ten files under tests/integration/src each built their own
 * `Client` + `StdioClientTransport` pair, resolved the server entry point from
 * `import.meta.url`, connected, listed instances, and selected the first
 * non-stale one. This is that sequence, once.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { structured, succeeded, toolError, type ToolError } from "./results.js";

export interface RackTestClientOptions {
  /** Rack user directory the server should search for instances. */
  userDir: string;
  /** Client name reported in the MCP handshake. */
  name?: string;
  /** Path to the built server entry. Defaults to the repo's `dist/index.js`. */
  serverEntry?: string;
  /** Extra environment for the server process. */
  env?: Record<string, string>;
}

/**
 * The server entry point, resolved from this module's own location.
 *
 * Deliberately the unbundled `apps/mcp-server/dist/index.js` and not the
 * bundle: the smokes run against a `pnpm -r build` tree, and pointing them at
 * the bundle would make every smoke depend on `bundle.mjs` having been run.
 */
export function defaultServerEntry(): string {
  // fileURLToPath, never URL.pathname: pathname percent-encodes, and this
  // repository's own checkout is at "/Users/.../VCV Rack MCP" -- a path with
  // spaces -- so pathname would hand Node "VCV%20Rack%20MCP" and every smoke
  // would die with MODULE_NOT_FOUND on a path that visibly looks right.
  // packages/test-client/dist/client.js -> repo root
  const root = new URL("../../../", new URL(import.meta.url));
  return fileURLToPath(new URL("apps/mcp-server/dist/index.js", root));
}

export class RackTestClient {
  readonly #client: Client;
  #transport: StdioClientTransport | null = null;
  #closed = false;

  private constructor(client: Client) {
    this.#client = client;
  }

  /** Connects over stdio. The caller still owns `close()`. */
  static async connect(opts: RackTestClientOptions): Promise<RackTestClient> {
    const client = new Client({ name: opts.name ?? "rackmcp-test-client", version: "0.1.0" });
    const self = new RackTestClient(client);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env["RACKMCP_RACK_USER_DIR"] = opts.userDir;
    Object.assign(env, opts.env ?? {});
    self.#transport = new StdioClientTransport({
      command: process.execPath,
      args: [opts.serverEntry ?? defaultServerEntry()],
      env,
      stderr: "pipe",
    });
    await client.connect(self.#transport);
    return self;
  }

  /** The underlying SDK client, for calls this wrapper does not cover. */
  get raw(): Client {
    return this.#client;
  }

  /** Calls a tool and returns the raw result, errors included. */
  async callRaw(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.#client.callTool({ name, arguments: args });
  }

  /**
   * Calls a tool and returns its structured payload, throwing if it failed.
   *
   * This is the difference that matters against the old `sc(await call(...))`:
   * a failed call used to flow on as an object with an `error` key, and the
   * next assertion read `undefined` from it and reported a confusing mismatch
   * instead of the actual error code.
   */
  async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const result = await this.callRaw(name, args);
    const err = toolError(result);
    if (err) throw new Error(`${name} failed: ${err.code || "(no code)"} ${err.message}`);
    return structured(result, name);
  }

  /** Calls a tool that is expected to fail, returning its error. */
  async expectError(name: string, args: Record<string, unknown> = {}): Promise<ToolError> {
    const result = await this.callRaw(name, args);
    const err = toolError(result);
    if (!err) {
      throw new Error(
        `${name} was expected to fail but succeeded: ` +
          JSON.stringify(structured(result, name)).slice(0, 300),
      );
    }
    return err;
  }

  /** True if the call succeeded. Does not throw either way. */
  async attempt(name: string, args: Record<string, unknown> = {}): Promise<boolean> {
    return succeeded(await this.callRaw(name, args));
  }

  /**
   * Selects the first instance the discovery directory reports as live.
   *
   * Every smoke did `inst.find((i) => !i.stale)!` -- a non-null assertion that,
   * when discovery turned up nothing, threw `Cannot read properties of
   * undefined (reading 'instanceId')` several lines later.
   */
  async selectLiveInstance(): Promise<Record<string, unknown>> {
    const listed = await this.call("list_rack_instances", {});
    const instances = (listed["instances"] ?? []) as Array<Record<string, unknown>>;
    const live = instances.find((i) => i["stale"] !== true);
    if (!live) {
      throw new Error(
        `no live Rack instance among ${instances.length} discovered ` +
          `(${instances.map((i) => String(i["instanceId"])).join(", ") || "none"})`,
      );
    }
    await this.call("select_rack_instance", { instanceId: live["instanceId"] });
    return live;
  }

  /** Idempotent: the smokes close in the body and again in `finally`. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#client.close();
    } catch {
      /* already gone */
    }
  }
}
