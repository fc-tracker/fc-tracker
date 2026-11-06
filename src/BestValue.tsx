// Best value (DESIGN 9r, mockup 03): not the highest score, but what each grade costs. A card bought for the
// Gallery is sold again – it costs EA's 5 % tax; cards already collected cost nothing; nothing is
// suggested that the user's coins can't pay for. The Planner (mockup 04) spends a budget along the
// best-value route. Used in the overlay (app) and FC-Tracker Web alike.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type BestValue, type GallerySet, type GradePlan, type PlanStep, type SetValue, type ValueBuy } from "./api";
import { excludeCard, includeCard, useExcluded } from "./excluded";
import { compact, num } from "./format";
import { getLocale, t, type MessageKey } from "./i18n";
import { Gem } from "./icons";
import { GradeDiamond, galleryCard } from "./Overlay";
import { rememberPlan, toggleShopExtra, useShopExtras } from "./shopping";
import { Coin, FaceChip, Grade, GToken, Keycap, Range, ToGrade } from "./ui";

export type ValueSection = "value" | "planner";

/** Coins, compact (≈ for prices from EA's market average). */
function Coins({ value, approx = false }: { value: number; approx?: boolean }) {
  return (
    <span className="bv-coins">
      <i className="coin" aria-hidden="true" />
      {approx ? "≈" : ""}
      {compact(value)}
    </span>
  );
}

const STATE_KEY: Record<GradePlan["state"], MessageKey> = {
  reached: "value.state.reached",
  buy: "value.state.buy",
  over_budget: "value.state.over",
  unpriced: "value.state.unpriced",
  not_possible: "value.state.impossible",
};

/** The best next step of a set: the grade above the reached one with the most tokens per tax coin. */
export function bestStep(v: SetValue): { plan: GradePlan; tokens: number } | null {
  let best: { plan: GradePlan; tokens: number; ratio: number } | null = null;
  for (const p of v.plans) {
    if (p.state !== "buy" || p.tokens_total <= v.tokens_have) continue;
    const tokens = p.tokens_total - v.tokens_have;
    const ratio = tokens / Math.max(1, p.tax);
    if (!best || ratio > best.ratio) best = { plan: p, tokens, ratio };
  }
  return best;
}

/** Tokens per 10,000 coins of tax – the one number to compare value by. */
const per10k = (tokens: number, tax: number) => (tokens * 10_000) / Math.max(1, tax);
/** Coins per token (after tax): whole coins, one decimal under 10. */
const perToken = (tax: number, tokens: number): string => {
  if (tokens <= 0) return "–";
  const p = tax / tokens;
  return p < 10 ? (Math.round(p * 10) / 10).toLocaleString(getLocale(), { maximumFractionDigits: 1 }) : num(Math.round(p));
};

/** The cards to buy, dearest first (buy, place, sell, then the next – the order "coins needed"
 * assumes). No ticks: a card the user bought and placed is collected after the next sync and leaves
 * the list by itself. */
function BuyList({ buys, limit }: { buys: ValueBuy[]; limit?: number }) {
  const sorted = [...buys].sort((a, b) => b.price - a.price);
  const [all, setAll] = useState(false);
  const shown = limit && !all ? sorted.slice(0, limit) : sorted;
  return (
    <>
      <ol className="bv-buys">
        {shown.map((b) => (
          <li key={b.card.def_id}>
            <span className="bv-rating">{b.card.rating ?? "?"}</span>
            <span className="bv-name">
              {b.card.name ?? "?"}
              <small>{b.card.position ?? ""}</small>
            </span>
            <span className="bv-pts">
              <Gem size={9} />
              {compact(b.card.score)}
            </span>
            <Coins value={b.price} approx />
            <button className="bv-x" title={t("value.excludeTitle")} aria-label={t("value.excludeTitle")} onClick={() => excludeCard(b.card)}>
              ✕
            </button>
          </li>
        ))}
      </ol>
      {shown.length < sorted.length && (
        <button className="bv-more" onClick={() => setAll(true)}>
          {t("value.showAll", { count: sorted.length })}
        </button>
      )}
    </>
  );
}

/** The cards the user left out, each one click from coming back. */
function ExcludedBar() {
  const out = useExcluded();
  if (out.length === 0) return null;
  return (
    <div className="bv-excluded">
      <span>{t("value.excluded", { count: out.length })}</span>
      {out.map((c) => (
        <button key={c.id} className="bv-chip" title={t("value.includeTitle")} onClick={() => includeCard(c.id)}>
          {c.rating ?? ""} {c.name ?? "?"} ↺
        </button>
      ))}
      {out.length > 1 && (
        <button className="bv-chip all" onClick={() => includeCard("all")}>
          {t("value.includeAll")}
        </button>
      )}
    </div>
  );
}

