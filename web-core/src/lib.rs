//! FC-Tracker's Gallery model in the browser (fc-tracker.com/web): the app's own scoring,
//! optimiser, set rules and lineup identification – the same source files, built for
//! WebAssembly. The page reads the game from a shared window, tab or capture card and hands
//! the readings in here; everything is computed exactly as in the app.
//!
//! What the browser version knows comes only from the screen: a public card catalog (every
//! Gallery card, none marked as owned) plus what the user shows – set pages (the lineup's points,
//! ratings, positions and first-owner triangles) and Swap Player pages (owned cards by name).
//!
//! ABI (no bindings generator): `alloc` / `dealloc` for buffers, `call(ptr, len)` takes a JSON
//! request `{"fn": …}` and returns `(ptr << 32) | len` of a JSON reply `{"ok": …}` or
//! `{"error": …}`. The host provides `env.now_ms()` (the model's search budget).
#![allow(dead_code)]

#[path = "../../src-tauri/src/gallery.rs"]
mod gallery;
#[path = "../../src-tauri/src/gallery_sets.rs"]
mod gallery_sets;
#[path = "../../src-tauri/src/lineup.rs"]
mod lineup;
#[path = "../../src-tauri/src/names.rs"]
mod names;
#[path = "../../src-tauri/src/types.rs"]
mod types;
#[path = "../../src-tauri/src/sync_data.rs"]
mod sync_data;

/// What the shared modules import from the app's store and screen reader.
mod store {
    pub use crate::types::*;
}
mod scan {
    pub use crate::names::normalise_name;
}

/// The browser's clock for the model's search budget (std's Instant panics in WebAssembly).
mod clock {
    #[link(wasm_import_module = "env")]
    extern "C" {
        fn now_ms() -> f64;
    }

    #[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
    pub struct Instant(f64);

    impl Instant {
        pub fn now() -> Self {
            Instant(unsafe { now_ms() })
        }
    }

    impl std::ops::Add<std::time::Duration> for Instant {
        type Output = Instant;
        fn add(self, d: std::time::Duration) -> Instant {
            Instant(self.0 + d.as_secs_f64() * 1000.0)
        }
    }

    pub fn ms() -> u64 {
        unsafe { now_ms() as u64 }
    }
}

use gallery_sets::FirstOwnerInfo;
use lineup::{SetCard, SlotObs};
use serde::Deserialize;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use types::{GalleryCard, ListObs, Price, SetObs};

#[derive(Default)]
struct Web {
    gallery: BTreeMap<u64, GalleryCard>,
    links: BTreeMap<u64, Vec<u64>>,
    observed: BTreeMap<String, SetObs>,
    listed: BTreeMap<String, ListObs>,
    /// First-owner facts from the set page's triangle (slots identified with certainty).
    scanned: BTreeMap<u64, bool>,
    /// The user's own marks in the card menu (first owner / bought).
    manual: BTreeMap<u64, bool>,
    /// From a club sync (the extension): EA's `owners == 1` – first owner, proven.
    known: BTreeSet<u64>,
    /// From a club sync: only a bought copy in the club.
    club_no: BTreeSet<u64>,
    /// The card catalog as loaded; cards a sync brought that it doesn't have are kept in the state.
    base_ids: BTreeSet<u64>,
    /// When the last club sync was read (ms).
    synced_at: Option<u64>,
    /// EA's market average per card: from the sync (club items) and the shared price pool.
    prices: BTreeMap<u64, Price>,
    /// The market the account trades on ("pc" / "console"), from the sync.
    platform: Option<String>,
}

thread_local! {
    static WEB: RefCell<Web> = RefCell::new(Web::default());
}

static EMPTY_IDS: BTreeSet<u64> = BTreeSet::new();
static EMPTY_FLAGS: BTreeMap<u64, bool> = BTreeMap::new();

#[derive(Deserialize)]
struct Catalog {
    gallery: Vec<GalleryCard>,
    #[serde(default)]
    links: BTreeMap<u64, Vec<u64>>,
}

