// The browser version's card catalog: every Gallery card from a synced snapshot, with nobody's
// ownership in it (collected = false for all) – the browser learns what a user owns only from
// their own screen. Run after a sync, then `npm run build:web`:
//   node scripts/web-catalog.mjs            (snapshot from %APPDATA%\dk.fctracker.app)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshot = process.env.FCT_REAL_SNAPSHOT ?? path.join(process.env.APPDATA ?? "", "dk.fctracker.app", "snapshot.json");
const snap = JSON.parse(fs.readFileSync(snapshot, "utf8"));

const KEEP = ["def_id", "score", "rating", "rareflag", "league", "team", "nation", "name", "position", "positions", "weak_foot", "skill_moves", "team_name", "holo"];
const gallery = Object.values(snap.gallery ?? {}).map((c) => {
  const out = { collected: false };
  for (const k of KEEP) if (c[k] != null && !(Array.isArray(c[k]) && !c[k].length) && c[k] !== false) out[k] = c[k];
  return out;
});
const catalog = { at: snap.gallery_synced_at ?? null, gallery, links: snap.team_links ?? {} };
const out = path.join(root, "src", "web", "catalog.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(catalog));
console.log(`${path.relative(root, out)}: ${gallery.length} cards, ${Object.keys(catalog.links).length} team links, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
