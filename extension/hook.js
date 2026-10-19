// Runs in the Web App's own context (MAIN world).
// Two modes:
// 1. Passive: listens to responses the Web App fetches itself (used to map endpoints).
// 2. Active club sync: on command from relay.js, pages through the club using the Web App's
//    own services (services.Club.search) – the same calls the Club screen makes – and reads the
//    Gallery card list per league set (services.Item.searchConceptItems). One page at a time,
//    about one a second, to keep the load on EA's servers low.
// The transfer market is never searched, and nothing is bought, sold or listed. Prices come only
// from EA's own `marketAverage` in the club items and from market searches the user does.
// Never reads or forwards EA's session token; only item data leaves the page.
(() => {
  const SOURCE = "fc-tracker-hook";
  const COMMAND_SOURCE = "fc-tracker-relay";
  const UT_PATH = /\/ut\/game\//;
  // Login/auth responses may contain session ids and are never forwarded.
  const BLOCKED = /\/(auth|login|token|connect)\b/i;
  const SECRET_KEYS = /^(sid|token|authcode|access_token|refresh_token|phishingtoken)$/i;

  const PAGE_SIZE = 90;
  const PAGE_DELAY_MS = 900; // about one page a second – a light load on EA's servers
  const MAX_PAGES = 40; // safety cap: 40 × 90 = 3,600 players
  const READY_TIMEOUT_MS = 180_000; // user may need to sign in first
  const FIRST_PAGE_ATTEMPTS = 20; // × 3 s = up to 1 minute for the club to load
  const FIRST_PAGE_RETRY_MS = 3000;

  const post = (data) => window.postMessage({ source: SOURCE, ...data }, window.location.origin);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- passive capture ----------

  const shouldCapture = (url) => UT_PATH.test(url) && !BLOCKED.test(url);

  function scrub(value) {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (!SECRET_KEYS.test(k)) out[k] = scrub(v);
      }
      return out;
    }
    return value;
  }

  function emit(url, status, text) {
    if (status < 200 || status >= 300 || !text) return;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return;
    }
    post({ kind: "capture", url: url.split("?")[0], body: scrub(body) });
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.call(this, input, init);
    try {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      if (shouldCapture(url)) res.clone().text().then((t) => emit(url, res.status, t)).catch(() => {});
    } catch {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__fctUrl = String(url);
    return origOpen.call(this, method, url, ...rest);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__fctUrl && shouldCapture(this.__fctUrl)) {
      this.addEventListener("load", () => {
        try {
          const text =
            this.responseType === "" || this.responseType === "text" ? this.responseText : JSON.stringify(this.response);
          emit(this.responseURL || this.__fctUrl, this.status, text);
        } catch {}
      });
    }
    return origSend.apply(this, args);
  };

  // ---------- active club sync (Web App services) ----------

  function webAppReady() {
    try {
      return !!(
        window.services?.Club?.search &&
        window.services?.User?.getUser?.() &&
        window.UTSearchCriteriaDTO &&
        window.SearchType
      );
    } catch {
      return false;
    }
  }

  // ---------- sign-in state (read from the page, never from cookies or tokens) ----------

  // The Login button of the Web App's start screen, in the languages the Web App offers.
  const LOGIN_WORDS = /^(login|log in|sign in|log ind|log på|anmelden|einloggen|iniciar sesión|connexion|se connecter|accedi|entrar|zaloguj)$/i;

  function loginScreenShown() {
    try {
      if (document.querySelector(".ut-login, .ut-login-content")) return true;
      return Array.from(document.querySelectorAll("button, a")).some(
        (el) => LOGIN_WORDS.test((el.textContent || "").trim()) && el.offsetParent !== null,
      );
    } catch {
      return false;
    }
  }

  /** "signed_in" (the club can be read), "signed_out" (the start screen asks to log in) or "loading". */
  function loginState() {
    if (webAppReady()) return "signed_in";
    return loginScreenShown() ? "signed_out" : "loading";
  }

  // Reports the state to relay.js whenever it changes, until signed in. Cheap: one DOM look a second.
  let loginWatch = null;
  function watchLogin() {
    if (loginWatch) return;
    let last = null;
    let outFor = 0;
    loginWatch = setInterval(() => {
      let state = loginState();
      // The start screen flashes by while a signed-in session loads: only call it signed out
      // when it stays for 3 s.
      outFor = state === "signed_out" ? outFor + 1 : 0;
      if (state === "signed_out" && outFor < 3) state = "loading";
      if (state !== last) {
        last = state;
        post({ kind: "login", state });
      }
      if (state === "signed_in") {
        clearInterval(loginWatch);
        loginWatch = null;
      }
    }, 1000);
  }

  async function waitForWebApp() {
    const start = Date.now();
    let outFor = 0;
    while (!webAppReady()) {
      // Signed out (the start screen with Login stays): never sync without a session.
      outFor = loginScreenShown() ? outFor + 1 : 0;
      if (outFor >= 3) throw new Error("not_signed_in");
      if (Date.now() - start > READY_TIMEOUT_MS) throw new Error("webapp_not_ready");
      await sleep(1000);
    }
  }

  /** Wraps the Web App's observable pattern (`obs.observe(ctx, (obs, result) => …)`) in a promise. */
  function observe(observable, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      if (!observable || typeof observable.observe !== "function") return reject(new Error("no_observable"));
      const ctx = {};
      const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      observable.observe(ctx, (obs, result) => {
        clearTimeout(timer);
        try {
          obs.unobserve(ctx);
        } catch {}
        resolve(result);
      });
    });
  }

  function staticData(e) {
    try {
      return (typeof e.getStaticData === "function" ? e.getStaticData() : e._staticData) || {};
    } catch {
      return {};
    }
  }

  // FUT position ids (entity.preferredPosition is numeric; verified 2026-10-12).
  const POSITIONS = [
    "GK", "SW", "RWB", "RB", "RCB", "CB", "LCB", "LB", "LWB", "RDM", "CDM", "LDM", "RM", "RCM",
    "CM", "LCM", "LM", "RAM", "CAM", "LAM", "RF", "CF", "LF", "RW", "RS", "ST", "LS", "LW",
  ];

  function positionName(p) {
    if (typeof p === "string") return p;
    return typeof p === "number" ? POSITIONS[p] ?? String(p) : null;
  }

  /** Converts a Web App item entity to plain JSON in the shape store.rs understands. */
  function toPlain(e) {
    const s = staticData(e);
    return {
      id: e.id,
      assetId: e.definitionId,
      rating: e.rating,
      preferredPosition: positionName(e.preferredPosition),
      itemType: typeof e.isPlayer === "function" ? (e.isPlayer() ? "player" : e.type) : e.type,
      untradeable: typeof e.tradable === "boolean" ? !e.tradable : null,
      rareflag: e.rareflag,
      gradingScore: e.gradingScore ?? e._gradingScore ?? null,
      // Number of owners; 1 = the user is the first owner (Gallery "First Owner" bonus).
      owners: typeof e.owners === "number" ? e.owners : null,
      leagueId: e.leagueId,
      teamId: e.teamId,
      nationId: e.nationId,
      name: s.name,
      firstName: s.firstName,
      lastName: s.lastName,
    };
  }

  function newCriteria(offset) {
    const criteria = new window.UTSearchCriteriaDTO();
    criteria.type = window.SearchType.PLAYER;
    criteria.count = PAGE_SIZE;
    criteria.offset = offset;
    return criteria;
  }

  /**
   * The Web App's services exist before the club is loaded after sign-in, so the first search
   * can fail or come back empty. Retry calmly until the club answers with players.
   */
  async function firstClubPage() {
    for (let attempt = 0; attempt < FIRST_PAGE_ATTEMPTS; attempt++) {
      try {
        const result = await observe(window.services.Club.search(newCriteria(0)));
        const items = result?.response?.items ?? [];
        if (items.some((e) => e && e.id)) return result;
      } catch {}
      post({ kind: "progress", phase: "waiting" });
      await sleep(FIRST_PAGE_RETRY_MS);
    }
    throw new Error("club_search_failed");
  }

  async function syncClub() {
    post({ kind: "progress", phase: "waiting" });
    await waitForWebApp();

    // The Web App caches the club client-side and may return the whole club regardless of
    // offset (verified 2026-10-12: 175 players returned for every offset). So we stop as soon
    // as a page brings no new ids, or when the page is short.
    const seen = new Set();
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = page === 0 ? await firstClubPage() : await observe(window.services.Club.search(newCriteria(offset)));
      const items = result?.response?.items ?? [];
      if (!result?.success && items.length === 0) break;
      const fresh = items.filter((e) => e && e.id && !seen.has(e.id));
      fresh.forEach((e) => seen.add(e.id));
      if (fresh.length === 0) break;      post({ kind: "capture", url: "fct://club/players", body: { itemData: fresh.map(toPlain) } });
      post({ kind: "progress", phase: "club", count: seen.size });
      if (items.length < PAGE_SIZE) break;
      offset += items.length;
      await sleep(PAGE_DELAY_MS);
    }
    const total = seen.size;

    // New pack items waiting in Unassigned also count as owned.
    try {
      if (window.services?.Item?.requestUnassignedItems) {
        await sleep(PAGE_DELAY_MS);
        const result = await observe(window.services.Item.requestUnassignedItems());
        const items = result?.response?.items ?? [];
        if (items.length) post({ kind: "capture", url: "fct://club/unassigned", body: { itemData: items.map(toPlain) } });
      }
    } catch {}

    return total;
  }

  // ---------- Gallery: card database per set (concept search) ----------

  function searchConcept(filter, offset) {
    const criteria = new window.UTSearchCriteriaDTO();
    criteria.type = window.SearchType.PLAYER;
    criteria.count = PAGE_SIZE + 1; // the Web App returns at most 91 per page
    criteria.offset = offset;
    if (filter.league) criteria.league = filter.league;
    if (filter.club) criteria.club = filter.club;
    if (filter.level) criteria.level = filter.level;
    if (filter.rarity != null) criteria.rarities = [filter.rarity];
    return observe(window.services.Item.searchConceptItems(criteria));
  }

  // Team names come from the Web App's own localisation (e.g. 1 and 116009 → "Arsenal").
  const teamNames = new Map();
  function teamName(id) {
    if (!id) return null;
    if (!teamNames.has(id)) {
      let name = null;
      try {
        const v = window.services.Localization.localize(`global.teamabbr15.2027.team${id}`);
        if (typeof v === "string" && !v.startsWith("*")) name = v;
      } catch {}
      teamNames.set(id, name);
    }
    return teamNames.get(id);
  }

  function toGalleryCard(e) {
    const s = staticData(e);
    return {
      teamName: teamName(e.teamId),
      definitionId: e.definitionId,
      gradingScore: e.gradingScore ?? 0,
      isCollected: e.isCollected === true,
      rating: e.rating,
      rareflag: e.rareflag,
      leagueId: e.leagueId,
      teamId: e.teamId,
      nationId: e.nationId,
      name: s.name,
      preferredPosition: positionName(e.preferredPosition),
      weakFoot: e._weakFoot ?? null,
      skillMoves: e._skillMoves ?? null,
    };
  }

  /**
   * Pages through one set. `endOfList` is unreliable (true after the first page – verified
   * 2026-10-12), so we stop on an empty page or when a page brings nothing new.
   */
  async function syncGallerySet(set) {
    const seen = new Set();
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await searchConcept(set.filter, offset);
      const items = result?.response?.items ?? [];
      const fresh = items.filter((e) => e && e.definitionId && !seen.has(e.definitionId));
      if (fresh.length === 0) break;
      fresh.forEach((e) => seen.add(e.definitionId));
      post({ kind: "capture", url: `fct://gallery/${set.key}`, body: { cards: fresh.map(toGalleryCard) } });
      offset += items.length;
      await sleep(PAGE_DELAY_MS);
    }
    return seen.size;
  }

  async function syncAll(gallerySets) {
    const players = await syncClub();
    const sets = Array.isArray(gallerySets) ? gallerySets : [];
    for (let i = 0; i < sets.length; i++) {
      post({ kind: "progress", phase: "gallery", done: i, total: sets.length });
      try {
        await syncGallerySet(sets[i]);
      } catch {
        // One failing set should not stop the rest; it is retried on the next sync.
      }
    }
    post({ kind: "syncComplete", count: players });
  }

  let running = false;
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.data?.source !== COMMAND_SOURCE) return;
    if (ev.data.cmd === "watchLogin") return watchLogin();
    if (ev.data.cmd !== "syncClub" || running) return;
    running = true;
    syncAll(ev.data.gallerySets)
      .catch((e) => post({ kind: "syncError", error: String(e?.message ?? e) }))
      .finally(() => (running = false));
  });
})();
