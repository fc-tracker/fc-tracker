// Anonymous usage counts (Umami, the same cookieless analytics as fc-tracker.com): how many
// installations start the app, and how far each one gets – connected, synced, a set read.
// Nothing about the player, the club or EA is ever sent: an event name, the app version and a
// random id made on this PC (so one installation counts once). Off in Settings → Usage statistics.
// The app sends as "app.fc-tracker.com", the browser version as "web.fc-tracker.com" – in Umami
// a filter on the hostname shows each on its own, apart from the website.

const UMAMI = "https://cloud.umami.is/api/send";
const WEBSITE = "a5548dcf-cd54-4723-ac06-c871f6718a5a";
const ID_KEY = "fct.usage.id";
const OFF_KEY = "fct.usage.off";
const ONCE_KEY = "fct.usage.once";

const get = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const set = (k: string, v: string | null) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {}
};

export const usageEnabled = () => get(OFF_KEY) !== "1";
export const setUsageEnabled = (on: boolean) => set(OFF_KEY, on ? null : "1");

function installId(): string {
  let id = get(ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    set(ID_KEY, id);
  }
  return id;
}

let host = "app.fc-tracker.com";
let version = "";
/** Which product sends ("app" or "web") and its version – once, before the first event. */
export function initUsage(kind: "app" | "web", v: string) {
  host = kind === "web" ? "web.fc-tracker.com" : "app.fc-tracker.com";
  version = v;
}

/** One event. `name` null = a visit (counts the installation as a visitor). */
export function track(name: string | null, data: Record<string, string | number | boolean> = {}) {
  if (!usageEnabled()) return;
  const payload = {
    website: WEBSITE,
    hostname: host,
    url: `/${host.split(".")[0]}`,
    title: host.startsWith("web") ? "FC-Tracker Web" : "FC-Tracker App",
    language: navigator.language,
    screen: `${screen.width}x${screen.height}`,
    id: installId(),
    ...(name ? { name, data: { version, ...data } } : {}),
  };
  fetch(UMAMI, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "event", payload }), keepalive: true }).catch(() => {});
}

/** An event that is sent once per installation (first start, first sync …). */
export function trackOnce(name: string, data: Record<string, string | number | boolean> = {}) {
  const done = new Set((get(ONCE_KEY) ?? "").split(",").filter(Boolean));
  if (done.has(name) || !usageEnabled()) return;
  done.add(name);
  set(ONCE_KEY, [...done].join(","));
  track(name, data);
}

// ---------------------------------------------------------------- presence (our own counter)
// A heartbeat every 5 minutes while the app runs (or FC-Tracker Web is open) to
// fc-tracker.com/api/beat: the same random id, the kind and the version – nothing else. It gives
// "online now" and exact active/installation counts (site/api/_presence.mjs). Off with the same
// setting as the usage counts.
const BEAT = "https://www.fc-tracker.com/api/beat";
const ONLINE = "https://www.fc-tracker.com/api/online";
const DAY_KEY = "fct.presence.day";
let beating: ReturnType<typeof setInterval> | null = null;

function beat(kind: "app" | "web") {
  if (!usageEnabled()) return;
  const today = new Date().toISOString().slice(0, 10);
  const daily = get(DAY_KEY) !== today;
  if (daily) set(DAY_KEY, today);
  // text/plain: no preflight; the server reads it as JSON
  fetch(BEAT, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ id: installId(), kind, v: version, day: daily }), keepalive: true }).catch(() => {
    if (daily) set(DAY_KEY, null); // the daily facts go with the next beat
  });
}

export function startPresence(kind: "app" | "web") {
  if (beating) return;
  beat(kind);
  beating = setInterval(() => beat(kind), 5 * 60 * 1000);
}

/** "N online now" – null while fewer than the public threshold are online. */
export async function onlineNow(): Promise<number | null> {
  try {
    const r = await fetch(ONLINE);
    const j = (await r.json()) as { shown: number | null };
    return typeof j.shown === "number" ? j.shown : null;
  } catch {
    return null;
  }
}
