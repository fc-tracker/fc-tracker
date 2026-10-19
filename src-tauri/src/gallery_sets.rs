//! Gallery set definitions (`gallery-sets.json`) and the per-set overview shown in the overlay.
//!
//! All 128 in-game sets are listed explicitly (see the file's `$comment`; each set records
//! `source` + `verified` so screen reading can replace numbers).
//! Club sets match the badge team plus its EA-linked team (men's ↔ women's, from
//! `chemistry/teamlinks`), limited to the leagues of the set's category – this reproduces the
//! in-game rules "Requires 15 Aston Villa Mens or Womens players" and, because Birmingham's men
//! are not in a synced league, "Requires 15 Birmingham City Womens players".

use crate::gallery::{self, Card, GradeResult, GradeStep, TagResult};
use crate::store::{Acquired, GalleryCard, ListObs, Price, SetObs};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const SETS_JSON: &str = include_str!("../gallery-sets.json");
const MISSING_SHOWN: usize = 12;
/// Missing cards ranked for the shopping list (by how much buying one adds).
const SHOPPING_CANDIDATES: usize = 60;
const SHOPPING_SHOWN: usize = 30;
/// Rarities that only ever come from an SBC – never on the transfer market, so never a "buy next"
/// (43 = Player of the Month, e.g. Groß 84; verified in the user's card database 2026-10-15).
const SBC_ONLY_RARITIES: [u64; 1] = [43];
/// Card definition ids carry version bits above the database id.
const DATABASE_ID_MASK: u64 = 16_777_216;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SetFilter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub league: Option<u64>,
    /// Badge team id of a club set (its linked team is included automatically).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub club: Option<u64>,
    /// EA rarity ids (`rareflag`), e.g. [3] = TOTW, [72] = Heroes, [150, 22, 71] = Season 1.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rarities: Vec<u64>,
    /// Holographic cards only (Holographics set).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub holo: bool,
    /// Every card counts (Starter Set – the in-game set takes Heroes and gold cards alike).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub any: bool,
}

impl SetFilter {
    fn is_empty(&self) -> bool {
        self.league.is_none() && self.club.is_none() && self.rarities.is_empty() && !self.holo && !self.any
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetDef {
    pub key: String,
    pub name: String,
    pub category: String,
    /// "league" | "club" | "rarity"
    pub kind: String,
    pub filter: SetFilter,
    pub slots: usize,
    #[serde(default)]
    pub grades: Vec<GradeStep>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub verified: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CategoryDef {
    key: String,
    name: String,
    #[serde(default)]
    club_leagues: Vec<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetsFile {
    sync_leagues: Vec<u64>,
    categories: Vec<CategoryDef>,
    sets: Vec<SetDef>,
}

fn file() -> SetsFile {
    serde_json::from_str(SETS_JSON).expect("gallery-sets.json is invalid")
}

/// What the extension must read from EA's card database: one search per league and per
/// rarity id (`{"league": id}` / `{"rarity": id}`). Club sets reuse the league cards.
pub fn sync_filters() -> Vec<(String, serde_json::Value)> {
    let f = file();
    let rarities: BTreeSet<u64> = f.sets.iter().flat_map(|s| s.filter.rarities.iter().copied()).collect();
    f.sync_leagues
        .iter()
        .map(|&l| (format!("league-{l}"), serde_json::json!({ "league": l })))
        .chain(rarities.into_iter().map(|r| (format!("rarity-{r}"), serde_json::json!({ "rarity": r }))))
        .collect()
}

/// A sync search's name for the progress notice ("league-13" → "Premier League", "rarity-3" → "TOTW").
pub fn sync_filter_name(key: &str) -> Option<String> {
    let f = file();
    if let Some(l) = key.strip_prefix("league-").and_then(|l| l.parse::<u64>().ok()) {
        return f.sets.iter().find(|s| s.filter.league == Some(l)).map(|s| s.name.clone());
    }
    let r = key.strip_prefix("rarity-")?.parse::<u64>().ok()?;
    f.sets.iter().find(|s| s.filter.rarities.contains(&r)).map(|s| s.name.clone())
}

/// Everything we know about first ownership. We never guess: a card is first owner only when
/// seen in the club (`owners == 1`) or marked by the user (later: read from the in-game Gallery).
pub struct FirstOwnerInfo<'a> {
    /// Seen in the club with `owners == 1`.
    pub known: &'a BTreeSet<u64>,
    /// User overrides (true/false) – beat everything else (lets the user correct a scan).
    pub manual: &'a BTreeMap<u64, bool>,
    /// Read from the in-game Gallery (first-owner triangle).
    pub scanned: &'a BTreeMap<u64, bool>,
    /// Seen in the club only as a bought copy (`owners` > 1, never `owners` == 1).
    pub club_no: &'a BTreeSet<u64>,
}

/// For callers without club data (tests, rules-only views).
pub static EMPTY_SET: BTreeSet<u64> = BTreeSet::new();
static EMPTY_FLAGS: BTreeMap<u64, bool> = BTreeMap::new();
static EMPTY_PRICES: BTreeMap<u64, Price> = BTreeMap::new();

/// The tracked sets a card belongs to (names, most specific first).
pub fn set_names_of(def_id: u64, gallery: &BTreeMap<u64, GalleryCard>, links: &BTreeMap<u64, Vec<u64>>) -> Vec<String> {
    let Some(card) = gallery.get(&def_id) else { return Vec::new() };
    let fo = FirstOwnerInfo { known: &EMPTY_SET, manual: &EMPTY_FLAGS, scanned: &EMPTY_FLAGS, club_no: &EMPTY_SET };
    let ctx = Context { fo: &fo, links, prices: &EMPTY_PRICES };
    let f = file();
    f.sets
        .iter()
        .filter(|s| !s.filter.is_empty())
        .filter(|s| f.categories.iter().find(|c| c.key == s.category).is_some_and(|cat| matches(card, s, cat, &ctx)))
        .collect::<Vec<_>>()
        .into_iter()
        // Most specific first: club, league, rarity, then sets any card fits (Starter Set).
        .map(|s| ((s.filter.any, match s.kind.as_str() { "club" => 0, "league" => 1, _ => 2 }), s.name.clone()))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(|(_, n)| n)
        .collect()
}

/// How a card's first-owner status was determined (shown in the overlay).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FirstOwnerStatus {
    Known,
    Manual,
    ManualNo,
    /// Verified in-game (scan).
    Scanned,
    ScannedNo,
    /// The copy in the club was bought (`owners` > 1) and no first-owner copy was ever seen.
    /// An older packed copy sold before tracking would still count in-game – the set page's
    /// triangle overrides this.
    ClubNo,
    /// Collected, but we can't see whether the user was the first owner (sold before tracking).
    Unknown,
    None,
}

impl FirstOwnerInfo<'_> {
    /// Proofs first: a triangle read in-game, then EA's `owners == 1` (a "not first owner" read or
    /// a purchase never beats EA saying the club copy is first owner), then a "no" read, then the
    /// user's mark. Without any of these: not first owner.
    pub fn known_or_manual(&self, def_id: u64) -> bool {
        match self.scanned.get(&def_id) {
            Some(true) => true,
            _ if self.known.contains(&def_id) => true,
            Some(false) => false,
            None => self.manual.get(&def_id).copied().unwrap_or(false),
        }
    }

    pub fn status(&self, c: &GalleryCard) -> FirstOwnerStatus {
        match self.scanned.get(&c.def_id) {
            Some(true) => FirstOwnerStatus::Scanned,
            _ if self.known.contains(&c.def_id) => FirstOwnerStatus::Known,
            Some(false) => FirstOwnerStatus::ScannedNo,
            None => match self.manual.get(&c.def_id) {
                Some(true) => FirstOwnerStatus::Manual,
                Some(false) => FirstOwnerStatus::ManualNo,
                None if self.club_no.contains(&c.def_id) => FirstOwnerStatus::ClubNo,
                None if c.collected => FirstOwnerStatus::Unknown,
                None => FirstOwnerStatus::None,
            },
        }
    }

    /// Nothing proves this card's status (not read, no EA fact, no mark): the set page's triangle
    /// on the slot it sits in is then what counts. ClubNo too – an older packed copy may exist.
    pub fn soft(&self, c: &GalleryCard) -> bool {
        matches!(self.status(c), FirstOwnerStatus::Unknown | FirstOwnerStatus::ClubNo)
    }
}

/// Finds the set an in-game page title refers to ("Premier League 1", "O Manchester City" …):
/// the longest set name contained in the normalised title wins.
pub fn find_set_by_title(title: &str) -> Option<SetDef> {
    let t = crate::scan::normalise_name(title);
    if t.len() < 3 {
        return None;
    }
    let sets = file().sets;
    let norm = |s: &SetDef| crate::scan::normalise_name(&s.name);
    // 1. A set name inside the title (title has extra OCR noise): the longest one wins.
    //    "Bundesliga" must not become "Frauen-Bundesliga", so a set name *longer* than the title
    //    only counts when nothing is contained in the title (2.).
    let inside = sets.iter().filter(|s| norm(s).len() >= 3 && t.contains(&norm(s))).max_by_key(|s| norm(s).len());
    // 2. The title cut short (e.g. a long club name): the shortest set name starting with it.
    let cut = || sets.iter().filter(|s| t.len() >= 6 && norm(s).starts_with(&t)).min_by_key(|s| norm(s).len());
    if let Some(set) = inside.or_else(cut) {
        return Some(set.clone());
    }
    // Multi-line tiles: OCR can reorder lines ("Serie Enilive A") or drop a lone digit
    // ("Ligue McDonald's"). Every word of the set name (lone digits optional) must be present.
    let words = |s: &str| -> Vec<String> {
        s.split(|c: char| c.is_whitespace() || c == '-' || c == '/')
            .map(crate::scan::normalise_name)
            .filter(|w| !w.is_empty())
            .collect()
    };
    let have = words(title);
    sets.into_iter()
        .filter_map(|s| {
            let need: Vec<String> = words(&s.name).into_iter().filter(|w| !w.chars().all(|c| c.is_ascii_digit())).collect();
            (!need.is_empty() && need.iter().all(|w| have.contains(w))).then(|| (need.iter().map(String::len).sum::<usize>(), s))
        })
        .max_by_key(|(len, _)| *len)
        .map(|(_, s)| s)
}

pub fn set_by_key(key: &str) -> Option<SetDef> {
    file().sets.into_iter().find(|s| s.key == key)
}

/// The highest Base Grade any lineup of the set can have (its best cards, owned or not).
pub fn base_cap(set: &SetDef, gallery: &BTreeMap<u64, GalleryCard>, links: &BTreeMap<u64, Vec<u64>>) -> u64 {
    let mut scores: Vec<u64> = cards_of_set(set, gallery, links).iter().map(|c| c.score).collect();
    scores.sort_unstable_by(|a, b| b.cmp(a));
    scores.iter().take(set.slots).sum()
}

/// The cards (collected or not) belonging to a set.
pub fn cards_of_set<'a>(
    set: &SetDef,
    gallery: &'a BTreeMap<u64, GalleryCard>,
    links: &BTreeMap<u64, Vec<u64>>,
) -> Vec<&'a GalleryCard> {
    let f = file();
    let Some(cat) = f.categories.iter().find(|c| c.key == set.category) else { return Vec::new() };
    let (known, manual) = (BTreeSet::new(), BTreeMap::new());
    let fo = FirstOwnerInfo { known: &known, manual: &manual, scanned: &manual, club_no: &EMPTY_SET };
    let prices = BTreeMap::new();
    let ctx = Context { fo: &fo, links, prices: &prices };
    gallery.values().filter(|c| matches(c, set, cat, &ctx)).collect()
}

