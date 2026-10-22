// Controller buttons as they look on the user's controller: PlayStation (✕ ○ □ △, L1/R1,
// Create) or Xbox (A B X Y, LB/RB, View). The layout follows the connected controller; without
// one the user picks it (Help → Controls). PlayStation first, like the rest of the app.
import { useEffect, useState } from "react";
import { api, events, type Controller } from "./api";

export type PadLayout = "playstation" | "xbox";
export type PadChoice = PadLayout | "auto";
export type PadButtonId = "south" | "east" | "west" | "north" | "l1" | "r1" | "l2" | "r2" | "view" | "up" | "down" | "left" | "right" | "rstick";

const STORAGE_KEY = "fct.padLayout";
const CHANGE_EVENT = "fct-pad-layout";

function readChoice(): PadChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "playstation" || v === "xbox" || v === "auto") return v;
  } catch {}
  return "auto";
}

/** The layout to draw: the user's pick, else the connected controller, else PlayStation. */
export function usePadLayout(): { layout: PadLayout; choice: PadChoice; controller: Controller | null; setChoice: (c: PadChoice) => void } {
  const [choice, setChoiceState] = useState<PadChoice>(readChoice);
  const [controller, setController] = useState<Controller | null>(null);
  useEffect(() => {
    api.controller().then(setController).catch(() => {});
    const un = events.onController(setController);
    const sync = () => setChoiceState(readChoice());
    window.addEventListener(CHANGE_EVENT, sync);
    return () => {
      un.then((u) => u());
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);
  const setChoice = (c: PadChoice) => {
    try {
      localStorage.setItem(STORAGE_KEY, c);
    } catch {}
    setChoiceState(c);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };
  const layout: PadLayout = choice !== "auto" ? choice : controller?.kind === "xbox" ? "xbox" : "playstation";
  return { layout, choice, controller, setChoice };
}

export type InputMode = "keyboard" | PadLayout;

/**
 * What the user is steering with right now: the last input wins. A key press → keyboard, a
 * controller button → that controller's layout. Starts on the controller when one is connected.
 */
export function useInputMode(): InputMode {
  const { layout, controller } = usePadLayout();
  const [mode, setMode] = useState<"keyboard" | "pad" | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) setMode("keyboard");
    };
    window.addEventListener("keydown", onKey);
    const un = events.onPad(() => setMode("pad"));
    return () => {
      window.removeEventListener("keydown", onKey);
      un.then((u) => u());
    };
  }, []);
  const m = mode ?? (controller ? "pad" : "keyboard");
  return m === "keyboard" ? "keyboard" : layout;
}

// face buttons: PlayStation symbols in their colours, Xbox letters in theirs
const FACE: Record<PadLayout, Record<"south" | "east" | "west" | "north", { color: string; label: string }>> = {
  playstation: {
    south: { color: "#7aa8ff", label: "✕" },
    east: { color: "#ff6b7a", label: "○" },
    west: { color: "#f48fd0", label: "□" },
    north: { color: "#4fd6a8", label: "△" },
  },
  xbox: {
    south: { color: "#5fcf5f", label: "A" },
    east: { color: "#ff5a5a", label: "B" },
    west: { color: "#4ea4ff", label: "X" },
    north: { color: "#ffd23f", label: "Y" },
  },
};

/** The button's name as printed on the controller (for text and screen readers). */
export function padName(id: PadButtonId, layout: PadLayout): string {
  if (id === "south" || id === "east" || id === "west" || id === "north") return FACE[layout][id].label;
  if (id === "l1") return layout === "xbox" ? "LB" : "L1";
  if (id === "r1") return layout === "xbox" ? "RB" : "R1";
  if (id === "l2") return layout === "xbox" ? "LT" : "L2";
  if (id === "r2") return layout === "xbox" ? "RT" : "R2";
  if (id === "view") return layout === "xbox" ? "View" : "Create";
  if (id === "rstick") return layout === "xbox" ? "RS" : "R3";
  return { up: "↑", down: "↓", left: "←", right: "→" }[id];
}

