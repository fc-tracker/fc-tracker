/* FC-Tracker brand v2 – shared React parts (README.md says what each is for). Ported from design/d-draft-2
   (components.css + kit.js); styles in ./ui.css (parts) and ../frame.css (cut, ring, focus, markings).
   Tokens only, every string through i18n. */
import type { CSSProperties, ReactNode } from "react";
import { getLocale, t } from "../i18n";
import { actionShotUrl, cardArt, clubUrl, flagUrl, foilUrl, leagueUrl, portraitUrl, stickerUrl } from "./eaArt";
import { useInputMode } from "../padGlyphs";
import "./ui.css";

export { cardArt, cardLevel, portraitUrl } from "./eaArt";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
/** a number in the user's language (thousands separators) */
export const fmt = (n: number) => n.toLocaleString(getLocale());

/* ───────────────────────────── numbers ───────────────────────────── */

/** Every number: Saira 75 %, tabular + lining. size: "" (inline) | "m" 40 | "l" 64 | "xl" 120 | "hero" 180. */
export function Num({ value, size, unit, className, style }: { value: number | string; size?: "m" | "l" | "xl" | "hero"; unit?: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <span className={cx(size ? `num-${size}` : "num", className)} style={style}>
      {typeof value === "number" ? fmt(value) : value}
      {unit != null && <span className="unit-q">{unit}</span>}
    </span>
  );
}

/** A score like a scoreboard: 12–3 with a thin rule, never a block dash. roll = the 260 ms digit roll. */
export function Score({ a, b, className, style }: { a: number | string; b: number | string; className?: string; style?: CSSProperties }) {
  return (
    <span className={cx("score", className)} style={style}>
      <span>{a}</span>
      <i aria-hidden="true">–</i>
      <span>{b}</span>
    </span>
  );
}

/* ───────────────────────────── glyphs ───────────────────────────── */

/** the mint gem before every Gallery score */
export const Gem = ({ className }: { className?: string }) => <i className={cx("gem", className)} aria-hidden="true" />;
/** the FUT coin glyph – next to every coin value (our own drawing, never EA's art) */
export const Coin = ({ large, className }: { large?: boolean; className?: string }) => <i className={cx("coin", large && "l", className)} aria-hidden="true" />;
/** the Champions token – Champions rewards only */
export const Token = ({ large }: { large?: boolean }) => (
  <i className={cx("ctok", large && "l")} aria-hidden="true">
    <svg viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="7.4" style={{ fill: "var(--token)", stroke: "var(--token-edge)" }} strokeWidth="1" />
      <circle cx="8" cy="8" r="5.7" fill="none" style={{ stroke: "var(--token-gold)" }} strokeWidth=".7" />
      <path d="M10.5 5.3 H7 L5.6 6.7 V9.3 L7 10.7 H10.5" fill="none" style={{ stroke: "var(--token-gold)" }} strokeWidth="1.9" strokeLinejoin="miter" />
    </svg>
  </i>
);
/** the Gallery token – every Gallery-token value (another currency than Champions tokens) */
export const GToken = ({ large }: { large?: boolean }) => (
  <i className={cx("ctok gtok", large && "l")} aria-hidden="true">
    <svg viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="7.3" style={{ fill: "var(--gtoken-face)", stroke: "var(--gtoken-ring)" }} strokeWidth="1.4" />
      <path d="M8 3.6 L12.4 8 L8 12.4 L3.6 8 Z" style={{ fill: "var(--gtoken-gem)" }} />
      <path d="M8 3.6 L12.4 8 L8 12.4 Z" style={{ fill: "var(--gtoken-gem-shade)" }} />
    </svg>
  </i>
);
/** a status diamond: done (mint) · accent (red) · warn (amber) · plain (text-3); live = blinks */
export const Dot = ({ tone, live }: { tone?: "done" | "accent" | "warn"; live?: boolean }) => <i className={cx("dot", tone, live && "live")} aria-hidden="true" />;
/** the FC-Tracker mark (red cut square with the F) */
export const Mark = ({ size = 28 }: { size?: number }) => (
  <span className="mark" style={{ "--m": `${size}px` } as CSSProperties} aria-hidden="true">
    <svg viewBox="0 0 28 28">
      <path d="M9 7h11v3.4h-7.2v3.2h6.2V17h-6.2v4H9z" fill="currentColor" />
    </svg>
  </span>
);

