// Nation flags: EA's nation id → the country's flag (src/nations.json from scripts/nations.mjs; the
// SVGs in src/assets/flags are flag-icons' (MIT), only the ones needed). A nation the table doesn't
// know yet is found by the name the Web App gives it (src/flagNames.json, then the country's English
// name); still unknown, a neutral mark – never a wrong flag.
import nations from "./nations.json";
import special from "./flagNames.json";

const URLS = import.meta.glob("./assets/flags/*.svg", { query: "?url", import: "default", eager: true }) as Record<string, string>;
const TABLE = nations as Record<string, { name: string; iso: string | null }>;
const SPECIAL = special as Record<string, string>;

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const url = (iso: string | null | undefined) => (iso ? URLS[`./assets/flags/${iso}.svg`] ?? null : null);

let byName: Map<string, string> | null = null;
function isoByName(name: string): string | null {
  if (SPECIAL[name]) return SPECIAL[name];
  if (!byName) {
    byName = new Map();
    try {
      const display = new Intl.DisplayNames(["en"], { type: "region" });
      for (const key of Object.keys(URLS)) {
        const iso = key.slice("./assets/flags/".length, -".svg".length);
        if (iso.length !== 2) continue;
        const n = display.of(iso.toUpperCase());
        if (n && !byName.has(norm(n))) byName.set(norm(n), iso);
      }
    } catch {}
  }
  return byName.get(norm(name)) ?? null;
}

export function nationName(id: number, name?: string | null): string {
  return TABLE[id]?.name ?? name ?? `#${id}`;
}

export function flagUrl(id: number, name?: string | null): string | null {
  return url(TABLE[id]?.iso) ?? (name ? url(isoByName(name)) : null);
}

export function Flag({ nation, name, size = 18 }: { nation: number; name?: string | null; size?: number }) {
  const src = flagUrl(nation, name);
  const label = nationName(nation, name);
  if (!src) return <span className="flag unknown" style={{ width: size, height: (size * 3) / 4 }} title={label} aria-label={label} />;
  return <img className="flag" src={src} width={size} height={(size * 3) / 4} alt={label} title={label} loading="lazy" decoding="async" />;
}
