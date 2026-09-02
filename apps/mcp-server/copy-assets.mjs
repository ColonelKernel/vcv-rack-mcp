// Copies non-TS runtime assets (the Rackwright identity prompt) into dist so the
// prompts module can read them at runtime. Run after tsc in the build script.
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, "src", "prompts");
const outDir = join(root, "dist", "prompts");
mkdirSync(outDir, { recursive: true });
for (const file of ["rackwright.md"]) {
  copyFileSync(join(srcDir, file), join(outDir, file));
}
console.error(`copied prompt assets to ${outDir}`);
