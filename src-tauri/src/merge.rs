//! Brings back data written to a second copy of the app folder.
//!
//! Windows runs packaged (MSIX) apps – e.g. the Claude desktop app – with their AppData writes
//! redirected to `%LOCALAPPDATA%\Packages\<package>\LocalCache\Roaming\…`. fc-tracker started
//! from such an app therefore kept its own snapshot there, while the user's own start used the
//! real `%APPDATA%\dk.fctracker.app` (2026-10-14: in-game reads, marks and purchases of one
//! evening seemed "forgotten"). At startup that copy is merged into the real data – nothing the
//! app ever learned is lost – and renamed so it is merged once.

use crate::store::Snapshot;
use std::fs;
use std::path::{Path, PathBuf};

/// `…\Packages\*\LocalCache\Roaming\<app folder name>` copies of `dir`.
pub fn redirected_copies(dir: &Path) -> Vec<PathBuf> {
    let (Some(name), Ok(local)) = (dir.file_name(), std::env::var("LOCALAPPDATA")) else { return Vec::new() };
    let Ok(packages) = fs::read_dir(Path::new(&local).join("Packages")) else { return Vec::new() };
    packages
        .filter_map(|e| e.ok())
        .map(|e| e.path().join("LocalCache").join("Roaming").join(name))
        .filter(|p| p.join("snapshot.json").is_file())
        .collect()
}

/// Merges every redirected copy into `snapshot` (the real one). Returns the merged folders.
/// A copy whose snapshot is byte-identical to ours is our own file seen through the redirect
/// (the app itself runs packaged) and is left alone.
pub fn absorb_redirected(dir: &Path, snapshot: &mut Snapshot) -> Vec<PathBuf> {
    let ours = fs::read(dir.join("snapshot.json")).unwrap_or_default();
    let mut merged = Vec::new();
    for copy in redirected_copies(dir) {
        let Ok(bytes) = fs::read(copy.join("snapshot.json")) else { continue };
        if bytes == ours {
            continue;
        }
        let Ok(mut other) = serde_json::from_slice::<Snapshot>(&bytes) else { continue };
        crate::store::migrate(&mut other);
        merge(snapshot, other);
        // Saved responses too (replays read them).
        if let Ok(rd) = fs::read_dir(copy.join("captures")) {
            let _ = fs::create_dir_all(dir.join("captures"));
            for f in rd.filter_map(|e| e.ok()) {
                let target = dir.join("captures").join(f.file_name());
                if !target.exists() {
                    let _ = fs::copy(f.path(), target);
                }
            }
        }
        let stamp = crate::store::now_ms();
        let _ = fs::rename(copy.join("snapshot.json"), copy.join(format!("snapshot.merged-{stamp}.json")));
        merged.push(copy);
    }
    merged
}

