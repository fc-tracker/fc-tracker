// Service worker: the only part that talks to the app on 127.0.0.1.
// When the app isn't running, what the Web App delivers is saved here (on this PC, in the
// extension's own storage) and handed to the app the next time it runs – nothing gets lost.
const APP = "http://127.0.0.1:47827";

async function token() {
  const { token } = await chrome.storage.local.get("token");
  return token;
}

async function call(path, { method = "GET", body } = {}) {
  // The version lets the app tell the user when a newer extension is out.
  const headers = { "X-FCT-Version": chrome.runtime.getManifest().version, ...(body ? { "Content-Type": "application/json" } : {}) };
  const t = await token();
  if (t) headers["X-FCT-Token"] = t;
  const res = await fetch(APP + path, { method, headers, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, ...data };
}

// ---------- i18n: follow the app's language (English by default), not Chrome's ----------

const LOCALES = ["en", "es", "fr", "de", "da"];
const messageCache = new Map();

async function loadMessages(locale) {
  if (!messageCache.has(locale)) {
    const res = await fetch(chrome.runtime.getURL(`_locales/${locale}/messages.json`));
    messageCache.set(locale, await res.json());
  }
  return messageCache.get(locale);
}

async function currentLocale() {
  const { locale } = await chrome.storage.local.get("locale");
  return LOCALES.includes(locale) ? locale : "en";
}

/** Messages for the app's language with English as fallback for missing keys. */
async function messages() {
  const locale = await currentLocale();
  const en = await loadMessages("en");
  return { locale, messages: locale === "en" ? en : { ...en, ...(await loadMessages(locale)) } };
}

// ---------- FC-Tracker Web (fc-tracker.com/web) ----------
// The browser version has no app to receive a sync. Once the user opened it with this extension
// installed ("webLinked"), every club sync is also kept here – the last complete one only, on
// this PC – and handed to that page when it asks (chrome.runtime.sendMessage from the site;
// externally_connectable allows only fc-tracker.com). Nothing is sent anywhere else.
const WEB_ORIGINS = ["https://www.fc-tracker.com", "https://fc-tracker.com"];

async function webLinked() {
  return !!(await chrome.storage.local.get("webLinked")).webLinked;
}

/** A sync starts (in the Web App tab `tab`): what the page gets is collected from scratch. */
function webStart(tab) {
  return serial(async () => {
    const { wPending } = await chrome.storage.local.get("wPending");
    if (Array.isArray(wPending) && wPending.length) await chrome.storage.local.remove(wPending);
    await chrome.storage.local.set({ wPending: [], wActive: true, wTab: tab ?? null, wStarted: Date.now() });
  });
}

/** The sync stopped without finishing (Web App closed, error): nothing half-read is handed over. */
function webAbandon() {
  return serial(async () => {
    const { wPending } = await chrome.storage.local.get("wPending");
    if (Array.isArray(wPending) && wPending.length) await chrome.storage.local.remove(wPending);
    await chrome.storage.local.set({ wPending: [], wActive: false, wTab: null });
  });
}

/** Is a sync really running? Its tab must still be open, and a sync never takes this long. */
async function webSyncing() {
  const { wActive, wTab, wStarted } = await chrome.storage.local.get(["wActive", "wTab", "wStarted"]);
  if (!wActive) return false;
  const alive = wTab == null ? false : await chrome.tabs.get(wTab).then(() => true, () => false);
  if (alive && Date.now() - (wStarted ?? 0) < 15 * 60 * 1000) return true;
  await webAbandon();
  return false;
}

// The Web App tab closed in the middle of a sync: it is over.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { wActive, wTab } = await chrome.storage.local.get(["wActive", "wTab"]);
  if (wActive && wTab === tabId) await webAbandon();
});

function webKeep(url, body, at) {
  return serial(async () => {
    const { wPending, wActive } = await chrome.storage.local.get(["wPending", "wActive"]);
    if (!wActive) return;
    const key = `w:${at}:${Math.random().toString(36).slice(2, 8)}`;
    await chrome.storage.local.set({ [key]: { url, body, at }, wPending: [...(Array.isArray(wPending) ? wPending : []), key] });
  });
}

