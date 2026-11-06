import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { ZOOM_BASE } from "./zoomBase";
import { IS_WEB, api, events, formatAge, type BestSelection, type BestValue, type GalleryCardView, type GameSession, type ShoppingList } from "./api";
import { compact, num } from "./format";
import { t, useLocale, type MessageKey } from "./i18n";
import { useTheme } from "./theme";
import { BuyName, useShopping, ShoppingPanel } from "./shopping";
import { PanelMatch } from "./PanelMatch";
import { sharedPlan, useSessionPick } from "./panelShare";
import { placeLabel } from "./Squads";
import { Coin, FaceChip, Gem, Grade, Keycap, Mark } from "./ui";
import { galleryCard } from "./Overlay";
import "./overlay.css";

/** From this many cards the best selection uses dense rows (30-slot league sets fit). */
const DENSE_FROM = 16;
/** Rows per Buy next section – the panel scrolls, so the list is complete enough to choose from. */
const SHOWN = 30;

type Tab = "match" | "best" | "buy" | "shop";

/** The overlay's last tab (Overlay.tsx keeps it in fct.section) – same origin, so readable here. */
function lastSection(): string | null {
  try {
    return localStorage.getItem("fct.section");
  } catch {
    return null;
  }
}

function tagName(id: number, fallback: string) {
  const key = `tag.${id}` as MessageKey;
  const v = t(key);
  return v === key ? fallback : v;
}

/**
 * The tab that fits what the app knows: "Best selection" while the game's selection can be
 * improved (or isn't proven the best yet on a complete set), otherwise "Buy next".
 */
function autoTab(list: ShoppingList): Tab {
  const b = list.best;
  if (!b || b.cards.length === 0) return "buy";
  if (b.gain != null) return b.gain > 0 ? "best" : "buy";
  return list.collected >= list.slots ? "best" : "buy";
}

// ---------- zoom (rule 8: Ctrl + scroll, Ctrl + / − / 0, the overlay's steps; saved for this window) ----------

const ZOOMS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4];
const ZOOM_KEY = "fct.zoom.panel2";
function usePanelZoom(on: boolean): [number, (dir: number) => void] {
  const [zoom, setZoomState] = useState<number>(() => {
    try {
      const z = Number(localStorage.getItem(ZOOM_KEY) ?? "1");
      return ZOOMS.includes(z) ? z : 1;
    } catch {
      return 1;
    }
  });
  const setZoom = useCallback((dir: number) => {
    setZoomState((z) => {
      const i = ZOOMS.indexOf(z);
      const next = dir === 0 ? 1 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 3 : i) + dir))];
      try {
        localStorage.setItem(ZOOM_KEY, String(next));
      } catch {}
      return next;
    });
  }, []);
  useEffect(() => {
    if (!on) return;
    // the panel never takes focus in the app: Ctrl + scroll is the way there (the wheel reaches the
    // window under the cursor); the keys work where it can have focus (dev preview)
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(e.deltaY < 0 ? 1 : -1);
    };
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "0") {
        e.preventDefault();
        setZoom(e.key === "0" ? 0 : e.key === "-" ? -1 : 1);
      }
    };
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", key);
    };
  }, [on, setZoom]);
  return [zoom, setZoom];
}

/** The dev preview's match: `?view=missing&match` (or `match=68` with the clock at 68'). */
const devMatch = import.meta.env.DEV && new URLSearchParams(location.search).has("match");

/**
 * The side panel (window "missing", mockup 07): Match | Best selection | Buy next | Shopping list
 * at the edge of the screen. Never takes focus – it takes the mouse only while the cursor is over
 * it (wheel scrolling, clicks), the game keeps keyboard and controller. In a match it is the match
 * brief and always dark (it sits on the live game).
 */
