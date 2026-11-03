//! EA's sync data → the model's cards: the Gallery card lists, the card-database search, the
//! club pages. Pure parsing (no I/O, no clock) – the app's store and the browser version
//! (web-core) both use it.

use crate::types::{GalleryCard, Item, PlayData};
use serde_json::Value;

pub(crate) const GALLERY_PREFIX: &str = "fct://gallery/";
pub(crate) const CLUB_READ_PREFIX: &str = "fct://club/";

pub(crate) fn parse_gallery_card(v: &Value) -> Option<GalleryCard> {
    let u = |k: &str| v.get(k).and_then(Value::as_u64);
    Some(GalleryCard {
        def_id: u("definitionId").filter(|&d| d > 0)?,
        score: u("gradingScore").unwrap_or(0),
        collected: v.get("isCollected").and_then(Value::as_bool).unwrap_or(false),
        rating: u("rating"),
        rareflag: u("rareflag"),
        league: u("leagueId"),
        team: u("teamId"),
        nation: u("nationId"),
        name: v.get("name").and_then(Value::as_str).map(str::to_string),
        position: v.get("preferredPosition").and_then(Value::as_str).map(str::to_string),
        weak_foot: u("weakFoot"),
        skill_moves: u("skillMoves"),
        positions: Vec::new(),
        team_name: v.get("teamName").and_then(Value::as_str).map(str::to_string),
        holo: v.get("holo").and_then(Value::as_bool).unwrap_or(false),
        face: Vec::new(),
    })
}

/// The same card in EA's raw JSON (the Web App's own `/defid` responses, captured passively).
/// This is the reliable source of `isCollected` – the in-page entities can report it as false
/// (seen 2026-10-13: 0 collected via entities, 1,527 in the raw responses of the same sync).
pub(crate) fn parse_raw_concept_card(v: &Value) -> Option<GalleryCard> {
    let u = |k: &str| v.get(k).and_then(Value::as_u64);
    Some(GalleryCard {
        def_id: u("resourceId").or_else(|| u("id")).filter(|&d| d > 0)?,
        score: u("gradingScore").unwrap_or(0),
        collected: v.get("isCollected").and_then(Value::as_bool).unwrap_or(false),
        rating: u("rating"),
        rareflag: u("rareflag"),
        league: u("leagueId"),
        team: u("teamid"),
        nation: u("nation"),
        name: None,
        position: v.get("preferredPosition").and_then(Value::as_str).map(str::to_string),
        weak_foot: u("weakfootabilitytypecode"),
        // EA stores skill moves as stars − 1.
        skill_moves: u("skillmoves").map(|s| s + 1),
        positions: v
            .get("possiblePositions")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default(),
        team_name: None,
        holo: v.get("hyperCosmetics").and_then(Value::as_object).is_some_and(|o| !o.is_empty()),
        face: v
            .get("attributeArray")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_u64).map(|x| x.min(99) as u8).collect::<Vec<_>>())
            .filter(|a| a.len() == 6)
            .unwrap_or_default(),
    })
}

impl GalleryCard {
    /// Combines two observations of the same card. `collected` is sticky: in-game a card
    /// stays collected forever, so one positive observation wins. Missing fields are filled in.
    pub(crate) fn merged_with(mut self, old: &GalleryCard) -> GalleryCard {
        self.collected |= old.collected;
        self.holo |= old.holo;
        if self.score == 0 {
            self.score = old.score;
        }
        self.rating = self.rating.or(old.rating);
        self.rareflag = self.rareflag.or(old.rareflag);
        self.league = self.league.or(old.league);
        self.team = self.team.or(old.team);
        self.nation = self.nation.or(old.nation);
        // EA's "---" placeholder never replaces a real name
        self.name = self.name.take().filter(|n| n.chars().any(char::is_alphanumeric)).or_else(|| old.name.clone());
        self.position = self.position.take().or_else(|| old.position.clone());
        self.weak_foot = self.weak_foot.or(old.weak_foot);
        self.skill_moves = self.skill_moves.or(old.skill_moves);
        if self.positions.is_empty() {
            self.positions = old.positions.clone();
        }
        self.team_name = self.team_name.take().or_else(|| old.team_name.clone());
        if self.face.is_empty() {
            self.face = old.face.clone();
        }
        self
    }
}

pub(crate) fn strip_query(url: &str) -> &str {
    url.split(['?', '#']).next().unwrap_or(url)
}