struct Context<'a> {
    fo: &'a FirstOwnerInfo<'a>,
    links: &'a BTreeMap<u64, Vec<u64>>,
    prices: &'a BTreeMap<u64, Price>,
}

fn matches(card: &GalleryCard, set: &SetDef, cat: &CategoryDef, ctx: &Context) -> bool {
    let f = &set.filter;
    if let Some(league) = f.league {
        return card.league == Some(league);
    }
    if let Some(club) = f.club {
        let in_category = card.league.is_some_and(|l| cat.club_leagues.contains(&l));
        let team_ok = card.team.is_some_and(|t| t == club || ctx.links.get(&club).is_some_and(|l| l.contains(&t)));
        return in_category && team_ok;
    }
    if f.any {
        return true;
    }
    if f.holo {
        return card.holo;
    }
    if !f.rarities.is_empty() {
        return card.rareflag.is_some_and(|r| f.rarities.contains(&r));
    }
    false
}

/// A card as the model scores it: first owner only when proven (a triangle read in-game, EA's
/// `owners == 1`, or the user's own mark) – everything else counts as not first owner (user
/// decision 2026-10-17: never guessed, never "up to").
fn to_card(c: &GalleryCard, ctx: &Context) -> Card {
    Card {
        score: c.score,
        nation: c.nation,
        club: c.team,
        league: c.league,
        player: Some(c.def_id % DATABASE_ID_MASK),
        rarity: c.rareflag,
        rating: c.rating,
        positions: if c.positions.is_empty() { c.position.iter().cloned().collect() } else { c.positions.clone() },
        weak_foot: c.weak_foot,
        skill_moves: c.skill_moves,
        holo: c.holo,
        first_owner: ctx.fo.known_or_manual(c.def_id),
    }
}

/// A card sitting in a read in-game slot: an unproven card takes the slot's triangle – that is
/// the picture proving it. Holographic cards always show a triangle, so it proves nothing there.
fn in_slot(c: &GalleryCard, slot_fo: bool, ctx: &Context) -> Card {
    let mut card = to_card(c, ctx);
    if !c.holo && ctx.fo.soft(c) {
        card.first_owner = slot_fo;
    }
    card
}

#[derive(Debug, Clone, Serialize)]
pub struct CardView {
    pub def_id: u64,
    pub name: Option<String>,
    pub rating: Option<u64>,
    pub position: Option<String>,
    pub score: u64,
    pub rareflag: Option<u64>,
    pub holo: bool,
    pub first_owner: FirstOwnerStatus,
    /// In-game lineup slot this entry stands for (anonymous slot cards only).
    pub slot: Option<usize>,
    /// EA's market average (else the lowest Buy Now seen) on the user's own platform market.
    pub price: Option<u64>,
    pub price_at: Option<u64>,
}

fn view(c: &GalleryCard, ctx: &Context) -> CardView {
    CardView {
        def_id: c.def_id,
        name: c.name.clone(),
        rating: c.rating,
        position: c.position.clone(),
        score: c.score,
        rareflag: c.rareflag,
        holo: c.holo,
        first_owner: ctx.fo.status(c),
        slot: None,
        price: ctx.prices.get(&c.def_id).and_then(Price::value),
        price_at: ctx.prices.get(&c.def_id).map(|p| p.at),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SetSummary {
    /// Best score of our optimiser alone (before the in-game floor).
    pub best_model: u64,
    pub key: String,
    pub name: String,
    pub kind: String,
    pub slots: usize,
    /// False when we can't read this set's cards yet (e.g. Holographics, Starter Set).
    pub tracked: bool,
    pub total: usize,
    pub collected: usize,
    pub missing: usize,
    /// All slots can be filled with collected cards (required before the set can be graded).
    pub complete: bool,
    pub base: u64,
    pub bonus: u64,
    /// Confirmed score: only known / marked first owners count – or the in-game total when that
    /// is higher (`from_ingame`), because the user's verified lineup is certainly achievable.
    pub score: u64,
    pub from_ingame: bool,
    pub tags: Vec<TagResult>,
    /// Reached grade + next threshold. `None` until the set is complete (in-game rule).
    pub grade: Option<GradeResult>,
    pub ladder: Vec<GradeStep>,
    /// Gallery Tokens earned at the reached grade (rewards are cumulative) and the maximum.
    pub tokens: u64,
    pub max_tokens: u64,
    pub verified: bool,
    /// The collected cards that count: the combination with the highest total (see gallery::optimise).
    pub lineup: Vec<CardView>,
    pub top_missing: Vec<CardView>,
    /// In-game lineup, when the tracker has seen this set's page.
    pub ingame: Option<InGame>,
    /// What the in-game category page shows for this set (score, or filled/slots).
    pub listed: Option<ListObs>,
    /// Swaps that turn the in-game lineup into the best lineup.
    pub swaps: Vec<SwapSuggestion>,
}

/// The user's current in-game lineup of a set (read by the Gallery tracking).
#[derive(Debug, Clone, Serialize)]
pub struct InGame {
    pub total: Option<u32>,
    pub base: Option<u32>,
    pub bonus: Option<u32>,
    /// Points sum matched the in-game Base Grade.
    pub verified: bool,
    pub slots: usize,
    pub identified: usize,
    pub ambiguous: usize,
    /// Collected cards seen on Swap Player (the box).
    pub in_box: usize,
    /// Swaps marked done by the user, not read in-game yet.
    pub user_swapped: bool,
    pub seen_at: Option<u64>,
    /// Our model scores this selection exactly like the game (every slot named or proven): a gain
    /// over it is certain. False: any gain is our estimate.
    pub exact: bool,
}

/// "Swap `out` for `into`". `out` may be an anonymous in-game slot (`slot` set, no name).
#[derive(Debug, Clone, Serialize)]
pub struct SwapSuggestion {
    pub out: CardView,
    pub into: CardView,
}

#[derive(Debug, Clone, Serialize)]
pub struct CategorySummary {
    pub key: String,
    pub name: String,
    pub sets: Vec<SetSummary>,
}

/// One entry of the optimisation pool: a known card, or an in-game lineup slot whose points
/// and first-owner triangle are certain but whose identity is not known (yet).
#[derive(Clone, Copy)]
enum Entry<'a> {
    /// A collected card; `Some(mark)`: it sits in a read in-game slot with that triangle.
    Card(&'a GalleryCard, Option<bool>),
    Slot { slot: usize, points: u32, first_owner: bool },
}

impl Entry<'_> {
    fn points(&self) -> u64 {
        match self {
            Entry::Card(c, _) => c.score,
            Entry::Slot { points, .. } => *points as u64,
        }
    }

    fn to_card(&self, ctx: &Context) -> Card {
        match self {
            Entry::Card(c, Some(mark)) => in_slot(c, *mark, ctx),
            Entry::Card(c, None) => to_card(c, ctx),
            Entry::Slot { points, first_owner, .. } => Card { score: *points as u64, first_owner: *first_owner, ..Default::default() },
        }
    }

    fn view(&self, ctx: &Context, obs: Option<&SetObs>) -> CardView {
        match self {
            Entry::Card(c, _) => view(c, ctx),
            Entry::Slot { slot, points, first_owner } => {
                let s = obs.and_then(|o| o.slots.get(*slot));
                CardView {
                    def_id: u64::MAX - *slot as u64,
                    name: None,
                    rating: s.and_then(|s| s.rating).map(|r| r as u64),
                    position: s.and_then(|s| s.position.clone()),
                    score: *points as u64,
                    rareflag: None,
                    holo: false,
                    first_owner: if *first_owner { FirstOwnerStatus::Scanned } else { FirstOwnerStatus::ScannedNo },
                    slot: Some(*slot),
                    price: None,
                    price_at: None,
                }
            }
        }
    }
}

/// Search limits for completing an in-game selection (a 30-slot set with several same-points
/// cards per slot stays far below these).
const COMPLETE_NODES: usize = 20_000;
const COMPLETE_LEAVES: usize = 1_500;
/// … and a time budget per set: the overview recomputes every set, it must stay quick.
const COMPLETE_BUDGET: std::time::Duration = std::time::Duration::from_millis(30);

/// How an unidentified in-game slot was filled in.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Completion {
    /// Every slot was already identified on the set page.
    Read,
    /// The filled-in combination scores exactly the game's total: the selection on screen.
    Proven,
    /// Consistent with every slot's points, rating, position and first-owner mark, but the total
    /// could not be reproduced (unknown first owners, a tag rule we don't model …).
    Likely,
}

/// Fills the unidentified slots of a read selection with collected cards: candidates per slot must
/// match its points and – where read – rating, position and first-owner mark. The combination whose
/// model total equals the game's total wins (`Proven`); otherwise the first consistent one
/// (`Likely`). No combination (a card we don't know as collected): `None`.
fn complete_selection(collected: &[&GalleryCard], obs: &SetObs, ctx: &Context) -> Option<(BTreeMap<usize, u64>, Completion)> {
    complete_selection_certain(collected, obs, ctx).map(|(ids, how, _)| (ids, how))
}

