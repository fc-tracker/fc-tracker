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

const KEEP = ["def_id", "score", "rating", "rareflag", "league", "team", "nation", "name", "position", "positions", "weak_foot", "skill_moves", "team_name", "holo", "face", "art"];
// EA's art guid per card (a special's action shot, "dynamic image"): the snapshot's, else read from the saved raw
// card-database responses (captures/*_defid.json) – the same files the app replays at start
const art = new Map();
const caps = path.join(path.dirname(snapshot), "captures");
if (fs.existsSync(caps)) {
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    const id = o.resourceId ?? o.definitionId;
    if (typeof o.guidAssetId === "string" && o.guidAssetId && typeof id === "number") art.set(id, o.guidAssetId);
    Object.values(o).forEach(walk);
  };
  for (const f of fs.readdirSync(caps).filter((f) => f.endsWith("_defid.json"))) {
    try {
      walk(JSON.parse(fs.readFileSync(path.join(caps, f), "utf8")).body);
    } catch {}
  }
}
const gallery = Object.values(snap.gallery ?? {}).map((c) => {
  const out = { collected: false };
  for (const k of KEEP) if (c[k] != null && !(Array.isArray(c[k]) && !c[k].length) && c[k] !== false) out[k] = c[k];
  if (!out.art && art.has(c.def_id)) out.art = art.get(c.def_id);
  return out;
});
const catalog = { at: snap.gallery_synced_at ?? null, gallery, links: snap.team_links ?? {} };
const out = path.join(root, "src", "web", "catalog.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(catalog));
console.log(`${path.relative(root, out)}: ${gallery.length} cards (${gallery.filter((c) => c.art).length} with EA art), ${Object.keys(catalog.links).length} team links, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
