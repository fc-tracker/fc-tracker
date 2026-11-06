// Service worker: the only part that talks to the app on 127.0.0.1.
// When the app isn't running, what the Web App delivers is saved here (on this PC, in the
// extension's own storage) and handed to the app the next time it runs – nothing gets lost.
//
// Who owns a club sync (v2, BRAND-MIGRATION.md "No sync without an owner"):
// - paired with the app → the app. It gets every response (or later, saved here), and keeps it on
//   its own FC-Tracker account. The extension holds no account token for that – /ping only says
//   whose account it is.
// - not paired, signed in here (e-mail code, its own device on the account) → the account: the
//   finished sync is sent to api.fc-tracker.com, which merges it into the account's Gallery and
//   Web App parts (server/src/club.rs). EA's session token never leaves the Web App.
// - neither → no sync at all; the badge and the popup offer the sign-in.
const APP = "http://127.0.0.1:47827";
const API = "https://api.fc-tracker.com";

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

// ---------- the FC-Tracker account (used only when no app is paired) ----------
// The refresh token (rotated on every use, per device) stays in this extension's local storage;
// the 15-minute access token only in session memory. Errors are codes (popup: authError_<code>).

async function account() {
  const { acct } = await chrome.storage.local.get("acct");
  return acct?.refresh ? acct : null;
}

async function api(method, path, body, auth = true) {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = `Bearer ${await accessToken()}`;
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw "offline";
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const code = (json && typeof json.error === "string" && json.error) || "server";
    if (code === "signed_out" && auth) await signedOutHere();
    throw code;
  }
  return json;
}

// One refresh at a time: two with the same refresh token would look like a stolen copy and the
// server would sign this device out.
let refreshing = null;
async function accessToken() {
  const { access } = await chrome.storage.session.get("access");
  if (access?.until > Date.now() + 30_000) return access.token;
  refreshing ??= (async () => {
    const acct = await account();
    if (!acct) throw "signed_out";
    const r = await api("POST", "/v1/auth/refresh", { refresh: acct.refresh }, false).catch(async (e) => {
      if (e === "signed_out") await signedOutHere();
      throw e;
    });
    await chrome.storage.local.set({ acct: { ...acct, refresh: r.refresh } });
    await chrome.storage.session.set({ access: { token: r.access, until: Date.now() + r.expires_in * 1000 } });
    return r.access;
  })().finally(() => (refreshing = null));
  return refreshing;
}

/** The server ended this device's sign-in (signed out elsewhere, or revoked in the devices list). */
async function signedOutHere() {
  await chrome.storage.local.remove(["acct", "pushPending"]);
  await chrome.storage.session.remove("access");
}

function deviceName() {
  const ua = navigator.userAgent;
  return `FC-Tracker extension · ${/Edg\//.test(ua) ? "Edge" : "Chrome"}`;
}

async function signIn(email, code) {
  const r = await api(
    "POST",
    "/v1/auth/verify",
    { email: email.trim(), code, device: { name: deviceName(), kind: "extension" }, locale: await currentLocale() },
    false,
  );
  await chrome.storage.local.set({ acct: { refresh: r.refresh, email: r.user.email, at: Date.now() } });
  await chrome.storage.session.set({ access: { token: r.access, until: Date.now() + r.expires_in * 1000 } });
  await showPairingHint(false);
}

async function signOut() {
  await api("POST", "/v1/auth/logout").catch(() => {});
  await signedOutHere();
}

/** Who gets a club sync now: "app" (paired), "account" (signed in here) or null (nobody – no sync). */
async function owner() {
  if (await token()) return "app";
  if (await account()) return "account";
  return null;
}

