import { useEffect, useState } from "react";
import { events, type ToastPayload } from "./api";
import { compact, num } from "./format";
import { t, useLocale, type MessageKey } from "./i18n";
import { Gem } from "./icons";
import { useTheme } from "./theme";
import "./overlay.css";

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

  if (!toast) return null;

  if (toast.kind === "better") {
    const b = toast.better;
    return (
      <div className="toast better" key={`better-${toast.set_key}-${b.best}`}>
        <span className="toast-mark better" aria-hidden="true" />
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
        <span className="toast-mark better" aria-hidden="true" />
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
        <span className="toast-mark" aria-hidden="true" />
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
        <span className="toast-mark better" aria-hidden="true" />
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
        <span className="toast-mark better" aria-hidden="true" />
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
        <span className="toast-mark read" aria-hidden="true" />
        <div className="toast-body">
          <p className="toast-title">{t("champs.toastTitle", { n: toast.n ?? "?" })}</p>
          <p className="toast-line">
            {[`${outcome} ${score}${toast.aet ? ` ${t("champs.aet")}` : ""}`, toast.opponent, toast.when_left ? t("champs.whenLeft", { score: `${toast.when_left[0]}–${toast.when_left[1]}`, minute: toast.minute ?? 0 }) : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="toast-line">{t("champs.toastRecord", { wins: toast.wins, losses: toast.losses, left: toast.remaining })}</p>
        </div>
      </div>
    );
  }

  if (toast.kind === "welcome") {
    return (
      <div className="toast read best" key="welcome" role="status">
        <span className="toast-mark read" aria-hidden="true" />
        <div className="toast-body">
          <p className="toast-title">{t("toast.welcome")}</p>
          <p className="toast-line">{t("toast.welcomeLine", { count: num(toast.players) })}</p>
        </div>
      </div>
    );
  }

  if (toast.kind === "recording") {
    return (
      <div className="toast better" key="recording" role="status">
        <span className="toast-mark better" aria-hidden="true" />
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
        <span className="toast-mark progress" aria-hidden="true" />
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
        <span className="toast-mark read" aria-hidden="true" />
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
          <span className="toast-mark sync login" aria-hidden="true" />
          <div className="toast-body">
            <p className="toast-title">
              <span className="toast-action">{t("toast.actionNeeded")}</span>
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
          <span className="toast-mark sync running" aria-hidden="true" />
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
        <span className={`toast-mark sync ${toast.state}`} aria-hidden="true" />
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
      <span className={`toast-mark ${upgraded.length ? "upgrade" : "pack"}`} aria-hidden="true" />
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
