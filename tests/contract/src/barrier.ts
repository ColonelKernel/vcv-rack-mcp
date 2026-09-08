import { loadSources } from "./sources.js";

/**
 * Gate H — the bridge handler is never called outside the exception barrier.
 *
 * `CommandPumpWidget::step()` is driven by Rack's frame loop, so a handler that
 * throws unwinds through `Widget::step` and takes Rack with it. `core/barrier.hpp`
 * converts a throw into an INTERNAL result instead, and `tests/cpp/barrier.test.cpp`
 * pins what it does with each of the three throw conventions — but a unit test on
 * the barrier cannot prove the pump routes through it. Reintroducing a bare
 * `frame = executeCommand(cmd);` would pass every test in the repo and lose the
 * property, which is exactly how the barrier came to be missing in the first
 * place.
 *
 * So: `executeCommand` has one call site, and this refuses any occurrence of it
 * in the pump that is not the argument of a `guardedCall`. It is deliberately
 * narrow — one symbol, in the files that may legitimately mention it — rather
 * than a repo-wide scan that would need exceptions.
 */
export interface UnguardedCall {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Files allowed to name `executeCommand` at all, and what each may do with it. */
const DECLARATION = "plugins/RackMCP/src/rackside/Handlers.hpp";
const DEFINITION = "plugins/RackMCP/src/rackside/Handlers.cpp";
const CALLER = "plugins/RackMCP/src/rackside/CommandPump.cpp";

/**
 * A call is guarded when `guardedCall(` appears before it on the same line.
 * The pump's call site is a one-line lambda, so this needs no brace matching;
 * anything spread over more lines is reported and can be rewritten or given a
 * reason here, which is the outcome we want from a construct nobody expected.
 */
function isGuarded(text: string): boolean {
  const call = text.indexOf("executeCommand(");
  const guard = text.indexOf("guardedCall(");
  return guard !== -1 && guard < call;
}

/** Every place `executeCommand` is invoked without the barrier in front of it. */
export function unguardedHandlerCalls(): UnguardedCall[] {
  const out: UnguardedCall[] = [];
  for (const file of loadSources()) {
    if (file.root.kind !== "producer") continue;
    if (file.path === DECLARATION || file.path === DEFINITION) continue;
    file.code.split("\n").forEach((text, i) => {
      // The definition's own signature and any declaration are not calls; a
      // call has an open paren immediately after the name.
      if (!text.includes("executeCommand(")) return;
      if (isGuarded(text)) return;
      out.push({ file: file.path, line: i + 1, text: text.trim() });
    });
  }
  return out;
}

/**
 * Where the barrier is expected to be, so that deleting the call site fails
 * too. A gate that only looks for a bad pattern passes when the code it guards
 * has been removed entirely.
 */
export function guardedCallSites(): UnguardedCall[] {
  const out: UnguardedCall[] = [];
  for (const file of loadSources()) {
    if (file.path !== CALLER) continue;
    file.code.split("\n").forEach((text, i) => {
      if (text.includes("executeCommand(") && isGuarded(text)) {
        out.push({ file: file.path, line: i + 1, text: text.trim() });
      }
    });
  }
  return out;
}
