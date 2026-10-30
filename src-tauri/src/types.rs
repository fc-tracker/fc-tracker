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
    /// From the shared price pool (another user's EA market average on the same platform), not
    /// seen by this user – never shared back.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub shared: bool,
}

impl Price {
    /// EA's average first (stable, official), else the lowest Buy Now seen.
    pub fn value(&self) -> Option<u64> {
        self.avg.or((self.bin > 0).then_some(self.bin))
    }

    /// EA's average as this user sees it now (club item, market result …).
    pub fn seen(old: Option<&Price>, avg: u64, at: u64) -> Price {
        match old {
            Some(p) => Price { avg: Some(avg), at, shared: false, ..*p },
            None => Price { bin: 0, listings: 0, at, avg: Some(avg), shared: false },
        }
    }

    /// A price from the shared pool – taken only when it is newer than the one we have.
    pub fn from_pool(old: Option<&Price>, avg: u64, at: u64) -> Option<Price> {
        match old {
            Some(p) if p.at >= at => None,
            Some(p) => Some(Price { avg: Some(avg), at, shared: true, ..*p }),
            None => Some(Price { bin: 0, listings: 0, at, avg: Some(avg), shared: true }),
        }
    }
}

/// The EA market averages this user saw themselves after `since` (ms), newest first – what the
/// shared pool gets: [definition id, average, seen at].
pub fn own_prices_since(prices: &BTreeMap<u64, Price>, since: u64, max: usize) -> Vec<[u64; 3]> {
    let mut v: Vec<[u64; 3]> = prices
        .iter()
        .filter(|(_, p)| !p.shared && p.at > since)
        .filter_map(|(&id, p)| p.avg.map(|a| [id, a, p.at]))
        .collect();
    v.sort_by(|a, b| b[2].cmp(&a[2]));
    v.truncate(max);
    v
}

/// The lowest Buy Now prices this user saw in their own market results after `since` (ms),
/// newest first – [definition id, lowest Buy Now, seen at]. Only market observations (they come
/// with EA's average); a price the user paid travels as a purchase instead.
pub fn own_bins_since(prices: &BTreeMap<u64, Price>, since: u64, max: usize) -> Vec<[u64; 3]> {
    let mut v: Vec<[u64; 3]> = prices
        .iter()
        .filter(|(_, p)| !p.shared && p.at > since && p.bin > 0 && p.avg.is_some())
        .map(|(&id, p)| [id, p.bin, p.at])
        .collect();
    v.sort_by(|a, b| b[2].cmp(&a[2]));
    v.truncate(max);
    v
}

/// A price paid for a card (Buy Now on the transfer market) – this user's own purchase, or the
/// shared pool of purchases on the platform. Fills only cards without EA's average: EA's average
/// stays first, a paid price is better than none (a card nobody had seen got a price at once –
/// user 2026-10-27, Rodman bought for 6,800). Kept like a Buy Now seen (`bin`; `listings` = how
/// many purchases agree). A newer price, or one more purchases agree on, replaces it – so one
/// sniped bargain gives way to the price most people paid.
pub fn apply_paid(prices: &mut BTreeMap<u64, Price>, id: u64, price: u64, at: u64, n: u32, shared: bool) -> bool {
    let n = n.max(1);
    match prices.get(&id) {
        Some(p) if p.avg.is_some() || (p.at >= at && p.listings >= n) || (p.bin == price && p.listings == n) => false,
        _ => {
            prices.insert(id, Price { bin: price, listings: n, at, avg: None, shared });
            true
        }
    }
}

/// Applies the shared pool of paid prices ({definition id: [price, newest purchase, purchases]}).
pub fn apply_paid_pool(prices: &mut BTreeMap<u64, Price>, pool: &BTreeMap<u64, [u64; 3]>) -> usize {
    pool.iter()
        .filter(|(&id, &[price, at, n])| price > 0 && apply_paid(prices, id, price, at, n.min(u32::MAX as u64) as u32, true))
        .count()
}

