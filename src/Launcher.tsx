// The launcher (brand v2, design/d-draft-2/01-launcher): top bar with the L1/R1 slab (Home · Settings ·
// Help · Account), the FUT-17 tile menu on Home (launcher/Home.tsx) with the status rail beside it, and a
// slim controls strip. Everything the launcher did before still happens here: pairing, sync (and sync +
// launch), every wait named, updates (UpdateRequired.tsx), settings, usage counts.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, events, formatAge, olderThan, syncAllowed, type AfterPlay, type BridgeInfo, type GameSession, type RemindPrefs, type SetupStatus, type SyncSummary } from "./api";
import { LOCALE_NAMES, t, tError, useLocale, type Locale, type MessageKey } from "./i18n";
import Help from "./Help";
import { useTopFit } from "./launcher/topFit";
import { SupportButton } from "./Support";
import Speed from "./Speed";
import { THEMES, useTheme, type Theme } from "./theme";
import { initUsage, onlineNow, setUsageEnabled, startPresence, track, trackOnce, usageEnabled } from "./usage";
import { boardName, NAME_RE, setBoardName, uploadWeekend } from "./championsBoard";
import { startPrices } from "./prices";
import { startGallerySets } from "./gallerySets";
import { Account } from "./AccountSettings";
import { startAccount, useAccount } from "./account";
import { Avatar } from "./OverlayMenu";
import { timeAgo } from "./SyncConflict";
import { afterSync as objectivesAfterSync, startObjectives } from "./objectives";
import SyncConflict from "./SyncConflict";
import { RequiredUpdate, UpdatedNotice, useUpdate } from "./UpdateRequired";
import Home from "./launcher/Home";
import Club from "./launcher/Club";
import Players from "./launcher/Players";
import { useLauncherZoom } from "./launcher/zoom";
import { ZOOM_BASE } from "./zoomBase";
import { Bar, Btn, Chip, Coin, Keycap, Mark, Num, Panel, Segs, Switch, Tabs, fmt } from "./ui";

// Dev only: ?check installs the layout check matrix (window.__launcherMatrix, src/launcher/layoutCheck.ts).
if (import.meta.env.DEV && new URLSearchParams(location.search).has("check")) void import("./launcher/layoutCheck").then((m) => m.installLayoutCheck());

// Usage statistics run in the real app only (the launcher window lives as long as the app does).
const inApp = "__TAURI_INTERNALS__" in window;

// Messages are stored as functions so they re-translate when the language changes.
type Message = { kind: "ok" | "error"; text: () => string } | null;
const ok = (text: () => string): Message => ({ kind: "ok", text });
const fail = (err: unknown): Message => ({ kind: "error", text: () => tError(err) });

const VIEWS = ["home", "club", "players", "settings", "help", "account"] as const;
type View = (typeof VIEWS)[number];
const SETTINGS_TABS = ["general", "speed"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];

