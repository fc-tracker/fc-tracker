//! App updates: signed releases from fc-tracker.com (tauri-plugin-updater).
//!
//! Instant (user 2026-10-30: "Det skal ske INSTANT"): a watcher checks at start, every
//! 10 minutes, and at once when the paired extension reports a new version – Chrome installed the
//! extension of a new release, so the app's update is out too (the feed holds an app release back
//! until the Chrome Web Store has accepted its extension, site/api/update-feed.mjs). Every window
//! hears about it right away (event "update"), no reload needed.
//!
//! Every update is forced (user 2026-11-04, brand v2): updating costs the user nothing, so any
//! newer release shows the "Update when FC 27 closes" popup (no "Later") and installs by itself as
//! soon as FC 27 has been closed for a moment – also while the launcher sits in the tray. The feed's
//! `required` (the oldest version that may still run) now only says *why*: this version can't read
//! the newest data, so the overlay blocks too. The app in turn requires `EXTENSION_REQUIRED` from the
//! extension and tells an older one to update itself (`/ping`). Installing never happens while FC 27
//! runs or a club sync is reading.
//!
//! After an update the launcher opens. Bug until v2: the updater relaunches the app with the args it
//! had, and an app started by Windows carries `--autostart`, so the new version started hidden in
//! the tray. The installer (nsis/installer.nsi, `.onInstSuccess`) now relaunches with `--updated`
//! instead, and `start_hidden` lets `--updated` win over `--autostart`.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

/// The oldest extension this app works with; an older one is told to update itself.
pub const EXTENSION_REQUIRED: &str = "0.13.0";
const EVERY: Duration = Duration::from_secs(10 * 60);
/// FC 27 must have been closed this long before an update installs by itself (a game that is
/// restarting, or its launcher handing over, must not be caught in between).
const CLOSED_FOR: Duration = Duration::from_secs(20);
/// How often the auto-install looks at the game while an update waits.
const LOOK_EVERY: Duration = Duration::from_secs(5);
/// Every update is forced (see the module docs) – the rule in one place.
pub const FORCE_EVERY_UPDATE: bool = true;
/// The arg the installer starts the new version with after an update (nsis/installer.nsi).
pub const UPDATED_ARG: &str = "--updated";
/// The arg Windows starts the app with at login (game::set_autostart, the installer's checkbox).
pub const AUTOSTART_ARG: &str = "--autostart";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct UpdateInfo {
    pub current: String,
    pub version: String,
    /// This version must not keep running: the popup shows, no "Later" (every update now).
    pub required: bool,
    /// The feed's `required` is newer than this version: it can't read the newest data, so the
    /// overlay is blocked as well (otherwise the overlay only shows a lower-third).
    pub data_change: bool,
    /// Installs by itself once FC 27 is closed (release builds; a dev build never replaces the
    /// installed app on its own).
    pub auto: bool,
}

/// The launcher's "Updated to …" notice after an update (shown once).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Updated {
    pub version: String,
}

static LATEST: Mutex<Option<UpdateInfo>> = Mutex::new(None);
static KICK: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());
static INSTALLING: AtomicBool = AtomicBool::new(false);
static JUST_UPDATED: AtomicBool = AtomicBool::new(false);

/// The launcher starts hidden (in the tray) only when Windows started the app at login – never
/// right after an update, even if the relaunch still carries `--autostart`.
pub fn start_hidden<I: IntoIterator<Item = S>, S: AsRef<str>>(args: I) -> bool {
    let (mut autostart, mut updated) = (false, false);
    for a in args {
        match a.as_ref() {
            AUTOSTART_ARG => autostart = true,
            UPDATED_ARG => updated = true,
            _ => {}
        }
    }
    autostart && !updated
}

/// Called once at start: remembers whether this run is the first after an update.
pub fn boot<I: IntoIterator<Item = S>, S: AsRef<str>>(args: I) {
    JUST_UPDATED.store(args.into_iter().any(|a| a.as_ref() == UPDATED_ARG), Ordering::SeqCst);
}

/// The "Updated to …" notice, once per run after an update (the launcher asks at start).
#[tauri::command]
pub fn updated_notice(app: AppHandle) -> Option<Updated> {
    JUST_UPDATED
        .swap(false, Ordering::SeqCst)
        .then(|| Updated { version: app.package_info().version.to_string() })
}

/// What the feed says, as the app shows it.
fn info(current: &str, version: &str, feed_required: Option<&str>) -> UpdateInfo {
    let data_change = feed_required.is_some_and(|r| older(current, r));
    UpdateInfo {
        current: current.to_string(),
        version: version.to_string(),
        required: FORCE_EVERY_UPDATE || data_change,
        data_change,
        auto: !cfg!(debug_assertions),
    }
}

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
    Ok(update.map(|u| info(&u.current_version, &u.version, u.raw_json.get("required").and_then(|v| v.as_str()))))
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

