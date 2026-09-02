/**
 * Graceful-quit smoke: proves the plugin shuts down cleanly on Rack's NORMAL
 * quit path (plugin destroy() -> RackBridge::stop()), which a signal-based
 * teardown never exercises (Rack treats SIGTERM as a fatal signal).
 *
 * Quits via the Quit Apple Event (what Cmd+Q sends), so GLFW closes the window
 * and Rack runs its ordinary shutdown. Guarded: it only runs when the isolated
 * instance is the sole Rack process, so it can never target a user's real Rack.
 *
 *   pnpm --filter @rackmcp/integration run quit
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RackHarness } from "./harness.js";

const scratch = process.env.RACKMCP_TEST_DIR ?? mkdtempSync(join(tmpdir(), "rackmcp-quit-"));
const log = (s: string) => process.stderr.write(s + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
};

const harness = new RackHarness({ baseDir: scratch, name: "quit" });
harness.prepare();
harness.launch();
try {
  await harness.waitForInstance();
  const pid = harness.rackPid!;
  const manifests = () => readdirSync(harness.discoveryDir).filter((f) => f.endsWith(".json"));
  check("manifest published", manifests().length === 1);

  const rackPids = spawnSync("pgrep", ["-x", "Rack"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
  if (rackPids.length !== 1 || Number(rackPids[0]) !== pid) {
    check("sole Rack process (refusing to send Quit to an ambiguous target)", false, `pids=${rackPids.join(",")}`);
  } else {
    // Cmd+Q equivalent: GLFW handles the Quit Apple Event by closing the window.
    spawnSync("osascript", ["-e", 'tell application "VCV Rack 2 Pro" to quit']);
    const deadline = Date.now() + 20_000;
    let alive = true;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { alive = false; break; }
      await sleep(250);
    }
    check("Rack exited within 20s of the Quit event", !alive);
    await sleep(500);
    const text = readFileSync(join(harness.userDir, "log.txt"), "utf8");
    check("no fatal signal / abort in log", !/Fatal signal|terminat|abort/i.test(text));
    check("destroy(): bridge stopped logged", /RackMCP: bridge stopped/.test(text));
    check("manifest removed on clean shutdown", existsSync(harness.discoveryDir) ? manifests().length === 0 : true);
    if (!alive) harness.rackPid = null; // already gone; do not signal a reused pid
  }
} catch (e) {
  check("no exception", false, String(e));
  log(harness.logTail());
} finally {
  await harness.quit();
}
log(failures === 0 ? "QUIT SMOKE: PASSED" : `QUIT SMOKE: FAILED (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