/** The sync finished: it becomes the one the page gets (the one before is removed). */
function webDone(at) {
  return serial(async () => {
    const { wPending, wLast, wActive } = await chrome.storage.local.get(["wPending", "wLast", "wActive"]);
    if (!wActive) return;
    if (wLast?.keys?.length) await chrome.storage.local.remove(wLast.keys);
    await chrome.storage.local.set({ wLast: { at, keys: Array.isArray(wPending) ? wPending : [] }, wPending: [], wActive: false });
  });
}

chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  if (!WEB_ORIGINS.includes(sender.origin)) return false;
  (async () => {
    switch (msg?.type) {
      case "hello": {
        // the page is open: from now on syncs are kept for it (also without the app)
        await chrome.storage.local.set({ webLinked: true });
        const { wLast } = await chrome.storage.local.get("wLast");
        await showPairingHint(false);
        return reply({ ok: true, version: chrome.runtime.getManifest().version, syncAt: wLast?.at ?? null, syncing: await webSyncing() });
      }
      case "sets":
        // which Gallery sets a sync reads (the page has the same list as the app)
        if (Array.isArray(msg.sets) && msg.sets.length) {
          const { gallerySets } = await chrome.storage.local.get("gallerySets");
          if (!Array.isArray(gallerySets) || !gallerySets.length) await chrome.storage.local.set({ gallerySets: msg.sets });
        }
        return reply({ ok: true });
      case "get-sync": {
        const { wLast } = await chrome.storage.local.get("wLast");
        if (!wLast?.keys?.length) return reply({ ok: true, at: null, entries: [] });
        const stored = await chrome.storage.local.get(wLast.keys);
        return reply({ ok: true, at: wLast.at, entries: wLast.keys.map((k) => stored[k]).filter(Boolean).map(({ url, body }) => ({ url, body })) });
      }
      case "open-webapp":
        // the user asked for a sync: the Web App syncs by itself when it opens
        await chrome.tabs.create({ url: "https://www.ea.com/ea-sports-fc/ultimate-team/web-app/" });
        return reply({ ok: true });
      default:
        return reply({ ok: false, error: "unknown_message" });
    }
  })().catch((e) => reply({ ok: false, error: String(e?.message ?? e) }));
  return true;
});

// ---------- saved syncs (app not running) ----------
// Each response is one storage key ("q:…"); "qIndex" lists them in order with what we need to
// decide without loading them: the sync they belong to (batch), the time and the size.
// A batch is one active sync (club + Gallery reads); passive responses have no batch.

const MAX_SAVED_BYTES = 80 * 1024 * 1024; // a full sync is ~5–6 MB; keep the newest
let chain = Promise.resolve();
/** Runs queue operations one after another (messages arrive in parallel). */
const serial = (fn) => (chain = chain.then(fn, fn));

async function queueIndex() {
  const { qIndex } = await chrome.storage.local.get("qIndex");
  return Array.isArray(qIndex) ? qIndex : [];
}

async function currentBatch() {
  const { batch } = await chrome.storage.local.get("batch");
  return batch ?? null;
}

function enqueue(entry) {
  return serial(async () => {
    const index = await queueIndex();
    const key = `q:${entry.at}:${Math.random().toString(36).slice(2, 8)}`;
    const size = entry.done ? 64 : JSON.stringify(entry.body ?? null).length;
    index.push({ key, at: entry.at, batch: entry.batch ?? null, done: !!entry.done, size });
    // Over the cap: drop the oldest saved responses first.
    let total = index.reduce((n, e) => n + e.size, 0);
    const drop = [];
    while (total > MAX_SAVED_BYTES && index.length > 1) {
      const e = index.shift();
      total -= e.size;
      drop.push(e.key);
    }
    if (drop.length) await chrome.storage.local.remove(drop);
    await chrome.storage.local.set({ [key]: entry, qIndex: index });
  });
}

/** A new sync starts: an older saved sync that was never delivered is replaced by it. */
function startBatch() {
  return serial(async () => {
    const batch = Date.now();
    const index = await queueIndex();
    const old = index.filter((e) => e.batch);
    if (old.length) await chrome.storage.local.remove(old.map((e) => e.key));
    await chrome.storage.local.set({ batch, qIndex: index.filter((e) => !e.batch) });
    return batch;
  });
}

/**
 * Hands everything saved to the app, oldest first, with the time it was really read.
 * A saved sync older than the app's own last sync is outdated and dropped.
 */