/** JSON → gzip → base64 (the server's part format). */
async function packed(value) {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * The last finished sync (what FC-Tracker Web gets too) goes to the account. Only when no app is
 * paired – a paired app keeps it on its own account. Kept as pending until the server took it.
 */
// ---------- the coin balance (passive) ----------
// EA's Web App loads the balance itself (usermassinfo at sign-in, tradepile, watchlist). The last
// one seen is kept here, because the sign-in response arrives before a sync begins – FC-Tracker Web
// and the account get it with the sync as `fct://webapp/coins {credits, at}` (web-core reads it).
// No request of our own. The app gets every response anyway and reads it itself.
const COIN_URL = /\/(usermassinfo|tradepile|watchlist|user\/credits)(\?|$)/;

async function noteCoins(url, body) {
  if (!COIN_URL.test(String(url)) || !body || typeof body !== "object") return;
  const credits = body.credits ?? body.userInfo?.credits;
  if (!Number.isSafeInteger(credits) || credits < 0) return;
  await chrome.storage.local.set({ coinsSeen: { credits, at: Date.now() } });
}

/** A sync's entries with the last balance seen in front (newer reads in the sync still win). */
async function withCoins(entries) {
  const { coinsSeen } = await chrome.storage.local.get("coinsSeen");
  return coinsSeen ? [{ url: "fct://webapp/coins", body: coinsSeen }, ...entries] : entries;
}

function pushClub() {
  return serial(async () => {
    const { wLast, pushPending } = await chrome.storage.local.get(["wLast", "pushPending"]);
    if (!wLast?.keys?.length || (await owner()) !== "account") return { ok: false, error: "nothing" };
    if (pushPending !== wLast.at) await chrome.storage.local.set({ pushPending: wLast.at });
    const stored = await chrome.storage.local.get(wLast.keys);
    const entries = await withCoins(wLast.keys.map((k) => stored[k]).filter(Boolean).map(({ url, body }) => ({ url, body })));
    try {
      const r = await api("POST", "/v1/club-sync", { at: wLast.at, data: await packed({ entries }) });
      await chrome.storage.local.set({ pushedAt: wLast.at, pushCollected: r.collected ?? null });
      await chrome.storage.local.remove("pushPending");
      return { ok: true, collected: r.collected ?? null };
    } catch (e) {
      // "bad_request" / "too_large": sending it again won't help
      if (e === "bad_request" || e === "too_large" || e === "signed_out") await chrome.storage.local.remove("pushPending");
      return { ok: false, error: String(e) };
    }
  });
}

/** A sync the server didn't take yet (offline, server busy): tried again at the next check-in. */
async function retryPush() {
  const { pushPending, wLast } = await chrome.storage.local.get(["pushPending", "wLast"]);
  if (pushPending && pushPending === wLast?.at) await pushClub();
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
// The browser version has no app to receive a sync. Every club sync is also kept here – the last
// complete one only, on this PC – always, not only once the page said hello ("webLinked"): a
// fresh install that synced before opening the page needed a second sync (2026-11-01).
// "webLinked" only decides what a sync without the app answers. The page gets the sync when it
// asks (chrome.runtime.sendMessage from the site;
// externally_connectable allows only fc-tracker.com). Nothing is sent anywhere else.
// FC-Tracker Web and the dashboard (also on its own host, dashboard.fc-tracker.com)
const WEB_ORIGINS = ["https://www.fc-tracker.com", "https://fc-tracker.com", "https://dashboard.fc-tracker.com"];

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

// FC-Tracker Web reads the club and the Gallery; the rest of a sync (SBCs, objectives, events)
// is only for the app – not kept in the browser for the page.
// Objective squads read in the Web App (objectives, names, formations, player attributes) are kept.
// EA's whole objectives list goes through (/scmp/objective/categories/all): the page plans from
// every event with its progress, not only the ones the sync opened
const WEB_SKIP = /\/(sbs|scmp(?!\/objective\/categories\/all)|champs2|rivals|sqbt|leaderboards|academy(?!\/hub)|squad|store|eventtoken|club\/stats)\b|\/fc\/(user|season)\b|^fct:\/\/webapp\/(?!objectives|names|formations|attributes)/;

function webKeep(url, body, at) {
  if (WEB_SKIP.test(url)) return Promise.resolve();
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
        // v2 additions: who gets a sync (null = nobody: the extension asks for a sign-in first) and
        // when the last one reached the account (no e-mail, no token – only that it happened)
        const { pushedAt } = await chrome.storage.local.get("pushedAt");
        return reply({
          ok: true,
          version: chrome.runtime.getManifest().version,
          syncAt: wLast?.at ?? null,
          syncing: await webSyncing(),
          owner: await owner(),
          pushedAt: pushedAt ?? null,
        });
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
        return reply({ ok: true, at: wLast.at, entries: await withCoins(wLast.keys.map((k) => stored[k]).filter(Boolean).map(({ url, body }) => ({ url, body }))) });
      }
      case "update":
        // the page needs a newer extension (update required): ask the store now
        await updateNow("web");
        return reply({ ok: true, version: chrome.runtime.getManifest().version });
      case "open-webapp":
        // the user asked for a sync: the Web App syncs by itself when it opens
        await chrome.tabs.create({ url: "https://www.ea.com/ea-sports-fc/ultimate-team/web-app/" });
        return reply({ ok: true });
      case "open-popup":
        // FC-Tracker Web's "Sign in to the extension" (no owner yet): the popup holds the e-mail-code sign-in
        try {
          await chrome.action.openPopup();
        } catch {
          await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?tab=1") });
        }
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
          await rememberAppState(res);
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
          const paired = !!(await token());
          const { appSeen, openFailedAt } = await chrome.storage.local.get(["appSeen", "openFailedAt"]);
          // "Open FC-Tracker" didn't start the app in the last 10 minutes: offer the download
          const openFailed = !!openFailedAt && Date.now() - openFailedAt < 10 * 60 * 1000;
          const acct = await account();
          const { pushedAt, pushPending, pushCollected, theme } = await chrome.storage.local.get(["pushedAt", "pushPending", "pushCollected", "theme"]);
          return reply({
            paired,
            appSeen: !!appSeen || paired,
            openFailed,
            web: await webLinked(),
            lastSyncAt: lastSyncAt ?? 0,
            saved: await hasSaved(),
            // v2: who gets a sync, this extension's own sign-in, the last push to the account
            owner: paired ? "app" : acct ? "account" : null,
            email: acct?.email ?? null,
            pushedAt: pushedAt ?? 0,
            pushPending: !!pushPending,
            pushCollected: pushCollected ?? null,
            theme: theme ?? "glass",
          });
        }
        case "auth-start":
          try {
            await api("POST", "/v1/auth/start", { email: String(msg.email ?? "").trim(), locale: await currentLocale() }, false);
            return reply({ ok: true });
          } catch (e) {
            return reply({ ok: false, error: String(e) });
          }
        case "auth-verify":
          try {
            await signIn(String(msg.email ?? ""), String(msg.code ?? "").replace(/\D/g, ""));
            // a sync from the last day, read before the sign-in (kept for FC-Tracker Web), goes to the account now
            const { wLast } = await chrome.storage.local.get("wLast");
            if (!(await token()) && wLast?.at > Date.now() - 24 * 3600 * 1000) {
              await chrome.storage.local.set({ pushPending: wLast.at });
              retryPush();
            }
            return reply({ ok: true });
          } catch (e) {
            return reply({ ok: false, error: String(e) });
          }
        case "sign-out":
          await signOut();
          await showPairingHint(!(await token()));
          return reply({ ok: true });
        case "open-popup":
          // the badge's "Sign in" (a click in the Web App): the popup holds the sign-in
          try {
            await chrome.action.openPopup();
          } catch {
            await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?tab=1") });
          }
          return reply({ ok: true });
        case "openApp": {
          // fctracker:// (registered by the app's installer); no answer within ~8 s = not installed here
          await chrome.storage.local.remove("openFailedAt");
          await chrome.tabs.create({ url: "fctracker://open" });
          reply({ ok: true });
          for (let i = 0; i < 8; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            try {
              if ((await call("/ping")).app === "fc-tracker") return;
            } catch {}
          }
          await chrome.storage.local.set({ openFailedAt: Date.now() });
          return;
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
            if (res.ok && Array.isArray(res.sets)) await chrome.storage.local.set({ gallerySets: res.sets, gallerySetsAt: Date.now() });
            if (res.ok) return reply(res);
          } catch {}
          // no app: the same list from fc-tracker's API (public, no account data) – once a day
          const { gallerySets, gallerySetsAt } = await chrome.storage.local.get(["gallerySets", "gallerySetsAt"]);
          const fresh = Array.isArray(gallerySets) && gallerySets.length && Date.now() - (gallerySetsAt ?? 0) < 24 * 3600 * 1000;
          if (!fresh && (await owner()) === "account") {
            try {
              const r = await api("GET", "/v1/gallery-sets", undefined, false);
              if (Array.isArray(r?.sets) && r.sets.length) {
                await chrome.storage.local.set({ gallerySets: r.sets, gallerySetsAt: Date.now() });
                return reply({ ok: true, sets: r.sets, cached: false });
              }
            } catch {}
          }
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
          // no owner (not paired, not signed in): no sync – checked here too, not only in the badge
          if (!(await owner())) return reply({ ok: false, error: "no_owner" });
          await webStart(sender.tab?.id);
          return reply({ batch: await startBatch() });
        case "capture": {
          // nothing is kept or sent for nobody – not even for FC-Tracker Web
          if (!(await owner())) return reply({ ok: false, error: "no_owner" });
          await noteCoins(msg.url, msg.body);
          const at = Date.now();
          const web = await webLinked();
          await webKeep(msg.url, msg.body, at);
          // not paired: the app isn't the owner – the account (or FC-Tracker Web) gets the finished sync
          if (!(await token())) {
            if (await account()) return reply({ ok: true, account: true, items: 0 });
            return reply(web ? { ok: true, web: true, items: 0 } : { ok: false, error: "no_owner" });
          }
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
          await webDone(at);
          if (!(await token()) && (await account())) {
            // signed in without the app: the sync goes to the account (the badge shows it happening)
            await chrome.storage.local.set({ lastSyncAt: at });
            const r = await pushClub();
            if (msg.closeTab && sender.tab?.id) setTimeout(() => chrome.tabs.remove(sender.tab.id), 1500);
            return reply({ ok: true, account: true, pushed: r.ok, collected: r.collected ?? null, error: r.error ?? null });
          }
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
          await webAbandon();
          return reply({ ok: true });
        case "abortSync":
          // The game entered Ultimate Team: close the Web App so the game keeps the session.
          if (sender.tab?.id) chrome.tabs.remove(sender.tab.id);
          return reply({ ok: true });
        case "unpair":
          await chrome.storage.local.remove("token");
          await chrome.storage.session.remove("appAccount");
          return reply({ ok: true });
        case "app-account": {
          // the paired app's account (bridge protocol 2); undefined = an older app that doesn't say
          const { appAccount } = await chrome.storage.session.get("appAccount");
          return reply({ ok: true, appAccount: appAccount ?? null });
        }
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
  // signed in without the app: the sync has an owner, nothing to point at
  if (needed && !(await token()) && (await account())) needed = false;
  if (needed) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#F5B03B" }); // v2 --amber: the user has to act
    return;
  }
  // connected: a newer version is out → "↑" on the icon until it is installed
  const outdated = isOlder(chrome.runtime.getManifest().version, (await chrome.storage.local.get("latest")).latest);
  await chrome.action.setBadgeText({ text: outdated ? "↑" : "" });
  if (outdated) await chrome.action.setBadgeBackgroundColor({ color: "#EF4359" }); // v2 --red: the one action
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

/**
 * What a paired app tells (bridge protocol 2): its theme – the popup and the badge follow it – and
 * whose account it keeps the sync on. An older app says neither: dark glass, account unknown.
 */
async function rememberAppState(res) {
  if (!res?.authorized) return;
  const theme = ["light", "dark", "glass"].includes(res.theme) ? res.theme : null;
  const appAccount = res.account && typeof res.account === "object" ? { signedIn: !!res.account.signed_in, email: res.account.email ?? null } : null;
  const { theme: had } = await chrome.storage.local.get("theme");
  if (theme && theme !== had) await chrome.storage.local.set({ theme });
  await chrome.storage.session.set({ appAccount });
}

/** The app tells which extension version belongs to it. */
async function rememberLatest(res) {
  // The app answered once: it is installed (the popup offers "Open FC-Tracker", else "Get the app").
  if (res?.app === "fc-tracker") {
    const { appSeen } = await chrome.storage.local.get("appSeen");
    if (!appSeen) await chrome.storage.local.set({ appSeen: true });
    await chrome.storage.local.remove("openFailedAt");
  }
  if (typeof res?.extension_latest === "string" && /^\d+(\.\d+)*$/.test(res.extension_latest)) {
    await chrome.storage.local.set({ latest: res.extension_latest });
  }
  // The app needs a newer extension (an update required): ask the Chrome Web Store now instead of
  // waiting for Chrome's own check (hours) – at most every 10 minutes.
  if (typeof res?.extension_required === "string" && isOlder(chrome.runtime.getManifest().version, res.extension_required)) {
    await updateNow("required");
  }
}

/** Asks the store for this extension's update; one found is applied by reloading. */
async function updateNow(reason) {
  const { updateAskedAt } = await chrome.storage.local.get("updateAskedAt");
  if (updateAskedAt && Date.now() - updateAskedAt < 10 * 60 * 1000) return;
  await chrome.storage.local.set({ updateAskedAt: Date.now() });
  try {
    const self = await chrome.management.getSelf();
    if (self.installType !== "normal") return; // a developer copy updates by hand
    chrome.runtime.requestUpdateCheck((s) => {
      const status = typeof s === "string" ? s : s?.status;
      if (!chrome.runtime.lastError && status === "update_available") applyUpdate(reason);
    });
  } catch {}
}

/** Reloads into the new version – not in the middle of a sync. */
async function applyUpdate(reason) {
  for (let i = 0; i < 60 && (await syncRunning()); i++) await new Promise((r) => setTimeout(r, 5000));
  console.info(`FC-Tracker: updating the extension (${reason})`);
  chrome.runtime.reload();
}

/** A sync for FC-Tracker Web or the app is running right now. */
async function syncRunning() {
  if (await webSyncing()) return true;
  try {
    return (await call("/ping")).sync_active === true;
  } catch {
    return false; // the app isn't running
  }
}

// Chrome downloaded a new version: use it now (instant), not at the next browser start.
chrome.runtime.onUpdateAvailable.addListener(() => applyUpdate("store"));

async function checkIn() {
  try {
    const res = await call("/ping");
    if (LOCALES.includes(res.locale)) await chrome.storage.local.set({ locale: res.locale });
    await rememberAppState(res);
    await rememberLatest(res);
    await showPairingHint(!res.authorized);
    if (res.authorized) await flush();
    else await retryPush();
    return res;
  } catch {
    await showPairingHint(!(await token()));
    await retryPush(); // app not running: a sync waiting for the account goes now
    return null;
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
