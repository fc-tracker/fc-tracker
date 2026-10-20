import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, events, formatAge, olderThan, syncAllowed, type BridgeInfo, type GameSession, type SetupStatus, type SyncSummary, type UpdateInfo, type AfterPlay } from "./api";
import { LOCALE_NAMES, t, tError, useLocale, type Locale, type MessageKey } from "./i18n";
import Help from "./Help";
import { SupportButton } from "./Support";
import Speed from "./Speed";
import { THEMES, useTheme, type Theme } from "./theme";
import { initUsage, onlineNow, setUsageEnabled, startPresence, track, trackOnce, usageEnabled } from "./usage";

// Usage statistics run in the real app only (the launcher window lives as long as the app does).
const inApp = "__TAURI_INTERNALS__" in window;

// Messages are stored as functions so they re-translate when the language changes.
type Message = { kind: "ok" | "error"; text: () => string } | null;
const ok = (text: () => string): Message => ({ kind: "ok", text });
const fail = (err: unknown): Message => ({ kind: "error", text: () => tError(err) });

type View = "home" | "help" | "settings";

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
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const [version, setVersion] = useState("");
  const [afterPlay, setAfterPlay] = useState<AfterPlay>("remind");
  const [suggested, setSuggested] = useState(false);
  useEffect(() => {
    api.syncSuggested().then(setSuggested).catch(() => {});
    const un = events.onSyncSuggested(setSuggested);
    return () => {
      un.then((u) => u());
    };
  }, []);
  const [settingsTab, setSettingsTab] = useState<"general" | "speed">("general");
  const [missingSide, setMissingSide] = useState<"left" | "right">("left");
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [usageOn, setUsageOn] = useState(usageEnabled);
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
  useEffect(() => {
    api
      .uiPrefs()
      .then((p) => {
        setAfterPlay(p.after_play);
        setMissingSide(p.missing_side);
      })
      .catch(() => {});
  }, []);
  // The game was started together with the sync: shown as a step until it runs.
  const launched = useRef(false);

  // The extension follows the app's language.
  useEffect(() => {
    api.setLocale(locale).catch(() => {});
  }, [locale]);

  // New releases: checked at start and every 6 hours; installed only when the user clicks.
  useEffect(() => {
    api.appVersion().then(setVersion).catch(() => {});
    const check = () => api.checkUpdate().then(setUpdate).catch(() => {});
    check();
    const id = setInterval(check, 6 * 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  async function installUpdate() {
    setUpdating(true);
    setMessage(null);
    try {
      await api.installUpdate();
    } catch (e) {
      setMessage(fail(e));
      setUpdating(false);
    }
  }

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
  const borderless = setup?.exists && setup.mode === "borderless";
  // With the game open, a sync is fine as long as the user is outside Ultimate Team.
  // "unknown" stays clickable: the app then looks at the game behind the launcher right away.
  const canSync = paired && (!running || syncAllowed(session) || session === "unknown");
  const extOutdated = !!(paired && bridge?.extension_version && olderThan(bridge.extension_version, bridge.extension_latest));

  return (
    <div className="ln">
      <aside className="ln-rail">
        <Logo />
        <nav className="ln-nav">
          <RailButton icon={<IconHome />} label={t("nav.home")} on={view === "home"} onClick={() => setView("home")} />
          <RailButton icon={<IconHelp />} label={t("nav.help")} on={view === "help"} onClick={() => setView("help")} />
          <RailButton icon={<IconGear />} label={t("nav.settings")} on={view === "settings"} onClick={() => setView("settings")} />
        </nav>
      </aside>

      <main className="ln-main">
        <header className="ln-top">
          <span className="ln-brand">FC-Tracker</span>
          {online != null && (
            <span className="ln-online" title={t("online.hint")}>
              <span className="ln-online-dot" aria-hidden="true" />
              {t("online.now", { count: online })}
            </span>
          )}
          <span className="ln-top-right">
            <SupportButton />
            <span className={`ln-pill ${running ? "on" : ""}`}>
              <span className="ln-dot" />
              {running ? t(`session.${session}` as MessageKey) : t("ln.game.off")}
            </span>
          </span>
        </header>

        {update && (
          <div className="ln-update" role="status">
            <span className="ln-update-mark" aria-hidden="true" />
            <p>
              <b>{t("update.available", { version: update.version })}</b> {running ? t("update.closeGame") : t("update.text")}
            </p>
            <button className="ln-btn small" disabled={updating || running} onClick={installUpdate}>
              {updating ? t("update.installing") : t("update.install")}
            </button>
          </div>
        )}

        {view === "home" && (
          <>
            <section className="ln-hero">
              <p className="ln-eyebrow">{t("ln.eyebrow")}</p>
              {bridgeError ? (
                <Hero title={t("ln.error.title")} text={tError(bridgeError)} />
              ) : !paired && bridge ? (
                <Hero title={t("ln.pair.title")} text={t("ln.pair.text")}>
                  <p className="ln-code">{bridge.pairing_code}</p>
                  <p className="ln-hint">{t("ln.pair.get")}</p>
                </Hero>
              ) : syncing ? (
                <Hero title={t("ln.sync.title")} text={t("ln.sync.text")}>
                  <ol className="ln-steps">
                    <Step state="done" label={t("ln.sync.step.open")} />
                    <Step
                      state="active"
                      label={sync && sync.item_count > 0 ? t("ln.sync.step.reading") : t("ln.sync.step.signIn")}
                      detail={sync && sync.item_count > 0 ? t("ln.sync.step.items", { count: sync.item_count }) : undefined}
                    />
                    <Step state="todo" label={t("ln.sync.step.done")} />
                  </ol>
                  {(running || launched.current) && (
                    <div className="ln-warn" role="status">
                      <span className="ln-warn-mark" aria-hidden="true">!</span>
                      <p>
                        <b>{t("ln.sync.warnTitle")}</b> {t("ln.sync.warn")}
                      </p>
                    </div>
                  )}
                  <div className="ln-actions">
                    <button className="ln-btn ghost" disabled={busy} onClick={stopSync}>
                      {t("ln.sync.stop")}
                    </button>
                  </div>
                </Hero>
              ) : running && session === "in_match" ? (
                <Hero title={t("ln.match.title")} text={t("ln.match.text")} />
              ) : running ? (
                <Hero title={t("ln.running.title")} text={t("ln.running.text")}>
                  <div className="ln-actions">
                    <button className="ln-btn" disabled={busy || !canSync} onClick={() => run(api.startSync)}>
                      {t("ln.running.sync")}
                    </button>
                  </div>
                  {!syncAllowed(session) && <p className="ln-hint">{t(`session.hint.${session}` as MessageKey)}</p>}
                </Hero>
              ) : (
                <Hero title={t("ln.ready.title")} text={t("ln.ready.text")}>
                  {suggested && (
                    <div className="ln-warn ln-suggest" role="status">
                      <span className="ln-warn-mark" aria-hidden="true">!</span>
                      <p>
                        <b>{t("ln.suggest.title")}</b> {t("ln.suggest.text")}
                      </p>
                      <button className="ln-suggest-x" aria-label={t("ln.suggest.dismiss")} onClick={() => api.dismissSyncSuggestion().then(() => setSuggested(false)).catch(() => {})}>
                        ×
                      </button>
                    </div>
                  )}
                  <div className="ln-actions">
                    <button className="ln-btn" disabled={busy} onClick={syncAndLaunch}>
                      <IconPlay /> {t("ln.launch")}
                    </button>
                    <button className="ln-btn ghost" disabled={busy || !canSync} onClick={() => run(api.startSync)}>
                      {t("ln.syncOnly")}
                    </button>
                  </div>
                  {/* Synced lately: start the game straight away. */}
                  <div className="ln-already">
                    <p>{sync?.synced_at ? t("ln.alreadySynced", { age: formatAge(sync.synced_at) }) : t("ln.notSyncedYet")}</p>
                    <button className="ln-btn ghost small" disabled={busy} onClick={() => run(api.launchGame, () => t("game.launching"))}>
                      <IconPlay /> {t("ln.launchOnly")}
                    </button>
                  </div>
                </Hero>
              )}
              {message && <p className={`ln-message ${message.kind}`}>{message.text()}</p>}
            </section>

            {!syncing && (
            <section className="ln-tiles">
              <Tile
                label={t("status.extension")}
                value={
                  extOutdated
                    ? t("tile.extension.outdated", { version: bridge?.extension_latest ?? "" })
                    : !paired
                      ? t("status.notConnected")
                      : bridge?.extension_live
                        ? t("status.connected")
                        : bridge?.browser_running
                          ? t("tile.extension.silent")
                          : t("tile.extension.waiting")
                }
                good={paired && !extOutdated && !!bridge?.extension_live}
                text={
                  extOutdated
                    ? t("tile.extension.outdatedText")
                    : paired && !bridge?.extension_live
                      ? bridge?.browser_running
                        ? t("tile.extension.silentText")
                        : t("tile.extension.waitingText")
                      : t("tile.extension.text")
                }
              >
                {(extOutdated || (paired && !bridge?.extension_live && bridge?.browser_running)) && (
                  <button className="ln-link" onClick={() => api.openSite("/download").catch(() => {})}>
                    {t("tile.extension.get")} ↗
                  </button>
                )}
              </Tile>
              <Tile
                label={t("status.displayMode")}
                value={setup ? (setup.exists ? t(`mode.${setup.mode}`) : t("status.setupMissing")) : "…"}
                good={!!borderless}
                text={t("tile.mode.text")}
              >
                {setup?.exists && !borderless && (
                  <button className="ln-link" disabled={busy || running} onClick={() => run(api.setBorderless, () => t("borderless.done"))}>
                    {running ? t("borderless.closeFirst") : t("tile.mode.fix")}
                  </button>
                )}
              </Tile>
              <Tile
                label={t("tile.club")}
                value={
                  sync?.synced_at
                    ? `${t("status.players", { count: sync.player_count })} · ${formatAge(sync.synced_at)}`
                    : t("tile.club.never")
                }
                good={!!sync?.synced_at}
                text={t("tile.club.text")}
              />
            </section>
            )}
          </>
        )}

        {view === "help" && <Help />}

        {view === "settings" && (
          <section className="ln-page">
            <h1>{t("nav.settings")}</h1>
            <nav className="help-bar settings-tabs" aria-label={t("nav.settings")}>
              <span className="help-tabs">
                {(["general", "speed"] as const).map((tab) => (
                  <button key={tab} className={settingsTab === tab ? "on" : ""} aria-pressed={settingsTab === tab} onClick={() => setSettingsTab(tab)}>
                    {t(tab === "general" ? "settings.general" : "speed.tab")}
                  </button>
                ))}
              </span>
            </nav>
            {settingsTab === "speed" && <Speed />}
            {settingsTab === "general" && (
            <>
            <div className="ln-form">
              <label>
                <span>{t("overlay.theme")}</span>
                <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
                  {THEMES.map((th) => (
                    <option key={th} value={th}>
                      {t(`theme.${th}` as MessageKey)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("language")}</span>
                <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                  {Object.entries(LOCALE_NAMES).map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="ln-rows">
              <div className="ln-row">
                <div>
                  <b>{t("status.extension")}</b>
                  <p>
                    {paired ? t("status.connected") : t("status.notConnected")}
                    {bridge?.extension_version && ` · v${bridge.extension_version}`}
                  </p>
                </div>
                {paired && (
                  <button className="ln-btn ghost small" onClick={() => run(api.unpair, () => t("footer.unpaired"))}>
                    {t("footer.unpair")}
                  </button>
                )}
              </div>
              <div className="ln-row">
                <div>
                  <b>{t("settings.autostart")}</b>
                  <p>{t("settings.autostartText")}</p>
                </div>
                <button
                  className={`ln-btn small ${autostart ? "" : "ghost"}`}
                  aria-pressed={!!autostart}
                  disabled={autostart === null}
                  onClick={() => api.setAutostart(!autostart).then(setAutostart).catch(() => {})}
                >
                  {autostart ? t("settings.on") : t("settings.off")}
                </button>
              </div>
              <div className="ln-row">
                <div>
                  <b>{t("settings.usage")}</b>
                  <p>{t("settings.usageText")}</p>
                </div>
                <button
                  className={`ln-btn small ${usageOn ? "" : "ghost"}`}
                  aria-pressed={usageOn}
                  onClick={() => {
                    setUsageEnabled(!usageOn);
                    setUsageOn(!usageOn);
                  }}
                >
                  {usageOn ? t("settings.on") : t("settings.off")}
                </button>
              </div>
              <div className="ln-row">
                <div>
                  <b>{t("settings.syncAfterPlay")}</b>
                  <p>{t("settings.syncAfterPlayText")}</p>
                </div>
                <div className="ln-seg">
                  {(["remind", "auto", "off"] as const).map((m) => (
                    <button
                      key={m}
                      className={`ln-btn small ${afterPlay === m ? "" : "ghost"}`}
                      aria-pressed={afterPlay === m}
                      onClick={() => api.setAfterPlay(m).then((p) => setAfterPlay(p.after_play)).catch(() => {})}
                    >
                      {t(m === "remind" ? "settings.afterPlay.remind" : m === "auto" ? "settings.afterPlay.auto" : "settings.off")}
                    </button>
                  ))}
                </div>
              </div>
              <div className="ln-row">
                <div>
                  <b>{t("settings.missingSide")}</b>
                  <p>{t("settings.missingSideText")}</p>
                </div>
                <div className="ln-seg" role="group" aria-label={t("settings.missingSide")}>
                  {(["left", "right"] as const).map((side) => (
                    <button
                      key={side}
                      className={`ln-btn small ${missingSide === side ? "" : "ghost"}`}
                      aria-pressed={missingSide === side}
                      onClick={() => api.setMissingSide(side).then((p) => setMissingSide(p.missing_side)).catch(() => {})}
                    >
                      {t(side === "left" ? "settings.left" : "settings.right")}
                    </button>
                  ))}
                </div>
              </div>
              <Diagnostics />
              <div className="ln-row">
                <div>
                  <b>{t("settings.data")}</b>
                  <p>{t("settings.dataText")}</p>
                </div>
                <button className="ln-btn ghost small" onClick={() => run(api.openDataDir)}>
                  {t("footer.dataFolder")}
                </button>
              </div>
              <div className="ln-row">
                <div>
                  <b>{t("settings.source")}</b>
                  <p>{t("settings.sourceText")}</p>
                </div>
                <button className="ln-btn ghost small" onClick={() => api.openSite("/source").catch(() => {})}>
                  {t("settings.sourceOpen")}
                </button>
              </div>
            </div>
            </>
            )}
            <p className="ln-hint">{t("settings.version", { version })}</p>
            {message && <p className={`ln-message ${message.kind}`}>{message.text()}</p>}
          </section>
        )}
      </main>
    </div>
  );
}

function Hero({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <>
      <h1 className="ln-title">{title}</h1>
      <p className="ln-text">{text}</p>
      {children}
    </>
  );
}

function Step({ state, label, detail }: { state: "done" | "active" | "todo"; label: string; detail?: string }) {
  return (
    <li className={`ln-step ${state}`}>
      <span className="ln-step-mark" aria-hidden="true" />
      <span>
        {label}
        {detail && <small>{detail}</small>}
      </span>
    </li>
  );
}

function Tile({ label, value, good, text, children }: { label: string; value: string; good: boolean; text: string; children?: ReactNode }) {
  return (
    <div className={`ln-tile ${good ? "good" : "todo"}`}>
      <span className="ln-tile-label">{label}</span>
      <span className="ln-tile-value">
        <span className="ln-dot" /> {value}
      </span>
      <p>{text}</p>
      {children}
    </div>
  );
}

function RailButton({ icon, label, on, onClick }: { icon: ReactNode; label: string; on: boolean; onClick: () => void }) {
  return (
    <button className={`ln-rail-btn ${on ? "on" : ""}`} onClick={onClick} aria-label={label} title={label} aria-current={on ? "page" : undefined}>
      {icon}
    </button>
  );
}

function Logo() {
  return (
    <svg className="ln-logo" viewBox="0 0 512 512" aria-label="FC-Tracker">
      <defs>
        <linearGradient id="ln-lf" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a48bff" />
          <stop offset="1" stopColor="#5b3fe0" />
        </linearGradient>
        <linearGradient id="ln-lg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7ff5d6" />
          <stop offset="1" stopColor="#22c49c" />
        </linearGradient>
      </defs>
      <path d="M256 70 L442 256 L256 442 L70 256 Z" fill="none" stroke="url(#ln-lf)" strokeWidth="46" />
      <path d="M256 168 L330 240 L256 344 L182 240 Z" fill="url(#ln-lg)" />
    </svg>
  );
}

const IconHome = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z" />
  </svg>
);
// Help opens on Controls, so the rail shows a controller (a question mark read as "error")
const IconHelp = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fillRule="evenodd" d="M7 7h10a5 5 0 0 1 4.9 6l-.8 4a2.5 2.5 0 0 1-4.4 1L15 16H9l-1.7 2a2.5 2.5 0 0 1-4.4-1l-.8-4A5 5 0 0 1 7 7Zm0 3v1.5H5.5v1.5H7v1.5h1.5V13H10v-1.5H8.5V10Zm9 .5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm-2 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" />
  </svg>
);
const IconGear = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="m10 2-.6 2.6a8 8 0 0 0-1.9 1.1L5 4.9 3 8.4l2 1.8a8 8 0 0 0 0 2.2l-2 1.8 2 3.5 2.5-.8a8 8 0 0 0 1.9 1.1L10 22h4l.6-2.6a8 8 0 0 0 1.9-1.1l2.5.8 2-3.5-2-1.8a8 8 0 0 0 0-2.2l2-1.8-2-3.5-2.5.8a8 8 0 0 0-1.9-1.1L14 2Zm2 7a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z" />
  </svg>
);
const IconPlay = () => (
  <svg className="ln-play" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 5v14l11-7z" />
  </svg>
);

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
    <div className="ln-row">
      <div>
        <b>{t("diag.title")}</b>
        <p>{on ? t("diag.running", { minutes: Math.max(1, Math.ceil((left ?? 0) / 60)) }) : t("diag.text")}</p>
      </div>
      <div className="ln-seg">
        <button className={`ln-btn small ${on ? "" : "ghost"}`} aria-pressed={on} onClick={() => api.setDiagnostics(!on).then((s) => setLeft(s.remaining)).catch(() => {})}>
          {on ? t("settings.on") : t("settings.off")}
        </button>
        <button className="ln-btn ghost small" onClick={() => api.openDiagnostics().catch(() => {})}>
          {t("diag.folder")}
        </button>
      </div>
    </div>
  );
}
