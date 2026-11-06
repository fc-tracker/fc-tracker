// The Planner's shopping list: every card of the token plan once, dearest first (buy, place, sell,
// then the next). Shown at full width under the plan and as the side panel's third tab, so it can
// sit next to the game while buying. The side panel plans with the Planner's last coins and goal.
import { useEffect, useMemo, useState } from "react";
import { api, events, type BestValue, type TokenPlan, type ValueBuy } from "./api";
import { cardTier, compact, num } from "./format";
import { Coin, FaceChip } from "./ui";
import { galleryCard } from "./Overlay";
import { rarity } from "./rarities";
import { t } from "./i18n";

/** A card to buy: name · position, and HOLO when it is the holographic version – two versions of one
 *  player in a list must be told apart (production review SP-4). */
export function BuyName({ card }: { card: { name?: string | null; position?: string | null; holo?: boolean } }) {
  const text = `${card.name ?? "?"}${card.position ? ` · ${card.position}` : ""}`;
  return (
    <span className="ml-nameline">
      <b className="ml-ellip">{text}</b>
      {card.holo && (
        <span className="tag ml-holo" title={t("ui.holo")}>
          {t("v2web.dash.holo")}
        </span>
      )}
    </span>
  );
}

export type ShopItem = { buy: ValueBuy; sets: string[] };

