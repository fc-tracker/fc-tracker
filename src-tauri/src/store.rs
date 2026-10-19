//! Local snapshot of the club, built from the responses the Web App fetches itself.
//! Everything is stored only on the user's machine (the app data folder).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub use crate::types::{Acquired, GalleryCard, Item, ListObs, Price, SetObs};
use crate::sync_data::{collect_items, endpoint_key, is_card_database_search, parse_gallery_card, raw_concept_cards, strip_query, CLUB_READ_PREFIX, GALLERY_PREFIX};

const MAX_RAW_CAPTURES: usize = 200;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

const SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Snapshot {
    #[serde(default)]
    pub schema: u32,
    pub synced_at: Option<u64>,
    pub items: BTreeMap<u64, Item>,
    /// Endpoint path → times seen. Used to map the Web App's calls.
    pub endpoints: BTreeMap<String, u64>,
    /// Card definitions (assetId) the user has ever owned as first owner. Never pruned:
    /// the Gallery "First Owner" bonus still counts after the card is sold.
    #[serde(default)]
    pub first_owner: BTreeSet<u64>,
    /// User overrides per card definition: true = first owner, false = not (beats everything).
    #[serde(default)]
    pub first_owner_manual: BTreeMap<u64, bool>,
    /// Card definitions seen in the club only as bought copies (`owners` > 1): not first owner,
    /// unless the in-game triangle says otherwise.
    #[serde(default)]
    pub first_owner_club_no: BTreeSet<u64>,
    /// Saved club responses were replayed for `owners` by card definition id (special cards
    /// were keyed by the base player's asset id before).
    #[serde(default)]
    pub owners_replayed: bool,
    /// Read from the in-game Gallery (Swap Player selector, first-owner triangle) – the truth.
    #[serde(default)]
    pub first_owner_scanned: BTreeMap<u64, bool>,
    /// Bumped on every first-owner / in-game observation change (cache key).
    #[serde(default)]
    pub first_owner_version: u64,
    /// What the in-game Gallery showed per set (set key → observation).
    #[serde(default)]
    pub set_obs: BTreeMap<String, SetObs>,
    /// Card database entries for Gallery sets (definitionId → card), incl. EA's `isCollected`.
    #[serde(default)]
    pub gallery: BTreeMap<u64, GalleryCard>,
    #[serde(default)]
    pub gallery_synced_at: Option<u64>,
    /// Men's ↔ women's team links from EA (`chemistry/teamlinks`), e.g. 1 ↔ 116009 (Arsenal).
    #[serde(default)]
    pub team_links: BTreeMap<u64, Vec<u64>>,
    /// Prices per card definition, only from data the Web App loads anyway (never searched by
    /// us): EA's `marketAverage` on club items and on market results of the user's own searches,
    /// plus the lowest Buy Now in those results. The Web App uses the account's platform market,
    /// so a PC account sees PC prices.
    #[serde(default)]
    pub prices: BTreeMap<u64, Price>,
    /// What the in-game category pages show per set (score, or filled/slots) – every set's real
    /// score without opening it.
    #[serde(default)]
    pub set_list: BTreeMap<String, ListObs>,
    /// Gallery → Summary as last seen in-game.
    #[serde(default)]
    pub summary: Option<SummaryObs>,
    /// Flag colours per nation id, learned from cards identified for certain on set pages.
    #[serde(default)]
    pub flags: BTreeMap<u64, FlagSample>,
    /// Nation → flag colours on New Items / Swap Player cards (learned from cards named for certain).
    #[serde(default)]
    pub card_flags: BTreeMap<u64, FlagSample>,
    /// Cards seen on a "New Items" screen and where they first came from ("pack" | "bought").
    /// A bought card left in Unassigned shows up again after the next pack – it keeps "bought".
    #[serde(default)]
    pub acquired: BTreeMap<u64, Acquired>,
    /// Version of the first-owner triangle detector the scanned facts come from.
    #[serde(default)]
    pub fo_detector: u32,
}

/// 3 = triangle template at the fixed marker spot (2026-10-13). Version 1 read every special card
/// as first owner, version 2 missed triangles on inform/holo cards partly covered by player art.
/// 4 = holographic cards: their triangle is drawn in holo colours whether or not the user is the
/// first owner (Lucy Bronze, Dunk, Mijnans – user, 2026-10-13), so it is no fact for them.
const FO_DETECTOR: u32 = 4;

