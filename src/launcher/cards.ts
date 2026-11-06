// The app's card data → the shared FutCard (src/ui). Only what is known goes in – nothing guessed.
import type { GalleryCardView } from "../api";
import type { ClubEntry, SlotView } from "../squadsData";
import type { FutCardData } from "../ui";

const foot = (f: number | undefined) => (f === 1 ? "R" : f === 2 ? "L" : null);
const face = (f: number[] | null | undefined) => (f && f.length === 6 ? f : null);

/** Card-art fields SlotView gets with v2-app's Phase 1 (rareflag, club, positions) and the face stats Rust already
 *  sends – read as optional until then: unknown art = FutCard's plain outline. */
type SlotArt = { rareflag?: number; club?: number; positions?: string[]; face?: number[] | null };

/** A planned XI slot (squads.rs SlotView). `pos` = the slot; the card keeps its own position. */
export const slotCard = (slot: SlotView): FutCardData => {
  const s = slot as SlotView & SlotArt;
  return {
  name: s.name,
  rating: s.rating,
  // the card keeps its own (primary) position – "87 CB" on a CDM card was the slot (user 2026-11-05, Gilberto Silva)
  position: s.positions?.[0] ?? s.pos,
  rareflag: s.rareflag ?? null,
  defId: s.def_id || null,
  nation: s.nation || null,
  league: s.league || null,
  club: s.club || null,
  foot: foot(s.foot),
  skillMoves: s.skill_moves || null,
  weakFoot: s.weak_foot || null,
  meta: s.strength || null,
  face: face(s.face),
  positions: s.positions,
  firstOwner: !!(slot as SlotView & { first_owner?: boolean }).first_owner,
  actionGuid: (slot as SlotView & { art?: string | null }).art ?? null,
  };
};

/** A club card (squads.rs ClubEntry) at its best position. */
export const clubCard = (c: ClubEntry, pos?: string): FutCardData => ({
  name: c.name,
  rating: c.rating,
  position: pos ?? c.positions[0] ?? null,
  positions: c.positions,
  rareflag: c.rareflag ?? null,
  defId: c.def_id ?? null,
  actionGuid: c.art ?? null,
  nation: c.nation || null,
  league: c.league || null,
  club: c.club || null,
  face: face(c.face),
  meta: pos && c.meta ? (c.meta[pos] ?? null) : null,
});

/** A Gallery card (owned or to get). */
export const galleryCard = (g: GalleryCardView): FutCardData => ({
  name: g.name,
  rating: g.rating,
  position: g.position,
  rareflag: g.rareflag,
  defId: g.def_id,
  holo: g.holo,
  actionGuid: g.art ?? null,
  // the flag · league · club row and the face stats, as on every other card (user 2026-11-05: Šašić had none)
  nation: g.nation ?? null,
  league: g.league ?? null,
  club: g.club ?? null,
  face: g.face?.length === 6 ? g.face : null,
  // the overlay's own rule (Overlay.tsx FO_YES): proven by a picture, EA, or the user's own mark
  firstOwner: g.first_owner === "known" || g.first_owner === "scanned" || g.first_owner === "manual",
});