/** `embedded`: inside the overlay (full screen, browser version) instead of its own window. */
export default function MissingList({ embedded = false }: { embedded?: boolean }) {
  useLocale();
  useTheme();
  const own = !embedded && !IS_WEB;
  const [list, setList] = useState<ShoppingList | null>(null);
  // every wait visible: "Calculating…" until the first answer, then the list or the empty hint
  const [loading, setLoading] = useState(true);
  const [side, setSide] = useState<"left" | "right">("left");
  const [zoom, setZoom] = usePanelZoom(own);
  // A tab picked by hand holds for that set; another set starts from the automatic choice.
  // opened from the Planner: the shopping list; from Squads: the match brief
  const fromSection = (): { key: string; tab: Tab } | null => (lastSection() === "planner" ? { key: "", tab: "shop" } : lastSection() === "squads" || lastSection() === "champions" ? { key: "", tab: "match" } : lastSection() === "value" ? { key: "", tab: "buy" } : null);
  const [picked, setPicked] = useState<{ key: string; tab: Tab } | null>(fromSection);
  // where the user is in the game: in a match the panel is the match brief (opened by a double-tap
  // of View, or left open)
  const [game, setGame] = useState<GameSession>("unknown");
  useEffect(() => {
    api.gameSession().then(setGame).catch(() => {});
    const u = events.onGameSession((g) => {
      setGame(g);
      // a match starts: the brief first (a tab picked during it holds)
      if (g === "in_match") setPicked({ key: "", tab: "match" });
    });
    return () => void u.then((f) => f());
  }, []);
  const inMatch = own && (game === "in_match" || devMatch);
  useEffect(() => {
    if (own) api.uiPrefs().then((p) => setSide(p.missing_side)).catch(() => {});
  }, [own]);
  const switchSide = () => {
    const next = side === "left" ? "right" : "left";
    api.setMissingSide(next).then((p) => setSide(p.missing_side)).catch(() => {});
  };

  const load = useCallback(() => {
    api
      .shoppingList()
      .then(setList)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    const unlisten = [
      events.onMissingSet(() => load()),
      events.onGalleryUpdated(() => document.visibilityState === "visible" && load()),
      events.onSyncDone(() => load()),
      // the game shows an event's hub: its match brief
      events.onSquadsFocus(() => setPicked({ key: "", tab: "match" })),
      // opened again: the tab follows what the app knows (a hand-picked tab doesn't stick)
      events.onMissingVisible((v) => {
        if (v) {
          setPicked(fromSection());
          load();
        }
      }),
    ];
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      unlisten.forEach((p) => p.then((u) => u()));
    };
  }, [load]);

  // The match brief and the shopping list are not one set's – once picked they stay while sets change.
  const tab: Tab =
    picked?.tab === "match" || picked?.tab === "shop"
      ? picked.tab
      : inMatch && !picked
        ? "match"
        : list
          ? picked?.key === list.key
            ? picked.tab
            : autoTab(list)
          : "match";
  const choose = (next: Tab) => setPicked({ key: list?.key ?? "", tab: next });

  const tabsRef = useShortTabs();
  const tabs: [Tab, MessageKey, boolean][] = [
    ["match", "v2panel.tab.match", false],
    ["best", "v2panel.tab.best", !list?.best],
    ["buy", "v2panel.tab.buy", false],
    ["shop", "v2panel.tab.shop", false],
  ];
  // the line under the brand: where the user is
  const ctx = inMatch ? t("v2panel.ctx.match") : game === "closed" ? t("v2panel.ctx.closed") : game === "in_ultimate_team" ? t("v2panel.ctx.ut") : game === "unknown" ? "" : t("v2panel.ctx.menus");

  return (
    <div className={`ml ${own ? "" : "embedded"} ${inMatch ? "in-match" : ""}`} data-theme={inMatch ? "dark" : undefined} style={own ? { zoom: zoom * ZOOM_BASE } : undefined} data-full-text onMouseOver={fullTextOnHover}>
      <header className="ml-h">
        <div className="ml-h1">
          <span className="ml-brand">
            <Mark size={22} />
            <b>FC-Tracker</b>
          </span>
          {ctx && <span className="ml-ctx">{ctx}</span>}
          {own && (
            // Left/Right switch (clickable while the cursor is over the panel)
            <button className="ml-side" onClick={switchSide} title={t("missing.sideHint")} aria-label={t("missing.sideHint")}>
              <span className={side === "left" ? "on" : ""}>{t("settings.left")}</span>
              <span className={side === "right" ? "on" : ""}>{t("settings.right")}</span>
            </button>
          )}
        </div>
        <nav className="ml-tabs" role="tablist" aria-label={t("best.tabs")} ref={tabsRef}>
          {tabs.map(([id, label, disabled]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} disabled={disabled && tab !== id} onClick={() => choose(id)} title={t(label)}>
              <span className="ml-tab-l">{t(label)}</span>
              <span className="ml-tab-s">{t(`v2panel.tabShort.${id}`)}</span>
            </button>
          ))}
        </nav>
      </header>

      {tab === "match" ? (
        <PanelMatch inMatch={inMatch} />
      ) : tab === "shop" ? (
        <ShoppingPanel />
      ) : tab === "buy" ? (
        <BuyNext list={list} />
      ) : !list ? (
        <div className="ml-body">
          <section className="ml-sec">{loading ? <p className="ml-wait">{t("progress.calculating")}</p> : <p className="ml-muted">{t("missing.empty")}</p>}</section>
        </div>
      ) : tab === "best" && list.best ? (
        <Best list={list} best={list.best} />
      ) : (
        <BuyNext list={list} />
      )}

      {own && (
        <footer className="ml-f" title={t(inMatch ? "v2panel.noFocus" : "v2panel.mouseOnly")}>
          <Keycap ps={t("v2panel.viewTwice")} label={t("v2panel.close")} />
          <span className="ml-f-note">{t(inMatch ? "v2panel.noFocus" : "v2panel.mouseOnly")}</span>
          <span className="ml-zoom" role="group" aria-label={t("overlay.zoom")}>
            <button onClick={() => setZoom(-1)} aria-label={t("overlay.zoomOut")} title={t("overlay.zoomOut")}>
              −
            </button>
            <button className="num" onClick={() => setZoom(0)} title={t("overlay.zoomReset")}>
              {Math.round(zoom * 100)}%
            </button>
            <button onClick={() => setZoom(1)} aria-label={t("overlay.zoomIn")} title={t("overlay.zoomIn")}>
              +
            </button>
          </span>
        </footer>
      )}
    </div>
  );
}

