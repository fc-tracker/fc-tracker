// Builds the browser version (fc-tracker.com/web) into site/public/web:
//   npm run build:web
// 1. web-core: the app's Gallery model (gallery, gallery_sets, lineup) for WebAssembly
//    (needs `rustup target add wasm32-unknown-unknown` once).
// 2. vite --mode web: the overlay + side panel + screen reading (web.html → src/web/main.tsx).
// The card catalog (src/web/catalog.json) comes from scripts/web-catalog.mjs – refresh it after a
// sync when new cards are out. Then `node site/build.mjs`, commit and push.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!fs.existsSync(path.join(root, "src", "web", "catalog.json"))) {
  console.error("src/web/catalog.json is missing – run node scripts/web-catalog.mjs first");
  process.exit(1);
}
execSync("cargo build --release --target wasm32-unknown-unknown", { cwd: path.join(root, "web-core"), stdio: "inherit" });
execSync("npx vite build --mode web", { cwd: root, stdio: "inherit" });
const out = path.join(root, "site", "public", "web");
// served at /web (index.html), not /web/web
fs.renameSync(path.join(out, "web.html"), path.join(out, "index.html"));
const size = fs.readdirSync(path.join(out, "assets")).reduce((a, f) => a + fs.statSync(path.join(out, "assets", f)).size, 0);
console.log(`site/public/web: ${(size / 1024).toFixed(0)} KB of assets`);
