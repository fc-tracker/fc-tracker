//! The FC-Tracker account on this PC (SERVER.md §3): the device's refresh token lives in Windows
//! Credential Manager (encrypted for this Windows user, never in a file), and the local data
//! travels to api.fc-tracker.com in parts – gzipped + base64; the server encrypts it again.
//! Every part stays on this PC first: the account is a copy, the app works without it.
//!   gallery   – snapshot.json (the app's own format; FC-Tracker Web reads/writes it too)
//!   webapp    – webdata.json (objectives, club record, card sources …)
//!   champions – champions.json without opponents' gamertags (they never leave this PC)
//! Settings travel from the UI (src/account.ts).

use crate::store::Snapshot;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::io::{Read, Write};
use std::path::Path;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

const TARGET: &str = "FC-Tracker/account";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// The saved account secret (JSON from the UI: refresh token + e-mail), if any.
pub fn secret() -> Option<String> {
    let target = wide(TARGET);
    let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
    unsafe {
        CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut cred).ok()?;
        let c = &*cred;
        let blob = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec();
        CredFree(cred as *const _);
        String::from_utf8(blob).ok()
    }
}

/// Saves (Some) or removes (None) the account secret.
pub fn set_secret(value: Option<&str>) -> Result<(), String> {
    let mut target = wide(TARGET);
    unsafe {
        match value {
            None => {
                let _ = CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None);
                Ok(())
            }
            Some(v) => {
                let mut user = wide("FC-Tracker");
                let mut blob = v.as_bytes().to_vec();
                let cred = CREDENTIALW {
                    Type: CRED_TYPE_GENERIC,
                    TargetName: PWSTR(target.as_mut_ptr()),
                    CredentialBlobSize: blob.len() as u32,
                    CredentialBlob: blob.as_mut_ptr(),
                    Persist: CRED_PERSIST_LOCAL_MACHINE,
                    UserName: PWSTR(user.as_mut_ptr()),
                    ..Default::default()
                };
                CredWriteW(&cred, 0).map_err(|e| format!("credentials:{e}"))
            }
        }
    }
}

/// Any part for the server: JSON, gzipped, base64.
pub fn pack<T: Serialize>(value: &T) -> Result<String, String> {
    let json = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let mut gz = GzEncoder::new(Vec::new(), Compression::new(6));
    gz.write_all(&json).map_err(|e| e.to_string())?;
    Ok(B64.encode(gz.finish().map_err(|e| e.to_string())?))
}

/// A part from the server (what another device of the same account sent).
pub fn unpack<T: DeserializeOwned>(data: &str) -> Result<T, String> {
    let gz = B64.decode(data.trim()).map_err(|_| "sync_bad_data".to_string())?;
    let mut json = Vec::new();
    GzDecoder::new(&gz[..]).take(64 * 1024 * 1024).read_to_end(&mut json).map_err(|_| "sync_bad_data".to_string())?;
    serde_json::from_slice(&json).map_err(|_| "sync_bad_data".to_string())
}

/// The Gallery part. Prices taken from the shared pools (other users' prices) are left out: they
/// change every few minutes on every PC and are no news of this user's – only the ones this
/// user saw or paid travel.
pub fn export(snapshot: &Snapshot) -> Result<String, String> {
    let mut v = serde_json::to_value(snapshot).map_err(|e| e.to_string())?;
    if let Some(prices) = v.get_mut("prices").and_then(|p| p.as_object_mut()) {
        prices.retain(|_, p| !p.get("shared").and_then(|s| s.as_bool()).unwrap_or(false));
    }
    pack(&v)
}

pub fn decode(data: &str) -> Result<Snapshot, String> {
    let mut s: Snapshot = unpack(data)?;
    crate::store::migrate(&mut s);
    Ok(s)
}

/// When a local file was last written (ms) – shown when local and cloud disagree.
pub fn written_at(dir: &Path, file: &str) -> u64 {
    std::fs::metadata(dir.join(file))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_snapshot_survives_the_round_trip() {
        let mut s = Snapshot { schema: 2, platform: Some("pc".into()), ..Default::default() };
        s.first_owner.insert(232580);
        let back = decode(&export(&s).unwrap()).unwrap();
        assert_eq!(back.platform.as_deref(), Some("pc"));
        assert!(back.first_owner.contains(&232580));
        assert!(decode("not base64!").is_err());
    }

    #[test]
    fn opponents_gamertags_never_go_to_the_account() {
        use crate::champions::{for_sync, Data, Match, Run, Team};
        let mut d = Data::default();
        d.me.gamertag = Some("NS5Chris".into());
        d.runs.push(Run {
            id: 1,
            matches: vec![Match {
                home: Team { gamertag: Some("nschris".into()), ..Default::default() },
                away: Team { gamertag: Some("witsel2003".into()), club: Some("Nice SC".into()), ..Default::default() },
                ..Default::default()
            }],
            ..Default::default()
        });
        let sent = pack(&for_sync(&d)).unwrap();
        let back: Data = unpack(&sent).unwrap();
        let m = &back.runs[0].matches[0];
        assert_eq!(m.away.gamertag, None);
        assert_eq!(m.away.club.as_deref(), Some("Nice SC"));
        assert!(!String::from_utf8_lossy(&B64.decode(&sent).unwrap()).contains("witsel"));
        // "nschris" isn't the user's own tag (case aside it differs) → removed too
        assert_eq!(m.home.gamertag, None);
    }

    /// The user's real snapshot (env FCT_REAL = path): exported, read back and merged into itself
    /// – nothing lost, and the size that would travel.
    #[test]
    #[ignore]
    fn the_real_snapshot_survives_export_and_merge() {
        let Ok(path) = std::env::var("FCT_REAL") else { return };
        let mut real: Snapshot = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        crate::store::migrate(&mut real);
        let data = export(&real).unwrap();
        let back = decode(&data).unwrap();
        let count = |s: &Snapshot| (s.items.len(), s.gallery.values().filter(|c| c.collected).count(), s.first_owner.len(), s.set_obs.len(), s.prices.values().filter(|p| !p.shared).count());
        let before = count(&real);
        assert_eq!(count(&back), before);
        crate::merge::merge(&mut real, back);
        assert_eq!(count(&real), before);
        println!("export: {} KB base64 (items, collected, first owner, sets, prices) = {:?}", data.len() / 1024, before);
    }

    /// Writes, reads and removes a test credential (touches this PC's Credential Manager).
    #[test]
    #[ignore]
    fn the_secret_is_kept_in_credential_manager() {
        set_secret(Some("{\"refresh\":\"test\"}")).unwrap();
        assert_eq!(secret().as_deref(), Some("{\"refresh\":\"test\"}"));
        set_secret(None).unwrap();
        assert_eq!(secret(), None);
    }
}
