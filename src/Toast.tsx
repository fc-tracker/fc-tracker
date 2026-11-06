import { Children, cloneElement, useEffect, useLayoutEffect, useState, type ReactElement, type ReactNode } from "react";
import { events, type ToastPayload } from "./api";
import { compact, num } from "./format";
import { t, useLocale, type MessageKey } from "./i18n";
import { Gem } from "./icons";
import { useTheme } from "./theme";
import { Rank, Score } from "./ui";
import { rankFor, REWARDS } from "./championsData";
import "./overlay.css";

/** dev preview: `?view=toast&demo=…&secs=8` draws the timer line of an 8 s notice */
const devSecs = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get("secs")) || 0 : 0;

const signed = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "±") + num(Math.abs(n));

/**
 * Click-through hint at the top of the screen (window "toast"): live advice on the Swap screen,
 * impact of packed cards. Never takes focus; the backend shows and hides the window.
 */
export default function Toast() {
  useLocale();
  useTheme();
  const [toast, setToast] = useState<ToastPayload | null>(null);

  useEffect(() => {
    const unlisten = events.onToast(setToast);
    return () => {
      unlisten.then((u) => u());
    };
  }, []);

  useFitToast(toast);
  if (!toast) return null;
  const el = toastElement(toast);
  // the timer line (mockup 08): only when the app said how long the notice stays – a notice that
  // waits for something (a sync, a sign-in) has no timer
  const secs = (toast as { secs?: number }).secs ?? devSecs;
  if (!secs || secs > 60) return el;
  const timer = (
    <span key="toast-time" className="toast-time" aria-hidden="true">
      <i style={{ animationDuration: `${secs}s` }} />
    </span>
  );
  return cloneElement(el, undefined, ...Children.toArray((el.props as { children?: ReactNode }).children), timer);
}

/**
 * Rule 10 (every size, every language): the toast is click-through, so no tooltip can show a cut
 * text – it must fit. Step by step until nothing is cut: a smaller title (fit-1, fit-2), then the
 * title on two lines and the line wrapping (fit-3).
 */
const FIT = ["fit-1", "fit-2", "fit-3"];
function useFitToast(toast: ToastPayload | null) {
  useLayoutEffect(() => {
    const root = document.querySelector<HTMLElement>(".toast");
    if (!root) return;
    const cut = () =>
      [...root.querySelectorAll<HTMLElement>(".toast-title, .toast-title > span, .toast-line")].some((e) => e.scrollWidth > e.clientWidth + 1) ||
      [...root.querySelectorAll<HTMLElement>(".toast-body")].some((b) => b.scrollHeight > b.clientHeight + 1);
    const fit = () => {
      root.classList.remove(...FIT);
      for (const step of FIT) {
        if (!cut()) return;
        root.classList.remove(...FIT);
        root.classList.add(step);
      }
    };
    fit();
    // the display font may arrive after the first paint: measure again then
    document.fonts?.ready.then(fit).catch(() => {});
  }, [toast]);
}

