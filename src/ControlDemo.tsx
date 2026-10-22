import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GalleryCategory, ShoppingList } from "./api";
import { PadArt, type Press, type PressKind } from "./Controllers";
import { cardTier, compact } from "./format";
import { t, type MessageKey } from "./i18n";
import { Gem } from "./icons";
import { SetDetail, SetRow, type CardUi } from "./Overlay";
import { PadButton, type PadButtonId, type PadLayout } from "./padGlyphs";
import { rarity } from "./rarities";

export type ControlId = "overlay" | "missing" | "category" | "move" | "open" | "info" | "back" | "scroll";

/** Every control on the Help page: its buttons, how they are pressed, and the keyboard keys. */
export const CONTROLS: { id: ControlId; group: "show" | "overlay"; buttons: PadButtonId[]; gesture?: "hold" | "double"; keys: string[] }[] = [
  { id: "overlay", group: "show", buttons: ["view"], gesture: "hold", keys: ["Ctrl", "Shift", "F"] },
  { id: "missing", group: "show", buttons: ["view"], gesture: "double", keys: ["Ctrl", "Shift", "M"] },
  { id: "category", group: "overlay", buttons: ["l1", "r1"], keys: ["Q", "E"] },
  { id: "move", group: "overlay", buttons: ["up", "down", "left", "right"], keys: ["↑", "↓", "←", "→"] },
  { id: "open", group: "overlay", buttons: ["south"], keys: ["Enter"] },
  { id: "info", group: "overlay", buttons: ["west"], keys: ["I"] },
  { id: "back", group: "overlay", buttons: ["east"], keys: ["Esc"] },
  { id: "scroll", group: "overlay", buttons: ["rstick"], keys: [] },
];

// What the little screen shows.
type Screen = { overlay: boolean; missing: boolean; tab: number; row: number; open: boolean; card: number; info: boolean; scroll: number };
const BASE: Screen = { overlay: false, missing: false, tab: 0, row: 0, open: false, card: 0, info: false, scroll: 0 };
const START: Record<ControlId, Screen> = {
  overlay: BASE,
  missing: BASE,
  category: { ...BASE, overlay: true },
  move: { ...BASE, overlay: true },
  open: { ...BASE, overlay: true },
  info: { ...BASE, overlay: true, open: true, card: 1 },
  back: { ...BASE, overlay: true, open: true, card: 2 },
  scroll: { ...BASE, overlay: true },
};

// One step of a recording: a press, what it does on screen, what the prompt says, then a pause.
type Step = { press?: PadButtonId; kind?: PressKind; dir?: 1 | -1; act?: string; then?: (s: Screen) => Screen; wait: number };
const MS: Record<PressKind, number> = { tap: 200, double: 520, hold: 850, tilt: 1300 };
const SCRIPTS: Record<ControlId, Step[]> = {
  overlay: [
    { wait: 1100 },
    { press: "view", kind: "hold", act: "open", then: (s) => ({ ...s, overlay: true }), wait: 2300 },
    { press: "view", kind: "hold", act: "close", then: (s) => ({ ...s, overlay: false }), wait: 1500 },
  ],
  missing: [
    { wait: 1100 },
    { press: "view", kind: "double", act: "show", then: (s) => ({ ...s, missing: true }), wait: 2600 },
    { press: "view", kind: "double", act: "hide", then: (s) => ({ ...s, missing: false }), wait: 1500 },
  ],
  category: [
    { wait: 900 },
    { press: "r1", act: "next", then: (s) => ({ ...s, tab: 1 }), wait: 1300 },
    { press: "r1", act: "next", then: (s) => ({ ...s, tab: 2 }), wait: 1300 },
    { press: "l1", act: "prev", then: (s) => ({ ...s, tab: 1 }), wait: 1100 },
    { press: "l1", act: "prev", then: (s) => ({ ...s, tab: 0 }), wait: 1400 },
  ],
  move: [
    { wait: 800 },
    { press: "down", act: "down", then: (s) => ({ ...s, row: 1 }), wait: 750 },
    { press: "down", act: "down", then: (s) => ({ ...s, row: 2 }), wait: 750 },
    { press: "down", act: "down", then: (s) => ({ ...s, row: 3 }), wait: 1000 },
    { press: "up", act: "up", then: (s) => ({ ...s, row: 2 }), wait: 1500 },
  ],
  open: [
    { wait: 900 },
    { press: "south", act: "openSet", then: (s) => ({ ...s, open: true, card: 0 }), wait: 1300 },
    { press: "right", act: "right", then: (s) => ({ ...s, card: 1 }), wait: 700 },
    { press: "right", act: "right", then: (s) => ({ ...s, card: 2 }), wait: 1600 },
  ],
  info: [
    { wait: 900 },
    { press: "west", act: "info", then: (s) => ({ ...s, info: true }), wait: 2400 },
    { press: "east", act: "back", then: (s) => ({ ...s, info: false }), wait: 1300 },
  ],
  back: [
    { wait: 900 },
    { press: "east", act: "back", then: (s) => ({ ...s, open: false }), wait: 1200 },
    { press: "east", act: "close", then: (s) => ({ ...s, overlay: false }), wait: 1500 },
  ],
  scroll: [
    { wait: 900 },
    { press: "rstick", kind: "tilt", act: "scrollDown", then: (s) => ({ ...s, scroll: 1 }), wait: 1200 },
    { press: "rstick", kind: "tilt", dir: -1, act: "scrollUp", then: (s) => ({ ...s, scroll: 0 }), wait: 1300 },
  ],
};