export default function Launcher() {
  const [locale, setLocale] = useLocale();
  const [theme, setTheme] = useTheme();
  const [view, setView] = useState<View>("home");
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [bridge, setBridge] = useState<BridgeInfo | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncSummary | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<GameSession>("unknown");
  // the update watcher's news arrives at once (updates.rs) – no reload needed
  const update = useUpdate();
  const [version, setVersion] = useState("");
  // zoom (Ctrl + scroll, Ctrl + / − / 0, Settings): per window, like the overlay
  const [userZoom, setZoom] = useLauncherZoom();
  // the launcher's own room after zoom picks the layout (styles.css "small windows"), not the screen
  const [room, setRoom] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setRoom({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  // fit (user 2026-11-05: "the launcher has the same zoom problem" – at Windows 150 % a 1300 px window got the cramped
  // small-window layout): below 1440 × 900 CSS px the launcher lays out at that size and scales down to fit, to .8 at
  // most; the player's own zoom (Settings, Ctrl + scroll) comes on top
  // the app's own scale (ZOOM_BASE, shown as 100 %) under the player's zoom
  const base = userZoom * ZOOM_BASE;
  const fit = Math.min(1, Math.max(0.8, Math.min(room.w / base / 1440, room.h / base / 900)));
  const zoom = base * fit;
  const roomW = room.w / zoom;
  const roomH = room.h / zoom;
  // the header's coins (from the last club sync) and when the Gallery was last read (status rail)
  const [coins, setCoins] = useState<number | null>(null);
  const [clubCount, setClubCount] = useState<number | null>(null);
  const [galleryAt, setGalleryAt] = useState<number | null>(null);
  useEffect(() => {
    const load = () => {
      api
        .squadsPlan()
        .then((v) => {
          setCoins(v.coins);
          // the club without loan cards (they aren't the user's)
          setClubCount(v.club.filter((c) => c.owned && !c.loan).length || null);
        })
        .catch(() => {});
      api.galleryStatus().then((g) => setGalleryAt(g.summary?.at ?? null)).catch(() => {});
    };
    load();
    const un = [events.onSyncDone(load), events.onGalleryUpdated(load)];
    return () => un.forEach((u) => u.then((f) => f()));
  }, []);
  const [afterPlay, setAfterPlay] = useState<AfterPlay>("remind");
  const [suggested, setSuggested] = useState(false);
  useEffect(() => {
    api.syncSuggested().then(setSuggested).catch(() => {});
    const un = events.onSyncSuggested(setSuggested);
    return () => {
      un.then((u) => u());
    };
  }, []);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [missingSide, setMissingSide] = useState<"left" | "right">("left");
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [usageOn, setUsageOn] = useState(usageEnabled);
  const [champsOn, setChampsOn] = useState<boolean | null>(null);
  const [reminders, setReminders] = useState<RemindPrefs | null>(null);
  const saveReminders = (p: RemindPrefs) => {
    setReminders(p);
    api.setMatchReminders(p).then((u) => u.reminders && setReminders(u.reminders)).catch(() => {});
  };
  const [champsCleared, setChampsCleared] = useState(false);
  const [boardOn, setBoardOn] = useState(() => boardName());
  const [boardDraft, setBoardDraft] = useState(() => boardName() ?? "");
  // Champions leaderboard (opt-in): the weekend record goes up when the hub counts a match
  useEffect(() => {
    api.championsData().then(uploadWeekend).catch(() => {});
    const un = events.onChampions((d) => void uploadWeekend(d));
    return () => {
      un.then((u) => u());
    };
  }, [boardOn]);
  // "N online now" (our own counter) – shown once enough people are online
  const [online, setOnline] = useState<number | null>(null);
  useEffect(() => {
    if (!inApp) return;
    const load = () => onlineNow().then(setOnline);
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    api.autostart().then(setAutostart).catch(() => {});
  }, []);
  // read again on every tab change: the home tiles change the same settings
  useEffect(() => {
    api
      .uiPrefs()
      .then((p) => {
        setAfterPlay(p.after_play);
        setMissingSide(p.missing_side);
        setChampsOn(p.champions === true);
        setReminders(p.reminders ?? { on: true, at: [0, 45], sub_at: 70 });
      })
      .catch(() => {});
  }, [view]);
  // The game was started together with the sync: shown as a step until it runs.
  const launched = useRef(false);

  // The extension follows the app's language.
  useEffect(() => {
    api.setLocale(locale).catch(() => {});
  }, [locale]);

  useEffect(() => {
    api.appVersion().then(setVersion).catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    const [s, r, sum, gs] = await Promise.all([api.setupStatus(), api.gameRunning(), api.syncSummary(), api.gameSession()]);
    setSetup(s);
    setRunning(r);
    setSync(sum);
    setSession(gs);
    try {
      setBridge(await api.bridgeInfo());
      setBridgeError(null);
    } catch (e) {
      setBridgeError(String(e));
    }
  }, []);

  // Anonymous usage counts (src/usage.ts): a start, the first time each step is reached, and
  // "still in use" every two hours while the app runs.
  // the dev preview has no usage counts, but the account (and its ?mock= states) start here too
  useEffect(() => {
    if (!inApp) void startAccount();
  }, []);
  useEffect(() => {
    if (!inApp) return;
    let active: ReturnType<typeof setInterval> | undefined;
    (async () => {
      const v = await api.appVersion().catch(() => "");
      initUsage("app", v);
      // an installation that already had a club or Gallery data before this version
      const existing = await api.galleryStatus().then((g) => g.collected > 0).catch(() => false);
      track(null);
      track("app-start", { existing });
      trackOnce("first-start", { existing });
      active = setInterval(() => track("app-active"), 2 * 60 * 60 * 1000);
      startPresence("app");
      startPrices();
      startGallerySets();
      void startAccount();
      // the shared objectives list: in after every sync, out to everyone (src/objectives.ts)
      startObjectives();
      void events.onSyncDone(() => void objectivesAfterSync());
    })();
    const unlisten = [
      events.onPaired(() => trackOnce("extension-connected")),
      events.onSyncDone((s) => {
        if (s.player_count > 0) trackOnce("first-sync", { players: s.player_count });
        track("sync");
      }),
      events.onPageChanged((p) => {
        if (p.kind === "set" && p.verified) trackOnce("first-set-read");
      }),
    ];
    return () => {
      clearInterval(active);
      unlisten.forEach((p) => p.then((u) => u()));
    };
  }, []);

  useEffect(() => {
    refresh().catch((e) => setMessage(fail(e)));
    const id = setInterval(() => refresh().catch(() => {}), 3000);
    const unlisten = [
      events.onPaired(() => {
        setMessage(ok(() => t("pair.done")));
        refresh().catch(() => {});
      }),
      events.onSyncUpdate(setSync),
      events.onOpenHelp(() => setView("help")),
      events.onGameSession(setSession),
      events.onSyncAborted(() => {
        launched.current = false;
        setMessage({ kind: "error", text: () => t("sync.aborted") });
        refresh().catch(() => {});
      }),
      events.onSyncBlocked((reason) => {
        setMessage({ kind: "error", text: () => t(reason === "no_extension" ? "sync.noExtension" : reason === "webapp_not_ready" ? "sync.notReady" : "sync.notSignedIn") });
      }),
      events.onSyncResumed(() => setMessage(null)),
      events.onSyncDone((s) => {
        launched.current = false;
        setSync(s);
        setMessage(ok(() => t("ln.done", { count: s.player_count })));
      }),
    ];
    return () => {
      clearInterval(id);
      unlisten.forEach((p) => p.then((u) => u()));
    };
  }, [refresh]);

  // The controller in the launcher (it has the focus, not the game): L1/R1 = top tabs, L2/R2 = sub-tabs,
  // D-pad moves the cursor, ✕/A opens, ○/B goes to the tray. Keyboard: Q/E switch the top tabs.
  useEffect(() => {
    const step = (d: 1 | -1) => setView((v) => VIEWS[(VIEWS.indexOf(v) + d + VIEWS.length) % VIEWS.length]);
    const sub = (d: 1 | -1) => setSettingsTab((v) => SETTINGS_TABS[(SETTINGS_TABS.indexOf(v) + d + SETTINGS_TABS.length) % SETTINGS_TABS.length]);
    const move = (d: 1 | -1) => {
      const all = [...document.querySelectorAll<HTMLElement>(".ln-body [data-f], .ln-body button:not(:disabled), .ln-body input, .ln-body select")].filter((e) => e.offsetParent);
      const i = all.indexOf(document.activeElement as HTMLElement);
      all[(i + d + all.length) % all.length]?.focus();
    };
    const act = (a: string) => {
      if (a === "prev_category") step(-1);
      else if (a === "next_category") step(1);
      else if (a === "prev_section") sub(-1);
      else if (a === "next_section") sub(1);
      else if (a === "up" || a === "left") move(-1);
      else if (a === "down" || a === "right") move(1);
      else if (a === "select") (document.activeElement as HTMLElement | null)?.click();
      else if (a === "back") void api.hideLauncher().catch(() => {});
    };
    const un = inApp ? events.onPad(act) : null;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
      if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "q" || e.key === "Q") step(-1);
      else if (e.key === "e" || e.key === "E") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      un?.then((u) => u());
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  async function run(action: () => Promise<unknown>, success?: () => string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      if (success) setMessage(ok(success));
    } catch (e) {
      setMessage(fail(e));
    } finally {
      setBusy(false);
      refresh().catch(() => {});
    }
  }

  function syncAndLaunch() {
    launched.current = true;
    run(api.syncAndLaunch);
  }

  function stopSync() {
    launched.current = false;
    run(api.cancelSync);
  }

  const syncing = sync?.sync_active ?? false;
  // Paired = a token exists and no extension without it is asking to be paired.
  const paired = (bridge?.paired ?? false) && !bridge?.needs_pairing;
  const borderless = !!(setup?.exists && setup.mode === "borderless");
  // With the game open, a sync is fine as long as the user is outside Ultimate Team.
  // "unknown" stays clickable: the app then looks at the game behind the launcher right away.
  const canSync = paired && (!running || syncAllowed(session) || session === "unknown");
  const extOutdated = !!(paired && bridge?.extension_version && olderThan(bridge.extension_version, bridge.extension_latest));
  // older than the app needs: the extension was told to update itself (it reloads within a minute)
  const extRequired = !!(paired && bridge?.extension_version && bridge.extension_required && olderThan(bridge.extension_version, bridge.extension_required));

  const status = (
    <StatusRail
      {...{ bridge, bridgeError, paired, syncing, sync, running, session, setup, borderless, busy, canSync, extOutdated, extRequired, suggested, message }}
      launched={launched.current}
      onSyncAndLaunch={syncAndLaunch}
      onSync={() => run(api.startSync)}
      onStop={stopSync}
      onLaunch={() => run(api.launchGame, () => t("game.launching"))}
      onBorderless={() => run(api.setBorderless, () => t("borderless.done"))}
      onDismissSuggestion={() => api.dismissSyncSuggestion().then(() => setSuggested(false)).catch(() => {})}
      onAccount={() => setView("account")}
      version={version}
      galleryAt={galleryAt}
      clubCount={clubCount}
    />
  );

  // the top bar drops items in a fixed order when they don't fit (launcher/topFit.ts) – never a collision
  const topRef = useRef<HTMLElement>(null);
  useTopFit(topRef, [locale, coins != null, clubCount, version, online, zoom]);

  const viewLabel: Record<View, string> = { home: t("nav.home"), club: t("lh.nav.club"), players: t("players.title"), settings: t("nav.settings"), help: t("nav.help"), account: t("nav.account") };

  return (
    <div
      className="ln"
      data-roomy={roomW >= 1560 ? "" : undefined}
      data-narrow={roomW < 1320 ? "" : undefined}
      data-stack={roomW < 1000 ? "" : undefined}
      data-short={roomH < 820 ? "" : undefined}
      data-tiny={roomH < 700 ? "" : undefined}
      style={zoom !== 1 ? ({ zoom, height: `calc(100vh / ${zoom})` } as React.CSSProperties) : undefined}>
      <SyncConflict />
      <header className="ln-top" ref={topRef}>
        <div className="row ln-brandline">
          <span className="brand ln-brand" aria-label="FC-Tracker">
            <Mark size={32} />
            <span className="ln-brand-word">FC-Tracker</span>
          </span>
          <span className="ln-tagline">{t("brand.tagline")}</span>
        </div>
        {/* the keycaps as a pair around the slab, in the input in use (keyboard: Q / E – the launcher's own keys) */}
        <nav className="row ln-tabnav" aria-label={t("lh.key.section")}>
          <Keycap ps="L1" xb="LB" kb="Q" big />
          <Tabs keys={false} items={VIEWS.map((id) => ({ id, label: viewLabel[id], count: id === "club" && clubCount ? clubCount : undefined }))} active={view} onChange={(id) => setView(id as View)} />
          <Keycap ps="R1" xb="RB" kb="E" big />
        </nav>
        <div className="row ln-top-right">
          {online != null && (
            <span className="t-13 faint ln-online" title={t("online.hint")}>
              {t("online.now", { count: online })}
            </span>
          )}
          <SupportButton />
          {coins != null && (
            <span className="coins ln-coins" title={t("lh.coinsTitle")}>
              <Coin />
              <b className="num">{fmt(coins)}</b>
            </span>
          )}
          {version && <Chip tone="line" className="ln-version">v{version}</Chip>}
        </div>
      </header>

      {/* every update is forced: the popup, no "Later" (UpdateRequired.tsx) */}
      {update && <RequiredUpdate update={update} running={running} />}
      <UpdatedNotice />
      {/* 12: the extension updating itself (the app needs a newer one – Chrome updates it and reloads it) */}
      {extRequired && !update && (
        <div className="fu-l3-dock launcher" role="status">
          <div className="toast ring ln-ext-toast">
            <i className="edge" />
            <div className="col grow">
              <span className="t-15">
                {t("update.ext.updating", { version: bridge?.extension_required ?? "" })}
                {bridge?.extension_version && <span className="faint"> · v{bridge.extension_version}</span>}
              </span>
              <Bar value={0} loading />
            </div>
          </div>
        </div>
      )}

      <main className="ln-body">
        {view === "home" && <Home rail={status} />}

        {view === "account" && (
          <section className="ln-page">
            <h1 className="h1">{t("nav.account")}</h1>
            <Panel className="ln-panel">
              <Account />
            </Panel>
          </section>
        )}

        {view === "club" && <Club />}
        {view === "players" && <Players />}

        {view === "help" && <Help />}

        {view === "settings" && (
          <section className="ln-page">
            <div className="row between ln-page-head">
              <h1 className="h1">{t("nav.settings")}</h1>
              <Segs
                items={SETTINGS_TABS.map((id) => ({ id, label: t(id === "general" ? "settings.general" : "speed.tab") }))}
                active={settingsTab}
                onChange={(id) => setSettingsTab(id as SettingsTab)}
              />
            </div>
            {settingsTab === "speed" && (
              <Panel className="ln-panel">
                <Speed />
              </Panel>
            )}
            {settingsTab === "general" && (
              <Panel className="ln-panel">
                <div className="ln-rows">
                  <Row title={t("overlay.theme")}>
                    <span className="ln-choice" role="group" aria-label={t("overlay.theme")}>
                      {THEMES.map((th) => (
                        <Choice key={th} on={theme === th} onClick={() => setTheme(th as Theme)}>
                          {t(`theme.${th}` as MessageKey)}
                        </Choice>
                      ))}
                    </span>
                  </Row>
                  <Row title={t("overlay.zoom")} text={t("lh.zoomText")}>
                    <span className="ln-choice" role="group" aria-label={t("overlay.zoom")}>
                      <button type="button" className="seg ring" onClick={() => setZoom(-1)} aria-label={t("overlay.zoomOut")} title={t("overlay.zoomOut")}>
                        <span>−</span>
                      </button>
                      <button type="button" className="seg ring ln-zoom-now" onClick={() => setZoom(0)} title={t("overlay.zoomReset")}>
                        <span className="num">{Math.round(userZoom * 100)} %</span>
                      </button>
                      <button type="button" className="seg ring" onClick={() => setZoom(1)} aria-label={t("overlay.zoomIn")} title={t("overlay.zoomIn")}>
                        <span>+</span>
                      </button>
                    </span>
                  </Row>
                  <Row title={t("language")}>
                    <select className="ln-input ln-select" value={locale} aria-label={t("language")} onChange={(e) => setLocale(e.target.value as Locale)}>
                      {Object.entries(LOCALE_NAMES).map(([code, name]) => (
                        <option key={code} value={code}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </Row>
                  <Row title={t("status.extension")} text={`${paired ? t("status.connected") : t("status.notConnected")}${bridge?.extension_version ? ` · v${bridge.extension_version}` : ""}`}>
                    {paired && (
                      <Btn size="s" kind="quiet" onClick={() => run(api.unpair, () => t("footer.unpaired"))}>
                        {t("footer.unpair")}
                      </Btn>
                    )}
                  </Row>
                  <Row title={t("settings.autostart")} text={t("settings.autostartText")}>
                    <Switch on={!!autostart} label={t("settings.autostart")} onChange={(v) => autostart !== null && api.setAutostart(v).then(setAutostart).catch(() => {})} />
                  </Row>
                  <Row title={t("settings.champions")} text={t("settings.championsText")}>
                    <Btn size="s" kind="quiet" disabled={champsCleared} onClick={() => api.clearChampions().then(() => setChampsCleared(true)).catch(() => {})}>
                      {champsCleared ? t("settings.championsCleared") : t("settings.championsClear")}
                    </Btn>
                    <Switch on={!!champsOn} label={t("settings.champions")} onChange={(v) => api.setChampionsTracking(v).then((p) => setChampsOn(p.champions === true)).catch(() => {})} />
                  </Row>
                  <Row title={t("settings.championsBoard")} text={t("settings.championsBoardText")}>
                    {boardOn ? (
                      <>
                        <Chip tone="line">{boardOn}</Chip>
                        <Btn size="s" kind="quiet" onClick={() => { setBoardName(null); setBoardOn(null); }}>
                          {t("settings.championsBoardLeave")}
                        </Btn>
                      </>
                    ) : (
                      <>
                        <input
                          className="ln-input"
                          value={boardDraft}
                          maxLength={16}
                          placeholder={t("settings.championsBoardName")}
                          aria-label={t("settings.championsBoardName")}
                          title={t("settings.championsBoardHint")}
                          onChange={(e) => setBoardDraft(e.target.value)}
                        />
                        <Btn size="s" disabled={!NAME_RE.test(boardDraft.trim())} onClick={() => { setBoardName(boardDraft); setBoardOn(boardName()); }}>
                          {t("settings.championsBoardJoin")}
                        </Btn>
                      </>
                    )}
                  </Row>
                  <Row title={t("settings.reminders")} text={t("settings.remindersText")}>
                    {reminders?.on &&
                      reminders.at.map((m, i) => (
                        <label key={i} className="ln-minute" title={t("settings.reminderAt")}>
                          <input
                            className="ln-input minute"
                            type="number"
                            min={0}
                            max={120}
                            value={m}
                            aria-label={t("settings.reminderAt")}
                            onChange={(e) => {
                              const v = Math.max(0, Math.min(120, Math.round(Number(e.target.value) || 0)));
                              saveReminders({ ...reminders, at: reminders.at.map((x, k) => (k === i ? v : x)) });
                            }}
                          />
                          <small>{m === 0 ? t("settings.reminderLoad") : m === 45 ? t("settings.reminderHalf") : `${m}:00`}</small>
                        </label>
                      ))}
                    {reminders?.on && (
                      <label className="ln-minute sub" title={t("settings.reminderSub")}>
                        <input
                          className="ln-input minute"
                          type="number"
                          min={1}
                          max={120}
                          value={reminders.sub_at ?? 70}
                          aria-label={t("settings.reminderSub")}
                          onChange={(e) => saveReminders({ ...reminders, sub_at: Math.max(1, Math.min(120, Math.round(Number(e.target.value) || 70))) })}
                        />
                        <small>{t("settings.reminderSubShort")}</small>
                      </label>
                    )}
                    <Switch on={!!reminders?.on} label={t("settings.reminders")} onChange={(v) => reminders && saveReminders({ ...reminders, on: v })} />
                  </Row>
                  <Row title={t("settings.usage")} text={t("settings.usageText")}>
                    <Switch on={usageOn} label={t("settings.usage")} onChange={(v) => { setUsageEnabled(v); setUsageOn(v); }} />
                  </Row>
                  <Row title={t("settings.syncAfterPlay")} text={t("settings.syncAfterPlayText")}>
                    <span className="ln-choice" role="group" aria-label={t("settings.syncAfterPlay")}>
                      {(["remind", "auto", "off"] as const).map((m) => (
                        <Choice key={m} on={afterPlay === m} onClick={() => api.setAfterPlay(m).then((p) => setAfterPlay(p.after_play)).catch(() => {})}>
                          {t(m === "remind" ? "settings.afterPlay.remind" : m === "auto" ? "settings.afterPlay.auto" : "settings.off")}
                        </Choice>
                      ))}
                    </span>
                  </Row>
                  <Row title={t("settings.missingSide")} text={t("settings.missingSideText")}>
                    <span className="ln-choice" role="group" aria-label={t("settings.missingSide")}>
                      {(["left", "right"] as const).map((side) => (
                        <Choice key={side} on={missingSide === side} onClick={() => api.setMissingSide(side).then((p) => setMissingSide(p.missing_side)).catch(() => {})}>
                          {t(side === "left" ? "settings.left" : "settings.right")}
                        </Choice>
                      ))}
                    </span>
                  </Row>
                  <Diagnostics />
                  <Row title={t("settings.data")} text={t("settings.dataText")}>
                    <Btn size="s" kind="quiet" onClick={() => run(api.openDataDir)}>
                      {t("footer.dataFolder")}
                    </Btn>
                  </Row>
                  <Row title={t("settings.source")} text={t("settings.sourceText")}>
                    <Btn size="s" kind="quiet" onClick={() => api.openSite("/source").catch(() => {})}>
                      {t("settings.sourceOpen")} ↗
                    </Btn>
                  </Row>
                </div>
              </Panel>
            )}
            <p className="t-13 faint">{t("settings.version", { version })}</p>
            {message && <p className={`ln-message ${message.kind}`}>{message.text()}</p>}
          </section>
        )}
      </main>

      <footer className="ln-foot">
        <div className="hints">
          <Keycap ps="✕" xb="A" kb="Enter" label={t("lh.key.open")} />
          <Keycap ps="○" xb="B" kb="Esc" label={t("lh.key.tray")} />
          <Keycap ps="L1" xb="LB" />
          <Keycap ps="R1" xb="RB" kb="Tab" label={t("lh.key.section")} />
        </div>
        <div className="hints">
          <Keycap ps="Create" xb="View" kb="Ctrl+Shift+F" label={t("lh.key.overlay")} />
          <Keycap ps="Create ×2" xb="View ×2" kb="Ctrl+Shift+M" label={t("lh.key.side")} />
        </div>
      </footer>
    </div>
  );
}

/** A settings row: what it is (and a line of why), its control on the right. */
function Row({ title, text, children }: { title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="ln-row">
      <div className="ln-row-text">
        <b>{title}</b>
        {text && <p>{text}</p>}
      </div>
      <div className="ln-row-ctl">{children}</div>
    </div>
  );
}

/** One option of a small choice (a session-tab shape; selected = the neutral active fill). */
function Choice({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`seg ring ${on ? "is-on" : ""}`} aria-pressed={on} onClick={onClick}>
      <span>{children}</span>
    </button>
  );
}

type RailProps = {
  bridge: BridgeInfo | null;
  bridgeError: string | null;
  paired: boolean;
  syncing: boolean;
  sync: SyncSummary | null;
  running: boolean;
  session: GameSession;
  setup: SetupStatus | null;
  borderless: boolean;
  busy: boolean;
  canSync: boolean;
  extOutdated: boolean;
  extRequired: boolean;
  suggested: boolean;
  message: Message;
  launched: boolean;
  version: string;
  galleryAt: number | null;
  /** owned club cards without loans (the sync's count includes loan cards) */
  clubCount: number | null;
  onSyncAndLaunch: () => void;
  onSync: () => void;
  onStop: () => void;
  onLaunch: () => void;
  onBorderless: () => void;
  onDismissSuggestion: () => void;
  onAccount: () => void;
};

const Tick = ({ state }: { state: "done" | "todo" | "bad" }) => (
  <span className={`tick ${state === "done" ? "done" : ""} ln-tick-${state}`} aria-hidden="true">
    {state === "done" ? (
      <svg viewBox="0 0 12 12">
        <path d="M2.5 6.2l2.3 2.3L9.6 3.7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
      </svg>
    ) : state === "bad" ? (
      "!"
    ) : null}
  </span>
);

/** The rail: Status (what's connected, the one red action) and What's new. */
function StatusRail(p: RailProps) {
  const { bridge, sync } = p;
  const ext: "done" | "todo" | "bad" = p.extOutdated || p.extRequired ? "todo" : !p.paired ? "bad" : bridge?.extension_live ? "done" : bridge?.browser_running ? "bad" : "todo";
  const club: "done" | "todo" = sync?.synced_at ? "done" : "todo";
  const mode: "done" | "todo" | "bad" = p.borderless ? "done" : p.setup && !p.setup.exists ? "bad" : "todo";
  const allSet = ext === "done" && club === "done" && mode === "done";
  const extText = p.extRequired
    ? t("update.ext.required", { version: bridge?.extension_required ?? "" })
    : p.extOutdated
      ? t("tile.extension.outdated", { version: bridge?.extension_latest ?? "" })
      : !p.paired
        ? t("status.notConnected")
        : bridge?.extension_live
          ? t("status.connected")
          : bridge?.browser_running
            ? t("tile.extension.silent")
            : t("tile.extension.waiting");
  return (
    <>
      <Panel className="ln-status" tier="hero">
        <div className="row between">
          <span className="eyebrow">{t("lh.status")}</span>
          {!p.syncing && p.paired && !p.bridgeError && <Chip tone={allSet ? "done" : "warn"}>{allSet ? t("lh.allSet") : t("lh.actionNeeded")}</Chip>}
        </div>

        {p.bridgeError ? (
          <div className="col ln-state">
            <span className="h3">{t("ln.error.title")}</span>
            <p className="t-14 muted">{tError(p.bridgeError)}</p>
          </div>
        ) : !p.paired && bridge ? (
          <div className="col ln-state">
            <span className="h3">{t("ln.pair.title")}</span>
            <p className="t-14 muted">{t("ln.pair.text")}</p>
            <Num value={bridge.pairing_code} size="l" className="ln-code" />
            <p className="t-13 faint">{t("ln.pair.get")}</p>
          </div>
        ) : p.syncing ? (
          <div className="col ln-state">
            <span className="h3">{t("ln.sync.title")}</span>
            <p className="t-14 muted">{t("ln.sync.text")}</p>
            <div className="list rule">
              <div className="lrow">
                <Tick state="done" />
                <span>{t("ln.sync.step.open")}</span>
              </div>
              <div className="lrow now">
                <span className="tick run" aria-hidden="true" />
                <span className="strong">{sync && sync.item_count > 0 ? t("ln.sync.step.reading") : t("ln.sync.step.signIn")}</span>
                {sync && sync.item_count > 0 && <span className="t-13 muted">{t("ln.sync.step.items", { count: sync.item_count })}</span>}
              </div>
              <div className="lrow">
                <Tick state="todo" />
                <span className="muted">{t("ln.sync.step.done")}</span>
              </div>
            </div>
            {(p.running || p.launched) && (
              <div className="toast ln-warn" role="status">
                <i className="edge" />
                <p className="t-13">
                  <b>{t("ln.sync.warnTitle")}</b> {t("ln.sync.warn")}
                </p>
              </div>
            )}
            <Btn kind="secondary" disabled={p.busy} onClick={p.onStop}>
              {t("ln.sync.stop")}
            </Btn>
          </div>
        ) : (
          <>
            <div className="list rule">
              <div className="lrow">
                <Tick state={p.running ? "done" : "todo"} />
                <span>{p.running ? t(`session.${p.session}` as MessageKey) : t("ln.game.off")}</span>
              </div>
              <div className="lrow">
                <Tick state={ext} />
                <span className="ellip">{extText}</span>
                <span className="t-13 faint">{bridge?.extension_version ? `v${bridge.extension_version}` : ""}</span>
              </div>
              <div className="lrow">
                <Tick state={club} />
                <span className="ellip">{sync?.synced_at ? t("lh.clubSynced", { count: p.clubCount ?? sync.player_count }) : t("tile.club.never")}</span>
                <span className="t-13 faint">{sync?.synced_at ? formatAge(sync.synced_at) : ""}</span>
              </div>
              <div className="lrow">
                <Tick state={mode} />
                <span className="ellip">{p.setup ? (p.setup.exists ? t(`mode.${p.setup.mode}`) : t("status.setupMissing")) : "…"}</span>
                {p.setup?.exists && !p.borderless && (
                  <button className="ln-link t-13" disabled={p.busy || p.running} onClick={p.onBorderless}>
                    {p.running ? t("borderless.closeFirst") : t("tile.mode.fix")}
                  </button>
                )}
              </div>
              <div className="lrow">
                <Tick state={p.galleryAt ? "done" : "todo"} />
                <span>{p.galleryAt ? t("lh.galleryRead") : t("lh.galleryNotRead")}</span>
                <span className="t-13 faint">{p.galleryAt ? formatAge(p.galleryAt) : ""}</span>
              </div>
              <AccountRow onAccount={p.onAccount} />
            </div>
            {(p.extOutdated || p.extRequired || (p.paired && !bridge?.extension_live && bridge?.browser_running)) && (
              <button className="ln-link t-13" onClick={() => api.openSite("/download").catch(() => {})}>
                {t("tile.extension.get")} ↗
              </button>
            )}
            {p.suggested && !p.running && (
              <div className="toast ln-warn" role="status">
                <i className="edge" />
                <p className="t-13 grow">
                  <b>{t("ln.suggest.title")}</b> {t("ln.suggest.text")}
                </p>
                <button className="ln-x" aria-label={t("ln.suggest.dismiss")} onClick={p.onDismissSuggestion}>
                  ×
                </button>
              </div>
            )}
            {p.running && p.session === "in_match" ? (
              <p className="t-14 muted">{t("ln.match.text")}</p>
            ) : p.running ? (
              <div className="col ln-actions">
                <Btn kind="primary" disabled={p.busy || !p.canSync} onClick={p.onSync}>
                  {t("ln.running.sync")}
                </Btn>
                {!syncAllowed(p.session) && <p className="t-13 faint">{t(`session.hint.${p.session}` as MessageKey)}</p>}
              </div>
            ) : (
              <div className="col ln-actions">
                <Btn kind="primary" disabled={p.busy} onClick={p.onSyncAndLaunch}>
                  {t("ln.launch")}
                </Btn>
                <div className="row ln-actions-2">
                  <Btn kind="quiet" size="s" disabled={p.busy || !p.canSync} onClick={p.onSync}>
                    {t("ln.syncOnly")}
                  </Btn>
                  <Btn kind="quiet" size="s" disabled={p.busy} onClick={p.onLaunch}>
                    {t("ln.launchOnly")}
                  </Btn>
                </div>
                <p className="t-13 faint">{sync?.synced_at ? t("ln.alreadySynced", { age: formatAge(sync.synced_at) }) : t("ln.notSyncedYet")}</p>
              </div>
            )}
          </>
        )}
        {p.message && <p className={`ln-message ${p.message.kind}`}>{p.message.text()}</p>}
      </Panel>
      <WhatsNew version={p.version} />
    </>
  );
}

/** Signed in: who and the last account sync; signed out: the way to sign in (everything is free). */
function AccountRow({ onAccount }: { onAccount: () => void }) {
  const acc = useAccount();
  if (acc.status === "loading") return null;
  if (acc.status === "out")
    return (
      <button type="button" className="lrow ln-acct-row" onClick={onAccount}>
        <Tick state="todo" />
        <span className="ellip">{t("lh.signIn")}</span>
        <span className="t-13 faint">{t("acct.strip.signIn")} →</span>
      </button>
    );
  const s = acc.sync;
  const line = s.phase === "syncing" ? t("account.syncing") : s.phase === "conflict" ? t("account.conflict.pending") : s.phase === "error" ? tError(s.error) : s.at ? t("account.synced", { when: timeAgo(s.at) }) : t("account.syncing");
  return (
    <button type="button" className="lrow ln-acct-row" onClick={onAccount}>
      <Avatar size={18} />
      {/* the state under the name, wrapping – a long one ("Waiting for your choice …") never widens the rail */}
      <span className="col ln-acct-who">
        <span className="ellip">{acc.user?.display_name ?? acc.user?.email}</span>
        <span className="t-13 faint">{line}</span>
      </span>
    </button>
  );
}

/** What's new in this version (release notes in five languages, lh.new.*). */
const NEW_NOTES = ["look", "update", "free", "opens", "home"] as const;
function WhatsNew({ version }: { version: string }) {
  return (
    <Panel className="ln-notes">
      <span className="h3">{t("lh.newIn", { version: version || "v2" })}</span>
      <ul>
        {NEW_NOTES.map((k) => (
          <li key={k}>
            <b>{t(`lh.new.${k}.t` as MessageKey)}</b> {t(`lh.new.${k}.d` as MessageKey)}
          </li>
        ))}
      </ul>
      <button className="ln-link t-13 ln-notes-all" onClick={() => void api.openReleaseNotes().catch(() => {})}>
        {t("lh.allNotes")} →
      </button>
    </Panel>
  );
}

/** Settings → Diagnostics: for 30 minutes every picture the tracking reads is saved with what the
 * app made of it – so a wrong read can be looked at exactly as the app saw it. */
function Diagnostics() {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const check = () => api.diagnosticsStatus().then((s) => setLeft(s.remaining)).catch(() => {});
    check();
    const id = setInterval(check, 5000);
    return () => clearInterval(id);
  }, []);
  const on = left != null;
  return (
    <Row title={t("diag.title")} text={on ? t("diag.running", { minutes: Math.max(1, Math.ceil((left ?? 0) / 60)) }) : t("diag.text")}>
      <Btn size="s" kind="quiet" onClick={() => api.openDiagnostics().catch(() => {})}>
        {t("diag.folder")}
      </Btn>
      <Switch on={on} label={t("diag.title")} onChange={(v) => api.setDiagnostics(v).then((s) => setLeft(s.remaining)).catch(() => {})} />
    </Row>
  );
}
