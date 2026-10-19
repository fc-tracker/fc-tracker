//! The model's plain data – what gallery_sets / lineup compute from. No I/O, no clock: the same
//! file builds into the app and into the browser version (web-core, WebAssembly).

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Acquired {
    pub source: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ListObs {
    pub score: Option<u32>,
    pub filled: Option<(u32, u32)>,
    pub at: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Price {
    /// Lowest Buy Now price seen (0 = none seen).
    pub bin: u64,
    /// Listings it was based on.
    pub listings: u32,
    pub at: u64,
    /// EA's own market average (the in-game "market average" on a card's info page).
    #[serde(default)]
    pub avg: Option<u64>,
}

impl Price {
    /// EA's average first (stable, official), else the lowest Buy Now seen.
    pub fn value(&self) -> Option<u64> {
        self.avg.or((self.bin > 0).then_some(self.bin))
    }
}

/// The user's in-game lineup of one set, read from the set page and its swap pages.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SetObs {
    pub slots: Vec<crate::lineup::SlotObs>,
    /// Points sum matched the in-game Base Grade.
    pub verified: bool,
    pub total: Option<u32>,
    pub base: Option<u32>,
    pub bonus: Option<u32>,
    pub lineup_at: Option<u64>,
    /// Collected cards seen on this set's swap pages = not in the lineup.
    pub unselected: BTreeSet<u64>,
    /// Slot → card, where certain.
    pub identified: BTreeMap<usize, u64>,
    pub ambiguous: usize,
    /// The verified lineup holds cards we didn't know as collected (points proven by the Base
    /// Grade, cards not named yet): no first-owner facts from it, no box clean-up by counts.
    #[serde(default)]
    pub unnamed: bool,
    /// The user marked suggested swaps as done: the lineup below is their word, not a read. The
    /// next verified read of the set page replaces it (and clears this).
    #[serde(default)]
    pub user_swapped: bool,
}

/// One card definition from EA's card database (concept search), as used by the Gallery.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GalleryCard {
    pub def_id: u64,
    pub score: u64,
    /// EA's "ever owned" flag – stays true after selling.
    pub collected: bool,
    pub rating: Option<u64>,
    pub rareflag: Option<u64>,
    pub league: Option<u64>,
    pub team: Option<u64>,
    pub nation: Option<u64>,
    pub name: Option<String>,
    pub position: Option<String>,
    pub weak_foot: Option<u64>,
    pub skill_moves: Option<u64>,
    /// Every position the card can play (EA `possiblePositions`, preferred first); empty until
    /// the raw card data has been seen – then the preferred position stands in.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub positions: Vec<String>,
    #[serde(default)]
    pub team_name: Option<String>,
    /// Holographic version (EA `hyperCosmetics` present): ×1.5 points and the Holographic tag.
    /// Only special cards can be holographic (verified 2026-10-13: 402 same-player pairs, all ×1.5).
    #[serde(default)]
    pub holo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: u64,
    pub asset_id: Option<u64>,
    pub rating: Option<u64>,
    pub position: Option<String>,
    pub item_type: Option<String>,
    pub untradeable: Option<bool>,
    #[serde(default)]
    pub name: Option<String>,
    /// EA's Gallery points for this card (`gradingScore`).
    #[serde(default)]
    pub grading_score: Option<u64>,
    #[serde(default)]
    pub league_id: Option<u64>,
    #[serde(default)]
    pub team_id: Option<u64>,
    #[serde(default)]
    pub nation_id: Option<u64>,
    #[serde(default)]
    pub rareflag: Option<u64>,
    pub last_seen: u64,
}