/// `base` = the real data (newer when both know something), `other` = the redirected copy.
/// Facts are unions; where both hold a value, the newer one (by its own timestamp) wins, and
/// without a timestamp (first-owner reads and marks) `base` – the user's own data – wins.
pub fn merge(base: &mut Snapshot, other: Snapshot) {
    // Club contents: the newer full read is the club as it is now.
    if other.synced_at > base.synced_at {
        base.items = other.items;
        base.synced_at = other.synced_at;
    }
    for (k, v) in other.endpoints {
        let e = base.endpoints.entry(k).or_insert(0);
        *e = (*e).max(v);
    }
    base.first_owner.extend(other.first_owner);
    base.first_owner_club_no.extend(other.first_owner_club_no);
    let known = base.first_owner.clone();
    base.first_owner_club_no.retain(|id| !known.contains(id));
    for (k, v) in other.first_owner_manual {
        base.first_owner_manual.entry(k).or_insert(v);
    }
    for (k, v) in other.first_owner_scanned {
        base.first_owner_scanned.entry(k).or_insert(v);
    }
    base.owners_replayed &= other.owners_replayed;
    // Card database: union; "ever collected" can only become true.
    let newer_db = other.gallery_synced_at > base.gallery_synced_at;
    for (id, card) in other.gallery {
        match base.gallery.get_mut(&id) {
            Some(b) => {
                let collected = b.collected || card.collected;
                if newer_db {
                    *b = card;
                }
                b.collected = collected;
            }
            None => {
                base.gallery.insert(id, card);
            }
        }
    }
    base.gallery_synced_at = base.gallery_synced_at.max(other.gallery_synced_at);
    for (k, v) in other.team_links {
        base.team_links.entry(k).or_insert(v);
    }
    // In-game lineups: the newer read; the box (Swap Player) is kept when the lineup is the same.
    for (key, o) in other.set_obs {
        match base.set_obs.get_mut(&key) {
            None => {
                base.set_obs.insert(key, o);
            }
            Some(b) => {
                let points = |s: &crate::store::SetObs| {
                    let mut v: Vec<u32> = s.slots.iter().map(|x| x.points).collect();
                    v.sort_unstable();
                    v
                };
                let same = points(b) == points(&o);
                if o.lineup_at > b.lineup_at || (!b.verified && o.verified) {
                    let keep = std::mem::take(&mut b.unselected);
                    *b = o;
                    if same {
                        b.unselected.extend(keep);
                    }
                } else if same {
                    b.unselected.extend(o.unselected);
                }
            }
        }
    }
    for (k, v) in other.prices {
        if base.prices.get(&k).is_none_or(|b| v.at > b.at) {
            base.prices.insert(k, v);
        }
    }
    for (k, v) in other.set_list {
        if base.set_list.get(&k).is_none_or(|b| v.at > b.at) {
            base.set_list.insert(k, v);
        }
    }
    if other.summary.as_ref().map(|s| s.at) > base.summary.as_ref().map(|s| s.at) {
        base.summary = other.summary;
    }
    for (k, v) in other.flags {
        if base.flags.get(&k).is_none_or(|b| v.n > b.n) {
            base.flags.insert(k, v);
        }
    }
    // The first source of a card wins (pack vs bought).
    for (k, v) in other.acquired {
        if base.acquired.get(&k).is_none_or(|b| v.at < b.at) {
            base.acquired.insert(k, v);
        }
    }
    // Both sides are migrated before merging (see `absorb_redirected`): base keeps its versions.
    base.first_owner_version += other.first_owner_version + 1;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{GalleryCard, SetObs};

    /// Dry run on the user's two real copies (env FCT_REAL, FCT_REDIRECTED = snapshot paths).
    #[test]
    #[ignore]
    fn dry_run_on_real_copies() {
        let (Ok(real), Ok(red)) = (std::env::var("FCT_REAL"), std::env::var("FCT_REDIRECTED")) else { return };
        let read = |p: &str| serde_json::from_slice::<Snapshot>(&fs::read(p).unwrap()).unwrap();
        let (mut base, other) = (read(&real), read(&red));
        let count = |s: &Snapshot| (s.gallery.values().filter(|c| c.collected).count(), s.first_owner_scanned.len(), s.first_owner_manual.len(), s.set_obs.len(), s.acquired.len());
        println!("real       collected/scanned/manual/sets/acquired = {:?}", count(&base));
        println!("redirected collected/scanned/manual/sets/acquired = {:?}", count(&other));
        merge(&mut base, other);
        println!("merged     collected/scanned/manual/sets/acquired = {:?}", count(&base));
        println!("Gabriel scanned {:?}, Bronze manual {:?}", base.first_owner_scanned.get(&232580), base.first_owner_manual.get(&50558894));
    }

    #[test]
    fn nothing_learned_in_either_copy_is_lost() {
        let mut base = Snapshot { schema: 2, fo_detector: 4, ..Default::default() };
        let mut other = Snapshot { schema: 2, fo_detector: 4, ..Default::default() };
        // Gabriel read in-game only in the redirected copy, Bronze marked there too.
        other.first_owner_scanned.insert(232580, false);
        other.first_owner_manual.insert(50558894, false);
        // A purchase only the real copy saw, and a card each copy knew as collected.
        base.acquired.insert(246641, crate::store::Acquired { source: "bought".into(), at: 10 });
        base.gallery.insert(1, GalleryCard { def_id: 1, collected: true, ..Default::default() });
        other.gallery.insert(1, GalleryCard { def_id: 1, collected: false, ..Default::default() });
        other.gallery.insert(2, GalleryCard { def_id: 2, collected: true, ..Default::default() });
        // The same lineup in both, box cards seen in each.
        let slot = |p| crate::lineup::SlotObs { points: p, rating: None, position: None, first_owner: false, flag: None, uncertain: false };
        let obs = |at, ids: &[u64]| SetObs { slots: vec![slot(100), slot(200)], verified: true, lineup_at: Some(at), unselected: ids.iter().copied().collect(), ..Default::default() };
        base.set_obs.insert("k".into(), obs(5, &[7]));
        other.set_obs.insert("k".into(), obs(3, &[8]));
        merge(&mut base, other);
        assert_eq!(base.first_owner_scanned.get(&232580), Some(&false));
        assert_eq!(base.first_owner_manual.get(&50558894), Some(&false));
        assert!(base.acquired.contains_key(&246641));
        assert!(base.gallery[&1].collected && base.gallery[&2].collected);
        assert_eq!(base.set_obs["k"].unselected.iter().copied().collect::<Vec<_>>(), vec![7, 8]);
        assert_eq!(base.set_obs["k"].lineup_at, Some(5));
    }
}
