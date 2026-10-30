//! App updates: signed releases from fc-tracker.com (tauri-plugin-updater).
//!
//! Instant (user 2026-10-30: "Det skal ske INSTANT"): a watcher checks at start, every
//! 10 minutes, and at once when the paired extension reports a new version – Chrome installed the
//! extension of a new release, so the app's update is out too (the feed holds an app release back
//! until the Chrome Web Store has accepted its extension, site/api/update-feed.mjs). Every window
//! hears about it right away (event "update"), no reload needed.
//!
//! Required updates: the feed's `required` is the oldest version that may still run; an app below
//! it shows "Update required" and installs as soon as FC 27 isn't running. The app in turn requires
//! `EXTENSION_REQUIRED` from the extension and tells an older one to update itself (`/ping`).
//! Installing never happens while FC 27 runs.

use serde::Serialize;
use std::sync::{Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// The oldest extension this app works with; an older one is told to update itself.
pub const EXTENSION_REQUIRED: &str = "0.13.0";
const EVERY: Duration = Duration::from_secs(10 * 60);

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct UpdateInfo {
    pub current: String,
    pub version: String,
    /// This version must not keep running (the feed's `required` is newer than it).
    pub required: bool,
}

static LATEST: Mutex<Option<UpdateInfo>> = Mutex::new(None);
static KICK: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

fn failed(e: impl std::fmt::Display) -> String {
    format!("update_failed:{e}")
}

/// "0.1.9" older than "0.1.10"? (a missing version is never older)
pub fn older(have: &str, than: &str) -> bool {
    let parse = |s: &str| s.trim_start_matches('v').split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (a, b) = (parse(have), parse(than));
    if have.is_empty() || than.is_empty() {
        return false;
    }
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x < y;
        }
    }
    false
}

async fn fetch(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app.updater().map_err(failed)?.check().await.map_err(failed)?;
    Ok(update.map(|u| {
        let required = u.raw_json.get("required").and_then(|v| v.as_str()).is_some_and(|r| older(&u.current_version, r));
        UpdateInfo { current: u.current_version.clone(), version: u.version.clone(), required }
    }))
}

/// Checks now; tells every window when the answer changed.
async fn refresh(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    let found = fetch(app).await?;
    let changed = {
        let mut latest = LATEST.lock().unwrap();
        let changed = *latest != found;
        latest.clone_from(&found);
        changed
    };
    if changed {
        let _ = app.emit("update", &found);
    }
    Ok(found)
}

/// Asks the watcher to check right away (a new extension version was seen).
pub fn kick() {
    let (lock, cv) = &KICK;
    *lock.lock().unwrap() = true;
    cv.notify_one();
}

/// The watcher: at start, every 10 minutes and on every kick.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        let _ = tauri::async_runtime::block_on(refresh(&app));
        let (lock, cv) = &KICK;
        let mut kicked = lock.lock().unwrap();
        if !*kicked {
            kicked = cv.wait_timeout(kicked, EVERY).unwrap().0;
        }
        *kicked = false;
    });
}

/// What the watcher knows (no request).
#[tauri::command]
pub fn update_state() -> Option<UpdateInfo> {
    LATEST.lock().unwrap().clone()
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    refresh(&app).await
}

/// Downloads the update, verifies its signature and runs the installer (passive: a progress
/// bar, no questions); the installer closes FC-Tracker and starts the new version.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if crate::game::is_running() {
        return Err("update_game_running".into());
    }
    let Some(update) = app.updater().map_err(failed)?.check().await.map_err(failed)? else {
        return Ok(());
    };
    update.download_and_install(|_, _| {}, || {}).await.map_err(failed)?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::older;

    #[test]
    fn versions_compare_by_number() {
        assert!(older("0.1.9", "0.1.10"));
        assert!(older("0.12.0", "0.13.0"));
        assert!(!older("0.13.0", "0.13.0"));
        assert!(!older("0.13.1", "0.13.0"));
        assert!(!older("", "0.13.0"));
    }
}
