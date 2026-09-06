import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanInstances, type DiscoveredInstance } from "@rackmcp/protocol";

/**
 * The plugin version the harness writes into its synthetic autosave patch.
 * Read from plugin.json rather than written out again: Rack refuses to load a
 * module whose recorded version does not match the installed plugin, so a
 * hardcoded copy would turn a version bump into a confusing load failure.
 */
const PLUGIN_VERSION: string = (
  JSON.parse(
    readFileSync(
      join(fileURLToPath(new URL("../../../", import.meta.url)), "plugins/RackMCP/plugin.json"),
      "utf8",
    ),
  ) as { version: string }
).version;


const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

export const RACK_APP = "/Applications/VCV Rack 2 Pro.app/Contents/MacOS/Rack";
export const PLUGIN_DIR = join(REPO_ROOT, "plugins", "RackMCP");

export interface RackHarnessOptions {
  /** Directory for the isolated Rack user dir (never the real one). */
  baseDir: string;
  name?: string;
  /** Seed the autosave with a patch containing the Bridge module. */
  seedBridgePatch?: boolean;
}

/**
 * Launches the installed VCV Rack 2 Pro with an ISOLATED user directory
 * (Rack's -u flag). The user's real settings, patches and plugins are never
 * touched. The RackMCP plugin is installed from the local build.
 */
export class RackHarness {
  readonly userDir: string;
  /** PID from the discovery manifest (Rack is spawned via LaunchServices). */
  rackPid: number | null = null;
  /** Holds a display-wake assertion so Rack's window can be created. */
  private caffeinate: ChildProcess | null = null;

  constructor(private readonly options: RackHarnessOptions) {
    this.userDir = join(options.baseDir, options.name ?? "rack-user");
  }

  get discoveryDir(): string {
    return join(this.userDir, "RackMCP", "instances");
  }
  get rackmcpDir(): string {
    return join(this.userDir, "RackMCP");
  }

  prepare(): void {
    rmSync(this.userDir, { recursive: true, force: true });
    mkdirSync(this.userDir, { recursive: true });

    // Quiet first-run behaviors; unknown keys are ignored by Rack.
    writeFileSync(
      join(this.userDir, "settings.json"),
      JSON.stringify(
        {
          showTipsOnLaunch: false,
          autoCheckUpdates: false,
          checkAppUpdates: false,
          autosaveInterval: 15.0,
          // Mirror a realistic engine config.
          sampleRate: 44100.0,
          threadCount: 1,
          safeMode: false,
          cpuMeter: false,
          frameRateLimit: 60.0,
        },
        null,
        2,
      ),
    );

    // Install the locally built plugin.
    const pluginDest = join(this.userDir, "plugins-mac-arm64", "RackMCP");
    mkdirSync(pluginDest, { recursive: true });
    for (const f of ["plugin.dylib", "plugin.json"]) {
      cpSync(join(PLUGIN_DIR, f), join(pluginDest, f));
    }
    cpSync(join(PLUGIN_DIR, "res"), join(pluginDest, "res"), { recursive: true });

    if (this.options.seedBridgePatch !== false) {
      this.seedAutosave();
    }
  }

  /** Seeds the autosave with a minimal patch containing one Bridge module. */
  private seedAutosave(): void {
    const autosaveDir = join(this.userDir, "autosave");
    mkdirSync(autosaveDir, { recursive: true });
    const modules: unknown[] = [
      {
        id: 1,
        plugin: "RackMCP",
        model: "Bridge",
        version: PLUGIN_VERSION,
        params: [{ id: 0, value: 0.0 }],
        pos: [0, 0],
      },
    ];
    const patch = { version: "2.6.6", zoom: 1.0, modules, cables: [] };
    writeFileSync(join(autosaveDir, "patch.json"), JSON.stringify(patch, null, 2));
  }

  launch(): void {
    if (!existsSync(RACK_APP)) {
      throw new Error(`Rack not found at ${RACK_APP}`);
    }
    // Disable AppKit persistent-state restore for Rack: test teardown uses
    // signals, which macOS counts as crashes, and the resulting "reopen
    // windows?" prompt would block the next launch forever. One reversible
    // per-user preference key; Rack manages its own window state anyway.
    spawnSync("defaults", ["write", "com.vcvrack.rack2pro", "ApplePersistenceIgnoreState", "-bool", "true"]);
    // Disable macOS App Nap for Rack: launched in the background (the test driver
    // holds focus), an automated GUI app is otherwise a candidate for napping,
    // which throttles its threads. Cheap, reversible, and good hygiene.
    spawnSync("defaults", ["write", "com.vcvrack.rack2pro", "NSAppSleepDisabled", "-bool", "true"]);
    // Clear macOS window-restore state so a previously crashed/killed test
    // run cannot trigger the blocking "reopen windows?" prompt at launch.
    rmSync(join(homedir(), "Library", "Saved Application State", "com.vcvrack.rack2pro.savedState"), {
      recursive: true,
      force: true,
    });
    // Rack standalone creates a GLFW window at startup and asserts
    // (monitor != NULL) when the display is asleep — which it is whenever the
    // user is away. Declare user activity to wake the display, then hold a
    // display-sleep-prevention assertion for the lifetime of this instance.
    spawnSync("caffeinate", ["-u", "-t", "2"]);
    this.caffeinate = spawn("caffeinate", ["-d", "-i"], { stdio: "ignore" });
    this.caffeinate.unref();

    // Launch through LaunchServices: a directly spawned child crashes during
    // GL context creation when the parent is not a GUI-session app. `open`
    // detaches the process, so lifecycle is tracked via the manifest PID.
    const child = spawn("open", ["-n", "-a", "VCV Rack 2 Pro", "--args", "-u", this.userDir], {
      stdio: "ignore",
    });
    child.unref();
  }

  /** Waits for a fresh discovery manifest from this harness's instance. */
  async waitForInstance(timeoutMs = 90_000): Promise<DiscoveredInstance> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const instances = scanInstances(this.discoveryDir).filter((i) => !i.stale);
      if (instances.length > 0) {
        this.rackPid = instances[0]!.manifest.pid;
        return instances[0]!;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`no live Rack instance discovered in ${this.discoveryDir}`);
  }

  logTail(lines = 40): string {
    try {
      const content = readFileSync(join(this.userDir, "log.txt"), "utf8");
      return content.split("\n").slice(-lines).join("\n");
    } catch {
      return "";
    }
  }

  private pidAlive(): boolean {
    if (this.rackPid === null) return false;
    try {
      process.kill(this.rackPid, 0);
      return true;
    } catch {
      return false;
    }
  }

  kill(): void {
    if (this.rackPid !== null && this.pidAlive()) {
      try {
        process.kill(this.rackPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    this.rackPid = null;
    this.releaseCaffeinate();
  }

  private releaseCaffeinate(): void {
    if (this.caffeinate && this.caffeinate.exitCode === null) {
      this.caffeinate.kill("SIGTERM");
    }
    this.caffeinate = null;
  }

  /** Requests a clean quit (SIGTERM); falls back to SIGKILL. */
  async quit(graceMs = 8000): Promise<void> {
    if (this.rackPid === null) return;
    try {
      process.kill(this.rackPid, "SIGTERM");
    } catch {
      this.rackPid = null;
      return;
    }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && this.pidAlive()) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.pidAlive()) process.kill(this.rackPid!, "SIGKILL");
    this.rackPid = null;
    this.releaseCaffeinate();
  }
}
