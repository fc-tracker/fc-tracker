import type React from "react";
import type { ReactNode } from "react";
import type { PadButtonId, PadLayout } from "./padGlyphs";

/** What the recording does with a button: a tap, a double tap, a hold (ring fills) or a stick push. */
export type PressKind = "tap" | "double" | "hold" | "tilt";
export type Press = { id: PadButtonId; kind: PressKind; ms: number; n: number; dir?: 1 | -1 } | null;
// the press length, for the CSS animations of the parts
const msVar = (on: Press) => (on ? ({ ["--ms" as string]: `${on.ms}ms` } as React.CSSProperties) : undefined);

// Both controllers are our own drawings, front-on in a 300×200 box, dark and see-through like the
// controller overlay in EA's tutorial videos. Each body is one half, mirrored, so it stays symmetric.
const MIRROR = "matrix(-1 0 0 1 300 0)";

const DS_HALF =
  "M150.5 34H104C80 34 60 35 46 44 30 54 20 76 13 104 6 132 2 162 10 180c7 15 26 18 38 8 10-8 16-22 26-34 10-12 24-16 42-16h34.5";
const DS_BUMPER = "M40 52C50 32 74 24 102 25l2 12c-26 0-46 5-58 16Z";
const XB_HALF =
  "M150.5 40C134 40 122 33 100 32 76 31 52 34 38 50 24 66 16 96 12 126c-4 30-2 56 14 64 14 7 28-2 38-16 10-14 22-24 42-26 18-1 32 2 44.5 2";
const XB_BUMPER = "M36 56C46 38 68 28 98 28l3 11c-28 0-48 8-58 22Z";

/** One button: lights up while pressed; a tap sends a ripple, a hold fills a ring around it. */
function Key({ id, press, cx, cy, r, children }: { id: PadButtonId; press: Press; cx: number; cy: number; r: number; children: ReactNode }) {
  const on = press?.id === id ? press : null;
  const ring = r + 5;
  const len = 2 * Math.PI * ring;
  return (
    <g className={`pa-key ${on ? `on ${on.kind}` : ""}`} key={on ? on.n : 0} style={msVar(on)}>
      {children}
      {on && (on.kind === "tap" || on.kind === "double") && (
        <>
          <circle className="pa-ripple" cx={cx} cy={cy} r={r + 1} />
          {on.kind === "double" && <circle className="pa-ripple second" cx={cx} cy={cy} r={r + 1} />}
        </>
      )}
      {on?.kind === "hold" && (
        <circle
          className="pa-ring"
          cx={cx}
          cy={cy}
          r={ring}
          strokeDasharray={len}
          strokeDashoffset={len}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      )}
    </g>
  );
}

function Stick({ id, press, cx, cy }: { id?: PadButtonId; press: Press; cx: number; cy: number }) {
  const on = id && press?.id === id ? press : null;
  return (
    <g className={`pa-stick ${on ? `on ${on.dir === -1 ? "up" : "down"}` : ""}`} key={on ? on.n : 0} style={msVar(on)}>
      <circle className="pa-well" cx={cx} cy={cy} r={19} />
      <g className="pa-cap">
        <circle cx={cx} cy={cy} r={14.5} />
        <circle className="pa-cap-rim" cx={cx} cy={cy} r={10} />
      </g>
      {on && <path className="pa-arrow" d={on.dir === -1 ? `M${cx - 6} ${cy - 25}l6-6 6 6` : `M${cx - 6} ${cy + 25}l6 6 6-6`} />}
    </g>
  );
}