/// `https://host/ut/game/fc27/club?x=1` → `/ut/game/fc27/club`. Numeric ids are normalised to `{id}`.
pub fn endpoint_key(url: &str) -> String {
    let no_query = strip_query(url);
    if no_query.starts_with("fct://") {
        return no_query.to_string(); // our own synthetic sources, e.g. fct://club/players
    }
    let path = no_query.splitn(4, '/').nth(3).map(|p| format!("/{p}")).unwrap_or_default();
    path.split('/')
        .map(|seg| if !seg.is_empty() && seg.chars().all(|c| c.is_ascii_digit()) { "{id}" } else { seg })
        .collect::<Vec<_>>()
        .join("/")
}

/// (item, `owners`, card definition id). The definition id (`resourceId`) is what the Gallery
/// uses; for special cards it differs from `assetId` (the base player).
pub(crate) fn collect_items(v: &Value, out: &mut Vec<(Item, Option<u64>, Option<u64>)>, now: u64) {
    match v {
        // a sold card on the transfer list stays there until the list is cleared: not the club's any
        // more (2026-11-01: a sold Bonmatí kept coming back in objective squads)
        Value::Object(map) if map.get("tradeState").and_then(Value::as_str) == Some("closed") => {}
        Value::Object(map) => {
            for (k, child) in map {
                if k == "itemData" {
                    let arr = match child {
                        Value::Array(a) => a.iter().collect::<Vec<_>>(),
                        obj @ Value::Object(_) => vec![obj],
                        _ => vec![],
                    };
                    out.extend(arr.into_iter().filter_map(|i| {
                        let def_id = i.get("resourceId").and_then(Value::as_u64);
                        Some((parse_item(i, now)?, i.get("owners").and_then(Value::as_u64), def_id))
                    }));
                } else {
                    collect_items(child, out, now);
                }
            }
        }
        Value::Array(arr) => arr.iter().for_each(|c| collect_items(c, out, now)),
        _ => {}
    }
}

pub(crate) fn raw_concept_cards(body: &Value) -> Vec<GalleryCard> {
    body.get("itemData")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(parse_raw_concept_card).collect())
        .unwrap_or_default()
}

/// `/ut/game/fc27/defid` is the Web App's concept (card database) search.
pub(crate) fn is_card_database_search(url: &str) -> bool {
    endpoint_key(url).ends_with("/defid")
}

pub(crate) fn parse_item(v: &Value, now: u64) -> Option<Item> {
    // concept cards, and cards in a dream squad or an opponent's squad (Squad Battles hub): EA marks
    // those `dream` – the user doesn't own them (2026-10-30: Cruyff, Buffon, Puskás from a dream squad)
    if v.get("concept").and_then(Value::as_bool) == Some(true) || v.get("dream").and_then(Value::as_bool) == Some(true) || v.get("itemState").and_then(Value::as_str) == Some("invalid") {
        return None;
    }
    // id 0 = placeholder slots (empty squad/SBC positions), not owned items.
    let id = v.get("id")?.as_u64().filter(|&id| id > 0)?;
    Some(Item {
        id,
        asset_id: v.get("assetId").and_then(Value::as_u64),
        rating: v.get("rating").and_then(Value::as_u64),
        position: v.get("preferredPosition").and_then(Value::as_str).map(str::to_string),
        item_type: v.get("itemType").and_then(Value::as_str).map(str::to_string),
        untradeable: v.get("untradeable").and_then(Value::as_bool),
        name: v.get("name").and_then(Value::as_str).map(str::to_string),
        grading_score: v.get("gradingScore").and_then(Value::as_u64),
        league_id: v.get("leagueId").and_then(Value::as_u64),
        // EA's raw JSON uses `teamid`; our plain items use `teamId`.
        team_id: v.get("teamId").or_else(|| v.get("teamid")).and_then(Value::as_u64),
        nation_id: v.get("nationId").or_else(|| v.get("nation")).and_then(Value::as_u64),
        rareflag: v.get("rareflag").and_then(Value::as_u64),
        // raw EA JSON: lifetimeStatsArray; our plain items (the extension's club read): lifetimeStats
        stats: v
            .get("lifetimeStatsArray")
            .or_else(|| v.get("lifetimeStats"))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_u64).collect::<Vec<_>>())
            .filter(|a| !a.is_empty()),
        assists: v.get("lifetimeAssists").and_then(Value::as_u64),
        play: parse_play(v),
        last_seen: now,
        full_name: {
            let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::trim).filter(|n| real(n)).map(str::to_string);
            // the name a card shows (the Web App's rule): the common name, else the last name
            s("knownAs").or_else(|| s("commonName")).or_else(|| s("lastName")).or_else(|| s("firstName"))
        },
    })
}