/** Grade tabs: every grade with what reaching it costs from the user's club (the Sets view). */
export function GradeCosts({ value, compactView = false }: { value: SetValue; compactView?: boolean }) {
  // Opens on the best next step; else the first grade not reached; with every grade reached, the top one.
  const firstOpen = value.plans.findIndex((p) => p.state !== "reached");
  const step = bestStep(value);
  const start = () => (step ? value.plans.indexOf(step.plan) : firstOpen >= 0 ? firstOpen : value.plans.length - 1);
  const [pick, setPick] = useState<number>(start);
  useEffect(() => setPick(start()), [value.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const p = value.plans[pick];
  const next = value.plans.find((g) => g.state !== "reached");
  // the highest grade the coins reach (or the club already holds) – the top score within the coins
  const top = [...value.plans].reverse().find((g) => g.state === "buy" || g.state === "reached");
  return (
    <section className={`detail-section bv-grades ${compactView ? "compact" : ""}`}>
      <h2>
        {t("value.title")}
        {value.balance != null && <span className="bv-balance"> · {t("value.withCoins", { coins: num(value.balance) })}</span>}
      </h2>
      <p className="bv-sofar">
        {value.collected < value.slots ? (
          <span>{t("value.slotsLeft", { count: value.slots - value.collected })}</span>
        ) : next ? (
          <span>
            <Gem size={10} /> {t("value.toGrade", { score: num(Math.max(0, next.score_needed - value.score)), grade: next.grade })}
          </span>
        ) : (
          <span className="ok">{t("value.allReached")}</span>
        )}
        {top && top.state === "buy" && (
          <button className="bv-top" onClick={() => setPick(value.plans.indexOf(top))}>
            {t("value.topGrade", { grade: top.grade, coins: compact(top.coins_needed), tokens: top.tokens_total })}
          </button>
        )}
      </p>
      <div className="bv-tabs" role="tablist">
        {value.plans.map((g, i) => (
          <button key={g.grade} role="tab" aria-selected={i === pick} className={`bv-tab state-${g.state} ${i === pick ? "active" : ""} ${g === top ? "top" : ""}`} onClick={() => setPick(i)}>
            <GradeDiamond grade={g.grade} size={26} />
            <span className="bv-tab-cost">
              {g.state === "reached" ? (
                <>
                  <span className="bv-check" aria-hidden="true" />
                  {t("value.state.reached")}
                </>
              ) : g.state === "buy" ? (
                <Coins value={g.tax} approx />
              ) : (
                t(STATE_KEY[g.state])
              )}
            </span>
            {/* every tab has the same rows (diamond · cost · after tax · tokens), so they line up */}
            <span className="bv-tab-sub">{g.state === "buy" ? t("value.afterTax") : ""}</span>
            {/* what this grade adds and what you have at it (user 2026-11-01: "45" next to "gives 35" confused) */}
            <span className="bv-tab-tokens">{g.tokens_total > 0 ? (g.tokens > 0 && g.tokens !== g.tokens_total ? t("value.tabTokens", { step: g.tokens, total: g.tokens_total }) : t("overlay.tokens", { count: g.tokens_total })) : " "}</span>
          </button>
        ))}
      </div>
      <ExcludedBar />
      {p && (
        <div className="bv-plan">
          <p className="bv-needs">
            {p.tokens !== p.tokens_total
              ? t("value.gradeNeedsTotal", { grade: p.grade, score: num(p.score_needed), tokens: p.tokens, total: p.tokens_total })
              : t("value.gradeNeeds", { grade: p.grade, score: num(p.score_needed), tokens: p.tokens })}
          </p>
          {p.state === "reached" && <p className="bv-note ok">{t("value.reachedNote", { grade: p.grade })}</p>}
          {p.state === "buy" && (
            <>
              <dl className="bv-totals">
                <div>
                  <dt>{t("value.coinsNeeded")}</dt>
                  <dd>
                    <Coins value={p.coins_needed} approx />
                  </dd>
                </div>
                <div>
                  <dt>{t("value.totalPrice")}</dt>
                  <dd>
                    <Coins value={p.total_price} approx />
                  </dd>
                </div>
                <div>
                  <dt>{t("value.lostToTax")}</dt>
                  <dd>
                    <Coins value={p.tax} approx />
                  </dd>
                </div>
                <div>
                  <dt>{t("value.score")}</dt>
                  <dd>
                    <Gem size={11} /> {num(p.score)}
                  </dd>
                </div>
              </dl>
              {p.buys.length > 0 ? <BuyList buys={p.buys} /> : <p className="bv-note ok">{t("value.noBuys")}</p>}
              <p className="bv-note">{t("value.howTo")}</p>
            </>
          )}
          {p.state === "over_budget" && <p className="bv-note warn">{t("value.overNote", { coins: num(value.balance ?? 0) })}</p>}
          {p.state === "unpriced" && <p className="bv-note">{t("value.unpricedNote", { count: value.unpriced })}</p>}
          {p.state === "not_possible" && <p className="bv-note">{t("value.impossibleNote")}</p>}
        </div>
      )}
    </section>
  );
}

/** The ranking used by the list: sets with a step first (best value), then the rest. */
export function rankByValue(sets: SetValue[]): SetValue[] {
  const score = (v: SetValue) => {
    const s = bestStep(v);
    return s ? per10k(s.tokens, s.plan.tax) : -1;
  };
  return [...sets].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}

/* ───────────────────────── shared: rows the two views rank ───────────────────────── */

/** One priced step: a set going from its grade (or "not complete") to the next grade worth buying. */
type Step = {
  key: string;
  name: string;
  from: string | null;
  grade: string;
  /** what this step pays: the grade's cumulative tokens minus what the set has paid already */
  tokens: number;
  /** what is lost to EA's 5 % tax when the cards are sold again – the product's cost (after tax) */
  tax: number;
  /** the coins needed at once (dearest first, sell, next) */
  coinsNeeded: number;
  buys: ValueBuy[];
  score: number;
  scoreAfter: number;
  cardGain: number;
  bonusGain: number;
  scoreNeeded: number;
  /** the set has no grade yet: this step fills its last slots */
  completes: boolean;
  /** Gallery cards of the set not collected yet (from the Gallery read), null when unknown */
  missing: number | null;
};

function stepOf(v: SetValue, p: GradePlan, tokens: number, gallery: Map<string, GallerySet>): Step {
  const cardGain = p.buys.reduce((a, b) => a + b.card.score, 0);
  return {
    key: v.key, name: v.name, from: v.grade, grade: p.grade, tokens, tax: p.tax, coinsNeeded: p.coins_needed, buys: p.buys,
    score: v.score, scoreAfter: p.score, cardGain, bonusGain: Math.max(0, p.score - v.score - cardGain), scoreNeeded: p.score_needed,
    completes: !v.grade, missing: gallery.get(v.key)?.missing ?? null,
  };
}

/** Best value's table: every set's best next step, the fewest coins per token first. */
function valueSteps(sets: SetValue[], gallery: Map<string, GallerySet>): Step[] {
  return rankByValue(sets)
    .map((v) => {
      const s = bestStep(v);
      return s ? stepOf(v, s.plan, s.tokens, gallery) : null;
    })
    .filter((s): s is Step => s != null);
}

/** "Not priced yet": sets without a priced step whose next grade waits for prices – closest first. */
type Unpriced = { key: string; name: string; grade: string | null; next: string; tokens: number; toGo: number };
function unpricedSets(sets: SetValue[]): Unpriced[] {
  const out: Unpriced[] = [];
  for (const v of sets) {
    if (bestStep(v)) continue;
    const p = v.plans.find((g) => g.state === "unpriced" && g.tokens_total > v.tokens_have);
    if (!p) continue;
    out.push({ key: v.key, name: v.name, grade: v.grade, next: p.grade, tokens: p.tokens_total - v.tokens_have, toGo: Math.max(0, p.score_needed - v.score) });
  }
  return out.sort((a, b) => a.toGo - b.toGo || a.name.localeCompare(b.name));
}

/** The set's grade badge – "–" (not complete yet) as the game's empty badge */


/** "N cards complete the set · M still missing" / "N cards · M still missing" */
function stepSub(s: Step) {
  const cards = t(s.completes ? "v2ov.cardsComplete" : "v2ov.cards", { count: s.buys.length });
  return s.missing != null ? `${cards} · ${t("v2ov.stillMissing", { count: s.missing })}` : cards;
}

/** Set score before → after a step: the score so far, the cards' and the set bonus' share, the grade's line. */
function ScoreFlow({ s }: { s: Step }) {
  const max = Math.max(s.scoreAfter, s.scoreNeeded, 1) * 1.08;
  const pct = (x: number) => `${(100 * x) / max}%`;
  return (
    <div className="v3-flow" role="img" aria-label={t("v2ov.flowLabel", { from: num(s.score), to: num(s.scoreAfter), grade: s.grade, need: num(s.scoreNeeded) })}>
      <span className="bar thick ink v3-bar">
        <i style={{ width: pct(s.score) }} />
        <i className="gain" style={{ left: pct(s.score), width: pct(s.scoreAfter - s.score) }} />
      </span>
      <span className="v3-need" style={{ left: pct(s.scoreNeeded) }} />
    </div>
  );
}

/** Not priced yet: the closest sets first (tokens · points to go). */
function UnpricedRows({ rows, focus, base, onOpen }: { rows: Unpriced[]; focus: number; base: number; onOpen: (key: string) => void }) {
  return (
    <div className="list rule v3-np-list scroll-fade">
      {rows.map((s, i) => (
        <div key={s.key} className={`lrow v3-np-row ${focus === base + i ? "is-focus" : ""}`} data-f data-fi={base + i} onClick={() => onOpen(s.key)}>
          <Grade g={s.grade} size="s" />
          <span className="v3-name">
            <span>{s.name}</span> <ToGrade to={s.next} />
          </span>
          <span className="v3-r num">
            <GToken /> {s.tokens} <small>{t("v2.tokens")}</small>
          </span>
          <span className="v3-r num">
            {num(s.toGo)} <small>{t("v2ov.points")}</small>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Moves the focus with the overlay's D-pad / arrow keys ("fct:view-nav"). */
function useViewNav(on: (action: string) => void) {
  const ref = useRef(on);
  ref.current = on;
  useEffect(() => {
    const h = (e: Event) => ref.current((e as CustomEvent<string>).detail);
    window.addEventListener("fct:view-nav", h);
    return () => window.removeEventListener("fct:view-nav", h);
  }, []);
}
const scrollToFocus = (root: HTMLElement | null, i: number) =>
  requestAnimationFrame(() => root?.querySelector(`[data-fi="${i}"]`)?.scrollIntoView({ block: "nearest" }));

/* ───────────────────────── 03 · Best value ───────────────────────── */

/** Best value (mockup 03): the ranked steps (coins after tax · tokens · per token), the sets that wait
 *  for prices, the coins strip; the focused set on the right with what to buy next. ✕/A adds it to the
 *  shopping list, □/X opens the Planner. */
export function BestValueView({
  data,
  busy,
  gallery,
  pick,
  onPlanner,
  onOpenSet,
}: {
  data: BestValue | null;
  busy: boolean;
  gallery: Map<string, GallerySet>;
  /** a set picked elsewhere (the Sets view's Best value list) opens focused */
  pick?: string | null;
  onPlanner: () => void;
  onOpenSet: (key: string) => void;
}) {
  const steps = useMemo(() => valueSteps(data?.sets ?? [], gallery), [data, gallery]);
  const unpriced = useMemo(() => unpricedSets(data?.sets ?? []), [data]);
  const extras = useShopExtras();
  const [focus, setFocus] = useState(0);
  const [sel, setSel] = useState(0);
  const [act, setAct] = useState<0 | 1 | null>(null); // the detail's buttons: 0 Planner · 1 Add
  const root = useRef<HTMLDivElement>(null);
  const npShown = unpriced.slice(0, 7);
  const count = steps.length + npShown.length;
  useEffect(() => {
    if (sel >= steps.length) setSel(0);
    if (focus >= count) setFocus(0);
  }, [steps.length, count]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const i = pick ? steps.findIndex((x) => x.key === pick) : -1;
    if (i >= 0) {
      setSel(i);
      setFocus(i);
      scrollToFocus(root.current, i);
    }
  }, [pick, steps]);
  const s = steps[Math.min(sel, steps.length - 1)];
  const onList = !!s && extras.some((e) => e.key === s.key && e.grade === s.grade);
  const add = () => s && toggleShopExtra({ key: s.key, name: s.name, grade: s.grade, buys: s.buys });
  // the focus as of the last key press (several presses can land before React renders again)
  const fRef = useRef(focus);
  fRef.current = focus;
  const move = (i: number) => {
    const n = Math.max(0, Math.min(count - 1, i));
    fRef.current = n;
    setFocus(n);
    setAct(null);
    if (n < steps.length) setSel(n);
    scrollToFocus(root.current, n);
  };
  useViewNav((a) => {
    if (a === "up") move(fRef.current - 1);
    else if (a === "down") move(fRef.current + 1);
    else if (a === "right" && s) setAct(1);
    else if (a === "left") setAct((x) => (x === 1 ? 0 : null));
    else if (a === "info") onPlanner();
    else if (a === "select") {
      if (act === 0) onPlanner();
      else if (act === 1) add();
      else if (fRef.current < steps.length) add();
      else if (npShown[fRef.current - steps.length]) onOpenSet(npShown[fRef.current - steps.length].key);
    }
  });
  if (busy && !data) return <div className="ov-empty"><p className="ml-loading">{t("value.calculating")}</p></div>;
  if (!data || (steps.length === 0 && unpriced.length === 0)) return <div className="ov-empty"><p>{t(data ? "value.empty" : "value.calculating")}</p></div>;
  const balance = data.coins?.[0] ?? null;
  const sumTax = steps.reduce((a, x) => a + x.tax, 0);
  const sumTokens = steps.reduce((a, x) => a + x.tokens, 0);
  const top = steps[0];
  return (
    <div className="ov-body v3" ref={root}>
      <section className="v3-left">
        {top ? (
          <header className="v3-hero">
            <span className="eyebrow">{t("section.value")}</span>
            <h1 className="h1">{t("v2.bv.headline", { coins: num(top.tax), tokens: top.tokens })}</h1>
          </header>
        ) : null}
        <div className="panel ring v3-rank">
          <div className="v3-hd v3-cols" aria-hidden="true">
            <span>#</span>
            <span>{t("v2.bv.set")}</span>
            <span className="v3-r" title={t("v2ov.afterTaxTitle")}>{t("v2ov.afterTax")}</span>
            <span className="v3-r">{t("v2ov.tokensCol")}</span>
            <span className="v3-r">{t("v2ov.perToken")}</span>
          </div>
          <div className="list rule v3-rows scroll-fade">
            {steps.map((x, i) => (
              <div
                key={x.key}
                className={`lrow v3-cols v3-row ${i === focus && act == null ? "is-focus" : i === sel ? "is-sel" : ""}`}
                data-f
                data-fi={i}
                onClick={() => move(i)}
              >
                <span className="v3-no num">{i + 1}</span>
                <span className="v3-set">
                  <b className="v3-name">
                    <span>{x.name}</span> <ToGrade to={x.grade} from={x.from ?? undefined} />
                  </b>
                  <small>{stepSub(x)}</small>
                </span>
                <span className="v3-r v3-coin" data-label={t("v2ov.afterTax")}>
                  <Coin /> <b className="num">{num(x.tax)}</b>
                </span>
                <span className="v3-r num v3-big" data-label={t("v2ov.tokensCol")}>{x.tokens}</span>
                <span className="v3-r num v3-big" data-label={t("v2ov.perToken")}>{perToken(x.tax, x.tokens)}</span>
              </div>
            ))}
            {steps.length === 0 && <p className="v3-empty">{t("value.planEmptyPrices")}</p>}
          </div>
        </div>
        {npShown.length > 0 && (
          <div className="panel ring v3-np">
            <div className="v3-np-hd">
              <span className="sec-t">{t("v2ov.notPriced")}</span>
              <button className="v3-np-link" onClick={onPlanner}>
                <Keycap ps="□" xb="X" kb="I" label={t("section.planner")} />
              </button>
            </div>
            <UnpricedRows rows={npShown} focus={focus} base={steps.length} onOpen={onOpenSet} />
            {unpriced.length > npShown.length && <p className="v3-more">{t("v2ov.more", { count: unpriced.length - npShown.length })}</p>}
          </div>
        )}
        <div className="panel ring v3-sum">
          <div>
            <span className="eyebrow">{t("v2ov.yourCoins")}</span>
            <span className="v3-sum-v">
              <Coin /> <b className="num">{balance != null ? num(balance) : "–"}</b>
            </span>
            {balance == null && <small className="faint">{t("v2ov.coinsUnknown")}</small>}
          </div>
          <div>
            <span className="eyebrow">{t("v2ov.allGrades", { count: steps.length })}</span>
            <span className="v3-sum-v">
              <Coin /> <b className="num">{num(sumTax)}</b>
            </span>
            <small className="faint">{t("value.afterTax")}</small>
          </div>
          <div>
            <span className="eyebrow">{t("v2ov.tokensCol")}</span>
            <span className="v3-sum-v">
              <b className="num">{num(sumTokens)}</b>
            </span>
          </div>
          <div>
            <span className="eyebrow">{t("v2ov.leftAfter")}</span>
            <span className="v3-sum-v">
              <Coin /> <b className="num">{balance != null ? num(Math.max(0, balance - sumTax)) : "–"}</b>
            </span>
          </div>
        </div>
      </section>

      {s ? (
        <section className="panel ring xl v3-det" key={s.key}>
          <span className="eyebrow">{t("v2ov.bvOf", { n: sel + 1, count: steps.length })}</span>
          <div className="v3-det-head">
            <div className="v3-det-title">
              <h2 className="h1" title={s.name}>{s.name}</h2>
              <p className="v3-det-sub">
                {s.completes
                  ? t("v2ov.subComplete", { count: s.buys.length, grade: s.grade, score: num(s.scoreNeeded) })
                  : t("v2ov.subReach", { count: s.buys.length, grade: s.grade })}
              </p>
            </div>
            <span className="chip l ring line v3-chip" title={s.completes ? t("v2ov.notCompleteTitle") : undefined}>
              {s.completes ? t("v2ov.notComplete") : null}
              <ToGrade to={s.grade} from={s.completes ? undefined : s.from} />
            </span>
          </div>
          <div className="v3-facts">
            <div>
              <span className="eyebrow">{t("v2ov.coinsAfterTax")}</span>
              <span className="v3-fact">
                <Coin /> <b className="num">{num(s.tax)}</b>
              </span>
              <small>{t("v2ov.coinsAfterTaxSub", { price: num(s.buys.reduce((a, b) => a + b.price, 0)) })}</small>
            </div>
            <div>
              <span className="eyebrow">{t("v2ov.tokensCol")}</span>
              <span className="v3-fact">
                <b className="num">{s.tokens}</b>
              </span>
              <small>{data.sets.find((v) => v.key === s.key)?.plans.find((p) => p.grade === s.grade)?.tokens !== s.tokens ? t("v2ov.tokensUpTo", { grade: s.grade }) : t("v2ov.tokensFor", { grade: s.grade })}</small>
            </div>
            <div>
              <span className="eyebrow">{t("v2ov.perToken")}</span>
              <span className="v3-fact">
                <b className="num">{perToken(s.tax, s.tokens)}</b>
              </span>
              <small>{t("v2ov.rankedBy")}</small>
            </div>
          </div>
          <div className="v3-buys">
            <span className="sec-t">{t("v2ov.buyNext")}</span>
            <div className="list rule scroll-fade">
              {[...s.buys]
                .sort((a, b) => b.price - a.price)
                .map((b) => (
                  <div key={b.card.def_id} className="lrow v3-buy">
                    <FaceChip card={galleryCard(b.card)} s={64} pos={b.card.position ?? undefined} />
                    <span className="v3-set">
                      <b className="v3-name">{b.card.name ?? "?"}</b>
                      <small>{t("v2ov.setScore", { score: num(b.card.score) })}</small>
                    </span>
                    <span className="v3-r v3-coin">
                      <Coin /> <b className="num">≈{num(b.price)}</b>
                    </span>
                    <button className="bv-x" title={t("value.excludeTitle")} aria-label={t("value.excludeTitle")} onClick={() => excludeCard(b.card)}>
                      ✕
                    </button>
                  </div>
                ))}
            </div>
            <ExcludedBar />
          </div>
          <div className="v3-score">
            <span className="num v3-score-a">
              <i className="gem" /> {num(s.score)}
            </span>
            <ScoreFlow s={s} />
            <span className="num v3-score-b">
              {num(s.scoreAfter)}{" "}
              <small>
                · {s.grade} {t("v2ov.from", { score: num(s.scoreNeeded) })}
              </small>
            </span>
          </div>
          <div className="v3-gain">
            <span>
              {t("v2ov.cardsGain")} <b className="num">+{num(s.cardGain)}</b>
            </span>
            <span>
              {t("v2ov.bonusGain")} <b className="num">+{num(s.bonusGain)}</b>
            </span>
            <span>
              {t("v2ov.totalGain")} <b className="num">+{num(s.scoreAfter - s.score)}</b>
            </span>
          </div>
          <div className="v3-actions">
            <button className={`btn btn-secondary ring ${act === 0 ? "is-focus" : ""}`} onClick={onPlanner}>
              <Keycap ps="□" xb="X" kb="I" />
              {t("section.planner")}
            </button>
            <button className={`btn ${onList ? "btn-secondary ring" : "btn-primary"} ${act === 1 ? "is-focus" : ""}`} onClick={add} aria-pressed={onList}>
              {onList ? (
                <>
                  <i className="dot done" /> {t("v2ov.onList")}
                </>
              ) : (
                t("v2ov.addToList")
              )}
            </button>
          </div>
        </section>
      ) : (
        <section className="panel ring xl v3-det">
          <p className="bv-note">{t("value.planEmptyPrices")}</p>
        </section>
      )}
    </div>
  );
}

/* ───────────────────────── 04 · Planner ───────────────────────── */

type RouteRow = Step & { st: PlanStep; i: number };

/** The route: the Planner's steps in order, each with where its set comes from and what it adds. */
function routeOf(steps: PlanStep[], sets: SetValue[], gallery: Map<string, GallerySet>): RouteRow[] {
  const byKey = new Map(sets.map((v) => [v.key, v]));
  const last = new Map<string, { grade: string; score: number; buys: Set<number> }>();
  return steps.map((st, i) => {
    const v = byKey.get(st.key);
    const p = v?.plans.find((g) => g.grade === st.grade);
    const prev = last.get(st.key);
    const from = prev ? prev.grade : (v?.grade ?? null);
    const score = prev ? prev.score : (v?.score ?? 0);
    const scoreAfter = p?.score ?? score;
    const cardGain = (p?.buys ?? st.buys).filter((b) => !prev?.buys.has(b.card.def_id)).reduce((a, b) => a + b.card.score, 0);
    last.set(st.key, { grade: st.grade, score: scoreAfter, buys: new Set((p?.buys ?? st.buys).map((b) => b.card.def_id)) });
    return {
      st, i, key: st.key, name: st.name, from, grade: st.grade, tokens: st.tokens, tax: st.tax, coinsNeeded: st.coins_needed, buys: st.buys,
      score, scoreAfter, cardGain, bonusGain: Math.max(0, scoreAfter - score - cardGain), scoreNeeded: p?.score_needed ?? 0,
      completes: !from && !v?.grade, missing: gallery.get(st.key)?.missing ?? null,
    };
  });
}

/** The token planner (mockup 04): the budget (EA's balance or another amount, slider L2/R2) spent along
 *  the best-value route. A step fits when the coins it needs at once fit what is left after the tax
 *  already lost; the route is the solver's own order (tokens per tax coin), so nothing is ticked by hand. */
export function Planner({
  data,
  busy,
  gallery,
  onLoad,
  onOpenSet,
}: {
  data: BestValue | null;
  busy: boolean;
  gallery: Map<string, GallerySet>;
  /** recompute the route for a budget above the one it was made for */
  onLoad: (budget: number | null) => void;
  onOpenSet: (key: string) => void;
}) {
  const plan = data?.plan ?? null;
  const sets = data?.sets ?? [];
  const balance = data?.coins?.[0] ?? null;
  const route = useMemo(() => routeOf(plan?.steps ?? [], sets, gallery), [plan, sets, gallery]); // eslint-disable-line react-hooks/exhaustive-deps
  const unpriced = useMemo(() => unpricedSets(sets), [sets]);
  // the slider reaches the coins the route was made for (EA's balance, or the amount typed), else what the whole route needs
  const max = Math.max(1, data?.budget ?? plan?.coins_needed ?? 0);
  const [budget, setBudget] = useState<number | null>(null);
  const b = budget ?? max;
  const [draft, setDraft] = useState<string | null>(null);
  const step = Math.max(500, Math.round(max / 50 / 500) * 500);
  // the side panel's shopping list plans with the same coins
  useEffect(() => {
    const id = window.setTimeout(() => rememberPlan([budget, null, null]), 400);
    return () => window.clearTimeout(id);
  }, [budget]);
  const fit = useMemo(() => {
    let spent = 0;
    return route.map((r) => {
      const ok = spent + r.coinsNeeded <= b;
      const need = ok ? 0 : spent + r.coinsNeeded - b;
      if (ok) spent += r.tax;
      return { r, ok, cum: ok ? spent : null, need };
    });
  }, [route, b]);
  const inn = fit.filter((x) => x.ok);
  const sum = {
    tax: inn.reduce((a, x) => a + x.r.tax, 0),
    tokens: inn.reduce((a, x) => a + x.r.tokens, 0),
    cards: inn.reduce((a, x) => a + x.r.buys.length, 0),
    gain: inn.reduce((a, x) => a + (x.r.scoreAfter - x.r.score), 0),
  };
  const firstOut = fit.find((x) => !x.ok);
  const [focus, setFocus] = useState(0);
  const [sel, setSel] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const npShown = unpriced.slice(0, 7);
  const count = route.length + npShown.length;
  useEffect(() => {
    if (sel >= route.length) setSel(0);
    if (focus >= count) setFocus(0);
  }, [route.length, count]); // eslint-disable-line react-hooks/exhaustive-deps
  const fRef = useRef(focus);
  fRef.current = focus;
  const bRef = useRef(b);
  bRef.current = b;
  const move = (i: number) => {
    const n = Math.max(0, Math.min(count - 1, i));
    fRef.current = n;
    setFocus(n);
    if (n < route.length) setSel(n);
    scrollToFocus(root.current, n);
  };
  const setB = (v: number) => {
    const n = Math.max(0, Math.round(v));
    bRef.current = n;
    setBudget(n);
    setDraft(null);
    if (n > max) onLoad(n);
  };
  useViewNav((a) => {
    if (a === "up") move(fRef.current - 1);
    else if (a === "down") move(fRef.current + 1);
    else if (a === "prev_category") setB(Math.max(0, bRef.current - step));
    else if (a === "next_category") setB(Math.min(max, bRef.current + step));
    else if (a === "select") {
      const f = fRef.current;
      const k = f < route.length ? route[f]?.key : npShown[f - route.length]?.key;
      if (k) onOpenSet(k);
    }
  });
  if (busy && !plan) return <div className="ov-empty"><p className="ml-loading">{t("value.calculating")}</p></div>;
  if (!plan || route.length === 0)
    return (
      <div className="ov-empty">
        <p>{t(data && data.sets.some((v) => v.unpriced > 0) ? "value.planEmptyPrices" : data ? "value.planEmpty" : "value.calculating")}</p>
      </div>
    );
  const s = route[Math.min(sel, route.length - 1)];
  const parse = (v: string) => Number(v.replace(/[^\d]/g, "")) || 0;
  const commit = () => draft != null && setB(parse(draft));
  return (
    <div className="ov-body p4" ref={root}>
      <section className="panel ring xl p4-bud">
        <div className="frame-scroll p4-bud-body">
        <h2 className="h2 p4-title">{t("v2ov.spentRight", { coins: num(b) })}</h2>
        <div className="p4-top">
          <div className="p4-tok">
            <span className="p4-lbl">{t("v2ov.tokensForBudget")}</span>
            <span className="num-xl">{num(sum.tokens)}</span>
          </div>
          <label className="p4-field">
            <span className="label">{t("v2ov.budget")}</span>
            <span className="field ring">
              <i className="coin" aria-hidden="true" />
              <input
                inputMode="numeric"
                aria-label={t("v2ov.budget")}
                value={draft ?? num(b)}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => e.key === "Enter" && commit()}
              />
            </span>
          </label>
        </div>
        <div className="p4-range">
          <Range value={Math.min(b, max)} min={0} max={max} step={step >= 1000 ? 500 : 100} label={t("v2ov.budget")} onChange={(v) => { setBudget(v); setDraft(null); }} />
          <div className="p4-range-legend">
            <span className="num">0</span>
            <span className="p4-keys">
              <Keycap ps="L2" xb="LT" kb="Q" />
              <Keycap ps="R2" xb="RT" kb="E" label={t("v2ov.budget")} />
            </span>
            <span className="num">
              {num(max)} · {t(balance != null && data?.budget === balance ? "v2ov.allYourCoins" : "v2ov.wholeRoute")}
            </span>
          </div>
        </div>
        <div className="p4-kv">
          <div>
            <span>{t("v2ov.coinsAfterTax")}</span>
            <b className="num">{num(sum.tax)}</b>
          </div>
          <div>
            <span>{t("v2ov.steps")}</span>
            <b className="num">
              {inn.length}/{route.length}
            </b>
          </div>
          <div>
            <span>{t("v2ov.cardsToBuy")}</span>
            <b className="num">{num(sum.cards)}</b>
          </div>
          <div>
            <span>{t("v2ov.nextNeeds")}</span>
            <b className="num">{firstOut ? `+${num(firstOut.need)}` : "–"}</b>
          </div>
          <div>
            <span>{t("v2ov.coinsLeft")}</span>
            <b className="num">{num(Math.max(0, (balance ?? b) - sum.tax))}</b>
          </div>
          <div>
            <span>{t("v2ov.setScoreGain")}</span>
            <b className="num">+{num(sum.gain)}</b>
          </div>
        </div>
        {s && (
          <div className="p4-det">
            <div className="p4-det-hd">
              <span className="eyebrow">
                {t("v2ov.stepOf", { n: s.i + 1, set: s.name })} <ToGrade to={s.grade} from={s.from} />
              </span>
              <span className="p4-muted">{s.completes ? t("v2ov.completesSet") : ""}</span>
            </div>
            <div className="list rule p4-det-list scroll-fade">
              {[...s.buys]
                .sort((x, y) => y.price - x.price)
                .map((x) => (
                  <div key={x.card.def_id} className="lrow p4-det-row">
                    <span className="p4-name">{x.card.name ?? "?"}</span>
                    <span className="tag">{x.card.position ?? ""}</span>
                    <span className="num">{x.card.rating ?? ""}</span>
                    <span className="v3-r v3-coin">
                      <Coin /> <span className="num">≈{num(x.price)}</span>
                    </span>
                    <button className="bv-x" title={t("value.excludeTitle")} aria-label={t("value.excludeTitle")} onClick={() => excludeCard(x.card)}>
                      ✕
                    </button>
                  </div>
                ))}
              <div className="lrow p4-det-row p4-total">
                <span className="p4-name">{t("v2ov.total")}</span>
                <span />
                <span />
                <span className="v3-r v3-coin">
                  <Coin /> <span className="num">≈{num(s.buys.reduce((a, x) => a + x.price, 0))}</span>
                </span>
                <span />
              </div>
              <div className="lrow p4-det-row p4-tax">
                <span className="p4-name">{t("v2ov.lostToTax")}</span>
                <span />
                <span />
                <span className="v3-r v3-coin">
                  <Coin /> <span className="num">{num(s.tax)}</span>
                </span>
                <span />
              </div>
            </div>
            <ExcludedBar />
            <div className="p4-flow">
              <div className="p4-flow-hd">
                <span className="eyebrow">{t("v2ov.scoreAfterStep", { cards: num(s.cardGain), bonus: num(s.bonusGain) })}</span>
                <span className="p4-muted">
                  {s.grade} {t("v2ov.from", { score: "" })}
                  <b className="num">{num(s.scoreNeeded)}</b>
                </span>
              </div>
              <ScoreFlow s={s} />
              <div className="p4-flow-ft">
                <span className="num">
                  <i className="gem" /> {num(s.score)}
                </span>
                <span className="num">
                  {num(s.scoreAfter)} <small>+{num(s.scoreAfter - s.score)}</small>
                </span>
              </div>
            </div>
            {unpriced[0] && (
              <div className="p4-closest">
                <span className="p4-muted">
                  {t("v2ov.closestUnpriced")} <b>{unpriced[0].name}</b> <ToGrade to={unpriced[0].next} />
                </span>
                <span className="p4-muted">
                  <b className="num">{num(unpriced[0].toGo)}</b> {t("v2ov.points")}
                </span>
              </div>
            )}
          </div>
        )}
        </div>
      </section>

      <div className="p4-right">
        <section className="panel ring p4-route">
          <header className="p4-hd">
            <span className="h3">{t("v2ov.route")}</span>
            {busy && <span className="ml-loading p4-muted">{t("value.calculating")}</span>}
          </header>
          <div className="p4-th p4-cols" aria-hidden="true">
            <span>#</span>
            <span>{t("v2.bv.set")}</span>
            <span>{t("v2ov.cardsToBuy")}</span>
            <span className="v3-r" title={t("v2ov.afterTaxTitle")}>{t("v2ov.afterTax")}</span>
            <span className="v3-r">{t("v2ov.tokensCol")}</span>
            <span className="v3-r">{t("v2ov.perToken")}</span>
            <span className="v3-r">{t("v2ov.running")}</span>
          </div>
          <div className="list rule p4-list scroll-fade">
            {fit.map(({ r, ok, cum }, i) => (
              <div key={`${r.key}:${r.grade}`} className={`lrow p4-cols p4-row ${ok ? "" : "out"} ${i === focus ? "is-focus" : i === sel ? "is-sel" : ""}`} data-f data-fi={i} onClick={() => move(i)}>
                <span className="num p4-n">{i + 1}</span>
                <span className="v3-set">
                  <b className="v3-name">
                    <span>{r.name}</span> <ToGrade to={r.grade} from={r.from ?? undefined} />
                  </b>
                  <small>{stepSub(r)}</small>
                </span>
                <span className="p4-faces">
                  {r.buys.slice(0, 8).map((x) => (
                    <FaceChip key={x.card.def_id} card={galleryCard(x.card)} s={42} pos={x.card.position ?? undefined} />
                  ))}
                  {r.buys.length > 8 && <span className="p4-more num">+{r.buys.length - 8}</span>}
                </span>
                <span className="v3-r v3-coin" data-label={t("v2ov.afterTax")}>
                  <Coin /> <b className="num">{num(r.tax)}</b>
                </span>
                <span className="v3-r num v3-big" data-label={t("v2ov.tokensCol")}>{r.tokens}</span>
                <span className="v3-r num v3-big" data-label={t("v2ov.perToken")}>{perToken(r.tax, r.tokens)}</span>
                <span className="v3-r num p4-cum" data-label={t("v2ov.running")}>{cum != null ? num(cum) : "–"}</span>
              </div>
            ))}
          </div>
        </section>
        {npShown.length > 0 && (
          <section className="panel ring p4-np">
            <header className="p4-hd">
              <span className="col">
                <span className="h3">{t("v2ov.notPriced")}</span>
                <span className="p4-muted">{t("v2ov.npSub", { count: unpriced.length })}</span>
              </span>
            </header>
            <div className="p4-th p4-np-cols" aria-hidden="true">
              <span />
              <span>{t("v2.bv.set")}</span>
              <span className="v3-r">{t("v2ov.tokensCol")}</span>
              <span className="v3-r">{t("v2ov.pointsToGo")}</span>
            </div>
            <UnpricedRows rows={npShown} focus={focus} base={route.length} onOpen={onOpenSet} />
            {unpriced.length > npShown.length && (
              <p className="v3-more">
                {t("v2ov.more", { count: unpriced.length - npShown.length })} · {unpriced.slice(7).map((x) => x.name).join(", ")}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/** Loads Best value once per opening (it computes every set – a second or two on big clubs). */
export function useBestValue(active: boolean) {
  const [data, setData] = useState<BestValue | null>(null);
  const [busy, setBusy] = useState(false);
  const last = useRef<[number | null, number | null, number | null]>([null, null, null]);
  const excluded = useExcluded().length;
  const load = (budget: number | null = null, target: number | null = null, steps: number | null = null) => {
    last.current = [budget, target, steps];
    setBusy(true);
    api
      .bestValue(budget, target, steps)
      .then(setData)
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    if (active && !data && !busy) load();
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (data) load(...last.current);
  }, [excluded]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, busy, load };
}

/** One set's grades with their costs (the Sets view). */
export function useSetValue(key: string | undefined) {
  const [value, setValue] = useState<SetValue | null>(null);
  const excluded = useExcluded().length;
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    // a new set starts empty (its wait is named); the same set keeps its grades while it recomputes
    if (shown.current !== key) setValue(null);
    shown.current = key;
    if (!key) return;
    let live = true;
    api
      .setValue(key)
      .then((v) => live && setValue(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, excluded]);
  return value;
}
