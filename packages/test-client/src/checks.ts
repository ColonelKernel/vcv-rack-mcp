/**
 * Assertion tallying for the live smokes.
 *
 * Every smoke in tests/integration/src had its own copy of `ok()` and its own
 * `failures` counter, which is why the counter was sometimes incremented in the
 * catch block and sometimes not, and why one smoke's summary line said PASSED
 * while `process.exitCode` said otherwise. This is that code, once.
 */
export class Checks {
  #failures = 0;
  #passes = 0;
  readonly #label: string;
  readonly #sink: (line: string) => void;

  /**
   * @param label Name used in the summary line, e.g. "FILES SMOKE".
   * @param sink  Where lines go. Defaults to stderr because **stdout is
   *              reserved for the MCP transport** -- a smoke that writes a
   *              progress line to stdout corrupts the protocol stream.
   */
  constructor(label: string, sink: (line: string) => void = (l) => console.error(l)) {
    this.#label = label;
    this.#sink = sink;
  }

  ok(name: string, cond: boolean, detail = ""): boolean {
    if (cond) {
      this.#passes++;
      this.#sink(`ok   ${name}${detail ? ` (${detail})` : ""}`);
    } else {
      this.#failures++;
      this.#sink(`FAIL ${name} ${detail}`);
    }
    return cond;
  }

  /** Records a failure that is not an assertion -- a thrown exception. */
  fail(name: string, detail = ""): void {
    this.#failures++;
    this.#sink(`FAIL ${name} ${detail}`);
  }

  get failures(): number {
    return this.#failures;
  }

  get passes(): number {
    return this.#passes;
  }

  /**
   * Prints the summary and sets the exit code. Deliberately sets
   * `process.exitCode` rather than calling `process.exit()`: an outstanding
   * `harness.quit()` must be allowed to finish, or Rack is left running.
   */
  finish(): number {
    this.#sink(
      this.#failures
        ? `${this.#label}: FAILED (${this.#failures} of ${this.#failures + this.#passes})`
        : `${this.#label}: PASSED (${this.#passes})`,
    );
    process.exitCode = this.#failures ? 1 : 0;
    return this.#failures;
  }
}