/// A name EA really gave (not its "---" placeholder).
pub fn real(n: &str) -> bool {
    n.chars().any(char::is_alphanumeric)
}

/// The same player's base card: a promo card's definition id is the base id + n × 2^24
/// (Cruyff 67298909 = 190045 + 4 × 16777216).
pub fn base_id(def_id: u64) -> u64 {
    def_id & 0xFF_FFFF
}

/// EA writes "---" for some (promo) cards everywhere – in the Gallery and in the club. Every card
/// of a player gets the name another card of the same player has (the base card first). Global:
/// the Gallery, the club, the overlay, the side panel and FC-Tracker Web all read these names.
/// A club card the Web App named lends its name too: EA's raw responses (the transfer list) carry
/// no name, and a Gallery read can bring "---" (2026-11-03: Kelly and Ona Batlle showed as "Arsenal").
pub fn fill_names(gallery: &mut std::collections::BTreeMap<u64, GalleryCard>, items: Option<&mut std::collections::BTreeMap<u64, Item>>) {
    let mut by_player: std::collections::BTreeMap<u64, String> = std::collections::BTreeMap::new();
    // the base card first, then any card of the player, then the club's named cards
    for c in gallery.values().filter(|c| c.def_id == base_id(c.def_id)).chain(gallery.values()) {
        if let Some(n) = c.name.as_deref().filter(|n| real(n)) {
            by_player.entry(base_id(c.def_id)).or_insert_with(|| n.to_string());
        }
    }
    let item_def = |i: &Item| i.play.as_ref().and_then(|p| p.def_id).or(i.asset_id).unwrap_or(0);
    let mut by_card: std::collections::BTreeMap<u64, String> = std::collections::BTreeMap::new();
    for i in items.iter().flat_map(|m| m.values()) {
        if let Some(n) = i.name.as_deref().filter(|n| real(n)) {
            by_card.entry(item_def(i)).or_insert_with(|| n.to_string());
            by_player.entry(base_id(item_def(i))).or_insert_with(|| n.to_string());
        }
    }
    for c in gallery.values_mut() {
        if !c.name.as_deref().is_some_and(real) {
            if let Some(n) = by_card.get(&c.def_id) {
                c.name = Some(n.clone());
            }
        }
    }
    for c in gallery.values_mut() {
        if !c.name.as_deref().is_some_and(real) {
            if let Some(n) = by_player.get(&base_id(c.def_id)) {
                c.name = Some(n.clone());
            }
        }
    }
    let Some(items) = items else { return };
    for i in items.values_mut() {
        if i.name.as_deref().is_some_and(real) {
            continue;
        }
        let def = item_def(i);
        let found = gallery.get(&def).and_then(|c| c.name.clone()).filter(|n| real(n)).or_else(|| by_player.get(&base_id(def)).cloned()).or_else(|| i.asset_id.and_then(|a| by_player.get(&base_id(a)).cloned())).or_else(|| i.full_name.clone());
        if found.is_some() {
            i.name = found;
        }
    }
}

/// A club player's in-game data – only EA's raw club items carry it.
fn parse_play(v: &Value) -> Option<PlayData> {
    let positions: Vec<String> =
        v.get("possiblePositions").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    let nums = |k: &str| v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect::<Vec<_>>()).unwrap_or_default();
    let face = nums("attributeArray");
    if positions.is_empty() && face.is_empty() {
        return None;
    }
    Some(PlayData {
        def_id: v.get("resourceId").and_then(Value::as_u64).filter(|&d| d > 0),
        positions,
        face,
        ps: nums("baseTraits"),
        ps_plus: nums("iconTraits"),
        roles_plus: nums("plusRoles"),
        roles_pp: nums("plusPlusRoles"),
        weak_foot: v.get("weakfootabilitytypecode").and_then(Value::as_u64),
        skill_moves: v.get("skillmoves").and_then(Value::as_u64).map(|s| s + 1),
        loans: v.get("loans").and_then(Value::as_u64),
        foot: v.get("preferredfoot").and_then(Value::as_u64),
    })
}

