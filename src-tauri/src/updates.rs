//! App updates: signed releases from fc-tracker.com (tauri-plugin-updater). The launcher checks
//! at start and every few hours; installing is the user's click, never while FC 27 runs.

use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(serde::Serialize, Clone)]
pub struct UpdateInfo {
    pub current: String,
    pub version: String,
}

fn failed(e: impl std::fmt::Display) -> String {
    format!("update_failed:{e}")
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app.updater().map_err(failed)?.check().await.map_err(failed)?;
    Ok(update.map(|u| UpdateInfo { current: u.current_version.clone(), version: u.version.clone() }))
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