function DualSense({ press }: { press: Press }) {
  // D-pad arms point towards the middle (64,88)
  const arm = (id: "up" | "down" | "left" | "right", d: string, cx: number, cy: number) => (
    <Key id={id} press={press} cx={cx} cy={cy} r={7}>
      <path className="pa-btn" d={d} />
    </Key>
  );
  const face = (id: PadButtonId, cx: number, cy: number, symbol: ReactNode, tone: string) => (
    <Key id={id} press={press} cx={cx} cy={cy} r={9.5}>
      <circle className="pa-btn" cx={cx} cy={cy} r={9.5} />
      <g className="pa-sym" style={{ color: tone }}>
        {symbol}
      </g>
    </Key>
  );
  return (
    <svg className="pa dualsense" viewBox="0 0 300 200" aria-hidden="true">
      <Key id="l1" press={press} cx={70} cy={30} r={8}>
        <path className="pa-btn pa-bumper" d={DS_BUMPER} />
      </Key>
      <Key id="r1" press={press} cx={230} cy={30} r={8}>
        <path className="pa-btn pa-bumper" d={DS_BUMPER} transform={MIRROR} />
      </Key>
      <g className="pa-body">
        <path d={DS_HALF} />
        <path d={DS_HALF} transform={MIRROR} />
      </g>
      {/* the black centre and the touchpad with its light bars */}
      <path className="pa-inset" d="M112 90c-6 18-4 34 6 46h64c10-12 12-28 6-46Z" />
      <path className="pa-pad" d="M106 36h88l-6 52q-38 6-76 0Z" />
      <path className="pa-light" d="M103 40l7 46M197 40l-7 46" />
      <Key id="view" press={press} cx={92} cy={50} r={6}>
        <rect className="pa-btn" x={89} y={43} width={6} height={14} rx={3} transform="rotate(-14 92 50)" />
      </Key>
      <rect className="pa-btn idle" x={205} y={43} width={6} height={14} rx={3} transform="rotate(14 208 50)" />
      {arm("up", "M58 70h12v10l-6 7-6-7Z", 64, 76)}
      {arm("down", "M58 106h12V96l-6-7-6 7Z", 64, 100)}
      {arm("left", "M46 82v12h10l7-6-7-6Z", 52, 88)}
      {arm("right", "M82 82v12H72l-7-6 7-6Z", 76, 88)}
      {face("north", 236, 70, <path d="M236 65.5l4.6 7.6h-9.2Z" />, "#5fd6b8")}
      {face("west", 218, 88, <rect x={214} y={84} width={8} height={8} />, "#e79bd9")}
      {face("east", 254, 88, <circle cx={254} cy={88} r={4.4} />, "#ff7f7f")}
      {face("south", 236, 106, <path d="M232.5 102.5l7 7m0-7-7 7" />, "#8fb4ff")}
      <Stick press={press} cx={110} cy={124} />
      <Stick id="rstick" press={press} cx={190} cy={124} />
      <circle className="pa-btn idle" cx={150} cy={121} r={5.5} />
      <rect className="pa-btn idle" x={145} y={131} width={10} height={3} rx={1.5} />
    </svg>
  );
}

function XboxPad({ press }: { press: Press }) {
  const face = (id: PadButtonId, cx: number, cy: number, letter: string, tone: string) => (
    <Key id={id} press={press} cx={cx} cy={cy} r={8.5}>
      <circle className="pa-btn" cx={cx} cy={cy} r={8.5} />
      <text className="pa-letter" x={cx} y={cy + 3.6} style={{ fill: tone }}>
        {letter}
      </text>
    </Key>
  );
  const arm = (id: "up" | "down" | "left" | "right", x: number, y: number, w: number, h: number, cx: number, cy: number) => (
    <Key id={id} press={press} cx={cx} cy={cy} r={6}>
      <rect className="pa-btn" x={x} y={y} width={w} height={h} rx={1.5} />
    </Key>
  );
  return (
    <svg className="pa xbox" viewBox="0 0 300 200" aria-hidden="true">
      <Key id="l1" press={press} cx={66} cy={34} r={8}>
        <path className="pa-btn pa-bumper" d={XB_BUMPER} />
      </Key>
      <Key id="r1" press={press} cx={234} cy={34} r={8}>
        <path className="pa-btn pa-bumper" d={XB_BUMPER} transform={MIRROR} />
      </Key>
      <g className="pa-body">
        <path d={XB_HALF} />
        <path d={XB_HALF} transform={MIRROR} />
      </g>
      {/* the guide button: a lit ring */}
      <circle className="pa-guide" cx={150} cy={56} r={11} />
      <circle className="pa-guide-x" cx={150} cy={56} r={6} />
      <Key id="view" press={press} cx={127} cy={84} r={6.5}>
        <circle className="pa-btn" cx={127} cy={84} r={6.5} />
        <path className="pa-mini" d="M123.6 81.2h4.2v3.2M126.2 83.6h4.2v3.2h-4.2Z" />
      </Key>
      <circle className="pa-btn idle" cx={173} cy={84} r={6.5} />
      <path className="pa-mini" d="M170 81.8h6M170 84h6M170 86.2h6" />
      <rect className="pa-btn idle" x={145.5} y={95} width={9} height={6} rx={2} />
      <Stick press={press} cx={84} cy={82} />
      <rect className="pa-well" x={99} y={113} width={30} height={30} rx={7} />
      {arm("up", 109.5, 114, 9, 10.5, 114, 119)}
      {arm("down", 109.5, 131.5, 9, 10.5, 114, 137)}
      {arm("left", 99.5, 123.5, 10.5, 9, 105, 128)}
      {arm("right", 118, 123.5, 10.5, 9, 123, 128)}
      <rect className="pa-btn idle" x={109.5} y={123.5} width={9} height={9} />
      <Stick id="rstick" press={press} cx={186} cy={128} />
      {face("north", 220, 65, "Y", "#f2c94c")}
      {face("west", 203, 82, "X", "#5aa9ff")}
      {face("east", 237, 82, "B", "#ff6262")}
      {face("south", 220, 99, "A", "#62d66f")}
    </svg>
  );
}

/** The user's controller (PlayStation / Xbox), with the pressed button animated. */
export function PadArt({ layout, press }: { layout: PadLayout; press: Press }) {
  return layout === "xbox" ? <XboxPad press={press} /> : <DualSense press={press} />;
}