#[derive(Deserialize)]
struct SetRead {
    title: String,
    total: Option<u32>,
    base: Option<u32>,
    bonus: Option<u32>,
    slots: Vec<SlotRead>,
    /// A graded set (score panel shown). An incomplete set has no Base Grade to check the cards
    /// against – its placed cards are taken as read (every chip is a real points value).
    #[serde(default)]
    complete: bool,
}

#[derive(Deserialize)]
struct SlotRead {
    points: u32,
    rating: Option<u32>,
    position: Option<String>,
    #[serde(default)]
    first_owner: bool,
}

#[derive(Deserialize)]
struct SwapRead {
    title: String,
    cards: Vec<SwapCardRead>,
}

#[derive(Deserialize)]
struct SwapCardRead {
    name: String,
    rating: Option<u32>,
    points: Option<u32>,
}

#[derive(Deserialize)]
struct TileRead {
    title: String,
    score: Option<u32>,
    filled: Option<(u32, u32)>,
}

fn set_cards(set: &gallery_sets::SetDef, w: &Web) -> Vec<SetCard> {
    gallery_sets::cards_of_set(set, &w.gallery, &w.links)
        .into_iter()
        .map(|c| SetCard { def_id: c.def_id, points: c.score as u32, rating: c.rating.map(|r| r as u32), position: c.position.clone(), nation: c.nation })
        .collect()
}

/// Identifies the read lineup against the set's catalog cards (owned or not – the browser
/// doesn't know the club): a slot is named only when exactly one card fits it.
fn identify(w: &mut Web, key: &str, set: &gallery_sets::SetDef) {
    let cards = set_cards(set, w);
    let Some(obs) = w.observed.get(key).cloned() else { return };
    let ident = lineup::identify(&obs.slots, &cards, &obs.unselected, false, &BTreeMap::new());
    for id in ident.slots.values() {
        if let Some(c) = w.gallery.get_mut(id) {
            c.collected = true;
        }
    }
    if obs.verified {
        for (id, fo) in &ident.first_owner {
            if ident.slots.values().any(|v| v == id) {
                w.scanned.insert(*id, *fo);
            }
        }
    }
    let unnamed = ident.slots.len() < obs.slots.len();
    if let Some(o) = w.observed.get_mut(key) {
        o.identified = ident.slots;
        o.ambiguous = ident.ambiguous;
        o.unnamed = unnamed;
    }
}

fn observe_set(w: &mut Web, read: SetRead) -> Value {
    let Some(set) = gallery_sets::find_set_by_title(&read.title) else { return json!({ "set_key": null }) };
    let slots: Vec<SlotObs> = read
        .slots
        .iter()
        .map(|s| SlotObs { points: s.points, rating: s.rating, position: s.position.clone(), first_owner: s.first_owner, flag: None, uncertain: false })
        .collect();
    let sum: u32 = slots.iter().map(|s| s.points).sum();
    let verified = !slots.is_empty() && if read.complete { read.base.is_some_and(|b| b == sum) } else { read.base.is_none() };
    let unselected = w.observed.get(&set.key).map(|o| o.unselected.clone()).unwrap_or_default();
    w.observed.insert(
        set.key.clone(),
        SetObs {
            slots,
            verified,
            total: read.total,
            base: read.base,
            bonus: read.bonus,
            lineup_at: Some(clock::ms()),
            unselected,
            identified: BTreeMap::new(),
            ambiguous: 0,
            unnamed: false,
            user_swapped: false,
        },
    );
    identify(w, &set.key, &set);
    let o = &w.observed[&set.key];
    json!({
        "kind": "set", "set_key": set.key, "set_name": set.name, "verified": verified,
        "cards_read": o.slots.len(), "facts_changed": 0, "identified": o.identified.len(), "ambiguous": o.ambiguous,
    })
}