/// Like `complete_selection`, plus the filled slots that are **certain**: proven, and no other
/// candidate (in place, or swapped with another filled slot) scores the game's total too –
/// look-alike cards (same points, rating, position and tags) are interchangeable under the total,
/// so a proof alone doesn't say which of them sits where.
fn complete_selection_certain(collected: &[&GalleryCard], obs: &SetObs, ctx: &Context) -> Option<(BTreeMap<usize, u64>, Completion, BTreeSet<usize>)> {
    if obs.slots.is_empty() {
        return None;
    }
    if obs.identified.len() == obs.slots.len() {
        return Some((obs.identified.clone(), Completion::Read, BTreeSet::new()));
    }
    let taken: BTreeSet<u64> = obs.identified.values().copied().collect();
    let fits = |c: &GalleryCard, s: &crate::lineup::SlotObs| {
        let fo_ok = c.holo || ctx.fo.soft(c) || to_card(c, ctx).first_owner == s.first_owner;
        c.score == s.points as u64
            && s.rating.is_none_or(|r| c.rating == Some(r as u64))
            && s.position.as_deref().is_none_or(|p| c.position.as_deref().is_none_or(|cp| cp == p))
            && fo_ok
            && !taken.contains(&c.def_id)
            && !obs.unselected.contains(&c.def_id)
    };
    // open slots, fewest candidates first
    let mut open: Vec<(usize, Vec<&GalleryCard>)> = (0..obs.slots.len())
        .filter(|i| !obs.identified.contains_key(i))
        .map(|i| (i, collected.iter().copied().filter(|c| fits(c, &obs.slots[i])).collect::<Vec<_>>()))
        .collect();
    if open.iter().any(|(_, c)| c.is_empty()) {
        return None;
    }
    open.sort_by_key(|(_, c)| c.len());
    let by_id: BTreeMap<u64, &GalleryCard> = collected.iter().map(|c| (c.def_id, *c)).collect();
    // A card whose first-owner status we don't know takes the slot's mark (the game shows it): the
    // model then scores the selection the way the game does – without that, sets with unknown
    // cards never reproduced the game's total (Arsenal: 109,520 vs 114,873, 2026-10-16).
    let slot_card = |c: &GalleryCard, s: &crate::lineup::SlotObs| in_slot(c, s.first_owner, ctx);
    let fixed: Vec<Card> = obs.identified.iter().filter_map(|(slot, id)| Some(slot_card(by_id.get(id)?, obs.slots.get(*slot)?))).collect();
    let target = obs.total.filter(|_| obs.verified).map(u64::from);

    struct Search<'s, 'a> {
        open: &'s [(usize, Vec<&'a GalleryCard>)],
        fixed: &'s [Card],
        slots: &'s [crate::lineup::SlotObs],
        slot_card: &'s dyn Fn(&GalleryCard, &crate::lineup::SlotObs) -> Card,
        target: Option<u64>,
        chosen: Vec<&'a GalleryCard>,
        used: BTreeSet<u64>,
        first: Option<Vec<&'a GalleryCard>>,
        proven: Option<Vec<&'a GalleryCard>>,
        nodes: usize,
        leaves: usize,
        deadline: std::time::Instant,
    }
    impl<'s, 'a> Search<'s, 'a> {
        fn go(&mut self, k: usize) {
            if self.proven.is_some() || self.nodes >= COMPLETE_NODES || self.leaves >= COMPLETE_LEAVES || std::time::Instant::now() >= self.deadline {
                return;
            }
            self.nodes += 1;
            if k == self.open.len() {
                self.leaves += 1;
                if self.first.is_none() {
                    self.first = Some(self.chosen.clone());
                }
                if let Some(t) = self.target {
                    let mut cards = self.fixed.to_vec();
                    cards.extend(self.chosen.iter().zip(self.open).map(|(c, (slot, _))| (self.slot_card)(c, &self.slots[*slot])));
                    if gallery::score(&cards).total == t {
                        self.proven = Some(self.chosen.clone());
                    }
                } else {
                    // nothing to prove against: the first consistent combination is all we get
                    self.leaves = COMPLETE_LEAVES;
                }
                return;
            }
            for c in &self.open[k].1 {
                if self.used.insert(c.def_id) {
                    self.chosen.push(c);
                    self.go(k + 1);
                    self.chosen.pop();
                    self.used.remove(&c.def_id);
                }
            }
        }
    }
    // A consistent combination always comes from a bipartite matching (Kuhn) – instant, even when
    // the proof search below runs out of time.
    let matching = {
        fn augment<'a>(k: usize, open: &[(usize, Vec<&'a GalleryCard>)], seen: &mut BTreeSet<u64>, owner: &mut BTreeMap<u64, usize>) -> bool {
            for c in &open[k].1 {
                if seen.insert(c.def_id) {
                    let free = match owner.get(&c.def_id).copied() {
                        None => true,
                        Some(other) => augment(other, open, seen, owner),
                    };
                    if free {
                        owner.insert(c.def_id, k);
                        return true;
                    }
                }
            }
            false
        }
        let mut owner: BTreeMap<u64, usize> = BTreeMap::new();
        let ok = (0..open.len()).all(|k| augment(k, &open, &mut BTreeSet::new(), &mut owner));
        ok.then(|| {
            let by_slot: BTreeMap<usize, u64> = owner.iter().map(|(id, k)| (*k, *id)).collect();
            (0..open.len()).filter_map(|k| by_slot.get(&k).and_then(|id| by_id.get(id)).copied()).collect::<Vec<&GalleryCard>>()
        })
    };
    let Some(matching) = matching else { return None };
    let mut s = Search { open: &open, fixed: &fixed, slots: &obs.slots, slot_card: &slot_card, target, chosen: Vec::new(), used: BTreeSet::new(), first: Some(matching), proven: None, nodes: 0, leaves: 0, deadline: std::time::Instant::now() + COMPLETE_BUDGET };
    s.go(0);
    let (pick, how) = match (s.proven, s.first) {
        (Some(p), _) => (p, Completion::Proven),
        (None, Some(f)) => (f, Completion::Likely),
        _ => return None,
    };
    let mut certain = BTreeSet::new();
    if let (Completion::Proven, Some(t)) = (how, target) {
        let total = |p: &[&GalleryCard]| {
            let mut cards = fixed.clone();
            cards.extend(p.iter().zip(&open).map(|(c, (slot, _))| slot_card(c, &obs.slots[*slot])));
            gallery::score(&cards).total
        };
        for k in 0..open.len() {
            let ambiguous = open[k].1.iter().filter(|x| x.def_id != pick[k].def_id).any(|x| {
                let mut alt = pick.clone();
                match pick.iter().position(|p| p.def_id == x.def_id) {
                    // swap with the slot holding x, when the card fits there
                    Some(j) => {
                        if !open[j].1.iter().any(|c| c.def_id == pick[k].def_id) {
                            return false;
                        }
                        alt.swap(k, j);
                    }
                    None => alt[k] = x,
                }
                total(&alt) == t
            });
            if !ambiguous {
                certain.insert(open[k].0);
            }
        }
    }
    let mut identified = obs.identified.clone();
    for ((slot, _), c) in open.iter().zip(pick) {
        identified.insert(*slot, c.def_id);
    }
    Some((identified, how, certain))
}

/// For the tracker: the slots of the read selection that are named **for certain** by a proof
/// (the completed selection scores the game's total and no look-alike could stand in) – slot →
/// card. Only these become facts. `None` without proof.
pub fn prove_selection(key: &str, gallery: &BTreeMap<u64, GalleryCard>, fo: &FirstOwnerInfo, links: &BTreeMap<u64, Vec<u64>>, obs: &SetObs) -> Option<BTreeMap<usize, u64>> {
    let f = file();
    let set = f.sets.iter().find(|s| s.key == key)?;
    let cat = f.categories.iter().find(|c| c.key == set.category)?;
    let prices = BTreeMap::new();
    let ctx = Context { fo, links, prices: &prices };
    let collected: Vec<&GalleryCard> = gallery.values().filter(|c| c.collected && matches(c, set, cat, &ctx)).collect();
    match complete_selection_certain(&collected, obs, &ctx)? {
        (ids, Completion::Proven, certain) => Some(ids.into_iter().filter(|(slot, _)| obs.identified.contains_key(slot) || certain.contains(slot)).collect()),
        _ => None,
    }
}

/// The read selection with its open slots filled in (see `complete_selection`).
fn completed_obs(collected: &[&GalleryCard], obs: Option<&SetObs>, ctx: &Context) -> Option<(SetObs, Completion)> {
    let obs = obs.filter(|o| o.verified && !o.slots.is_empty())?;
    let (identified, how) = complete_selection(collected, obs, ctx)?;
    let mut o = obs.clone();
    o.identified = identified;
    Some((o, how))
}

/// The optimisation pool. Without a fully identified in-game lineup: every collected card.
/// With a verified lineup whose slots are all identified: its slots first (identified ones as cards, the rest as anonymous slots with
/// certain points + first-owner flag), then the box – every other collected card (Swap Player).
/// For every anonymous slot one same-points card leaves the box (preferring cards not seen on a
/// swap page – those seen there are certainly outside the lineup). Returns (pool, number of lineup entries at the front).
fn build_pool<'a>(collected: &[&'a GalleryCard], obs: Option<&SetObs>) -> (Vec<Entry<'a>>, usize) {
    // Any verified selection: named slots as cards with their triangle, the rest as anonymous
    // slots (certain points + triangle). Anonymous slots score without nation/club/position tags,
    // so the model of the game's selection is a lower bound – a swap is shown only when the best
    // selection beats the game's own total, so it can only gain.
    match obs.filter(|o| o.verified && !o.slots.is_empty()) {
        Some(obs) => lineup_pool(collected, obs),
        None => (collected.iter().map(|c| Entry::Card(c, None)).collect(), 0),
    }
}

/// The in-game lineup (identified cards, anonymous slots for the rest) followed by the box.
fn lineup_pool<'a>(collected: &[&'a GalleryCard], obs: &SetObs) -> (Vec<Entry<'a>>, usize) {
    let by_id: BTreeMap<u64, &'a GalleryCard> = collected.iter().map(|c| (c.def_id, *c)).collect();
    let mut pool: Vec<Entry<'a>> = Vec::new();
    let mut in_lineup: BTreeSet<u64> = BTreeSet::new();
    let mut anonymous_points: Vec<u32> = Vec::new();
    for (i, s) in obs.slots.iter().enumerate() {
        match obs.identified.get(&i).and_then(|id| by_id.get(id)) {
            Some(c) => {
                in_lineup.insert(c.def_id);
                pool.push(Entry::Card(c, Some(s.first_owner)));
            }
            None => {
                anonymous_points.push(s.points);
                pool.push(Entry::Slot { slot: i, points: s.points, first_owner: s.first_owner });
            }
        }
    }
    let lineup_len = pool.len();
    let mut rest: Vec<&GalleryCard> = collected.iter().copied().filter(|c| !in_lineup.contains(&c.def_id)).collect();
    for p in anonymous_points {
        let pos = rest
            .iter()
            .position(|c| c.score == p as u64 && !obs.unselected.contains(&c.def_id))
            .or_else(|| rest.iter().position(|c| c.score == p as u64));
        if let Some(pos) = pos {
            rest.remove(pos);
        }
    }
    pool.extend(rest.into_iter().map(|c| Entry::Card(c, None)));
    (pool, lineup_len)
}

/// Swaps from the in-game lineup (the first `lineup_len` pool entries) to the picked lineup.
fn swap_suggestions(pool: &[Entry], lineup_len: usize, picked: &[usize], ctx: &Context, obs: Option<&SetObs>, completed: Option<&SetObs>) -> Vec<SwapSuggestion> {
    let mut outgoing: Vec<usize> = (0..lineup_len).filter(|i| !picked.contains(i)).collect();
    let mut incoming: Vec<usize> = picked.iter().copied().filter(|&i| i >= lineup_len).collect();
    outgoing.sort_by_key(|&i| pool[i].points());
    incoming.sort_by_key(|&i| std::cmp::Reverse(pool[i].points()));
    // A filled-in slot keeps its slot label (rating, position, points) – the game shows that card,
    // we only inferred which one it is.
    let out_view = |o: usize| match (pool[o], completed, obs) {
        (Entry::Card(c, _), Some(done), Some(read)) => match done.identified.iter().find(|(_, id)| **id == c.def_id) {
            Some((slot, _)) if !read.identified.contains_key(slot) => {
                let s = &done.slots[*slot];
                Entry::Slot { slot: *slot, points: s.points, first_owner: s.first_owner }.view(ctx, obs)
            }
            _ => pool[o].view(ctx, obs),
        },
        _ => pool[o].view(ctx, obs),
    };
    outgoing
        .into_iter()
        .zip(incoming)
        .map(|(o, n)| SwapSuggestion { out: out_view(o), into: pool[n].view(ctx, obs) })
        .collect()
}

