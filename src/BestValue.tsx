// Best value (DESIGN 9r): not the highest score, but what each grade costs. A card bought for the
// Gallery is sold again – it costs EA's 5 % tax; cards already collected cost nothing; nothing is
// suggested that the user's coins can't pay for. Used in the overlay (app) and FC-Tracker Web alike.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type BestValue, type GradePlan, type SetValue, type TokenPlan, type ValueBuy } from "./api";
import { excludeCard, includeCard, useExcluded } from "./excluded";
import { compact, num } from "./format";
import { t, type MessageKey } from "./i18n";
import { Gem } from "./icons";
import { GradeDiamond } from "./Overlay";

export type ValueSection = "value" | "planner";

/** Coins, compact (≈ for prices from EA's market average). */
function Coins({ value, approx = false }: { value: number; approx?: boolean }) {
  return (
    <span className="bv-coins">
      <span className="ml-coin" aria-hidden="true" />
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
const fmtRatio = (n: number) => (n >= 100 ? num(Math.round(n)) : n.toFixed(1));

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

/** Grade tabs: every grade with what reaching it costs from the user's club. */
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
              {g.state === "reached" ? "✓" : g.state === "buy" ? <Coins value={g.coins_needed} approx /> : t(STATE_KEY[g.state])}
            </span>
            <span className="bv-tab-tokens">{g.tokens_total > 0 ? t("overlay.tokens", { count: g.tokens_total }) : " "}</span>
          </button>
        ))}
      </div>
      <ExcludedBar />
      {p && (
        <div className="bv-plan">
          <p className="bv-needs">{t("value.gradeNeeds", { grade: p.grade, score: num(p.score_needed), tokens: p.tokens })}</p>
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

/** Sets ranked by value: the best next grade of each, tokens per 10K tax first. */
export function ValueList({
  sets,
  selected,
  onSelect,
}: {
  sets: SetValue[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <aside className="set-list bv-list">
      {sets.map((v) => {
        const s = bestStep(v);
        return (
          <div key={v.key} data-set={v.key}>
            <button className={`set-row bv-row ${v.key === selected ? "active" : ""}`} onClick={() => onSelect(v.key)}>
              <span className="bv-row-head">
                <span className="set-name">{v.name}</span>
                {s ? (
                  <span className="bv-row-step">
                    <GradeDiamond grade={v.grade} size={20} />→<GradeDiamond grade={s.plan.grade} size={20} />
                  </span>
                ) : (
                  <GradeDiamond grade={v.grade} size={20} />
                )}
              </span>
              <span className="bv-row-meta">
                {s ? (
                  <>
                    <b>+{t("overlay.tokens", { count: s.tokens })}</b>
                    <span title={t("value.per10k", { n: fmtRatio(per10k(s.tokens, s.plan.tax)) })}>{t("value.taxShort", { tax: compact(s.plan.tax) })}</span>
                  </>
                ) : (
                  <span className="muted">{t(v.unpriced > 0 ? "value.rowUnpriced" : "value.rowNothing", { count: v.unpriced })}</span>
                )}
              </span>
            </button>
          </div>
        );
      })}
    </aside>
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

/** Why some sets can't be planned yet: their cards have no price. */
function MissingPrices({ sets }: { sets: SetValue[] }) {
  const blocked = sets.filter((v) => v.plans.some((p) => p.state === "unpriced"));
  const cards = blocked.reduce((n, v) => n + v.unpriced, 0);
  const dear = sets.reduce((n, v) => n + v.plans.filter((p) => p.state === "over_budget").length, 0);
  if (blocked.length === 0 && dear === 0) return null;
  if (blocked.length === 0) return <p className="bv-note">{t("value.tooDear", { count: dear })}</p>;
  return (
    <section className="detail-section bv-missing">
      <h2>{t("value.pricesTitle")}</h2>
      {blocked.length > 0 && (
        <>
          <p className="bv-missing-big">{t("value.pricesBody", { sets: num(blocked.length), cards: num(cards) })}</p>
          <p className="bv-note">{t("value.pricesWhy")}</p>
          <p className="bv-note">{t("value.pricesHelp")}</p>
        </>
      )}
      {dear > 0 && <p className="bv-note">{t("value.tooDear", { count: dear })}</p>}
    </section>
  );
}

type Goal = "all" | "5" | "10" | "tokens";

/** The token planner (DESIGN 9r): a narrow control column – the coins (EA's balance, or another
 * amount), the goal and the result – beside the plan as one card per set. Every change recalculates
 * at once (a named wait); the plan follows the club, so nothing is ticked by hand. */
export function Planner({ data, onChange, busy }: { data: BestValue | null; onChange: (budget: number | null, target: number | null, steps: number | null) => void; busy: boolean }) {
  const [budget, setBudget] = useState<string>("");
  const [target, setTarget] = useState<string>("");
  const [goal, setGoal] = useState<Goal>("all");
  const plan: TokenPlan | null = data?.plan ?? null;
  const parse = (v: string) => {
    const n = Number(v.replace(/[^\d]/g, ""));
    return n > 0 ? n : null;
  };
  const run = (g: Goal = goal, b = budget, tg = target) =>
    onChange(parse(b), g === "tokens" ? parse(tg) : null, g === "5" ? 5 : g === "10" ? 10 : null);
  const pickGoal = (g: Goal) => {
    setGoal(g);
    if (g !== "tokens" || parse(target)) run(g);
  };
  const asked = goal === "5" ? 5 : goal === "10" ? 10 : null;
  const setsByKey = useMemo(() => new Map((data?.sets ?? []).map((v) => [v.key, v])), [data]);
  const allBuys = useMemo(() => {
    const seen = new Map<number, { buy: ValueBuy; sets: string[] }>();
    for (const st of plan?.steps ?? []) for (const b of st.buys) {
      const e = seen.get(b.card.def_id);
      if (e) e.sets.push(st.name);
      else seen.set(b.card.def_id, { buy: b, sets: [st.name] });
    }
    return [...seen.values()].sort((a, b) => b.buy.price - a.buy.price);
  }, [plan]);
  const balance = data?.coins?.[0] ?? null;
  const field = (value: string, set: (v: string) => void, placeholder: string, apply: (v: string) => void) => (
    <input
      inputMode="numeric"
      value={value}
      placeholder={placeholder}
      onChange={(e) => set(e.target.value)}
      onBlur={(e) => apply(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && apply((e.target as HTMLInputElement).value)}
    />
  );
  return (
    <div className="pl">
      <aside className="pl-side">
        <header className="pl-head">
          <p className="eyebrow">{t("value.plannerEyebrow")}</p>
          <h1 className="detail-title">{t("value.plannerTitle")}</h1>
          <p className="pl-sub">{t("value.plannerSub")}</p>
        </header>

        <section className="pl-box">
          <h3>{t("value.budget")}</h3>
          <p className="pl-coins">
            <span className="ml-coin" aria-hidden="true" />
            {parse(budget) ? num(parse(budget)!) : balance != null ? num(balance) : "–"}
            <small>{parse(budget) ? t("value.ownAmount") : balance != null ? t("value.fromEa") : t("value.budgetUnknown")}</small>
          </p>
          <label className="pl-other">
            <span>{t("value.otherAmount")}</span>
            {field(budget, setBudget, balance != null ? num(balance) : "", (v) => run(goal, v))}
          </label>
        </section>

        <section className="pl-box">
          <h3>{t("value.goal")}</h3>
          <div className="pl-seg" role="radiogroup" aria-label={t("value.goal")}>
            {(["all", "5", "10", "tokens"] as Goal[]).map((g) => (
              <button key={g} role="radio" aria-checked={goal === g} className={goal === g ? "on" : ""} onClick={() => pickGoal(g)}>
                {g === "all" ? t("value.goalAll") : g === "tokens" ? t("value.goalTokens") : t("value.goalSets", { count: Number(g) })}
              </button>
            ))}
          </div>
          {goal === "tokens" && (
            <label className="pl-other">
              <span>{t("value.target")}</span>
              {field(target, setTarget, "100", (v) => run("tokens", budget, v))}
            </label>
          )}
          <p className="pl-hint">{t(goal === "all" ? "value.goalAllHint" : goal === "tokens" ? "value.goalTokensHint" : "value.goalSetsHint", { count: asked ?? 0 })}</p>
        </section>

        {plan && plan.steps.length > 0 && (
          <section className="pl-result" aria-live="polite">
            <p className="pl-big">
              <Gem size={18} />+{num(plan.tokens)}
              <small>{t("value.tokensHint")}</small>
            </p>
            <dl>
              {(
                [
                  ["value.lostToTax", "value.taxHint", <Coins value={plan.tax} approx />],
                  ["value.coinsNeeded", "value.neededHint", <Coins value={plan.coins_needed} approx />],
                  ["value.sets", "value.setsHint", <>{num(plan.steps.length)}</>],
                  ["value.players", "value.playersHint", <>{num(plan.players)}</>],
                ] as [MessageKey, MessageKey, React.ReactNode][]
              ).map(([label, hint, value]) => (
                <div key={label} title={t(hint)}>
                  <dt>{t(label)}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        <ExcludedBar />
      </aside>

      <div className="pl-main">
        <ol className="pl-how">
          {(["1", "2", "3"] as const).map((n) => (
            <li key={n}>
              <span className="bv-how-n">{n}</span>
              <div>
                <b>{t(`value.how${n}Title` as MessageKey)}</b>
                <span>{t(`value.how${n}` as MessageKey)}</span>
              </div>
            </li>
          ))}
        </ol>
        {busy && <p className="ml-loading">{t("value.calculating")}</p>}
        {busy && !plan ? null : !plan || plan.steps.length === 0 ? (
          <>
            <p className="bv-note">{t(data && data.sets.some((v) => v.unpriced > 0) ? "value.planEmptyPrices" : "value.planEmpty")}</p>
            {data && <MissingPrices sets={data.sets} />}
          </>
        ) : (
          <>
            {asked != null && plan.steps.length < asked && <p className="bv-note warn">{t("value.fewerSets", { count: plan.steps.length, asked })}</p>}
            <p className="pl-auto">{t("value.autoUpdate")}</p>
            <ol className="pl-steps">
              {plan.steps.map((st, i) => {
                const now = setsByKey.get(st.key);
                return (
                  <li key={`${st.key}:${st.grade}`} className={`pl-step ${st.tokens === 0 ? "zero" : ""}`}>
                    <header>
                      <span className="pl-n">{i + 1}</span>
                      <span className="pl-name">
                        {st.name}
                        <small>
                          {t("value.taxShort", { tax: compact(st.tax) })} · {t("value.needsAtOnce", { coins: compact(st.coins_needed) })}
                        </small>
                      </span>
                      <span className="bv-row-step">
                        <GradeDiamond grade={now?.grade ?? null} size={24} />
                        <span aria-hidden="true">→</span>
                        <GradeDiamond grade={st.grade} size={30} />
                      </span>
                      <b className="pl-tokens">{st.tokens > 0 ? `+${st.tokens}` : "0"}</b>
                    </header>
                    <p className="pl-what">
                      {st.tokens === 0
                        ? t("value.zeroTokens", { grade: st.grade })
                        : st.buys.length > 0
                          ? t("value.stepCards", { count: st.buys.length, set: st.name, grade: st.grade })
                          : t("value.stepNoBuy", { set: st.name, grade: st.grade })}
                    </p>
                    {st.buys.length > 0 && <BuyList buys={st.buys} limit={5} />}
                  </li>
                );
              })}
            </ol>
            <MissingPrices sets={data?.sets ?? []} />
            {allBuys.length > 0 && (
              <details className="detail-section bv-all">
                <summary>{t("value.shopping", { count: allBuys.length })}</summary>
                <ol className="bv-buys">
                  {allBuys.slice(0, 200).map(({ buy, sets }) => (
                    <li key={buy.card.def_id}>
                      <span className="bv-rating">{buy.card.rating ?? "?"}</span>
                      <span className="bv-name">
                        {buy.card.name ?? "?"}
                        <small>{sets.join(" · ")}</small>
                      </span>
                      <Coins value={buy.price} approx />
                      <span className="bv-tax">{t("value.taxShort", { tax: compact(buy.tax) })}</span>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </>
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
