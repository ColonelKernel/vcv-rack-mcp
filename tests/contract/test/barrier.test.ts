import { describe as suite, expect, test } from "vitest";
import { guardedCallSites, unguardedHandlerCalls } from "../src/barrier.js";

suite("the pump's exception barrier", () => {
  test("executeCommand is never called outside guardedCall", () => {
    const bad = unguardedHandlerCalls().map((c) => `${c.file}:${c.line} -> ${c.text}`);
    expect(
      bad,
      "CommandPumpWidget::step() runs inside Rack's frame loop, so a handler that throws " +
        "unwinds out of the application. Every call to executeCommand must go through " +
        "guardedCall (core/barrier.hpp), which converts the throw into an INTERNAL result.",
    ).toEqual([]);
  });

  test("the barrier is actually there", () => {
    // Without this the gate passes when the call site is deleted or renamed:
    // an absent population has no violations. It is the same failure mode the
    // barrier itself had -- nothing noticed it was missing.
    const sites = guardedCallSites();
    expect(
      sites.length,
      "expected exactly one guarded executeCommand call in CommandPump.cpp",
    ).toBe(1);
    expect(sites[0]!.text).toContain("guardedCall(");
    expect(sites[0]!.text).toContain("executeCommand(cmd)");
  });
});
