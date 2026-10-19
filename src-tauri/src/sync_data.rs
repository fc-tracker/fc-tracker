//! EA's sync data → the model's cards: the Gallery card lists, the card-database search, the
//! club pages. Pure parsing (no I/O, no clock) – the app's store and the browser version
//! (web-core) both use it.

use crate::types::{GalleryCard, Item};
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
        self.name = self.name.take().or_else(|| old.name.clone());
        self.position = self.position.take().or_else(|| old.position.clone());
        self.weak_foot = self.weak_foot.or(old.weak_foot);
        self.skill_moves = self.skill_moves.or(old.skill_moves);
        if self.positions.is_empty() {
            self.positions = old.positions.clone();
        }
        self.team_name = self.team_name.take().or_else(|| old.team_name.clone());
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
    if v.get("concept").and_then(Value::as_bool) == Some(true) {
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
        last_seen: now,
    })
}