const WORLD_W = 1200; // the stage is drawn at a real overlay size and scaled as one piece
const GESTURE: Record<PressKind, MessageKey> = { tap: "help.press", double: "help.double", hold: "help.hold", tilt: "help.tilt" };

type Data = { categories: GalleryCategory[]; buy: ShoppingList | null };
type Prompt = { act: string; button: PadButtonId; kind: PressKind; n: number } | null;

/**
 * A looping recording of one control, in the app's own look: a drawn stand-in for the game, the
 * real overlay / Buy next list on top of it (real Gallery data from the sample set), an in-game
 * style button prompt and the user's controller with the button being pressed.
 */
export default function ControlStage({ id, layout }: { id: ControlId; layout: PadLayout }) {
  const [screen, setScreen] = useState<Screen>(START[id]);
  const [press, setPress] = useState<Press>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [rewind, setRewind] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [scale, setScale] = useState(0.5);
  const stage = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);

  useEffect(() => {
    import("./devMock").then((m) => setData({ categories: m.mockGallery, buy: m.mockShopping }));
  }, []);

  // one scale for the whole drawing, from the stage's width
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / WORLD_W));
    ro.observe(el);
    world.current?.setAttribute("inert", "");
    return () => ro.disconnect();
  }, []);

  // the timeline
  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, reduced ? Math.max(ms, 500) : ms));
    let n = 0;
    const run = (i: number, s: Screen) => {
      const steps = SCRIPTS[id];
      if (i >= steps.length) {
        // fade out, reset, fade in – the loop restarts without a jump
        setRewind(true);
        setPrompt(null);
        later(() => {
          setScreen(START[id]);
          setRewind(false);
          run(0, START[id]);
        }, 380);
        return;
      }
      const step = steps[i];
      const kind = step.kind ?? "tap";
      const ms = MS[kind];
      if (step.press) {
        n += 1;
        setPress({ id: step.press, kind, ms, n, dir: step.dir });
        setPrompt({ act: step.act ?? "", button: step.press, kind, n });
      } else {
        setPrompt(null);
      }
      const next = step.then ? step.then(s) : s;
      // a hold acts when the ring is full, a double tap on the second tap, a tap at once
      later(() => setScreen(next), step.press ? (kind === "tap" ? 80 : kind === "tilt" ? 150 : ms) : 0);
      later(() => {
        setPress(null);
        later(() => run(i + 1, next), step.wait);
      }, step.press ? ms : 0);
    };
    setScreen(START[id]);
    run(0, START[id]);
    return () => timers.forEach(clearTimeout);
  }, [id]);

  const cats = data?.categories ?? [];
  const cat = cats[Math.min(screen.tab, Math.max(0, cats.length - 1))];
  const sets = cat?.sets ?? [];
  const set = sets[Math.min(screen.row, Math.max(0, sets.length - 1))];
  const focusCard = screen.open && set ? set.lineup[screen.card] : undefined;
  const focusKey = focusCard ? `l:${focusCard.def_id}:${focusCard.slot ?? ""}` : null;
  const noop = () => {};
  const ui: CardUi = {
    focused: focusKey,
    info: screen.info && focusKey ? { key: focusKey, toLeft: false } : null,
    onInfo: noop,
    onSwapDone: noop,
    menu: null,
    onOpen: noop,
    onChoose: noop,
  };

  // keep the focused card in view, like the overlay does; the right stick scrolls the detail
  useEffect(() => {
    const wrap = world.current?.querySelector<HTMLElement>(".detail-wrap");
    if (!wrap) return;
    const cell = wrap.querySelector<HTMLElement>(".card-cell.focused");
    let top = 0;
    if (cell) top = wrap.scrollTop + (cell.getBoundingClientRect().top - wrap.getBoundingClientRect().top) / scale - 60;
    else if (screen.scroll) top = 420;
    wrap.scrollTo({ top, behavior: "smooth" });
  }, [focusKey, screen.scroll, screen.row, screen.tab, data, scale]);

  const buyRows = (data?.buy?.entries ?? []).filter((e, i, all) => all.findIndex((o) => o.card.name === e.card.name) === i).slice(0, 9);

  return (
    <div className="cs" ref={stage} aria-hidden="true">
      <div className={`cs-world ${rewind ? "rewind" : ""}`} ref={world} style={{ transform: `scale(${scale})` }}>
        {/* Buy next sits beside the game (it stays playable); the overlay covers it */}
        <GameStandIn dim={screen.overlay} />

        {/* the real overlay */}
        <div className={`cs-ov ${screen.overlay ? "on" : ""}`}>
          <div className="ov">
            <div className="ov-frame">
              <header className="ov-header">
                <div className="brand">
                  <span className="brand-mark" aria-hidden="true" />
                  <span className="brand-name">FC-Tracker</span>
                </div>
              </header>
              <div className="cat-bar">
                <nav className="cat-tabs">
                  <kbd className="key-hint">Q</kbd>
                  {cats.map((c, i) => (
                    <span key={c.key} className={`cat-tab ${i === screen.tab ? "active" : ""}`}>
                      {c.key === "leagues" ? t("overlay.leagues") : c.key === "rarities" ? t("overlay.rarities") : c.name}
                    </span>
                  ))}
                  <kbd className="key-hint">E</kbd>
                </nav>
              </div>
              <div className={`ov-body zone-${screen.open ? "cards" : "list"}`}>
                <aside className="set-list" key={cat?.key}>
                  {sets.slice(0, 12).map((s, i) => (
                    <div key={s.key} className={i === screen.row && !screen.open ? "cs-focus" : ""}>
                      <SetRow set={s} index={i} active={i === screen.row} onSelect={noop} />
                    </div>
                  ))}
                </aside>
                <main className="detail-wrap">{set && <SetDetail set={set} ui={ui} />}</main>
              </div>
            </div>
          </div>
        </div>

        {/* the real Buy next list, at the edge of the screen */}
        <div className={`cs-ml ${screen.missing ? "on" : ""}`}>
          <div className="ml">
            <div className="ml-frame">
              <header className="ml-head">
                <span className="eyebrow">{t("missing.title")}</span>
                <h1 className="ml-title">{data?.buy?.name}</h1>
              </header>
              <ol className="ml-list">
                {buyRows.map((e) => (
                  <li key={e.card.def_id} className="ml-row">
                    <span className={`ml-rating tier-${cardTier(e.card)} rar-${rarity(e.card.rareflag).family}`}>{e.card.rating ?? "?"}</span>
                    <span className="ml-name">
                      {e.card.name ?? "?"}
                      <small>{e.card.position ?? ""}</small>
                    </span>
                    <span className="ml-gain">
                      <Gem size={9} />+{compact(e.gain)}
                    </span>
                    <span className="ml-price" />
                  </li>
                ))}
              </ol>
              <footer className="ml-foot" />
            </div>
          </div>
        </div>

        {/* what you do: an in-game style prompt, and the controller doing it */}
        <div className="cs-hud">
          {prompt && (
            <div className={`cs-prompt ${prompt.kind}`} key={prompt.n}>
              <span className="cs-prompt-btn">
                <PadButton id={prompt.button} layout={layout} size={58} />
                {prompt.kind === "hold" && (
                  <svg className="cs-prompt-ring" viewBox="0 0 80 80">
                    <circle className="track" cx="40" cy="40" r="36" />
                    <circle className="fill" cx="40" cy="40" r="36" pathLength={100} />
                  </svg>
                )}
              </span>
              <span className="cs-prompt-text">
                <small>{t(GESTURE[prompt.kind])}</small>
                <b>{t(`help.a.${prompt.act}` as MessageKey)}</b>
              </span>
            </div>
          )}
          <div className="cs-pad">
            <PadArt layout={layout} press={press} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** A drawn stand-in for the game's Gallery behind the overlay: shapes only, no EA content. */
function GameStandIn({ dim }: { dim: boolean }) {
  return (
    <div className={`cs-game ${dim ? "dim" : ""}`}>
      <div className="cs-g-top">
        <span className="cs-g-crest" />
        {[64, 92, 0, 70, 84, 40, 88, 72, 64].map((w, i) => (w ? <span key={i} className={`cs-g-tab ${i === 1 ? "on" : ""}`} style={{ width: w }} /> : <i key={i} />))}
      </div>
      <div className="cs-g-chips">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <span key={i} className={i === 1 || i === 5 ? "on" : ""} />
        ))}
      </div>
      <div className="cs-g-cards">
        {Array.from({ length: 16 }, (_, i) => (
          <span key={i} className={`cs-g-card ${i === 0 ? "sel" : ""} ${i > 12 ? "empty" : ""}`}>
            <em />
            <b />
          </span>
        ))}
      </div>
      <div className="cs-g-side">
        <span className="cs-g-diamond" />
        <span className="cs-g-line big" />
        <span className="cs-g-line" />
        <span className="cs-g-line" />
      </div>
    </div>
  );
}