fn summarise(set: &SetDef, mut cards: Vec<&GalleryCard>, ctx: &Context, obs: Option<&SetObs>, listed: Option<&ListObs>) -> SetSummary {
    cards.sort_by(|a, b| b.score.cmp(&a.score));
    let (collected, missing): (Vec<&GalleryCard>, Vec<&GalleryCard>) = cards.iter().partition(|c| c.collected);

    // The read selection with open slots filled in from the club – no Swap Player paging needed.
    let completed = completed_obs(&collected, obs, ctx);
    let pool_obs = completed.as_ref().map(|(o, _)| o).or(obs);
    // Best combination (base + bonus), never worse than the in-game lineup when it is known.
    let (pool, lineup_len) = build_pool(&collected, pool_obs);
    let start_vec: Vec<usize> = (0..lineup_len).collect();
    let start = (lineup_len > 0).then_some(start_vec.as_slice());
    let candidates: Vec<Card> = pool.iter().map(|e| e.to_card(ctx)).collect();
    let picked = gallery::optimise_from(&candidates, set.slots, start);
    let score = gallery::score(&picked.iter().map(|&i| candidates[i].clone()).collect::<Vec<_>>());
    let exact_ingame = pool_obs
        .filter(|o| o.verified && o.identified.len() == o.slots.len() && lineup_len == o.slots.len())
        .and_then(|o| o.total)
        .is_some_and(|t| gallery::score(&candidates[..lineup_len]).total == t as u64);

    // The verified in-game lineup is achievable, so its total is a confirmed floor. Until all of
    // its cards are identified our per-card model can't reproduce it, so we show the game's own
    // numbers and lineup instead.
    let ingame_floor = obs.filter(|o| o.verified).and_then(|o| Some((o, o.total? as u64))).filter(|(_, t)| *t > score.total);
    let (mut total, base, bonus, mut from_ingame) = match ingame_floor {
        Some((o, t)) => (t, o.base.unwrap_or(0) as u64, o.bonus.unwrap_or(0) as u64, true),
        None => (score.total, score.base, score.bonus, false),
    };
    // The category page shows the real current score too (read without opening the set).
    if let Some(listed) = listed.and_then(|l| l.score).map(u64::from).filter(|l| *l > total) {
        total = listed;
        from_ingame = true;
    }
    // The game's own count beats ours: a lineup shown in-game (or a filled count on the category
    // page) is owned even when a purchase slipped past us.
    let in_game_filled = obs
        .filter(|o| o.verified)
        .map_or(0, |o| o.slots.len())
        .max(listed.and_then(|l| l.filled).map_or(0, |(f, _)| f as usize))
        .max(if listed.and_then(|l| l.score).is_some() { set.slots } else { 0 });
    let owned = collected.len().max(in_game_filled);
    let complete = owned >= set.slots;
    let grade = (complete && !set.grades.is_empty()).then(|| gallery::grade_for(&set.grades, total));
    let reached_score = grade
        .as_ref()
        .and_then(|g| g.grade.as_ref())
        .and_then(|name| set.grades.iter().find(|s| &s.grade == name))
        .map(|s| s.score);
    let tokens = reached_score.map_or(0, |reached| set.grades.iter().filter(|s| s.score <= reached).map(|s| s.tokens).sum());
    let mut lineup: Vec<CardView> = match ingame_floor {
        Some((o, _)) => {
            let by_id: BTreeMap<u64, &GalleryCard> = collected.iter().map(|c| (c.def_id, *c)).collect();
            o.slots
                .iter()
                .enumerate()
                .map(|(i, s)| match o.identified.get(&i).and_then(|id| by_id.get(id)) {
                    Some(c) => view(c, ctx),
                    None => Entry::Slot { slot: i, points: s.points, first_owner: s.first_owner }.view(ctx, obs),
                })
                .collect()
        }
        None => picked.iter().map(|&i| pool[i].view(ctx, obs)).collect(),
    };
    lineup.sort_by_key(|c| std::cmp::Reverse(c.score));

    SetSummary {
        best_model: score.total,
        key: set.key.clone(),
        name: set.name.clone(),
        kind: set.kind.clone(),
        slots: set.slots,
        tracked: !set.filter.is_empty(),
        total: cards.len(),
        collected: owned,
        missing: missing.len(),
        complete,
        base,
        bonus,
        score: total,
        from_ingame,
        tags: score.tags.into_iter().filter(|t| t.count > 0).collect(),
        grade,
        ladder: set.grades.clone(),
        tokens,
        max_tokens: set.grades.iter().map(|s| s.tokens).sum(),
        verified: set.verified,
        ingame: obs.filter(|o| !o.slots.is_empty()).map(|o| InGame {
            total: o.total,
            base: o.base,
            bonus: o.bonus,
            verified: o.verified,
            slots: o.slots.len(),
            identified: o.identified.len(),
            ambiguous: o.ambiguous,
            in_box: collected.iter().filter(|c| o.unselected.contains(&c.def_id)).count(),
            user_swapped: o.user_swapped,
            seen_at: o.lineup_at,
            exact: exact_ingame,
        }),
        // Only when the best selection beats the game's own total (the model can't reproduce the
        // in-game score with unknown first owners – live 2026-10-16: swaps that would lose points).
        swaps: if obs.and_then(|o| o.total).is_some_and(|t| score.total <= t as u64) {
            Vec::new()
        } else {
            swap_suggestions(&pool, lineup_len, &picked, ctx, obs, completed.as_ref().map(|(o, _)| o))
        },
        listed: listed.cloned(),
        lineup,
        top_missing: missing.iter().take(MISSING_SHOWN).map(|c| view(c, ctx)).collect(),
    }
}

/// Our score of the in-game lineup, when every card in it is identified – the check that our
/// model reproduces the game for this set before we claim a better lineup.
pub fn ingame_model_total(
    key: &str,
    gallery: &BTreeMap<u64, GalleryCard>,
    fo: &FirstOwnerInfo,
    links: &BTreeMap<u64, Vec<u64>>,
    observed: &BTreeMap<String, SetObs>,
) -> Option<u64> {
    let obs = observed.get(key).filter(|o| o.verified && !o.slots.is_empty())?;
    let prices = BTreeMap::new();
    let ctx = Context { fo, links, prices: &prices };
    // Not every slot read by name: a combination from the club that scores the game's total is
    // the same proof (`Completion::Proven`).
    let identified = if obs.identified.len() == obs.slots.len() {
        obs.identified.clone()
    } else {
        let f = file();
        let set = f.sets.iter().find(|s| s.key == key)?;
        let cat = f.categories.iter().find(|c| c.key == set.category)?;
        let collected: Vec<&GalleryCard> = gallery.values().filter(|c| c.collected && matches(c, set, cat, &ctx)).collect();
        match complete_selection(&collected, obs, &ctx)? {
            (ids, Completion::Proven | Completion::Read) => ids,
            _ => return None,
        }
    };
    let cards: Option<Vec<Card>> =
        (0..obs.slots.len()).map(|i| identified.get(&i).and_then(|id| gallery.get(id)).map(|c| in_slot(c, obs.slots[i].first_owner, &ctx))).collect();
    Some(gallery::score(&cards?).total)
}

/// The summary of one set (for a live notice on its page).
pub fn set_summary(
    key: &str,
    gallery: &BTreeMap<u64, GalleryCard>,
    fo: &FirstOwnerInfo,
    links: &BTreeMap<u64, Vec<u64>>,
    observed: &BTreeMap<String, SetObs>,
    prices: &BTreeMap<u64, Price>,
    listed: &BTreeMap<String, ListObs>,
) -> Option<SetSummary> {
    let f = file();
    let set = f.sets.iter().find(|s| s.key == key)?;
    let cat = f.categories.iter().find(|c| c.key == set.category)?;
    let ctx = Context { fo, links, prices };
    Some(summarise(set, gallery.values().filter(|c| matches(c, set, cat, &ctx)).collect(), &ctx, observed.get(key), listed.get(key)))
}

pub fn overview(
    gallery: &BTreeMap<u64, GalleryCard>,
    fo: &FirstOwnerInfo,
    links: &BTreeMap<u64, Vec<u64>>,
    observed: &BTreeMap<String, SetObs>,
    prices: &BTreeMap<u64, Price>,
    listed: &BTreeMap<String, ListObs>,
) -> Vec<CategorySummary> {
    let f = file();
    let ctx = Context { fo, links, prices };
    f.categories
        .iter()
        .map(|cat| CategorySummary {
            key: cat.key.clone(),
            name: cat.name.clone(),
            sets: f
                .sets
                .iter()
                .filter(|s| s.category == cat.key)
                .map(|s| summarise(s, gallery.values().filter(|c| matches(c, s, cat, &ctx)).collect(), &ctx, observed.get(&s.key), listed.get(&s.key)))
                .collect(),
        })
        .collect()
}

/// How much one card adds to the sets it belongs to (best lineup before vs. after), e.g. for a
/// card just packed (`as_first_owner`: packed cards count as first owner).
#[derive(Debug, Clone, Serialize)]
pub struct CardImpact {
    pub set_key: String,
    pub set_name: String,
    pub gain: u64,
    /// The set is not complete and the card takes a free slot: (cards in it afterwards, slots).
    pub fills: Option<(u32, u32)>,
}

/// Best lineup per set (cards, total, def_ids in it), computed once per screen read.
pub type LineupCache = BTreeMap<String, (Vec<Card>, u64, Vec<Option<u64>>)>;

#[allow(clippy::too_many_arguments)]
pub fn card_impact(
    def_id: u64,
    as_first_owner: bool,
    gallery: &BTreeMap<u64, GalleryCard>,
    fo: &FirstOwnerInfo,
    links: &BTreeMap<u64, Vec<u64>>,
    observed: &BTreeMap<String, SetObs>,
    prices: &BTreeMap<u64, Price>,
    cache: &mut LineupCache,
) -> Vec<CardImpact> {
    let Some(card) = gallery.get(&def_id) else { return Vec::new() };
    let f = file();
    let ctx = Context { fo, links, prices };
    let with = Card { first_owner: as_first_owner || ctx.fo.known_or_manual(def_id), ..to_card(card, &ctx) };
    let mut out = Vec::new();
    for set in f.sets.iter().filter(|s| !s.filter.is_empty()) {
        let Some(cat) = f.categories.iter().find(|c| c.key == set.category) else { continue };
        if !matches(card, set, cat, &ctx) {
            continue;
        }
        let (lineup, old, ids) = cache.entry(set.key.clone()).or_insert_with(|| {
            let collected: Vec<&GalleryCard> = gallery.values().filter(|c| c.collected && matches(c, set, cat, &ctx)).collect();
            // the read selection completed from the club (slot triangles kept): the impact is
            // measured against what the game really holds
            let completed = completed_obs(&collected, observed.get(&set.key), &ctx);
            let (pool, lineup_len) = build_pool(&collected, completed.as_ref().map(|(o, _)| o).or(observed.get(&set.key)));
            let start_vec: Vec<usize> = (0..lineup_len).collect();
            let start = (lineup_len > 0).then_some(start_vec.as_slice());
            let cards: Vec<Card> = pool.iter().map(|e| e.to_card(&ctx)).collect();
            let picked = gallery::optimise_from(&cards, set.slots, start);
            let lineup: Vec<Card> = picked.iter().map(|&i| cards[i].clone()).collect();
            let ids = picked.iter().map(|&i| match pool[i] { Entry::Card(c, _) => Some(c.def_id), Entry::Slot { .. } => None }).collect();
            let total = gallery::score(&lineup).total;
            (lineup, total, ids)
        });
        // Already in the lineup: only its first-owner status can change. Otherwise the best
        // single replacement (or a free slot).
        let fills = (lineup.len() < set.slots && !ids.contains(&Some(def_id))).then(|| ((lineup.len() + 1) as u32, set.slots as u32));
        let new = match ids.iter().position(|id| *id == Some(def_id)) {
            Some(i) => {
                let mut l = lineup.clone();
                l[i] = with.clone();
                gallery::score(&l).total
            }
            None if lineup.len() < set.slots => {
                let mut l = lineup.clone();
                l.push(with.clone());
                gallery::score(&l).total
            }
            None => (0..lineup.len())
                .map(|i| {
                    let mut l = lineup.clone();
                    l[i] = with.clone();
                    gallery::score(&l).total
                })
                .max()
                .unwrap_or(*old),
        };
        if new > *old {
            out.push(CardImpact { set_key: set.key.clone(), set_name: set.name.clone(), gain: new - *old, fills });
        }
    }
    out.sort_by(|a, b| b.gain.cmp(&a.gain));
    out
}

