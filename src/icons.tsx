/** FUT coin, drawn (no emoji) so it matches every theme. */
export function Coin({ size = 10 }: { size?: number }) {
  return (
    <svg className="coin" width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
      <circle cx="5" cy="5" r="4.4" />
      <circle className="coin-inner" cx="5" cy="5" r="2.6" />
    </svg>
  );
}

/** Mint "gem" used next to every Gallery score, like in FC27. */
export function Gem({ size = 12 }: { size?: number }) {
  return (
    <svg className="gem" width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 0 12 6 6 12 0 6Z" />
      <path className="gem-shine" d="M6 0 12 6 6 6Z" />
    </svg>
  );
}
