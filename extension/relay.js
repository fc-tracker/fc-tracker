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

  function ensureBadge() {
    if (badge || !document.body) return badge;
    badge = document.createElement("div");
    badge.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#0f1420;color:#e8ecf5;" +
      "border:1px solid #f5c542;border-radius:10px;padding:10px 14px;font:13px 'Segoe UI',sans-serif;" +
      "box-shadow:0 4px 20px rgba(0,0,0,.4);display:flex;gap:12px;align-items:center";
    const text = document.createElement("span");
    const btn = document.createElement("button");
    btn.textContent = msg("syncNow");
    btn.style.cssText =
      "background:#f5c542;color:#1a1a1a;border:0;border-radius:6px;padding:5px 10px;font-weight:600;cursor:pointer";
    btn.onclick = requestSync;
    const open = document.createElement("a");
    open.href = "fctracker://open";
    open.textContent = msg("openApp");
    open.style.cssText =
      "background:#3fe0b8;color:#04130e;border-radius:6px;padding:5px 10px;font-weight:700;text-decoration:none;white-space:nowrap";
    open.onclick = waitForApp;
    badge.append(text, btn, open);
    document.body.appendChild(badge);
    return badge;
  }

  function render(text, showButton = !done, urgent = false) {
    const b = ensureBadge();
    if (!b) return;
    b.children[0].textContent = text;
    b.children[0].style.fontWeight = urgent ? "700" : "";
    b.style.borderColor = urgent ? "#ff6b6b" : "#f5c542";
    b.children[1].style.display = showButton ? "" : "none";
    b.children[2].style.display = appUp ? "none" : "";
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
        if (res?.app !== "fc-tracker") return;
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
    window.postMessage({ source: COMMAND_SOURCE, cmd: "syncClub", gallerySets }, window.location.origin);
  }

  async function finish() {
    clearInterval(abortWatch);
    done = true;
    syncing = false;
    render(msg("badgeSending"), false);
    const res = await send({ type: "done", closeTab: syncActive });
    // App closed: the sync is saved in the extension and delivered when the app runs.
    if (res?.queued) return render(msg("badgeSaved"), false);
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
        const text =
          data.phase === "waiting"
            ? msg("badgeWaiting")
            : data.phase === "gallery"
              ? msg("badgeGallery", [String(data.done + 1), String(data.total)])
              : msg("badgeProgress", [String(data.count)]);
        return render(text, false);
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
        return finish();
      case "syncError":
        syncing = false;
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
  Promise.all([send({ type: "ping" }), send({ type: "status" })]).then(async ([res, status]) => {
    await fctI18n.load();
    whenBody(() => {
      appUp = !!(res && res.app === "fc-tracker");
      if (appUp && !res.authorized) return render(msg("badgeNotPaired"), false);
      if (!appUp && !status?.paired) return render(msg("badgeNoApp"), false);
      if (!appUp) render(msg("badgeAppClosed"), false);
      syncActive = appUp && !!res.sync_active;
      const lastSync = Math.max(Number(status?.lastSyncAt ?? 0), Number((appUp && res.synced_at) || 0));
      if (syncActive || Date.now() - lastSync > AUTO_SYNC_AFTER_MS) return requestSync();
      render(appUp ? msg("badgeReady") : status?.saved ? msg("badgeSaved") : msg("badgeReady"));
    });
  });
})();