function FaceSymbol({ id, layout }: { id: "south" | "east" | "west" | "north"; layout: PadLayout }) {
  const { color } = FACE[layout][id];
  if (layout === "xbox") {
    return (
      <text x="12" y="16.5" textAnchor="middle" fontSize="12" fontWeight="800" fill={color} fontFamily="var(--font-body)">
        {FACE.xbox[id].label}
      </text>
    );
  }
  const s = { fill: "none", stroke: color, strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (id === "south") return <path d="M8 8 16 16M16 8 8 16" {...s} />;
  if (id === "east") return <circle cx="12" cy="12" r="4.6" {...s} />;
  if (id === "west") return <rect x="7.6" y="7.6" width="8.8" height="8.8" {...s} />;
  return <path d="M12 7.2 16.8 15.6H7.2Z" {...s} />;
}

/** One controller button as a small glyph (inline with text). */
export function PadButton({ id, layout, size = 22 }: { id: PadButtonId; layout: PadLayout; size?: number }) {
  const name = padName(id, layout);
  if (id === "south" || id === "east" || id === "west" || id === "north") {
    return (
      <svg className="pad-glyph" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={name}>
        <circle cx="12" cy="12" r="10.5" fill="#15192b" stroke="rgba(255,255,255,0.18)" />
        <FaceSymbol id={id} layout={layout} />
      </svg>
    );
  }
  if (id === "l1" || id === "r1" || id === "l2" || id === "r2" || id === "rstick") {
    return (
      <span className="pad-pill" style={{ height: size, fontSize: size * 0.48 }} role="img" aria-label={name}>
        {name}
      </span>
    );
  }
  if (id === "view") {
    return (
      <svg className="pad-glyph" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={name}>
        <rect x="1.5" y="5.5" width="21" height="13" rx="6.5" fill="#15192b" stroke="rgba(255,255,255,0.18)" />
        {layout === "xbox" ? (
          <g fill="none" stroke="#e7ecff" strokeWidth="1.3">
            <rect x="8" y="8.5" width="6" height="5" rx="0.8" />
            <rect x="10.2" y="10.6" width="6" height="5" rx="0.8" fill="#15192b" />
          </g>
        ) : (
          <g stroke="#e7ecff" strokeWidth="1.3" strokeLinecap="round">
            <path d="M9.5 9.5v5M12 8.5v7M14.5 9.5v5" />
          </g>
        )}
      </svg>
    );
  }
  // D-pad direction
  const rot = { up: 0, right: 90, down: 180, left: 270 }[id];
  return (
    <svg className="pad-glyph" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={`D-pad ${name}`}>
      <path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7Z" fill="#15192b" stroke="rgba(255,255,255,0.18)" />
      <path d="M12 4.5 14.2 7.6H9.8Z" fill="#e7ecff" transform={`rotate(${rot} 12 12)`} />
    </svg>
  );
}

/** The whole D-pad with all four arrows (for "move" in any direction). */
export function DpadGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg className="pad-glyph" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="D-pad">
      <path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7Z" fill="#15192b" stroke="rgba(255,255,255,0.18)" />
      {[0, 90, 180, 270].map((a) => (
        <path key={a} d="M12 4.2 13.9 6.9H10.1Z" fill="#e7ecff" transform={`rotate(${a} 12 12)`} />
      ))}
    </svg>
  );
}

// Brand marks (Simple Icons, CC0) – used only to say which controller a layout is for.
export function PlayStationLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M8.984 2.596v17.547l3.915 1.261V6.688c0-.69.304-1.151.794-.991.636.18.76.814.76 1.505v5.875c2.441 1.193 4.362-.002 4.362-3.152 0-3.237-1.126-4.675-4.438-5.827-1.307-.448-3.728-1.186-5.39-1.502zm4.656 16.241l6.296-2.275c.715-.258.826-.625.246-.818-.586-.192-1.637-.139-2.357.123l-4.205 1.5V14.98l.24-.085s1.201-.42 2.913-.615c1.696-.18 3.785.03 5.437.661 1.848.601 2.04 1.472 1.576 2.072-.465.6-1.622 1.036-1.622 1.036l-8.544 3.107V18.86zM1.807 18.6c-1.9-.545-2.214-1.668-1.352-2.32.801-.586 2.16-1.052 2.16-1.052l5.615-2.013v2.313L4.205 17c-.705.271-.825.632-.239.826.586.195 1.637.15 2.343-.12L8.247 17v2.074c-.12.03-.256.044-.39.073-1.939.331-3.996.196-6.038-.479z" />
    </svg>
  );
}

export function XboxLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M4.102 21.033C6.211 22.881 8.977 24 12 24c3.026 0 5.789-1.119 7.902-2.967 1.877-1.912-4.316-8.709-7.902-11.417-3.582 2.708-9.779 9.505-7.898 11.417zm11.16-14.406c2.5 2.961 7.484 10.313 6.076 12.912C23.002 17.48 24 14.861 24 12.004c0-3.34-1.365-6.362-3.57-8.536 0 0-.027-.022-.082-.042-.063-.022-.152-.045-.281-.045-.592 0-1.985.434-4.805 3.246zM3.654 3.426c-.057.02-.082.041-.086.042C1.365 5.642 0 8.664 0 12.004c0 2.854.998 5.473 2.661 7.533-1.401-2.605 3.579-9.951 6.08-12.91-2.82-2.813-4.216-3.245-4.806-3.245-.131 0-.223.021-.281.046v-.002zM12 3.551S9.055 1.828 6.755 1.746c-.903-.033-1.454.295-1.521.339C7.379.646 9.659 0 11.984 0H12c2.334 0 4.605.646 6.766 2.085-.068-.046-.615-.372-1.52-.339C14.946 1.828 12 3.545 12 3.545v.006z" />
    </svg>
  );
}