/// Live advice for the swap the user is previewing in-game (Swap screen, a lineup slot selected).
#[derive(Debug, Clone, Serialize)]
pub struct SwapAdvice {
    pub set_key: String,
    pub set_name: String,
    /// The game's own change for the highlighted swap.
    pub ingame_delta: i64,
    /// Our change for the same swap, when the highlighted card could be identified.
    pub model_delta: Option<i64>,
    /// Our model reproduces the in-game total before the swap exactly.
    pub model_exact: bool,
    /// The best card for this slot by our model and how much it adds (vs. the current lineup).
    pub best: Option<CardView>,
    pub best_gain: i64,
    /// The highlighted card is already the best choice for this slot.
    pub highlighted_is_best: bool,
    /// Lineup cards identified so far (advice is exact only when all are).
    pub identified: usize,
    pub slots: usize,
}

pub struct PreviewInput<'a> {
    pub out_points: u32,
    pub in_points: u32,
    pub in_rating: Option<u32>,
    pub in_position: Option<&'a str>,
    pub total_after: u32,
    pub total_delta: i64,
    /// def_ids of the cards visible on the swap page with these points (for the highlighted one).
    pub visible_in: Vec<u64>,
}

pub fn swap_advice(
    key: &str,
    gallery: &BTreeMap<u64, GalleryCard>,
    fo: &FirstOwnerInfo,
    links: &BTreeMap<u64, Vec<u64>>,
    obs: &SetObs,
    prices: &BTreeMap<u64, Price>,
    p: &PreviewInput,
) -> Option<SwapAdvice> {
    let f = file();
    let set = f.sets.iter().find(|s| s.key == key)?;
    let cat = f.categories.iter().find(|c| c.key == set.category)?;
    if obs.slots.is_empty() {
        return None;
    }
    let ctx = Context { fo, links, prices };
    let collected: Vec<&GalleryCard> = gallery.values().filter(|c| c.collected && matches(c, set, cat, &ctx)).collect();
    let (pool, lineup_len) = lineup_pool(&collected, obs);
    let cards: Vec<Card> = pool.iter().map(|e| e.to_card(&ctx)).collect();
    let lineup: Vec<usize> = (0..lineup_len).collect();
    let total = |l: &[usize]| gallery::score(&l.iter().map(|&i| cards[i].clone()).collect::<Vec<_>>()).total as i64;
    let old = total(&lineup);
    let before = p.total_after as i64 - p.total_delta;
    let rest: Vec<usize> = (lineup_len..pool.len()).collect();
    let swap_in = |slot: usize, b: usize| {
        let mut l = lineup.clone();
        l[slot] = b;
        total(&l)
    };
    // The highlighted card: outside the lineup with the in-card's points (+ rating/position when read),
    // narrowed to the cards visible on the swap page. Unique, or no model delta.
    let fits = |i: &usize| {
        let Entry::Card(c, _) = pool[*i] else { return false };
        c.score == p.in_points as u64
            && p.in_rating.is_none_or(|r| c.rating == Some(r as u64))
            && p.in_position.is_none_or(|pos| c.position.as_deref() == Some(pos))
            && (p.visible_in.is_empty() || p.visible_in.contains(&c.def_id))
    };
    let highlighted: Vec<usize> = rest.iter().copied().filter(fits).collect();
    // The slot being replaced: a lineup entry with the out card's points. Several such slots
    // (e.g. one first owner, one not): the one where our change equals the game's.
    let slots: Vec<usize> = lineup.iter().copied().filter(|&i| pool[i].points() == p.out_points as u64).collect();
    let slot = match highlighted.as_slice() {
        [h] => slots.iter().copied().find(|&s| swap_in(s, *h) - old == p.total_delta).or(slots.first().copied()),
        _ => slots.first().copied(),
    }?;
    let swapped = |b: usize| swap_in(slot, b);
    let model_delta = match highlighted.as_slice() {
        [one] => Some(swapped(*one) - old),
        _ => None,
    };
    let best = rest.iter().copied().max_by_key(|&b| swapped(b))?;
    let best_gain = swapped(best) - old;
    Some(SwapAdvice {
        set_key: set.key.clone(),
        set_name: set.name.clone(),
        ingame_delta: p.total_delta,
        model_delta,
        model_exact: old == before,
        best: (best_gain > 0).then(|| pool[best].view(&ctx, Some(obs))),
        best_gain,
        highlighted_is_best: highlighted.len() == 1 && swapped(highlighted[0]) >= swapped(best),
        identified: obs.identified.len(),
        slots: obs.slots.len(),
    })
}

/// One missing card and how much the set's best score rises when it is bought and slotted in.
#[derive(Debug, Clone, Serialize)]
pub struct ShoppingEntry {
    pub card: CardView,
    pub gain: u64,
    /// Just bought / packed (seen on New Items) but not in this set's in-game lineup yet: the
    /// list keeps it with a ✓ until the set page shows it placed.
    #[serde(default)]
    pub got: bool,
    /// How it arrived: "pack" (first owner) or "bought".
    #[serde(default)]
    pub got_source: Option<String>,
}

/// The missing cards of one set, best buys first (shown in the click-through side list).
#[derive(Debug, Clone, Serialize)]
pub struct ShoppingList {
    pub key: String,
    pub name: String,
    pub slots: usize,
    pub collected: usize,
    pub missing: usize,
    /// Best score with the cards the user has now.
    pub score: u64,
    pub entries: Vec<ShoppingEntry>,
    /// The best selection from the user's own cards (the side panel's "Best selection" tab).
    pub best: Option<BestSelection>,
}

/// The whole best selection of a set from the cards the user has – one overview instead of a list
/// of swaps.
#[derive(Debug, Clone, Serialize)]
pub struct BestSelection {
    pub total: u64,
    pub base: u64,
    pub bonus: u64,
    /// Total of the selection read on the set page in-game.
    pub ingame: Option<u64>,
    /// Points over the in-game selection – only when our model scores that selection exactly like
    /// the game (else unknown). 0 = the selection in the game is already the best.
    pub gain: Option<u64>,
    /// Most points first.
    pub cards: Vec<BestCard>,
    pub tags: Vec<gallery::TagResult>,
    /// A few changes (up to `PRECISE_SWAPS`) from the known in-game selection: each as one precise
    /// swap – this card out, that one in – in the order that gains the most at every step. Empty
    /// for bigger changes (then the whole selection is the advice) or while the in-game selection
    /// isn't known card by card.
    pub swaps: Vec<BestSwap>,
}

/// One precise swap of the best selection: `out` leaves (None = an open slot is filled), `into`
/// comes in; `gain` = the total after this swap minus before (the swaps above already done).
#[derive(Debug, Clone, Serialize)]
pub struct BestSwap {
    pub out: Option<CardView>,
    pub into: CardView,
    pub gain: i64,
}

/// Up to this many changes are advised as precise swaps (user 2026-10-17: "single changes as
/// precise swaps, a big change as a new selection").
const PRECISE_SWAPS: usize = 3;

/// The changes from the in-game selection (pool `0..lineup_len`) to `picked`, as single swaps:
/// at each step the swap (any leaving card × any coming card, or filling an open slot) that gives
/// the highest total. Pairs are chosen by the score, not by points – which card a newcomer
/// replaces decides the bonus tags (Same Club, nations …).
fn precise_swaps(candidates: &[Card], lineup_len: usize, picked: &[usize], slots: usize) -> Vec<(Option<usize>, usize, i64)> {
    let mut incoming: Vec<usize> = picked.iter().copied().filter(|&i| i >= lineup_len).collect();
    let mut outgoing: Vec<usize> = (0..lineup_len).filter(|i| !picked.contains(i)).collect();
    if incoming.is_empty() || incoming.len() > PRECISE_SWAPS {
        return Vec::new();
    }
    let total = |sel: &[usize]| gallery::score_refs(&sel.iter().map(|&i| &candidates[i]).collect::<Vec<_>>()).total as i64;
    let mut current: Vec<usize> = (0..lineup_len).collect();
    let mut now = total(&current);
    let mut out = Vec::new();
    while !incoming.is_empty() {
        let mut best: Option<(Option<usize>, usize, Vec<usize>, i64)> = None;
        for &n in &incoming {
            let mut tries: Vec<(Option<usize>, Vec<usize>)> = outgoing
                .iter()
                .map(|&o| (Some(o), current.iter().map(|&c| if c == o { n } else { c }).collect()))
                .collect();
            if current.len() < slots {
                let mut added = current.clone();
                added.push(n);
                tries.push((None, added));
            }
            for (o, sel) in tries {
                let t = total(&sel);
                if best.as_ref().is_none_or(|b| t > b.3) {
                    best = Some((o, n, sel, t));
                }
            }
        }
        let Some((o, n, sel, t)) = best else { break };
        out.push((o, n, t - now));
        incoming.retain(|&i| i != n);
        if let Some(o) = o {
            outgoing.retain(|&i| i != o);
        }
        current = sel;
        now = t;
    }
    // every leaving card must have been used, else the steps don't reach the best selection
    if outgoing.is_empty() { out } else { Vec::new() }
}

#[derive(Debug, Clone, Serialize)]
pub struct BestCard {
    pub card: CardView,
    /// Already in the in-game selection (`None` while that selection isn't known card by card).
    pub in_selection: Option<bool>,
}

