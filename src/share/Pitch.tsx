/* A squad on a pitch (share page + dashboard Creator): lines from attack to keeper, each card its own EA card, the
   slot's position under it (the card keeps its own position – brand rule). */
import { pitchRows, type SlotView } from "../squadsData";
import { FutCard, type FutCardData } from "../ui";
import type { ShareSlot } from "../account";

export function Pitch({ slots, w = 120 }: { slots: ShareSlot[]; w?: number }) {
  const rows = pitchRows(slots as unknown as SlotView[]) as unknown as ShareSlot[][];
  const card = (s: ShareSlot): FutCardData => ({ name: s.name, rating: s.rating, position: s.positions?.[0] ?? s.pos, positions: s.positions, rareflag: s.rareflag ?? null, defId: s.def_id ?? null, nation: s.nation ?? null, league: s.league ?? null, club: s.club ?? null, actionGuid: s.art ?? null });
  return (
    <div className="dvp">
      {rows.map((r, i) => (
        <div key={i} className="dvp-row">
          {r.map((s, k) => (
            <span key={k} className="dvp-slot">
              <FutCard card={card(s)} size="small" w={w} toGet={s.owned === false} />
              <small>{s.pos}</small>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
