//! Identifies the cards of an in-game set lineup (set page = no names) against the user's
//! collected cards, and turns that into certain first-owner facts – never guesses.
//!
//! Evidence:
//! - set page: per slot the points (always readable), sometimes rating/position, and the
//!   first-owner triangle;
//! - swap pages: every *unselected* collected card of the set, by name.
//!
//! A collected card that was seen on a swap page is not in the lineup. So once all swap pages
//! of a set were scanned, the lineup is exactly "collected − seen on swap pages" and every slot
//! can be identified by elimination, even when several cards share the same points.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// One slot of the in-game lineup as read from the set page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SlotObs {
    pub points: u32,
    pub rating: Option<u32>,
    pub position: Option<String>,
    pub first_owner: bool,
    /// Colour signature of the nation flag on the card (see `scan::flag_signature`).
    #[serde(default)]
    pub flag: Option<Vec<u8>>,
    /// No triangle read, but its score was close (a light card at 1080p): counted as not first
    /// owner, yet never stored as a "not first owner" fact.
    #[serde(default)]
    pub uncertain: bool,
}

/// A collected card of the set (what we know from the Web App sync).
#[derive(Debug, Clone)]
pub struct SetCard {
    pub def_id: u64,
    pub points: u32,
    pub rating: Option<u32>,
    pub position: Option<String>,
    pub nation: Option<u64>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Identified {
    /// Slot index → card (only slots that are certain).
    pub slots: BTreeMap<usize, u64>,
    /// First-owner facts that follow with certainty (def_id → first owner?).
    pub first_owner: BTreeMap<u64, bool>,
    /// Slots we could not tie to one card (e.g. several 340-point cards, swap pages not scanned).
    pub ambiguous: usize,
    /// Slots identified without any doubt about *which* card sits there (safe to learn the
    /// nation's flag colours from).
    pub unique: BTreeSet<usize>,
}

/// Flag signatures must be this close to a learned nation (Euclidean over 18 bytes; the same
/// nation measures ~10–35, different flags 100+).
const FLAG_MATCH: f32 = 60.0;

fn flag_distance(a: &[u8], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (*x as f32 - y).powi(2)).sum::<f32>().sqrt()
}

fn flag_unique(slot: &SlotObs, cands: &[&SetCard], learned: &BTreeMap<u64, Vec<f32>>) -> Option<u64> {
    let flag = slot.flag.as_ref()?;
    let dist = |c: &SetCard| c.nation.and_then(|n| learned.get(&n)).map(|sig| flag_distance(flag, sig));
    let matching: Vec<&&SetCard> = cands.iter().filter(|c| dist(c).is_some_and(|d| d <= FLAG_MATCH)).collect();
    let [one] = matching.as_slice() else { return None };
    let d = dist(one)?;
    let others_excluded = cands
        .iter()
        .filter(|c| c.def_id != one.def_id)
        .all(|c| c.nation != one.nation && dist(c).is_some_and(|o| o > d * 2.0 && o > FLAG_MATCH));
    others_excluded.then_some(one.def_id)
}

/// Same points/rating/position but different nations (e.g. Ødegaard 🇳🇴 and Bruno Guimarães 🇧🇷,
/// both 4,100 · 86 CM): the flag on each slot, compared with flag colours learned from cards
/// identified for certain, decides which card sits where. Only clear matches count (best slot
/// at least twice as close as any other); otherwise nothing is assigned.
/// Returns the pairs it is sure of (possibly only some), plus the slots and cards left over.
#[allow(clippy::type_complexity)]
fn assign_by_flag<'a>(
    idx: &[usize],
    cands: &[&'a SetCard],
    slots: &[SlotObs],
    learned: &BTreeMap<u64, Vec<f32>>,
) -> (Vec<(usize, u64)>, Vec<usize>, Vec<&'a SetCard>) {
    let mut free_slots: Vec<usize> = idx.to_vec();
    let mut free_cards: Vec<&SetCard> = cands.to_vec();
    let mut out = Vec::new();
    while !free_cards.is_empty() {
        if free_cards.len() == 1 && free_slots.len() == 1 {
            out.push((free_slots[0], free_cards[0].def_id));
            break;
        }
        let mut best: Option<(usize, usize, f32)> = None;
        for (ci, c) in free_cards.iter().enumerate() {
            let Some(sig) = c.nation.and_then(|n| learned.get(&n)) else { continue };
            let ds: Vec<(usize, f32)> = free_slots
                .iter()
                .enumerate()
                .filter_map(|(si, &s)| Some((si, flag_distance(slots[s].flag.as_ref()?, sig))))
                .collect();
            if ds.len() != free_slots.len() {
                continue;
            }
            let Some((bsi, bd)) = ds.iter().copied().min_by(|a, b| a.1.total_cmp(&b.1)) else { continue };
            let second = ds.iter().filter(|(si, _)| *si != bsi).map(|(_, d)| *d).fold(f32::MAX, f32::min);
            if bd <= FLAG_MATCH && bd * 2.0 < second && best.is_none_or(|(_, _, d)| bd < d) {
                best = Some((bsi, ci, bd));
            }
        }
        let Some((si, ci, _)) = best else { break };
        out.push((free_slots.remove(si), free_cards.remove(ci).def_id));
    }
    if out.last().is_some_and(|(s, _)| !free_slots.contains(s)) && free_cards.len() == 1 && free_slots.len() == 1 {
        out.push((free_slots.remove(0), free_cards.remove(0).def_id));
    }
    (out, free_slots, free_cards)
}

