// Best value (DESIGN 9r): not the highest score, but what each grade costs. A card bought for the
// Gallery is sold again – it costs EA's 5 % tax; cards already collected cost nothing; nothing is
// suggested that the user's coins can't pay for. Used in the overlay (app) and FC-Tracker Web alike.
import { useEffect, useMemo, useState } from "react";
import { api, type BestValue, type GradePlan, type SetValue, type TokenPlan, type ValueBuy } from "./api";
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

function BuyList({ buys }: { buys: ValueBuy[] }) {
  // dearest first: buy, place in the set, sell, then the next – the order "coins needed" assumes
  const sorted = [...buys].sort((a, b) => b.price - a.price);
  return (
    <ol className="bv-buys">
      {sorted.map((b) => (
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
          <span className="bv-tax">{t("value.taxShort", { tax: compact(b.tax) })}</span>
        </li>
      ))}
    </ol>
  );
}

/** Grade tabs: every grade with what reaching it costs from the user's club. */
export function GradeCosts({ value, compactView = false }: { value: SetValue; compactView?: boolean }) {
  const firstOpen = value.plans.findIndex((p) => p.state !== "reached");
  const step = bestStep(value);
  const [pick, setPick] = useState<number>(() => (step ? value.plans.indexOf(step.plan) : Math.max(0, firstOpen)));
  useEffect(() => setPick(step ? value.plans.indexOf(step.plan) : Math.max(0, firstOpen)), [value.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const p = value.plans[pick];
  return (
    <section className={`detail-section bv-grades ${compactView ? "compact" : ""}`}>
      <h2>
        {t("value.title")}
        {value.balance != null && <span className="bv-balance"> · {t("value.withCoins", { coins: num(value.balance) })}</span>}
      </h2>
      <div className="bv-tabs" role="tablist">
        {value.plans.map((g, i) => (
          <button key={g.grade} role="tab" aria-selected={i === pick} className={`bv-tab state-${g.state} ${i === pick ? "active" : ""}`} onClick={() => setPick(i)}>
            <GradeDiamond grade={g.grade} size={26} />
            <span className="bv-tab-cost">
              {g.state === "reached" ? "✓" : g.state === "buy" ? <Coins value={g.coins_needed} approx /> : t(STATE_KEY[g.state])}
            </span>
            <span className="bv-tab-tokens">{t("overlay.tokens", { count: g.tokens_total })}</span>
          </button>
        ))}
      </div>
      {p && (
        <div className="bv-plan">
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
                    <span>{t("value.taxShort", { tax: compact(s.plan.tax) })}</span>
                    <span className="bv-ratio">{t("value.per10k", { n: fmtRatio(per10k(s.tokens, s.plan.tax)) })}</span>
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

/** The token planner: a budget (the user's coins by default) or a token target → which sets to
 * take to which grade, and one shopping list for all of them. */
export function Planner({ data, onChange, busy }: { data: BestValue | null; onChange: (budget: number | null, target: number | null, steps: number | null) => void; busy: boolean }) {
  const [budget, setBudget] = useState<string>("");
  const [target, setTarget] = useState<string>("");
  const [steps, setSteps] = useState<number | null>(null);
  const plan: TokenPlan | null = data?.plan ?? null;
  const parse = (s: string) => {
    const n = Number(s.replace(/[^\d]/g, ""));
    return n > 0 ? n : null;
  };
  const apply = (nextSteps = steps) => onChange(parse(budget), parse(target), nextSteps);
  const allBuys = useMemo(() => {
    const seen = new Map<number, { buy: ValueBuy; sets: string[] }>();
    for (const s of plan?.steps ?? []) for (const b of s.buys) {
      const e = seen.get(b.card.def_id);
      if (e) e.sets.push(s.name);
      else seen.set(b.card.def_id, { buy: b, sets: [s.name] });
    }
    return [...seen.values()].sort((a, b) => b.buy.price - a.buy.price);
  }, [plan]);
  return (
    <div className="detail bv-planner">
      <div className="detail-head">
        <div>
          <p className="eyebrow">{t("value.plannerEyebrow")}</p>
          <h1 className="detail-title">{t("value.plannerTitle")}</h1>
          <p className="detail-sub">{t("value.plannerSub")}</p>
        </div>
      </div>
      <form
        className="bv-inputs"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <label>
          <span>{t("value.budget")}</span>
          <input inputMode="numeric" placeholder={data?.coins ? num(data.coins[0]) : t("value.budgetUnknown")} value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
        <label>
          <span>{t("value.target")}</span>
          <input inputMode="numeric" placeholder={t("value.targetAny")} value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>
        <div className="bv-quick" role="group">
          {[null, 5, 10].map((n) => (
            <button
              key={String(n)}
              type="button"
              className={`theme-btn ${steps === n ? "active" : ""}`}
              onClick={() => {
                setSteps(n);
                apply(n);
              }}
            >
              {n == null ? t("value.allSets") : t("value.nextSets", { count: n })}
            </button>
          ))}
        </div>
        <button type="submit" className="theme-btn active">
          {t("value.calculate")}
        </button>
      </form>
      {busy ? (
        <p className="ml-loading">{t("value.calculating")}</p>
      ) : !plan || plan.steps.length === 0 ? (
        <p className="bv-note">{t(data && data.sets.some((s) => s.unpriced > 0) ? "value.planEmptyPrices" : "value.planEmpty")}</p>
      ) : (
        <>
          <dl className="bv-totals big">
            <div>
              <dt>{t("value.tokens")}</dt>
              <dd>+{num(plan.tokens)}</dd>
            </div>
            <div>
              <dt>{t("value.lostToTax")}</dt>
              <dd>
                <Coins value={plan.tax} approx />
              </dd>
            </div>
            <div>
              <dt>{t("value.coinsNeeded")}</dt>
              <dd>
                <Coins value={plan.coins_needed} approx />
              </dd>
            </div>
            <div>
              <dt>{t("value.sets")}</dt>
              <dd>{num(plan.steps.length)}</dd>
            </div>
            <div>
              <dt>{t("value.players")}</dt>
              <dd>{num(plan.players)}</dd>
            </div>
          </dl>
          <section className="detail-section">
            <h2>{t("value.steps")}</h2>
            <ol className="bv-steps">
              {plan.steps.map((s, i) => (
                <li key={`${s.key}-${s.grade}`}>
                  <span className="bv-step-n">{i + 1}</span>
                  <span className="bv-name">{s.name}</span>
                  <GradeDiamond grade={s.grade} size={20} />
                  <b>+{t("overlay.tokens", { count: s.tokens })}</b>
                  <span className="bv-tax">{t("value.taxShort", { tax: compact(s.tax) })}</span>
                  <span className="muted">{t("value.buysCount", { count: s.buys.length })}</span>
                </li>
              ))}
            </ol>
          </section>
          {allBuys.length > 0 && (
            <section className="detail-section">
              <h2>{t("value.shopping", { count: allBuys.length })}</h2>
              <ol className="bv-buys">
                {allBuys.slice(0, 120).map(({ buy, sets }) => (
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
              <p className="bv-note">{t("value.howTo")}</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** Loads Best value once per opening (it computes every set – a second or two on big clubs). */
export function useBestValue(active: boolean) {
  const [data, setData] = useState<BestValue | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (budget: number | null = null, target: number | null = null, steps: number | null = null) => {
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
  return { data, busy, load };
}

/** One set's grades with their costs (the Sets view). */
export function useSetValue(key: string | undefined) {
  const [value, setValue] = useState<SetValue | null>(null);
  useEffect(() => {
    setValue(null);
    if (!key) return;
    let live = true;
    api
      .setValue(key)
      .then((v) => live && setValue(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key]);
  return value;
}