function flush() {
  return serial(async () => {
    let index = await queueIndex();
    if (!index.length) return;
    let ping;
    try {
      ping = await call("/ping");
    } catch {
      return; // app not running – keep everything
    }
    if (!ping.authorized) return;
    // Anything read before the app's own last sync is older than what the app knows – e.g. a
    // player sold since then would come back. Such data is dropped, synced or passive alike.
    const syncedAt = Number(ping.synced_at ?? 0);
    const outdated = new Set(index.filter((e) => e.batch && e.batch <= syncedAt).map((e) => e.batch));
    for (const e of [...index]) {
      if (!(e.batch && outdated.has(e.batch)) && e.at > syncedAt) {
        const stored = (await chrome.storage.local.get(e.key))[e.key];
        if (stored) {
          let res;
          try {
            res = stored.done
              ? await call("/sync-done", { method: "POST", body: { at: stored.at } })
              : await call("/capture", { method: "POST", body: { url: stored.url, body: stored.body, at: stored.at } });
          } catch {
            return; // the app went away: the rest stays saved
          }
          if (!res.ok && res.status !== 400) return;
        }
      }
      await chrome.storage.local.remove(e.key);
      index = index.filter((x) => x.key !== e.key);
      await chrome.storage.local.set({ qIndex: index });
    }
  });
}

async function hasSaved() {
  return (await queueIndex()).length > 0;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    try {
      switch (msg.type) {
        case "i18n":
          return reply(await messages());
        case "ping": {
          const res = await call("/ping");
          if (LOCALES.includes(res.locale)) await chrome.storage.local.set({ locale: res.locale });
          await rememberLatest(res);
          await showPairingHint(!res.authorized);
          if (res.authorized) flush();
          return reply(res);
        }
        case "update-info": {
          const { latest } = await chrome.storage.local.get("latest");
          const have = chrome.runtime.getManifest().version;
          const self = await chrome.management.getSelf();
          return reply({ have, latest: latest ?? null, outdated: isOlder(have, latest), installType: self.installType });
        }
        case "update-check": {
          // Chrome Web Store copy: ask the store now; an update found is applied by reloading
          const self = await chrome.management.getSelf();
          if (self.installType !== "normal") return reply({ status: "manual" });
          const status = await new Promise((resolve) =>
            chrome.runtime.requestUpdateCheck((s) => resolve(chrome.runtime.lastError ? "error" : s)),
          );
          reply({ status: typeof status === "string" ? status : status?.status ?? "error" });
          if ((typeof status === "string" ? status : status?.status) === "update_available") setTimeout(() => chrome.runtime.reload(), 1500);
          return;
        }
        case "status": {
          const { lastSyncAt } = await chrome.storage.local.get("lastSyncAt");
          return reply({ paired: !!(await token()), web: await webLinked(), lastSyncAt: lastSyncAt ?? 0, saved: await hasSaved() });
        }
        case "pair": {
          const res = await call("/pair", { method: "POST", body: { code: msg.code } });
          if (res.ok && res.token) await chrome.storage.local.set({ token: res.token });
          if (res.ok) {
            await showPairingHint(false);
            flush();
          }
          return reply({ ok: res.ok, error: res.error });
        }
        case "gallerySets": {
          // Which Gallery sets to read comes from the app; the last list is kept for syncs
          // that run while the app is closed.
          try {
            const res = await call("/gallery-sets");
            if (res.ok && Array.isArray(res.sets)) await chrome.storage.local.set({ gallerySets: res.sets });
            if (res.ok) return reply(res);
          } catch {}
          const { gallerySets } = await chrome.storage.local.get("gallerySets");
          return reply({ ok: true, sets: Array.isArray(gallerySets) ? gallerySets : [], cached: true });
        }
        case "syncBlocked":
          // The Web App isn't signed in: the app tells the user on top of the game.
          try {
            return reply(await call("/sync-blocked", { method: "POST", body: { reason: msg.reason } }));
          } catch {
            return reply({ ok: false, error: "app_unreachable" });
          }
        case "syncStart":
          if (await webLinked()) await webStart(sender.tab?.id);
          return reply({ batch: await startBatch() });
        case "capture": {
          const at = Date.now();
          const web = await webLinked();
          if (web) await webKeep(msg.url, msg.body, at);
          try {
            if (await hasSaved()) await flush(); // keep the order: older saved data first
            const res = await call("/capture", { method: "POST", body: { url: msg.url, body: msg.body, at } });
            if (res.ok || res.status === 401) return reply(res);
          } catch {}
          // no app: kept for FC-Tracker Web only
          if (!(await token())) return reply(web ? { ok: true, web: true, items: 0 } : { ok: false, error: "app_unreachable" });
          await enqueue({ url: msg.url, body: msg.body, at, batch: msg.url.startsWith("fct://") ? await currentBatch() : null });
          return reply({ ok: true, queued: true, items: 0 });
        }
        case "done": {
          const at = Date.now();
          const web = await webLinked();
          if (web) await webDone(at);
          try {
            if (await hasSaved()) await flush();
            const res = await call("/sync-done", { method: "POST", body: { at } });
            if (res.ok) {
              await chrome.storage.local.set({ lastSyncAt: at });
              reply({ ok: true, players: res.player_count });
              // Close the Web App tab so its session does not clash with the game.
              if (msg.closeTab && sender.tab?.id) setTimeout(() => chrome.tabs.remove(sender.tab.id), 1500);
              return;
            }
          } catch {}
          if (!(await token())) {
            if (!web) return reply({ ok: false, error: "app_unreachable" });
            await chrome.storage.local.set({ lastSyncAt: at });
            return reply({ ok: true, web: true });
          }
          await enqueue({ done: true, at, batch: await currentBatch() });
          await chrome.storage.local.set({ lastSyncAt: at });
          return reply({ ok: true, queued: true });
        }
        case "syncFailed":
          if (await webLinked()) await webAbandon();
          return reply({ ok: true });
        case "abortSync":
          // The game entered Ultimate Team: close the Web App so the game keeps the session.
          if (sender.tab?.id) chrome.tabs.remove(sender.tab.id);
          return reply({ ok: true });
        case "unpair":
          await chrome.storage.local.remove("token");
          return reply({ ok: true });
        default:
          return reply({ ok: false, error: "unknown_message" });
      }
    } catch (e) {
      console.warn("fc-tracker: app unreachable", e);
      reply({ ok: false, error: "app_unreachable", detail: String(e?.message ?? e) });
    }
  })();
  return true; // replies asynchronously
});

