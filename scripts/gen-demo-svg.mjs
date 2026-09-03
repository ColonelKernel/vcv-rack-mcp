// Renders a captured demo transcript (stdin) into a self-contained terminal-card
// SVG (stdout) for the README. The transcript is real output from
// `pnpm --filter @rackmcp/integration run demo`; this only styles it.
//   pnpm --filter @rackmcp/integration run demo 2>/dev/null | node scripts/gen-demo-svg.mjs > docs/assets/demo.svg
//
// The README shows the PNG (retina 2x, wider compatibility). To re-render it on
// macOS, scale the outer width/height and pin a font macOS can resolve by name
// (its SVG rasterizer ignores a font-family fallback list), then convert:
//   H=$(sed -n '1s/.*height="\([0-9]*\)".*/\1/p' docs/assets/demo.svg)
//   sed -e "1s/width=\"820\" height=\"$H\"/width=\"1640\" height=\"$((H*2))\"/" \
//       -e 's/font-family="[^"]*"/font-family="Menlo"/' docs/assets/demo.svg > /tmp/demo-2x.svg
//   sips -s format png /tmp/demo-2x.svg --out docs/assets/demo.png
import { readFileSync } from "node:fs";

const raw = readFileSync(0, "utf8").replace(/\s+$/, "");
const lines = raw.split("\n");

const PAD = 22;
const HEADER = 44;
const LH = 21;
const FS = 13.5;
const W = 820;
const H = HEADER + PAD + lines.length * LH + PAD - 4;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function color(line) {
  if (line.startsWith("$")) return "#7ee787";
  if (line.startsWith("→")) return "#58a6ff";
  if (line.startsWith("#")) return "#768390";
  if (line.trimStart().startsWith("←")) {
    if (/valid ✓|committed|resolved|connected/.test(line)) return "#56d364";
    return "#adbac7";
  }
  return "#adbac7";
}
const italic = (line) => (line.startsWith("#") ? ' font-style="italic"' : "");

// Indentation is encoded as an x offset rather than leading spaces: some SVG
// rasterizers (macOS CoreGraphics among them) collapse leading whitespace even
// under xml:space="preserve", which silently flattens the transcript.
const CHAR_W = FS * 0.6; // monospace advance
const rows = lines
  .map((line, i) => {
    if (line.trim() === "") return "";
    const indent = line.length - line.trimStart().length;
    const x = PAD + indent * CHAR_W;
    const y = HEADER + PAD + i * LH + FS;
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${color(line)}"${italic(line)}>${esc(line.trimStart())}</text>`;
  })
  .filter(Boolean)
  .join("\n    ");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rack MCP live session transcript">
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="11" fill="#0d1117" stroke="#30363d"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${HEADER}" rx="11" fill="#161b22"/>
  <rect x="0.5" y="${HEADER - 11}" width="${W - 1}" height="12" fill="#161b22"/>
  <circle cx="24" cy="22" r="6" fill="#ff5f56"/>
  <circle cx="44" cy="22" r="6" fill="#febc2e"/>
  <circle cx="64" cy="22" r="6" fill="#27c93f"/>
  <text x="${W / 2}" y="27" text-anchor="middle" fill="#768390" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="12.5">rack-mcp — live MCP session (real output)</text>
  <g font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="${FS}" xml:space="preserve">
    ${rows}
  </g>
</svg>
`;
process.stdout.write(svg);
