// Builds a self-contained, reproducible server distributable (spec section 16).
// esbuild inlines every dependency (SDK, zod, and the @rackmcp/* workspace
// packages resolved through their published `dist`) into a single ESM file that
// a host can launch directly with `node rack-mcp-server.mjs`. The Rackwright
// prompt is read at runtime relative to the bundle, so it is copied alongside.
//
// Prerequisite: the workspace packages must be built first (`pnpm -r build`),
// since esbuild resolves @rackmcp/* to their dist via package "exports".
import { build } from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "dist", "bundle");
mkdirSync(outDir, { recursive: true });

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

const result = await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile: join(outDir, "rack-mcp-server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Deterministic output: no minification, sorted-by-esbuild, banner with a
  // shebang so the file is directly executable.
  minify: false,
  sourcemap: false,
  // No shebang banner: esbuild preserves the entry module's own shebang, so
  // adding one here would duplicate it (a second shebang line is invalid JS).
  legalComments: "none",
  logLevel: "info",
  metafile: true,
  define: { "process.env.RACKMCP_SERVER_VERSION": JSON.stringify(pkg.version) },
});

// The Rackwright identity is read at runtime from a sibling of the entry module.
copyFileSync(join(root, "src", "prompts", "rackwright.md"), join(outDir, "rackwright.md"));

// Record the input set for reproducibility auditing.
writeFileSync(join(outDir, "bundle-metafile.json"), JSON.stringify(result.metafile, null, 2));

console.error(`bundled rack-mcp-server@${pkg.version} -> ${join(outDir, "rack-mcp-server.mjs")}`);
console.error("run: node dist/bundle/rack-mcp-server.mjs (keep rackwright.md beside it)");