// ---------- check in with the app: on install/start and every minute while Chrome runs ----------
// The app can only tell "connected" from "needs the code" when the extension speaks up, so it
// does so on its own – the launcher then shows the right state before the user starts a sync.
// The same check delivers anything saved while the app was closed (within a minute of its start).

/**
 * Not connected yet: a small "!" on the toolbar icon says "click me" – the popup holds the
 * code field. Never a tab of its own: opening pages by itself felt like malware (user, 2026-10-15).
 */
async function showPairingHint(needed) {
  // used with FC-Tracker Web only: no app to pair with, nothing to point at
  if (needed && !(await token()) && (await webLinked())) needed = false;
  if (needed) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#f5c542" });
    return;
  }
  // connected: a newer version is out → "↑" on the icon until it is installed
  const outdated = isOlder(chrome.runtime.getManifest().version, (await chrome.storage.local.get("latest")).latest);
  await chrome.action.setBadgeText({ text: outdated ? "↑" : "" });
  if (outdated) await chrome.action.setBadgeBackgroundColor({ color: "#8d6bff" });
}

/** "0.10.2" older than "0.10.5"? (missing = not older) */
function isOlder(have, latest) {
  if (!have || !latest) return false;
  const a = have.split(".").map(Number);
  const b = latest.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/** The app tells which extension version belongs to it. */
async function rememberLatest(res) {
  if (typeof res?.extension_latest === "string" && /^\d+(\.\d+)*$/.test(res.extension_latest)) {
    await chrome.storage.local.set({ latest: res.extension_latest });
  }
}

async function checkIn() {
  try {
    const res = await call("/ping");
    if (LOCALES.includes(res.locale)) await chrome.storage.local.set({ locale: res.locale });
    await rememberLatest(res);
    await showPairingHint(!res.authorized);
    if (res.authorized) await flush();
    return res;
  } catch {
    await showPairingHint(!(await token()));
    return null; // app not running
  }
}

// Every 30 s (the shortest Chrome allows): the launcher sees quickly when the extension is gone.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("check-in", { periodInMinutes: 0.5 });
  checkIn();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("check-in", { periodInMinutes: 0.5 });
  checkIn();
});
chrome.alarms.onAlarm.addListener((a) => a.name === "check-in" && checkIn());