/* ───────────────────────────── controller keys ───────────────────────────── */

const PAD_GLYPH: Record<string, ReactNode> = {
  "✕": <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="square" />,
  "○": <circle cx="8" cy="8" r="4.6" stroke="currentColor" strokeWidth="1.6" fill="none" />,
  "□": <rect x="3.8" y="3.8" width="8.4" height="8.4" stroke="currentColor" strokeWidth="1.6" fill="none" />,
  "△": <path d="M8 3.4l5 8.6H3z" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinejoin="miter" />,
};
/** A key hint that follows the input in use (v1 rule, BRAND-MIGRATION relayed rule 7): the PlayStation button, the Xbox
 *  button or the keyboard key – the last input used wins (useInputMode), never two side by side.
 *  <Keycap ps="✕" xb="A" kb="Enter" label={t(...)} />. No key for the current input → only the label (or nothing). */
export function Keycap({ ps, xb, kb, label, big, className }: { ps?: string; xb?: string; kb?: string; label?: ReactNode; big?: boolean; className?: string }) {
  const mode = useInputMode();
  const k = mode === "keyboard" ? kb : mode === "xbox" ? (xb ?? ps) : (ps ?? xb);
  if (k == null && label == null) return null;
  return (
    <span className={cx("key", big && "big", className)}>
      {k == null ? null : mode === "playstation" && PAD_GLYPH[k] ? (
        <b className="g">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {PAD_GLYPH[k]}
          </svg>
        </b>
      ) : (
        <b>{k}</b>
      )}
      {label != null && <span>{label}</span>}
    </span>
  );
}

/* ───────────────────────────── chips, tags, buttons ───────────────────────────── */