fn compatible(obs: &SlotObs, c: &SetCard) -> bool {
    c.points == obs.points
        && obs.rating.is_none_or(|r| c.rating == Some(r))
        && obs.position.as_ref().is_none_or(|p| c.position.as_ref() == Some(p))
}

/// `unselected` = def_ids seen on this set's swap pages. `swap_complete` = all swap pages scanned.
pub fn identify(
    slots: &[SlotObs],
    cards: &[SetCard],
    unselected: &BTreeSet<u64>,
    swap_complete: bool,
    learned: &BTreeMap<u64, Vec<f32>>,
) -> Identified {
    let pool: Vec<&SetCard> = cards.iter().filter(|c| !unselected.contains(&c.def_id)).collect();
    let mut out = Identified::default();
    let mut taken: BTreeSet<u64> = BTreeSet::new();

    // Group slots by their observation signature; cards with the same signature are
    // interchangeable for us, so we reason per group.
    let mut groups: BTreeMap<(u32, Option<u32>, Option<String>), Vec<usize>> = BTreeMap::new();
    for (i, s) in slots.iter().enumerate() {
        groups.entry((s.points, s.rating, s.position.clone())).or_default().push(i);
    }

    // Most specific groups first (rating/position read), then repeat until nothing changes:
    // a card identified in one group is no longer a candidate for the others, which can make
    // them certain (e.g. Rice 88 CDM read → the other 8,300 slot must be Raya).
    let mut pending: Vec<Vec<usize>> = groups.into_values().collect();
    pending.sort_by_key(|idx| {
        let s = &slots[idx[0]];
        std::cmp::Reverse(s.rating.is_some() as u8 + s.position.is_some() as u8)
    });
    loop {
        let mut progressed = false;
        pending.retain(|idx| {
            let obs = &slots[idx[0]];
            let candidates: Vec<&&SetCard> =
                pool.iter().filter(|c| compatible(obs, c) && !taken.contains(&c.def_id)).collect();
            let n_fo = idx.iter().filter(|&&i| slots[i].first_owner).count();
            // Certain when the slots use up every compatible candidate: either exactly as many
            // candidates as slots, or – after a complete swap scan – the pool is the lineup itself.
            let certain = candidates.len() == idx.len() || (swap_complete && candidates.len() <= idx.len());
            if !certain && idx.len() == 1 {
                // One slot, several possible cards (Swap Player not fully paged yet): the flag decides
                // when it matches exactly one candidate and every other candidate's learned flag
                // clearly differs (an unlearned or same nation can't be excluded).
                if let Some(def_id) = flag_unique(&slots[idx[0]], &candidates.iter().map(|c| **c).collect::<Vec<_>>(), learned) {
                    out.slots.insert(idx[0], def_id);
                    out.first_owner.insert(def_id, slots[idx[0]].first_owner);
                    taken.insert(def_id);
                    progressed = true;
                    return false;
                }
            }
            if !certain || candidates.is_empty() {
                return true;
            }
            // The group is fully known as a set. First-owner status per card is certain only if
            // all slots agree (all or none first owner); otherwise we can not tell which is which.
            let agree = n_fo == 0 || n_fo == idx.len();
            for c in &candidates {
                taken.insert(c.def_id);
                if agree {
                    out.first_owner.insert(c.def_id, n_fo > 0);
                }
            }
            let flagged = (candidates.len() == idx.len() && idx.len() > 1)
                .then(|| assign_by_flag(idx, &candidates.iter().map(|c| **c).collect::<Vec<_>>(), slots, learned))
                .filter(|(pairs, _, _)| !pairs.is_empty());
            if let Some((pairs, rest_slots, rest_cards)) = flagged {
                // Each placed card's own slot is known: its first-owner triangle is its fact.
                for (slot, def_id) in pairs {
                    out.slots.insert(slot, def_id);
                    out.first_owner.insert(def_id, slots[slot].first_owner);
                }
                // The rest: certain as a group; first owner only if those slots agree.
                let rest_fo = rest_slots.iter().filter(|&&i| slots[i].first_owner).count();
                if rest_fo == 0 || rest_fo == rest_slots.len() {
                    for c in &rest_cards {
                        out.first_owner.insert(c.def_id, rest_fo > 0);
                    }
                }
                out.ambiguous += rest_slots.len();
            } else if candidates.len() == idx.len() && agree {
                for (slot, c) in idx.iter().zip(&candidates) {
                    out.slots.insert(*slot, c.def_id);
                    if idx.len() == 1 {
                        out.unique.insert(*slot);
                    }
                }
            } else {
                out.ambiguous += idx.len();
            }
            progressed = true;
            false
        });
        if !progressed {
            break;
        }
    }
    out.ambiguous += pending.iter().map(Vec::len).sum::<usize>();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs(points: u32, fo: bool) -> SlotObs {
        SlotObs { points, rating: None, position: None, first_owner: fo, flag: None, uncertain: false }
    }

    fn card(def_id: u64, points: u32) -> SetCard {
        SetCard { def_id, points, rating: None, position: None, nation: None }
    }

    #[test]
    fn unique_points_identify_the_slot_and_its_first_owner_flag() {
        let slots = [obs(11_000, false), obs(5_125, true)];
        let cards = [card(1, 11_000), card(2, 5_125), card(3, 340)];
        let id = identify(&slots, &cards, &BTreeSet::new(), false, &BTreeMap::new());
        assert_eq!(id.slots, BTreeMap::from([(0, 1), (1, 2)]));
        assert_eq!(id.first_owner, BTreeMap::from([(1, false), (2, true)]));
        assert_eq!(id.ambiguous, 0);
    }

    #[test]
    fn same_points_stay_ambiguous_until_the_swap_pages_eliminate_the_rest() {
        // Two 340 slots, four 340-point cards collected (two are outside the lineup).
        let slots = [obs(340, true), obs(340, true)];
        let cards = [card(1, 340), card(2, 340), card(3, 340), card(4, 340)];
        let none = identify(&slots, &cards, &BTreeSet::new(), false, &BTreeMap::new());
        assert!(none.first_owner.is_empty());
        assert_eq!(none.ambiguous, 2);

        // Swap pages showed cards 3 and 4 → the lineup holds 1 and 2, both first owner.
        let seen = BTreeSet::from([3, 4]);
        let id = identify(&slots, &cards, &seen, true, &BTreeMap::new());
        assert_eq!(id.first_owner, BTreeMap::from([(1, true), (2, true)]));
        assert_eq!(id.ambiguous, 0);
    }

    #[test]
    fn a_card_identified_elsewhere_resolves_the_remaining_slot() {
        // Live: Rice 88 CDM read with position, Raya slot only by points (both 8,300).
        let slots = [
            SlotObs { points: 8300, rating: None, position: None, first_owner: false, flag: None, uncertain: false },
            SlotObs { points: 8300, rating: Some(88), position: Some("CDM".into()), first_owner: false, flag: None, uncertain: false },
        ];
        let cards = [
            SetCard { def_id: 1, points: 8300, rating: Some(88), position: Some("GK".into()), nation: None },
            SetCard { def_id: 2, points: 8300, rating: Some(88), position: Some("CDM".into()), nation: None },
        ];
        let id = identify(&slots, &cards, &BTreeSet::new(), false, &BTreeMap::new());
        assert_eq!(id.slots, BTreeMap::from([(0, 1), (1, 2)]));
        assert_eq!(id.first_owner, BTreeMap::from([(1, false), (2, false)]));
        assert_eq!(id.ambiguous, 0);
    }

    #[test]
    fn flags_tell_two_otherwise_identical_cards_apart() {
        // Ødegaard (nation 36) and Bruno Guimarães (54): both 4,100 · 86 CM, only Bruno first owner.
        let norway = vec![180u8, 108, 125, 210, 112, 92, 175, 105, 118, 205, 110, 90, 170, 104, 120, 200, 108, 88];
        let brazil = vec![100u8, 159, 73, 119, 177, 73, 80, 140, 63, 116, 175, 68, 97, 161, 72, 114, 176, 73];
        let slot = |fo: bool, flag: &Vec<u8>| SlotObs { points: 4100, rating: None, position: None, first_owner: fo, flag: Some(flag.clone()), uncertain: false };
        let slots = [slot(false, &norway), slot(true, &brazil)];
        let cards = [
            SetCard { def_id: 1, points: 4100, rating: None, position: None, nation: Some(36) },
            SetCard { def_id: 2, points: 4100, rating: None, position: None, nation: Some(54) },
        ];
        // Without learned flags: ambiguous, no facts (mixed first owner).
        let none = identify(&slots, &cards, &BTreeSet::new(), false, &BTreeMap::new());
        assert!(none.first_owner.is_empty());
        // Brazil learned from another card (e.g. Gabriel): Bruno is slot 1, Ødegaard slot 0.
        let learned = BTreeMap::from([(54u64, brazil.iter().map(|v| *v as f32 + 4.0).collect::<Vec<f32>>())]);
        let id = identify(&slots, &cards, &BTreeSet::new(), false, &learned);
        assert_eq!(id.slots, BTreeMap::from([(0, 1), (1, 2)]));
        assert_eq!(id.first_owner, BTreeMap::from([(1, false), (2, true)]));
        // Same flag on both slots: never assigned.
        let same = [slot(false, &brazil), slot(true, &brazil)];
        let cards2 = [
            SetCard { def_id: 1, points: 4100, rating: None, position: None, nation: Some(54) },
            SetCard { def_id: 2, points: 4100, rating: None, position: None, nation: Some(54) },
        ];
        assert!(identify(&same, &cards2, &BTreeSet::new(), false, &learned).first_owner.is_empty());

        // One slot, two candidates (Swap Player not fully paged): Brazil matches, Norway is learned
        // and far away → Bruno. With Norway unlearned the other card can't be excluded.
        let one = [slot(true, &brazil)];
        let both = BTreeMap::from([
            (54u64, brazil.iter().map(|v| *v as f32).collect::<Vec<f32>>()),
            (36u64, norway.iter().map(|v| *v as f32).collect::<Vec<f32>>()),
        ]);
        let id = identify(&one, &cards, &BTreeSet::new(), false, &both);
        assert_eq!(id.first_owner, BTreeMap::from([(2, true)]));
        assert!(identify(&one, &cards, &BTreeSet::new(), false, &learned).first_owner.is_empty());
    }

    #[test]
    fn mixed_first_owner_in_a_group_is_not_attributed() {
        let slots = [obs(340, true), obs(340, false)];
        let cards = [card(1, 340), card(2, 340)];
        let id = identify(&slots, &cards, &BTreeSet::new(), false, &BTreeMap::new());
        assert!(id.first_owner.is_empty()); // we know one of them is FO, not which
        assert_eq!(id.ambiguous, 2);
    }

    #[test]
    fn rating_and_position_split_groups_when_read() {
        let slots = [
            SlotObs { points: 340, rating: Some(82), position: Some("CB".into()), first_owner: true, flag: None, uncertain: false },
            SlotObs { points: 340, rating: Some(82), position: Some("ST".into()), first_owner: false, flag: None, uncertain: false },
        ];
        let cards = [
            SetCard { def_id: 1, points: 340, rating: Some(82), position: Some("CB".into()), nation: None },
            SetCard { def_id: 2, points: 340, rating: Some(82), position: Some("ST".into()), nation: None },
            SetCard { def_id: 3, points: 340, rating: Some(82), position: Some("LM".into()), nation: None },
        ];
        let id = identify(&slots, &cards, &BTreeSet::new(), false, &BTreeMap::new());
        assert_eq!(id.first_owner, BTreeMap::from([(1, true), (2, false)]));
    }
}
