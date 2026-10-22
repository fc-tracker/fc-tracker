//! The Gallery model (overview of all sets, the missing-players list) computed in the background.
//!
//! The optimiser runs once per set and once per missing card – far too slow to run while the
//! user waits for the overlay, and it must never hold the store lock (the tracking loop would
//! stall and miss short screens like New Items). So a worker copies what the model needs, lets
//! go of the lock, computes, and caches the result; the overlay and the list read the cache
//! instantly and refresh on "gallery-updated".

use crate::gallery_sets::{self, CategorySummary, FirstOwnerInfo, ShoppingList};
use crate::store::{Acquired, GalleryCard, ListObs, Price, SetObs, Store};
use crate::AppState;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// How often the worker looks for new data. Each run copies a few MB and takes ~0.5 s of one
/// core in release builds, so bursts of page reads are folded into one run.
const POLL: Duration = Duration::from_millis(150);

/// Everything the model reads, copied out of the store.
pub struct ModelInput {
    gallery: BTreeMap<u64, GalleryCard>,
    known: BTreeSet<u64>,
    manual: BTreeMap<u64, bool>,
    scanned: BTreeMap<u64, bool>,
    club_no: BTreeSet<u64>,
    links: BTreeMap<u64, Vec<u64>>,
    observed: BTreeMap<String, SetObs>,
    prices: BTreeMap<u64, Price>,
    listed: BTreeMap<String, ListObs>,
    acquired: BTreeMap<u64, Acquired>,
    /// The coin balance last seen ([coins, at]) – Best value never suggests what it can't pay.
    coins: Option<[u64; 2]>,
}

impl ModelInput {
    pub fn from_store(s: &Store) -> Self {
        let snap = &s.snapshot;
        Self {
            gallery: snap.gallery.clone(),
            known: snap.first_owner.clone(),
            manual: snap.first_owner_manual.clone(),
            scanned: snap.first_owner_scanned.clone(),
            club_no: snap.first_owner_club_no.clone(),
            links: snap.team_links.clone(),
            observed: snap.set_obs.clone(),
            prices: snap.prices.clone(),
            listed: snap.set_list.clone(),
            acquired: snap.acquired.clone(),
            coins: snap.coins,
        }
    }

    fn fo(&self) -> FirstOwnerInfo<'_> {
        FirstOwnerInfo { known: &self.known, manual: &self.manual, scanned: &self.scanned, club_no: &self.club_no }
    }

    pub fn overview(&self) -> Vec<CategorySummary> {
        gallery_sets::overview(&self.gallery, &self.fo(), &self.links, &self.observed, &self.prices, &self.listed)
    }

    pub fn shopping_list(&self, key: &str) -> Option<ShoppingList> {
        gallery_sets::shopping_list(key, &self.gallery, &self.fo(), &self.links, &self.observed, &self.prices, &self.acquired, self.balance())
    }

    pub fn balance(&self) -> Option<u64> {
        self.coins.map(|[c, _]| c)
    }

    pub fn coins(&self) -> Option<[u64; 2]> {
        self.coins
    }

    pub fn set_value(&self, key: &str) -> Option<gallery_sets::SetValue> {
        gallery_sets::set_value(key, &self.gallery, &self.fo(), &self.links, &self.observed, &self.prices, self.balance())
    }

    /// Every set's grades and what they cost from the club, within `balance` coins.
    pub fn values(&self, balance: Option<u64>) -> Vec<gallery_sets::SetValue> {
        gallery_sets::all_values(&self.gallery, &self.fo(), &self.links, &self.observed, &self.prices, balance)
    }
}

/// Copies the model input under the store lock (milliseconds) and releases it.
pub fn input(app: &AppHandle) -> (u64, ModelInput) {
    let state = app.state::<AppState>();
    let s = state.store.lock().unwrap();
    (s.revision(), ModelInput::from_store(&s))
}

/// Keeps the overview and the followed set's missing list fresh in the background.
pub fn spawn(app: AppHandle) {
    std::thread::Builder::new()
        .name("gallery-model".into())
        .spawn(move || {
            let mut done: Option<(u64, Option<String>)> = None;
            loop {
                std::thread::sleep(POLL);
                let state = app.state::<AppState>();
                let rev = state.store.lock().unwrap().revision();
                let key = state.missing_set.lock().unwrap().clone();
                let want = (rev, key.clone());
                if done.as_ref() == Some(&want) {
                    continue;
                }
                let overview_fresh = done.as_ref().is_some_and(|(r, _)| *r == rev);
                let (rev, input) = input(&app);
                if !overview_fresh {
                    let overview = input.overview();
                    *state.gallery_cache.lock().unwrap() = Some((rev, overview));
                }
                if let Some(key) = &key {
                    if let Some(list) = input.shopping_list(key) {
                        *state.shopping_cache.lock().unwrap() = Some((rev, key.clone(), list));
                    }
                }
                done = Some((rev, key));
                let _ = app.emit("gallery-updated", rev);
            }
        })
        .expect("failed to start gallery model thread");
}

#[cfg(test)]
mod demo_export {
    /// The website demo's data, computed by this model from the real snapshot (FC 27 1:1):
    /// `FCT_DEMO_OUT=<file> cargo test --lib export_demo_data -- --ignored`
    /// (FCT_REAL_SNAPSHOT picks the snapshot). scripts/demo-data.mjs trims it for the site.
    #[test]
    #[ignore]
    fn export_demo_data() {
        let Ok(out) = std::env::var("FCT_DEMO_OUT") else { return };
        let store = crate::store::Store::copy_of_user_data();
        let input = super::ModelInput::from_store(&store);
        let overview = input.overview();
        let shopping: Vec<_> = overview.iter().flat_map(|c| c.sets.iter()).filter_map(|s| input.shopping_list(&s.key)).collect();
        let snap = &store.snapshot;
        let collected = snap.gallery.values().filter(|c| c.collected).count();
        let json = serde_json::json!({
            "summary": snap.summary,
            "collected": collected,
            "overview": overview,
            "shopping": shopping,
            "synced_at": snap.synced_at,
        });
        std::fs::write(out, serde_json::to_string(&json).unwrap()).unwrap();
    }
}
