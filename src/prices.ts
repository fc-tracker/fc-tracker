// The shared price pool (fc-tracker.com/api/prices). EA sends its own market average with club
// items and market results, never with the Gallery card lists – so a card you lack has no price
// until someone has seen it. Every FC-Tracker user sees prices of their own club cards anyway, and
// one user's club card is another's "Buy next": so each one sends the averages it saw, and gets
// the pool of its platform back (PC and console markets apart). No extra EA requests, no user id,
// no club – only [card id, EA average, when seen]. Sending follows Settings → Anonymous usage
// statistics; getting the pool is a plain download and always on.
import { api } from "./api";
import { usageEnabled } from "./usage";

const URL_ = "https://www.fc-tracker.com/api/prices";
const SENT_KEY = "fct.prices.sent";
const EVERY = 30 * 60 * 1000;

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

async function round() {
  const share = await api.priceShare(Number(get(SENT_KEY) ?? 0));
  const p = share.platform;
  if (!p) return; // the account's market is not known yet (first sync)
  if (usageEnabled() && share.prices.length) {
    const r = await fetch(URL_, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ p, v: share.prices }), keepalive: true });
    if (r.ok) set(SENT_KEY, String(Math.max(...share.prices.map((x) => x[2]))));
  }
  const pool = (await (await fetch(`${URL_}?p=${p}`)).json()) as { d?: Record<string, [number, number]> };
  if (pool.d) await api.pricePool(p, pool.d);
}

// Paid prices (fc-tracker.com/api/paid): what users paid for a card on the transfer market – the
// price of cards EA gives no average for. A purchase is sent within half a minute and reaches the
// other users of the market at their next pool download (every 3 minutes, cached 1 minute).
const PAID_URL = "https://www.fc-tracker.com/api/paid";
const PAID_SEND_EVERY = 30 * 1000;
const PAID_POOL_EVERY = 3 * 60 * 1000;
let paidPoolAt = 0;

async function paidRound() {
  const share = await api.paidShare();
  const p = share.platform;
  if (!p) return;
  if (usageEnabled() && share.prices.length) {
    await fetch(PAID_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ p, v: share.prices }), keepalive: true });
  }
  if (Date.now() - paidPoolAt < PAID_POOL_EVERY) return;
  paidPoolAt = Date.now();
  const pool = (await (await fetch(`${PAID_URL}?p=${p}`)).json()) as { d?: Record<string, [number, number, number]> };
  if (pool.d) await api.paidPool(p, pool.d);
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Starts the pool rounds: soon after start (a sync may be under way), then every 30 minutes;
 *  paid prices every half minute (sending) and 3 minutes (downloading). */
export function startPrices() {
  if (timer) return;
  const run = () => round().catch(() => {});
  setTimeout(run, 20_000);
  timer = setInterval(run, EVERY);
  setInterval(() => paidRound().catch(() => {}), PAID_SEND_EVERY);
}
