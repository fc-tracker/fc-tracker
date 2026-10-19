import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  api,
  events,
  formatAge,
  regradeGain,
  type CurrentPage,
  type GalleryCardView,
  type GalleryStatus,
  type GalleryCategory,
  type GallerySet,
  type GameSession,
  type OverlayMode,
  type SwapSuggestion,
  type SyncSummary,
} from "./api";
import { cardTier, num } from "./format";
import { rarity } from "./rarities";
import { t, useLocale, type MessageKey } from "./i18n";
import { Gem } from "./icons";
import { THEMES, useTheme } from "./theme";
import { SupportButton } from "./Support";
import { PadButton, useInputMode } from "./padGlyphs";
import "./overlay.css";

/** Angular grade badge (D/C/B/A/S). Unknown grade renders as an empty outline. */
function GradeDiamond({ grade, size = 44 }: { grade: string | null | undefined; size?: number }) {
  const g = grade ?? "";
  return (
    <span className={`diamond grade-${g ? g.toLowerCase() : "none"}`} style={{ width: size, height: size }}>
      <span className="diamond-face" />
      <span className="diamond-letter" style={{ fontSize: size * 0.48 }}>
        {g || "–"}
      </span>
    </span>
  );
}


const FO_MARK: Record<GalleryCardView["first_owner"], string> = {
  known: "1", manual: "1", scanned: "1", unknown: "?", manual_no: "×", scanned_no: "", club_no: "", none: "",
};

/** Statuses that read as "first owner" / "not first owner" (for the menu's current choice). */
const FO_YES: GalleryCardView["first_owner"][] = ["known", "manual", "scanned"];
const FO_NO: GalleryCardView["first_owner"][] = ["manual_no", "scanned_no", "club_no"];

/** What the card menu offers, in order (controller ↑↓ and ✕ / A, keyboard ↑↓ Enter, mouse). */
const MENU = ["first_owner", "purchased", "back"] as const;
type MenuChoice = (typeof MENU)[number];

/** Small menu attached to a card's top-right corner: mark first owner / purchased, or back. */
function CardMenu({ card, index, toLeft, onChoose }: { card: GalleryCardView; index: number; toLeft: boolean; onChoose: (c: MenuChoice) => void }) {
  const current: MenuChoice | null = FO_YES.includes(card.first_owner) ? "first_owner" : FO_NO.includes(card.first_owner) ? "purchased" : null;
  return (
    <div className={`card-menu ${toLeft ? "to-left" : ""}`} role="menu" onClick={(e) => e.stopPropagation()}>
      <p className="card-menu-title">{card.name ?? "?"}</p>
      {MENU.map((c, i) => (
        <button
          key={c}
          type="button"
          role="menuitem"
          className={`card-menu-item ${i === index ? "focused" : ""} ${c === current ? "current" : ""} item-${c}`}
          onClick={() => onChoose(c)}
        >
          <span className="card-menu-mark" aria-hidden="true">
            {c === "first_owner" ? "1" : c === "purchased" ? "×" : "‹"}
          </span>
          {t(`overlay.menu.${c}` as MessageKey)}
        </button>
      ))}
    </div>
  );
}

/** What the marks on a card mean, in the order shown in the info box. */
const LEGEND: GalleryCardView["first_owner"][] = ["scanned", "known", "manual", "manual_no"];

/** Info box on a card (▢ / X, I, right-click): type, first-owner status and where it comes from. */
function CardInfo({ card, toLeft, missing }: { card: GalleryCardView; toLeft: boolean; missing: boolean }) {
  const r = rarity(card.rareflag);
  return (
    <div className={`card-menu card-info ${toLeft ? "to-left" : ""}`} role="tooltip" onClick={(e) => e.stopPropagation()}>
      <p className="card-menu-title">{card.name ?? "?"}</p>
      {r.name && <p className="card-info-type">{r.name}{card.holo ? ` · ${t("overlay.info.holo")}` : ""}</p>}
      <p className="card-info-status">{missing ? t("overlay.info.missing") : t(`overlay.fo.${card.first_owner}` as MessageKey)}</p>
      {!missing && <ul className="card-info-legend">
        {LEGEND.map((s) => (
          <li key={s} className={s === card.first_owner ? "current" : ""}>
            <span className={`legend-mark mini-fo fo-${s}`}>{FO_MARK[s] || "–"}</span>
            {t(`overlay.fo.${s}` as MessageKey)}
          </li>
        ))}
      </ul>}
    </div>
  );
}

/** Focus + menu state of the card area, shared by keyboard, controller and mouse. */
export type CardUi = {
  focused: string | null;
  info: { key: string; toLeft: boolean } | null;
  onInfo: (key: string) => void;
  onSwapDone: (swaps: SwapSuggestion[]) => void;
  menu: { key: string; index: number; toLeft: boolean } | null;
  onOpen: (key: string, card: GalleryCardView) => void;
  onChoose: (card: GalleryCardView, c: MenuChoice) => void;
};

