import "./ui/ui.css";

/** FUT coin – the brand v2 glyph (src/ui Coin: gold ring, black face), sized in px. */
export function Coin({ size = 10 }: { size?: number }) {
  return <i className="coin" style={{ width: size, height: size }} aria-hidden="true" />;
}

/** Mint gem before every Gallery score – the brand v2 gem (src/ui Gem), sized in px (its diagonal). */
export function Gem({ size = 12 }: { size?: number }) {
  return <i className="gem" style={{ width: size * 0.7, height: size * 0.7, marginRight: size * 0.3 }} aria-hidden="true" />;
}