/** Rule 10 (every size): the four tabs keep their full names while they fit; in a narrow panel (or a
 *  long language, or zoomed in) they switch to one word each – never names cut to "Best …". */
function useShortTabs() {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const fit = () => {
      const buttons = [...nav.querySelectorAll<HTMLElement>("button")];
      const gap = parseFloat(getComputedStyle(nav).columnGap) || 0;
      // the long names are measured even while hidden (they stay in the layout, invisible)
      const need = buttons.reduce((w, b) => w + (b.querySelector<HTMLElement>(".ml-tab-l")?.scrollWidth ?? 0) + 10, 0) + gap * (buttons.length - 1);
      nav.classList.toggle("short", need > nav.clientWidth + 10);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(nav);
    return () => ro.disconnect();
  }, []);
  return ref;
}

/** Rule 10: nothing is cut without its full text on hover – any text the panel ends with "…" gets
 *  its whole text as a tooltip the moment the cursor is over it (one listener for every row). */
function fullTextOnHover(e: MouseEvent) {
  for (let el = e.target as HTMLElement | null; el && !el.classList.contains("ml"); el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === "ellipsis") {
      if (!el.title) el.title = el.textContent?.trim() ?? "";
      return;
    }
  }
}

/** the card as a face chip: its portrait on its own rarity colour, rating + position (brand v2) */
function Face({ card, s = 40 }: { card: GalleryCardView; s?: number }) {
  return <FaceChip card={galleryCard(card)} s={s} />;
}

const cardName = (c: GalleryCardView) => c.name ?? (c.slot != null ? t("swaps.slot", { n: c.slot + 1 }) : "?");