/** A set's grade added from Best value ("Add to shopping list", mockup 03) – kept beside the Planner's plan. */
export type ShopExtra = { key: string; name: string; grade: string; buys: ValueBuy[] };
const EXTRA_KEY = "fct.shop.extra";
export function shopExtras(): ShopExtra[] {
  try {
    const v = JSON.parse(localStorage.getItem(EXTRA_KEY) ?? "[]");
    return Array.isArray(v) ? (v as ShopExtra[]) : [];
  } catch {
    return [];
  }
}
/** Adds a set's grade (or removes it when that grade is there); other windows hear it via the storage event. */
export function toggleShopExtra(x: ShopExtra) {
  const all = shopExtras();
  const at = all.findIndex((e) => e.key === x.key);
  const next = at >= 0 && all[at].grade === x.grade ? all.filter((_, i) => i !== at) : [...all.filter((e) => e.key !== x.key), x];
  try {
    localStorage.setItem(EXTRA_KEY, JSON.stringify(next));
  } catch {}
  window.dispatchEvent(new Event("fct:shop-extra"));
}
export function useShopExtras(): ShopExtra[] {
  const [list, setList] = useState<ShopExtra[]>(shopExtras);
  useEffect(() => {
    const bump = () => setList(shopExtras());
    const onStorage = (e: StorageEvent) => e.key === EXTRA_KEY && bump();
    window.addEventListener("fct:shop-extra", bump);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("fct:shop-extra", bump);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return list;
}

/** Each card of the plan (and of the sets added from Best value) once – a card that fills two sets is
 *  bought once – dearest first. */
export function shoppingOf(plan: TokenPlan | null | undefined, extras: ShopExtra[] = []): ShopItem[] {
  const seen = new Map<number, ShopItem>();
  for (const st of [...(plan?.steps ?? []), ...extras]) {
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

/** The plan the side panel showed last, kept for this window (user 2026-11-05: the Shopping list was
 *  worked out again on every tab click). Worked out again only when an input changed – a sync, new
 *  prices / Gallery data (gallery-updated), the Planner's coins or goal (fct.plan) – and then the old
 *  list stays on screen with a named "Updating…" until the new one is in. */
// `loaded`: an answer is in – also when it was empty (null): the cache held only non-empty plans and an
// empty answer was asked again on every tab click (tester 2026-11-05)
const shop: { params: string; data: BestValue | null; loaded: boolean; dirty: boolean; busy: boolean; watching: boolean } = { params: "", data: null, loaded: false, dirty: true, busy: false, watching: false };
const shopListeners = new Set<() => void>();
const shopNotify = () => shopListeners.forEach((l) => l());
function shopWatch() {
  if (shop.watching) return;
  shop.watching = true;
  const stale = () => {
    shop.dirty = true;
    shopNotify();
  };
  window.addEventListener("storage", (e) => e.key === PLAN_KEY && stale());
  void events.onSyncDone(stale);
  void events.onGalleryUpdated(stale);
}
function shopLoad() {
  const params = JSON.stringify(lastPlan());
  if (shop.busy || (!shop.dirty && shop.params === params && shop.loaded)) return;
  shop.busy = true;
  shop.dirty = false;
  shopNotify();
  api
    .bestValue(...lastPlan())
    .then((d) => {
      shop.data = d;
    })
    .catch(() => {})
    .finally(() => {
      shop.busy = false;
      shop.loaded = true;
      shop.params = params;
      shopNotify();
      // an input changed while it ran: once more
      if (shop.dirty || JSON.stringify(lastPlan()) !== params) shopLoad();
    });
}

/** The plan for the side panel: the last one at once, worked out again only when its inputs changed. */
export function useShopping(active: boolean): { data: BestValue | null; busy: boolean; loaded: boolean } {
  const [, setTick] = useState(0);
  useEffect(() => {
    shopWatch();
    const l = () => setTick((n) => n + 1);
    shopListeners.add(l);
    return () => void shopListeners.delete(l);
  }, []);
  useEffect(() => {
    if (active) shopLoad();
  });
  return { data: shop.data, busy: shop.busy || !shop.loaded, loaded: shop.loaded };
}

/** Side panel tab (mockup 07's section language): the plan's result, then every card to buy –
 *  face, name and the sets it fills, price and what it costs after tax – then the totals. */
export function ShoppingPanel() {
  const { data, busy } = useShopping(true);
  const extras = useShopExtras();
  const items = useMemo(() => shoppingOf(data?.plan, extras), [data, extras]);
  const plan = data?.plan;
  return (
    <div className="ml-body shop-frame">
      <section className="ml-sec">
        <span className="eyebrow">{t("value.plannerTitle")}</span>
        <h1 className="ml-title">{t("missing.shopTab")}</h1>
        {plan && plan.steps.length > 0 ? (
          <p className="ml-status up">{t("missing.shopSub", { tokens: plan.tokens, players: items.length, sets: plan.steps.length, coins: compact(plan.coins_needed) })}</p>
        ) : null}
        {busy && data && <p className="ml-wait ml-small">{t("v2panel.updating")}</p>}
      </section>
      {busy && !data ? (
        <section className="ml-sec">
          <p className="ml-wait">{t("missing.shopCalculating")}</p>
        </section>
      ) : items.length === 0 ? (
        <section className="ml-sec">
          <p className="ml-muted">{t("value.planEmpty")}</p>
        </section>
      ) : (
        <>
          <section className="ml-sec">
            <ol className="ml-list">
              {items.map(({ buy, sets }) => (
                <li key={buy.card.def_id} className="ml-buy">
                  <FaceChip card={galleryCard(buy.card)} s={40} />
                  <span className="ml-col">
                    <BuyName card={buy.card} />
                    <span className="ml-muted ml-small ml-ellip" title={sets.join(" · ")}>
                      {sets.join(" · ")}
                    </span>
                  </span>
                  <span className="ml-price">
                    <span className="ml-coins">
                      <Coin />
                      <b className="num">≈{compact(buy.price)}</b>
                    </span>
                    <small>{t("value.taxShort", { tax: compact(buy.tax) })}</small>
                  </span>
                </li>
              ))}
            </ol>
          </section>
          {plan && (
            <section className="ml-sec">
              <div className="ml-row2">
                <span className="eyebrow">{t("v2panel.total", { count: items.length })}</span>
                <span className="ml-coins">
                  <Coin />
                  <b className="num ml-big">{num(items.reduce((a, x) => a + x.buy.price, 0))}</b>
                </span>
              </div>
            </section>
          )}
        </>
      )}
      <section className="ml-sec ml-notes">
        <span>{t("missing.shopNote")}</span>
      </section>
    </div>
  );
}
