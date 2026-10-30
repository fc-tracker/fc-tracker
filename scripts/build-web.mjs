// Builds the browser version (fc-tracker.com/web) into site/public/web:
//   npm run build:web
// 1. web-core: the app's Gallery model (gallery, gallery_sets, lineup) for WebAssembly
//    (needs `rustup target add wasm32-unknown-unknown` once).
// 2. vite --mode web: the overlay + side panel + screen reading (web.html → src/web/main.tsx).
// The card catalog (src/web/catalog.json) comes from scripts/web-catalog.mjs – refresh it after a
// sync when new cards are out. Then `node site/build.mjs`, commit and push.
// WEB_REQUIRED=1 npm run build:web – open pages older than this build must reload (update required).
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
const out = path.join(root, "site", "public", "web");
// version.json: open pages compare it with their own build (src/web/WebUpdate.tsx) and show the
// new one at once; WEB_REQUIRED=1 makes this build required (older pages reload by themselves).
const old = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(out, "version.json"), "utf8"));
  } catch {
    return {};
  }
})();
const build = Date.now();
const extensionRequired = /EXTENSION_REQUIRED: &str = "([\d.]+)"/.exec(fs.readFileSync(path.join(root, "src-tauri", "src", "updates.rs"), "utf8"))?.[1];
execSync("npx vite build --mode web", { cwd: root, stdio: "inherit", env: { ...process.env, VITE_WEB_BUILD: String(build) } });
fs.writeFileSync(
  path.join(out, "version.json"),
  JSON.stringify({ build, required: process.env.WEB_REQUIRED === "1" ? build : old.required ?? 0, ...(extensionRequired ? { extension_required: extensionRequired } : {}) }, null, 2) + "\n",
);
// served at /web (index.html), not /web/web
fs.renameSync(path.join(out, "web.html"), path.join(out, "index.html"));
const size = fs.readdirSync(path.join(out, "assets")).reduce((a, f) => a + fs.statSync(path.join(out, "assets", f)).size, 0);
console.log(`site/public/web: ${(size / 1024).toFixed(0)} KB of assets`);
