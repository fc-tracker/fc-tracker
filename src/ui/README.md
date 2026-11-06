# src/ui – brand v2 shared parts

The React parts of the brand v2 system (approved mockups: `design/d-draft-2/`, rules: skill `fct-brand`,
PRINCIPLES.md §1–16a). Every surface – overlay, side panel, toasts, launcher, /web, dashboard – builds from these
instead of drawing its own. Import from `./ui` (or `../ui`); the import also loads `ui.css`.

- **Tokens:** `src/brand.css` (light | dark | glass, grades, ranks, coin/token colours). `src/themes.css` imports it
  and still carries the v1 names (`--muted`, `--accent-2`, `--surface-hi` …) for surfaces that haven't moved – new UI
  uses the v2 tokens only. Theme switch: `useTheme()` in `src/theme.ts` (default glass; v1 prefs migrate:
  midnight/pitch → dark, gold → light).
- **Frames:** `src/frame.css` – the cut corner (`.cut` or any part below), `.ring` (1 px border that follows the cut,
  same width on all 8 sides), the game cursor `.is-focus` (red cut corners + brackets, 2 px lift), list rows
  (`.lrow`: the left bar + a plate 4 px inside = "this row"; hover = plate only; never brackets on a row).
- **Parts CSS:** `ui.css` – ported 1:1 from `design/d-draft-2/components.css` (keep the two in step).
- **Fonts:** Saira variable (display at `font-stretch: 87.5%`, numbers 75 %) + Barlow 400–700, bundled via
  `brand.css` (no Google Fonts). Families: `var(--f-display)`, `var(--f-num)`, `var(--f-body)`.

| Part | Use it for |
|---|---|
| `Num` | every number (Saira 75 %, tabular). `size` m/l/xl/hero for hero numbers, `unit` = a quiet unit beside it |
| `Score` | a W–L or match score (12–3 with a thin rule) |
| `Gem` | the mint diamond before every Gallery score |
| `Coin` | the FUT coin glyph beside every coin value |
| `Token` | Champions tokens only |
| `GToken` | Gallery tokens (another currency) |
| `Dot` | a status diamond (done / accent / warn; `live` blinks) |
| `Mark` | the FC-Tracker mark (red cut square) |
| `Keycap` | a key hint that follows the input in use – PlayStation, Xbox or keyboard, the last one used wins (never two side by side): `<Keycap ps="✕" xb="A" kb="Enter" label=… />`; no key for the current input = label only |
| `Chip` | 24 px status chip; `tone` = accent (red, rare) · accent-soft · done · warn · ink · line · beta |
| `Tag` | 18 px tag on cards/rows: EVO, XI, FO, ++ |
| `Btn` | buttons. `kind="primary"` = the ONE red action per view; secondary (ringed), quiet, ink. `size` s/l/xl |
| `Grade` | a Gallery grade D–S as the game draws it (game colours); `null` = not complete yet ("–" + tooltip) |
| `ToGrade` | "[C] → [B]" or "→ [B]" (target grade) |
| `Rank`, `RankRow` | a Champions rank shield (0 = Contender V … 14 = Elite I; `got`, `next`); the game's row of 15 |
| `Tabs` | the top L1/R1 FUT slab (active = filled cut block + 3 px red bottom edge) |
| `Segs` | session tabs L2/R2 ("1. Rivals \| 22") |
| `Panel` | a surface: cut l (default) / xl (hero) / m (inner block); `tier` hero (lit) / dense (tables); `signed` = red folded corner; `scroll` = fixed height, the content scrolls in an inner `.frame-scroll` while the frame stays |
| `FocusCursor` | the game cursor's brackets drawn over an element that keeps its own background (prefer the `.is-focus` class) |
| `Bar`, `Ticks` | progress bar (cut, flat; done/ink tones, loading slide); segment strips (matches, steps) |
| `Chem` | chemistry diamonds 0–3 |
| `Switch`, `Range` | toggle (knob 2 px inside its frame), slider (4 px track, red fill, cut thumb) |
| `FutCard` | an EA card, FUT-exact: `size` full (complete: ++, alt positions, stats, flag row, foot · SM · WF · meta) · small (≥ 96 px, with name) · mini (< 96 px, no name). `holo`, `firstOwner` (proven only), `toGet` (dashed "To get"), unknown rarity → plain outline. A full card without face stats shows as small. `focus` = brackets on the card's box |
| `FaceChip` | under 64 px: portrait on the card's own rarity colour + "82 ST" |

Card art (`eaArt.ts`): EA's Web App CDN – rarity backgrounds by `rareflag` (EA's rarity table), portraits by
definition id, action shots by the item's art guid, flags/leagues/clubs, EA's holo foil and sticker. Never CSS tints,
never invented rarity colours.

**Frames never let content escape (§16, user 2026-11-05).** A framed element (`.ring`, `Panel`) either grows with its
content, or keeps its height and scrolls the content in an inner `.frame-scroll` (`<Panel scroll>`, frame.css). Never
`overflow: auto` on the element that carries the frame – its `::after` frame would scroll through the rows – and never
a fixed box with overflow visible. The outer padding keeps scrolled rows clear of the frame line.

Rules that come with the parts (fct-brand): one hero per view, no dead space > 120 px, one marking per element,
fills keep an inset, red = one primary + focus + active tab + buy + 70:00 only, mint = done/owned, amber = problems,
every string through i18n, every wait visible and named, `prefers-reduced-motion` turns motion off.
