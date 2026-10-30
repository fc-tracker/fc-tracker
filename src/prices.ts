// Prices (api.fc-tracker.com/v1/prices – FC-Tracker's own database, SERVER.md). EA sends its own
// market average with club items and market results, never with the Gallery card lists – so a
// card you lack has no price until someone has seen it. Every FC-Tracker user sees prices of
// their own club cards and their own market searches anyway, and one user's club card is
// another's "Buy next": so each one sends every price it saw – EA's average, a price paid, the
// lowest Buy Now – and gets the pool of its market back (PC and console apart). Every price is
// kept as history on the server. No extra EA requests, no user id, no club: only [card id,
// price, when, kind]. Sending follows Settings → Anonymous usage statistics; getting the pool is a
// plain download and always on.
import { api, IS_WEB } from "./api";
import { usageEnabled } from "./usage";

const API = "https://api.fc-tracker.com/v1";
const SENT_KEY = "fct.prices.sent";
const CARDS_KEY = "fct.cards.sent";
const SEND_EVERY = 2 * 60 * 1000;
const POOL_EVERY = 5 * 60 * 1000;
const CARDS_EVERY = 24 * 60 * 60 * 1000;
const KIND = { avg: 1, paid: 2, bin: 3 } as const;

const get = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const set = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};

let platform: string | null = null;
type Row = [number, number, number, number];

/** Sends what this device saw since the last round: averages, purchases, lowest Buy Nows. */
async function send() {
  const since = Number(get(SENT_KEY) ?? 0);
  const share = await api.priceShare(since);
  platform = share.platform ?? platform;
  // purchases are queued in the app (taken once); the browser sees none
  const paid = IS_WEB ? { platform: null, prices: [] } : await api.paidShare();
  platform = paid.platform ?? platform;
  if (!platform || !usageEnabled()) return;
  const rows: Row[] = [
    ...share.prices.map(([id, p, at]): Row => [id, p, at, KIND.avg]),
    ...(share.bins ?? []).map(([id, p, at]): Row => [id, p, at, KIND.bin]),
    ...paid.prices.map(([id, p, at]): Row => [id, p, at, KIND.paid]),
  ];
  if (!rows.length) return;
  const r = await fetch(`${API}/prices`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ p: platform, v: rows }) });
  const newest = Math.max(since, ...share.prices.map((x) => x[2]), ...(share.bins ?? []).map((x) => x[2]));
  if (r.ok) set(SENT_KEY, String(newest));
}

let poolAt = 0;
/** The market's pool back: EA's newest average and the price most recent purchases agree on. */
async function pool() {
  if (!platform || Date.now() - poolAt < POOL_EVERY) return;
  poolAt = Date.now();
  const r = (await (await fetch(`${API}/prices?p=${platform}`)).json()) as {
    avg?: Record<string, [number, number]>;
    paid?: Record<string, [number, number, number]>;
  };
  if (r.avg) await api.pricePool(platform, r.avg);
  if (r.paid) await api.paidPool(platform, r.paid);
}

/** Once a day: the card definitions this PC knows go to the card list (no ownership). */
async function cards() {
  if (IS_WEB || !usageEnabled() || Date.now() - Number(get(CARDS_KEY) ?? 0) < CARDS_EVERY) return;
  const list = await api.cardDefs();
  if (!list.length) return;
  const r = await fetch(`${API}/cards`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(list) });
  if (r.ok) set(CARDS_KEY, String(Date.now()));
}

async function round() {
  await send().catch(() => {});
  await pool().catch(() => {});
  await cards().catch(() => {});
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Starts the price rounds: soon after start (a sync may be under way), then every 2 minutes
 *  (sending) – the pool comes back every 5. */
export function startPrices() {
  if (timer) return;
  setTimeout(() => void round(), 20_000);
  timer = setInterval(() => void round(), SEND_EVERY);
}
