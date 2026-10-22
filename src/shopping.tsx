// The Planner's shopping list: every card of the token plan once, dearest first (buy, place, sell,
// then the next). Shown at full width under the plan and as the side panel's third tab, so it can
// sit next to the game while buying. The side panel plans with the Planner's last coins and goal.
import { useEffect, useMemo, useState } from "react";
import { api, events, type BestValue, type TokenPlan, type ValueBuy } from "./api";
import { cardTier, compact } from "./format";
import { rarity } from "./rarities";
import { t } from "./i18n";

export type ShopItem = { buy: ValueBuy; sets: string[] };

/** Each card of the plan once (a card that fills two sets is bought once), dearest first. */
export function shoppingOf(plan: TokenPlan | null | undefined): ShopItem[] {
  const seen = new Map<number, ShopItem>();
  for (const st of plan?.steps ?? []) {
    for (const b of st.buys) {
      const e = seen.get(b.card.def_id);
      if (e) e.sets.push(st.name);
      else seen.set(b.card.def_id, { buy: b, sets: [st.name] });
    }
  }
  return [...seen.values()].sort((a, b) => b.buy.price - a.buy.price);
}

/** The list itself: number, rating, name with the sets it fills, price and what it costs after tax. */
export function ShoppingRows({ items, limit }: { items: ShopItem[]; limit?: number }) {
  return (
    <ol className="shop-list">
      {items.slice(0, limit ?? 200).map(({ buy, sets }, i) => (
        <li key={buy.card.def_id} style={{ animationDelay: `${Math.min(i, 20) * 18}ms` }}>
          <span className="shop-n">{i + 1}</span>
          <span className={`ml-rating tier-${cardTier(buy.card)} rar-${rarity(buy.card.rareflag).family} ${buy.card.holo ? "holo" : ""}`}>{buy.card.rating ?? "?"}</span>
          <span className="shop-name">
            {buy.card.name ?? "?"}
            <small>{sets.join(" · ")}</small>
          </span>
          <span className="shop-price">
            <span className="bv-coins">
              <span className="ml-coin" aria-hidden="true" />≈{compact(buy.price)}
            </span>
            <small>{t("value.taxShort", { tax: compact(buy.tax) })}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}

const PLAN_KEY = "fct.plan";
type PlanParams = [number | null, number | null, number | null];

/** The Planner remembers its coins and goal so the side panel shows the same plan. */
export function rememberPlan(p: PlanParams) {
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify(p));
  } catch {}
}
function lastPlan(): PlanParams {
  try {
    const v = JSON.parse(localStorage.getItem(PLAN_KEY) ?? "null");
    if (Array.isArray(v) && v.length === 3) return v as PlanParams;
  } catch {}
  return [null, null, null];
}

/** The plan for the side panel: computed when the tab opens, again when the club or the Planner changes. */
export function useShopping(active: boolean): { data: BestValue | null; busy: boolean } {
  const [data, setData] = useState<BestValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const onStorage = (e: StorageEvent) => e.key === PLAN_KEY && bump();
    window.addEventListener("storage", onStorage);
    const un = [events.onSyncDone(bump), events.onGalleryUpdated(bump)];
    return () => {
      window.removeEventListener("storage", onStorage);
      un.forEach((p) => p.then((u) => u()));
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    let live = true;
    setBusy(true);
    api
      .bestValue(...lastPlan())
      .then((d) => live && setData(d))
      .catch(() => {})
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [active, tick]);
  return { data, busy };
}

/** Side panel tab: the shopping list with the plan's result above it. */
export function ShoppingPanel() {
  const { data, busy } = useShopping(true);
  const items = useMemo(() => shoppingOf(data?.plan), [data]);
  const plan = data?.plan;
  return (
    <div className="ml-frame shop-frame">
      <header className="ml-head">
        <span className="eyebrow">{t("value.plannerTitle")}</span>
        <h1 className="ml-title">{t("missing.shopTab")}</h1>
        {plan && plan.steps.length > 0 ? (
          <p className="ml-sub ml-next">
            {t("missing.shopSub", { tokens: plan.tokens, players: items.length, sets: plan.steps.length, coins: compact(plan.coins_needed) })}
          </p>
        ) : null}
      </header>
      {busy && !data ? (
        <p className="ml-empty ml-loading">{t("missing.shopCalculating")}</p>
      ) : items.length === 0 ? (
        <p className="ml-empty">{t("value.planEmpty")}</p>
      ) : (
        <div className="ml-scroll">
          <ShoppingRows items={items} />
        </div>
      )}
      <footer className="ml-foot">
        <span>{t("missing.shopNote")}</span>
      </footer>
    </div>
  );
}
