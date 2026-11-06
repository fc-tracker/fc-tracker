// Isolated content script: bridges hook.js (page) ↔ background (app) and shows a small status badge.
(() => {
  const SOURCE = "fc-tracker-hook";
  const COMMAND_SOURCE = "fc-tracker-relay";
  const msg = fctI18n.t;
  const send = (message) =>
    new Promise((resolve) =>
      chrome.runtime.sendMessage(message, (res) => resolve(chrome.runtime.lastError ? null : res)),
    );

  let syncActive = false;
  let syncing = false;
  // Opening the Web App syncs by itself – but not again within this time (reloads, tabs).
  const AUTO_SYNC_AFTER_MS = 15 * 60 * 1000;
  let items = 0;
  let badge = null;
  // The FC-Tracker app answers. If not, the sync is saved for it – and the badge offers to open
  // it (fctracker://, registered by the app): with the app open, everything goes straight in.
  let appUp = true;
  let done = false;
  // Sign-in state reported by hook.js: a sync only starts with an active Web App session.
  let loginState = null;
  let pendingStart = false;
  let blockedSent = false;
  // The app was never seen on this PC (extension installed first): offer to get it instead of opening it.
  let appSeen = true;
  // The three sync lanes (club · Gallery · SBCs and the rest), shown together on one line.
  const lanes = { club: 0, gDone: 0, gTotal: 0, xDone: 0, xTotal: 0 };

  // Who gets a sync (background `owner()`): "app", "account" or null – null = no sync, sign in first.
  let owner = null;
  let theme = "glass";
  let parts = null;

  // The badge: a v2 lower-third in its own closed shadow root, styled from a string
  // (badge-style.js) – nothing of ours is loaded into or fetchable by EA's page outside the host.
  function ensureBadge() {
    if (badge || !document.body) return badge;
    badge = document.createElement("fc-tracker-badge");
    badge.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;display:block;max-width:min(560px,calc(100vw - 32px))";
    const root = badge.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = fctBadgeCss;
    const wrap = document.createElement("div");
    wrap.className = "fct";
    wrap.dataset.theme = theme;
    const toast = document.createElement("div");
    toast.className = "toast ring";
    toast.setAttribute("role", "status");
    const edge = document.createElement("i");
    edge.className = "edge";
    const body = document.createElement("div");
    body.className = "body";
    const eyebrow = document.createElement("span");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "FC-Tracker";
    const text = document.createElement("span");
    text.className = "text";
    body.append(eyebrow, text);
    const acts = document.createElement("div");
    acts.className = "acts";
    const btn = document.createElement("button");
    btn.className = "btn btn-primary btn-s";
    btn.onclick = () => (owner ? requestSync() : send({ type: "open-popup" }));
    const open = document.createElement("a");
    open.className = "btn btn-secondary btn-s ring";
    open.href = "fctracker://open";
    open.onclick = (e) => {
      if (!appSeen) {
        e.preventDefault();
        window.open("https://www.fc-tracker.com/download", "_blank", "noopener");
        return;
      }
      waitForApp();
    };
    acts.append(btn, open);
    const bar = document.createElement("div");
    bar.className = "busy";
    toast.append(edge, body, acts, bar);
    wrap.append(toast);
    root.append(style, wrap);
    parts = { wrap, toast, text, btn, open, bar };
    requestAnimationFrame(() => wrap.classList.add("ready"));
    document.body.appendChild(badge);
    return badge;
  }

  /**
   * One line of status. The eyebrow already says FC-Tracker, so a leading "FC-Tracker:" in the
   * (older) texts is dropped. Edge: amber = the user has to act, mint = done, red = working.
   */
  function render(text, showButton = !done, urgent = false) {
    if (!ensureBadge()) return;
    const rest = String(text).replace(/^FC-Tracker\s*[:–-]\s*/, "");
    const line = rest.charAt(0).toLocaleUpperCase() + rest.slice(1);
    const ok = !urgent && line.includes("✓");
    parts.wrap.dataset.theme = theme;
    parts.text.textContent = line;
    parts.text.classList.toggle("urgent", urgent);
    parts.toast.className = `toast ring ${urgent ? "warn" : ok ? "done" : ""}`;
    // working = no buttons and no result yet: the busy bar shows it moving
    parts.bar.hidden = urgent || ok || showButton || !syncing;
    parts.btn.textContent = msg(owner ? "syncNow" : "badgeSignInBtn");
    parts.btn.style.display = showButton || !owner ? "" : "none";
    // the app is closed: offer to open it – not when the account gets the sync (no app needed)
    parts.open.style.display = appUp || owner === "account" ? "none" : "";
    parts.open.textContent = msg(appSeen ? "openApp" : "getApp");
  }

  // After "Open FC-Tracker": watch for the app (the background then delivers what was saved).
  let appWatch = null;
  function waitForApp() {
    clearInterval(appWatch);
    let tries = 0;
    appWatch = setInterval(async () => {
      const res = await send({ type: "ping" });
      if (res?.app === "fc-tracker" || ++tries > 30) {
        clearInterval(appWatch);
        // it didn't start (not installed on this PC any more?): offer the download
        if (res?.app !== "fc-tracker") {
          appSeen = false;
          if (!syncing) render(msg("openFailed"), false, true);
          return;
        }
        appUp = true;
        if (!syncing) render(msg("badgeDelivered"), false);
      }
    }, 2000);
  }

  function whenBody(fn) {
    document.body ? fn() : document.addEventListener("DOMContentLoaded", fn, { once: true });
  }

  // While a sync runs, ask the app every 1.5 s whether the game entered Ultimate Team; if so
  // the Web App must let go of the session at once (the background closes this tab).
  let abortWatch = null;
  function watchForAbort() {
    clearInterval(abortWatch);
    abortWatch = setInterval(async () => {
      const res = await send({ type: "ping" });
      if (res?.abort) {
        clearInterval(abortWatch);
        render(msg("badgeAborted"), false);
        send({ type: "abortSync" });
      }
    }, 1500);
  }

  // The Web App never says "signed in" or "signed out" (EA maintenance, a page stuck loading, a
  // Login label in another language): after this long the user is told instead of waiting forever.
  const LOGIN_WAIT_MS = 120_000;
  let loginTimer = null;

  /** Starts the sync once the Web App is signed in – never without a session. */
  function requestSync() {
    // nobody to receive it (no app paired, not signed in): no sync – ask for the sign-in instead
    if (!owner) return noOwner();
    if (loginState === "signed_in") return startClubSync();
    pendingStart = true;
    clearTimeout(loginTimer);
    loginTimer = setTimeout(() => {
      if (pendingStart && loginState !== "signed_in") signInNeeded("webapp_not_ready");
    }, LOGIN_WAIT_MS);
    render(msg(loginState === "signed_out" ? "badgeSignIn" : "badgeWaiting"), false, loginState === "signed_out");
    window.postMessage({ source: COMMAND_SOURCE, cmd: "watchLogin" }, window.location.origin);
  }

  /** Not signed in: say so here and on top of the game (the app) – once per page. */
  function signInNeeded(reason) {
    syncing = false;
    clearInterval(abortWatch);
    pendingStart = true;
    render(msg(reason === "webapp_not_ready" ? "badgeNotReady" : "badgeSignIn"), false, true);
    if (!blockedSent) {
      blockedSent = true;
      send({ type: "syncBlocked", reason });
    }
    window.postMessage({ source: COMMAND_SOURCE, cmd: "watchLogin" }, window.location.origin);
  }

  async function startClubSync() {
    done = false;
    items = 0;
    watchForAbort();
    render(msg("badgeWaiting"), false);
    // A new sync: an older one saved while the app was closed is replaced by it.
    await send({ type: "syncStart" });
    // Which Gallery sets to read comes from the app (gallery-sets.json).
    const res = await send({ type: "gallerySets" });
    const gallerySets = Array.isArray(res?.sets) ? res.sets : [];
    syncing = true;
    Object.assign(lanes, { club: 0, gDone: 0, gTotal: gallerySets.length, xDone: 0, xTotal: 0 });
    window.postMessage({ source: COMMAND_SOURCE, cmd: "syncClub", gallerySets }, window.location.origin);
  }

  async function finish(nameless = 0) {
    clearInterval(abortWatch);
    done = true;
    syncing = false;
    render(msg(owner === "account" ? "badgePushing" : "badgeSending"), false);
    syncing = true; // the busy bar stays while it is sent
    const res = await send({ type: "done", closeTab: syncActive });
    syncing = false;
    // Signed in without the app: the server merged it into the account (or it is sent again soon)
    if (res?.account) {
      if (res.pushed) {
        if (nameless >= 3) return render(msg("badgeNamesMissing", [String(nameless)]), true);
        return render(res.collected != null ? msg("badgePushed", [String(res.collected)]) : msg("badgePushedPlain"), false);
      }
      if (res.error === "signed_out") {
        owner = null;
        return render(msg("badgeSignedOut"), false, true);
      }
      return render(msg("badgePushFailed"), false, true);
    }
    // App closed: the sync is saved in the extension and delivered when the app runs.
    if (res?.queued) return render(msg("badgeSaved"), false);
    // No app, FC-Tracker Web: the page picks it up by itself
    // the Web App didn't load EA's player names (often: a second Web App tab): say how to fix it
    if (res?.ok && nameless >= 3) return render(msg("badgeNamesMissing", [String(nameless)]), true);
    if (res?.web) return render(msg("badgeWebSynced"), false);
    render(res?.ok ? msg("badgeSynced", [String(res.players ?? items)]) : msg("badgeNoApp"), !res?.ok);
  }

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window || ev.data?.source !== SOURCE) return;
    const data = ev.data;
    switch (data.kind) {
      case "capture": {
        const res = await send({ type: "capture", url: data.url, body: data.body });
        if (res?.queued && appUp) {
          appUp = false; // the app went away mid-sync: offer to open it
          render(msg("badgeAppClosed"), false);
        }
        // Saved for later (app closed) counts as fine; only "never paired" is a problem.
        if (!res?.ok) return syncing ? render(msg("badgeNoApp")) : undefined;
        items += res.items ?? 0;
        return;
      }
      case "progress": {
        if (data.phase === "waiting") return render(msg("badgeWaiting"), false);
        if (data.phase === "club") lanes.club = data.count ?? lanes.club;
        if (data.phase === "gallery") Object.assign(lanes, { gDone: data.done + 1, gTotal: data.total });
        if (data.phase === "extras") Object.assign(lanes, { xDone: data.done + 1, xTotal: data.total });
        const read = [msg("laneClub", [String(lanes.club)])];
        if (lanes.gTotal) read.push(msg("laneGallery", [String(Math.min(lanes.gDone, lanes.gTotal)), String(lanes.gTotal)]));
        if (lanes.xTotal) read.push(msg("laneExtras", [String(Math.min(lanes.xDone, lanes.xTotal)), String(lanes.xTotal)]));
        return render(read.join(" · "), false);
      }
      case "login":
        loginState = data.state;
        if (data.state === "signed_out" && pendingStart) return signInNeeded("not_signed_in");
        if (data.state === "signed_in" && pendingStart) {
          pendingStart = false;
          clearTimeout(loginTimer);
          blockedSent = false;
          return startClubSync();
        }
        return;
      case "syncComplete":
        return finish(data.nameless ?? 0);
      case "syncError":
        syncing = false;
        send({ type: "syncFailed" }); // FC-Tracker Web stops showing "syncing"
        // No session (or the club never loaded): the user has to act – sign in.
        if (data.error === "not_signed_in" || data.error === "webapp_not_ready") return signInNeeded(data.error);
        return render(msg("badgeError", [data.error]));
    }
  });

  // On load: check the app, then sync by itself – no click needed:
  // - the launcher started a sync (Sync & launch, Sync only, after playing) → sync, close the tab;
  // - the user opened the Web App → sync once (not again within 15 minutes), tab stays open;
  // - the app isn't running → the same, and the extension saves it for the app.
  // The ping also tells the background the app's language, so load translations after it.
  // - nobody owns the sync (no app paired, not signed in) → no sync; the badge offers the sign-in
  //   and the sync starts by itself once the user signed in or connected the app.
  /** No owner: the sign-in (popup) instead of a sync. Text says whether the app runs here. */
  function noOwner() {
    pendingStart = false;
    render(msg(appUp ? "badgeNotPaired" : "badgeNoOwner"), false, true);
  }

  /** Who owns the sync now, from the background's status (and the theme to draw in). */
  function takeStatus(res, status) {
    appUp = !!(res && res.app === "fc-tracker");
    appSeen = appUp || !!status?.appSeen;
    theme = status?.theme ?? "glass";
    // a saved pairing the running app doesn't accept any more is no owner
    const paired = !!status?.paired && (!appUp || !!res.authorized);
    owner = paired ? "app" : status?.email ? "account" : null;
  }

  function startIfDue(res, status) {
    syncActive = appUp && !!res?.authorized && !!res.sync_active;
    const lastSync = Math.max(Number(status?.lastSyncAt ?? 0), Number((appUp && res?.authorized && res.synced_at) || 0));
    if (syncActive || Date.now() - lastSync > AUTO_SYNC_AFTER_MS) return requestSync();
    if (owner === "account") return render(status?.pushPending ? msg("badgePushFailed") : msg("badgeReady"), true, !!status?.pushPending);
    render(appUp ? msg("badgeReady") : status?.saved ? msg("badgeSaved") : msg("badgeReady"));
  }

  Promise.all([send({ type: "ping" }), send({ type: "status" })]).then(async ([res, status]) => {
    await fctI18n.load();
    whenBody(() => {
      takeStatus(res, status);
      if (!owner) return noOwner();
      if (owner === "app" && !appUp) render(msg("badgeAppClosed"), false);
      startIfDue(res, status);
    });
  });

  // Signed in (popup) or connected to the app while this page is open: the sync starts by itself.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !(changes.acct || changes.token || changes.theme)) return;
    const [res, status] = await Promise.all([send({ type: "ping" }), send({ type: "status" })]);
    const had = owner;
    takeStatus(res, status);
    if (syncing || pendingStart) return;
    if (!owner) return noOwner();
    if (!had) return startIfDue(res, status);
    if (changes.theme && parts) parts.wrap.dataset.theme = theme;
  });
})();