/// Levenshtein distance (names read from the screen against the catalog).
fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            cur.push((prev[j] + usize::from(ca != cb)).min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

fn observe_swap(w: &mut Web, read: SwapRead) -> Value {
    let Some(set) = gallery_sets::find_set_by_title(&read.title) else { return json!({ "set_key": null }) };
    let cards = gallery_sets::cards_of_set(&set, &w.gallery, &w.links);
    let mut matched: Vec<u64> = Vec::new();
    let mut unmatched: Vec<String> = Vec::new();
    for r in &read.cards {
        let n = names::normalise_name(&r.name);
        let fits = |c: &&&GalleryCard| r.points.is_none_or(|p| c.score == p as u64) && r.rating.is_none_or(|x| c.rating == Some(x as u64));
        let named = |c: &&&GalleryCard, max: usize| c.name.as_deref().is_some_and(|cn| {
            let cn = names::normalise_name(cn);
            n.len() >= 3 && (cn == n || (max > 0 && distance(&cn, &n) <= max))
        });
        let exact: Vec<&&GalleryCard> = cards.iter().filter(|c| fits(c) && named(c, 0)).collect();
        let pick = if exact.len() == 1 {
            Some(exact[0].def_id)
        } else {
            let near: Vec<&&GalleryCard> = cards.iter().filter(|c| fits(c) && named(c, if n.len() >= 6 { 2 } else { 1 })).collect();
            (near.len() == 1).then(|| near[0].def_id)
        };
        match pick {
            Some(id) => matched.push(id),
            None => unmatched.push(r.name.clone()),
        }
    }
    for id in &matched {
        if let Some(c) = w.gallery.get_mut(id) {
            c.collected = true;
        }
    }
    let obs = w.observed.entry(set.key.clone()).or_default();
    obs.unselected.extend(matched.iter().copied());
    identify(w, &set.key, &set);
    json!({ "kind": "swap", "set_key": set.key, "set_name": set.name, "matched": matched.len(), "unmatched": unmatched })
}

fn observe_tile(w: &mut Web, read: TileRead) -> Value {
    let Some(set) = gallery_sets::find_set_by_title(&read.title) else { return json!({ "set_key": null }) };
    w.listed.insert(set.key.clone(), ListObs { score: read.score, filled: read.filled, at: clock::ms() });
    json!({ "set_key": set.key })
}

#[derive(Deserialize)]
struct SyncEntry {
    url: String,
    body: Value,
}

#[derive(Deserialize)]
struct SyncData {
    at: Option<u64>,
    entries: Vec<SyncEntry>,
}

/// A club sync the extension read in the Web App (the same responses the app ingests): the
/// Gallery card lists say which cards the user has, the club pages who was the first owner.
fn ingest_sync(w: &mut Web, sync: SyncData) -> Value {
    let mut cards: Vec<GalleryCard> = Vec::new();
    let mut owners: Vec<(u64, u64)> = Vec::new();
    let at = sync.at.unwrap_or_else(clock::ms);
    for e in &sync.entries {
        if !e.url.starts_with("fct://") {
            for (id, avg) in sync_data::market_averages(&e.body) {
                let p = Price::seen(w.prices.get(&id), avg, at);
                w.prices.insert(id, p);
            }
            if let Some(p) = sync_data::account_platform(&e.url, &e.body) {
                w.platform = Some(p.to_string());
            }
        }
        if e.url.starts_with(sync_data::GALLERY_PREFIX) {
            cards.extend(e.body.get("cards").and_then(Value::as_array).into_iter().flatten().filter_map(sync_data::parse_gallery_card));
        } else if sync_data::is_card_database_search(&e.url) {
            cards.extend(sync_data::raw_concept_cards(&e.body));
        } else if sync_data::endpoint_key(&e.url).ends_with("/chemistry/teamlinks") {
            for l in e.body.get("teamChemLinks").and_then(Value::as_array).into_iter().flatten() {
                let (Some(team), Some(linked)) = (l.get("teamId").and_then(Value::as_u64), l.get("linkedTeams").and_then(Value::as_array)) else { continue };
                w.links.insert(team, linked.iter().filter_map(Value::as_u64).collect());
            }
        } else if !sync_data::endpoint_key(&e.url).ends_with("/transfermarket") {
            let mut found = Vec::new();
            sync_data::collect_items(&e.body, &mut found, 0);
            for (item, n, def_id) in found {
                if let (Some(id), Some(n)) = (def_id.or(item.asset_id), n) {
                    owners.push((id, n));
                }
            }
        }
    }
    let n = cards.len();
    for c in cards {
        let merged = match w.gallery.get(&c.def_id) {
            Some(old) => c.merged_with(old),
            None => c,
        };
        w.gallery.insert(merged.def_id, merged);
    }
    for (id, n) in owners {
        if n == 1 {
            w.known.insert(id);
            w.club_no.remove(&id);
        } else if n > 1 && !w.known.contains(&id) {
            w.club_no.insert(id);
        }
    }
    w.synced_at = sync.at.or(w.synced_at);
    json!({ "cards": n, "collected": w.gallery.values().filter(|c| c.collected).count(), "first_owner": w.known.len(), "synced_at": w.synced_at })
}

fn dispatch(req: Value) -> Result<Value, String> {
    let f = req.get("fn").and_then(Value::as_str).ok_or("no fn")?.to_string();
    let arg = |k: &str| req.get(k).cloned().unwrap_or(Value::Null);
    WEB.with(|cell| {
        let mut w = cell.borrow_mut();
        let fo = |w: &Web| -> (BTreeMap<u64, bool>, BTreeMap<u64, bool>) { (w.scanned.clone(), w.manual.clone()) };
        match f.as_str() {
            "load_catalog" => {
                let cat: Catalog = serde_json::from_value(arg("catalog")).map_err(|e| e.to_string())?;
                w.gallery = cat.gallery.into_iter().map(|mut c| {
                    c.collected = false;
                    (c.def_id, c)
                }).collect();
                w.links = cat.links;
                w.base_ids = w.gallery.keys().copied().collect();
                Ok(json!({ "cards": w.gallery.len() }))
            }
            "load_state" => {
                let s = arg("state");
                w.observed = serde_json::from_value(s.get("observed").cloned().unwrap_or(json!({}))).unwrap_or_default();
                w.listed = serde_json::from_value(s.get("listed").cloned().unwrap_or(json!({}))).unwrap_or_default();
                w.scanned = serde_json::from_value(s.get("scanned").cloned().unwrap_or(json!({}))).unwrap_or_default();
                w.manual = serde_json::from_value(s.get("manual").cloned().unwrap_or(json!({}))).unwrap_or_default();
                w.known = serde_json::from_value(s.get("known").cloned().unwrap_or(json!([]))).unwrap_or_default();
                w.club_no = serde_json::from_value(s.get("club_no").cloned().unwrap_or(json!([]))).unwrap_or_default();
                w.synced_at = s.get("synced_at").and_then(Value::as_u64);
                w.prices = serde_json::from_value(s.get("prices").cloned().unwrap_or(json!({}))).unwrap_or_default();
                w.platform = s.get("platform").and_then(Value::as_str).map(str::to_string);
                let extra: Vec<GalleryCard> = serde_json::from_value(s.get("extra").cloned().unwrap_or(json!([]))).unwrap_or_default();
                for c in extra {
                    w.gallery.entry(c.def_id).or_insert(c);
                }
                let owned: Vec<u64> = serde_json::from_value(s.get("collected").cloned().unwrap_or(json!([]))).unwrap_or_default();
                for c in w.gallery.values_mut() {
                    c.collected = false;
                }
                for id in owned {
                    if let Some(c) = w.gallery.get_mut(&id) {
                        c.collected = true;
                    }
                }
                Ok(json!(true))
            }
            "state" => {
                let collected: Vec<u64> = w.gallery.values().filter(|c| c.collected).map(|c| c.def_id).collect();
                let extra: Vec<&GalleryCard> = w.gallery.values().filter(|c| !w.base_ids.contains(&c.def_id)).collect();
                Ok(json!({ "collected": collected, "observed": w.observed, "listed": w.listed, "scanned": w.scanned, "manual": w.manual,
                    "known": w.known, "club_no": w.club_no, "synced_at": w.synced_at, "extra": extra, "prices": w.prices, "platform": w.platform }))
            }
            "reset" => {
                w.observed.clear();
                w.listed.clear();
                w.scanned.clear();
                w.manual.clear();
                w.known.clear();
                w.club_no.clear();
                w.synced_at = None;
                w.prices.clear();
                w.platform = None;
                let base = w.base_ids.clone();
                w.gallery.retain(|id, _| base.contains(id));
                for c in w.gallery.values_mut() {
                    c.collected = false;
                }
                Ok(json!(true))
            }
            "find_set" => {
                let title = arg("title").as_str().unwrap_or_default().to_string();
                Ok(gallery_sets::find_set_by_title(&title).map_or(Value::Null, |s| json!({ "key": s.key, "name": s.name, "slots": s.slots })))
            }
            "set_first_owner" => {
                let id = arg("def_id").as_u64().ok_or("def_id")?;
                match arg("value").as_bool() {
                    Some(v) => w.manual.insert(id, v),
                    None => w.manual.remove(&id),
                };
                Ok(json!(true))
            }
            "price_share" => {
                let since = arg("since").as_u64().unwrap_or(0);
                Ok(json!({ "platform": w.platform, "prices": types::own_prices_since(&w.prices, since, 1500) }))
            }
            "price_pool" => {
                let platform = arg("platform").as_str().unwrap_or_default().to_string();
                let pool: BTreeMap<u64, [u64; 2]> = serde_json::from_value(arg("prices")).map_err(|e| e.to_string())?;
                if w.platform.as_deref() != Some(platform.as_str()) {
                    return Ok(json!(0));
                }
                Ok(json!(types::apply_pool(&mut w.prices, &pool)))
            }
            "ingest_sync" => Ok(ingest_sync(&mut w, serde_json::from_value(arg("sync")).map_err(|e| e.to_string())?)),
            "sync_filters" => Ok(json!(gallery_sets::sync_filters().into_iter().map(|(key, filter)| json!({ "key": key, "filter": filter })).collect::<Vec<_>>())),
            "observe_set" => Ok(observe_set(&mut w, serde_json::from_value(arg("read")).map_err(|e| e.to_string())?)),
            "observe_swap" => Ok(observe_swap(&mut w, serde_json::from_value(arg("read")).map_err(|e| e.to_string())?)),
            "observe_tile" => Ok(observe_tile(&mut w, serde_json::from_value(arg("read")).map_err(|e| e.to_string())?)),
            "overview" => {
                let (scanned, manual) = fo(&w);
                let (known, club_no) = (w.known.clone(), w.club_no.clone());
                let info = FirstOwnerInfo { known: &known, manual: &manual, scanned: &scanned, club_no: &club_no };
                let out = gallery_sets::overview(&w.gallery, &info, &w.links, &w.observed, &w.prices, &w.listed);
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "shopping" => {
                let key = arg("key").as_str().unwrap_or_default().to_string();
                let (scanned, manual) = fo(&w);
                let (known, club_no) = (w.known.clone(), w.club_no.clone());
                let info = FirstOwnerInfo { known: &known, manual: &manual, scanned: &scanned, club_no: &club_no };
                let out = gallery_sets::shopping_list(&key, &w.gallery, &info, &w.links, &w.observed, &w.prices, &BTreeMap::new());
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            other => Err(format!("unknown fn {other}")),
        }
    })
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn dealloc(p: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(p, 0, len.max(1))) }
}

#[no_mangle]
pub extern "C" fn call(p: *const u8, len: usize) -> u64 {
    let input = unsafe { std::slice::from_raw_parts(p, len) };
    let reply = match serde_json::from_slice::<Value>(input).map_err(|e| e.to_string()).and_then(dispatch) {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "error": e }),
    };
    let mut bytes = serde_json::to_vec(&reply).unwrap_or_default();
    bytes.shrink_to_fit();
    let out_len = bytes.len();
    let mut boxed = bytes.into_boxed_slice();
    let out_ptr = boxed.as_mut_ptr();
    std::mem::forget(boxed);
    ((out_ptr as u64) << 32) | out_len as u64
}
