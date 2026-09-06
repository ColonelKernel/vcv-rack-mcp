import { CENSUS_EXCEPTIONS, type CensusException } from "@rackmcp/schemas";

export { CENSUS_EXCEPTIONS };
import { declaredSymbols, type DeclaredKind, type DeclaredSymbol } from "./declared.js";
import { kindsOf, rootsMentioning, type RootKind } from "./sources.js";

export interface CensusResult {
  readonly declared: DeclaredSymbol;
  readonly roots: readonly string[];
  readonly kinds: readonly RootKind[];
  /** Named by something other than its own declaration and the codegen. */
  readonly implemented: boolean;
  readonly exception: CensusException | undefined;
}

function findException(d: DeclaredSymbol): CensusException | undefined {
  return CENSUS_EXCEPTIONS.find((e) => e.symbol === d.symbol && e.kind === d.kind);
}

export function runCensus(): readonly CensusResult[] {
  return declaredSymbols().map((declared) => {
    const roots = rootsMentioning(
      [declared.symbol, ...declared.aliases],
      declared.declaredIn ? { ignoreFile: declared.declaredIn } : {},
    );
    const kinds = kindsOf(roots);
    return {
      declared,
      roots: [...roots].sort(),
      kinds: [...kinds].sort(),
      // A symbol with its own declaring file counts a hit anywhere else,
      // including elsewhere in the declaration root: for a limit, being
      // substituted into a schema IS the implementation.
      implemented:
        kinds.has("producer") ||
        kinds.has("consumer") ||
        (declared.declaredIn !== undefined && kinds.has("declaration")),
      exception: findException(declared),
    };
  });
}

/** Formats one result as a single failure line. */
export function describe(r: CensusResult): string {
  const where = r.roots.length ? r.roots.join(", ") : "nowhere";
  const spelled = r.declared.aliases.length ? ` [also ${r.declared.aliases.join(", ")}]` : "";
  return `${r.declared.kind} "${r.declared.symbol}"${spelled} (${r.declared.origin}) — found in: ${where}`;
}