/// Applies the shared pool ({definition id: [average, seen at]}); returns how many changed.
pub fn apply_pool(prices: &mut BTreeMap<u64, Price>, pool: &BTreeMap<u64, [u64; 2]>) -> usize {
    let mut n = 0;
    for (&id, &[avg, at]) in pool {
        if avg == 0 {
            continue;
        }
        if let Some(p) = Price::from_pool(prices.get(&id), avg, at) {
            prices.insert(id, p);
            n += 1;
        }
    }
    n
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
    /// The six face stats (EA `attributeArray`, the card database's raw data) – Objective squads
    /// rate cards to get with them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub face: Vec<u8>,
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
    /// EA's lifetime stats of this card in the user's club (`lifetimeStatsArray`): a player =
    /// [games, goals, yellow cards, red cards, …], a manager = [games, wins, draws, losses, clean sheets].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<Vec<u64>>,
    /// Lifetime assists of a player (`lifetimeAssists`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assists: Option<u64>,
    /// What a squad needs to know about a player (raw club data) – Objective squads (SQUADS.md).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub play: Option<PlayData>,
    pub last_seen: u64,
}

/// A club player's in-game data from EA's raw club items.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PlayData {
    /// The card definition (`resourceId`) – special cards differ from the base player's `assetId`.
    #[serde(default)]
    pub def_id: Option<u64>,
    /// EA `possiblePositions`.
    #[serde(default)]
    pub positions: Vec<String>,
    /// The six face stats (`attributeArray`): PAC SHO PAS DRI DEF PHY (a keeper: DIV HAN KIC REF SPD POS).
    #[serde(default)]
    pub face: Vec<u64>,
    /// PlayStyles (`baseTraits`) and PlayStyles+ (`iconTraits`).
    #[serde(default)]
    pub ps: Vec<u64>,
    #[serde(default)]
    pub ps_plus: Vec<u64>,
    /// Roles + and ++ (`plusRoles`, `plusPlusRoles`).
    #[serde(default)]
    pub roles_plus: Vec<u64>,
    #[serde(default)]
    pub roles_pp: Vec<u64>,
    #[serde(default)]
    pub weak_foot: Option<u64>,
    /// Stars (EA sends stars − 1).
    #[serde(default)]
    pub skill_moves: Option<u64>,
    /// Matches left on a loan item; none for owned cards.
    #[serde(default)]
    pub loans: Option<u64>,
    /// EA `preferredfoot`: 1 = right, 2 = left.
    #[serde(default)]
    pub foot: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_paid_price_fills_a_card_without_an_average_and_the_most_agreed_price_wins() {
        let mut prices = BTreeMap::new();
        // Rodman: no price anywhere, bought for 6,800 → priced at once
        assert!(apply_paid(&mut prices, 1, 6_800, 100, 1, false));
        assert_eq!(prices[&1].value(), Some(6_800));
        // the pool: two purchases agreeing on 6,850 replace one alone
        let pool = BTreeMap::from([(1u64, [6_850u64, 90, 2])]);
        assert_eq!(apply_paid_pool(&mut prices, &pool), 1);
        assert_eq!(prices[&1].value(), Some(6_850));
        // this user snipes it for 1,200: their own price until the pool (which still agrees on
        // 6,850 – the server picks the biggest group) comes back
        assert!(apply_paid(&mut prices, 1, 1_200, 200, 1, false));
        assert_eq!(apply_paid_pool(&mut prices, &pool), 1);
        assert_eq!(prices[&1].value(), Some(6_850));
        assert_eq!(apply_paid_pool(&mut prices, &pool), 0);
        // EA's average always stays first
        prices.insert(2, Price { bin: 0, listings: 0, at: 1, avg: Some(9_000), shared: false });
        assert!(!apply_paid(&mut prices, 2, 6_000, 500, 3, true));
        assert_eq!(prices[&2].value(), Some(9_000));
    }
}