/// How long a card's first source is remembered.
const ACQUIRED_KEEP_MS: u64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FlagSample {
    pub sig: Vec<f32>,
    pub n: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SummaryObs {
    #[serde(flatten)]
    pub summary: crate::scan::GallerySummary,
    pub at: u64,
}

/// Observations of the same card within this window are one price check (narrowing searches).
const PRICE_SESSION_MS: u64 = 15 * 60 * 1000;

#[derive(Debug, Clone, Serialize)]
pub struct Summary {
    pub synced_at: Option<u64>,
    pub item_count: usize,
    pub player_count: usize,
    pub endpoint_count: usize,
    pub sync_active: bool,
}

/// Brings a snapshot written by an older version up to date (in place, idempotent).
pub(crate) fn migrate(snapshot: &mut Snapshot) {
    if snapshot.schema < SCHEMA_VERSION {
        // Schema 1 stored card-database search results as club items; the next sync refills.
        // First-owner marks may come from those too; the club read rebuilds them.
        snapshot.items.clear();
        snapshot.first_owner.clear();
        snapshot.schema = SCHEMA_VERSION;
    }
    if snapshot.fo_detector < 3 {
        // Facts for special cards (TOTW, Heroes, Holo …) came from the old detector: read them
        // again. Gold/silver/bronze facts were right and stay; packed facts are re-added.
        let special: Vec<u64> = snapshot.gallery.values().filter(|c| c.rareflag.is_some_and(|r| r > 1)).map(|c| c.def_id).collect();
        for id in &special {
            if snapshot.acquired.get(id).is_none_or(|a| a.source != "pack") {
                snapshot.first_owner_scanned.remove(id);
            }
        }
        // Lineups holding a special card carry old triangle reads: read them again on the next
        // visit. Cards seen on Swap Player stay (they never depended on the triangle).
        for obs in snapshot.set_obs.values_mut() {
            if obs.identified.values().any(|id| special.contains(id)) {
                obs.slots.clear();
                obs.identified.clear();
                obs.verified = false;
                obs.ambiguous = 0;
            }
        }
        snapshot.first_owner_version += 1;
    }
    if snapshot.fo_detector < FO_DETECTOR {
        let holo: Vec<u64> = snapshot.gallery.values().filter(|c| c.holo).map(|c| c.def_id).collect();
        for id in &holo {
            if snapshot.acquired.get(id).is_none_or(|a| a.source != "pack") {
                snapshot.first_owner_scanned.remove(id);
            }
        }
        snapshot.fo_detector = FO_DETECTOR;
        snapshot.first_owner_version += 1;
    }
}

pub struct Store {
    dir: PathBuf,
    pub snapshot: Snapshot,
    pub sync_active: bool,
    /// Gallery cards that turned collected during this sync without the tracker having seen them
    /// arrive in-game (no pack / purchase read) – reported when the sync ends.
    sync_missed: Vec<u64>,
    /// The user entered Ultimate Team during a sync: the extension closes the Web App tab.
    pub sync_abort: bool,
    /// Why the running sync can't go on (`not_signed_in`, `webapp_not_ready`) – the user must act.
    pub sync_blocked: Option<String>,
    /// Cards EA's own card database reported as never owned during the running sync (raw
    /// responses only – the in-page entities can say false wrongly).
    pub sync_never_owned: BTreeMap<u64, u64>,
    /// Gallery searches (league / rarity) read so far in the running sync – for the progress notice.
    pub sync_sets_read: BTreeSet<String>,
    /// Set when a full club read (`fct://club/...`) starts; on finish, items not seen since
    /// then are removed (sold, quick-sold or used in SBCs).
    club_read_started: Option<u64>,
    /// Bumped on every change (cache key for derived data like the Gallery overview).
    revision: std::sync::atomic::AtomicU64,
    /// The set the user works on (in-game page or overlay pick): breaks name ties on New Items.
    pub focus_set: Option<String>,
    /// Something changed since the last save (set by observations that skip saving themselves).
    pub dirty: bool,
    /// A card on "Bidding Options": bought once the purchase is confirmed (success dialog, the
    /// coins dropping by its price, or New Items). Not saved – minutes at most.
    pub pending_buy: Option<PendingBuy>,
    /// The coin balance last read (top-right of Ultimate Team screens).
    pub last_coins: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct PendingBuy {
    pub def_id: u64,
    pub price: Option<u32>,
    pub coins_before: Option<u32>,
    pub at: std::time::Instant,
}

impl PendingBuy {
    /// A purchase is confirmed within this time or forgotten.
    pub const KEEP: std::time::Duration = std::time::Duration::from_secs(180);
}

impl Item {
    /// Fills in fields the new observation lacks from the previous one, so a sparse
    /// response (e.g. raw EA JSON without names) does not erase richer data.
    fn merged_with(mut self, old: &Item) -> Item {
        self.asset_id = self.asset_id.or(old.asset_id);
        self.rating = self.rating.or(old.rating);
        self.position = self.position.take().or_else(|| old.position.clone());
        self.item_type = self.item_type.take().or_else(|| old.item_type.clone());
        self.untradeable = self.untradeable.or(old.untradeable);
        self.name = self.name.take().or_else(|| old.name.clone());
        self.grading_score = self.grading_score.or(old.grading_score);
        self.league_id = self.league_id.or(old.league_id);
        self.team_id = self.team_id.or(old.team_id);
        self.nation_id = self.nation_id.or(old.nation_id);
        self.rareflag = self.rareflag.or(old.rareflag);
        self
    }
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(dir.join("captures"));
        let path = dir.join("snapshot.json");
        let mut snapshot: Snapshot = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| {
                // Never overwrite data we couldn't read: keep it aside for recovery.
                let aside = dir.join(format!("snapshot.unreadable-{}.json", now_ms()));
                let _ = fs::rename(&path, &aside);
                crate::tracking::log(&dir, &format!("startup: snapshot.json could not be read, kept as {}", aside.display()));
                Snapshot::default()
            }),
            Err(_) => Snapshot::default(),
        };
        migrate(&mut snapshot);
        // A copy written while the app ran from a packaged (MSIX) app joins the real data (it is
        // migrated on its own first, so neither side's versions can re-run old migrations).
        let absorbed = crate::merge::absorb_redirected(&dir, &mut snapshot);
        let mut store = Self { dir, snapshot, sync_active: false, sync_missed: Vec::new(), sync_abort: false, sync_blocked: None, sync_never_owned: BTreeMap::new(), sync_sets_read: BTreeSet::new(), club_read_started: None, revision: Default::default(), focus_set: None, dirty: false, pending_buy: None, last_coins: None };
        if store.replay_card_database_captures() > 0 || !absorbed.is_empty() {
            store.save();
        }
        for copy in &absorbed {
            crate::tracking::log(&store.dir, &format!("startup: merged the data kept in {} (app started from a packaged app)", copy.display()));
        }
        store
    }