/// The best selection of a set from the collected cards, never worse than the in-game one.
fn best_selection(
    key: &str,
    collected: &[&GalleryCard],
    gallery: &BTreeMap<u64, GalleryCard>,
    observed: &BTreeMap<String, SetObs>,
    slots: usize,
    ctx: &Context,
) -> Option<BestSelection> {
    if collected.is_empty() {
        return None;
    }
    let obs = observed.get(key);
    let completed = completed_obs(collected, obs, ctx);
    // Which cards are in the game's selection is only said when it is certain.
    let certain = obs.is_some_and(|o| o.verified && !o.slots.is_empty() && o.identified.len() == o.slots.len())
        || completed.as_ref().is_some_and(|(_, how)| matches!(how, Completion::Read | Completion::Proven));
    let pool_obs = completed.as_ref().map(|(o, _)| o).or(obs);
    let (pool, lineup_len) = build_pool(collected, pool_obs);
    let start_vec: Vec<usize> = (0..lineup_len).collect();
    let start = (lineup_len > 0).then_some(start_vec.as_slice());
    let candidates: Vec<Card> = pool.iter().map(|e| e.to_card(ctx)).collect();
    let picked = gallery::optimise_from(&candidates, slots, start);
    let score = gallery::score(&picked.iter().map(|&i| candidates[i].clone()).collect::<Vec<_>>());
    let ingame = obs.filter(|o| o.verified).and_then(|o| o.total).map(u64::from);
    let exact = ingame.is_some_and(|t| ingame_model_total(key, gallery, ctx.fo, ctx.links, observed) == Some(t));
    let gain = ingame.filter(|_| exact).map(|t| score.total.saturating_sub(t));
    let mut cards: Vec<BestCard> = picked
        .iter()
        .map(|&i| BestCard { card: pool[i].view(ctx, pool_obs), in_selection: (certain && lineup_len > 0).then_some(i < lineup_len) })
        .collect();
    cards.sort_by_key(|c| std::cmp::Reverse(c.card.score));
    // Swaps need the read selection (slots not named yet show as their slot), and only when they
    // gain in total – never advice that loses points.
    let read_selection = obs.is_some_and(|o| o.verified && !o.slots.is_empty());
    let steps = if read_selection && lineup_len > 0 { precise_swaps(&candidates, lineup_len, &picked, slots) } else { Vec::new() };
    let steps = if steps.iter().map(|s| s.2).sum::<i64>() > 0 { steps } else { Vec::new() };
    let swaps = if !steps.is_empty() {
        steps
            .into_iter()
            .map(|(o, n, g)| BestSwap { out: o.map(|o| pool[o].view(ctx, pool_obs)), into: pool[n].view(ctx, pool_obs), gain: g })
            .collect()
    } else {
        Vec::new()
    };
    Some(BestSelection {
        total: score.total,
        base: score.base,
        bonus: score.bonus,
        ingame,
        gain,
        cards,
        tags: score.tags.into_iter().filter(|t| t.counts && t.bonus > 0).collect(),
        swaps,
    })
}

