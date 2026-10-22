import { useCallback, useEffect, useState } from "react";
import { IS_WEB, api, events, formatAge, type BestSelection, type GalleryCardView, type ShoppingList } from "./api";
import { cardTier, compact, num } from "./format";
import { rarity } from "./rarities";
import { t, useLocale, type MessageKey } from "./i18n";
import { Gem } from "./icons";
import { useTheme } from "./theme";
import { ShoppingPanel } from "./shopping";
import "./overlay.css";

/** Rows of "Best for your coins": the side window can't scroll (it never takes the mouse), so it
 *  keeps the top few and lets the most valuable fill the rest; the overlay and web scroll all. */
const FOR_COINS_WINDOW = 5;
const SHOWN_EMBEDDED = 30;
/** From this many cards the best selection uses dense rows (30-slot league sets fit). */
const DENSE_FROM = 16;

type Tab = "best" | "buy" | "shop";

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

/**
 * Click-through side panel (window "missing"): for the set the user is on in-game (or picked in
 * the overlay) the best selection from their own cards, and the cards to buy next. Never takes
 * focus – only the tab strip at the top takes mouse clicks, the game keeps the input.
 */
/** `embedded`: inside the overlay (full screen, browser version) instead of its own window. */
export default function MissingList({ embedded = false }: { embedded?: boolean }) {
  useLocale();
  useTheme();
  const [list, setList] = useState<ShoppingList | null>(null);
  // every wait visible: "Calculating…" until the first answer, then the list or the empty hint
  const [loading, setLoading] = useState(true);
  const [side, setSide] = useState<"left" | "right">("left");
  // A tab picked by hand holds for that set; another set starts from the automatic choice.
  const [picked, setPicked] = useState<{ key: string; tab: Tab } | null>(() => (lastSection() === "planner" ? { key: "", tab: "shop" } : null));
  useEffect(() => {
    api.uiPrefs().then((p) => setSide(p.missing_side)).catch(() => {});
  }, []);
  const switchSide = () => {
    const next = side === "left" ? "right" : "left";
    api.setMissingSide(next).then((p) => setSide(p.missing_side)).catch(() => {});
  };
  // Left/Right switch, top-right (clickable through side_switch_watch in lib.rs)
  const sideSwitch = IS_WEB || embedded ? null : (
    <button className="ml-side" onClick={switchSide} title={t("missing.sideHint")} aria-label={t("missing.sideHint")}>
      <span className={side === "left" ? "on" : ""}>{t("settings.left")}</span>
      <span className={side === "right" ? "on" : ""}>{t("settings.right")}</span>
    </button>
  );

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
      // opened again: the tab follows what the app knows (a hand-picked tab doesn't stick)
      events.onMissingVisible((v) => {
        if (v) {
          // opened from the Planner (the overlay's last tab): the shopping list, else what the app knows
          setPicked(lastSection() === "planner" ? { key: "", tab: "shop" } : null);
          load();
        }
      }),
    ];
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      unlisten.forEach((p) => p.then((u) => u()));
    };
  }, [load]);

  if (!list) {
    return (
      <div className={`ml ${embedded || IS_WEB ? "embedded" : ""}`}>
        <div className="ml-top">{sideSwitch}</div>
        <div className="ml-frame">
          {loading ? <p className="ml-empty ml-loading">{t("progress.calculating")}</p> : <p className="ml-empty">{t("missing.empty")}</p>}
        </div>
      </div>
    );
  }

  // The shopping list is the whole plan, not one set – once picked it stays while sets change.
  const tab: Tab = picked?.tab === "shop" ? "shop" : picked?.key === list.key ? picked.tab : autoTab(list);
  const choose = (next: Tab) => setPicked({ key: list.key, tab: next });

  return (
    <div className={`ml ${embedded || IS_WEB ? "embedded" : ""}`}>
      <div className="ml-top">
      <div className="ml-tabs" role="tablist" aria-label={t("best.tabs")}>
        <button role="tab" aria-selected={tab === "best"} className={tab === "best" ? "on" : ""} onClick={() => choose("best")} disabled={!list.best}>
          {t("best.tab")}
        </button>
        <button role="tab" aria-selected={tab === "buy"} className={tab === "buy" ? "on" : ""} onClick={() => choose("buy")}>
          {t("missing.title")}
        </button>
        <button role="tab" aria-selected={tab === "shop"} className={tab === "shop" ? "on" : ""} onClick={() => choose("shop")}>
          {t("missing.shopTab")}
        </button>
      </div>
      {sideSwitch}
      </div>
      {tab === "shop" ? <ShoppingPanel /> : tab === "best" && list.best ? <Best list={list} best={list.best} /> : <BuyNext list={list} forCoinsShown={IS_WEB || embedded ? SHOWN_EMBEDDED : FOR_COINS_WINDOW} />}
    </div>
  );
}

