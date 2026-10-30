// Runs in the Web App's own context (MAIN world).
// Two modes:
// 1. Passive: listens to responses the Web App fetches itself (used to map endpoints).
// 2. Active club sync: on command from relay.js, pages through the club using the Web App's
//    own services (services.Club.search) – the same calls the Club screen makes – and reads the
//    Gallery card list per league set (services.Item.searchConceptItems), and opens the rest of
//    the Web App's screens the same way (SBCs, objectives, season pass, Champions / Rivals / Squad
//    Battles, leaderboards, evolutions, squads, store) – read only. Three calm lanes side by side,
//    each about a request a second, to keep the load on EA's servers low.
// The transfer market is never searched, and nothing is bought, sold or listed. Prices come only
// from EA's own `marketAverage` in the club items and from market searches the user does.
// Never reads or forwards EA's session token; only item data leaves the page.
(() => {
  const SOURCE = "fc-tracker-hook";
  const COMMAND_SOURCE = "fc-tracker-relay";
  // Ultimate Team (/ut/game/) and the FC-wide season pass / objectives (/fc/user, /fc/season)
  const UT_PATH = /\/ut\/game\/|\/fc\/(user|season)\b/;
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
    if (TEXT_PATHS.test(url)) postTexts(body);
  }

  // EA sends SBC / objective / event names as text keys ("FC27_S1_OWW_COMP_GROUP"); the Web App
  // shows them through its own localisation – we send the shown text along (fct://webapp/texts).
  const TEXT_PATHS = /\/(sbs|scmp|champs2|rivals|sqbt|academy|fc\/user|fc\/season)\//;
  const TEXT_KEYS = new Set(["title", "subtitle", "name", "description", "featuredTitle", "featuredSubTitle", "header"]);
  const knownTexts = new Set();
  function postTexts(body) {
    const texts = {};
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== "object") return;
      for (const [k, x] of Object.entries(v)) {
        if (typeof x === "string" && TEXT_KEYS.has(k) && /^[A-Z][A-Z0-9_.]{5,}$/.test(x) && !knownTexts.has(x)) {
          knownTexts.add(x);
          try {
            const shown = window.services?.Localization?.localize?.(x);
            if (typeof shown === "string" && shown && shown !== x && !shown.startsWith("*")) texts[x] = shown;
          } catch {}
        } else if (x && typeof x === "object") walk(x);
      }
    };
    walk(body);
    if (Object.keys(texts).length) post({ kind: "capture", url: "fct://webapp/texts", body: { texts } });
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
      // games, goals, cards … (a manager: games, wins, draws, losses, clean sheets)
      lifetimeStats: Array.isArray(e._lifetimeStats) ? e._lifetimeStats : Array.isArray(e.lifetimeStats) ? e.lifetimeStats : undefined,
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
    const players = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = page === 0 ? await firstClubPage() : await observe(window.services.Club.search(newCriteria(offset)));
      const items = result?.response?.items ?? [];
      if (!result?.success && items.length === 0) break;
      const fresh = items.filter((e) => e && e.id && !seen.has(e.id));
      fresh.forEach((e) => seen.add(e.id));
      players.push(...fresh);
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

    try {
      await syncAttributes(players);
    } catch {}
    return total;
  }

  // ---------- in-game attributes (Objective squads' rating, SQUADS.md B) ----------
  // The player bio's own call (services.PlayerMetaData → /attributes/metadata) for the club's
  // players, in batches like a person opening bios, 0.9 s apart; the Web App keeps them, so a
  // later sync only asks for new cards. Sent with the Web App's own names for the attributes and
  // PlayStyles (its enums), so the app never guesses an order.
  const META_BATCH = 30;

  function enumNames(e) {
    const out = {};
    for (const [k, v] of Object.entries(e ?? {})) if (typeof v === "number") out[v] = k;
    return out;
  }

  async function syncAttributes(entities) {
    const meta = window.services?.PlayerMetaData;
    const repo = window.repositories?.PlayerMeta;
    if (!meta?.updateItemPlayerMeta || !repo?.get) return;
    const players = entities.filter((e) => e && e.definitionId && (typeof e.isPlayer !== "function" || e.isPlayer()));
    for (let i = 0; i < players.length && !stopped; i += META_BATCH) {
      try {
        await observe(meta.updateItemPlayerMeta(players.slice(i, i + META_BATCH)), 20_000);
      } catch {}
      await sleep(PAGE_DELAY_MS);
    }
    const cards = {};
    for (const e of players) {
      try {
        const m = repo.get(e.definitionId);
        if (m && m.a) cards[e.definitionId] = { a: m.a, h: m.h ?? null };
      } catch {}
    }
    if (Object.keys(cards).length) {
      post({ kind: "capture", url: "fct://webapp/attributes", body: { names: enumNames(window.ItemSubAttribute), traits: enumNames(window.PlayerTrait), cards } });
    }
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

  let stopped = false;

  async function syncGallery(sets) {
    for (let i = 0; i < sets.length && !stopped; i++) {
      post({ kind: "progress", phase: "gallery", done: i, total: sets.length });
      try {
        await syncGallerySet(sets[i]);
      } catch {
        // One failing set should not stop the rest; it is retried on the next sync.
      }
    }
  }

  // ---------- the rest of the Web App: SBCs, objectives, events (read only) ----------
  // The same calls the Web App makes when its screens open (SBC, Objectives, Champions, Rivals,
  // Squad Battles, Leaderboards, Evolutions, Squads, Store). Responses flow through the passive
  // capture above. Most are cached by the Web App itself (then no request is sent at all).
  // Never a claim, submit, purchase or bid.
  const EXTRA_DELAY_MS = 900;
  const MAX_SBC_CHALLENGES = 25; // open SBC sets whose challenges are read per sync (calm)

  async function call(fn) {
    try {
      const obs = fn();
      return obs && typeof obs.observe === "function" ? await observe(obs, 20_000) : null;
    } catch {
      return null;
    } finally {
      await sleep(EXTRA_DELAY_MS);
    }
  }

  async function syncExtras() {
    const s = window.services ?? {};
    const steps = [
      () => s.SBC?.requestSets?.(),
      () => s.Objectives?.requestCategories?.(),
      () => s.Objectives?.requestCampaignDetails?.(),
      () => s.Objectives?.requestMetaObjectiveGroups?.(),
      () => s.Objectives?.requestTokenInventory?.(),
      () => s.Champions?.requestChampsHub?.(),
      () => s.Champions?.checkOutstandingRewards?.(),
      () => s.Rivals?.getEvent?.(),
      () => s.Rivals?.getWeeklyRewardsInfo?.(),
      () => s.SquadBattles?.requestCurrentEventFullScope?.(),
      () => s.Leaderboards?.requestOptions?.(),
      () => s.Academy?.requestAcademyHub?.(),
      () => s.Squad?.requestSquadList?.(),
      () => s.Club?.getStats?.(),
      () => s.EventToken?.requestDefinitions?.(),
      () => s.Store?.getPacks?.(),
    ];
    let sbcSets = [];
    for (let i = 0; i < steps.length && !stopped; i++) {
      post({ kind: "progress", phase: "extras", done: i, total: steps.length });
      const res = await call(steps[i]);
      if (i === 0) sbcSets = res?.data?.sets ?? res?.response?.sets ?? [];
    }
    // SBC challenges (requirements + rewards) of open sets, most rewarding first: players, then the rest
    const open = (Array.isArray(sbcSets) ? sbcSets : []).filter((set) => {
      try {
        if (typeof set.isComplete === "function" && set.isComplete()) return false;
        if (typeof set.isExpired === "function" && set.isExpired()) return false;
        return typeof s.SBC?.requestChallengesForSet === "function";
      } catch {
        return false;
      }
    });
    for (const set of open.slice(0, MAX_SBC_CHALLENGES)) {
      if (stopped) break;
      await call(() => s.SBC.requestChallengesForSet(set));
    }
    try {
      await syncObjectiveSquads();
    } catch {}
  }

  // ---------- Objective squads (SQUADS.md): objectives, names, formations (read only) ----------
  // The objectives of the open objective groups (what the Objectives screen loads when a group is
  // opened), with their texts as the Web App shows them; the league / club / nation names of the
  // user's language (the Web App's own localisation, no request); and the game's formations.
  const MAX_OBJECTIVE_GROUPS = 15;

  function shown(key) {
    if (typeof key !== "string" || !key) return "";
    try {
      const v = window.services?.Localization?.localize?.(key);
      if (typeof v === "string" && v && v !== key && !v.startsWith("*")) return v;
    } catch {}
    return key;
  }

  const tryCall = (f) => {
    try {
      const v = f();
      return typeof v === "string" && v && !v.startsWith("*") ? v : null;
    } catch {
      return null;
    }
  };

  function readNames() {
    const tc = window.repositories?.TeamConfig;
    const L = window.UTLocalizationUtil;
    const loc = window.services?.Localization;
    const year = window.APP_YEAR ?? 2027;
    const list = (f) => {
      try {
        const v = f();
        return Array.isArray(v) ? v : v ? Array.from(v) : [];
      } catch {
        return [];
      }
    };
    const leagues = {};
    for (const l of list(() => tc.getLeagues())) {
      const id = l?.id ?? l?.leagueId;
      if (id == null) continue;
      leagues[id] = [tryCall(() => loc.localize(`global.leagueFull.${year}.league${id}`)), tryCall(() => L.leagueIdToName(id, loc)), tryCall(() => L.leagueIdToAbbr5(id, loc))].filter(Boolean);
    }
    const nations = {};
    for (const n of list(() => tc.getNations())) {
      const id = n?.id ?? n?.nationId;
      const name = id != null && tryCall(() => L.nationIdToName(id, loc));
      if (name) nations[id] = name;
    }
    const teams = {};
    for (const t of list(() => tc.getTeams())) {
      const id = t?.id ?? t?.teamId;
      if (id == null) continue;
      const names = [tryCall(() => L.teamIdToAbbr15(id, loc)), tryCall(() => L.teamIdToAbbr3(id, loc))].filter(Boolean);
      if (names.length) teams[id] = { names, league: t.leagueId ?? t.league?.id ?? (typeof t.league === "number" ? t.league : null) };
    }
    // rarity / program names ("Future Stars Academy"): objective texts name programs, cards carry
    // only their rareflag – the Web App's own localisation, under the keys it has used
    const rarities = {};
    const util = L ? Object.getOwnPropertyNames(L).filter((n) => /rar/i.test(n) && typeof L[n] === "function") : [];
    for (let id = 0; id < 256; id++) {
      for (const k of [`item.raretype${id}`, `item.raretype.${id}`, `global.raretype${id}`, `search.cardRarity.${id}`]) {
        const v = tryCall(() => loc.localize(k));
        if (typeof v === "string" && v.trim() && v !== k && !v.startsWith("*") && !v.includes("raretype")) {
          rarities[id] = v.trim();
          break;
        }
      }
      if (rarities[id]) continue;
      for (const n of util) {
        const v = tryCall(() => L[n](id, loc));
        if (typeof v === "string" && v.trim() && !v.startsWith("*")) {
          rarities[id] = v.trim();
          break;
        }
      }
    }
    return { leagues, nations, teams, rarities };
  }

  function readFormations() {
    const sq = window.repositories?.Squad;
    let all = [];
    try {
      all = Array.from(sq?.getFormations?.() ?? []);
    } catch {}
    return all
      .map((f) => ({ name: f?.name, label: f?.displayName, positions: Array.isArray(f?.generalPositions) ? f.generalPositions : null }))
      .filter((f) => f.name && f.positions);
  }

  function objectiveDone(o) {
    for (const m of ["isCompleted", "isComplete", "isRedeemed", "isClaimed"]) {
      try {
        if (typeof o[m] === "function" && o[m]()) return true;
      } catch {}
    }
    return typeof o.progress === "number" && typeof o.multiplier === "number" && o.progress >= o.multiplier;
  }

  async function syncObjectiveSquads() {
    const s = window.services ?? {};
    try {
      const names = readNames();
      if (Object.keys(names.leagues).length || Object.keys(names.teams).length) post({ kind: "capture", url: "fct://webapp/names", body: names });
      const formations = readFormations();
      if (formations.length) post({ kind: "capture", url: "fct://webapp/formations", body: { formations } });
    } catch {}
    const O = s.Objectives;
    if (!O?.requestCategories || stopped) return;
    const res = await call(() => O.requestCategories());
    let cats = res?.response?.categories ?? res?.data?.categories ?? [];
    if (!cats.length) {
      try {
        cats = O.objectivesRepository?.getCategories?.() ?? [];
      } catch {}
    }
    // open event groups (with an end time), soonest first – no milestones, no foundation groups
    const open = [];
    for (const c of cats) {
      let groups = [];
      try {
        groups = Array.from(c.getGroups?.() ?? []);
      } catch {}
      for (const g of groups) {
        try {
          if (g.isMilestone?.() || g.isExpiringMilestone?.() || g.isFoundation?.() || g.isGraduatedAccess?.() || g.hasExpired?.()) continue;
          if (!(g.endTime > 0)) continue;
          open.push({ c, g });
        } catch {}
      }
    }
    open.sort((a, b) => a.g.endTime - b.g.endTime);
    const out = [];
    for (const { c, g } of open.slice(0, MAX_OBJECTIVE_GROUPS)) {
      if (stopped) break;
      if (typeof O.requestGroup === "function") await call(() => O.requestGroup(c, g.compositeId));
      let group = g;
      try {
        group = c.getGroup?.(g.compositeId) ?? g;
      } catch {}
      let objectives = [];
      try {
        objectives = Array.from(group.getObjectives?.() ?? []);
      } catch {}
      out.push({
        id: g.id,
        categoryId: c.id,
        title: shown(g.title ?? g.name),
        description: shown(g.description),
        endTime: g.endTime,
        objectives: objectives.map((o) => ({
          id: o.id,
          name: shown(o.name),
          description: shown(o.description),
          progress: typeof o.progress === "number" ? o.progress : 0,
          target: typeof o.multiplier === "number" ? o.multiplier : 1,
          state: o.state,
          done: objectiveDone(o),
        })),
      });
    }
    if (out.length) post({ kind: "capture", url: "fct://webapp/objectives", body: { groups: out } });
  }

  /**
   * Club, Gallery and the rest run side by side – three calm lanes (each about a request a second,
   * like a person moving between Web App screens), so a sync takes about a third of the time.
   */
  async function syncAll(gallerySets) {
    const sets = Array.isArray(gallerySets) ? gallerySets : [];
    stopped = false;
    // a failing club read (signed out, the club never loads) stops the other lanes too
    const club = syncClub().catch((e) => {
      stopped = true;
      throw e;
    });
    // the Gallery and the rest start once the Web App is signed in and loaded
    await waitForWebApp();
    const [players] = await Promise.all([club, syncGallery(sets), syncExtras().catch(() => {})]);
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