/** The lower-third for one notice: a solid tag, the title, one line (mockup 08). */
function toastElement(toast: ToastPayload): ReactElement {
  if (toast.kind === "better") {
    const b = toast.better;
    return (
      <div className="toast better" key={`better-${toast.set_key}-${b.best}`}>
        <span className="toast-mark better" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 8.4l3 3 6-6.6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="square" /></svg></span>
        <div className="toast-body">
          <p className="toast-title">
            {t("toast.betterTitle", { set: toast.set_name })}
            <span className="toast-delta up">
              <Gem size={10} /> +{num(b.gain)}
            </span>
          </p>
          <p className="toast-line">{t("toast.betterLine", { best: num(b.best), ingame: num(b.ingame) })}</p>
        </div>
      </div>
    );
  }

  if (toast.kind === "optimized") {
    return (
      <div className="toast better" key={`optimized-${toast.set_key}-${toast.total}`}>
        <span className="toast-mark better" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 8.4l3 3 6-6.6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="square" /></svg></span>
        <div className="toast-body">
          <p className="toast-title">
            {t("toast.optimizedTitle", { set: toast.set_name })}
            <span className="toast-ok">✓</span>
          </p>
          <p className="toast-line">{t("toast.optimizedLine", { total: num(toast.total) })}</p>
        </div>
      </div>
    );
  }

  if (toast.kind === "swap") {
    const a = toast.advice;
    const agrees = a.model_exact && a.model_delta === a.ingame_delta && a.ingame_delta >= 0;
    return (
      <div className="toast" key={`${a.set_key}-${a.ingame_delta}`}>
        <span className="toast-mark" aria-hidden="true"><i className="dot" /></span>
        <div className="toast-body">
          <p className="toast-title">
            {t("toast.swapTitle", { set: a.set_name })}
            <span className={`toast-delta ${a.ingame_delta >= 0 ? "up" : "down"}`}>
              <Gem size={10} /> {signed(a.ingame_delta)}
            </span>
            {agrees && <span className="toast-ok">{t("toast.agrees")}</span>}
          </p>
          <p className="toast-line">
            {!a.model_exact
              ? t("toast.notExact", { identified: a.identified, slots: a.slots })
              : a.highlighted_is_best
                ? t("toast.highlightedBest")
                : a.best
                  ? t("toast.best", {
                      name: a.best.name ?? "?",
                      rating: a.best.rating ?? "",
                      gain: compact(a.best_gain),
                    })
                  : t("toast.keep")}
          </p>
        </div>
      </div>
    );
  }

  if (toast.kind === "autocomplete") {
    return (
      <div className="toast better" key="autocomplete">
        <span className="toast-mark better" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 8.4l3 3 6-6.6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="square" /></svg></span>
        <div className="toast-body">
          <p className="toast-title">{t("toast.autoTitle")}</p>
          <p className="toast-line">{toast.set_name ? t("toast.autoLine", { set: toast.set_name }) : t("toast.autoLineNoSet")}</p>
        </div>
      </div>
    );
  }

  if (toast.kind === "fill") {
    return (
      <div className="toast better" key={`fill-${toast.set_name}`}>
        <span className="toast-mark better" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 8.4l3 3 6-6.6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="square" /></svg></span>
        <div className="toast-body">
          <p className="toast-title">{t(toast.count === 1 ? "fill.titleOne" : "fill.title", { set: toast.set_name, count: toast.count })}</p>
          <p className="toast-line">
            {toast.names.length > 0 && toast.points != null
              ? t("fill.lineNames", { names: toast.names.join(", "), points: num(toast.points) })
              : t("fill.line")}
          </p>
        </div>
      </div>
    );
  }

  if (toast.kind === "champions") {
    const score = toast.score ? `${toast.score[0]}–${toast.score[1]}` : "";
    const outcome = toast.outcome ? t(`champs.short.${toast.outcome}`) : "";
    return (
      <div className={`toast read ${toast.outcome === "win" ? "best" : ""}`} key={`champs-${toast.n}`} role="status">
        <span className="toast-mark read" aria-hidden="true">
          <Score a={toast.wins} b={toast.losses} />
        </span>
        <div className="toast-body">
          {toast.outcome === "win" && rankFor(toast.wins) ? (
            // a win (08): the rank it reached, with the shield, and what that rank pays
            <>
              <p className="toast-title toast-rank">
                <Rank i={toast.wins - 1} got />
                <span>{t("v2panel.toast.winRank", { rank: rankFor(toast.wins) ?? "" })}</span>
              </p>
              <p className="toast-line">
                {t("v2panel.toast.winLine", { n: toast.n ?? "?", coins: num(REWARDS[toast.wins - 1].coins), tokens: REWARDS[toast.wins - 1].tokens })}
              </p>
            </>
          ) : (
            <p className="toast-title">{t("champs.toastTitle", { n: toast.n ?? "?" })}</p>
          )}
          {toast.outcome !== "win" && <p className="toast-line">
            {[`${outcome} ${score}${toast.aet ? ` ${t("champs.aet")}` : ""}`, toast.when_left ? t("champs.whenLeft", { score: `${toast.when_left[0]}–${toast.when_left[1]}`, minute: toast.minute ?? 0 }) : null]
              .filter(Boolean)
              .join(" · ")}
          </p>}
          {toast.outcome !== "win" && <p className="toast-line">{t("champs.toastRecord", { wins: toast.wins, losses: toast.losses, left: toast.remaining })}</p>}
        </div>
      </div>
    );
  }

  if (toast.kind === "welcome") {
    return (
      <div className="toast read best" key="welcome" role="status">
        <span className="toast-mark read" aria-hidden="true"><i className="dot" /></span>
        <div className="toast-body">
          <p className="toast-title">{t("toast.welcome")}</p>
          <p className="toast-line">{t("toast.welcomeLine", { count: num(toast.players) })}</p>
        </div>
      </div>
    );
  }

  if (toast.kind === "squads") {
    return (
      <div className="toast read best" key="squads" role="status">
        <span className="toast-mark read" aria-hidden="true"><i className="dot" /></span>
        <div className="toast-body">
          <p className="toast-title">{t("squads.notice.title", { event: toast.event })}</p>
          <p className="toast-line">{t("squads.notice.line")}</p>
        </div>
      </div>
    );
  }

  if (toast.kind === "squads-swap") {
    return (
      <div className="toast read" key="squads-swap" role="status">
        <span className="toast-mark read" aria-hidden="true"><span className="num">{t("v2panel.matchTag", { n: toast.played + 1 })}</span></span>
        <div className="toast-body">
          {/* 08: one title, the changes on one line (out → in · out → in) */}
          <p className="toast-title">{t("v2panel.toast.changes", { count: toast.swaps.length })}</p>
          <p className="toast-line" title={t("squads.toast.check")}>
            {toast.swaps
              .map((w) => (w.out ? `${w.out} → ${w.in}` : t("squads.plan.in", { in: w.in, pos: w.pos })) + (w.buy ? ` (${t("squads.toast.buy")})` : ""))
              .join(" · ")}
          </p>
        </div>
      </div>
    );
  }

  if (toast.kind === "squads-match") {
    return (
      <div className="toast read" key="squads-match" role="status">
        <span className="toast-mark read" aria-hidden="true"><i className="dot" /></span>
        <div className="toast-body">
          <p className="toast-title">{t("squads.toast.matchTitle", { count: toast.played })}</p>
          <p className="toast-line">{toast.next != null && toast.next > 0 ? t("squads.toast.next", { count: toast.next }) : t("squads.toast.keep")}</p>
          <p className="toast-line">{t("squads.toast.check")}</p>
        </div>
      </div>
    );
  }

  // An objective done (read on the Objectives screen): the plan without it – who to change
  if (toast.kind === "squad-changes") {
    return (
      <div className="toast read best" key={`squad-changes-${toast.done}`} role="status">
        <span className="toast-mark read" aria-hidden="true"><span className="num">{t("v2panel.matchTag", { n: toast.counted + 1 })}</span></span>
        <div className="toast-body">
          <p className="toast-title">{toast.swaps.length ? t("squadchg.title", { done: toast.done ?? "" }) : t("squadchg.keepTitle", { done: toast.done ?? "" })}</p>
          {toast.swaps.slice(0, 4).map((w, i) => (
            <p className="toast-line" key={i}>
              {w.out ? t("squads.plan.swap", { out: w.out, in: w.in, pos: w.pos }) : t("squads.plan.in", { in: w.in, pos: w.pos })}
              {w.buy ? ` · ${t("squads.toast.buy")}` : ""}
            </p>
          ))}
          <p className="toast-line">{t("squadchg.line", { count: toast.counted, place: toast.place })}</p>
        </div>
      </div>
    );
  }

  // The game's Objectives screen: its real progress replaced the last sync's
  if (toast.kind === "objectives-read") {
    return (
      <div className="toast read" key={`objectives-read-${toast.event}`} role="status">
        <span className="toast-mark read" aria-hidden="true"><i className="dot" /></span>
        <div className="toast-body">
          <p className="toast-title">{t("objread.notice.title", { event: toast.event })}</p>
          <p className="toast-line">{t("objread.notice.line", { count: toast.count })}</p>
        </div>
      </div>
    );
  }

  // A live event's entry rules read on its page: its squad can be built now
  if (toast.kind === "rules") {
    const line = toast.cap ? t("rules.notice.cap", { rating: toast.cap[0], count: toast.cap[1] }) : toast.min != null && toast.max != null ? t("rules.notice.range", { min: toast.min, max: toast.max }) : toast.min != null ? t("rules.notice.min", { min: toast.min }) : toast.max != null ? t("rules.notice.max", { max: toast.max }) : t("rules.notice.any");
    return (
      <div className="toast read best" key={`rules-${toast.event}`} role="status">
        <span className="toast-mark read" aria-hidden="true"><i className="dot" /></span>
        <div className="toast-body">
          <p className="toast-title">{t("rules.notice.title", { event: toast.event.replace(/(^| )(\S)/g, (_m, a: string, c: string) => a + c.toUpperCase()) })}</p>
          <p className="toast-line">{line}</p>
        </div>
      </div>
    );
  }

  // Evolutions: one activated or paused in the game – the bench follows
  if (toast.kind === "evo") {
    return (
      <div className="toast read" key={`evo-${toast.evo}-${toast.active}`} role="status">
        <span className="toast-mark read" aria-hidden="true"><i className="dot" /></span>
        <div className="toast-body">
          <p className="toast-title">{t(toast.active ? "evo.notice.on" : "evo.notice.off", { evo: toast.evo, player: toast.player || toast.evo })}</p>
          <p className="toast-line">{t(toast.active ? "evo.notice.onLine" : "evo.notice.offLine")}</p>
        </div>
      </div>
    );
  }

  // Match reminders: an evolution player to sub on (or one that has to start)
  if (toast.kind === "match-reminder") {
    return (
      <div className={`toast better reminder ${toast.now ? "now" : ""}`} key={`match-reminder-${toast.at}`} role="status">
        <span className="toast-mark better" aria-hidden="true">
          {toast.at === 0 ? (toast.needs.every((n) => n.bench) ? "XI" : t("v2panel.tagEvo")) : `${toast.at}:00`}
        </span>
        <div className="toast-body">
          <p className="toast-title">
            {toast.now && toast.needs.length === 1 && !toast.needs[0].bench && !toast.needs[0].start
              ? t("v2panel.toast.subNow", { player: toast.needs[0].player })
              : toast.now ? t("remind.title", { minute: toast.at }) : toast.at === 0 ? (toast.needs.every((n) => n.bench) ? t("remind.loadBench") : t("remind.loadTitle")) : t("remind.moment", { minute: toast.at })}
          </p>
          {toast.needs.slice(0, 3).map((n, i) => (
            <p className="toast-line" key={i}>
              {n.start
                ? t("remind.starts", { player: n.player, evo: n.evo })
                : toast.now
                  ? n.bench
                    ? t("remind.subFor", { player: n.player, what: n.evo })
                    : toast.needs.length === 1
                      ? t("squads.evo.level", { name: n.evo, level: n.level, levels: n.levels })
                      : t("remind.subOn", { player: n.player, evo: n.evo, level: n.level, levels: n.levels })
                  : n.bench
                    ? t("remind.benchFor", { player: n.player, what: n.evo, minute: n.at })
                    : t("remind.bench", { player: n.player, evo: n.evo, minute: n.at })}
            </p>
          ))}
        </div>
      </div>
    );
  }

  if (toast.kind === "recording") {
    return (
      <div className="toast better" key="recording" role="status">
        <span className="toast-mark better" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 8.4l3 3 6-6.6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="square" /></svg></span>
        <div className="toast-body">
          <p className="toast-title">{t("toast.recTitle")}</p>
          <p className="toast-line">{t("toast.recLine")}</p>
        </div>
      </div>
    );
  }

  // Every wait visible: what is being read right now.
  if (toast.kind === "progress") {
    const title =
      toast.what === "set"
        ? t("progress.set", { name: toast.name ?? "" })
        : toast.what === "swap"
          ? t("progress.swap", { name: toast.name ?? "" })
          : toast.what === "bidding"
            ? t("progress.bidding", { name: toast.name ?? "" })
            : t("progress.newItems");
    return (
      <div className="toast progress" key={`progress-${toast.what}-${toast.name ?? ""}`}>
        <span className="toast-mark progress" aria-hidden="true"><i className="bar loading"><i /></i></span>
        <div className="toast-body">
          <p className="toast-title">{title}</p>
          <p className="toast-line">{t(toast.what === "new_items" ? "progress.newItemsLine" : toast.what === "bidding" ? "progress.biddingLine" : "progress.setLine")}</p>
        </div>
      </div>
    );
  }

  // A read that needs nothing from the user – said, so a read never looks like no read.
  if (toast.kind === "read") {
    const title =
      toast.state === "nothing_new"
        ? t("read.newItems")
        : toast.state === "swap"
          ? t("read.swap", { set: toast.set_name })
          : t("read.set", { set: toast.set_name });
    const line =
      toast.state === "best"
        ? t("read.bestLine", { total: num(toast.total ?? 0) })
        : toast.state === "unclear"
          ? t("read.unclearLine")
          : toast.state === "nothing_new"
            ? t("read.newItemsLine")
            : toast.state === "swap"
              ? t("read.swapLine", { count: toast.cards })
              : t("read.setLine", { count: toast.cards });
    return (
      <div className={`toast read ${toast.state}`} key={`read-${toast.state}-${toast.set_name}`}>
        <span className="toast-mark read" aria-hidden="true"><i className="dot" /></span>
        <div className="toast-body">
          <p className="toast-title">
            {title}
            {toast.state !== "unclear" && <span className="toast-ok">✓</span>}
          </p>
          <p className="toast-line">{line}</p>
        </div>
      </div>
    );
  }

  if (toast.kind === "sync") {
    // Sync progress while the game runs: stay out of Ultimate Team until it is done.
    if (toast.state === "login") {
      // Action needed: the sync can't start without a signed-in Web App.
      return (
        <div className="toast sync login" key="sync-login" role="alert">
          <span className="toast-mark sync login" aria-hidden="true">
            {toast.reason === "no_extension" ? (
              <svg viewBox="0 0 16 16">
                <path d="M8 2l6.5 11.5h-13z" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <path d="M8 6.5v3.4M8 11.3v.9" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            ) : (
              "!"
            )}
          </span>
          <div className="toast-body">
            <p className="toast-title">
              {t(toast.reason === "no_extension" ? "toast.syncNoExtension" : "toast.syncLogin")}
            </p>
            <p className="toast-line">
              {t(toast.reason === "no_extension" ? "toast.syncNoExtensionLine" : toast.reason === "webapp_not_ready" ? "toast.syncNotReadyLine" : "toast.syncLoginLine")}
            </p>
          </div>
        </div>
      );
    }
    if (toast.state === "suggest") {
      // FC 27 closed after Ultimate Team: a sync is due – the user starts it (the browser never
      // opens by itself)
      return (
        <div className="toast sync running" key="sync-suggest" role="status">
          <span className="toast-mark sync running" aria-hidden="true"><i className="bar loading"><i /></i></span>
          <div className="toast-body">
            <p className="toast-title">{t("toast.syncSuggest")}</p>
            <p className="toast-line">{t("toast.syncSuggestLine")}</p>
          </div>
        </div>
      );
    }
    const key = toast.state === "running" ? "syncRunning" : toast.state === "done" ? "syncDone" : "syncAborted";
    return (
      <div className={`toast sync ${toast.state}`} key={`sync-${toast.state}`}>
        <span className={`toast-mark sync ${toast.state}`} aria-hidden="true">
          {toast.state === "done" ? <svg viewBox="0 0 16 16"><path d="M3.5 8.4l3 3 6-6.6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="square" /></svg> : toast.state === "running" ? (toast.phase === "club" && toast.count ? <span className="num">{toast.count}</span> : <i className="bar loading"><i /></i>) : "II"}
        </span>
        <div className="toast-body">
          <p className="toast-title">{t(`toast.${key}` as MessageKey)}</p>
          <p className="toast-line">
            {toast.state === "running" && toast.phase === "gallery"
              ? t("toast.syncGalleryLine", { set: toast.set ?? "", done: toast.done ?? 0, total: toast.total ?? 0 })
              : toast.state === "running" && toast.phase === "club"
                ? t("toast.syncClubLine", { count: num(toast.count ?? 0) })
                : t(`toast.${key}Line` as MessageKey, { count: toast.count ?? 0 })}
          </p>
        </div>
      </div>
    );
  }

  // Pack / bought cards on New Items: Gallery impact of the cards on screen. A card that was
  // collected without first owner and is now packed leads the toast ("upgraded").
  const top = toast.cards.slice(0, 3);
  const upgraded = toast.cards.filter((c) => c.upgraded);
  const newFo = toast.cards.filter((c) => c.new_first_owner);
  // One card: say what it does – a new first owner, a new card for an incomplete set, or a better lineup.
  const one = toast.cards.length === 1 ? toast.cards[0] : null;
  return (
    <div className={`toast ${upgraded.length ? "upgrade" : ""}`} key={top.map((c) => c.def_id).join("-")}>
      <span className={`toast-mark ${upgraded.length ? "upgrade" : "pack"}`} aria-hidden="true">{upgraded.length ? <span className="num">{t("v2panel.fo")}</span> : null}</span>
      <div className="toast-body">
        <p className="toast-title">
          {upgraded.length === 1
            ? t("toast.upgradedOne", { name: upgraded[0].name })
            : upgraded.length > 1
              ? t("toast.upgradedMany", { count: upgraded.length })
              : newFo.length === 1
                ? t("toast.newFoOne", { set: newFo[0].set })
                : newFo.length > 1
                  ? t("toast.newFoMany", { count: newFo.length })
                  : one?.fills
                    ? t("toast.fillsOne", { set: one.set, n: one.fills[0], slots: one.fills[1] })
                    : one && one.gain > 0
                      ? t("toast.improvesOne", { name: one.name, set: one.set })
                      : t("toast.packTitle", { count: toast.cards.length })}
          {upgraded.length === 0 && newFo.length === 0 && <span className="toast-note">{t(toast.first_owner ? "toast.asFirstOwner" : "toast.notFirstOwner")}</span>}
          {toast.regrade && <span className="toast-ok">{t("toast.regrade")}</span>}
        </p>
        <p className="toast-line">
          {top.map((c, i) => (
            <span key={c.def_id} className="toast-card">
              {i > 0 && " · "}
              <b>{c.name}</b>{" "}
              {c.upgraded ? t("toast.upgradedCard") : c.new ? t("toast.newFor", { set: c.set }) : t("toast.alreadyIn", { set: c.set })}{" "}
              {c.gain > 0 && (
                <span className="toast-delta up">
                  <Gem size={9} /> +{compact(c.gain)}
                </span>
              )}
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}