function Rating({ card }: { card: GalleryCardView }) {
  const r = rarity(card.rareflag);
  return (
    <span className={`ml-rating tier-${cardTier(card)} rar-${r.family} ${card.holo ? "holo" : ""}`} title={r.name ?? undefined}>
      {card.rating ?? "?"}
    </span>
  );
}

/** The best selection from the user's own cards: every card, the ones to put in marked. */
function Best({ list, best }: { list: ShoppingList; best: BestSelection }) {
  const putIn = best.cards.filter((c) => c.in_selection === false).length;
  const dense = best.cards.length >= DENSE_FROM;
  // the cards to put in first, then the rest (each by points)
  const cards = [...best.cards].sort((a, b) => Number(b.in_selection === false) - Number(a.in_selection === false));
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
    <div className="ml-frame" key={`best-${list.key}`}>
      <header className="ml-head">
        <span className="eyebrow">{t("best.tab")}</span>
        <h1 className="ml-title">{list.name}</h1>
        <p className="ml-best-total">
          <Gem size={12} /> {num(best.total)}
          <small>{t("best.split", { base: num(best.base), bonus: num(best.bonus) })}</small>
        </p>
        <p className={`ml-sub ${best.gain != null && best.gain > 0 ? "ml-up" : best.gain === 0 ? "ml-ok" : ""}`}>{status}</p>
        {(best.swaps ?? []).length > 0 && (
          <section className="ml-swaps" aria-label={t("best.swapsTitle", { count: best.swaps.length })}>
            <h2>{t((best.swaps ?? []).length === 1 ? "best.swapsTitleOne" : "best.swapsTitle", { count: best.swaps.length })}</h2>
            <ol>
              {best.swaps.map((s, i) => (
                <li key={`${s.into.def_id}-${i}`}>
                  <span className="ml-swap-out">
                    {s.out ? (
                      <>
                        <Rating card={s.out} />
                        {s.out.name ?? (s.out.slot != null ? t("swaps.slot", { n: s.out.slot + 1 }) : "?")}
                      </>
                    ) : (
                      <em>{t("best.swapOpen")}</em>
                    )}
                  </span>
                  <span className="ml-swap-arrow" aria-hidden="true">→</span>
                  <span className="ml-swap-in">
                    <Rating card={s.into} />
                    {s.into.name ?? "?"}
                  </span>
                  <span className={`ml-swap-gain ${s.gain > 0 ? "ml-up" : ""}`}>
                    {s.gain > 0 ? "+" : s.gain < 0 ? "−" : "±"}
                    {num(Math.abs(s.gain))}
                  </span>
                </li>
              ))}
            </ol>
            <p>{t("best.swapsHow")}</p>
          </section>
        )}
        </header>

      <ol className={`ml-list ${dense ? "dense" : ""}`}>
        {cards.map(({ card, in_selection }, i) => (
          <li
            key={card.def_id}
            className={`ml-row best ${in_selection === false ? "put-in" : ""}`}
            style={{ animationDelay: `${i * 18}ms` }}
          >
            <Rating card={card} />
            <span className="ml-name">
              {card.name ?? (card.slot != null ? t("swaps.slot", { n: card.slot + 1 }) : "?")}
              {!dense && <small>{card.position ?? ""}</small>}
              {["known", "manual", "scanned"].includes(card.first_owner) && (
                <span className="ml-fo" title={t("best.firstOwner")}>
                  1
                </span>
              )}
            </span>
            <span className="ml-points">
              <Gem size={9} />
              {compact(card.score)}
            </span>
            {!dense && (
              <span className="ml-price">
                {in_selection === false ? <span className="ml-putin">{t("best.putIn")}</span> : in_selection ? <span className="ml-in">✓</span> : null}
              </span>
            )}
          </li>
        ))}
      </ol>

      <footer className="ml-foot">
        {best.tags.length > 0 && (
          <span className="ml-tags">
            {best.tags.slice(0, 6).map((tag) => (
              <span key={tag.id}>
                {tagName(tag.id, tag.name)} +{compact(tag.bonus)}
              </span>
            ))}
          </span>
        )}
        {dense && putIn > 0 && <span className="ml-putin-key">{t("best.denseKey", { count: putIn })}</span>}
        <span>{putIn > 0 ? t("best.howTo") : t("best.note", { slots: list.slots })}</span>
      </footer>
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
      <span className="ml-coin" aria-hidden="true" />≈{compact(card.price)}
    </span>
  );
}