function MiniCard({ card, ghost = false, index, cardKey, ui }: {
  card: GalleryCardView;
  ghost?: boolean;
  index: number;
  cardKey: string;
  ui: CardUi;
}) {
  // Missing cards (not owned) have no first-owner status to show or set.
  const mark = ghost ? "" : FO_MARK[card.first_owner];
  const tier = cardTier(card);
  const r = rarity(card.rareflag);
  const menuOpen = ui.menu?.key === cardKey;
  const infoOpen = !menuOpen && ui.info?.key === cardKey;
  // Anonymous in-game slots (card not identified) and missing cards can't be marked.
  const markable = card.slot == null && !ghost;
  return (
    <div className={`card-cell ${menuOpen || infoOpen ? "menu-open" : ""} ${ui.focused === cardKey ? "focused" : ""}`}>
    <button
      type="button"
      data-key={cardKey}
      className={`mini-card tier-${tier} ${tier === "special" ? `rar-${r.family}` : ""} ${card.holo ? "holo" : ""} ${ghost ? "ghost" : ""} ${ui.focused === cardKey ? "focused" : ""}`}
      style={{ animationDelay: `${index * 18}ms` }}
      onClick={(e) => {
        e.stopPropagation();
        if (markable) ui.onOpen(cardKey, card);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        ui.onInfo(cardKey);
      }}
      title={[r.name, t(`overlay.fo.${card.first_owner}` as MessageKey)].filter(Boolean).join(" · ")}
    >
      <div className="mini-points">
        <Gem size={9} />
        {num(card.score)}
      </div>
      <div className="mini-body">
        <span className="mini-rating">{card.rating ?? "?"}</span>
        <span className="mini-pos">{card.position ?? ""}</span>
        <span className="mini-name">{card.name ?? (card.slot != null ? t("swaps.slot", { n: card.slot + 1 }) : "?")}</span>
      </div>
      {mark && <span className={`mini-fo fo-${card.first_owner}`}>{mark}</span>}
    </button>
    {infoOpen && ui.info && <CardInfo card={card} toLeft={ui.info.toLeft} missing={ghost} />}
    {menuOpen && ui.menu && <CardMenu card={card} index={ui.menu.index} toLeft={ui.menu.toLeft} onChoose={(c) => ui.onChoose(card, c)} />}
    </div>
  );
}

// Tag id → in-game colour group (ids as in src-tauri/src/gallery.rs).
const TAG_TONES: Record<number, string> = {
  1: "gold", 7: "gold",
  21: "position", 22: "position", 23: "position", 20: "position", 5: "position", 10: "position",
  12: "special", 2: "special", 19: "special", 18: "special",
  11: "silver", 4: "bronze",
};
const tagTone = (id: number) => TAG_TONES[id] ?? "composition";

function tagName(id: number, fallback: string) {
  const key = `tag.${id}` as MessageKey;
  const v = t(key);
  return v === key ? fallback : v;
}

export function SetRow({ set, active, onSelect, index }: { set: GallerySet; active: boolean; onSelect: () => void; index: number }) {
  const filled = Math.min(set.collected, set.slots);
  const pct = Math.round((filled / set.slots) * 100);
  return (
    <button
      className={`set-row ${active ? "active" : ""} ${set.complete ? "complete" : ""}`}
      onClick={onSelect}
      style={{ animationDelay: `${index * 22}ms` }}
      aria-pressed={active}
    >
      <span className="set-row-main">
        <span className="set-row-name">{set.name}</span>
        <span className="set-row-meta">
          <span className="set-row-slots">
            {filled}/{set.slots}
          </span>
          {set.max_tokens > 0 && (
            <span className="set-row-tokens" title={t("overlay.tokensOf", { count: set.tokens, max: set.max_tokens })}>
              {set.tokens}/{set.max_tokens}
            </span>
          )}
          <span className="set-row-score">
            <Gem size={10} /> {num(set.score)}
            {set.listed?.score != null && set.listed.score === set.score && (
              <span className="set-row-check" title={t("overlay.listedSame")}>✓</span>
            )}
            {regradeGain(set) && (
              <span className="set-row-regrade" title={t("overlay.regradeHint")}>
                ↻
              </span>
            )}
          </span>
        </span>
        <span className="bar">
          <span className="bar-fill" style={{ width: `${pct}%` }} />
        </span>
      </span>
      <GradeDiamond grade={set.grade?.grade} size={30} />
    </button>
  );
}