/// Tests on the user's data work on a copy in a temp folder – never on the app folder itself
    /// (from a packaged shell a write there would start a second, redirected data set).
    /// `FCT_REAL_SNAPSHOT` picks the snapshot file; default: the app folder's.
    #[cfg(test)]
    pub fn copy_of_user_data() -> Self {
        let src = std::env::var("FCT_REAL_SNAPSHOT").map(PathBuf::from).unwrap_or_else(|_| {
            PathBuf::from(std::env::var("APPDATA").unwrap()).join("dk.fctracker.app").join("snapshot.json")
        });
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = std::env::temp_dir().join(format!("fct-copy-{}-{}-{n}", now_ms(), std::process::id()));
        fs::create_dir_all(tmp.join("captures")).unwrap();
        // the saved raw responses too: startup replays them (as in the app)
        if let Ok(rd) = fs::read_dir(src.with_file_name("captures")) {
            for e in rd.filter_map(|e| e.ok()) {
                let _ = fs::copy(e.path(), tmp.join("captures").join(e.file_name()));
            }
        }
        fs::copy(src, tmp.join("snapshot.json")).unwrap();
        Self::load(tmp)
    }

    pub fn dir(&self) -> &PathBuf {
        &self.dir
    }

    pub fn revision(&self) -> u64 {
        self.revision.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn bump(&self) {
        self.revision.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    /// Stores the lowest Buy Now price per card from one transfer market response.
    fn merge_prices(&mut self, body: &Value, now: u64) -> usize {
        let mut seen: BTreeMap<u64, (u64, u32)> = BTreeMap::new();
        for a in body.get("auctionInfo").and_then(Value::as_array).into_iter().flatten() {
            let item = a.get("itemData").unwrap_or(&Value::Null);
            let id = item.get("resourceId").or_else(|| item.get("assetId")).and_then(Value::as_u64);
            let bin = a.get("buyNowPrice").and_then(Value::as_u64).filter(|&b| b > 0);
            if let (Some(id), Some(bin)) = (id, bin) {
                let e = seen.entry(id).or_insert((bin, 0));
                e.0 = e.0.min(bin);
                e.1 += 1;
            }
        }
        for (&id, &(bin, listings)) in &seen {
            let price = match self.snapshot.prices.get(&id) {
                // A narrowing search in the same price check can only find cheaper listings.
                Some(old) if now.saturating_sub(old.at) < PRICE_SESSION_MS && old.bin > 0 => {
                    Price { bin: old.bin.min(bin), listings: old.listings.max(listings), at: now, avg: old.avg }
                }
                Some(old) => Price { bin, listings, at: now, avg: old.avg },
                None => Price { bin, listings, at: now, avg: None },
            };
            self.snapshot.prices.insert(id, price);
        }
        seen.len()
    }

    /// EA's `marketAverage` from any item in a response (club items, market results).
    fn merge_market_averages(&mut self, body: &Value, now: u64) {
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
        let mut found = Vec::new();
        walk(body, &mut found);
        for (id, avg) in found {
            let p = self.snapshot.prices.entry(id).or_insert(Price { bin: 0, listings: 0, at: now, avg: None });
            p.avg = Some(avg);
            p.at = now;
        }
    }

    /// The user's explicit choice from a card's menu. It replaces an earlier in-game read of
    /// that card too, so it shows at once; the next in-game read (the triangle) is the truth again.
    pub fn set_first_owner(&mut self, def_id: u64, value: Option<bool>) {
        match value {
            Some(v) => self.snapshot.first_owner_manual.insert(def_id, v),
            None => self.snapshot.first_owner_manual.remove(&def_id),
        };
        self.snapshot.first_owner_scanned.remove(&def_id);
        self.snapshot.first_owner_version += 1;
        self.save();
    }

    /// Records a set page. Only a read verified against Base Grade replaces what we know.
    /// The box (cards seen on Swap Player) is kept across visits; only the points values that
    /// entered the lineup since the last verified read are taken out of it – a card with those
    /// points may have come from the box. Flags tell same-points swaps apart (another nation in
    /// a slot group). OCR extras (rating/position) never touch the box.
    pub fn observe_set_page(
        &mut self,
        key: &str,
        slots: Vec<crate::lineup::SlotObs>,
        verified: bool,
        total: Option<u32>,
        base: Option<u32>,
        bonus: Option<u32>,
    ) {
        let obs = self.snapshot.set_obs.entry(key.to_string()).or_default();
        if !verified && obs.verified {
            return;
        }
        if verified {
            // Without an earlier trusted lineup (first visit was Swap Player, or a migration
            // cleared it) any points value of this lineup may have come out of the box.
            let entered = if obs.verified && !obs.slots.is_empty() {
                entered_points(&obs.slots, &slots)
            } else {
                slots.iter().map(|o| o.points).collect()
            };
            if !entered.is_empty() {
                let gallery = &self.snapshot.gallery;
                obs.unselected.retain(|id| gallery.get(id).is_none_or(|c| !entered.contains(&(c.score as u32))));
            }
        }
        // Flag colours vary a little per read: compare what matters.
        let key = |v: &[crate::lineup::SlotObs]| v.iter().map(|o| (o.points, o.rating, o.position.clone(), o.first_owner)).collect::<Vec<_>>();
        let same = key(&obs.slots) == key(&slots) && obs.verified == verified && (obs.total, obs.base, obs.bonus) == (total, base, bonus) && !obs.user_swapped;
        obs.slots = slots;
        obs.verified = verified;
        if verified {
            obs.user_swapped = false;
        }
        (obs.total, obs.base, obs.bonus) = (total, base, bonus);
        obs.lineup_at = Some(now_ms());
        if !same {
            self.dirty = true;
            self.snapshot.first_owner_version += 1;
        }
    }

    /// "Done" on a suggested swap: `out` (a known card, or the anonymous slot `out_slot`) left the
    /// in-game lineup, `into` took its place. The in-game numbers are unknown until the set page is
    /// read again. Returns false when the lineup doesn't hold `out`.
    pub fn mark_swap_done(&mut self, key: &str, out_def: u64, out_slot: Option<usize>, into_def: u64) -> bool {
        let Some(card) = self.snapshot.gallery.get(&into_def).cloned() else { return false };
        let snap = &self.snapshot;
        let fo = crate::gallery_sets::FirstOwnerInfo { known: &snap.first_owner, manual: &snap.first_owner_manual, scanned: &snap.first_owner_scanned, club_no: &snap.first_owner_club_no };
        let into_fo = fo.known_or_manual(into_def);
        let Some(obs) = self.snapshot.set_obs.get_mut(key) else { return false };
        let slot = match out_slot {
            Some(s) => Some(s),
            None => obs.identified.iter().find(|(_, d)| **d == out_def).map(|(s, _)| *s),
        };
        let Some(slot) = slot.filter(|s| *s < obs.slots.len()) else { return false };
        obs.identified.insert(slot, into_def);
        obs.slots[slot] = crate::lineup::SlotObs { points: card.score as u32, rating: card.rating.map(|r| r as u32), position: card.position.clone(), first_owner: into_fo, flag: None, uncertain: false };
        obs.unselected.remove(&into_def);
        if out_slot.is_none() {
            obs.unselected.insert(out_def);
        }
        (obs.total, obs.base, obs.bonus) = (None, None, None);
        obs.user_swapped = true;
        self.snapshot.first_owner_version += 1;
        self.save();
        true
    }

    /// The box can hold at most (cards owned − lineup slots) cards of each points value. More
    /// means part of it is stale (a same-points swap we couldn't see): forget that value's box
    /// cards, the next swap pages bring them back. `owned`: the set's collected cards per points.
    pub fn enforce_box(&mut self, key: &str, owned: &BTreeMap<u32, usize>) -> usize {
        let Some(obs) = self.snapshot.set_obs.get_mut(key) else { return 0 };
        if obs.unnamed {
            return 0; // the owned counts are short by the unnamed cards
        }
        let gallery = &self.snapshot.gallery;
        let points = |id: &u64| gallery.get(id).map(|c| c.score as u32);
        let mut in_box: BTreeMap<u32, usize> = BTreeMap::new();
        for p in obs.unselected.iter().filter_map(points) {
            *in_box.entry(p).or_default() += 1;
        }
        let mut in_lineup: BTreeMap<u32, usize> = BTreeMap::new();
        for s in &obs.slots {
            *in_lineup.entry(s.points).or_default() += 1;
        }
        let over: BTreeSet<u32> = in_box
            .iter()
            .filter(|(p, n)| **n > owned.get(p).copied().unwrap_or(0).saturating_sub(in_lineup.get(p).copied().unwrap_or(0)))
            .map(|(p, _)| *p)
            .collect();
        let before = obs.unselected.len();
        if !over.is_empty() && !obs.slots.is_empty() {
            obs.unselected.retain(|id| points(id).is_none_or(|p| !over.contains(&p)));
        }
        before - obs.unselected.len()
    }

    /// One tile of an in-game category page.
    pub fn observe_list_tile(&mut self, key: &str, score: Option<u32>, filled: Option<(u32, u32)>) {
        self.snapshot.set_list.insert(key.to_string(), ListObs { score, filled, at: now_ms() });
        self.snapshot.first_owner_version += 1;
    }

    /// Running mean of a nation's flag signature (capped weight, so it keeps adapting).
    pub fn learn_flag(&mut self, nation: u64, flag: &[u8]) {
        Self::learn_into(&mut self.snapshot.flags, nation, flag);
    }

    /// The same for the flag on New Items / Swap Player cards (other size and place than on the
    /// set grid, so learned separately).
    pub fn learn_card_flag(&mut self, nation: u64, flag: &[u8]) {
        Self::learn_into(&mut self.snapshot.card_flags, nation, flag);
    }

    fn learn_into(table: &mut BTreeMap<u64, FlagSample>, nation: u64, flag: &[u8]) {
        let e = table.entry(nation).or_insert(FlagSample { sig: flag.iter().map(|v| *v as f32).collect(), n: 0 });
        if e.sig.len() != flag.len() {
            e.sig = flag.iter().map(|v| *v as f32).collect();
            e.n = 0;
        }
        let w = 1.0 / (e.n.min(19) + 1) as f32;
        for (s, v) in e.sig.iter_mut().zip(flag) {
            *s += (*v as f32 - *s) * w;
        }
        e.n += 1;
    }

    /// A card on a New Items screen: it is in the club now (collected), and a packed / reward
    /// card is first owner (EA also upgrades an earlier bought copy when it is packed). Returns the
    /// card's source (the first one seen wins) and whether anything changed.
    /// Where a card on New Items came from: the first source seen wins – a bought card still lying
    /// in New Items when a pack opens stays "bought". A later real pack copy is not guessed either:
    /// the set page's triangle proves it (user decision 2026-10-17: not first owner until proven).
    pub fn source_for(&self, def_id: u64, context: &str, _now: u64) -> String {
        match self.snapshot.acquired.get(&def_id) {
            Some(a) => a.source.clone(),
            None => context.to_string(),
        }
    }

    pub fn acquire(&mut self, def_id: u64, source: &str) -> (String, bool) {
        let now = now_ms();
        self.snapshot.acquired.retain(|_, a| now.saturating_sub(a.at) < ACQUIRED_KEEP_MS);
        let source = self.source_for(def_id, source, now);
        self.snapshot.acquired.insert(def_id, Acquired { source: source.clone(), at: self.snapshot.acquired.get(&def_id).filter(|a| a.source == source).map_or(now, |a| a.at) });
        let mut changed = false;
        let mut was_collected = true;
        if let Some(c) = self.snapshot.gallery.get_mut(&def_id) {
            was_collected = c.collected;
            changed |= !c.collected;
            c.collected = true;
        }
        if source == "pack" {
            changed |= self.snapshot.first_owner_scanned.insert(def_id, true) != Some(true);
        } else if source == "bought" && !was_collected && !self.snapshot.first_owner_scanned.contains_key(&def_id) {
            // Never owned before and bought now: no copy can make it first owner (yet).
            self.snapshot.first_owner_scanned.insert(def_id, false);
            changed = true;
        }
        if changed {
            self.snapshot.first_owner_version += 1;
        }
        (source, changed)
    }

    /// Cards the in-game lineup shows, but our data didn't know as collected. Returns how many.
    pub fn mark_collected(&mut self, def_ids: &[u64]) -> usize {
        let mut n = 0;
        for id in def_ids {
            if let Some(c) = self.snapshot.gallery.get_mut(id) {
                if !c.collected {
                    c.collected = true;
                    n += 1;
                }
            }
        }
        if n > 0 {
            self.snapshot.first_owner_version += 1;
        }
        n
    }

    pub fn observe_summary(&mut self, summary: crate::scan::GallerySummary) {
        self.snapshot.summary = Some(SummaryObs { summary, at: now_ms() });
    }

    /// Records cards seen on a swap page of a set: they are in the box (collected, not in the
    /// lineup) – the game's own word, it beats any earlier identification of that card.
    pub fn observe_swap_page(&mut self, key: &str, def_ids: &[u64]) {
        let obs = self.snapshot.set_obs.entry(key.to_string()).or_default();
        obs.unselected.extend(def_ids.iter().copied());
        self.snapshot.first_owner_version += 1;
    }

    /// Stores first-owner flags read from the in-game Gallery. Returns how many changed.
    /// Holographic cards are skipped: their triangle shows whether or not they are first owner.
    pub fn apply_scan(&mut self, results: &[(u64, bool)]) -> usize {
        let gallery = &self.snapshot.gallery;
        let scanned = &mut self.snapshot.first_owner_scanned;
        let changed = results
            .iter()
            .filter(|(id, _)| !gallery.get(id).is_some_and(|c| c.holo))
            .filter(|(id, fo)| scanned.insert(*id, *fo) != Some(*fo))
            .count();
        if changed > 0 {
            self.snapshot.first_owner_version += 1;
            self.save();
        }
        changed
    }

    fn merge_gallery(&mut self, cards: Vec<GalleryCard>) {
        for c in cards {
            let merged = match self.snapshot.gallery.get(&c.def_id) {
                Some(old) => {
                    // The sync is the truth: a card that came in without a pack/purchase read
                    // is a miss of the in-game tracking.
                    if self.sync_active && !old.collected && c.collected && !self.snapshot.acquired.contains_key(&c.def_id) {
                        self.sync_missed.push(c.def_id);
                    }
                    c.merged_with(old)
                }
                None => c,
            };
            self.snapshot.gallery.insert(merged.def_id, merged);
        }
    }

    /// Re-applies the saved raw card-database responses (`captures/*_defid.json`). Recovers
    /// collected flags without a new sync; idempotent because `collected` only ever turns on.
    fn replay_card_database_captures(&mut self) -> usize {
        let Ok(rd) = fs::read_dir(self.dir.join("captures")) else { return 0 };
        let mut cards = Vec::new();
        // One-time backfill of EA market averages from responses saved before they were read.
        let backfill = !self.snapshot.prices.values().any(|p| p.avg.is_some());
        // One-time backfill of bought copies (`owners` > 1) from club responses saved earlier.
        let owners_backfill = !self.snapshot.owners_replayed;
        let (mut special_assets, mut base_first_owner) = (BTreeSet::new(), BTreeSet::new());
        for path in rd.filter_map(|e| e.ok()).map(|e| e.path()) {
            let name = path.to_string_lossy().to_string();
            let concept = name.ends_with("_defid.json");
            // Club and market responses carry EA's market average (prices, no extra requests).
            let priced = name.ends_with("_club.json") || name.ends_with("_transfermarket.json");
            if !concept && !priced {
                continue;
            }
            let Some(record) = fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else {
                continue;
            };
            let body = record.get("body").unwrap_or(&Value::Null);
            if concept {
                cards.extend(raw_concept_cards(body));
            } else {
                if backfill {
                    self.merge_market_averages(body, now_ms());
                }
                if owners_backfill && name.ends_with("_club.json") {
                    let mut found = Vec::new();
                    collect_items(body, &mut found, now_ms());
                    for (item, owners, def_id) in found {
                        // Special cards were stored under the base player's asset id: wrong card.
                        if let (Some(asset), Some(def)) = (item.asset_id, def_id) {
                            if asset != def {
                                special_assets.insert(asset);
                            } else if owners == Some(1) {
                                base_first_owner.insert(asset);
                            }
                        }
                        self.note_owners(def_id.or(item.asset_id), owners);
                    }
                }
            }
        }
        let n = cards.len();
        self.merge_gallery(cards);
        if owners_backfill {
            // Only where the base card isn't collected: a fact on a collected base card may come
            // from a club read whose response wasn't saved – never delete it on a guess.
            for asset in special_assets.difference(&base_first_owner) {
                if self.snapshot.gallery.get(asset).is_none_or(|c| !c.collected) {
                    self.snapshot.first_owner.remove(asset);
                }
            }
            self.snapshot.owners_replayed = true;
            self.snapshot.first_owner_version += 1;
            return n.max(1); // saved by the caller
        }
        n
    }

    pub fn summary(&self) -> Summary {
        Summary {
            synced_at: self.snapshot.synced_at,
            item_count: self.snapshot.items.len(),
            player_count: self
                .snapshot
                .items
                .values()
                .filter(|i| i.item_type.as_deref() == Some("player"))
                .count(),
            endpoint_count: self.snapshot.endpoints.len(),
            sync_active: self.sync_active,
        }
    }

    /// Records one Web App response. Returns the number of items found in it.
    pub fn ingest(&mut self, url: &str, body: &Value) -> usize {
        self.ingest_at(url, body, now_ms())
    }

    /// Like `ingest`, for a response seen at `at` (ms): the extension saves what it reads while
    /// the app is closed and delivers it later – items keep the time they were really seen.
    pub fn ingest_at(&mut self, url: &str, body: &Value, at: u64) -> usize {
        *self.snapshot.endpoints.entry(endpoint_key(url)).or_default() += 1;
        // Raw captures are only for mapping EA's own endpoints; our synthetic fct:// sources are known.
        if !url.starts_with("fct://") {
            self.save_raw(url, body);
        }

        let now = at.min(now_ms());
        self.bump();
        if !url.starts_with("fct://") {
            self.merge_market_averages(body, now);
        }
        // Other people's listings: prices only, never club items (their `owners` would
        // otherwise look like our own first-owner cards).
        let key = endpoint_key(url);
        if key.ends_with("/transfermarket") || key.ends_with("/watchlist") {
            if key.ends_with("/transfermarket") {
                self.merge_prices(body, now);
            }
            return 0;
        }
        if url.starts_with(GALLERY_PREFIX) {
            self.sync_sets_read.insert(url[GALLERY_PREFIX.len()..].to_string());
            let cards: Vec<GalleryCard> = body
                .get("cards")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(parse_gallery_card).collect())
                .unwrap_or_default();
            let n = cards.len();
            self.merge_gallery(cards);
            self.snapshot.gallery_synced_at = Some(now);
            return n;
        }
        // Card-database searches return concept cards: Gallery data, never club items.
        if is_card_database_search(url) {
            let cards = raw_concept_cards(body);
            // during a sync (asked for by the app, or the extension's own club read)
            if self.sync_active || self.club_read_started.is_some() {
                // card → when EA said "never owned"; a later "collected" answer withdraws it
                for c in &cards {
                    if c.collected {
                        self.sync_never_owned.remove(&c.def_id);
                    } else {
                        self.sync_never_owned.insert(c.def_id, now);
                    }
                }
            }
            self.merge_gallery(cards);
            self.snapshot.gallery_synced_at = Some(now);
            return 0;
        }
        if endpoint_key(url).ends_with("/chemistry/teamlinks") {
            let links = body.get("teamChemLinks").and_then(Value::as_array).cloned().unwrap_or_default();
            for l in links {
                let (Some(team), Some(linked)) = (l.get("teamId").and_then(Value::as_u64), l.get("linkedTeams")) else {
                    continue;
                };
                let linked: Vec<u64> = linked.as_array().into_iter().flatten().filter_map(Value::as_u64).collect();
                self.snapshot.team_links.insert(team, linked);
            }
            return 0;
        }
        if url.starts_with(CLUB_READ_PREFIX) && self.club_read_started.is_none() {
            self.club_read_started = Some(now);
        }
        let mut found = Vec::new();
        collect_items(body, &mut found, now);
        let n = found.len();
        for (item, owners, def_id) in found {
            self.note_owners(def_id.or(item.asset_id), owners);
            let item = match self.snapshot.items.get(&item.id) {
                Some(old) => item.merged_with(old),
                None => item,
            };
            self.snapshot.items.insert(item.id, item);
        }
        n
    }

    /// `owners` of a club item: 1 = first owner (kept forever, the Gallery remembers), more = a
    /// bought copy (not first owner unless a first-owner copy was ever seen).
    fn note_owners(&mut self, asset: Option<u64>, owners: Option<u64>) {
        let (Some(asset), Some(owners)) = (asset, owners) else { return };
        if owners == 1 {
            self.snapshot.first_owner.insert(asset);
            self.snapshot.first_owner_club_no.remove(&asset);
        } else if owners > 1 && !self.snapshot.first_owner.contains(&asset) {
            self.snapshot.first_owner_club_no.insert(asset);
        }
    }

    /// A sync that stops without finishing (Ultimate Team entered, cancelled): what it collected
    /// for the reconciliation is dropped – a partial read must never correct or prune anything later.
    pub fn abandon_sync(&mut self) {
        self.sync_sets_read.clear();
        self.sync_active = false;
        self.sync_blocked = None;
        self.sync_never_owned.clear();
        self.sync_missed.clear();
        self.club_read_started = None;
    }

    /// Data from the running sync has come in (club or Gallery) – the extension answered.
    pub fn sync_data_seen(&self) -> bool {
        self.club_read_started.is_some() || !self.sync_sets_read.is_empty()
    }

    /// A sync is running (asked for by the app, or the extension's own club read).
    pub fn syncing(&self) -> bool {
        self.sync_active || self.club_read_started.is_some()
    }

    /// The progress notice of the running sync, after data from `url` came in: the club
    /// (players so far), then the Gallery (which set, n of all).
    pub fn sync_progress(&self, url: &str) -> serde_json::Value {
        let players = self.summary().player_count;
        if let Some(key) = url.strip_prefix(GALLERY_PREFIX) {
            let total = crate::gallery_sets::sync_filters().len();
            serde_json::json!({ "kind": "sync", "state": "running", "phase": "gallery", "count": players,
                "done": self.sync_sets_read.len().min(total), "total": total, "set": crate::gallery_sets::sync_filter_name(key) })
        } else {
            serde_json::json!({ "kind": "sync", "state": "running", "phase": "club", "count": players })
        }
    }

    pub fn finish_sync(&mut self) {
        self.finish_sync_at(now_ms());
    }

    /// A sync that ended at `at` (ms) – a delivered one never moves the sync time backwards.
    pub fn finish_sync_at(&mut self, at: u64) {
        self.sync_blocked = None;
        self.sync_sets_read.clear();
        // Only prune after a full club read; passive captures alone never remove items.
        if let Some(started) = self.club_read_started.take() {
            self.snapshot.items.retain(|_, i| i.last_seen >= started);
        }
        let at = at.min(now_ms());
        self.snapshot.synced_at = Some(self.snapshot.synced_at.map_or(at, |t| t.max(at)));
        self.sync_active = false;
        // The sync is the truth for in-game reads: a card read on New Items (packed / bought) that
        // EA says was never owned was a misread (live 2026-10-17: "Riben Dias" became Boulaye Dia).
        let never = std::mem::take(&mut self.sync_never_owned);
        // only an answer given after the in-game read overrules it (a card packed after an
        // aborted sync's "never owned" answer is real)
        let misread: Vec<u64> = self
            .snapshot
            .acquired
            .iter()
            .filter(|(id, a)| a.source != "sync" && never.get(id).is_some_and(|said| *said >= a.at))
            .map(|(id, _)| *id)
            .collect();
        if !misread.is_empty() {
            let names: Vec<String> = misread.iter().map(|id| self.snapshot.gallery.get(id).and_then(|c| c.name.clone()).unwrap_or_else(|| id.to_string())).collect();
            for id in &misread {
                self.snapshot.acquired.remove(id);
                if let Some(c) = self.snapshot.gallery.get_mut(id) {
                    c.collected = false;
                }
                if self.snapshot.first_owner_scanned.get(id) == Some(&true) {
                    self.snapshot.first_owner_scanned.remove(id);
                }
            }
            self.snapshot.first_owner_version += 1;
            crate::tracking::log(&self.dir, &format!("sync: {} card(s) read in-game are not in the club (misread) – corrected: {}", misread.len(), names.join(", ")));
        }
        // Reconcile with the in-game tracking: cards the sync found that no read caught. They
        // count as arrived now (the Buy next list ticks them until they are placed).
        if !self.sync_missed.is_empty() {
            let missed = std::mem::take(&mut self.sync_missed);
            let names: Vec<String> = missed.iter().take(12).map(|id| self.snapshot.gallery.get(id).and_then(|c| c.name.clone()).unwrap_or_else(|| id.to_string())).collect();
            crate::tracking::log(&self.dir, &format!("sync: {} Gallery card(s) came in without being caught in-game: {}{}", missed.len(), names.join(", "), if missed.len() > 12 { " …" } else { "" }));
            let now = now_ms();
            // many at once (e.g. packs opened on another device): logged only, no ticks in the list
            let missed = if missed.len() <= 20 { missed } else { Vec::new() };
            for id in missed {
                self.snapshot.acquired.entry(id).or_insert(Acquired { source: "sync".into(), at: now });
            }
        }
        self.save();
    }

    pub fn save(&mut self) {
        self.dirty = false;
        self.bump();
        // Write a temp file, then rename: a crash mid-write never leaves a half snapshot.
        if let Ok(json) = serde_json::to_string(&self.snapshot) {
            let tmp = self.dir.join("snapshot.json.tmp");
            if fs::write(&tmp, json).is_ok() {
                let _ = fs::rename(&tmp, self.dir.join("snapshot.json"));
            }
        }
    }

    fn save_raw(&self, url: &str, body: &Value) {
        let captures = self.dir.join("captures");
        let name = format!("{}_{}.json", now_ms(), sanitize(&endpoint_key(url)));
        let record = serde_json::json!({ "url": strip_query(url), "body": body });
        let _ = fs::write(captures.join(name), record.to_string());
        prune(&captures, MAX_RAW_CAPTURES);
    }
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).take(80).collect()
}

