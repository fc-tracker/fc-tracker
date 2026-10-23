// The Gallery set list from fc-tracker.com (built from src-tauri/gallery-sets.json). When EA adds
// a set we update that one file and deploy the site: the app and FC-Tracker Web load it at start
// when its revision is newer than the one built in, and the next sync reads the leagues it adds –
// no app release. Sets the game shows that the list doesn't have yet are reported anonymously
// (the set's name only, Settings → Anonymous usage statistics) so we hear of them the same day.
import { api, IS_WEB } from "./api";
import { track } from "./usage";

const URL_ = IS_WEB ? "/gallery-sets.json" : "https://www.fc-tracker.com/gallery-sets.json";
const EVERY = 6 * 60 * 60 * 1000;
const UNKNOWN_EVERY = 5 * 60 * 1000;

async function round() {
  const r = await fetch(URL_, { cache: "no-cache" });
  if (!r.ok) return;
  const json = await r.text();
  const revision = (JSON.parse(json) as { revision?: number }).revision ?? 0;
  if (revision > (await api.gallerySetsRevision())) await api.useGallerySets(json);
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Loads the set list now and every 6 hours; in the app also reports unknown sets. */
export function startGallerySets() {
  if (timer) return;
  const run = () => round().catch(() => {});
  run();
  timer = setInterval(run, EVERY);
  if (IS_WEB) return;
  setInterval(() => {
    api
      .takeUnknownSets()
      .then((names) => names.forEach((name) => track("unknown-set", { name })))
      .catch(() => {});
  }, UNKNOWN_EVERY);
}