/// The watcher: at start, every 10 minutes and on every kick; plus the auto-install.
pub fn start(app: AppHandle) {
    let installer = app.clone();
    std::thread::spawn(move || auto_install(installer));
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

/// A club sync is reading (an update would cut it off; it installs right after).
fn syncing(app: &AppHandle) -> bool {
    app.try_state::<crate::AppState>().is_some_and(|s| s.store.lock().unwrap().syncing())
}

/// Should the waiting update install now? `closed_since`: since when FC 27 is seen closed.
fn due(auto: bool, closed_since: Option<Instant>, busy: bool, now: Instant) -> bool {
    auto && !busy && closed_since.is_some_and(|t| now.duration_since(t) >= CLOSED_FOR)
}

/// Installs a waiting update by itself once FC 27 has been closed for `CLOSED_FOR` and no sync
/// reads – the user never has to come back to the launcher for it.
fn auto_install(app: AppHandle) {
    let mut closed_since: Option<Instant> = None;
    let mut failed_at: Option<Instant> = None;
    loop {
        std::thread::sleep(LOOK_EVERY);
        let latest = LATEST.lock().unwrap().clone();
        let Some(latest) = latest else {
            closed_since = None;
            continue;
        };
        if crate::game::is_running() {
            closed_since = None;
            continue;
        }
        let now = Instant::now();
        let since = *closed_since.get_or_insert(now);
        let busy = syncing(&app) || INSTALLING.load(Ordering::SeqCst) || failed_at.is_some_and(|t| now.duration_since(t) < EVERY);
        if due(latest.auto, Some(since), busy, now) {
            if let Err(e) = tauri::async_runtime::block_on(install(&app)) {
                failed_at = Some(Instant::now());
                if let Some(state) = app.try_state::<crate::AppState>() {
                    crate::tracking::log(&state.data_dir, &format!("update: installing {} failed: {e}", latest.version));
                }
            }
        }
    }
}

/// Downloads the update, verifies its signature and runs the installer (passive: a progress
/// bar, no questions); the installer closes FC-Tracker and starts the new version with
/// `--updated` (the launcher opens). One install at a time (button, countdown, auto-install).
async fn install(app: &AppHandle) -> Result<(), String> {
    if crate::game::is_running() {
        return Err("update_game_running".into());
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = async {
        let Some(update) = app.updater().map_err(failed)?.check().await.map_err(failed)? else {
            return Ok(());
        };
        let _ = app.emit("update-installing", &update.version);
        update.download_and_install(|_, _| {}, || {}).await.map_err(failed)?;
        // Windows: the updater has already exited the process for the installer. Elsewhere:
        app.restart();
    }
    .await;
    INSTALLING.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    install(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_update_is_forced() {
        let plain = info("0.1.101", "0.2.0", None);
        assert!(plain.required, "a release without the feed's `required` is still forced");
        assert!(!plain.data_change);
        let old = info("0.1.101", "0.2.0", Some("0.2.0"));
        assert!(old.required && old.data_change);
        let fine = info("0.2.0", "0.2.1", Some("0.1.50"));
        assert!(fine.required && !fine.data_change);
    }

    #[test]
    fn launcher_opens_after_an_update() {
        assert!(start_hidden(["fc-tracker.exe", "--autostart"]), "Windows login: quietly in the tray");
        assert!(!start_hidden(["fc-tracker.exe"]));
        // the updater hands the old run's args on; the installer adds --updated
        assert!(!start_hidden(["fc-tracker.exe", "--autostart", "--updated"]));
        assert!(!start_hidden(["fc-tracker.exe", "--updated"]));
    }

    #[test]
    fn installs_only_when_the_game_was_closed_long_enough() {
        let now = Instant::now();
        let long_ago = now - CLOSED_FOR - Duration::from_secs(1);
        let just_now = now - Duration::from_secs(2);
        assert!(due(true, Some(long_ago), false, now));
        assert!(!due(true, Some(just_now), false, now), "the game may be restarting");
        assert!(!due(true, None, false, now), "FC 27 runs");
        assert!(!due(true, Some(long_ago), true, now), "a sync reads / an install runs");
        assert!(!due(false, Some(long_ago), false, now), "a dev build never installs by itself");
    }

    #[test]
    fn versions_compare_by_number() {
        assert!(older("0.1.9", "0.1.10"));
        assert!(older("0.12.0", "0.13.0"));
        assert!(!older("0.13.0", "0.13.0"));
        assert!(!older("0.13.1", "0.13.0"));
        assert!(!older("", "0.13.0"));
    }
}