fn prune(dir: &PathBuf, keep: usize) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut files: Vec<_> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    if files.len() <= keep {
        return;
    }
    files.sort(); // file names start with a timestamp
    for f in &files[..files.len() - keep] {
        let _ = fs::remove_file(f);
    }
}

/// Finds items in arbitrary JSON: objects in an array under the key `itemData`
/// (FUT's format in previous years). Tolerant of unknown fields.
/// Each found item comes with its `owners` count (1 = first owner), when known.
/// Points values that entered the lineup between two verified reads: values whose count grew,
/// plus values whose flags changed within the group (a swap between two cards with equal points).
fn entered_points(old: &[crate::lineup::SlotObs], new: &[crate::lineup::SlotObs]) -> BTreeSet<u32> {
    /// Two reads of the same card's flag measure ~10–35 apart, different flags 100+.
    const SAME_FLAG: f32 = 70.0;
    let group = |s: &[crate::lineup::SlotObs], p: u32| -> Vec<Option<Vec<u8>>> { s.iter().filter(|o| o.points == p).map(|o| o.flag.clone()).collect() };
    let values: BTreeSet<u32> = new.iter().map(|o| o.points).collect();
    let mut out = BTreeSet::new();
    for p in values {
        let (mut was, now) = (group(old, p), group(new, p));
        if now.len() > was.len() {
            out.insert(p);
            continue;
        }
        // Every flag in the new group must find a close one in the old group.
        for f in now.iter() {
            let Some(f) = f else { continue };
            let best = was
                .iter()
                .enumerate()
                .filter_map(|(i, g)| g.as_ref().map(|g| (i, g.iter().zip(f).map(|(a, b)| (*a as f32 - *b as f32).powi(2)).sum::<f32>().sqrt())))
                .min_by(|a, b| a.1.total_cmp(&b.1));
            match best {
                Some((i, d)) if d <= SAME_FLAG => {
                    was.remove(i);
                }
                Some(_) => {
                    out.insert(p);
                    break;
                }
                None => {} // no flags stored before: can't tell
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(points: u32, flag: u8) -> crate::lineup::SlotObs {
        crate::lineup::SlotObs { points, rating: None, position: None, first_owner: false, flag: Some(vec![flag; 18]), uncertain: false }
    }

    #[test]
    fn a_sync_saved_by_the_extension_keeps_its_own_time() {
        let mut s = temp_store();
        let at = now_ms() - 3_600_000; // read an hour ago, delivered now
        let club = serde_json::json!({ "itemData": [{ "id": 77, "assetId": 1, "rating": 85, "owners": 1 }] });
        s.ingest_at("fct://club/players", &club, at);
        assert_eq!(s.snapshot.items.get(&77).map(|i| i.last_seen), Some(at));
        s.finish_sync_at(at);
        assert_eq!(s.snapshot.synced_at, Some(at));
        assert!(s.snapshot.items.contains_key(&77), "the delivered club read is kept");
        // a later, older delivery never moves the sync time backwards
        s.finish_sync_at(at - 1000);
        assert_eq!(s.snapshot.synced_at, Some(at));
        // a time in the future is clamped to now
        s.finish_sync_at(now_ms() + 60_000);
        assert!(s.snapshot.synced_at.unwrap() <= now_ms());
    }

    #[test]
    fn the_box_survives_revisits_and_only_loses_what_entered_the_lineup() {
        let mut s = temp_store();
        for (id, score) in [(1, 160), (2, 160), (3, 160), (4, 120), (5, 120)] {
            s.snapshot.gallery.insert(id, GalleryCard { def_id: id, score, collected: true, ..Default::default() });
        }
        let lineup = vec![slot(160, 10), slot(160, 200), slot(120, 90)];
        s.observe_set_page("k", lineup.clone(), true, Some(500), Some(440), Some(60));
        s.observe_swap_page("k", &[3, 5]);
        // Same lineup again (OCR noise in the flags): the box stays.
        let noisy = vec![slot(160, 14), slot(160, 195), slot(120, 94)];
        s.observe_set_page("k", noisy, true, Some(500), Some(440), Some(60));
        assert_eq!(s.snapshot.set_obs["k"].unselected.len(), 2);
        // An unverified read never touches it.
        s.observe_set_page("k", vec![slot(700, 0)], false, None, None, None);
        assert_eq!(s.snapshot.set_obs["k"].unselected.len(), 2);
        // A same-points swap (another flag in the 160 group): the 160s leave the box, 120 stays.
        let swapped = vec![slot(160, 10), slot(160, 120), slot(120, 90)];
        s.observe_set_page("k", swapped, true, Some(500), Some(440), Some(60));
        assert_eq!(s.snapshot.set_obs["k"].unselected.iter().copied().collect::<Vec<_>>(), vec![5]);
    }

    #[test]
    fn a_swap_marked_done_changes_the_lineup_until_the_next_read() {
        let mut s = temp_store();
        for (id, score) in [(1, 340), (2, 280), (3, 280)] {
            s.snapshot.gallery.insert(id, GalleryCard { def_id: id, score, collected: true, ..Default::default() });
        }
        s.observe_set_page("k", vec![slot(340, 1), slot(280, 2)], true, Some(900), Some(620), Some(280));
        s.snapshot.set_obs.get_mut("k").unwrap().identified = [(0usize, 1u64), (1, 2)].into_iter().collect();
        s.observe_swap_page("k", &[3]);
        assert!(s.mark_swap_done("k", 1, None, 3));
        let o = &s.snapshot.set_obs["k"];
        assert_eq!(o.identified[&0], 3);
        assert_eq!(o.slots[0].points, 280);
        assert!(o.unselected.contains(&1) && !o.unselected.contains(&3));
        assert!(o.user_swapped && o.total.is_none());
        // The next verified read is the truth again.
        s.observe_set_page("k", vec![slot(280, 1), slot(280, 2)], true, Some(850), Some(560), Some(290));
        assert!(!s.snapshot.set_obs["k"].user_swapped);
        // Not in the lineup: nothing changes.
        assert!(!s.mark_swap_done("k", 99, None, 1));
    }

    #[test]
    fn the_triangle_of_a_holographic_card_is_no_first_owner_fact() {
        let mut s = temp_store();
        s.snapshot.gallery.insert(1, GalleryCard { def_id: 1, holo: true, collected: true, ..Default::default() });
        s.snapshot.gallery.insert(2, GalleryCard { def_id: 2, collected: true, ..Default::default() });
        assert_eq!(s.apply_scan(&[(1, true), (2, true)]), 1);
        assert!(!s.snapshot.first_owner_scanned.contains_key(&1));
        assert_eq!(s.snapshot.first_owner_scanned.get(&2), Some(&true));
    }

    #[test]
    fn a_box_with_more_cards_than_possible_is_partly_stale() {
        let mut s = temp_store();
        for (id, score) in [(1, 160), (2, 160), (3, 160), (4, 120), (5, 120)] {
            s.snapshot.gallery.insert(id, GalleryCard { def_id: id, score, collected: true, ..Default::default() });
        }
        s.observe_set_page("k", vec![slot(160, 1), slot(160, 2), slot(120, 3)], true, None, Some(440), None);
        s.observe_swap_page("k", &[1, 3, 5]); // two 160s in the box, but only one can be there
        let owned: BTreeMap<u32, usize> = [(160, 3), (120, 2)].into_iter().collect();
        assert_eq!(s.enforce_box("k", &owned), 2);
        assert_eq!(s.snapshot.set_obs["k"].unselected.iter().copied().collect::<Vec<_>>(), vec![5]);
    }

    #[test]
    fn endpoint_keys_are_normalized() {
        assert_eq!(
            endpoint_key("https://utas.example.com/ut/game/fc27/item/123456?x=1"),
            "/ut/game/fc27/item/{id}"
        );
    }

    fn temp_store() -> Store {
        let dir = std::env::temp_dir().join(format!("fct-test-{}", random_suffix()));
        Store::load(dir)
    }

    fn random_suffix() -> u128 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    }

    #[test]
    fn full_club_read_prunes_sold_items_and_keeps_names() {
        let mut s = temp_store();
        s.ingest("fct://club/players", &serde_json::json!({ "itemData": [
            { "id": 1, "name": "Kept", "rating": 88 }, { "id": 2, "name": "Sold" }
        ]}));
        s.finish_sync();
        std::thread::sleep(std::time::Duration::from_millis(2));

        // Next sync: item 2 is gone; a sparse raw response for item 1 must not erase its name.
        s.ingest("fct://club/players", &serde_json::json!({ "itemData": [{ "id": 1, "rating": 88 }] }));
        s.ingest("https://x/ut/game/fc27/club", &serde_json::json!({ "itemData": [{ "id": 1 }] }));
        s.finish_sync();

        let ids: Vec<u64> = s.snapshot.items.keys().copied().collect();
        assert_eq!(ids, vec![1]);
        assert_eq!(s.snapshot.items[&1].name.as_deref(), Some("Kept"));
        let _ = fs::remove_dir_all(s.dir());
    }

    #[test]
    fn first_owner_is_remembered_after_the_card_is_sold() {
        let mut s = temp_store();
        s.ingest("fct://club/players", &serde_json::json!({ "itemData": [
            { "id": 1, "assetId": 500, "owners": 1 }, { "id": 2, "assetId": 600, "owners": 3 }
        ]}));
        s.finish_sync();
        // Timestamps are in ms; make sure the next read starts strictly later.
        std::thread::sleep(std::time::Duration::from_millis(2));
        // Card 1 sold: a later full club read no longer contains it.
        s.ingest("fct://club/players", &serde_json::json!({ "itemData": [{ "id": 2, "assetId": 600, "owners": 3 }] }));
        s.finish_sync();
        assert!(!s.snapshot.items.contains_key(&1));
        assert_eq!(s.snapshot.first_owner.iter().copied().collect::<Vec<_>>(), vec![500]);
        let _ = fs::remove_dir_all(s.dir());
    }

    #[test]
    fn card_database_searches_are_not_club_items() {
        let mut s = temp_store();
        let n = s.ingest(
            "https://utas.example/ut/game/fc27/defid?type=player",
            &serde_json::json!({ "itemData": [{ "id": 50558851, "assetId": 227203 }] }),
        );
        s.ingest("https://x/ut/game/fc27/club", &serde_json::json!({ "itemData": [{ "id": 7, "concept": true }] }));
        assert_eq!(n, 0);
        assert!(s.snapshot.items.is_empty());
        let _ = fs::remove_dir_all(s.dir());
    }

    #[test]
    fn raw_card_database_responses_mark_cards_collected_and_stay_collected() {
        let mut s = temp_store();
        // Raw EA JSON from the Web App's own search: the reliable collected flag.
        s.ingest(
            "https://utas.example/ut/game/fc27/defid",
            &serde_json::json!({ "itemData": [{ "id": 227203, "resourceId": 227203, "gradingScore": 19000,
                "isCollected": true, "rating": 91, "leagueId": 2216, "teamid": 116009, "skillmoves": 3 }] }),
        );
        // Entity-based payload for the same card reports false and adds the name.
        s.ingest("fct://gallery/league-2216", &serde_json::json!({ "cards": [
            { "definitionId": 227203, "gradingScore": 19000, "isCollected": false, "name": "Putellas" }
        ]}));
        let c = &s.snapshot.gallery[&227203];
        assert!(c.collected);
        assert_eq!(c.name.as_deref(), Some("Putellas"));
        assert_eq!((c.team, c.skill_moves), (Some(116009), Some(4)));
        assert!(s.snapshot.items.is_empty());
        let _ = fs::remove_dir_all(s.dir());
    }

    #[test]
    fn a_sync_corrects_a_card_misread_on_new_items() {
        let mut s = temp_store();
        s.snapshot.gallery.insert(9, GalleryCard { def_id: 9, score: 180, name: Some("Dia".into()), ..Default::default() });
        // in-game: "Riben Dias" matched to Dia on New Items → collected + first owner
        s.acquire(9, "pack");
        assert!(s.snapshot.gallery[&9].collected);
        // the sync: the club read starts, EA's card database says Dia was never owned
        s.ingest("fct://club/players", &serde_json::json!({ "itemData": [] }));
        s.ingest("https://utas.example/ut/game/fc27/defid", &serde_json::json!({ "itemData": [{ "id": 9, "resourceId": 9, "gradingScore": 180, "isCollected": false }] }));
        s.finish_sync();
        assert!(!s.snapshot.gallery[&9].collected);
        assert!(!s.snapshot.acquired.contains_key(&9));
        assert_eq!(s.snapshot.first_owner_scanned.get(&9), None);
        let _ = fs::remove_dir_all(s.dir());
    }

    #[test]
    fn a_real_pack_after_an_aborted_sync_is_never_corrected_away() {
        let mut s = temp_store();
        s.snapshot.gallery.insert(9, GalleryCard { def_id: 9, score: 180, ..Default::default() });
        // an app sync reads "never owned", then the user enters Ultimate Team: aborted
        s.sync_active = true;
        s.ingest("https://utas.example/ut/game/fc27/defid", &serde_json::json!({ "itemData": [{ "id": 9, "resourceId": 9, "gradingScore": 180, "isCollected": false }] }));
        s.abandon_sync();
        // the card is really packed
        s.acquire(9, "pack");
        // later the extension's own sync: EA now says collected
        s.ingest("fct://club/players", &serde_json::json!({ "itemData": [] }));
        s.ingest("https://utas.example/ut/game/fc27/defid", &serde_json::json!({ "itemData": [{ "id": 9, "resourceId": 9, "gradingScore": 180, "isCollected": true }] }));
        s.finish_sync();
        assert!(s.snapshot.gallery[&9].collected);
        assert_eq!(s.snapshot.first_owner_scanned.get(&9), Some(&true));
        let _ = fs::remove_dir_all(s.dir());
    }

    #[test]
    fn transfer_market_gives_prices_not_club_items() {
        let mut s = temp_store();
        let market = |bins: &[u64]| {
            serde_json::json!({ "auctionInfo": bins.iter().map(|b| serde_json::json!({
                "buyNowPrice": b, "itemData": { "id": 9, "resourceId": 50_000_001u64, "owners": 1 }
            })).collect::<Vec<_>>() })
        };
        let n = s.ingest("https://utas.example/ut/game/fc27/transfermarket?maskedDefId=1", &market(&[4200, 3900, 5000]));
        assert_eq!(n, 0);
        assert!(s.snapshot.items.is_empty() && s.snapshot.first_owner.is_empty());
        assert_eq!(s.snapshot.prices[&50_000_001].bin, 3900);
        // Narrowing search a moment later: cheaper listing wins.
        s.ingest("https://utas.example/ut/game/fc27/transfermarket", &market(&[3700]));
        assert_eq!(s.snapshot.prices[&50_000_001].bin, 3700);
        // EA's own market average (club items / market results) is preferred when present.
        s.ingest("https://utas.example/ut/game/fc27/club", &serde_json::json!({ "itemData": [
            { "id": 7, "resourceId": 50_000_001u64, "marketAverage": 3950 }
        ]}));
        assert_eq!(s.snapshot.prices[&50_000_001].value(), Some(3950));
        let _ = fs::remove_dir_all(s.dir());
    }

    #[test]
    fn passive_capture_alone_never_prunes() {
        let mut s = temp_store();
        s.ingest("fct://club/players", &serde_json::json!({ "itemData": [{ "id": 1 }] }));
        s.finish_sync();
        s.ingest("https://x/ut/game/fc27/tradepile", &serde_json::json!({ "itemData": [{ "id": 2 }] }));
        s.finish_sync();
        assert_eq!(s.snapshot.items.len(), 2);
        let _ = fs::remove_dir_all(s.dir());
    }

    #[test]
    fn finds_nested_items() {
        let body = serde_json::json!({
            "itemData": [{ "id": 1, "assetId": 99, "rating": 88, "itemType": "player", "preferredPosition": "ST" }],
            "nested": { "itemData": { "id": 2, "itemType": "player" } },
            "other": [{ "id": 3 }],
            "placeholders": { "itemData": [{ "id": 0, "rating": 0 }] }
        });
        let mut out = vec![];
        collect_items(&body, &mut out, 0);
        let mut ids: Vec<u64> = out.iter().map(|(i, _, _)| i.id).collect();
        ids.sort();
        assert_eq!(ids, vec![1, 2]);
        assert_eq!(out[0].0.rating, Some(88));
    }
}
