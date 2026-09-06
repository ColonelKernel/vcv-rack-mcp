/**
 * In-Rack chat smoke: the live half of the panel -> note -> assistant path.
 *
 * What this can and cannot do, stated plainly because the difference is the
 * whole design of the file:
 *
 * - It CAN drive the bridge end of the path for real — connect, authenticate,
 *   `chat.poll`, `chat.post`, resumption by `sinceSeq`, acknowledgement — all
 *   against a live plugin in a live Rack.
 * - It CANNOT type. Rack draws its entire UI in OpenGL and exposes no
 *   accessibility tree, so System Events finds no field: `click at` reports
 *   success and hits nothing. Creating a note requires real synthetic input
 *   aimed at a screen coordinate, which is a human (or a granted computer-use
 *   agent), not a script.
 *
 * So `--hold=<seconds>` opens a window for a person to type into the panel, and
 * everything after it verifies what actually arrived. Without `--hold` the run
 * covers only the empty poll.
 *
 * The non-empty marshalling itself is NOT left to this file — that would leave
 * it unverified in CI. `buildChatPollPayload` was extracted into Rack-free
 * `core/activitylog.cpp` precisely so `tests/cpp/activitylog.test.cpp` can
 * cover the shape, the escaping and the refcount on every platform. What
 * remains here is the part no unit test can reach: that a keystroke in the
 * panel becomes a note on the wire.
 *
 *   pnpm --filter @rackmcp/integration run chat        # empty case, unattended
 *   pnpm --filter @rackmcp/integration run chat:hold   # 150s to type
 */import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeClient, BridgeRequestError, loadPairingSecret } from "@rackmcp/protocol";
import { ChatPollResult, ChatPostResult } from "@rackmcp/schemas";
import { RackHarness } from "./harness.js";

const scratch = process.env.RACKMCP_TEST_DIR ?? mkdtempSync(join(tmpdir(), "rackmcp-chat-"));
const log = (s: string) => process.stderr.write(s + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
};

const NOTE = "make the filter darker";

/** The command pump attaches on the first Bridge widget step, not at connect. */
async function waitReady(c: BridgeClient): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      return (await c.request("status.get", {})) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof BridgeRequestError && e.rpcError.code === "BRIDGE_NOT_READY") {
        await sleep(500);
        continue;
      }
      throw e;
    }
  }
  throw new Error("bridge never became ready");
}

const harness = new RackHarness({ baseDir: scratch, name: "chat" }).withModules("Chat");
harness.prepare();
harness.launch();

let client: BridgeClient | null = null;
try {
  const instance = await harness.waitForInstance();
  const pid = harness.rackPid!;

  client = new BridgeClient({ clientName: "chat-smoke", clientVersion: "0.0.0" });
  await client.connect(instance.manifest.port);
  await client.authenticate(loadPairingSecret(harness.rackmcpDir));
  const status = await waitReady(client);
  const scope = () => ({
    instanceId: status.instanceId as string,
    sessionId: status.sessionId as string,
    patchEpoch: 1,
  });

  const before = ChatPollResult.parse(await client.request("chat.poll", { scope: scope(), sinceSeq: 0 }));
  check("no notes before anything is typed", before.notes.length === 0, `lastSeq=${before.lastSeq}`);

  // --- type into the panel -------------------------------------------------
  // Rack draws its whole UI in OpenGL and exposes no accessibility tree, so
  // System Events cannot find the field: `click at` reports success and hits
  // nothing. Typing therefore has to be real synthetic input aimed at a
  // coordinate, which a script cannot do on its own. With --hold the smoke
  // waits here so an operator (or a computer-use agent) can type into the
  // panel, then verifies what arrived.
  const holdSeconds = Number(
    process.argv.find((a) => a.startsWith("--hold="))?.split("=")[1] ?? "0",
  );
  if (holdSeconds > 0) {
    const rackPids = spawnSync("pgrep", ["-x", "Rack"], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")
      .filter(Boolean);
    if (rackPids.length !== 1 || Number(rackPids[0]) !== pid) {
      check("sole Rack process (refusing to hold an ambiguous target)", false,
            `pids=${rackPids.join(",")}`);
    } else {
      log(`--- holding ${holdSeconds}s: type "${NOTE}" into the Chat panel and press Enter ---`);
      log(`    rack pid ${pid}`);
      await sleep(holdSeconds * 1000);
    }
  } else {
    log("--- no --hold given: empty case only; run chat:hold to verify a real keystroke ---");
  }

  // --- the assistant reads it ----------------------------------------------
  const after = ChatPollResult.parse(await client.request("chat.poll", { scope: scope(), sinceSeq: 0 }));
  if (holdSeconds > 0) {
    check("a note arrived", after.notes.length === 1, `${after.notes.length} notes`);
  }
  if (after.notes.length > 0) {
    const note = after.notes[0]!;
    check("the note carries what was typed", note.text === NOTE, JSON.stringify(note.text));
    check("the note has a sequence number", note.seq > 0, `seq=${note.seq}`);
    check("the note has a clock", /^\d\d:\d\d:\d\d$/.test(note.clock), note.clock);
    check("lastSeq tracks the note", after.lastSeq === note.seq);

    // sinceSeq must exclude what the caller already has.
    const resumed = ChatPollResult.parse(
      await client.request("chat.poll", { scope: scope(), sinceSeq: note.seq }),
    );
    check("polling past the note returns nothing", resumed.notes.length === 0);

    // --- the assistant replies and acknowledges --------------------------
    const posted = ChatPostResult.parse(
      await client.request("chat.post", {
        scope: scope(),
        text: "lowered the cutoff",
        ackThroughSeq: note.seq,
      }),
    );
    check("the reply was accepted", posted.seq > 0, `seq=${posted.seq}`);
    check("the note was acknowledged", posted.acknowledged === 1, `${posted.acknowledged}`);

    const again = ChatPostResult.parse(
      await client.request("chat.post", { scope: scope(), text: "and again", ackThroughSeq: note.seq }),
    );
    check("acknowledging twice acknowledges nothing new", again.acknowledged === 0);
  }
} catch (err) {
  check("smoke completed", false, String(err).slice(0, 300));
} finally {
  if (client) client.close();
  harness.kill();
}

log(failures === 0 ? "CHAT SMOKE: PASSED" : `CHAT SMOKE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