/** Grading is manual in-game: say when pressing Regrade (Space / ▢) would pay off. */
function Regrade({ set }: { set: GallerySet }) {
  const gain = regradeGain(set);
  if (!gain) return null;
  // No swaps (the cards in the current selection aren't known one by one): the best selection
  // itself is the advice – which cards to put in.
  const target = set.swaps.length === 0 && !set.from_ingame ? set.lineup : [];
  return (
    <div className="regrade" role="note">
      <span className="regrade-icon" aria-hidden="true">
        ↻
      </span>
      <span className="regrade-body">
        <span>
          <strong>{t("overlay.regradeTitle")}</strong>{" "}
          {gain.cards > 0 && t("overlay.regradeCards", { count: gain.cards })}
          {gain.cards > 0 && gain.points > 0 && " · "}
          {gain.points > 0 && t("overlay.regradePoints", { points: num(gain.points) })}
        </span>
        {target.length > 0 && (
          <>
            <small className="regrade-sub">{t("overlay.regradeSelection", { count: target.length })}</small>
            <span className="regrade-cards">
              {target.map((c) => (
                <SwapCard key={c.def_id} card={c} />
              ))}
            </span>
          </>
        )}
      </span>
    </div>
  );
}

function Step({ state, children }: { state: "done" | "todo" | "warn"; children: ReactNode }) {
  return (
    <li className={`step ${state}`}>
      <span className="step-mark" aria-hidden="true">
        <i>{state === "done" ? "✓" : state === "warn" ? "!" : ""}</i>
      </span>
      <span>{children}</span>
    </li>
  );
}

/**
 * How far the app has read this set in-game: 1. the set page (the selection) · 2. the result –
 * swaps or "already the best". The rest of the club comes from the sync, no paging needed.
 * Everything is read automatically – the user only opens the pages in-game.
 */
function InGamePanel({ set }: { set: GallerySet }) {
  if (!set.tracked || set.collected === 0) return null;
  const g = set.ingame;
  const gain = g?.total != null ? Math.max(0, set.score - g.total) : 0;
  return (
    <section className="ingame">
      <h2>{t("ingame.title")}</h2>
      <ol className="steps">
        {!g ? (
          <Step state="todo">{t("ingame.step.open", { set: set.name })}</Step>
        ) : g.verified ? (
          <Step state="done">{t("ingame.step.read", { points: g.total != null ? num(g.total) : "–" })}</Step>
        ) : (
          <Step state="warn">{t("ingame.step.unclear")}</Step>
        )}
        {g?.user_swapped && <Step state="warn">{t("ingame.step.userSwapped", { set: set.name })}</Step>}
        {/* No Swap Player paging: the rest of the selection comes from the club sync. */}
        {g?.verified &&
          (set.swaps.length > 0 ? (
            g.exact ? (
              <Step state="done">
                <strong className="ingame-better">{t("ingame.step.swapsReady", { count: set.swaps.length, points: num(gain) })}</strong>
              </Step>
            ) : (
              // not every card of the in-game selection is known: our estimate, not a fact
              <Step state="warn">{t("ingame.step.swapsLikely", { count: set.swaps.length, points: num(gain) })}</Step>
            )
          ) : gain > 0 ? (
            <Step state="warn">{t("ingame.step.unmatched")}</Step>
          ) : (
            <Step state="done">{t("ingame.best")}</Step>
          ))}
      </ol>
    </section>
  );
}

function SwapCard({ card }: { card: GalleryCardView }) {
  const fo = FO_MARK[card.first_owner];
  return (
    <span className={`swap-card tier-${cardTier(card)} rar-${rarity(card.rareflag).family} ${card.holo ? "holo" : ""}`}>
      <b>{card.rating ?? "?"}</b>
      <span className="swap-name">{card.name ?? (card.slot != null ? t("swaps.slot", { n: card.slot + 1 }) : "?")}</span>
      <span className="swap-points">
        <Gem size={9} /> {num(card.score)}
      </span>
      {fo && <span className={`swap-fo fo-${card.first_owner}`}>{fo}</span>}
    </span>
  );
}

/**
 * The whole best selection (when it beats the in-game one): every card it holds, the ones to put
 * in marked – one overview instead of a list of swaps. "Done" = the user made the changes in-game.
 */