type Tone = "accent" | "accent-soft" | "done" | "warn" | "ink" | "line" | "beta";
/** 24 px uppercase chip (status, counts). tone decides the colour job; plain = neutral fill. */
export const Chip = ({ tone, children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) => (
  <span className={cx("chip", tone, className)} title={title}>
    {children}
  </span>
);
/** 18 px tag (EVO, XI, FO, ++ …) */
export const Tag = ({ tone, children, title }: { tone?: "accent" | "done" | "ink" | "warn"; children: ReactNode; title?: string }) => (
  <span className={cx("tag", tone)} title={title}>
    {children}
  </span>
);
/** Buttons: primary (the ONE red action per view) · secondary (ringed) · quiet · ink. size s 32 / m 44 / l 56. */
export function Btn({ kind = "secondary", size, children, onClick, disabled, title, className, type = "button" }: {
  kind?: "primary" | "secondary" | "quiet" | "ink"; size?: "s" | "l" | "xl"; children: ReactNode; onClick?: () => void; disabled?: boolean; title?: string; className?: string; type?: "button" | "submit";
}) {
  return (
    <button type={type} className={cx("btn", disabled ? "btn-disabled" : `btn-${kind}`, kind === "secondary" && !disabled && "ring", size && `btn-${size}`, className)} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

/* ───────────────────────────── grades and ranks ───────────────────────────── */

export type GradeLetter = "D" | "C" | "B" | "A" | "S";
/** A Gallery grade as FC 27 draws it (game colours, bevelled letter, S has a second diamond). null = not complete yet. */
export function Grade({ g, size, className }: { g: string | null | undefined; size?: "xs" | "s" | "l" | "xl"; className?: string }) {
  const letter = g && "DCBAS".includes(g) ? g : null;
  return (
    <span className={cx("grade", letter ? `g-${letter}` : "none", size, className)} title={letter ? undefined : t("ui.gradeNone")}>
      {letter && <b>{letter}</b>}
    </span>
  );
}
/** "[C] → [B]" (current → target) or "→ [B]" when the current grade is shown beside it */
export const ToGrade = ({ to, from }: { to: string | null; from?: string | null }) => (
  <span className="to-g">
    {from !== undefined && <Grade g={from} size="xs" />}
    <i>→</i>
    <Grade g={to} size="xs" />
  </span>
);

let rankSeq = 0;
/** A Champions rank shield (FC 27's own): i = 0 Contender V … 14 Elite I. got = reached · next = being played for (green ▼). */
export function Rank({ i, got, next, size, name }: { i: number; got?: boolean; next?: boolean; size?: "s" | "m" | "l" | "xl"; name?: string }) {
  const tier = ["c", "p", "e"][Math.floor(i / 5)] ?? "c";
  const n = ["V", "IV", "III", "II", "I"][i % 5];
  const g = tier === "e" && got ? ++rankSeq : 0;
  const fl = (side: string) => (g ? { fill: `url(#rk${side}${g})` } : undefined);
  return (
    <span className={cx("rk", `t-${tier}`, got && "got", next && "next", size)} title={name ? (got ? t("ui.rankReached", { rank: name }) : name) : undefined} aria-label={name}>
      <svg viewBox="-4 0 48 50" aria-hidden="true">
        {g > 0 && (
          <defs>
            <linearGradient id={`rkl${g}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset=".15" style={{ stopColor: "var(--rank-e-top)" }} />
              <stop offset=".8" style={{ stopColor: "var(--rank-e-bottom)" }} />
            </linearGradient>
            <linearGradient id={`rkr${g}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset=".15" style={{ stopColor: "var(--rank-e-shade-top)" }} />
              <stop offset=".8" style={{ stopColor: "var(--rank-e-shade-bottom)" }} />
            </linearGradient>
          </defs>
        )}
        {tier !== "c" && <path className="wg" d="M4 11 L-2 19 L4 18 L-2 28 L4 27 Z M36 11 L42 19 L36 18 L42 28 L36 27 Z" />}
        {tier === "e" && <path className="lr" d="M7 40 L12 41 M9 44 L15 44 M33 40 L28 41 M31 44 L25 44 M20 46 L20 49" />}
        <path className="sh" style={fl("l")} d="M20 2 L36 8 L36 28 L20 44 L4 28 L4 8 Z" />
        <path className="hf" style={fl("r")} d="M20 2 L36 8 L36 28 L20 44 Z" />
        <path className="in" d="M20 6 L32.5 10.7 L32.5 26.6 L20 39 L7.5 26.6 L7.5 10.7 Z" />
      </svg>
      <b>{n}</b>
    </span>
  );
}
/** The game's row of 15 rank shields: reached up to `wins`, the next one marked. names[i] = the rank's name. */
export function RankRow({ wins, names }: { wins: number; names?: string[] }) {
  return (
    <div className="rk-row">
      {Array.from({ length: 15 }, (_, i) => (
        <Rank key={i} i={i} got={i < wins} next={i === wins} name={names?.[i]} />
      ))}
    </div>
  );
}

/* ───────────────────────────── tabs ───────────────────────────── */

export type TabItem = { id: string; label: ReactNode; count?: ReactNode };
/** The top FUT slab (L1/R1): the active tab is a filled cut block with a 3 px red bottom edge. */
export function Tabs({ items, active, onChange, keys = true }: { items: TabItem[]; active: string; onChange: (id: string) => void; keys?: boolean }) {
  return (
    <nav className="tabbar">
      {keys && <Keycap ps="L1" xb="LB" kb="⇧Tab" big />}
      <div className="tabs" role="tablist" ref={stripRef}>
        {items.map((it) => (
          <button key={it.id} type="button" role="tab" data-id={it.id} aria-selected={it.id === active} className={cx("tab", it.id === active && "is-on")} onClick={() => onChange(it.id)} ref={it.id === active ? (el) => void el?.scrollIntoView({ inline: "nearest", block: "nearest" }) : undefined}>
            {it.label}
            {it.count != null && <span className="n">{it.count}</span>}
          </button>
        ))}
      </div>
      {keys && <Keycap ps="R1" xb="RB" kb="Tab" big />}
    </nav>
  );
}
/** A tab strip wider than its row (sets, leagues): a fade on the side with more tabs, and the
 *  mouse wheel scrolls it sideways – "Leagues" was out of sight with nothing saying so. */
export function stripRef(el: HTMLElement | null) {
  if (!el || el.dataset.strip) return;
  el.dataset.strip = "1";
  const update = () => {
    el.dataset.moreLeft = String(el.scrollLeft > 2);
    el.dataset.moreRight = String(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  };
  el.addEventListener("scroll", update, { passive: true });
  el.addEventListener(
    "wheel",
    (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    },
    { passive: false },
  );
  new ResizeObserver(update).observe(el);
  update();
}

/** Session tabs (L2/R2): "1. Rivals | 22" – one 34 px cut shape, the count after a hairline. */
export function Segs({ items, active, onChange, keys = true }: { items: TabItem[]; active: string; onChange: (id: string) => void; keys?: boolean }) {
  return (
    <div className="cat-row">
      {keys && <Keycap ps="L2" xb="LT" kb="Q" />}
      <div className="cat-tabs segs-bar" ref={stripRef}>
        {items.map((it) => (
          <button key={it.id} type="button" aria-pressed={it.id === active} className={cx("seg ring", it.id === active && "is-on")} onClick={(e) => (onChange(it.id), e.currentTarget.scrollIntoView({ inline: "nearest", block: "nearest" }))}>
            <span>{it.label}</span>
            {it.count != null && <b>{it.count}</b>}
          </button>
        ))}
      </div>
      {keys && <Keycap ps="R2" xb="RT" kb="E" />}
    </div>
  );
}

/* ───────────────────────────── surfaces ───────────────────────────── */

/** A panel: cut l (20) by default, xl (32) for hero panels, m (8) for inner blocks. tier: standard · hero (lit) · dense (tables).
 *  signed = the hero panel's red folded corner. ring = the 1 px theme frame that follows the cut.
 *  Content never escapes the frame (§16): the panel grows with its content, or – scroll – it keeps its height and the
 *  content scrolls in an inner .frame-scroll while the frame stays put (never overflow: auto on the framed element). */
export function Panel({ children, cut, tier, signed, ring = true, scroll, className, style, as: As = "section", ...rest }: {
  children?: ReactNode; cut?: "m" | "l" | "xl"; tier?: "hero" | "dense"; signed?: boolean; ring?: boolean; scroll?: boolean; className?: string; style?: CSSProperties; as?: "section" | "div" | "aside" | "header";
} & Record<`data-${string}`, string | undefined>) {
  return (
    <As className={cx("panel", cut === "xl" && "xl", cut === "m" && "m", tier && `tier-${tier}`, signed && "signed", ring && "ring", className)} style={style} {...rest}>
      {scroll ? <div className="frame-scroll">{children}</div> : children}
    </As>
  );
}

/** The game cursor for elements that can't carry the CSS focus (their own background art): four red brackets on the
 *  element's own corners, drawn over it. shape "cut" follows a cut element, "sq" a square one. Prefer `.is-focus`. */
export const FocusCursor = ({ shape = "sq" }: { shape?: "cut" | "sq" }) => <i className={cx("focus-cursor", shape)} aria-hidden="true" />;

/** Progress: a flat bar on its cut; tone done = mint, ink = neutral; loading = one sliding bar */
export const Bar = ({ value, tone, size, loading }: { value: number; tone?: "done" | "ink"; size?: "thick" | "thin"; loading?: boolean }) => (
  <span className={cx("bar", tone, size, loading && "loading")} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
    <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
  </span>
);
/** Segments (matches, steps): w won/done · l lost · a accent · empty */
export const Ticks = ({ items }: { items: ("w" | "l" | "a" | "")[] }) => (
  <span className="ticks">
    {items.map((k, i) => (
      <i key={i} className={k} />
    ))}
  </span>
);
/** Chemistry diamonds 0–3 */
export const Chem = ({ n }: { n: number }) => (
  <span className="chem" aria-label={t("ui.chemistry", { count: n })}>
    {[0, 1, 2].map((i) => (
      <i key={i} className={i < n ? "on" : ""} />
    ))}
  </span>
);
/** Toggle: 1 px frame, the knob 2 px inside (the knob is the only fill) */
export const Switch = ({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) => (
  <button type="button" role="switch" aria-checked={on} aria-label={label} className={cx("switch", on && "on")} onClick={() => onChange(!on)} />
);
/** Range: a flat 4 px track, a red fill, a 14×20 cut-corner thumb */
export function Range({ value, min, max, step, onChange, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string }) {
  const p = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return <input type="range" aria-label={label} min={min} max={max} step={step} value={value} style={{ "--p": `${p}%` } as CSSProperties} onChange={(e) => onChange(Number(e.target.value))} />;
}

/* ───────────────────────────── cards ───────────────────────────── */

/** What a card needs. Everything but name/rating/position is optional – what is unknown is left out, never guessed. */
export type FutCardData = {
  name: string | null;
  rating: number | null;
  position: string | null;
  /** EA rarity id – picks EA's background and text colours (unknown → the plain outline) */
  rareflag?: number | null;
  /** EA definition id (portrait = def % 2^24) – or asset */
  defId?: number | null;
  /** a special's action shot guid (the item's own art) */
  actionGuid?: string | null;
  holo?: boolean;
  /** proven first owner only (a picture: set page triangle, pack/reward on New Items, EA owners == 1) */
  firstOwner?: boolean;
  positions?: string[];
  /** positions with a ++ role (EA's role table) */
  pp?: string[];
  foot?: "L" | "R" | null;
  skillMoves?: number | null;
  weakFoot?: number | null;
  /** FC-Tracker's meta rating (squads::strength) */
  meta?: number | null;
  /** PAC SHO PAS DRI DEF PHY (GK: DIV HAN KIC REF SPD POS) */
  face?: (number | null)[] | null;
  nation?: number | null;
  league?: number | null;
  club?: number | null;
};

/* EA's card abbreviations – part of the card art, like the position */
const LBL = ["PAC", "SHO", "PAS", "DRI", "DEF", "PHY"];
const GKL = ["DIV", "HAN", "KIC", "REF", "SPD", "POS"];
const PH_PATH = "M44 74 L232 52 L288 26 L344 52 L532 74 L540 132 L540 620 Q540 690 288 772 Q36 690 36 620 L36 132 Z";
const FB_PATH = "M36 190 V44 H150 M426 44 H540 V190 M36 610 V756 H150 M540 610 V756 H426";
const STAR = (
  <svg viewBox="0 0 10 10" aria-hidden="true">
    <path d="M5 .6l1.3 2.9 3.1.3-2.4 2.1.7 3.1L5 7.4 2.3 9l.7-3.1L.6 3.8l3.1-.3z" fill="currentColor" />
  </svg>
);
const FoMark = () => (
  <i className="fo" title={t("ui.firstOwner")}>
    <svg viewBox="0 0 20 19" aria-hidden="true">
      <path d="M.9 .6h18.2a.6.6 0 0 1 .52.9L10.52 18.1a.6.6 0 0 1-1.04 0L.38 1.5A.6.6 0 0 1 .9 .6z" />
      <path className="one" d="M8.4 2.6h3.1v9.6H9.4V5.3l-1.6.6V3.7z" />
    </svg>
  </i>
);
const hash = (s: string) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};

/** EA's portrait: the action shot for a special when its art guid is known, else the base portrait; hidden until loaded */
function Portrait({ c }: { c: FutCardData }) {
  if (!c.defId) return null;
  const base = portraitUrl(c.defId);
  const action = c.actionGuid ? actionShotUrl(c.actionGuid, c.defId) : null;
  return (
    <img
      className={cx("pt", action ? "action" : "base")}
      src={action ?? base}
      alt=""
      loading="lazy"
      onLoad={(e) => e.currentTarget.classList.add("ok")}
      onError={(e) => {
        const img = e.currentTarget;
        if (img.src !== base) {
          img.src = base;
          img.classList.replace("action", "base");
        } else img.style.visibility = "hidden";
      }}
    />
  );
}

function FlagRow({ c }: { c: FutCardData }) {
  if (!c.nation && !c.league && !c.club) return null;
  return (
    <span className="ft">
      {c.nation ? <img src={flagUrl(c.nation)} alt="" className="fl" /> : null}
      {c.league ? <img src={leagueUrl(c.league)} alt="" className="lg" onError={(e) => e.currentTarget.remove()} /> : null}
      {c.club ? <img src={clubUrl(c.club)} alt="" className="bd" onError={(e) => e.currentTarget.remove()} /> : null}
    </span>
  );
}

/**
 * A FUT card, EA-exact (cards-check.html spec, % of the card's height). size:
 *  - "full": rating, position, ++, alt positions, name, six face stats, flag · league · club, facts bar (foot · SM · WF · meta).
 *    Without face stats a full card falls back to "small" (PRINCIPLES 16a: full card only with real stats).
 *  - "small" (≥ 96 px): rating + position column, portrait, name, flag row. "mini" (< 96 px): the same without the name.
 *  holo = EA's foil (static, one pop + a quiet pulse). toGet = the neutral dashed "To get" silhouette (never a rarity).
 *  A rarity without known art = the plain outline. focus = the game cursor's four brackets on the card's own box.
 */
export function FutCard({ card: c, size = "full", w, pos, toGet, ghost, focus, className, title }: {
  card: FutCardData; size?: "full" | "small" | "mini"; w?: number; pos?: string; toGet?: boolean; ghost?: boolean; focus?: boolean; className?: string; title?: string;
}) {
  const position = pos ?? c.position ?? "";
  const face = c.face && c.face.length === 6 && c.face.every((v) => v != null) ? c.face : null;
  const kind = size === "full" && !face ? "small" : size;
  const width = w ?? (kind === "full" ? 200 : kind === "small" ? 110 : 84);
  const art = toGet ? null : cardArt(c.rareflag, c.rating);
  const ph = !art;
  const special = (c.rareflag ?? 0) > 1;
  const holo = !!c.holo && !ph;
  const style = { "--w": `${width}px`, ...(art ? { "--ink": art.ink, "--line": art.line, "--inv": art.alt } : {}) } as CSSProperties;
  const name = c.name ?? "";
  const pp = new Set(c.pp ?? []);
  const fo = !!c.firstOwner;
  const tip = title ?? [name, `${c.rating ?? ""} ${position}`.trim(), holo ? t("ui.holo") : "", fo ? t("ui.firstOwner") : ""].filter(Boolean).join(" · ");
  const bg = ph ? (
    <>
      <svg className="bg ph-svg" viewBox="0 0 576 800" preserveAspectRatio="none" aria-hidden="true">
        <path d={PH_PATH} vectorEffect="non-scaling-stroke" />
      </svg>
      {toGet && kind !== "mini" && <span className="get">{t("ui.toGet")}</span>}
    </>
  ) : (
    <img className="bg" src={art.bg} alt="" />
  );
  const foil = holo ? <img className="foil" src={foilUrl("si")} alt="" aria-hidden="true" style={{ "--fd": `${(hash(name) % 5000) + 600}ms` } as CSSProperties} /> : null;
  const brackets = (
    <svg className="fb" viewBox="0 0 576 800" preserveAspectRatio="none" aria-hidden="true">
      <path d={FB_PATH} vectorEffect="non-scaling-stroke" />
    </svg>
  );
  const root = cx("fut", kind !== "full" && "mini", ph && "ph", toGet && "to-get", !toGet && ph && "plain", special && "spc", holo && "holo", ghost && "ghost", focus && "is-focus", className);

  if (kind !== "full") {
    // name AND flag · league · club on every card big enough to read them (user 2026-11-05: "some have names, others
    // clubs – none both"); the list-row minis (< 64 px) stay rating + position + art
    const showName = ph || kind === "small" || width >= 64;
    return (
      <div className={root} style={style} title={tip}>
        {bg}
        {foil}
        <Portrait c={c} />
        <span className="rt">{c.rating ?? ""}</span>
        <span className="ps">{position}</span>
        {showName && <span className={cx("nm", name.length > 11 && "long")}>{name}</span>}
        <FlagRow c={c} />
        {fo && !holo && <FoMark />}
        {brackets}
      </div>
    );
  }
  const lab = position === "GK" ? GKL : LBL;
  const alts = (c.positions ?? []).filter((x) => x !== position).slice(0, 3);
  const facts = [
    c.foot && (
      <span key="f" title={t(c.foot === "L" ? "ui.footLeft" : "ui.footRight")}>
        <b>{c.foot}</b>
      </span>
    ),
    c.skillMoves ? (
      <span key="sm" title={t("ui.skillMoves", { count: c.skillMoves })}>
        <b>{c.skillMoves}</b>
        {STAR}
        <small>{t("ui.sm")}</small>
      </span>
    ) : null,
    c.weakFoot ? (
      <span key="wf" title={t("ui.weakFoot", { count: c.weakFoot })}>
        <b>{c.weakFoot}</b>
        {STAR}
        <small>{t("ui.wf")}</small>
      </span>
    ) : null,
    c.meta != null && isFinite(c.meta) ? (
      <span key="m" className="mt" title={t("ui.metaRating")}>
        <i className="gem" />
        <b>{c.meta.toFixed(1)}</b>
      </span>
    ) : null,
  ].filter(Boolean);
  return (
    <div className={root} style={style} title={tip}>
      {bg}
      {foil}
      <Portrait c={c} />
      <span className="rt">{c.rating ?? ""}</span>
      <span className="ps">{position}</span>
      {pp.has(position) && (
        <span className="pp" title={t("ui.ppRole", { pos: position })}>
          ++
        </span>
      )}
      {alts.length > 0 && (
        <span className="alt">
          {alts.map((a) => (
            <i key={a}>
              {a}
              {pp.has(a) && <sup>++</sup>}
            </i>
          ))}
        </span>
      )}
      <span className={cx("nm", name.length > 11 && "long")}>{name}</span>
      {face && (
        <span className="st">
          {lab.map((l, i) => (
            <span key={l}>
              <small>{l}</small>
              <b>{face[i]}</b>
            </span>
          ))}
        </span>
      )}
      <FlagRow c={c} />
      {holo ? <img className="hs" src={stickerUrl(fo)} alt={fo ? `${t("ui.holo")} · ${t("ui.firstOwner")}` : t("ui.holo")} /> : fo ? <FoMark /> : null}
      {brackets}
      {facts.length > 0 && <span className="fx">{facts}</span>}
    </div>
  );
}

/** Under 64 px a card is unreadable: a portrait crop on the card's own rarity colour + a "82 ST" chip. */
export function FaceChip({ card: c, s = 48, pos }: { card: FutCardData; s?: number; pos?: string }) {
  const art = cardArt(c.rareflag, c.rating) ?? cardArt(c.rating != null && c.rating >= 65 ? 1 : 0, c.rating);
  return (
    <span className="face-w" style={{ "--s": `${s}px`, ...(art ? { "--fbg": `url('${art.bg}')` } : {}) } as CSSProperties} title={c.name ?? undefined}>
      <span className="face">{c.defId ? <img src={portraitUrl(c.defId)} alt="" loading="lazy" /> : null}</span>
      <b className="num">
        <span>{c.rating ?? ""}</span>
        <i>{pos ?? c.position ?? ""}</i>
      </b>
    </span>
  );
}

/** BRAND-MIGRATION rule 10 – the layout tiers by the view's own width in CSS px (container `ovframe` = .ov-frame):
 *  xl ≥ 1600 (3 columns) · l 1200–1599 (2 columns) · m 760–1199 (1 column, detail in place) · s < 760 (stacked).
 *  CSS: `@container ovframe (width >= 1600px)` … or `.ov-frame[data-tier="m"]` (src/tiers.css). */
export type Tier = "xl" | "l" | "m" | "s";
export const tierOf = (w: number): Tier => (w >= 1600 ? "xl" : w >= 1200 ? "l" : w >= 760 ? "m" : "s");