pub fn shopping_list(
    key: &str,
    gallery: &BTreeMap<u64, GalleryCard>,
    fo: &FirstOwnerInfo,
    links: &BTreeMap<u64, Vec<u64>>,
    observed: &BTreeMap<String, SetObs>,
    prices: &BTreeMap<u64, Price>,
    acquired: &BTreeMap<u64, Acquired>,
) -> Option<ShoppingList> {
    let f = file();
    let set = f.sets.iter().find(|s| s.key == key)?;
    let cat = f.categories.iter().find(|c| c.key == set.category)?;
    let ctx = Context { fo, links, prices };
    let mut cards: Vec<&GalleryCard> = gallery.values().filter(|c| matches(c, set, cat, &ctx)).collect();
    cards.sort_by(|a, b| b.score.cmp(&a.score));
    let (collected, missing): (Vec<&GalleryCard>, Vec<&GalleryCard>) = cards.iter().partition(|c| c.collected);

    let obs = observed.get(key);
    let completed = completed_obs(&collected, obs, &ctx);
    let (pool, lineup_len) = build_pool(&collected, completed.as_ref().map(|(o, _)| o).or(obs));
    let start_vec: Vec<usize> = (0..lineup_len).collect();
    let start = (lineup_len > 0).then_some(start_vec.as_slice());
    let candidates: Vec<Card> = pool.iter().map(|e| e.to_card(&ctx)).collect();
    let picked = gallery::optimise_from(&candidates, set.slots, start);
    let lineup_ids: BTreeSet<u64> = picked.iter().filter_map(|&i| match &pool[i] { Entry::Card(c, _) => Some(c.def_id), _ => None }).collect();
    let lineup: Vec<Card> = picked.iter().map(|&i| candidates[i].clone()).collect();
    let current = gallery::score(&lineup).total;

    let mut entries: Vec<ShoppingEntry> = missing
        .iter()
        .filter(|c| !c.rareflag.is_some_and(|r| SBC_ONLY_RARITIES.contains(&r)))
        .take(SHOPPING_CANDIDATES)
        .map(|c| {
            // A card bought on the transfer market is never first owner.
            let card = Card { first_owner: false, ..to_card(c, &ctx) };
            let best = if lineup.len() < set.slots {
                let mut l = lineup.clone();
                l.push(card);
                gallery::score(&l).total
            } else {
                (0..lineup.len())
                    .map(|i| {
                        let mut l = lineup.clone();
                        l[i] = card.clone();
                        gallery::score(&l).total
                    })
                    .max()
                    .unwrap_or(current)
            };
            ShoppingEntry { card: view(c, &ctx), gain: best.saturating_sub(current), got: false, got_source: None }
        })
        .collect();
    entries.sort_by(|a, b| b.gain.cmp(&a.gain).then(b.card.score.cmp(&a.card.score)));
    entries.truncate(SHOPPING_SHOWN);

    // Cards that arrived in the club since the set page was last read and are not placed yet.
    // Placed = identified in the in-game lineup; a fully identified lineup read after the card
    // arrived without it means the user chose not to place it, so the ✓ goes away.
    let placed: BTreeSet<u64> = obs.map(|o| o.identified.values().copied().collect()).unwrap_or_default();
    let fully_read = obs.is_some_and(|o| !o.slots.is_empty() && o.identified.len() == o.slots.len());
    let read_at = obs.and_then(|o| o.lineup_at).unwrap_or(0);
    // Probably placed: a read after the purchase shows a slot we couldn't name with exactly its
    // points (and rating, when read) – e.g. three 280 cards where only the count tells it went in.
    let probably_placed = |c: &GalleryCard| {
        obs.is_some_and(|o| {
            acquired.get(&c.def_id).is_some_and(|a| o.lineup_at.is_some_and(|t| t > a.at))
                && o.slots.iter().enumerate().any(|(i, s)| {
                    !o.identified.contains_key(&i) && s.points as u64 == c.score && s.rating.is_none_or(|r| Some(r as u64) == c.rating)
                })
        })
    };
    let mut got: Vec<ShoppingEntry> = collected
        .iter()
        .filter(|c| !placed.contains(&c.def_id) && !probably_placed(c))
        .filter(|c| acquired.get(&c.def_id).is_some_and(|a| !fully_read || a.at > read_at))
        .filter_map(|c| {
            // What the card adds: the best lineup with it against the best lineup without it.
            // Not in the best lineup = adds nothing here (it was bought for another set).
            let in_best = lineup_ids.contains(&c.def_id);
            if !in_best {
                return None;
            }
            let without: Vec<Card> = pool.iter().filter(|e| !matches!(e, Entry::Card(x, _) if x.def_id == c.def_id)).map(|e| e.to_card(&ctx)).collect();
            let best_without = gallery::score(&gallery::optimise_from(&without, set.slots, None).iter().map(|&i| without[i].clone()).collect::<Vec<_>>()).total;
            let gain = current.saturating_sub(best_without);
            (gain > 0).then(|| ShoppingEntry { card: view(c, &ctx), gain, got: true, got_source: acquired.get(&c.def_id).map(|a| a.source.clone()) })
        })
        .collect();
    got.sort_by(|a, b| b.gain.cmp(&a.gain));
    got.extend(entries);
    let mut entries = got;
    entries.truncate(SHOPPING_SHOWN);
    let best = best_selection(key, &collected, gallery, observed, set.slots, &ctx);
    Some(ShoppingList {
        key: set.key.clone(),
        name: set.name.clone(),
        slots: set.slots,
        // A lineup shown in-game is owned even when a purchase slipped past us.
        collected: collected.len().max(obs.filter(|o| o.verified).map_or(0, |o| o.slots.len())),
        missing: missing.len(),
        score: current,
        entries,
        best,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_few_changes_are_precise_swaps() {
        let c = |score: u64| gallery::Card { score, player: Some(score), ..Default::default() };
        // in-game: 100, 50, 10 (pool 0..3); the club also has 80 and 5
        let cards = vec![c(100), c(50), c(10), c(80), c(5)];
        // best of 3: 100, 80, 50 → the 10 goes out, the 80 comes in
        assert_eq!(precise_swaps(&cards, 3, &[0, 3, 1], 3), vec![(Some(2), 3, 70)]);
        // an open slot (4 slots, 3 placed): the 80 fills it, nothing goes out
        assert_eq!(precise_swaps(&cards, 3, &[0, 1, 2, 3], 4), vec![(None, 3, 80)]);
        // nothing to change, or more than PRECISE_SWAPS changes: no swaps
        assert!(precise_swaps(&cards, 3, &[0, 1, 2], 3).is_empty());
        let many: Vec<gallery::Card> = (1..=10).map(|i| c(i * 10)).collect();
        assert!(precise_swaps(&many, 5, &[5, 6, 7, 8, 9], 5).is_empty());
    }

    fn gc(def_id: u64, league: u64, team: u64, score: u64, collected: bool) -> GalleryCard {
        GalleryCard { def_id, league: Some(league), team: Some(team), score, collected, rating: Some(85), ..Default::default() }
    }

    #[test]
    fn a_selection_of_lookalike_cards_still_gets_swaps_without_swap_pages() {
        // 30 slots of 100 points that can't be told apart by name, and a 5,000 card outside them.
        let file = file();
        let pl = file.sets.iter().find(|s| s.name == "Premier League").unwrap();
        let league = pl.filter.league.unwrap();
        let mut g = BTreeMap::new();
        for i in 0..30 {
            g.insert(i, gc(i, league, 10 + i, 100, true));
        }
        g.insert(100, gc(100, league, 99, 5000, true));
        let (k, m) = (BTreeSet::new(), BTreeMap::new());
        let fo = FirstOwnerInfo { known: &k, manual: &m, scanned: &m, club_no: &EMPTY_SET };
        let ctx = Context { fo: &fo, links: &BTreeMap::new(), prices: &BTreeMap::new() };
        let lineup: Vec<Card> = (0..30).map(|i| to_card(&g[&i], &ctx)).collect();
        let total = gallery::score(&lineup).total as u32;
        let slot = crate::lineup::SlotObs { points: 100, rating: Some(85), position: None, first_owner: false, flag: None, uncertain: false };
        let obs = SetObs { slots: vec![slot; 30], verified: true, total: Some(total), ..Default::default() };
        let mut observed = BTreeMap::new();
        observed.insert(pl.key.clone(), obs);
        let s = set_summary(&pl.key, &g, &fo, &BTreeMap::new(), &observed, &BTreeMap::new(), &BTreeMap::new()).unwrap();
        assert_eq!(s.swaps.len(), 1, "{:?}", s.swaps);
        assert_eq!(s.swaps[0].into.def_id, 100);
        assert!(s.swaps[0].out.slot.is_some(), "the out card is shown as its slot – it was inferred, not read");
        // and the proof holds: the filled-in selection scores the game's total
        assert_eq!(ingame_model_total(&pl.key, &g, &fo, &BTreeMap::new(), &observed), Some(total as u64));
    }

    #[test]
    fn a_proof_names_only_slots_no_lookalike_could_fill() {
        // Two look-alike 830 cards of one club (unknown first owner) in slots with and without the
        // triangle, plus one unique 340 card: the total is the same either way round, so the proof
        // must not say which 830 card is first owner – only the 340 slot is certain.
        let file = file();
        let pl = file.sets.iter().find(|s| s.name == "Premier League").unwrap();
        let league = pl.filter.league.unwrap();
        let mut g = BTreeMap::new();
        g.insert(1, gc(1, league, 10, 830, true));
        g.insert(2, gc(2, league, 10, 830, true));
        g.insert(3, gc(3, league, 11, 340, true));
        let (k, m) = (BTreeSet::new(), BTreeMap::new());
        let fo = FirstOwnerInfo { known: &k, manual: &m, scanned: &m, club_no: &EMPTY_SET };
        let ctx = Context { fo: &fo, links: &BTreeMap::new(), prices: &BTreeMap::new() };
        let slot = |points: u32, first_owner: bool| crate::lineup::SlotObs { points, rating: Some(85), position: None, first_owner, flag: None, uncertain: false };
        let slots = vec![slot(830, true), slot(830, false), slot(340, false)];
        let cards = vec![in_slot(&g[&1], true, &ctx), in_slot(&g[&2], false, &ctx), in_slot(&g[&3], false, &ctx)];
        let total = gallery::score(&cards).total as u32;
        let obs = SetObs { slots, verified: true, total: Some(total), ..Default::default() };
        let ids = prove_selection(&pl.key, &g, &fo, &BTreeMap::new(), &obs).expect("proven");
        assert_eq!(ids.get(&2), Some(&3), "the unique card is named");
        assert!(!ids.contains_key(&0) && !ids.contains_key(&1), "look-alikes are not named: {ids:?}");
    }

    fn find<'a>(cats: &'a [CategorySummary], name: &str) -> &'a SetSummary {
        cats.iter().flat_map(|c| &c.sets).find(|s| s.name == name).unwrap()
    }

    /// Every set with a read selection in the real snapshot: is it completed (and proven), and which
    /// swaps come out – no Swap Player paging. `FCT_REAL_SNAPSHOT=… cargo test --lib real_selections -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_selections_complete_without_swap_pages() {
        let store = crate::store::Store::copy_of_user_data();
        let snap = &store.snapshot;
        let fo = FirstOwnerInfo { known: &snap.first_owner, manual: &snap.first_owner_manual, scanned: &snap.first_owner_scanned, club_no: &snap.first_owner_club_no };
        let f = file();
        let (mut proven, mut likely, mut none, mut read) = (0, 0, 0, 0);
        for set in &f.sets {
            let Some(obs) = snap.set_obs.get(&set.key).filter(|o| o.verified && !o.slots.is_empty()) else { continue };
            let cat = f.categories.iter().find(|c| c.key == set.category).unwrap();
            let ctx = Context { fo: &fo, links: &snap.team_links, prices: &snap.prices };
            let collected: Vec<&GalleryCard> = snap.gallery.values().filter(|c| c.collected && matches(c, set, cat, &ctx)).collect();
            let t = std::time::Instant::now();
            let how = complete_selection(&collected, obs, &ctx).map(|(_, h)| h);
            match how { Some(Completion::Proven) => proven += 1, Some(Completion::Likely) => likely += 1, Some(Completion::Read) => read += 1, None => none += 1 }
            let s = set_summary(&set.key, &snap.gallery, &fo, &snap.team_links, &snap.set_obs, &snap.prices, &snap.set_list).unwrap();
            let swaps: Vec<String> = s.swaps.iter().map(|w| format!("{} {}→{} {}", w.out.name.clone().unwrap_or(format!("slot{} {}", w.out.slot.map_or(0, |x| x + 1), w.out.rating.unwrap_or(0))), w.out.score, w.into.name.clone().unwrap_or_default(), w.into.score)).collect();
            println!("{:22} slots {:>2} read-by-name {:>2} → {:?} in {:?} | in-game {:?} best {} | {} swaps: {}", set.name, obs.slots.len(), obs.identified.len(), how, t.elapsed(), obs.total, s.best_model, s.swaps.len(), swaps.join(", "));
        }
        println!("== read {read}, proven {proven}, likely {likely}, none {none}");
        // model vs game for fully read selections: base / bonus / per-tag, slot marks for unknown first owners
        for set in &f.sets {
            let Some(obs) = snap.set_obs.get(&set.key).filter(|o| o.verified && !o.slots.is_empty() && o.identified.len() == o.slots.len()) else { continue };
            let Some(total) = obs.total else { continue };
            let ctx = Context { fo: &fo, links: &snap.team_links, prices: &snap.prices };
            let cards: Vec<Card> = (0..obs.slots.len()).filter_map(|i| {
                let c = snap.gallery.get(obs.identified.get(&i)?)?;
                let mut card = to_card(c, &ctx);
                if ctx.fo.status(c) == FirstOwnerStatus::Unknown { card.first_owner = obs.slots[i].first_owner; }
                Some(card)
            }).collect();
            let sc = gallery::score(&cards);
            let fo_model = cards.iter().filter(|c| c.first_owner).count();
            let fo_slots = obs.slots.iter().filter(|s| s.first_owner).count();
            println!("MODEL {:18} game {total} (base {:?} bonus {:?}) model {} (base {} bonus {}) · first owner model {fo_model} / slots {fo_slots} · tags {}", set.name, obs.base, obs.bonus, sc.total, sc.base, sc.bonus,
                sc.tags.iter().filter(|t| t.count > 0).map(|t| format!("{}×{}={}{}", t.name, t.count, t.bonus, if t.counts { "" } else { "(capped)" })).collect::<Vec<_>>().join(" "));
        }
    }

    /// The side panel's best selection per read set: `cargo test --release -- --ignored best_selection_on_real`.
    #[test]
    #[ignore]
    fn best_selection_on_real_snapshot() {
        let mut store = crate::store::Store::copy_of_user_data();
        let t = std::time::Instant::now();
        let n = crate::tracking::reprove_all(&mut store);
        println!("reprove_all: {n} fact(s) changed in {:?}", t.elapsed());
        {
            let snap = &store.snapshot;
            let fo = FirstOwnerInfo { known: &snap.first_owner, manual: &snap.first_owner_manual, scanned: &snap.first_owner_scanned, club_no: &snap.first_owner_club_no };
            let ctx = Context { fo: &fo, links: &snap.team_links, prices: &snap.prices };
            let f = file();
            let set = f.sets.iter().find(|s| s.name == "Premier League").unwrap();
            let cat = f.categories.iter().find(|c| c.key == set.category).unwrap();
            let collected: Vec<&GalleryCard> = snap.gallery.values().filter(|c| c.collected && matches(c, set, cat, &ctx)).collect();
            let obs = &snap.set_obs[&set.key];
            let t = std::time::Instant::now();
            let how = complete_selection_certain(&collected, obs, &ctx).map(|(_, h, c)| (h, c.len()));
            println!("PL complete_selection_certain {:?} in {:?}", how, t.elapsed());
            let t = std::time::Instant::now();
            let (pool, len) = build_pool(&collected, completed_obs(&collected, Some(obs), &ctx).as_ref().map(|(o, _)| o));
            let cands: Vec<Card> = pool.iter().map(|e| e.to_card(&ctx)).collect();
            let st: Vec<usize> = (0..len).collect();
            let _ = gallery::optimise_from(&cands, set.slots, Some(&st));
            println!("PL optimise ({} cards) in {:?}", cands.len(), t.elapsed());
        }
        let snap = &store.snapshot;
        let fo = FirstOwnerInfo { known: &snap.first_owner, manual: &snap.first_owner_manual, scanned: &snap.first_owner_scanned, club_no: &snap.first_owner_club_no };
        for set in file().sets.iter().filter(|s| snap.set_obs.get(&s.key).is_some_and(|o| o.verified)) {
            let t = std::time::Instant::now();
            let Some(list) = shopping_list(&set.key, &snap.gallery, &fo, &snap.team_links, &snap.set_obs, &snap.prices, &snap.acquired) else { continue };
            let Some(b) = list.best else { continue };
            let new: Vec<String> = b.cards.iter().filter(|c| c.in_selection == Some(false)).map(|c| format!("{} {}", c.card.name.clone().unwrap_or_default(), c.card.score)).collect();
            let o = &snap.set_obs[&set.key];
            println!("   model of the in-game selection {:?} (identified {}/{}, base {:?} bonus {:?})", ingame_model_total(&set.key, &snap.gallery, &fo, &snap.team_links, &snap.set_obs), o.identified.len(), o.slots.len(), o.base, o.bonus);
            println!("{:20} best {} in-game {:?} gain {:?} · {} cards ({} known in, put in: {}) in {:?}", set.name, b.total, b.ingame, b.gain, b.cards.len(), b.cards.iter().filter(|c| c.in_selection == Some(true)).count(), new.join(", "), t.elapsed());
            for sw in &b.swaps {
                println!("    swap: {} out → {} in · {:+}", sw.out.as_ref().and_then(|c| c.name.clone()).unwrap_or("open slot".into()), sw.into.name.clone().unwrap_or_default(), sw.gain);
            }
        }
    }

    /// Timing check against the developer's real snapshot: `cargo test --release -- --ignored`.
    #[test]
    #[ignore]
    fn overview_speed_on_real_snapshot() {
        let store = crate::store::Store::copy_of_user_data();
        let start = std::time::Instant::now();
        let snap = &store.snapshot;
        let fo = FirstOwnerInfo { known: &snap.first_owner, manual: &snap.first_owner_manual, scanned: &snap.first_owner_scanned, club_no: &snap.first_owner_club_no };
        let cats = overview(&snap.gallery, &fo, &snap.team_links, &snap.set_obs, &snap.prices, &snap.set_list);
        let sets: usize = cats.iter().map(|c| c.sets.len()).sum();
        println!("overview: {sets} sets, {} cards in {:?}", store.snapshot.gallery.len(), start.elapsed());
        let collected = store.snapshot.gallery.values().filter(|c| c.collected).count();
        println!("collected cards: {collected}, first owner: {}", store.snapshot.first_owner.len());
        let t = std::time::Instant::now();
        let pl_key = file().sets.iter().find(|s| s.name == "Premier League").unwrap().key.clone();
        let list = shopping_list(&pl_key, &snap.gallery, &fo, &snap.team_links, &snap.set_obs, &snap.prices, &snap.acquired).unwrap();
        println!("PL shopping list in {:?}: {:?}", t.elapsed(), list.entries.iter().take(6).map(|e| (e.card.name.clone(), e.card.score, e.gain)).collect::<Vec<_>>());
        let pl = find(&cats, "Premier League");
        println!("PL best {} in-game {:?}", pl.best_model, pl.ingame.as_ref().and_then(|g| g.total));
        for name in ["Premier League", "Barclays WSL", "TOTW", "Heroes", "Holographics", "Starter Set", "Squad Foundations", "Season 1", "Arsenal", "Birmingham City"] {
            let s = find(&cats, name);
            println!(
                "{name:18} {:>3}/{:<3} slots {:>2} complete {:5} score {:>9} grade {:?} tokens {}/{}",
                s.collected, s.total, s.slots, s.complete, s.score,
                s.grade.as_ref().and_then(|g| g.grade.clone()), s.tokens, s.max_tokens
            );
        }
    }

    #[test]
    fn shopping_list_ranks_by_gain_and_never_counts_first_owner() {
        let file = file();
        let pl = file.sets.iter().find(|s| s.name == "Premier League").unwrap();
        let league = pl.filter.league.unwrap();
        let mut g = BTreeMap::new();
        for i in 0..30 {
            g.insert(i, gc(i, league, 10, 100, true));
        }
        g.insert(100, gc(100, league, 10, 5000, false));
        g.insert(101, gc(101, league, 10, 50, false));
        let (k, mut m) = (BTreeSet::new(), BTreeMap::new());
        m.insert(100, true); // a manual mark must not make a bought card first owner
        let list = shopping_list(&pl.key, &g, &FirstOwnerInfo { known: &k, manual: &m, scanned: &m, club_no: &EMPTY_SET }, &BTreeMap::new(), &BTreeMap::new(), &BTreeMap::new(), &BTreeMap::new()).unwrap();
        assert_eq!(list.entries[0].card.def_id, 100);
        // 4,900 base (replaces a 100) plus the tag bonus on it – but no first-owner bonus.
        let gain = list.entries[0].gain;
        assert!(gain > 4900 && gain < 4900 * 2, "{gain}");
        assert!(list.entries[1].gain < 100);
    }

    #[test]
    fn sbc_only_cards_are_never_a_buy() {
        let file = file();
        let pl = file.sets.iter().find(|s| s.name == "Premier League").unwrap();
        let league = pl.filter.league.unwrap();
        let mut g = BTreeMap::new();
        for i in 0..30 {
            g.insert(i, gc(i, league, 10, 100, true));
        }
        g.insert(100, GalleryCard { rareflag: Some(43), ..gc(100, league, 10, 9000, false) }); // POTM
        g.insert(101, gc(101, league, 10, 5000, false));
        let (k, m) = (BTreeSet::new(), BTreeMap::new());
        let fo = FirstOwnerInfo { known: &k, manual: &m, scanned: &m, club_no: &EMPTY_SET };
        let list = shopping_list(&pl.key, &g, &fo, &BTreeMap::new(), &BTreeMap::new(), &BTreeMap::new(), &BTreeMap::new()).unwrap();
        assert!(!list.entries.iter().any(|e| e.card.def_id == 100));
        assert_eq!(list.entries[0].card.def_id, 101);
    }

    #[test]
    fn a_bought_card_keeps_its_check_until_the_set_page_shows_it_placed() {
        let file = file();
        let pl = file.sets.iter().find(|s| s.name == "Premier League").unwrap();
        let league = pl.filter.league.unwrap();
        let mut g = BTreeMap::new();
        for i in 0..30 {
            g.insert(i, gc(i, league, 10, 100, true));
        }
        g.insert(100, gc(100, league, 10, 5000, true)); // just bought
        let (k, m) = (BTreeSet::new(), BTreeMap::new());
        let fo = FirstOwnerInfo { known: &k, manual: &m, scanned: &m, club_no: &EMPTY_SET };
        let mut acquired = BTreeMap::new();
        acquired.insert(100, Acquired { source: "bought".into(), at: 2_000 });
        let list = |obs: &BTreeMap<String, SetObs>, acq: &BTreeMap<u64, Acquired>| {
            shopping_list(&pl.key, &g, &fo, &BTreeMap::new(), obs, &BTreeMap::new(), acq).unwrap()
        };
        let first = list(&BTreeMap::new(), &acquired);
        assert!(first.entries[0].got && first.entries[0].card.def_id == 100, "{:?}", first.entries[0]);
        assert!(first.entries[0].gain > 4_000);
        // Not bought recently: no check.
        assert!(!list(&BTreeMap::new(), &BTreeMap::new()).entries.iter().any(|e| e.got));
        // The set page shows it placed (fully identified lineup with card 100): gone.
        let slots: Vec<crate::lineup::SlotObs> = (0..30).map(|_| crate::lineup::SlotObs { points: 100, rating: None, position: None, first_owner: false, flag: None, uncertain: false }).collect();
        let mut identified: BTreeMap<usize, u64> = (0..29).map(|i| (i as usize, i)).collect();
        identified.insert(29, 100);
        let mut obs = BTreeMap::new();
        obs.insert(pl.key.clone(), SetObs { slots, verified: true, identified, lineup_at: Some(3_000), ..Default::default() });
        assert!(!list(&obs, &acquired).entries.iter().any(|e| e.got));
    }

    #[test]
    fn titles_from_the_game_find_their_set() {
        let name = |t: &str| find_set_by_title(t).map(|s| s.name);
        assert_eq!(name("Premier League S)").as_deref(), Some("Premier League"));
        assert_eq!(name("O Manchester City").as_deref(), Some("Manchester City"));
        assert_eq!(name("g Serie A Enilive").as_deref(), Some("Serie A Enilive"));
        assert_eq!(name("Arsenal").as_deref(), Some("Arsenal"));
        assert_eq!(name("Brighton & Hove Albion").as_deref(), Some("Brighton & Hove Albion"));
        assert!(find_set_by_title("Gallery Level 6").is_none());
        // Category tiles (OCR line order / dropped digits).
        assert_eq!(name("Serie Enilive A").as_deref(), Some("Serie A Enilive"));
        assert_eq!(name("Ligue McDonald's").as_deref(), Some("Ligue 1 McDonald's"));
        assert_eq!(name("Villa Aston").as_deref(), Some("Aston Villa"));
        assert_eq!(name("Frauen- Bundesliga").as_deref(), Some("Frauen-Bundesliga"));
        assert_eq!(name("Season").as_deref(), Some("Season 1"));
        assert_eq!(name("Bundesliga").as_deref(), Some("Bundesliga"));
        assert_eq!(name("Frauen-Bundesliga").as_deref(), Some("Frauen-Bundesliga"));
    }

    #[test]
    fn file_has_128_sets_with_unique_keys_and_ladders() {
        let f = file();
        assert_eq!(f.sets.len(), 128);
        let keys: BTreeSet<&str> = f.sets.iter().map(|x| x.key.as_str()).collect();
        assert_eq!(keys.len(), 128);
        assert!(f.sets.iter().all(|s| s.grades.len() == 5 && f.categories.iter().any(|c| c.key == s.category)));
    }

    #[test]
    fn birmingham_ladder_matches_in_game_rewards_screen() {
        let f = file();
        let b = f.sets.iter().find(|s| s.name == "Birmingham City").unwrap();
        let scores: Vec<u64> = b.grades.iter().map(|g| g.score).collect();
        let tokens: Vec<u64> = b.grades.iter().map(|g| g.tokens).collect();
        assert_eq!((scores, tokens), (vec![10, 300, 500, 700, 1_000], vec![0, 0, 5, 8, 15]));
        assert!(b.verified);
    }

    #[test]
    fn league_set_counts_and_is_ungraded_until_complete() {
        let mut g = BTreeMap::new();
        for (id, score, col) in [(1, 37_500, false), (2, 14_000, true), (3, 8_300, true), (4, 100, false)] {
            g.insert(id, gc(id, 2216, 116009, score, col));
        }
        g.insert(9, gc(9, 13, 1, 50_000, true)); // other league
        let (k, m) = (BTreeSet::new(), BTreeMap::new());
        let cats = overview(&g, &FirstOwnerInfo { known: &k, manual: &m, scanned: &m, club_no: &EMPTY_SET }, &BTreeMap::new(), &BTreeMap::new(), &BTreeMap::new(), &BTreeMap::new());
        let wsl = find(&cats, "Barclays WSL");
        assert_eq!((wsl.total, wsl.collected, wsl.missing, wsl.slots), (4, 2, 2, 30));
        assert_eq!(wsl.base, 22_300);
        assert_eq!(wsl.top_missing[0].score, 37_500);
        assert!(!wsl.complete && wsl.grade.is_none() && wsl.tokens == 0);
    }

    #[test]
    fn club_set_includes_linked_team_and_earns_cumulative_tokens() {
        // Birmingham City (badge 88) is women-only in the PL/WSL category: 15 slots, S at 1,000.
        let women = 116_999;
        let links = BTreeMap::from([(88, vec![women]), (women, vec![88])]);
        let mut g = BTreeMap::new();
        for i in 0..15 {
            g.insert(i, gc(i, 2216, women, 100, true)); // 15 × 100 = 1,500 base → S
        }
        g.insert(99, gc(99, 14, 88, 5_000, true)); // Birmingham men in the Championship – not in this set
        let (k, m) = (BTreeSet::new(), BTreeMap::new());
        let cats = overview(&g, &FirstOwnerInfo { known: &k, manual: &m, scanned: &m, club_no: &EMPTY_SET }, &links, &BTreeMap::new(), &BTreeMap::new(), &BTreeMap::new());
        let b = find(&cats, "Birmingham City");
        assert_eq!((b.total, b.slots), (15, 15));
        assert!(b.complete);
        assert_eq!(b.grade.as_ref().unwrap().grade.as_deref(), Some("S"));
        assert_eq!((b.tokens, b.max_tokens), (28, 28)); // 5 + 8 + 15
    }

    #[test]
    fn unknown_first_owners_count_as_not_first_owner_without_a_range() {
        // 15-slot women-only club (Birmingham), 15 collected cards: one known first owner, one
        // marked "no", the rest unknown. Unknown = not first owner: the score is the score (no
        // "up to", no check list – user decision 2026-10-17).
        let women = 116_999;
        let links = BTreeMap::from([(88, vec![women])]);
        let mut g = BTreeMap::new();
        for i in 0..15 {
            g.insert(i, gc(i, 2216, women, 100 + i * 10, true));
        }
        let known = BTreeSet::from([0]);
        let manual = BTreeMap::from([(1, false)]);
        let none = BTreeMap::new();
        let fo = FirstOwnerInfo { known: &known, manual: &manual, scanned: &none, club_no: &EMPTY_SET };
        assert_eq!(fo.status(&g[&0]), FirstOwnerStatus::Known);
        assert_eq!(fo.status(&g[&1]), FirstOwnerStatus::ManualNo);
        assert_eq!(fo.status(&g[&2]), FirstOwnerStatus::Unknown);

        let cats = overview(&g, &fo, &links, &BTreeMap::new(), &BTreeMap::new(), &BTreeMap::new());
        let b = find(&cats, "Birmingham City");
        // only the known card counts as first owner (1 < 5: no First Owner tag at all)
        assert!(b.tags.iter().all(|t| t.name != "First Owner" || t.bonus == 0));
        let model = gallery::score(&g.values().map(|c| to_card(c, &Context { fo: &fo, links: &links, prices: &BTreeMap::new() })).collect::<Vec<_>>());
        assert_eq!(b.score, model.total);
        // EA's owners == 1 beats a "no" read (e.g. inferred from a purchase)
        let no = BTreeMap::from([(0, false)]);
        let fo2 = FirstOwnerInfo { known: &known, manual: &none, scanned: &no, club_no: &EMPTY_SET };
        assert!(fo2.known_or_manual(0));
        assert_eq!(fo2.status(&g[&0]), FirstOwnerStatus::Known);
    }

    #[test]
    fn rarity_sets_sync_by_rarity_and_every_set_is_tracked() {
        let filters = sync_filters();
        assert!(filters.iter().any(|(_, f)| f["rarity"] == 3)); // TOTW
        assert!(filters.iter().any(|(_, f)| f["rarity"] == 71)); // Season 1 includes Future Stars
        assert!(filters.iter().any(|(_, f)| f["league"] == 13));
        let (k, m) = (BTreeSet::new(), BTreeMap::new());
        let cats = overview(&BTreeMap::new(), &FirstOwnerInfo { known: &k, manual: &m, scanned: &m, club_no: &EMPTY_SET }, &BTreeMap::new(), &BTreeMap::new(), &BTreeMap::new(), &BTreeMap::new());
        assert!(cats.iter().flat_map(|c| &c.sets).all(|s| s.tracked)); // all 128 sets tracked
        assert!(!filters.iter().any(|(_, f)| f["rarity"] == 0 || f["rarity"] == 1)); // no base-card search
    }
}
