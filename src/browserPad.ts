// Controller support outside the app (website demo, dev server): the browser's Gamepad API,
// mapped to the same actions the app's gamepad thread sends (src-tauri/src/gamepad.rs), on the
// "standard" layout – PlayStation and Xbox alike. Browsers expose a controller only after one of
// its buttons was pressed while the page is open.

type Listener<T> = (v: T) => void;

// standard mapping: 0 ✕/A, 1 ○/B, 2 ▢/X, 4 L1/LB, 5 R1/RB, 12–15 D-pad ↑ ↓ ← →
const NAV: Record<number, string> = {
  0: "select",
  1: "back",
  2: "info",
  4: "prev_category",
  5: "next_category",
  12: "up",
  13: "down",
  14: "left",
  15: "right",
};
// Held D-pad keeps moving, like a held arrow key.
const REPEAT_AFTER = 380;
const REPEAT_EVERY = 110;
const DEADZONE = 0.15;

const navListeners = new Set<Listener<string>>();
const scrollListeners = new Set<Listener<number>>();
const connectListeners = new Set<Listener<string | null>>();
const held = new Map<number, { since: number; last: number }>();
let timer = 0;

function poll() {
  const pads = [...(navigator.getGamepads?.() ?? [])].filter((p): p is Gamepad => !!p && p.mapping === "standard");
  const now = performance.now();
  for (const [index, action] of Object.entries(NAV)) {
    const i = Number(index);
    const down = pads.some((p) => p.buttons[i]?.pressed);
    const state = held.get(i);
    if (down && !state) {
      held.set(i, { since: now, last: now });
      navListeners.forEach((l) => l(action));
    } else if (down && state && i >= 12 && now - state.since > REPEAT_AFTER && now - state.last > REPEAT_EVERY) {
      state.last = now;
      navListeners.forEach((l) => l(action));
    } else if (!down && state) {
      held.delete(i);
    }
  }
  // right stick, up positive (as the app sends it)
  const y = pads.map((p) => -(p.axes[3] ?? 0)).find((v) => Math.abs(v) > DEADZONE);
  if (y !== undefined) scrollListeners.forEach((l) => l(y));
}

function start() {
  if (!timer && typeof navigator !== "undefined" && "getGamepads" in navigator) timer = window.setInterval(poll, 30);
}

if (typeof window !== "undefined") {
  window.addEventListener("gamepadconnected", (e) => connectListeners.forEach((l) => l((e as GamepadEvent).gamepad.id)));
  window.addEventListener("gamepaddisconnected", () => {
    const left = [...navigator.getGamepads()].some(Boolean);
    if (!left) connectListeners.forEach((l) => l(null));
  });
}

const subscribe = <T,>(set: Set<Listener<T>>, cb: Listener<T>) => {
  set.add(cb);
  start();
  return () => void set.delete(cb);
};

export const browserPad = {
  onNav: (cb: Listener<string>) => subscribe(navListeners, cb),
  onScroll: (cb: Listener<number>) => subscribe(scrollListeners, cb),
  /** The controller's name when one is connected, null when the last one left. */
  onConnect: (cb: Listener<string | null>) => subscribe(connectListeners, cb),
  /** For tests: one polling step. */
  poll,
};