/** The best selection from the user's own cards: every card, the ones to put in marked. */
function Best({ list, best }: { list: ShoppingList; best: BestSelection }) {
  const putIn = best.cards.filter((c) => c.in_selection === false).length;
  const dense = best.cards.length >= DENSE_FROM;
  // the card it replaces – by name, or by its slot while the game hasn't named it yet
  const replacedBy = (id: number) => {
    const out = (best.swaps ?? []).find((s) => s.into.def_id === id)?.out;
    return out ? (out.name ?? (out.slot != null ? t("swaps.slot", { n: out.slot + 1 }) : null)) : null;
  };
  // the cards to put in first, then the rest (each by points)
  const cards = [...best.cards].sort((a, b) => Number(b.in_selection === false) - Number(a.in_selection === false));
  const swaps = best.swaps ?? [];
  const status =
    best.gain != null && best.gain > 0
      ? t("best.gain", { gain: num(best.gain), ingame: num(best.ingame ?? 0), count: putIn })
      : best.gain === 0
        ? t("best.isBest")
        : best.ingame != null
          ? best.total > best.ingame
            ? t("best.estimate", { ingame: num(best.ingame), gain: num(best.total - best.ingame) })
            : t("best.unproven", { ingame: num(best.ingame) })
          : putIn > 0
            ? t("best.fillIn", { count: putIn })
            : t("best.openSet");
  return (
    <div className="ml-body" key={`best-${list.key}`}>
      <section className="ml-sec">
        <span className="eyebrow">{t("best.tab")}</span>
        <h1 className="ml-title">{list.name}</h1>
        <p className="ml-total">
          <Gem />
          <b className="num">{num(best.total)}</b>
          <small>{t("best.split", { base: num(best.base), bonus: num(best.bonus) })}</small>
        </p>
        <p className={`ml-status ${best.gain != null && best.gain > 0 ? "up" : best.gain === 0 ? "ok" : ""}`}>{status}</p>
        {swaps.length > 0 && (
          <div className="ml-swaps" aria-label={t("best.swapsTitle", { count: swaps.length })}>
            <span className="eyebrow">{t(swaps.length === 1 ? "best.swapsTitleOne" : "best.swapsTitle", { count: swaps.length })}</span>
            <ol>
              {swaps.map((s, i) => (
                <li key={`${s.into.def_id}-${i}`}>
                  <span className="ml-swap-out">
                    {s.out ? (
                      <>
                        <Face card={s.out} s={30} />
                        <span className="ml-ellip">{cardName(s.out)}</span>
                      </>
                    ) : (
                      <em>{t("best.swapOpen")}</em>
                    )}
                  </span>
                  <span className="ml-swap-arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="ml-swap-in">
                    <Face card={s.into} s={30} />
                    <span className="ml-ellip">{s.into.name ?? "?"}</span>
                  </span>
                  <b className={`num ml-swap-gain ${s.gain > 0 ? "up" : ""}`}>
                    {s.gain > 0 ? "+" : s.gain < 0 ? "−" : "±"}
                    {num(Math.abs(s.gain))}
                  </b>
                </li>
              ))}
            </ol>
            <p>{t("best.swapsHow")}</p>
          </div>
        )}
      </section>

      <section className="ml-sec">
        <ol className={`ml-list ${dense ? "dense" : ""}`}>
          {/* one card per row with room to read it; a card to put in says what it replaces */}
          {cards.map(({ card, in_selection }) => (
            <li key={card.def_id} className={`ml-row ${in_selection === false ? "put-in" : ""}`}>
              <Face card={card} s={dense ? 32 : 40} />
              <span className="ml-name">
                <b className="ml-ellip">{cardName(card)}</b>
                <small>{card.position ?? ""}</small>
                {["known", "manual", "scanned"].includes(card.first_owner) && (
                  <span className="tag ml-fo" title={t("best.firstOwner")}>
                    {t("v2panel.fo")}
                  </span>
                )}
              </span>
              <span className="ml-points num">
                <Gem />
                {compact(card.score)}
              </span>
              <span className="ml-state">
                {in_selection === false ? (
                  <span className="ml-putin" title={replacedBy(card.def_id) ?? undefined}>
                    {replacedBy(card.def_id) ? t("best.putInFor", { name: replacedBy(card.def_id)! }) : t("best.putInFree")}
                  </span>
                ) : in_selection ? (
                  <span className="ml-in" aria-label={t("v2panel.inSelection")}>
                    ✓
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="ml-sec ml-notes">
        {best.tags.length > 0 && (
          <span className="ml-tags">
            {best.tags.slice(0, 6).map((tag) => (
              <span key={tag.id}>
                {tagName(tag.id, tag.name)} <b className="num">+{compact(tag.bonus)}</b>
              </span>
            ))}
          </span>
        )}
        <span>{putIn > 0 ? t("best.howTo") : t("best.note", { slots: list.slots })}</span>
      </section>
    </div>
  );
}

/** EA's market average for a card (≈, its age on hover); older than 3 days is dimmed. */
function Coins({ card, perK = null }: { card: GalleryCardView; perK?: number | null }) {
  if (!card.price) return null;
  const old = card.price_at != null && Date.now() - card.price_at > 3 * 86400 * 1000;
  const title = [t("missing.priceTitle", { age: formatAge(card.price_at) }), perK != null ? t("missing.perK", { n: num(perK) }) : null].filter(Boolean).join(" · ");
  return (
    <span className={`ml-coins ${old ? "old" : ""}`} title={title}>
      <Coin />
      <b className="num">≈{compact(card.price)}</b>
    </span>
  );
}

function BuyRow({ e }: { e: ShoppingList["entries"][number] }) {
  return (
    <li className={`ml-buy ${e.got ? "got" : e.gain > 0 ? "" : "no-gain"}`}>
      <Face card={e.card} />
      <span className="ml-col">
        <BuyName card={e.card} />
        <span className="ml-muted ml-small">{e.gain > 0 ? t("v2panel.setScore", { n: num(e.gain) }) : t("v2panel.noGain")}</span>
      </span>
      <span className="ml-price">
        {e.got ? (
          <span className="ml-got">✓ {t(e.got_source === "pack" ? "missing.gotPack" : "missing.got")}</span>
        ) : e.card.price ? (
          <Coins card={e.card} perK={e.per_k ?? null} />
        ) : (
          <span className="ml-noprice">{t("missing.noPrice")}</span>
        )}
      </span>
    </li>
  );
}

/** The squad the user plays (the overlay's session, shared): its cards to buy – no plan worked out here. */
function useSquadBuys() {
  const view = sharedPlan()?.view ?? null;
  const [picked] = useSessionPick(view);
  const s = view?.combos.find((x) => x.id === picked) ?? view?.combos[0];
  const st = s?.stages.find((x) => x.from <= s.played + 1 && (x.to == null || s.played + 1 <= x.to)) ?? null;
  const buys = (st?.squad ?? s?.squad)?.slots.filter((x) => x.owned === false) ?? [];
  const club = new Map((view?.club ?? []).map((c) => [c.key, c]));
  return { s, buys, club };
}

function SquadBuys({ sb }: { sb: ReturnType<typeof useSquadBuys> }) {
  const { s, buys, club } = sb;
  if (!s || buys.length === 0) return null;
  return (
    <section className="ml-sec">
      <div className="ml-row2">
        <span className="eyebrow">{t("v2panel.forSquad", { place: placeLabel(s.place, s.place_name) })}</span>
        <span className="chip accent-soft">{t("v2panel.cards", { count: buys.length })}</span>
      </div>
      <ol className="ml-list">
        {buys.map((x) => (
          <li key={x.key ?? x.def_id} className="ml-buy">
            <FaceChip card={{ name: x.name, rating: x.rating, position: x.pos, rareflag: x.rareflag ?? club.get(x.key ?? -1)?.rareflag ?? null, defId: x.def_id }} s={48} pos={x.pos} />
            <span className="ml-col">
              <b className="ml-ellip">
                {x.generic ? t("squads.slot.eg", { name: x.name }) : x.name} · {x.pos}
              </b>
              <span className="ml-muted ml-small">{t("v2panel.countsFor", { count: x.counts_for.length })}</span>
            </span>
            <span className="ml-price">
              {x.price ? (
                <span className="ml-coins">
                  <Coin />
                  <b className="num">{num(x.price)}</b>
                </span>
              ) : (
                <span className="ml-noprice">{t("missing.noPrice")}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** "Then · Planner": the token plan's next priced steps (the Shopping list tab has every card). */
function PlannerSteps({ steps }: { steps: BestValue["plan"]["steps"] }) {
  if (steps.length === 0) return null;
  return (
    <section className="ml-sec">
      <div className="ml-row2">
        <span className="eyebrow">{t("v2panel.thenPlanner")}</span>
        <span className="ml-faint ml-small">{t("v2panel.pricedSteps", { count: steps.length + 1 })}</span>
      </div>
      {steps.slice(0, 4).map((st) => (
        <div className="ml-task" key={st.key}>
          <Grade g={st.grade} size="s" />
          <span className="ml-ellip">
            <b>{st.name}</b> · {t("v2panel.tokens", { count: st.tokens })}
          </span>
          <span className="ml-price">
            <span className="ml-coins">
              <Coin />
              <b className="num">{num(st.coins_needed)}</b>
            </span>
            <small>{t("value.taxShort", { tax: num(st.tax) })}</small>
          </span>
        </div>
      ))}
    </section>
  );
}

/** "Not priced yet · closest": sets whose next grade has cards nobody priced yet, the fewest points to go first. */
function NotPriced({ data }: { data: BestValue | null }) {
  const rows = (data?.sets ?? [])
    .flatMap((s) => {
      const next = s.plans.find((p) => p.state !== "reached");
      return next && next.state === "unpriced" ? [{ key: s.key, name: s.name, grade: next.grade, tokens: next.tokens, toGo: Math.max(0, next.score_needed - s.score) }] : [];
    })
    .sort((a, b) => a.toGo - b.toGo)
    .slice(0, 10);
  if (rows.length === 0) return null;
  return (
    <section className="ml-sec">
      <div className="ml-row2">
        <span className="eyebrow">{t("v2panel.notPriced")}</span>
        <span className="ml-faint ml-small">{t("v2panel.toGo")}</span>
      </div>
      {rows.map((r) => (
        <div className="ml-task" key={r.key}>
          <Grade g={r.grade} size="s" />
          <span className="ml-ellip">
            <b>{r.name}</b> · {t("v2panel.tokens", { count: r.tokens })}
          </span>
          <b className="num ml-togo">{num(r.toGo)}</b>
        </div>
      ))}
    </section>
  );
}

/**
 * Buy next (mockup 07): the squad's buys, the Planner's first step with its cards, the Planner's
 * next steps, the total of these cards, then the sets not priced yet. The Gallery set on screen
 * keeps its own best buys, folded at the end (the panel still follows the set the game shows).
 */
function BuyNext({ list }: { list: ShoppingList | null }) {
  const sb = useSquadBuys();
  const { data, busy, loaded } = useShopping(true);
  const steps = data?.plan.steps ?? [];
  const step = steps[0] ?? null;
  // what a card adds to the set – only where the list knows it (the set on screen), never guessed
  const gainOf = new Map(list && step && step.key === list.key ? [...list.entries, ...(list.valuable ?? [])].map((e) => [e.card.def_id, e.gain]) : []);
  const priced = sb.buys.filter((x) => x.price);
  const totalCards = priced.length + (step?.buys.length ?? 0);
  const total = priced.reduce((n, x) => n + (x.price ?? 0), 0) + (step?.buys.reduce((n, b) => n + b.price, 0) ?? 0);
  const forCoins = list ? list.entries.slice(0, SHOWN) : [];
  return (
    <div className="ml-body">
      <SquadBuys sb={sb} />
      {busy && data && (
        <section className="ml-sec">
          <p className="ml-wait ml-small">{t("v2panel.updating")}</p>
        </section>
      )}
      {step ? (
        <section className="ml-sec">
          <div className="ml-row2">
            <span className="eyebrow">{t("v2panel.toGrade", { set: step.name, grade: step.grade })}</span>
            <span className="ml-faint ml-small">
              <b className="num">{step.tokens}</b> {t("v2panel.tokensWord")}
            </span>
          </div>
          <ol className="ml-list">
            {step.buys.map((b) => {
              const gain = gainOf.get(b.card.def_id);
              return (
                <li key={b.card.def_id} className="ml-buy">
                  <Face card={b.card} s={48} />
                  <span className="ml-col">
                    <BuyName card={b.card} />
                    {gain != null && gain > 0 && <span className="ml-muted ml-small">{t("v2panel.setScore", { n: num(gain) })}</span>}
                  </span>
                  <span className="ml-price">
                    <span className="ml-coins">
                      <Coin />
                      <b className="num">{num(b.price)}</b>
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      ) : !loaded ? (
        <section className="ml-sec">
          <p className="ml-wait">{t("missing.shopCalculating")}</p>
        </section>
      ) : sb.buys.length === 0 ? (
        <section className="ml-sec">
          <p className="ml-muted">{t("value.planEmpty")}</p>
        </section>
      ) : null}

      <PlannerSteps steps={steps.slice(1)} />

      {totalCards > 0 && (
        <section className="ml-sec">
          <div className="ml-row2">
            <span className="eyebrow">{t("v2panel.total", { count: totalCards })}</span>
            <span className="ml-coins">
              <Coin />
              <b className="num ml-big">{num(total)}</b>
            </span>
          </div>
          <span className="ml-muted ml-small">{t("v2panel.searchHint")}</span>
        </section>
      )}

      <NotPriced data={data} />

      {list && forCoins.length > 0 && !(list.top_reached || list.missing === 0) && (
        <section className="ml-sec">
          <details className="ml-all">
            <summary>
              {list.name} · {t("missing.forCoins")}
            </summary>
            <ol className="ml-list">
              {forCoins.map((e) => (
                <BuyRow key={e.card.def_id} e={e} />
              ))}
            </ol>
          </details>
        </section>
      )}
    </div>
  );
}
