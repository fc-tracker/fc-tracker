import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, useLayoutEffect } from "react";
import {
  IS_WEB,
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
import { num } from "./format";
import { rarity } from "./rarities";
import { t, useLocale, type MessageKey } from "./i18n";
import { Gem } from "./icons";
import { useTheme } from "./theme";
import OverlayMenu from "./OverlayMenu";
import MissingList from "./MissingList";
import { BestValueView, GradeCosts, Planner, bestStep, rankByValue, useBestValue, useSetValue } from "./BestValue";
import { useInputMode, type PadButtonId } from "./padGlyphs";
import { Bar, Dot, FaceChip, FutCard, Gem as GemV2, Keycap, Mark, Num, Score, Tabs, stripRef, tierOf, type FutCardData, type Tier } from "./ui";
import Champions, { useChampions } from "./Champions";
import Squads, { usePlanCount } from "./Squads";
import { RequiredUpdate, useUpdate } from "./UpdateRequired";
import { champsTabSeen } from "./championsBoard";
import "./overlay.css";
import "./tiers.css";
import { ZOOM_BASE } from "./zoomBase";

/** A Gallery grade as FC 27 draws it (brand v2: game colours, bevelled letter), sized in px. No grade = "–". */
export function GradeDiamond({ grade, size = 44 }: { grade: string | null | undefined; size?: number }) {
  const g = grade && "DCBAS".includes(grade) ? grade : null;
  return (
    <span className={`grade ${g ? `g-${g}` : "none"}`} style={{ "--g": `${size}px` } as React.CSSProperties} title={g ? undefined : t("ui.gradeNone")}>
      {g && <b>{g}</b>}
    </span>
  );
}

/** a Gallery card as an EA card (its rarity art + portrait; first owner only when proven) */
export const galleryCard = (c: GalleryCardView): FutCardData => ({
  name: c.name ?? (c.slot != null ? t("swaps.slot", { n: c.slot + 1 }) : "?"),
  rating: c.rating, position: c.position, rareflag: c.rareflag, defId: c.slot != null && !c.name ? null : c.def_id, holo: c.holo, actionGuid: c.art ?? null,
  firstOwner: c.first_owner === "known" || c.first_owner === "scanned" || c.first_owner === "manual",
  nation: c.nation ?? null,
  league: c.league ?? null,
  club: c.club ?? null,
  face: c.face?.length === 6 ? c.face : null,
});


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
      className={`mini-card v2 ${ghost ? "ghost" : ""} ${ui.focused === cardKey ? "focused" : ""}`}
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
      title={[card.name, r.name, t(`overlay.fo.${card.first_owner}` as MessageKey)].filter(Boolean).join(" · ")}
    >
      <FutCard card={galleryCard(card)} size="small" w={96} className={ghost ? "missing" : undefined} focus={ui.focused === cardKey} title="" />
      <span className="mini-points">
        <GemV2 />
        {num(card.score)}
      </span>
      {mark && !galleryCard(card).firstOwner && <span className={`mini-fo fo-${card.first_owner}`}>{mark}</span>}
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

/** The cards a set takes in all (user 2026-11-05: POTM said "0/1" – only Gross was known, the set has 7): never fewer
 *  than its slots, whatever part of it FC-Tracker has seen. */
export const setSize = (s: { total: number; slots: number }) => Math.max(s.total, s.slots);

export function SetRow({ set, active, onSelect, index }: { set: GallerySet; active: boolean; onSelect: () => void; index: number }) {
  const filled = Math.min(set.collected, set.slots);
  const regrade = regradeGain(set);
  return (
    <button
      className={`lrow set-row ${active ? "is-sel active" : ""} ${set.complete ? "complete" : ""}`}
      data-f
      onClick={onSelect}
      style={{ animationDelay: `${index * 22}ms` }}
      aria-pressed={active}
      title={set.max_tokens > 0 ? t("overlay.tokensOf", { count: set.tokens, max: set.max_tokens }) : undefined}
    >
      <GradeDiamond grade={set.grade?.grade} size={30} />
      <span className="set-row-main">
        <span className="set-row-name">
          {set.name}
          {set.listed?.score != null && set.listed.score === set.score && (
            <span className="set-row-check" title={t("overlay.listedSame")}>✓</span>
          )}
          {regrade && (
            <span className="set-row-regrade" title={t("overlay.regradeHint")}>
              ↻
            </span>
          )}
        </span>
        <Bar value={filled / Math.max(1, set.slots)} size="thin" tone={set.complete ? "done" : "ink"} />
      </span>
      <span className="set-row-slots num">
        {num(set.collected)}
        <span className="faint">/{num(setSize(set))}</span>
      </span>
      <span className="set-row-score num">
        <GemV2 />
        {num(set.score)}
      </span>
      <span className="set-row-next">
        {!set.tracked ? (
          t("overlay.notTracked")
        ) : !set.complete || !set.grade ? (
          <span className="faint">{t("v2.sets.notComplete")}</span>
        ) : set.grade.next ? (
          <>
            <b className="num">{num(set.grade.points_to_next)}</b> <span className="faint">{t("v2.sets.to", { grade: set.grade.next.grade })}</span>
          </>
        ) : (
          <span className="faint">{t("overlay.maxGrade")}</span>
        )}
      </span>
    </button>
  );
}

/** Your Gallery at a glance (left column of Sets): the total, the level, sets complete, the counts read from the
 *  game's Summary, and the sets closest to their next grade. Everything from the Summary read or the overview. */
function GalleryPanel({ status, sets, rarities, onPick }: { status: GalleryStatus | null; sets: GallerySet[]; rarities: GallerySet[]; onPick: (s: GallerySet) => void }) {
  const sum = status?.summary;
  const closest = sets
    .filter((x) => x.tracked && x.complete && x.grade?.next && x.grade.points_to_next > 0)
    .sort((a, b) => a.grade!.points_to_next - b.grade!.points_to_next)
    .slice(0, 6);
  return (
    <aside className="panel ring gal-panel" aria-label={t("v2.gallery.your")}>
      <div className="gal-scroll">
      <span className="eyebrow">{t("v2.gallery.your")}</span>
      <div className="gal-total">
        <span className="gal-label">{t("v2.gallery.total")}</span>
        {sum?.score != null ? (
          <span className="gal-score">
            <GemV2 />
            <Num value={sum.score} size="l" />
          </span>
        ) : (
          <span className="faint">{t("v2.gallery.notRead")}</span>
        )}
        {sum?.level != null && <span className="chip line ring">{t("overlay.level", { level: sum.level })}</span>}
      </div>
      {sum?.sets && (
        <div className="gal-sets">
          <span className="eyebrow">{t("v2.gallery.setsComplete")}</span>
          <Num value={`${sum.sets[0]}/${sum.sets[1]}`} />
          <Bar value={sum.sets[0] / Math.max(1, sum.sets[1])} tone="ink" size="thick" />
        </div>
      )}
      <dl className="gal-kv">
        {sum?.s_ranks && (
          <div>
            <dt>{t("v2.gallery.sRanks")}</dt>
            <dd className="num">
              {sum.s_ranks[0]}
              <span className="unit-q">/{sum.s_ranks[1]}</span>
            </dd>
          </div>
        )}
        {sum?.items != null && (
          <div>
            <dt>{t("v2.gallery.items")}</dt>
            <dd className="num">{num(sum.items)}</dd>
          </div>
        )}
        {sum?.first_owner != null && (
          <div>
            <dt>{t("ui.firstOwner")}</dt>
            <dd className="num">{num(sum.first_owner)}</dd>
          </div>
        )}
        {sum?.holographic != null && (
          <div>
            <dt>{t("ui.holo")}</dt>
            <dd className="num">{num(sum.holographic)}</dd>
          </div>
        )}
      </dl>
      {closest.length > 0 && (
        <div className="gal-closest">
          <span className="sec-t">{t("v2.gallery.closest")}</span>
          <div className="list rule">
            {closest.map((x) => (
              <button key={x.key} className="lrow" data-f onClick={() => onPick(x)}>
                <GradeDiamond grade={x.grade?.grade} size={22} />
                <span className="ellip">
                  {x.name} <span className="faint">→ {x.grade!.next!.grade}</span>
                </span>
                <span className="num">{num(x.grade!.points_to_next)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {rarities.length > 0 && (
        <div className="gal-closest gal-rar">
          <span className="sec-t">{t("overlay.rarities")}</span>
          <div className="list rule">
            {rarities.map((x) => (
              <button key={x.key} className="lrow" data-f onClick={() => onPick(x)}>
                <GradeDiamond grade={x.grade?.grade} size={22} />
                <span className="ellip">{x.name}</span>
                <span className="num">
                  {num(x.collected)}
                  <span className="faint">/{num(setSize(x))}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      </div>
    </aside>
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
    <span className={`swap-card v2 ${card.holo ? "holo" : ""}`}>
      <FaceChip card={galleryCard(card)} s={40} />
      <span className="swap-name">{card.name ?? (card.slot != null ? t("swaps.slot", { n: card.slot + 1 }) : "?")}</span>
      <span className="swap-points">
        <GemV2 />
        {num(card.score)}
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
  // which card each one replaces: no cross-checking with the game or the side panel
  const replaces = new Map(swaps.map((sw) => [sw.into.def_id, { ...sw.out, name: sw.out.name ?? (sw.out.slot != null ? t("swaps.slot", { n: sw.out.slot + 1 }) : null) }]));
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
            {putIn.has(c.def_id) && (
              <small className="best-putin" title={replaces.get(c.def_id)?.name ?? undefined}>
                {replaces.get(c.def_id)?.name ? t("best.putInFor", { name: replaces.get(c.def_id)!.name! }) : t("best.putInFree")}
              </small>
            )}
          </span>
        ))}
      </span>
    </section>
  );
}

/** The set's best selection at a glance (mockup 02): its strongest card big, the next five beside it, each with the
 *  Gallery points it brings – EA's own card art. The full selection and its swaps follow below. */
function BestShowcase({ set }: { set: GallerySet }) {
  const top = [...set.lineup].filter((c) => c.name).sort((a, b) => b.score - a.score).slice(0, 6);
  if (top.length < 2) return null;
  const [hero, ...rest] = top;
  return (
    <section className="detail-section best-show">
      <h2>
        {t("v2.sets.bestSel")}
        <span className="faint t-13">{t("v2.sets.cards", { count: set.lineup.length })}</span>
      </h2>
      <div className="best-show-row">
        <figure className="best-show-hero">
          <FutCard card={galleryCard(hero)} size="small" w={180} />
          <figcaption className="num">
            <GemV2 />
            {num(hero.score)}
          </figcaption>
        </figure>
        <div className="best-show-rest">
          {rest.map((c) => (
            <figure key={c.def_id}>
              <FutCard card={galleryCard(c)} size="small" w={96} />
              <figcaption className="num">
                <GemV2 />
                {num(c.score)}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
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
          <div key={step.grade} className={`ladder-step ${state} ${state === "next" ? "is-sel" : ""}`}>
            <GradeDiamond grade={step.grade} size={26} />
            {state === "reached" && (
              <span className="ladder-tick" title={t("v2.sets.reached")}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l3 3 6-6.6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="square" /></svg>
              </span>
            )}
            <span className="ladder-tokens">
              {step.tokens > 0 ? (
                <>
                  <b className="num">{step.tokens}</b> {t("v2.tokens")}
                </>
              ) : (
                "–"
              )}
            </span>
            <span className="ladder-score">
              {i === 0 && !set.complete ? (
                t("v2.sets.completeSet")
              ) : (
                <>
                  {t("v2.sets.from")} <b className="num">{num(step.score)}</b>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** What each grade of the set costs from the club (Best value) – shown once it is computed. */
function SetCosts({ setKey, name }: { setKey: string; name: string }) {
  const value = useSetValue(setKey);
  return value ? <GradeCosts value={value} /> : <p className="ml-loading">{t("value.calculatingSet", { set: name })}</p>;
}

// Main menu → tabs → categories. Today the main menu has one entry (Gallery); its tabs are the
// sets, Best value (sets ranked by what the next grade costs) and the token Planner.
const SECTIONS = ["sets", "value", "planner", "champions", "squads"] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_LABEL: Record<Section, MessageKey> = { sets: "section.sets", value: "section.value", planner: "section.planner", champions: "section.champions", squads: "section.squads" };
const readPref = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const writePref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};
// Zoom of the main view (Ctrl + scroll, Ctrl + / – / 0, or the − 100 % + buttons), for small
// screens and for anyone who wants it bigger.
/** controller: L1/R1 (Rust "category") switch the sections, L2/R2 (Rust "section") the sub-tabs – FC's own menu layout */
/** The game cursor for screens built from [data-f] elements (Objectives): D-pad → the nearest element in that
 *  direction (centre to centre, sideways distance weighs double), one .is-focus at a time, kept in view. */
function moveFocus(root: string, dir: "up" | "down" | "left" | "right") {
  const scope = document.querySelector(root);
  if (!scope) return;
  const all = Array.from(scope.querySelectorAll<HTMLElement>("[data-f]")).filter((e) => e.offsetParent !== null && !(e as HTMLButtonElement).disabled);
  if (!all.length) return;
  const cur = scope.querySelector<HTMLElement>(".is-focus[data-f]");
  const set = (el: HTMLElement) => {
    scope.querySelectorAll(".is-focus").forEach((e) => e.classList.remove("is-focus"));
    el.classList.add("is-focus");
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  if (!cur) return set(all[0]);
  const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
  const c = cur.getBoundingClientRect();
  const cx = c.left + c.width / 2, cy = c.top + c.height / 2;
  let best: HTMLElement | null = null, bd = Infinity;
  for (const el of all) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const x = b.left + b.width / 2 - cx, y = b.top + b.height / 2 - cy;
    const along = x * dx + y * dy;
    if (along <= 4) continue;
    const d = along + (Math.abs(x * dy) + Math.abs(y * dx)) * 2;
    if (d < bd) (bd = d), (best = el);
  }
  if (best) set(best);
}

/** which hints stay when the footer is narrow: select, back, the slab, the sub-tabs, then the rest */
const HINT_PRIO: PadButtonId[] = ["south", "east", "l1", "l2", "west", "north", "up", "left"];
const PAD_SWAP: Record<string, string> = { prev_category: "prev_section", next_category: "next_section", prev_section: "prev_category", next_section: "next_category" };
const PAD_KEY: Partial<Record<PadButtonId, [string, string]>> = {
  south: ["✕", "A"], east: ["○", "B"], west: ["□", "X"], north: ["△", "Y"], l1: ["L1", "LB"], r1: ["R1", "RB"], l2: ["L2", "LT"], r2: ["R2", "RT"],
  up: ["↑", "↑"], down: ["↓", "↓"], left: ["←", "←"], right: ["→", "→"], view: ["Create", "View"],
};
/** one key of a hint: the controller button (in its own layout) or the keyboard key – whichever input is in use */
function PadKey({ id, kb }: { id?: PadButtonId; kb?: string }) {
  const [ps, xb] = (id && PAD_KEY[id]) ?? [undefined, undefined];
  return <Keycap ps={ps} xb={xb || ps} kb={kb} />;
}
const ZOOMS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4];
// the app's own scale (src/zoomBase.ts); big screens still scale up once the layout passes 2400 CSS px

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
          <h1 className="detail-title h1">{set.name}</h1>
          <p className="detail-sub">
            {t("overlay.collectedOf", { collected: num(set.collected), total: num(setSize(set)) })}
          </p>
        </div>
        <div className="detail-grade">
          <GradeDiamond grade={set.grade?.grade} size={64} />
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
            <GemV2 />
            <Num value={set.score} size="m" />
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

      {set.ladder.length > 0 && (
        <section className="detail-section">
          <h2>
            {t("overlay.rewards")}
            {!set.verified && <span className="unverified"> · {t("overlay.unverified")}</span>}
          </h2>
          <Ladder set={set} />
        </section>
      )}

      <BestShowcase set={set} />
      <Regrade set={set} />
      <InGamePanel set={set} />
      <BestSelection set={set} ui={ui} />
      <SetCosts setKey={set.key} name={set.name} />


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
      <dl className="set-facts">
        <div>
          <dt>{t("v2.sets.collected")}</dt>
          <dd className="num">
            {num(set.collected)}
            <span className="faint">/{num(setSize(set))}</span>
          </dd>
        </div>
        <div>
          <dt>{t("v2.sets.missing")}</dt>
          <dd className="num">{num(Math.max(0, setSize(set) - set.collected))}</dd>
        </div>
        <div>
          <dt>{t("v2.sets.adds")}</dt>
          <dd className="num">
            {set.ingame?.total != null ? (
              <>
                <GemV2 />
                {num(Math.max(0, set.score - set.ingame.total))}
              </>
            ) : (
              <span className="md-nr">{t("v2.md.notRead")}</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** FC-Tracker Web's part of the overlay's one header (user 2026-11-05: no double header – /web is its own installable
 *  app): what is being read in the status pill, and the web's actions (club sync, share / stop, install, the app). */
export type WebBar = { label: string; tone: "" | "ok" | "warn" | "bad" | "busy"; actions: React.ReactNode };

export default function Overlay({ web }: { web?: WebBar } = {}) {
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
  // Full screen (and the browser version): Best selection | Buy next sit right in the view, next to
  // the set. The separate side panel (double-tap View) stays as it is.
  const [embedOn, setEmbedOn] = useState(() => {
    try {
      return localStorage.getItem("fct.embedMissing") !== "off";
    } catch {
      return true;
    }
  });
  const toggleEmbed = () =>
    setEmbedOn((on) => {
      try {
        localStorage.setItem("fct.embedMissing", on ? "off" : "on");
      } catch {}
      return !on;
    });
  const [status, setStatus] = useState<GalleryStatus | null>(null);
  const [session, setSession] = useState<GameSession>("unknown");
  // an update the app must have: shown over everything (installed from here or the launcher)
  const update = useUpdate();
  // ?section= opens a view directly (links, previews, screenshots); else the last one used
  const [section, setSectionState] = useState<Section>(() => {
    const asked = new URLSearchParams(location.search).get("section") ?? readPref("fct.section", "sets");
    return (SECTIONS as readonly string[]).includes(asked) ? (asked as Section) : "sets";
  });
  const setSection = (s: Section) => {
    setSectionState(s);
    writePref("fct.section", s);
  };
  const best = useBestValue(true);
  const [valueKey, setValueKey] = useState<string | null>(null);
  // the Champions view says whether its tracker is off (Enter switches it on then)
  const [champsOff, setChampsOff] = useState(false);
  useEffect(() => {
    const on = (e: Event) => setChampsOff((e as CustomEvent<boolean | null>).detail === false);
    window.addEventListener("fct:champions-state", on);
    return () => window.removeEventListener("fct:champions-state", on);
  }, []);
  const [zoom, setZoomState] = useState<number>(() => {
    const z = Number(readPref("fct.zoom2", "1"));
    return ZOOMS.includes(z) ? z : 1;
  });
  const setZoom = (dir: number) =>
    setZoomState((z) => {
      const i = ZOOMS.indexOf(z);
      const next = dir === 0 ? 1 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 3 : i) + dir))];
      writePref("fct.zoom2", String(next));
      return next;
    });
  // Big screens (review OV-7: 2560 looked small with empty space): above 2000 CSS px of content the whole view scales
  // up so it always lays out as the reviewed 2000 px view – continuous, at most 1.5×, on top of the player's own zoom.
  const [viewW, setViewW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setViewW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  // FC-Tracker Web (user 2026-11-05: "perfect at 75 %, too big by default"): a browser tab is not a game window – above
  // 1600 CSS px it lays out wider and smaller (1600 / width, never under .75); under 1600 it stays 1 (text ≥ 12 px)
  // the dashboard (a page beside its rail, user 2026-11-05: "80 % is too small in places"): never below 100 %, a
  // little bigger on big screens – by the room beside the rail (236 px from 860 px up)
  const DASH = typeof document !== "undefined" && document.documentElement.classList.contains("dash-page");
  const dashRoom = viewW >= 860 ? viewW - 236 : viewW;
  const frameZoom = DASH
    ? zoom * (dashRoom >= 2200 ? 1.25 : dashRoom >= 1660 ? 1.1 : 1)
    : IS_WEB
    ? zoom * Math.min(1, Math.max(0.75, 1600 / (viewW / zoom)))
    : zoom * ZOOM_BASE * Math.min(1.5, Math.max(1, viewW / (zoom * ZOOM_BASE) / 2400));
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
  const passiveRef = useRef(false);
  passiveRef.current = passive;
  useEffect(() => {
    const un = events.onOverlayPassive(setPassive);
    return () => {
      un.then((u) => u());
    };
  }, []);

  // The launcher's tiles open a view: open_overlay(section) emits "overlay-section" (v2-launcher, lib.rs)
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const un = listen<string>("overlay-section", (e) => {
      const id = e.payload === "objectives" ? "squads" : e.payload === "best-value" ? "value" : e.payload;
      if ((SECTIONS as readonly string[]).includes(id)) setSection(id as Section);
    });
    return () => void un.then((u) => u());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    // inside the view (full screen, FC-Tracker Web) the list always shows the set on screen – also
    // the one opened first; the separate side panel follows a set only once it is picked here
    if (selectedKey && (IS_WEB || mode === "full" || catKey || setKey)) api.followSet(selectedKey).catch(() => {});
  }, [selectedKey, catKey, setKey, mode]);

  const changeMode = (m: OverlayMode) => {
    setMode(m);
    api.setOverlayMode(m).catch(() => {});
  };

  const toggleTracking = () => {
    // the browser version: the pill opens the source picker (what to read the game from)
    if (IS_WEB && !tracking) return void window.dispatchEvent(new Event("fct-web-source"));
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

  // Best value and the Planner (BestValue.tsx) read the Gallery's sets (still missing) and open a set in Sets.
  const galleryByKey = useMemo(() => new Map(visible.flatMap((c) => c.sets).map((x) => [x.key, x])), [visible]);
  const openSetKey = (key: string) => {
    const cat = visible.find((c) => c.sets.some((x) => x.key === key));
    if (cat) {
      setCatKey(cat.key);
      setSetKey(key);
    }
    setZone("list");
    setSection("sets");
  };

  // BRAND-MIGRATION rule 10: the layout tier from the frame's own width (CSS px, so Full / Half / Panel and zoom all
  // count): xl ≥ 1600 · l 1200–1599 · m 760–1199 · s < 760. CSS uses the same numbers as container queries (tiers.css).
  // a callback ref: the frame mounts after the first (loading) render, so the observers attach when it exists
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  frameRef.current = frameEl;
  const [tier, setTier] = useState<Tier>("xl");
  useEffect(() => {
    const el = frameEl;
    if (!el) return;
    const fit = () => setTier(tierOf(el.clientWidth));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [frameEl]);
  // the lists open where the user is (user 2026-11-05): the open category and the open set scroll into view – also
  // when the set came from the game (followSet) or the overlay was opened again
  useEffect(() => {
    if (section !== "sets") return;
    const show = () => {
      document.querySelector(".cat-tabs .seg.is-on")?.scrollIntoView({ inline: "nearest", block: "nearest" });
      document.querySelector(".sets-v2 .set-list .set-row.active")?.scrollIntoView({ block: "nearest" });
    };
    // once the view has laid out (the rows come in with a short stagger)
    const ids = [80, 400].map((ms) => window.setTimeout(show, ms));
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [section, setKey, catKey, visible.length]);
  const narrow = tier === "m" || tier === "s";
  // The header can't collide (review OV-1): when brand, tabs and status don't fit side by side, items go in a fixed
  // order – 1 the "OVERLAY" label · 2 the status words (the dot stays) · 3 the player count · 4 the wordmark (the
  // mark stays) · 5 the tab counts – and only then do the tabs scroll between L1 / R1. Measured, never guessed.
  const headerRef = useRef<HTMLElement | null>(null);
  const fitHeader = useCallback(() => {
    const top = headerRef.current;
    if (!top) return;
    const parts = [".ov-brand", ".tabbar", ".ov-sec-s", ".ov-status"].map((q) => top.querySelector<HTMLElement>(q)).filter((e): e is HTMLElement => !!e && e.offsetParent !== null);
    // why the bar doesn't fit at a level, or "" when it does
    const clash = (): string => {
      const tabs = top.querySelector<HTMLElement>(".tabbar > .tabs");
      if (tabs && tabs.offsetParent !== null && tabs.scrollWidth > tabs.clientWidth + 1) return "tabs";
      const status = top.querySelector<HTMLElement>(".ov-status");
      if (status && status.scrollWidth > status.clientWidth + 1) return "status";
      // nothing in the bar is squeezed into an ellipsis either (the status words shrink before they overflow)
      for (const e of top.querySelectorAll<HTMLElement>(".track-label, .ov-brand .brand, .tabbar .tab, .ov-sec-s")) if (e.offsetParent !== null && e.scrollWidth > e.clientWidth + 1) return "squeezed";
      const rs = parts.map((e) => e.getBoundingClientRect());
      for (let i = 1; i < rs.length; i++) if (rs[i].left < rs[i - 1].right - 1) return "overlap";
      const box = top.getBoundingClientRect();
      return rs.every((r) => r.right <= box.right + 1 && r.left >= box.left - 1) ? "" : "outside";
    };
    for (let level = 0; level <= 5; level++) {
      top.dataset.fit = String(level);
      const why = clash();
      if (import.meta.env.DEV) top.dataset.fitWhy = why;
      if (!why) return;
    }
  }, []);
  useLayoutEffect(fitHeader);
  // the frame exists from the first render (the header may not yet): its size changes re-fit the bar
  useEffect(() => {
    const el = frameEl;
    if (!el) return;
    const ro = new ResizeObserver(() => fitHeader());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitHeader, frameEl]);
  // M / S: the set card opens in place of the list (✕ / Enter opens, ○ / Esc back)
  const [setOpen, setSetOpen] = useState(false);
  // opened in place: the card comes into view (Your Gallery and the categories sit above it)
  const detailShown = narrow && (setOpen || zone === "cards");
  useEffect(() => {
    if (detailShown) requestAnimationFrame(() => document.querySelector(".sets-v2 > .detail-wrap")?.scrollIntoView({ block: "start" }));
  }, [detailShown]);
  const moveSection = useCallback(
    (dir: number) => {
      const next = SECTIONS[(SECTIONS.indexOf(section) + dir + SECTIONS.length) % SECTIONS.length];
      setSection(next);
      setZone("list");
      setMenu(null);
    },
    [section], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // One handler for keyboard and controller.
  const nav = useCallback(
    (action: string) => {
      if (action === "prev_section") return moveSection(-1);
      if (action === "next_section") return moveSection(1);
      if (section === "value" || section === "planner") {
        // the view moves its own focus (BestValue.tsx "fct:view-nav"): ↑↓ rows, ←→ the detail's buttons,
        // ✕/A add to the shopping list / open the step's set, □/X the Planner, L2/R2 the Planner's budget
        if (action === "back") api.hideOverlay();
        else window.dispatchEvent(new CustomEvent("fct:view-nav", { detail: action }));
        return;
      }
      if (section === "champions") {
        // up/down scroll the weekend, L1/R1 (Q/E) step through the earlier weekends
        if (action === "prev_category" || action === "next_category") window.dispatchEvent(new CustomEvent("fct:champions-weekend", { detail: action === "next_category" ? 1 : -1 }));
        // ○ / B closes an opened match first, then the overlay
        else if (action === "back") document.querySelector(".ch5 .md") ? window.dispatchEvent(new Event("fct:champions-back")) : api.hideOverlay();
        // the D-pad moves through the 15 matches, ✕/A opens one, △/Y switches the tracker on / off
        else window.dispatchEvent(new CustomEvent("fct:view-nav", { detail: action }));
        return;
      }
      if (section === "squads") {
        // L2/R2 (Q/E) the squad tabs (1. Rivals, 2. Ghoul Fest …); the D-pad moves the game cursor over the screen
        // (pitch cards, buttons, plan stages, requirement lines) – the nearest one in that direction
        if (action === "prev_category" || action === "next_category") window.dispatchEvent(new CustomEvent("fct:squads-session", { detail: action === "next_category" ? 1 : -1 }));
        else if (action === "up" || action === "down" || action === "left" || action === "right") moveFocus(".sq-v2", action);
        // ✕ / A: the focused element; else Swap in the change bar or the opened player; else Lock in squad
        else if (action === "select")
          (document.querySelector<HTMLElement>(".sq-v2 .is-focus[data-f]") ??
            document.querySelector<HTMLElement>(".sq-multibar .btn-primary, .sq-swap .btn-primary") ??
            document.querySelector<HTMLElement>(".sq-lock-btn"))?.click();
        else if (action === "info") document.querySelector<HTMLElement>(".sq-change-btn")?.click();
        // △ / Y (B on the keyboard): the match brief – opens the side panel, where it lives during the match
        // ... and the overlay closes, so there are never two overlays (user 2026-11-05)
        else if (action === "brief") {
          api
            .missingListVisible()
            .then((v) => (v ? undefined : api.toggleMissingList()))
            .catch(() => {})
            .finally(() => !IS_WEB && api.hideOverlay());
        }
        // ○ / B: an opened player first, then the overlay
        else if (action === "back") document.querySelector(".sq-swap") ? window.dispatchEvent(new Event("fct:squads-back")) : api.hideOverlay();
        return;
      }
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
        if (action === "back") {
          setZone("list");
          setSetOpen(false);
        }
        else if (action === "select") {
          document.querySelector<HTMLElement>(`.detail [data-key="${focused}"]`)?.click();
        } else if (action === "up" || action === "down" || action === "left" || action === "right") moveCard(action);
        return;
      }
      if (action === "up") moveSet(-1);
      else if (action === "down") moveSet(1);
      else if (action === "select" || action === "right") {
        if (narrow) setSetOpen(true);
        enterCards();
      } else if (action === "back") {
        // M / S: ○ / Esc closes the set card first, back to the list
        if (narrow && setOpen) setSetOpen(false);
        else api.hideOverlay();
      }
    },
    [menu, info, zone, focused, moveCategory, moveSet, moveCard, enterCards, choose, moveSection, section, visible, narrow, setOpen],
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
      events.onGameSession((s) => {
        setSession(s);
        if (IS_WEB) setTracking(s !== "closed");
      }),
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
      enter: "select", " ": "select", escape: "back", backspace: "back", i: "info", b: "brief",
      "1": "section_sets", "2": "section_value", "3": "section_planner", "4": "section_champions", "5": "section_squads",
    };
    const onKey = (e: KeyboardEvent) => {
      // typing in a field (the planner's budget) is not navigation
      if (e.target instanceof HTMLInputElement) return;
      if (e.ctrlKey && (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "0")) {
        e.preventDefault();
        return setZoom(e.key === "0" ? 0 : e.key === "-" ? -1 : 1);
      }
      if (e.key === "Tab") {
        e.preventDefault();
        return nav(e.shiftKey ? "prev_section" : "next_section");
      }
      const action = keys[e.key.toLowerCase()];
      if (action?.startsWith("section_")) {
        e.preventDefault();
        return setSection(action.slice(8) as Section);
      }
      if (!action) return;
      e.preventDefault();
      nav(action);
    };
    window.addEventListener("keydown", onKey);
    // opened without focus (recording): the first click takes it, so fields can be typed in
    const onPointer = () => {
      if (passiveRef.current) void api.overlayFocus();
    };
    window.addEventListener("pointerdown", onPointer);
    // Controller (PlayStation / Xbox): L1/R1 category, D-pad move, ✕/A open, ○/B back.
    // brand v2 (the game's own layout): L1 / R1 move the top slab (sections), L2 / R2 the sub-tabs
    const unlistenPad = events.onPad((a) => nav(PAD_SWAP[a] ?? a));
    // Right stick scrolls the detail panel; speed grows with the tilt (squared) so a small push
    // rolls slowly. Events arrive every ~30 ms while the stick is held.
    const unlistenScroll = events.onPadScroll((v) => {
      const speed = Math.sign(v) * v * v * 30;
      // the Sets detail scrolls inside its frame; the other views scroll their wrap
      (document.querySelector(".sets-v2 .detail-wrap > .detail") ?? document.querySelector(".detail-wrap"))?.scrollBy({ top: -speed, behavior: "instant" as ScrollBehavior });
    });
    // Ctrl + scroll: zoom the main view (not the page)
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(e.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
      unlistenPad.then((u) => u());
      unlistenScroll.then((u) => u());
    };
  }, [nav]);

  // the side panel is never docked in the view any more (user 2026-11-05: "the quick view on Sets gives no value and
  // makes everything else smaller") – the button opens the separate side panel (double-tap View) in the app
  const embedded = false;
  const input = useInputMode();
  // hints follow the input in use (keyboard, PlayStation or Xbox – the last one touched), never two side by side
  const pad = input === "keyboard" ? null : input;
  // "New" on the Champions tab until it has been opened once (the tracker ships switched off)
  const champsNew = section !== "champions" && !champsTabSeen();
  // the footer names only what works in the view: Planner and Champions scroll, Enter switches
  // the Champions tracker on while it is off
  const scrolls = section === "planner" || section === "champions" || section === "squads";
  const enterHint: MessageKey | null = section === "planner" || section === "squads" ? null : section === "champions" ? (champsOff ? "champs.hintSwitch" : null) : "overlay.hintOpen";
  const syncedAt = sync?.synced_at ?? null;
  // the slab's counts: the weekend's record (this one while it runs, else the last), the first session's objectives
  const champs = useChampions();
  const lastRun = champs?.runs[champs.runs.length - 1];
  const champRec: [number, number] | null = lastRun ? [lastRun.hub.wins, lastRun.hub.losses] : null;
  const planCount = usePlanCount();
  // the footer names only what works in this view – controller: L1/R1 the sections, L2/R2 the sub-tabs
  type Hint = { pad: PadButtonId[]; keys: string[]; label: MessageKey };
  // Best value (03) · Planner (04) · Champions (05): the mockups' footers – what ✕ / □ / △ / L2·R2 do in that view
  const viewHints: Record<string, Hint[]> = {
    value: [
      { pad: ["south"], keys: ["Enter"], label: "v2ov.hintList" },
      { pad: ["west"], keys: ["I"], label: "section.planner" },
    ],
    planner: [
      { pad: ["south"], keys: ["Enter"], label: "v2ov.hintOpenStep" },
      { pad: ["l2", "r2"], keys: ["Q", "E"], label: "v2ov.budget" },
    ],
    champions: [
      { pad: ["south"], keys: ["Enter"], label: "v2ov.hintOpenMatch" },
      { pad: ["north"], keys: ["B"], label: "v2ov.hintTracker" },
      { pad: ["l2", "r2"], keys: ["Q", "E"], label: "champs.hintWeekend" },
    ],
  };
  const own = viewHints[section];
  const hints: Hint[] = own
    ? [{ pad: ["l1", "r1"], keys: ["Tab"], label: "overlay.hintSection" }, ...own, { pad: ["east"], keys: ["Esc"], label: "overlay.hintBack" }]
    : [
    { pad: ["l1", "r1"], keys: ["Tab"], label: "overlay.hintSection" },
    {
      pad: ["l2", "r2"],
      keys: ["Q", "E"],
      label: section === "squads" ? "squads.hintSession" : section === "champions" ? "champs.hintWeekend" : section === "planner" ? "value.hintGoal" : "overlay.hintCategory",
    },
    section === "squads"
      ? { pad: ["up", "left"] as PadButtonId[], keys: ["↑↓←→"], label: "v2.sq.hintMove" as MessageKey }
      : { pad: ["up", "down"] as PadButtonId[], keys: ["↑", "↓"], label: scrolls ? "value.hintScroll" : "overlay.hintSet" },
    ...(section === "squads" ? [{ pad: ["south"] as PadButtonId[], keys: ["Enter"], label: "squads.lock.lock" as MessageKey }, { pad: ["west"] as PadButtonId[], keys: ["I"], label: "squads.change.players" as MessageKey }, { pad: ["north"] as PadButtonId[], keys: ["B"], label: "brief.title" as MessageKey }] : []),
    ...(enterHint ? [{ pad: ["south"] as PadButtonId[], keys: ["Enter"], label: enterHint }] : []),
    ...(!scrolls ? [{ pad: ["west"] as PadButtonId[], keys: ["I"], label: "overlay.hintInfo" as MessageKey }] : []),
    { pad: ["east"], keys: ["Esc"], label: "overlay.hintBack" },
      ];

  return (
    <div className="ov">
      <div className="ov-frame" ref={setFrameEl} data-tier={tier} style={frameZoom !== 1 ? ({ zoom: frameZoom } as React.CSSProperties) : undefined}>
        {!IS_WEB && update?.required && <RequiredUpdate update={update} running={session !== "closed" && session !== "unknown"} overlay />}
        <header className={`ov-top mode-${mode}`} ref={headerRef} data-fit="0" data-tauri-drag-region={mode === "panel" ? true : undefined}>
          <div className="ov-brand" data-tauri-drag-region={mode === "panel" ? true : undefined} title={mode === "panel" ? t("overlay.dragHint") : undefined}>
            <span className="brand">
              <Mark />
              <span data-tauri-drag-region={mode === "panel" ? true : undefined}>FC-Tracker</span>
            </span>
            <span className="ov-ctx">{t(web ? "web.badge" : "v2.overlay")}</span>
          </div>
          {tier === "s" && (
            <div className="ov-sec-s">
              <button className="ov-sec-arrow" onClick={() => moveSection(-1)} aria-label={t("v2.prevSection")} title={t("v2.prevSection")}>
                <Keycap ps="L1" xb="LB" kb="⇧Tab" />
              </button>
              <span className="ov-sec-name">{t(SECTION_LABEL[section])}</span>
              <button className="ov-sec-arrow" onClick={() => moveSection(1)} aria-label={t("v2.nextSection")} title={t("v2.nextSection")}>
                <Keycap ps="R1" xb="RB" kb="Tab" />
              </button>
            </div>
          )}
          {/* the FUT slab: L1 / R1 on the controller, Tab on the keyboard */}
          <Tabs
            items={SECTIONS.map((s) => ({
              id: s,
              label: (
                <>
                  {t(SECTION_LABEL[s])}
                  {/* only news gets a mark – "beta" is said inside the view, not in the bar */}
                  {s === "champions" && champsNew && !champRec && <span className="chip accent sec-new">{t("champs.news.badge")}</span>}
                </>
              ),
              count:
                s === "sets" && status?.summary?.sets
                  ? `${status.summary.sets[0]}/${status.summary.sets[1]}`
                  : s === "champions" && champRec
                    ? <Score a={champRec[0]} b={champRec[1]} />
                    : s === "squads" && planCount != null
                      ? planCount
                      : undefined,
            }))}
            active={section}
            onChange={(id) => setSection(id as Section)}
            keys
          />
          <div className="ov-status">
            <button className={`ov-pill track-pill ${tracking ? "on" : "off"} ${web?.tone ? `wt-${web.tone}` : ""}`} onClick={toggleTracking} title={web?.label ?? t("track.hint")} aria-pressed={tracking}>
              <Dot tone={tracking ? "done" : undefined} live={tracking && session === "in_ultimate_team"} />
              <span className="track-label" role={web ? "status" : undefined} aria-live={web ? "polite" : undefined}>
                {web
                  ? web.label
                  : !tracking
                  ? t(IS_WEB ? "web.track.off" : "track.off")
                  : session === "in_ultimate_team" && page
                    ? t("track.following", { set: page.set_name })
                    : IS_WEB
                      ? t("web.track.watching")
                      : t(`session.${session}` as MessageKey)}
              </span>
            </button>
            {sync && sync.player_count > 0 && (
              <span className="ov-synced" title={!IS_WEB ? (syncedAt ? t("overlay.synced", { age: formatAge(syncedAt) }) : t("overlay.notSynced")) : undefined}>
                <b className="num">{num(sync.player_count)}</b> {t("v2.players")}
              </span>
            )}
            {passive && (
              <span className="ov-pill rec-pill" title={t("overlay.recordingHint")}>
                <Dot tone="accent" live />
                {t("overlay.recording")}
              </span>
            )}
            {!IS_WEB && <button
              className={`btn btn-s btn-secondary ring ${(embedded ? embedOn : missingOn) ? "is-on" : ""}`}
              onClick={() => (embedded ? toggleEmbed() : api.toggleMissingList().catch(() => {}))}
              title={t("missing.toggleHint")}
              aria-pressed={embedded ? embedOn : missingOn}
            >
              {t("missing.toggle")}
            </button>}
            {web?.actions}
            {/* theme, zoom, window layout, language, help, support and the profile: one menu */}
            <OverlayMenu
              theme={theme}
              setTheme={setTheme}
              zoom={zoom}
              setZoom={setZoom}
              mode={IS_WEB ? undefined : mode}
              changeMode={IS_WEB ? undefined : changeMode}
              status={
                narrow ? (
                  <>
                    <button className={`me-item me-track ${tracking ? "on" : ""}`} role="menuitemcheckbox" aria-checked={tracking} onClick={toggleTracking}>
                      <Dot tone={tracking ? "done" : undefined} live={tracking && session === "in_ultimate_team"} />
                      {web ? web.label : !tracking ? t(IS_WEB ? "web.track.off" : "track.off") : session === "in_ultimate_team" && page ? t("track.following", { set: page.set_name }) : IS_WEB ? t("web.track.watching") : t(`session.${session}` as MessageKey)}
                    </button>
                    {sync && sync.player_count > 0 && (
                      <span className="me-note">
                        <b className="num">{num(sync.player_count)}</b> {t("v2.players")}
                        {!IS_WEB && syncedAt ? ` · ${t("overlay.synced", { age: formatAge(syncedAt) })}` : ""}
                      </span>
                    )}
                    {tier === "s" && !IS_WEB && (
                      <button className="me-item" role="menuitemcheckbox" aria-checked={embedded ? embedOn : missingOn} onClick={() => (embedded ? toggleEmbed() : api.toggleMissingList().catch(() => {}))}>
                        {t("missing.toggle")}
                      </button>
                    )}
                  </>
                ) : undefined
              }
            />
            {!IS_WEB && (
              // Esc / hold View close it too (the hint row at the bottom says so)
              <button className="close-btn" onClick={() => api.hideOverlay()} title={t("overlay.closeHint")} aria-label={t("overlay.closeHint")}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="square" />
                </svg>
              </button>
            )}
          </div>
        </header>

        {section === "value" ? (
          <BestValueView data={best.data} busy={best.busy} gallery={galleryByKey} pick={valueKey} onPlanner={() => setSection("planner")} onOpenSet={openSetKey} />
        ) : section === "squads" ? (
          <div className="ov-body zone-list planner-body">
            <main className="detail-wrap">
              <Squads />
            </main>
          </div>
        ) : section === "champions" ? (
          <Champions keys={<Keycap ps="✕" xb="A" kb="Enter" />} />
        ) : section === "planner" ? (
          <Planner data={best.data} busy={best.busy} gallery={galleryByKey} onLoad={(b) => best.load(b)} onOpenSet={openSetKey} />
        ) : visible.length === 0 ? (
          <div className="ov-empty">
            <GradeDiamond grade={null} size={72} />
            <p className={loadingGallery ? "ml-loading" : ""}>{t(loadingGallery ? "progress.calculating" : "overlay.galleryEmpty")}</p>
          </div>
        ) : (
          <div className={`ov-body sets-v2 zone-${zone} ${embedded && embedOn && !narrow ? "with-ml" : ""} ${narrow && (setOpen || zone === "cards") ? "detail-open" : ""}`} onClick={() => setMenu(null)}>
            <GalleryPanel status={status} sets={visible.flatMap((c) => c.sets)} rarities={visible.find((c) => c.key === "rarities")?.sets ?? []} onPick={(x) => { const cat = visible.find((c) => c.sets.includes(x)); if (cat) setCatKey(cat.key); setSetKey(x.key); setZone("list"); }} />
            {/* the categories: L2 / R2 (Q / E) – the game's sub-tabs */}
            <div className="cat-row sets-cats">
            <Keycap ps="L2" xb="LT" kb="Q" />
            <nav className="cat-tabs segs-bar" ref={stripRef} aria-label={t("overlay.gallery")}>
              {visible.map((c) => (
                <button
                  key={c.key}
                  data-cat={c.key}
                  className={`seg ring ${c.key === category?.key ? "is-on" : ""}`}
                  aria-pressed={c.key === category?.key}
                  onClick={(e) => {
                    setCatKey(c.key);
                    setSetKey(null);
                    e.currentTarget.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
                  }}
                >
                  <span>{c.key === "leagues" ? t("overlay.leagues") : c.key === "rarities" ? t("overlay.rarities") : c.name}</span>
                  <b>{c.sets.length}</b>
                </button>
              ))}
            </nav>
            <Keycap ps="R2" xb="RT" kb="E" />
            </div>
            <div className="sets-mid">
              <aside className="set-list panel ring tier-dense" key={category?.key}>
                <div className="list">
                  {category?.sets.map((s, i) => (
                    <div key={s.key} data-set={s.key}>
                      <SetRow
                        set={s}
                        index={i}
                        active={s.key === selected?.key}
                        onSelect={() => {
                          setSetKey(s.key);
                          setZone("list");
                          if (narrow) setSetOpen(true);
                        }}
                      />
                    </div>
                  ))}
                </div>
              </aside>
              {/* the next grades worth buying (Best value) under the table – the column never ends in a void */}
              <section className="panel ring sets-bv" aria-label={t("section.value")}>
                <header>
                  <span className="sec-t">{t("section.value")}</span>
                  <button className="btn btn-quiet btn-s" onClick={() => setSection("value")}>
                    {t("v2.sets.allValue")}
                  </button>
                </header>
                {best.busy && !best.data ? (
                  <p className="ml-loading">{t("value.calculating")}</p>
                ) : !rankByValue(best.data?.sets ?? []).some((v) => bestStep(v)) ? (
                  <p className="sets-bv-none">{t("lh.value.none")}</p>
                ) : (
                  <div className="list rule">
                    {rankByValue(best.data?.sets ?? [])
                      .slice(0, 6)
                      .map((v) => {
                        const st = bestStep(v);
                        return (
                          <button
                            key={v.key}
                            className="lrow"
                            data-f
                            onClick={() => {
                              setValueKey(v.key);
                              setSection("value");
                            }}
                          >
                            <GradeDiamond grade={v.grade} size={22} />
                            <span className="ellip">
                              {v.name}
                              {st && (
                                <span className="to-g">
                                  <i>→</i>
                                  <GradeDiamond grade={st.plan.grade} size={16} />
                                </span>
                              )}
                            </span>
                            <span className="faint t-13">{st ? <><b className="num">{st.tokens}</b> {t("v2.tokens")}</> : t(v.unpriced > 0 ? "value.rowUnpriced" : "value.rowNothing", { count: v.unpriced })}</span>
                            <span className="num">{st ? <><i className="coin" /> ≈{num(st.plan.tax)}</> : ""}</span>
                          </button>
                        );
                      })}
                  </div>
                )}
              </section>
            </div>
            <main className="detail-wrap panel ring">
              {narrow && (
                <button className="btn btn-s btn-secondary ring detail-back" onClick={() => (setSetOpen(false), setZone("list"))}>
                  <Keycap ps="○" xb="B" kb="Esc" /> {t("v2.backToSets")}
                </button>
              )}
              {selected && <SetDetail set={selected} ui={cardUi} />}
            </main>
            {embedded && embedOn && (
              <div className="ov-ml" onClick={(e) => e.stopPropagation()}>
                <MissingList embedded />
              </div>
            )}
          </div>
        )}


        {/* only the input in use: the keyboard, or the controller (PlayStation first, then Xbox) */}
        <footer className={`ov-foot input-${input}`}>
          <div className="hints">
            {/* most important first: when the footer is narrow the last ones drop (CSS), never overlap */}
            {[...hints].sort((x, y) => HINT_PRIO.indexOf(x.pad[0]) - HINT_PRIO.indexOf(y.pad[0])).map((h, i) => (
              <span key={i} className="key">
                {Array.from({ length: Math.max(h.pad.length, h.keys.length) }, (_, j) => (
                  <PadKey key={j} id={h.pad[j]} kb={h.keys[j]} />
                ))}
                <span>{t(h.label)}</span>
              </span>
            ))}
          </div>
          {!IS_WEB && (
            <div className="hints">
              <Keycap ps="Create" xb="View" kb="Ctrl+Shift+F" label={pad ? `${t("pad.hold")} · ${t("overlay.hintToggle")}` : t("overlay.hintToggle")} />
              <Keycap ps="Create ×2" xb="View ×2" kb="Ctrl+Shift+M" label={t("v2.sidePanel")} />
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}