function BestSelection({ set, ui }: { set: GallerySet; ui: CardUi }) {
  const swaps = set.swaps;
  if (!swaps.length) return null;
  const putIn = new Set(swaps.map((sw) => sw.into.def_id));
  const gain = set.ingame?.total != null ? Math.max(0, set.score - set.ingame.total) : 0;
  return (
    <section className="detail-section swaps">
      <h2>
        {t("best.title", { count: set.lineup.length })}
        {gain > 0 && (
          <span className="best-gain">
            <Gem size={10} /> +{num(gain)}
          </span>
        )}
        <button
          type="button"
          data-key="s:all"
          className={`swap-done ${ui.focused === "s:all" ? "focused" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            ui.onSwapDone(swaps);
          }}
          title={t("swaps.doneHint")}
        >
          ✓ {t("swaps.allDone")}
        </button>
      </h2>
      <p className="verify-hint">{t("best.overlayHint", { count: putIn.size })}</p>
      <span className="best-grid">
        {[...set.lineup].sort((a, b) => Number(putIn.has(b.def_id)) - Number(putIn.has(a.def_id))).map((c, i) => (
          <span key={c.def_id} className={putIn.has(c.def_id) ? "best-cell put-in" : "best-cell"} style={{ animationDelay: `${i * 20}ms` }}>
            <SwapCard card={c} />
            {putIn.has(c.def_id) && <small className="best-putin">{t("best.putIn")}</small>}
          </span>
        ))}
      </span>
    </section>
  );
}

/** The in-game Rewards ladder: grade, score threshold and tokens per grade. */
function Ladder({ set }: { set: GallerySet }) {
  const reached = set.grade?.grade ?? null;
  const reachedIndex = set.ladder.findIndex((g) => g.grade === reached);
  return (
    <div className="ladder">
      {set.ladder.map((step, i) => {
        const state = i <= reachedIndex ? "reached" : i === reachedIndex + 1 ? "next" : "";
        return (
          <div key={step.grade} className={`ladder-step ${state}`}>
            <GradeDiamond grade={step.grade} size={34} />
            <span className="ladder-score">
              <Gem size={9} /> {num(step.score)}
            </span>
            <span className="ladder-tokens">{step.tokens > 0 ? t("overlay.tokens", { count: step.tokens }) : "–"}</span>
          </div>
        );
      })}
    </div>
  );
}

export function SetDetail({ set, ui }: { set: GallerySet; ui: CardUi }) {
  const filled = Math.min(set.collected, set.slots);
  const empty = Math.max(0, set.slots - set.lineup.length);
  return (
    <div className="detail" key={set.key}>
      <div className="detail-head">
        <div>
          <p className="eyebrow">
            {t(set.kind === "club" ? "overlay.kindClub" : set.kind === "rarity" ? "overlay.kindRarity" : "overlay.kindLeague")}
            {" · "}
            {t("overlay.tokensOf", { count: set.tokens, max: set.max_tokens })}
          </p>
          <h1 className="detail-title">{set.name}</h1>
          <p className="detail-sub">
            {t("overlay.collectedOf", { collected: num(set.collected), total: num(set.total) })}
          </p>
        </div>
        <div className="detail-grade">
          <GradeDiamond grade={set.grade?.grade} size={84} />
        </div>
      </div>

      <div className="score-panel">
        <div className="score-total">
          <span className="score-label" title={t(set.from_ingame ? "overlay.fromIngame" : "overlay.bestNote")}>
            {set.ingame?.total != null && set.score > set.ingame.total
              ? t("overlay.scoreBest")
              : set.ingame?.verified
                ? t("overlay.scoreIngame")
                : t("overlay.totalScore")}{" "}
            ⓘ
          </span>
          <span className="score-value">
            <Gem size={18} /> {num(set.score)}
          </span>
        </div>
        <dl className="score-split">
          <div>
            <dt>{t("overlay.base")}</dt>
            <dd>{num(set.base)}</dd>
          </div>
          <div>
            <dt>{t("overlay.bonus")}</dt>
            <dd>{num(set.bonus)}</dd>
          </div>
        </dl>
        <p className="score-note">
          {!set.tracked
            ? t("overlay.notTracked")
            : !set.complete
              ? t("overlay.toComplete", { count: set.slots - filled, slots: set.slots })
              : set.grade
                ? set.grade.next
                  ? t("overlay.toNextGrade", { points: num(set.grade.points_to_next), grade: set.grade.next.grade })
                  : t("overlay.maxGrade")
                : t("overlay.gradeUnknown")}
        </p>
      </div>

      <Regrade set={set} />
      <InGamePanel set={set} />
      <BestSelection set={set} ui={ui} />

      {set.ladder.length > 0 && (
        <section className="detail-section">
          <h2>
            {t("overlay.rewards")}
            {!set.verified && <span className="unverified"> · {t("overlay.unverified")}</span>}
          </h2>
          <Ladder set={set} />
        </section>
      )}

      {set.tags.length > 0 && (
        <div className="tags">
          {set.tags.map((tag) => (
            <span
              key={tag.id}
              className={`tag ${tag.counts ? "counts" : ""}`}
              data-tone={tagTone(tag.id)}
              title={`${tag.count} · ${tag.pct}%`}
            >
              {tagName(tag.id, tag.name)}
              {tag.bonus > 0 && <b>+{num(tag.bonus)}</b>}
            </span>
          ))}
        </div>
      )}

      <section className="detail-section">
        <h2>{t("overlay.lineup", { count: set.lineup.length, slots: set.slots })}</h2>
        <div className="card-grid">
          {set.lineup.map((c, i) => (
            <MiniCard key={`${c.def_id}-${c.slot ?? ""}`} card={c} index={i} cardKey={`l:${c.def_id}:${c.slot ?? ""}`} ui={ui} />
          ))}
          {Array.from({ length: Math.min(empty, 30) }, (_, i) => (
            <div key={`e${i}`} className="mini-card empty" />
          ))}
        </div>
      </section>

      {set.top_missing.length > 0 && (
        <section className="detail-section">
          <h2>{t("overlay.topMissing")}</h2>
          <div className="card-grid">
            {set.top_missing.map((c, i) => (
              <MiniCard key={c.def_id} card={c} ghost index={i} cardKey={`m:${c.def_id}`} ui={ui} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export default function Overlay() {
  useLocale();
  const [theme, setTheme] = useTheme();
  const [sync, setSync] = useState<SyncSummary | null>(null);
  const [categories, setCategories] = useState<GalleryCategory[]>([]);
  // every wait visible: the first overview takes a moment on big clubs
  const [loadingGallery, setLoadingGallery] = useState(true);
  const [catKey, setCatKey] = useState<string | null>(null);
  const [setKey, setSetKey] = useState<string | null>(null);
  const [page, setPage] = useState<CurrentPage | null>(null);
  const [tracking, setTracking] = useState(true);
  const [mode, setMode] = useState<OverlayMode>("panel");
  const [missingOn, setMissingOn] = useState(false);
  const [status, setStatus] = useState<GalleryStatus | null>(null);
  const [session, setSession] = useState<GameSession>("unknown");
  // Set to show after Ctrl+Shift+G, applied once the overview contains it.
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const load = useCallback(() => {
    api.syncSummary().then(setSync).catch(() => {});
    api
      .galleryOverview()
      .then(setCategories)
      .catch(() => {})
      .finally(() => setLoadingGallery(false));
    api.galleryStatus().then(setStatus).catch(() => {});
  }, []);

  const visible = useMemo(
    () =>
      categories
        .filter((c) => c.sets.some((s) => s.total > 0))
        // Untracked sets stay visible (with a note) so the category mirrors the in-game list.
        .map((c) => ({ ...c, sets: c.sets.filter((s) => s.total > 0 || !s.tracked) })),
    [categories],
  );
  const category = visible.find((c) => c.key === catKey) ?? visible[0];
  const selected = category?.sets.find((s) => s.key === setKey) ?? category?.sets[0];

  // Where the controller / keyboard is: the set list, or the cards of the selected set (with an
  // optional card menu open). Mouse clicks use the same state.
  const [zone, setZone] = useState<"list" | "cards">("list");
  const [focused, setFocused] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ key: string; index: number; card: GalleryCardView; toLeft: boolean } | null>(null);
  const [info, setInfo] = useState<{ key: string; toLeft: boolean } | null>(null);
  const toLeftOf = (key: string) => {
    const r = document.querySelector(`.detail [data-key="${key}"]`)?.getBoundingClientRect();
    return !!r && r.right + 170 > window.innerWidth;
  };

  const choose = useCallback(
    (card: GalleryCardView, c: MenuChoice) => {
      setMenu(null);
      if (c === "back") return;
      api.setFirstOwner(card.def_id, c === "first_owner").then(load).catch(() => {});
    },
    [load],
  );
  const cardUi: CardUi = {
    focused: zone === "cards" ? focused : null,
    info,
    onInfo: (key) => {
      setMenu(null);
      setZone("cards");
      setFocused(key);
      setInfo((i) => (i?.key === key ? null : { key, toLeft: toLeftOf(key) }));
    },
    onSwapDone: async (swaps) => {
      if (!selected) return;
      for (const sw of swaps) await api.markSwapDone(selected.key, sw).catch(() => false);
      load();
    },
    menu,
    onOpen: (key, card) => {
      setInfo(null);
      setZone("cards");
      setFocused(key);
      const r = document.querySelector(`.detail [data-key="${key}"]`)?.getBoundingClientRect();
      setMenu({ key, card, index: FO_NO.includes(card.first_owner) ? 1 : 0, toLeft: !!r && r.right + 170 > window.innerWidth });
    },
    onChoose: choose,
  };

  // Opened while a screen recorder runs (no focus: the controller stays with the game).
  const [passive, setPassive] = useState(false);
  useEffect(() => {
    const un = events.onOverlayPassive(setPassive);
    return () => {
      un.then((u) => u());
    };
  }, []);

  // Closed by holding View: vanish at once (the window itself hides when the button is up).
  useEffect(() => {
    const show = () => document.documentElement.classList.remove("ov-vanish");
    const un = events.onOverlayVanish((v) => document.documentElement.classList.toggle("ov-vanish", v));
    const onVis = () => document.visibilityState === "visible" && show();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      un.then((u) => u());
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Ctrl+Shift+G: jump to the set shown in-game (category + set).
  useEffect(() => {
    if (!focusKey) return;
    const cat = visible.find((c) => c.sets.some((s) => s.key === focusKey)) ?? categories.find((c) => c.sets.some((s) => s.key === focusKey));
    if (!cat) return;
    setCatKey(cat.key);
    setSetKey(focusKey);
    setFocusKey(null);
    requestAnimationFrame(() => document.querySelector(`[data-set="${focusKey}"]`)?.scrollIntoView({ block: "nearest" }));
  }, [focusKey, visible, categories]);

  // The click-through missing-players list follows the set picked here.
  const selectedKey = selected?.key;
  useEffect(() => {
    if (selectedKey && (catKey || setKey)) api.followSet(selectedKey).catch(() => {});
  }, [selectedKey, catKey, setKey]);

  const changeMode = (m: OverlayMode) => {
    setMode(m);
    api.setOverlayMode(m).catch(() => {});
  };

  const toggleTracking = () => {
    const next = !tracking;
    setTracking(next);
    api.setAutoScan(next).catch(() => {});
  };

  const moveCategory = useCallback(
    (dir: number) => {
      if (!visible.length || !category) return;
      const i = visible.indexOf(category);
      const next = visible[(i + dir + visible.length) % visible.length];
      setCatKey(next.key);
      setSetKey(null);
      setZone("list");
      setMenu(null);
      requestAnimationFrame(() => document.querySelector(`[data-cat="${next.key}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest" }));
    },
    [visible, category],
  );


  const moveSet = useCallback(
    (dir: number) => {
      if (!category || !selected) return;
      const i = category.sets.indexOf(selected);
      const next = category.sets[Math.max(0, Math.min(category.sets.length - 1, i + dir))];
      setSetKey(next.key);
      document.querySelector(`[data-set="${next.key}"]`)?.scrollIntoView({ block: "nearest" });
    },
    [category, selected],
  );

  // Into the selected set's cards (first card focused).
  const enterCards = useCallback(() => {
    // The first card – never a "Done" button (one ✕ / A must not mark swaps by accident).
    const first = document.querySelector<HTMLElement>(".detail .mini-card[data-key]") ?? document.querySelector<HTMLElement>(".detail [data-key]");
    if (!first) return;
    setZone("cards");
    setFocused(first.dataset.key ?? null);
  }, []);

  // Move between cards on screen: the nearest card in that direction (rows wrap like a grid).
  const moveCard = useCallback(
    (dir: "up" | "down" | "left" | "right") => {
      const all = Array.from(document.querySelectorAll<HTMLElement>(".detail [data-key]"));
      const cur = all.find((e) => e.dataset.key === focused);
      if (!cur) return enterCards();
      const c = cur.getBoundingClientRect();
      const cx = c.left + c.width / 2;
      const cy = c.top + c.height / 2;
      let best: HTMLElement | null = null;
      let bestScore = Infinity;
      for (const e of all) {
        if (e === cur) continue;
        const r = e.getBoundingClientRect();
        const dx = r.left + r.width / 2 - cx;
        const dy = r.top + r.height / 2 - cy;
        const sameRow = Math.abs(dy) < c.height / 2;
        const ok = dir === "left" ? sameRow && dx < 0 : dir === "right" ? sameRow && dx > 0 : dir === "up" ? dy < -c.height / 2 : dy > c.height / 2;
        if (!ok) continue;
        const score = dir === "left" || dir === "right" ? Math.abs(dx) : Math.abs(dy) * 4 + Math.abs(dx);
        if (score < bestScore) {
          bestScore = score;
          best = e;
        }
      }
      if (best) setFocused(best.dataset.key ?? null);
      else if (dir === "left") setZone("list"); // left of the first column = back to the sets
    },
    [focused, enterCards],
  );

  // One handler for keyboard and controller.
  const nav = useCallback(
    (action: string) => {
      if (action === "prev_category") return moveCategory(-1);
      if (action === "next_category") return moveCategory(1);
      if (menu) {
        if (action === "up") setMenu({ ...menu, index: (menu.index + MENU.length - 1) % MENU.length });
        else if (action === "down") setMenu({ ...menu, index: (menu.index + 1) % MENU.length });
        else if (action === "select") choose(menu.card, MENU[menu.index]);
        else if (action === "back" || action === "left") setMenu(null);
        return;
      }
      if (zone === "cards" && action === "info") {
        if (focused?.startsWith("s:")) return; // swap buttons have no info
        return setInfo((i) => (i || !focused ? null : { key: focused, toLeft: toLeftOf(focused) }));
      }
      if (info) setInfo(null); // any other action closes the info box first
      if (info && action === "back") return;
      if (zone === "cards") {
        if (action === "back") setZone("list");
        else if (action === "select") {
          document.querySelector<HTMLElement>(`.detail [data-key="${focused}"]`)?.click();
        } else if (action === "up" || action === "down" || action === "left" || action === "right") moveCard(action);
        return;
      }
      if (action === "up") moveSet(-1);
      else if (action === "down") moveSet(1);
      else if (action === "select" || action === "right") enterCards();
      else if (action === "back") api.hideOverlay();
    },
    [menu, info, zone, focused, moveCategory, moveSet, moveCard, enterCards, choose],
  );

  // An opened menu is fully visible (the detail panel scrolls).
  useEffect(() => {
    if (menu) requestAnimationFrame(() => document.querySelector(".card-menu")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }, [menu]);

  // The focused card stays in view.
  useEffect(() => {
    if (zone !== "cards" || !focused) return;
    // The cell (with its frame and scroll margin) is scrolled into view, not just the card.
    document.querySelector(`.detail [data-key="${focused}"]`)?.closest(".card-cell")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [zone, focused]);

  // Another set: back to its list entry, no menu.
  useEffect(() => {
    setMenu(null);
    setInfo(null);
    setZone("list");
  }, [setKey, catKey]);

  useEffect(() => {
    load();
    // Hidden most of the time; refresh whenever the overlay is shown again.
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", load);
    const unlisten = [
      events.onSyncUpdate(setSync),
      events.onSyncDone(() => load()),
      events.onPageChanged(setPage),
      // Fresh numbers arrive from the background model; only fetch them while on screen.
      events.onGalleryUpdated(() => document.visibilityState === "visible" && load()),
      events.onFocusSet((key) => {
        setFocusKey(key);
        load();
      }),
      events.onMissingVisible(setMissingOn),
      events.onGameSession(setSession),
    ];
    api.gameSession().then(setSession).catch(() => {});
    api.currentPage().then(setPage).catch(() => {});
    api.autoScan().then(setTracking).catch(() => {});
    api.uiPrefs().then((p) => setMode(p.mode)).catch(() => {});
    api.missingListVisible().then(setMissingOn).catch(() => {});
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", load);
      unlisten.forEach((p) => p.then((u) => u()));
    };
  }, [load]);

  useEffect(() => {
    // Keyboard: Q/E category, arrows move, Enter/Space open, Esc/Backspace back (closes at the top).
    const keys: Record<string, string> = {
      q: "prev_category", e: "next_category",
      arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right",
      enter: "select", " ": "select", escape: "back", backspace: "back", i: "info",
    };
    const onKey = (e: KeyboardEvent) => {
      const action = keys[e.key.toLowerCase()];
      if (!action) return;
      e.preventDefault();
      nav(action);
    };
    window.addEventListener("keydown", onKey);
    // Controller (PlayStation / Xbox): L1/R1 category, D-pad move, ✕/A open, ○/B back.
    const unlistenPad = events.onPad(nav);
    // Right stick scrolls the detail panel; speed grows with the tilt (squared) so a small push
    // rolls slowly. Events arrive every ~30 ms while the stick is held.
    const unlistenScroll = events.onPadScroll((v) => {
      const speed = Math.sign(v) * v * v * 30;
      document.querySelector(".detail-wrap")?.scrollBy({ top: -speed, behavior: "instant" as ScrollBehavior });
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      unlistenPad.then((u) => u());
      unlistenScroll.then((u) => u());
    };
  }, [nav]);

  const input = useInputMode();
  const pad = input === "keyboard" ? null : input;
  const syncedAt = sync?.synced_at ?? null;
  const nextTheme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];

  return (
    <div className="ov">
      <div className="ov-frame">
        <header className={`ov-header mode-${mode}`} data-tauri-drag-region={mode === "panel" ? true : undefined}>
          <div className="brand" data-tauri-drag-region={mode === "panel" ? true : undefined} title={mode === "panel" ? t("overlay.dragHint") : undefined}>
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name" data-tauri-drag-region={mode === "panel" ? true : undefined}>FC-Tracker</span>
            <span className="brand-section" data-tauri-drag-region={mode === "panel" ? true : undefined}>{t("overlay.gallery")}</span>
          </div>
          <div className="ov-status">
            <button
              className={`pill track-pill ${tracking ? "on" : "off"}`}
              onClick={toggleTracking}
              title={t("track.hint")}
              aria-pressed={tracking}
            >
              <span className="track-dot" aria-hidden="true" />
              {!tracking
                ? t("track.off")
                : session === "in_ultimate_team" && page
                  ? t("track.following", { set: page.set_name })
                  : t(`session.${session}` as MessageKey)}
            </button>
            {passive && (
              <span className="pill rec-pill" title={t("overlay.recordingHint")}>
                <span className="rec-dot" aria-hidden="true" />
                {t("overlay.recording")}
              </span>
            )}
            <button
              className={`theme-btn ${missingOn ? "active" : ""}`}
              onClick={() => api.toggleMissingList().catch(() => {})}
              title={t("missing.toggleHint")}
              aria-pressed={missingOn}
            >
              {t("missing.toggle")}
            </button>
            <button className="theme-btn" onClick={() => setTheme(nextTheme)} title={t("overlay.theme")}>
              <span className="theme-swatch" />
              {t(`theme.${theme}` as MessageKey)}
            </button>
            {/* Help → Controls in the launcher (buttons of the user's controller, animated examples) */}
            <button className="theme-btn help-btn" onClick={() => api.openHelp("controls")} title={t("overlay.help")}>
              <span className="help-q" aria-hidden="true">?</span>
              {t("overlay.help")}
            </button>
            <SupportButton />
            <button className="close-btn" onClick={() => api.hideOverlay()} title={t("overlay.closeHint")}>
              <span className="close-keys">
                <kbd>Esc</kbd>
                <kbd>{t("pad.holdViewShort")}</kbd>
              </span>
              <span className="close-x" aria-hidden="true">
                ×
              </span>
            </button>
            <div className="mode-switch" role="group" aria-label={t("overlay.mode.title")}>
              {(["panel", "half", "full"] as const).map((m) => (
                <button
                  key={m}
                  className={`mode-btn mode-${m} ${mode === m ? "active" : ""}`}
                  onClick={() => changeMode(m)}
                  title={t(`overlay.mode.${m}` as MessageKey)}
                  aria-pressed={mode === m}
                >
                  <span className="mode-icon" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        </header>

        {visible.length === 0 ? (
          <div className="ov-empty">
            <GradeDiamond grade={null} size={72} />
            <p className={loadingGallery ? "ml-loading" : ""}>{t(loadingGallery ? "progress.calculating" : "overlay.galleryEmpty")}</p>
          </div>
        ) : (
          <>
            <div className="cat-bar">
            <nav className="cat-tabs" aria-label={t("overlay.gallery")}>
              {pad ? <PadButton id="l1" layout={pad} size={20} /> : <kbd className="key-hint">Q</kbd>}
              {visible.map((c) => (
                <button
                  key={c.key}
                  data-cat={c.key}
                  className={`cat-tab ${c.key === category?.key ? "active" : ""}`}
                  onClick={() => {
                    setCatKey(c.key);
                    setSetKey(null);
                  }}
                >
                  {c.key === "leagues" ? t("overlay.leagues") : c.key === "rarities" ? t("overlay.rarities") : c.name}
                </button>
              ))}
              {pad ? <PadButton id="r1" layout={pad} size={20} /> : <kbd className="key-hint">E</kbd>}
            </nav>
              <span className="tabs-info">
            {status?.summary && (
              <span className="brand-level" title={t("overlay.summaryHint", { age: formatAge(status.summary.at) })}>
                {status.summary.level != null && t("overlay.level", { level: status.summary.level })}
                {status.summary.score != null && (
                  <>
                    {" · "}
                    <Gem size={10} /> {num(status.summary.score)}
                  </>
                )}
                {status.summary.first_owner != null && status.summary.items != null && (
                  <> · {t("overlay.foTotal", { fo: status.summary.first_owner, items: status.summary.items })}</>
                )}
              </span>
            )}
            {sync && sync.player_count > 0 && (
              <span className="pill">{t("overlay.clubPlayers", { count: num(sync.player_count) })}</span>
            )}
            <span className="pill muted">
              {syncedAt ? t("overlay.synced", { age: formatAge(syncedAt) }) : t("overlay.notSynced")}
            </span>
              </span>
            </div>

            <div className={`ov-body zone-${zone}`} onClick={() => setMenu(null)}>
              <aside className="set-list" key={category?.key}>
                {category?.sets.map((s, i) => (
                  <div key={s.key} data-set={s.key}>
                    <SetRow
                      set={s}
                      index={i}
                      active={s.key === selected?.key}
                      onSelect={() => {
                        setSetKey(s.key);
                        setZone("list");
                      }}
                    />
                  </div>
                ))}
              </aside>
              <main className="detail-wrap">{selected && <SetDetail set={selected} ui={cardUi} />}</main>
            </div>
          </>
        )}


        {/* only the input in use: keyboard, PlayStation or Xbox (the last one touched) */}
        <footer className={`ov-footer input-${input}`}>
          {pad ? (
            <>
              <span><PadButton id="l1" layout={pad} size={20} /><PadButton id="r1" layout={pad} size={20} /> {t("overlay.hintCategory")}</span>
              <span><PadButton id="up" layout={pad} size={20} /><PadButton id="down" layout={pad} size={20} /> {t("overlay.hintSet")}</span>
              <span><PadButton id="south" layout={pad} size={20} /> {t("overlay.hintOpen")}</span>
              <span><PadButton id="east" layout={pad} size={20} /> {t("overlay.hintBack")}</span>
              <span><PadButton id="west" layout={pad} size={20} /> {t("overlay.hintInfo")}</span>
              <span>{t("pad.hold")} <PadButton id="view" layout={pad} size={20} /> {t("overlay.hintToggle")}</span>
              <span>{t("pad.doubleTap")} <PadButton id="view" layout={pad} size={20} /> {t("overlay.hintMissing")}</span>
            </>
          ) : (
            <>
              <span><kbd>Q</kbd> <kbd>E</kbd> {t("overlay.hintCategory")}</span>
              <span><kbd>↑</kbd> <kbd>↓</kbd> {t("overlay.hintSet")}</span>
              <span><kbd>Enter</kbd> {t("overlay.hintOpen")}</span>
              <span><kbd>Esc</kbd> {t("overlay.hintBack")}</span>
              <span><kbd>I</kbd> {t("overlay.hintInfo")}</span>
              <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> {t("overlay.hintToggle")}</span>
              <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> {t("overlay.hintMissing")}</span>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