/// EA's `marketAverage` of every card in a response (club items, market results, transfer list,
/// watchlist, pack previews …): (definition id, average). EA never sends it with the Gallery card
/// lists, so a card the user lacks has a price only once someone has seen it this way.
pub(crate) fn market_averages(body: &Value) -> Vec<(u64, u64)> {
    fn walk(v: &Value, out: &mut Vec<(u64, u64)>) {
        match v {
            Value::Object(map) => {
                let avg = map.get("marketAverage").and_then(Value::as_u64).filter(|&a| a > 0);
                let id = map.get("resourceId").and_then(Value::as_u64).filter(|&d| d > 0);
                if let (Some(avg), Some(id)) = (avg, id) {
                    out.push((id, avg));
                }
                map.values().for_each(|c| walk(c, out));
            }
            Value::Array(a) => a.iter().for_each(|c| walk(c, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(body, &mut out);
    out
}

/// The market the account trades on: "pc", or "console" (PlayStation and Xbox share one
/// market). From the FC 27 club in EA's account info (its SKU, e.g. FFA27PCC – the most recently
/// used one when there are several), else from a SKU in the request URL (store pages).
pub(crate) fn account_platform(url: &str, body: &Value) -> Option<&'static str> {
    fn from_sku(sku: &str) -> Option<&'static str> {
        let s = sku.to_ascii_uppercase();
        if !s.starts_with("FFA27") || s.len() < 7 {
            return None;
        }
        Some(if s.contains("PC") { "pc" } else { "console" })
    }
    if endpoint_key(url).ends_with("/user/accountinfo") {
        let mut best: Option<(u64, &'static str)> = None;
        for persona in body.pointer("/userAccountInfo/personas").and_then(Value::as_array).into_iter().flatten() {
            for club in persona.get("userClubList").and_then(Value::as_array).into_iter().flatten() {
                let at = club.get("lastAccessTime").and_then(Value::as_u64).unwrap_or(0);
                for sku in club.get("skuAccessList").and_then(Value::as_object).into_iter().flat_map(|m| m.keys()) {
                    if let Some(p) = from_sku(sku) {
                        if best.is_none_or(|(t, _)| at > t) {
                            best = Some((at, p));
                        }
                    }
                }
            }
        }
        if let Some((_, p)) = best {
            return Some(p);
        }
    }
    url.split(|c: char| !c.is_ascii_alphanumeric()).find_map(from_sku)
}

#[cfg(test)]
mod price_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn platform_from_account_info_and_urls() {
        let body = json!({ "userAccountInfo": { "personas": [
            { "userClubList": [{ "lastAccessTime": 10, "skuAccessList": { "FFA23PS4": 10 } }] },
            { "userClubList": [{ "lastAccessTime": 20, "skuAccessList": { "FFA27PS5": 20 } }, { "lastAccessTime": 30, "skuAccessList": { "FFA27PCC": 30 } }] }
        ] } });
        assert_eq!(account_platform("https://x/ut/game/fc27/v2/user/accountinfo?a=1", &body), Some("pc"));
        assert_eq!(account_platform("https://x/ut/game/fc27/sku_FFA27XBS/store/category", &Value::Null), Some("console"));
        assert_eq!(account_platform("https://x/ut/game/fc27/club", &Value::Null), None);
    }

    #[test]
    fn shared_pool_never_overrides_newer_prices_and_is_never_shared_back() {
        use crate::types::{apply_pool, own_prices_since, Price};
        use std::collections::BTreeMap;
        let mut prices = BTreeMap::new();
        prices.insert(1, Price::seen(None, 1000, 50));
        let pool: BTreeMap<u64, [u64; 2]> = [(1, [900, 40]), (2, [46750, 60])].into();
        assert_eq!(apply_pool(&mut prices, &pool), 1);
        assert_eq!(prices[&1].value(), Some(1000));
        assert_eq!(prices[&2].value(), Some(46750));
        assert!(prices[&2].shared);
        assert_eq!(own_prices_since(&prices, 0, 10), vec![[1, 1000, 50]]);
        // seen by the user later: own again
        prices.insert(2, Price::seen(prices.get(&2), 47000, 70));
        assert_eq!(own_prices_since(&prices, 60, 10), vec![[2, 47000, 70]]);
    }

    #[test]
    fn market_averages_anywhere_in_a_response() {
        let body = json!({ "auctionInfo": [{ "itemData": { "resourceId": 239085, "marketAverage": 46750 } }], "itemData": [{ "resourceId": 1, "marketAverage": 0 }] });
        assert_eq!(market_averages(&body), vec![(239085, 46750)]);
    }
}

/// The coin balance EA sends with the user's own data (user info, transfer list, watchlist).
pub(crate) fn credits(url: &str, body: &Value) -> Option<u64> {
    let key = endpoint_key(url);
    if !(key.ends_with("/usermassinfo") || key.ends_with("/tradepile") || key.ends_with("/watchlist") || key.ends_with("/user/credits")) {
        return None;
    }
    body.get("credits").or_else(|| body.pointer("/userInfo/credits")).and_then(Value::as_u64)
}