function BuyRow({ e, i }: { e: ShoppingList["entries"][number]; i: number }) {
  return (
    <li className={`ml-row ${e.got ? "got" : e.gain > 0 ? "" : "no-gain"}`} style={{ animationDelay: `${i * 25}ms` }}>
      <Rating card={e.card} />
      <span className="ml-name">
        {e.card.name ?? "?"}
        <small>{e.card.position ?? ""}</small>
      </span>
      <span className="ml-gain">
        {e.gain > 0 ? (
          <>
            <Gem size={9} />+{compact(e.gain)}
          </>
        ) : (
          "–"
        )}
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

/** Buy next: the best buys for the coins (known price, most points per 1,000 tax), then the most
 *  valuable cards by points – priced or not, so a set whose cards nobody has priced yet still
 *  shows what is worth looking for. */
function BuyNext({ list, forCoinsShown }: { list: ShoppingList; forCoinsShown: number }) {
  // in the side window the most valuable fill whatever height is left (the last rows fade out)
  const forCoins = list.entries.slice(0, forCoinsShown);
  const valuable = (list.valuable ?? []).slice(0, SHOWN_EMBEDDED);
  const done = list.top_reached || list.missing === 0;
  return (
    <div className="ml-frame" key={`buy-${list.key}`}>
      <header className="ml-head">
        <span className="eyebrow">{t("missing.title")}</span>
        <h1 className="ml-title">{list.name}</h1>
        <p className="ml-sub">
          {t("missing.sub", { collected: Math.min(list.collected, list.slots), slots: list.slots, missing: num(list.missing) })}
        </p>
        {list.best?.gain === 0 && <p className="ml-sub ml-ok">{t("best.isBest")}</p>}
        {list.next_grade && (
          <p className="ml-sub ml-next">
            {t("missing.nextGrade", {
              grade: list.next_grade.grade,
              tokens: list.next_grade.tokens_total - (list.tokens_have ?? 0),
              tax: compact(list.next_grade.tax),
              buys: list.next_grade.buys.length,
            })}
          </p>
        )}
      </header>

      {done ? (
        <p className="ml-empty">{t(list.top_reached ? "missing.topReached" : "missing.complete")}</p>
      ) : (
        <div className="ml-scroll">
          <section className="ml-sec">
            <h2>
              {t("missing.forCoins")}
              <small>{list.balance != null ? t("missing.forCoinsSub", { coins: compact(list.balance) }) : t("missing.forCoinsSubNoBalance")}</small>
            </h2>
            {forCoins.length > 0 ? (
              <ol className="ml-list">
                {forCoins.map((e, i) => (
                  <BuyRow key={e.card.def_id} e={e} i={i} />
                ))}
              </ol>
            ) : (
              <p className="ml-none">{t((list.unpriced ?? 0) > 0 ? "missing.nonePriced" : "missing.noValue")}</p>
            )}
          </section>
          {valuable.length > 0 && (
            <section className="ml-sec">
              <h2>
                {t("missing.valuable")}
                <small>{t("missing.valuableSub")}</small>
              </h2>
              <ol className="ml-list">
                {valuable.map((e, i) => (
                  <BuyRow key={e.card.def_id} e={e} i={i + forCoins.length} />
                ))}
              </ol>
            </section>
          )}
        </div>
      )}

      <footer className="ml-foot">
        {list.entries.some((e) => e.got) && <span className="ml-got-hint">✓ {t("missing.gotHint")}</span>}
        {(list.over_budget ?? 0) > 0 && list.balance != null && <span>{t("missing.overBudget", { count: list.over_budget ?? 0, coins: num(list.balance) })}</span>}
        {!done && (list.unpriced ?? 0) > 0 && <span>{t("missing.unpricedIn", { count: list.unpriced ?? 0 })}</span>}
        <span>{t("missing.priceNote")}</span>
        <span>{t("missing.note")}</span>
      </footer>
    </div>
  );
}
