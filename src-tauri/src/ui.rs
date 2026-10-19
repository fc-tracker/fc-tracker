//! Window placement: overlay modes (panel / half / full), the dragged panel position and the
//! click-through missing-players list. Persisted in `ui.json` in the app data folder.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

pub const MODES: [&str; 3] = ["panel", "half", "full"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiPrefs {
    /// "panel" (movable window), "half" (right half of the screen) or "full".
    pub mode: String,
    /// Panel geometry in physical pixels, remembered after the user drags or resizes it.
    pub panel: Option<(i32, i32, u32, u32)>,
    /// Missing-players list side: "left" | "right".
    #[serde(default = "default_side")]
    pub missing_side: String,
    /// FC 27 closed after a session in Ultimate Team: "remind" (default – a notice and a banner
    /// in the launcher suggest Sync only; the browser never opens by itself), "auto" (the Web App
    /// opens, syncs and closes by itself) or "off". (User 2026-10-17: the browser opening on its
    /// own after closing the game is annoying.)
    #[serde(default = "remind")]
    pub after_play: String,
    /// Where FC 27 was last seen running from (any store) – the launcher starts it from there.
    #[serde(default)]
    pub game_exe: Option<String>,
    /// Tracking speed (Settings → Tracking speed).
    #[serde(default)]
    pub tracking: crate::speed::TrackingPrefs,
}

fn remind() -> String {
    "remind".into()
}

fn default_side() -> String {
    "left".into()
}

impl Default for UiPrefs {
    fn default() -> Self {
        Self { mode: "panel".into(), panel: None, missing_side: default_side(), after_play: remind(), game_exe: None, tracking: Default::default() }
    }
}

impl UiPrefs {
    pub fn load(dir: &PathBuf) -> Self {
        std::fs::read_to_string(dir.join("ui.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<UiPrefs>(&s).ok())
            .filter(|p| MODES.contains(&p.mode.as_str()))
            .unwrap_or_default()
    }

    pub fn save(&self, dir: &PathBuf) {
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(dir.join("ui.json"), json);
        }
    }
}

/// Monitor rectangle (physical pixels) the window is on, or the primary monitor.
fn monitor_rect(win: &WebviewWindow) -> Option<(i32, i32, u32, u32, f64)> {
    let m = win.current_monitor().ok().flatten().or_else(|| win.primary_monitor().ok().flatten())?;
    let (p, s) = (m.position(), m.size());
    Some((p.x, p.y, s.width, s.height, m.scale_factor()))
}

/// Places the overlay for its mode. Full and half cover the whole monitor height – the game
/// runs borderless, so there is no taskbar to keep free.
pub fn place_overlay(win: &WebviewWindow, prefs: &UiPrefs) {
    let Some((mx, my, mw, mh, scale)) = monitor_rect(win) else { return };
    let (x, y, w, h) = match prefs.mode.as_str() {
        "full" => (mx, my, mw, mh),
        "half" => (mx + (mw / 2) as i32, my, mw - mw / 2, mh),
        _ => prefs.panel.unwrap_or_else(|| {
            let (w, h) = ((1180.0 * scale) as u32, (760.0 * scale) as u32);
            (mx + (40.0 * scale) as i32, my + (50.0 * scale) as i32, w.min(mw), h.min(mh))
        }),
    };
    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// The toast: a short card at the top centre, above FC 27's own navigation bar.
pub fn place_toast(win: &WebviewWindow) {
    let Some((mx, my, mw, mh, scale)) = monitor_rect(win) else { return };
    let (w, h) = (((640.0 * scale) as u32).min(mw), (92.0 * scale) as u32);
    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.set_position(PhysicalPosition::new(mx + (mw as i32 - w as i32) / 2, my + (mh as f64 * 0.012) as i32));
}

/// The missing-players list: a narrow column at the screen edge, below the in-game header.
pub fn place_missing(win: &WebviewWindow, prefs: &UiPrefs) {
    let Some((mx, my, mw, mh, scale)) = monitor_rect(win) else { return };
    let w = ((340.0 * scale) as u32).min(mw / 3);
    let h = (mh as f64 * 0.74) as u32;
    let margin = (14.0 * scale) as i32;
    let x = if prefs.missing_side == "right" { mx + mw as i32 - w as i32 - margin } else { mx + margin };
    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.set_position(PhysicalPosition::new(x, my + (mh as f64 * 0.13) as i32));
}

/// Is the mouse cursor inside the window's top strip (`h` CSS px tall, full width)?
pub fn cursor_in_top_strip(win: &WebviewWindow, h: f64) -> bool {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let (Ok(pos), Ok(size), Ok(scale)) = (win.outer_position(), win.outer_size(), win.scale_factor()) else { return false };
    let mut p = POINT::default();
    // SAFETY: plain out-parameter call.
    if unsafe { GetCursorPos(&mut p) }.is_err() {
        return false;
    }
    let right = pos.x + size.width as i32;
    let (x0, y1) = (pos.x, pos.y + (h * scale) as i32);
    p.x >= x0 && p.x < right && p.y >= pos.y && p.y < y1
}

/// Shows a window without activating it (`SW_SHOWNOACTIVATE`): the game stays the foreground
/// window and keeps keyboard, mouse and controller. Tauri's `show()` would activate it.
pub fn show_without_focus(win: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
    match win.hwnd() {
        // SAFETY: hwnd belongs to a live Tauri window.
        Ok(hwnd) => unsafe {
            let _ = ShowWindow(HWND(hwnd.0 as *mut _), SW_SHOWNOACTIVATE);
        },
        Err(_) => {
            let _ = win.show();
        }
    }
    raise_without_focus(win);
}

/// Puts an always-on-top window above the other always-on-top ones (the overlay) without
/// activating it – among topmost windows the last activated one is drawn in front.
pub fn raise_without_focus(win: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};
    if let Ok(hwnd) = win.hwnd() {
        // SAFETY: hwnd belongs to a live Tauri window; z-order only.
        unsafe {
            let _ = SetWindowPos(HWND(hwnd.0 as *mut _), Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

/// Real visibility (Tauri's own flag doesn't know about `show_without_focus`).
pub fn is_shown(win: &WebviewWindow) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    match win.hwnd() {
        // SAFETY: hwnd belongs to a live Tauri window.
        Ok(hwnd) => unsafe { IsWindowVisible(HWND(hwnd.0 as *mut _)).as_bool() },
        Err(_) => win.is_visible().unwrap_or(false),
    }
}

/// Counterpart of `show_without_focus` (Tauri's `hide()` is skipped when its flag says hidden).
pub fn hide(win: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    if let Ok(hwnd) = win.hwnd() {
        // SAFETY: hwnd belongs to a live Tauri window.
        unsafe {
            let _ = ShowWindow(HWND(hwnd.0 as *mut _), SW_HIDE);
        }
    }
    let _ = win.hide();
}
