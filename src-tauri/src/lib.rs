mod bridge;
mod diag;
mod fcsetup;
mod gallery;
mod gallery_sets;
mod game;
mod gamepad;
mod lineup;
mod merge;
mod model;
mod scan;
mod session;
mod speed;
mod store;
mod tracking;
mod ui;
mod updates;
mod watch;
mod wgc;

use bridge::{Bridge, BridgeEvent, BridgeInfo};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use store::{Store, Summary};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

const OVERLAY: &str = "overlay";
const MISSING: &str = "missing";
const TOAST: &str = "toast";

struct AppState {
    store: Arc<Mutex<Store>>,
    bridge: Arc<Mutex<Bridge>>,
    bridge_error: Option<String>,
    /// The Gallery overview, kept fresh by the background model (model.rs).
    gallery_cache: Mutex<Option<(u64, Vec<gallery_sets::CategorySummary>)>>,
    /// Follow the in-game Gallery automatically (see tracking.rs).
    auto_scan: AtomicBool,
    /// Last Gallery page seen in-game (for Ctrl+Shift+G and the overlay).
    current_page: Mutex<Option<tracking::CurrentPage>>,
    /// Set shown in the missing-players list: the last set seen in-game or picked in the overlay.
    missing_set: Mutex<Option<String>>,
    ui: Mutex<ui::UiPrefs>,
    /// Last shopping list (store revision, set key), kept fresh by the background model.
    shopping_cache: Mutex<Option<(u64, String, gallery_sets::ShoppingList)>>,
    data_dir: std::path::PathBuf,
    /// The missing list was open when a match started (shown again afterwards).
    missing_before_match: AtomicBool,
    /// The side panel shows two tabs for its set; the first double-tap switched tab already.
    /// Where the user is in FC 27 (see session.rs).
    session: Mutex<session::GameSession>,
    /// A sync notice (see `show_notice`) stays up until then, whatever page the game shows.
    notice_until: Mutex<Option<std::time::Instant>>,
    /// The user was in Ultimate Team since the game started (club may have changed → sync on exit).
    played_ut: AtomicBool,
    /// "Welcome to Ultimate Team" shown in this game run (cleared when the game closes).
    welcomed: AtomicBool,
    /// FC 27 closed after Ultimate Team and the user is reminded to sync (cleared by a sync or ×).
    sync_suggested: AtomicBool,
    /// The overlay was opened while a screen recorder ran and is still shown without the focus
    /// (until the controller is used in it – see `toggle_overlay`, `wake_overlay`).
    overlay_passive: AtomicBool,
}

fn toggle_overlay(app: &AppHandle) {
    let Some(win) = app.get_webview_window(OVERLAY) else { return };
    if win.is_visible().unwrap_or(false) {
        close_overlay(app);
    } else {
        let in_game = scan::game_in_view();
        // A screen recorder runs: the overlay must not take the focus from FC 27. Live 2026-10-17
        // (Snipping Tool 20:36, OBS 22:42 and 22:52): each time the overlay opened *with* focus
        // while recording, the game left the recording ~5 s later (the desktop under it showed
        // until the end) and our own window capture got no frames – never without a recorder,
        // and never for the side panel or a toast, which don't take the focus. So while
        // recording it opens like the side panel: no activation (the mouse still works). The
        // first controller press in it takes the focus after all (`wake_overlay`) – the
        // controller always works in the overlay; just looking leaves the focus with the game.
        let passive = scan::STEADY.load(Ordering::Relaxed) && in_game;
        app.state::<AppState>().overlay_passive.store(passive, Ordering::Relaxed);
        let _ = app.emit_to(OVERLAY, "overlay-vanish", false);
        let _ = app.emit_to(OVERLAY, "overlay-passive", passive);
        let _ = win.set_ignore_cursor_events(false);
        if passive {
            let _ = win.set_focusable(false);
            ui::show_without_focus(&win);
        } else {
            let _ = win.set_focusable(true);
            let _ = win.show();
            let _ = win.set_focus();
        }
        if let Some(list) = app.get_webview_window(MISSING).filter(|w| ui::is_shown(w)) {
            ui::raise_without_focus(&list);
        }
        // Open on the set the user is on in-game (no extra shortcut needed) …
        let state = app.state::<AppState>();
        let page_key = state.current_page.lock().unwrap().as_ref().map(|p| p.set_key.clone()).filter(|k| !k.is_empty());
        if let Some(key) = page_key.or_else(|| state.missing_set.lock().unwrap().clone()) {
            let _ = app.emit("focus-set", key);
        }
        // … and check the screen right now in case the user just switched sets.
        if in_game {
            follow_screen(app);
        }
    }
}

/// The controller is used in an overlay opened while recording (without focus): from now on the
/// overlay takes the focus, so the controller drives the overlay and not the game – the controller
/// always works in the overlay. Only this first press also reaches the game (it had the focus).
fn wake_overlay(app: &AppHandle, win: &tauri::WebviewWindow) {
    let state = app.state::<AppState>();
    if !state.overlay_passive.swap(false, Ordering::Relaxed) {
        return;
    }
    let _ = win.set_focusable(true);
    // Tauri's own flag doesn't know about `show_without_focus`: show() first, or set_focus() is skipped.
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to(OVERLAY, "overlay-passive", false);
    tracking::log(&state.data_dir, "recording: the controller was used in the overlay – it takes the focus now");
}

/// Reads the set title on screen (~0.3 s: one capture + OCR, off the main thread). When it names
/// another set than the one we showed, the overlay and the missing list jump to it. Our windows
/// are excluded from capture, so an open overlay doesn't hide the game from us.
fn follow_screen(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(frame) = scan::capture_pixels().and_then(|(w, h, px)| scan::frame_from_pixels(w, h, px)) else { return };
        let Some(set) = scan::gallery_title(&frame).and_then(|t| gallery_sets::find_set_by_title(&t)) else { return };
        let state = app.state::<AppState>();
        if state.missing_set.lock().unwrap().as_deref() != Some(set.key.as_str()) {
            set_missing_set(&app, &set.key);
        }
        if app.get_webview_window(OVERLAY).is_some_and(|w| w.is_visible().unwrap_or(false)) {
            let _ = app.emit("focus-set", set.key);
        }
    });
}

/// Hides the overlay and hands the keyboard focus back to FC 27 – Windows doesn't always do
/// that by itself, and the game then misses keyboard input and stops being tracked.
fn close_overlay(app: &AppHandle) {
    // Pressed on the controller (○ / hold View): wait until it is released – the game gets the
    // focus back on close and would act on the button that is still down. (Opened without
    // focus while recording, the game had the focus and the press all along: no wait.)
    if gamepad::any_button_held() && !app.state::<AppState>().overlay_passive.load(Ordering::Relaxed) {
        // Gone from the screen right away; it only keeps the focus until the button is up.
        if let Some(win) = app.get_webview_window(OVERLAY) {
            let _ = app.emit_to(OVERLAY, "overlay-vanish", true);
            let _ = win.set_ignore_cursor_events(true);
        }
        let app = app.clone();
        std::thread::spawn(move || {
            let start = std::time::Instant::now();
            while gamepad::any_button_held() && start.elapsed() < std::time::Duration::from_millis(1500) {
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
            let h = app.clone();
            let _ = app.run_on_main_thread(move || close_overlay_now(&h));
        });
        return;
    }
    close_overlay_now(app);
}

fn close_overlay_now(app: &AppHandle) {
    // Focus goes to the game *before* the overlay hides: while our window is in front Windows
    // allows it; afterwards Windows may already have activated another window. Only when the
    // user came from the game (not when the overlay was opened from the launcher). Opened
    // without focus (recording): the game never lost it – no foreground change at all.
    let passive = app.state::<AppState>().overlay_passive.swap(false, Ordering::Relaxed);
    let to_game = !passive && scan::game_in_view();
    if to_game {
        scan::focus_game();
    }
    if let Some(win) = app.get_webview_window(OVERLAY) {
        ui::hide(&win);
        let _ = win.set_ignore_cursor_events(false);
    }
    if to_game {
        scan::focus_game();
    }
    save_ui(app);
}

/// A match starts: hide everything of ours (the overlay, the missing list, a toast) and remember
/// whether the list was open.
pub(crate) fn enter_match_mode(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = app2.state::<AppState>();
        // Entered twice (matchmaking, then kit selection): keep the first answer.
        let list_open = app2.get_webview_window(MISSING).is_some_and(|w| ui::is_shown(&w));
        state.missing_before_match.fetch_or(list_open, Ordering::Relaxed);
        if let Some(w) = app2.get_webview_window(MISSING) {
            if ui::is_shown(&w) {
                ui::hide(&w);
                let _ = app2.emit("missing-visible", false);
            }
        }
        *state.notice_until.lock().unwrap() = None;
        hide_toast_now(&app2);
        if app2.get_webview_window(OVERLAY).is_some_and(|w| w.is_visible().unwrap_or(false)) {
            close_overlay(&app2);
        }
    });
}

/// Back from a match: the missing list returns if it was open before.
pub(crate) fn leave_match_mode(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if app2.state::<AppState>().missing_before_match.swap(false, Ordering::Relaxed) {
            if let Some(w) = app2.get_webview_window(MISSING) {
                if !ui::is_shown(&w) {
                    toggle_missing(&app2);
                }
            }
        }
    });
}

fn in_match(app: &AppHandle) -> bool {
    *app.state::<AppState>().session.lock().unwrap() == session::GameSession::InMatch
}

fn save_ui(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.ui.lock().unwrap().save(&state.data_dir);
}

/// The side panel is click-through, except its top strip (tabs Best selection | Buy next, the
/// Left/Right switch): while the cursor is over that strip the window takes mouse clicks (still never the focus –
/// WS_EX_NOACTIVATE). Checked every 50 ms, only while the list is shown.
/// Every second: does a screen recorder show a window? Then our capture is held steady (scan::STEADY) and
/// the change is logged, so a recording is never disturbed by us.
fn recorder_watch(app: AppHandle) {
    std::thread::Builder::new()
        .name("recorder-watch".into())
        .spawn(move || {
            let mut last: Option<&'static str> = None;
            loop {
                let now = game::recorder_running();
                if now != last {
                    scan::STEADY.store(now.is_some(), Ordering::Relaxed);
                    let dir = app.state::<AppState>().data_dir.clone();
                    match now {
                        Some(name) => tracking::log(&dir, &format!("recording: {name} is running – our capture is held steady (one session, no changes)")),
                        None => tracking::log(&dir, "recording: no screen recorder any more – normal capture"),
                    }
                    last = now;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        })
        .expect("failed to start recorder watcher");
}

fn side_switch_watch(app: AppHandle) {
    std::thread::Builder::new()
        .name("side-switch".into())
        .spawn(move || {
            let mut clickable: Option<bool> = None;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(50));
                let Some(win) = app.get_webview_window(MISSING) else { continue };
                if !ui::is_shown(&win) {
                    clickable = None;
                    continue;
                }
                let want = ui::cursor_in_top_strip(&win, 52.0);
                if clickable != Some(want) {
                    let _ = win.set_ignore_cursor_events(!want);
                    clickable = Some(want);
                }
            }
        })
        .expect("failed to start side switch watcher");
}

/// The missing-players list never takes focus or clicks, so the game keeps mouse and controller.
fn toggle_missing(app: &AppHandle) {
    let Some(win) = app.get_webview_window(MISSING) else { return };
    // Double-tap View / Create opens and closes – nothing else (user 2026-10-17: a double-tap that
    // sometimes switched the tab instead was confusing). The tab follows what the app knows.
    if ui::is_shown(&win) {
        ui::hide(&win);
    } else {
        ui::place_missing(&win, &app.state::<AppState>().ui.lock().unwrap());
        let _ = win.set_ignore_cursor_events(true);
        ui::show_without_focus(&win);
        // The list follows the set on screen, even one switched to a moment ago.
        if scan::game_in_view() {
            follow_screen(app);
        }
    }
    let _ = app.emit("missing-visible", ui::is_shown(&win));
}

/// Shows a short, click-through hint at the top of the screen (swap advice, pack impact). Never
/// takes focus; replaced by the next one, hidden by `hide_toast`.
pub(crate) fn show_toast(app: &AppHandle, payload: serde_json::Value) {
    // A page hint replaces a sync notice.
    *app.state::<AppState>().notice_until.lock().unwrap() = None;
    show_toast_window(app, payload);
}

/// Counts the toasts shown – a caller can tell whether another one came after its own.
static TOAST_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(crate) fn toast_seq() -> u64 {
    TOAST_SEQ.load(Ordering::SeqCst)
}

fn show_toast_window(app: &AppHandle, payload: serde_json::Value) {
    TOAST_SEQ.fetch_add(1, Ordering::SeqCst);
    let _ = app.emit("toast", payload);
    if let Some(win) = app.get_webview_window(TOAST) {
        if !ui::is_shown(&win) {
            ui::place_toast(&win);
            let _ = win.set_ignore_cursor_events(true);
            ui::show_without_focus(&win);
        }
    }
}

/// Sync progress on top of the game ("syncing – stay out of Ultimate Team", "synced"): unlike
/// page hints it stays up while the user moves through menus, for `secs`.
pub(crate) fn show_notice(app: &AppHandle, payload: serde_json::Value, secs: u64) {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    *app.state::<AppState>().notice_until.lock().unwrap() = Some(until);
    show_toast_window(app, payload);
    // One timer for all notices (progress updates come every second during a sync): it sleeps
    // until the newest deadline and hides the notice when that passed.
    static TIMER: AtomicBool = AtomicBool::new(false);
    if TIMER.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        let state = app.state::<AppState>();
        let deadline = *state.notice_until.lock().unwrap();
        match deadline {
            Some(t) if std::time::Instant::now() < t => std::thread::sleep((t - std::time::Instant::now()).min(std::time::Duration::from_secs(1))),
            Some(_) => {
                *state.notice_until.lock().unwrap() = None;
                hide_toast(&app);
            }
            None => {
                TIMER.store(false, Ordering::SeqCst);
                // a notice that came in right now still gets a timer
                if state.notice_until.lock().unwrap().is_some() && !TIMER.swap(true, Ordering::SeqCst) {
                    continue;
                }
                return;
            }
        }
    });
}

/// Hides the toast unless a sync notice is up.
pub(crate) fn hide_toast(app: &AppHandle) {
    let held = app.state::<AppState>().notice_until.lock().unwrap().is_some_and(|t| std::time::Instant::now() < t);
    if !held {
        hide_toast_now(app);
    }
}

pub(crate) fn hide_toast_now(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(TOAST) {
        if ui::is_shown(&win) {
            ui::hide(&win);
        }
    }
}

/// Shows the set `key` in the missing-players list.
pub(crate) fn set_missing_set(app: &AppHandle, key: &str) {
    let state = app.state::<AppState>();
    let changed = state.missing_set.lock().unwrap().replace(key.to_string()).as_deref() != Some(key);
    state.store.lock().unwrap().focus_set = Some(key.to_string());
    if changed {
        let _ = app.emit("missing-set", key.to_string());
    }
}

#[tauri::command]
fn setup_status() -> Result<fcsetup::SetupStatus, String> {
    fcsetup::status()
}

#[tauri::command]
fn set_borderless() -> Result<fcsetup::SetupStatus, String> {
    if game::is_running() {
        return Err("game_running_setup".into());
    }
    fcsetup::set_borderless()
}

#[tauri::command]
fn game_running() -> bool {
    game::is_running()
}

#[tauri::command]
fn controller() -> Option<gamepad::Controller> {
    gamepad::controller()
}

/// Help from the overlay: the launcher comes forward on Help (its page listens for "open-help").
#[tauri::command]
fn open_help(app: AppHandle, topic: Option<String>) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
        let _ = main.emit("open-help", topic.unwrap_or_else(|| "controls".into()));
    }
}

#[tauri::command]
fn launch_game(state: State<AppState>) -> Result<(), String> {
    launch_installed_game(&state)
}

/// Starts FC 27 from where it was last seen running (any store), else wherever it is installed.
fn launch_installed_game(state: &AppState) -> Result<(), String> {
    let remembered = state.ui.lock().unwrap().game_exe.clone();
    game::launch(remembered.as_deref().map(std::path::Path::new))
}

/// FC 27 was seen starting: remember where its exe is, so the launcher can start it next time
/// wherever it is installed (Steam, EA app, Epic, another drive).
pub(crate) fn remember_game_exe(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // the process exists a moment before its window – look for a few seconds
        for _ in 0..10 {
            if let Some(exe) = game::running_exe() {
                let path = exe.to_string_lossy().to_string();
                let state = app.state::<AppState>();
                let changed = {
                    let mut p = state.ui.lock().unwrap();
                    let changed = p.game_exe.as_deref() != Some(path.as_str());
                    p.game_exe = Some(path.clone());
                    changed
                };
                if changed {
                    save_ui(&app);
                    tracking::log(&state.data_dir, &format!("game: FC 27 runs from {path} – remembered for the launcher"));
                }
                return;
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
}

#[tauri::command]
fn hide_overlay(app: AppHandle) {
    close_overlay(&app);
}

#[tauri::command]
fn bridge_info(state: State<AppState>) -> Result<BridgeInfo, String> {
    if let Some(e) = &state.bridge_error {
        return Err(e.clone());
    }
    let mut info = state.bridge.lock().unwrap().info();
    info.browser_running = game::browser_running();
    Ok(info)
}

#[tauri::command]
fn autostart() -> bool {
    game::autostart_enabled()
}

#[tauri::command]
fn set_autostart(on: bool) -> Result<bool, String> {
    game::set_autostart(on)?;
    Ok(game::autostart_enabled())
}

/// Opens a page of fc-tracker.com (e.g. "/download" for a newer extension).
#[tauri::command]
fn open_site(path: String) -> Result<(), String> {
    game::open_site(&path)
}

#[tauri::command]
fn unpair(state: State<AppState>) -> BridgeInfo {
    let mut b = state.bridge.lock().unwrap();
    b.unpair();
    b.info()
}

#[tauri::command]
fn set_locale(app: AppHandle, state: State<AppState>, locale: String) -> bool {
    let changed = state.bridge.lock().unwrap().set_locale(&locale);
    refresh_tray(&app);
    changed
}

// ---------- system tray: the launcher closes to it, tracking keeps running ----------

/// Tray menu wording per app language (the tray lives in Rust, outside the i18n files).
fn tray_labels(locale: &str) -> (&'static str, &'static str) {
    match locale {
        "da" => ("Åbn FC-Tracker", "Afslut FC-Tracker"),
        "de" => ("FC-Tracker öffnen", "FC-Tracker beenden"),
        "es" => ("Abrir FC-Tracker", "Salir de FC-Tracker"),
        "fr" => ("Ouvrir FC-Tracker", "Quitter FC-Tracker"),
        _ => ("Open FC-Tracker", "Quit FC-Tracker"),
    }
}

fn tray_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let locale = app.try_state::<AppState>().map(|s| s.bridge.lock().unwrap().locale().to_string()).unwrap_or_default();
    let (open, quit) = tray_labels(&locale);
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", open, true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", quit, true, None::<&str>)?,
        ],
    )
}

fn refresh_tray(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id("main"), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Brings the launcher back (tray click, second start, fctracker://).
pub fn show_launcher(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("FC-Tracker")
        .menu(&tray_menu(app)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => show_launcher(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_launcher(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// The overview from the background model (instant, possibly one page read old – the overlay
/// refreshes on "gallery-updated"). Computed here only before the first background run.
#[tauri::command]
async fn gallery_overview(app: AppHandle) -> Vec<gallery_sets::CategorySummary> {
    if let Some((_, overview)) = app.state::<AppState>().gallery_cache.lock().unwrap().as_ref() {
        return overview.clone();
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (rev, input) = model::input(&app);
        let overview = input.overview();
        // The background model may have stored a newer one meanwhile.
        let state = app.state::<AppState>();
        let mut cache = state.gallery_cache.lock().unwrap();
        if cache.as_ref().is_none_or(|(r, _)| *r <= rev) {
            *cache = Some((rev, overview.clone()));
        }
        overview
    })
    .await
    .unwrap_or_default()
}

/// "Done" on a suggested swap (the user made it in-game; the next set page read checks it).
#[tauri::command]
fn mark_swap_done(state: State<AppState>, set_key: String, out_def_id: u64, out_slot: Option<usize>, into_def_id: u64) -> bool {
    state.store.lock().unwrap().mark_swap_done(&set_key, out_def_id, out_slot, into_def_id)
}

/// The user's choice in a card's menu: first owner (true), purchased (false) or automatic (null).
#[tauri::command]
fn set_first_owner(state: State<AppState>, def_id: u64, value: Option<bool>) {
    state.store.lock().unwrap().set_first_owner(def_id, value);
}

#[tauri::command]
fn current_page(state: State<AppState>) -> Option<tracking::CurrentPage> {
    state.current_page.lock().unwrap().clone()
}

#[tauri::command]
fn auto_scan(state: State<AppState>) -> bool {
    state.auto_scan.load(Ordering::Relaxed)
}

#[tauri::command]
fn set_auto_scan(state: State<AppState>, enabled: bool) {
    state.auto_scan.store(enabled, Ordering::Relaxed);
    tracking::log(&state.data_dir, if enabled { "tracking: switched ON in the overlay" } else { "tracking: switched OFF in the overlay" });
}


/// The missing cards of a set (default: the set the list follows), best buys first. From the
/// background model when it covers this set; otherwise computed now, off the store lock.
#[tauri::command]
async fn shopping_list(app: AppHandle, key: Option<String>) -> Option<gallery_sets::ShoppingList> {
    let key = key.or_else(|| app.state::<AppState>().missing_set.lock().unwrap().clone())?;
    if let Some((_, k, list)) = app.state::<AppState>().shopping_cache.lock().unwrap().as_ref() {
        if *k == key {
            return Some(list.clone());
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (rev, input) = model::input(&app);
        let list = input.shopping_list(&key)?;
        let state = app.state::<AppState>();
        let mut cache = state.shopping_cache.lock().unwrap();
        if cache.as_ref().is_none_or(|(r, k, _)| *k != key || *r <= rev) {
            *cache = Some((rev, key, list.clone()));
        }
        Some(list)
    })
    .await
    .ok()
    .flatten()
}

/// The overlay picked a set: the missing-players list follows it.
#[tauri::command]
fn follow_set(app: AppHandle, key: String) {
    set_missing_set(&app, &key);
}

/// The side panel says whether it shows two tabs (Best selection + Buy next) for the set.
#[tauri::command]
fn toggle_missing_list(app: AppHandle) {
    toggle_missing(&app);
}

#[tauri::command]
fn missing_list_visible(app: AppHandle) -> bool {
    app.get_webview_window(MISSING).is_some_and(|w| ui::is_shown(&w))
}

#[tauri::command]
fn ui_prefs(state: State<AppState>) -> ui::UiPrefs {
    state.ui.lock().unwrap().clone()
}

/// Overlay window mode: "panel" (movable), "half" or "full".
#[tauri::command]
fn set_overlay_mode(app: AppHandle, mode: String) -> Result<ui::UiPrefs, String> {
    if !ui::MODES.contains(&mode.as_str()) {
        return Err("invalid_mode".into());
    }
    let prefs = {
        let state = app.state::<AppState>();
        let mut p = state.ui.lock().unwrap();
        p.mode = mode;
        p.clone()
    };
    if let Some(win) = app.get_webview_window(OVERLAY) {
        ui::place_overlay(&win, &prefs);
    }
    save_ui(&app);
    Ok(prefs)
}

#[tauri::command]
fn set_after_play(app: AppHandle, mode: String) -> Result<ui::UiPrefs, String> {
    if !matches!(mode.as_str(), "remind" | "auto" | "off") {
        return Err("invalid_mode".into());
    }
    let prefs = {
        let state = app.state::<AppState>();
        let mut p = state.ui.lock().unwrap();
        p.after_play = mode;
        p.clone()
    };
    save_ui(&app);
    Ok(prefs)
}

/// The launcher asks on start whether a sync is suggested (FC 27 closed after Ultimate Team).
#[tauri::command]
fn sync_suggested(state: State<AppState>) -> bool {
    state.sync_suggested.load(Ordering::SeqCst)
}

#[tauri::command]
fn dismiss_sync_suggestion(app: AppHandle) {
    clear_sync_suggestion(&app);
}

fn clear_sync_suggestion(app: &AppHandle) {
    if app.state::<AppState>().sync_suggested.swap(false, Ordering::SeqCst) {
        let _ = app.emit("sync-suggested", false);
    }
}

/// Tracking speed (Settings → Tracking speed): the saved choice, the values in force and the specs.
#[derive(serde::Serialize)]
struct TrackingInfo {
    prefs: speed::TrackingPrefs,
    effective: speed::TrackingPrefs,
    specs: speed::Specs,
}

#[tauri::command]
fn tracking_speed(app: AppHandle) -> TrackingInfo {
    let prefs = app.state::<AppState>().ui.lock().unwrap().tracking.clone();
    TrackingInfo { effective: speed::effective(&prefs), prefs, specs: speed::specs() }
}

#[tauri::command]
fn set_tracking_speed(app: AppHandle, prefs: speed::TrackingPrefs) -> TrackingInfo {
    {
        let state = app.state::<AppState>();
        let mut p = state.ui.lock().unwrap();
        // a preset applies its values; "custom" keeps the user's numbers (clamped)
        p.tracking = if prefs.preset == "custom" { speed::clamp(prefs) } else { speed::TrackingPrefs { preset: prefs.preset.clone(), ..speed::effective(&prefs) } };
        let e = speed::effective(&p.tracking);
        tracking::log(&state.data_dir, &format!("speed: {} · continuous {} · look every {} ms · still {} / moving {} / market {} ms{}", e.preset, e.continuous, e.watch_ms, e.still_ms, e.animated_ms, e.market_ms, if e.same_for_all { format!(" (same for all: {} ms)", e.all_ms) } else { String::new() }));
    }
    save_ui(&app);
    tracking_speed(app)
}

/// FC 27 closed after a session in Ultimate Team: the club changed, so a sync is due (the game
/// no longer holds the one Ultimate Team session). "remind": a notice and a launcher banner
/// suggest Sync only – the browser never opens by itself. "auto": the Web App opens, the
/// extension syncs and closes the tab. Skipped when off, not paired or a sync already runs.
pub fn sync_after_play(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mode = state.ui.lock().unwrap().after_play.clone();
    if !state.played_ut.swap(false, Ordering::SeqCst) || mode == "off" {
        return;
    }
    if !state.bridge.lock().unwrap().info().paired || state.store.lock().unwrap().sync_active {
        return;
    }
    if mode != "auto" {
        state.sync_suggested.store(true, Ordering::SeqCst);
        let _ = app.emit("sync-suggested", true);
        show_notice(app, serde_json::json!({ "kind": "sync", "state": "suggest" }), 20);
        tracking::log(&state.data_dir, "sync after play: reminder shown (Sync only in the launcher)");
        return;
    }
    {
        let mut s = state.store.lock().unwrap();
        if s.sync_active {
            return;
        }
        s.sync_active = true;
        s.sync_abort = false;
        s.sync_blocked = None;
        s.sync_never_owned.clear();
    }
    match game::open_web_app() {
        Ok(()) => {
            tracking::log(&state.data_dir, "sync after play: Web App opened");
            watch_sync_answer(app);
        }
        Err(e) => {
            state.store.lock().unwrap().sync_active = false;
            tracking::log(&state.data_dir, &format!("sync after play failed: {e}"));
        }
    }
}

#[tauri::command]
fn set_missing_side(app: AppHandle, side: String) -> Result<ui::UiPrefs, String> {
    if side != "left" && side != "right" {
        return Err("invalid_side".into());
    }
    let prefs = {
        let state = app.state::<AppState>();
        let mut p = state.ui.lock().unwrap();
        p.missing_side = side;
        p.clone()
    };
    if let Some(win) = app.get_webview_window(MISSING) {
        ui::place_missing(&win, &prefs);
    }
    save_ui(&app);
    Ok(prefs)
}

#[tauri::command]
fn sync_summary(state: State<AppState>) -> Summary {
    state.store.lock().unwrap().summary()
}

/// Gallery → Summary as last read in-game, next to what we know ourselves.
#[derive(serde::Serialize)]
struct GalleryStatus {
    summary: Option<store::SummaryObs>,
    /// Collected Gallery cards we know of, and how many of them are known first owner.
    collected: usize,
    first_owner_known: usize,
}

#[tauri::command]
fn gallery_status(state: State<AppState>) -> GalleryStatus {
    let s = state.store.lock().unwrap();
    let snap = &s.snapshot;
    let fo = gallery_sets::FirstOwnerInfo {
        known: &snap.first_owner,
        manual: &snap.first_owner_manual,
        scanned: &snap.first_owner_scanned,
    club_no: &snap.first_owner_club_no,
    };
    let collected: Vec<_> = snap.gallery.values().filter(|c| c.collected).collect();
    GalleryStatus {
        summary: snap.summary.clone(),
        collected: collected.len(),
        first_owner_known: collected.iter().filter(|c| fo.known_or_manual(c.def_id)).count(),
    }
}

#[tauri::command]
fn game_session(state: State<AppState>) -> session::GameSession {
    *state.session.lock().unwrap()
}

/// Syncing needs the Ultimate Team session: fine with the game closed or outside Ultimate Team.
#[tauri::command]
fn start_sync(app: AppHandle, state: State<AppState>) -> Result<Summary, String> {
    clear_sync_suggestion(&app);
    if game::is_running() {
        // Not seen yet: look at the screen now (the game is usually right behind the launcher).
        tracking::probe_unknown(&app);
        match *state.session.lock().unwrap() {
            session::GameSession::InUltimateTeam => return Err("game_in_ut".into()),
            session::GameSession::Unknown | session::GameSession::Closed => return Err("game_state_unknown".into()),
            _ => {}
        }
    }
    let summary = {
        let mut s = state.store.lock().unwrap();
        s.sync_active = true;
        s.sync_abort = false;
        s.sync_blocked = None;
        s.sync_never_owned.clear();
        s.summary()
    };
    game::open_web_app()?;
    watch_sync_answer(&app);
    Ok(summary)
}

/// A sync the app asked for must never wait silently: no data and no "sign in" from the extension
/// within 90 s means it isn't answering (the Web App opened in a browser without FC-Tracker, the
/// extension is off …) – the user is told, on top of the game and in the launcher.
fn watch_sync_answer(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(90));
        let state = app.state::<AppState>();
        let silent = {
            let mut s = state.store.lock().unwrap();
            let silent = s.sync_active && s.sync_blocked.is_none() && !s.sync_data_seen();
            if silent {
                s.sync_blocked = Some("no_extension".into());
            }
            silent
        };
        if silent {
            tracking::log(&state.data_dir, "sync: no answer from the extension within 90 s – the user is told");
            show_notice(&app, serde_json::json!({ "kind": "sync", "state": "login", "reason": "no_extension" }), 900);
            let _ = app.emit("sync-blocked", "no_extension");
        }
    });
}

/// Sync and game at once: the Web App syncs while FC 27 starts. The user must stay out of
/// Ultimate Team until the browser closes (notices on top of the game say so).
#[tauri::command]
fn sync_and_launch(app: AppHandle, state: State<AppState>) -> Result<Summary, String> {
    let summary = start_sync(app.clone(), state)?;
    if !game::is_running() {
        launch_installed_game(&app.state::<AppState>())?;
    }
    Ok(summary)
}

#[tauri::command]
fn cancel_sync(app: AppHandle, state: State<AppState>) -> Summary {
    *state.notice_until.lock().unwrap() = None;
    hide_toast_now(&app);
    let mut s = state.store.lock().unwrap();
    s.abandon_sync();
    s.summary()
}

/// Settings → Diagnostics: for 30 minutes every picture the tracking reads is saved.
#[derive(serde::Serialize)]
struct DiagStatus {
    /// Seconds left, None = off.
    remaining: Option<u64>,
}

#[tauri::command]
fn diagnostics_status() -> DiagStatus {
    DiagStatus { remaining: diag::remaining() }
}

#[tauri::command]
fn set_diagnostics(state: State<AppState>, on: bool) -> Result<DiagStatus, String> {
    if on {
        let dir = diag::start(&state.data_dir)?;
        tracking::log(&state.data_dir, &format!("diagnostics: ON for 30 minutes – pictures in {}", dir.display()));
    } else {
        diag::stop();
        tracking::log(&state.data_dir, "diagnostics: OFF");
    }
    Ok(DiagStatus { remaining: diag::remaining() })
}

/// Opens the diagnostics folder (the newest run is the last one).
#[tauri::command]
fn open_diagnostics(state: State<AppState>) -> Result<(), String> {
    let dir = state.data_dir.join("diagnostics");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    game::shell_open(&dir.to_string_lossy()).map_err(|e| e.replace("browser_failed", "open_folder_failed"))
}

#[tauri::command]
fn open_data_dir(state: State<AppState>) -> Result<(), String> {
    let dir = state.store.lock().unwrap().dir().clone();
    game::shell_open(&dir.to_string_lossy()).map_err(|e| e.replace("browser_failed", "open_folder_failed"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A crash at start used to leave nothing behind. Now it is written to crash.log in the data
    // folder (%APPDATA%\dk.fctracker.app) – no data of the user, just where it happened.
    std::panic::set_hook(Box::new(|info| {
        if let Some(dir) = std::env::var_os("APPDATA").map(|d| std::path::PathBuf::from(d).join("dk.fctracker.app")) {
            let _ = std::fs::create_dir_all(&dir);
            let line = format!("{} {}\n", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0), info);
            let _ = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("crash.log")).and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
        }
    }));
    // The only two shortcuts (user requirement: as few as possible; pages are read automatically).
    // Overlay – opens on the set shown in-game.
    let dev_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyF);
    // Show / hide the click-through missing-players list.
    let missing_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyM);

    tauri::Builder::default()
        // Started again (Start menu, second click): bring the running app forward instead of a
        // second copy failing on the bridge port.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_launcher(app)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &dev_shortcut {
                        toggle_overlay(app);
                    } else if shortcut == &missing_shortcut {
                        toggle_missing(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // fctracker:// – the extension's "Open FC-Tracker" button (no admin, current user)
            std::thread::spawn(game::register_protocol);
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            // A shortcut another program already owns must not stop the app from starting.
            for (name, shortcut) in [
                ("Ctrl+Shift+F", dev_shortcut),
                ("Ctrl+Shift+M", missing_shortcut),
            ] {
                if let Err(e) = app.global_shortcut().register(shortcut) {
                    eprintln!("shortcut {name} unavailable: {e}");
                }
            }

            let data_dir = app.path().app_data_dir()?;
            let store = Arc::new(Mutex::new(Store::load(data_dir.clone())));
            let dropped = tracking::revalidate(&mut store.lock().unwrap());
            if dropped > 0 {
                tracking::log(&data_dir, &format!("startup: {dropped} stored reading(s) failed the strict check (lineups are read again, impossible category scores dropped)"));
            }
            let reproven = tracking::reprove_all(&mut store.lock().unwrap());
            if reproven > 0 {
                tracking::log(&data_dir, &format!("startup: {reproven} first-owner fact(s) from selections proven again"));
            }
            let bridge = Arc::new(Mutex::new(Bridge::load(&data_dir)));

            let events = app.handle().clone();
            let bridge_error = bridge::spawn(store.clone(), bridge.clone(), move |ev| {
                let _ = match ev {
                    BridgeEvent::Paired => events.emit("bridge-paired", ()),
                    BridgeEvent::Updated(s) => events.emit("sync-update", s),
                    BridgeEvent::SyncDone(s) => {
                        // the club is current: name what couldn't be named before
                        let n = tracking::reprove_all(&mut events.state::<AppState>().store.lock().unwrap());
                        if n > 0 {
                            tracking::log(&events.state::<AppState>().data_dir, &format!("sync: {n} first-owner fact(s) from selections proven again"));
                        }
                        // The browser closes now: Ultimate Team is free in the game.
                        show_notice(&events, serde_json::json!({ "kind": "sync", "state": "done", "count": s.player_count }), 10);
                        clear_sync_suggestion(&events);
                        events.emit("sync-done", s)
                    }
                    BridgeEvent::SyncBlocked(_) if !events.state::<AppState>().store.lock().unwrap().sync_active => {
                        // the user opened the Web App signed out themselves: nothing to tell
                        Ok(())
                    }
                    BridgeEvent::SyncBlocked(reason) => {
                        // Action needed: stays up until the user signs in (or 15 minutes). Only for a
                        // sync the app asked for – the user opening the Web App signed out knows.
                        tracking::log(&events.state::<AppState>().data_dir, &format!("sync blocked: {reason} – the user has to sign in to the Web App"));
                        if events.state::<AppState>().store.lock().unwrap().sync_active {
                            show_notice(&events, serde_json::json!({ "kind": "sync", "state": "login", "reason": reason }), 900);
                        }
                        events.emit("sync-blocked", reason)
                    }
                    BridgeEvent::SyncProgress(p) => {
                        // every wait visible: what the sync is reading right now
                        show_notice(&events, p, 600);
                        Ok(())
                    }
                    BridgeEvent::SyncResumed => {
                        tracking::log(&events.state::<AppState>().data_dir, "sync resumed: signed in to the Web App");
                        if events.state::<AppState>().store.lock().unwrap().sync_active {
                            show_notice(&events, serde_json::json!({ "kind": "sync", "state": "running" }), 600);
                        }
                        events.emit("sync-resumed", ())
                    }
                };
            })
            .err();
            app.manage(AppState {
                store,
                bridge,
                bridge_error,
                gallery_cache: Mutex::new(None),
                auto_scan: AtomicBool::new(true),
                current_page: Mutex::new(None),
                missing_set: Mutex::new(None),
                shopping_cache: Mutex::new(None),
                ui: Mutex::new(ui::UiPrefs::load(&data_dir)),
                data_dir: data_dir.clone(),
                missing_before_match: AtomicBool::new(false),
                session: Mutex::new(if game::is_running() { session::GameSession::Unknown } else { session::GameSession::Closed }),
                notice_until: Mutex::new(None),
                played_ut: AtomicBool::new(false),
                welcomed: AtomicBool::new(false),
                sync_suggested: AtomicBool::new(false),
                overlay_passive: AtomicBool::new(false),
            });

            // Reads capture the game window itself (scan::capture_pixels), so our windows never
            // have to be hidden; they are registered for the page-change signature (masked
            // there) and for the screen-copy fallback.
            // Windows are created only now (`"create": false` in tauri.conf.json): their pages call
            // commands right away, and the state above must exist by then.
            // Started by Windows at login (--autostart): quietly – tracking runs, the launcher
            // stays in the tray until the user opens it.
            let quiet = std::env::args().any(|a| a == "--autostart");
            for mut config in app.config().app.windows.clone() {
                if quiet && config.label == "main" {
                    config.visible = false;
                }
                tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?.build()?;
            }
            // Only now: the tray reads the state and the close handler needs the main window
            // (0.1.16 did this first and crashed at start).
            // Closing the launcher only hides it: tracking, overlay and syncs keep running, and the
            // tray icon (or starting FC-Tracker again) brings it back. "Quit" in the tray ends it.
            // (Before: the window was destroyed while the hidden overlay kept the process alive –
            // invisible, and a second start found no window to show.)
            if let Err(e) = build_tray(app.handle()) {
                tracking::log(&app.state::<AppState>().data_dir, &format!("tray failed: {e}"));
            }
            if let Some(main) = app.get_webview_window("main") {
                let w = main.clone();
                main.on_window_event(move |ev| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            for label in [OVERLAY, MISSING, TOAST, "main"] {
                if let Some(win) = app.get_webview_window(label) {
                    if let Ok(hwnd) = win.hwnd() {
                        scan::register_own_window(hwnd.0 as isize);
                    }
                }
            }
            {
                let prefs = app.state::<AppState>().ui.lock().unwrap().clone();
                if let Some(win) = app.get_webview_window(OVERLAY) {
                    ui::place_overlay(&win, &prefs);
                    // Remember where the user drags / resizes the panel.
                    let handle = app.handle().clone();
                    let w = win.clone();
                    win.on_window_event(move |ev| {
                        if matches!(ev, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                            let state = handle.state::<AppState>();
                            let mut p = state.ui.lock().unwrap();
                            if p.mode == "panel" {
                                if let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) {
                                    if size.width > 200 && size.height > 200 {
                                        p.panel = Some((pos.x, pos.y, size.width, size.height));
                                    }
                                }
                            }
                        }
                    });
                }
                if let Some(win) = app.get_webview_window(TOAST) {
                    ui::place_toast(&win);
                    let _ = win.set_focusable(false);
                    let _ = win.set_ignore_cursor_events(true);
                }
                if let Some(win) = app.get_webview_window(MISSING) {
                    ui::place_missing(&win, &prefs);
                    // Never activated (WS_EX_NOACTIVATE) and never hit by the mouse: the game keeps
                    // keyboard, mouse and controller while the list is on screen.
                    let _ = win.set_focusable(false);
                    let _ = win.set_ignore_cursor_events(true);
                }
            }
            tracking::spawn(app.handle().clone());
            model::spawn(app.handle().clone());
            // Notices every switch to another program (browser, editor …) within 0.2 s, so our
            // own windows on top of the game never count as "the game is in view" after one.
            std::thread::Builder::new()
                .name("foreground-watch".into())
                .spawn(|| loop {
                    scan::game_in_view();
                    std::thread::sleep(std::time::Duration::from_millis(200));
                })
                .expect("failed to start foreground watcher");

            let handle = app.handle().clone();
            side_switch_watch(app.handle().clone());
            recorder_watch(app.handle().clone());

            // Continuous watching of the game window – only in the menus, never in a match.
            let watch_app = app.handle().clone();
            let watch_log = app.handle().clone();
            watch::spawn(
                move || {
                    let state = watch_app.state::<AppState>();
                    let e = speed::effective(&state.ui.lock().unwrap().tracking);
                    let session = *state.session.lock().unwrap();
                    let menus = matches!(session, session::GameSession::InUltimateTeam | session::GameSession::UtSelected | session::GameSession::MainMenu | session::GameSession::Unknown);
                    // While a recorder runs the one session stays open outside Ultimate Team too (not in
                    // a match), looking only every second: closing and reopening it is what disturbs a
                    // recording, and without it the screen probes can't see the game (live 2026-10-17:
                    // 20 minutes stuck in "other mode" while recording, every probe failed).
                    let steady = scan::STEADY.load(Ordering::Relaxed) && session != session::GameSession::InMatch && session != session::GameSession::Closed;
                    if steady && !menus {
                        return Some(std::time::Duration::from_millis(1000));
                    }
                    // also with another program in front: the game window is still read (no notices)
                    (e.continuous && menus).then(|| std::time::Duration::from_millis(e.watch_ms as u64))
                },
                move |line| tracking::log(&watch_log.state::<AppState>().data_dir, line),
            );

            gamepad::spawn(move |pad| {
                let h = handle.clone();
                // Windows must be managed from the main thread.
                let _ = handle.run_on_main_thread(move || match pad {
                    // In a match View / Create belongs to the game: nothing of ours pops up.
                    gamepad::Pad::ToggleOverlay | gamepad::Pad::ToggleMissing if in_match(&h) => {}
                    gamepad::Pad::ToggleOverlay => toggle_overlay(&h),
                    gamepad::Pad::ControllerChanged => {
                        let _ = h.emit("controller", gamepad::controller());
                    }
                    gamepad::Pad::ToggleMissing => toggle_missing(&h),
                    gamepad::Pad::Scroll(v) => {
                        if let Some(win) = h.get_webview_window(OVERLAY) {
                            if win.is_visible().unwrap_or(false) {
                                wake_overlay(&h, &win);
                                let _ = win.emit("pad-scroll", v);
                            }
                        }
                    }
                    // Navigation only while the overlay is open; otherwise the press is the game's.
                    // The overlay decides what "back" means (close a menu, leave a set, close).
                    gamepad::Pad::Nav(action) => {
                        if let Some(win) = h.get_webview_window(OVERLAY) {
                            if win.is_visible().unwrap_or(false) {
                                wake_overlay(&h, &win);
                                let _ = win.emit("pad", action);
                            }
                        }
                    }
                });
            }, {
                let dir = data_dir.clone();
                move |line| tracking::log(&dir, &line)
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            setup_status,
            set_borderless,
            game_running,
            launch_game,
            hide_overlay,
            bridge_info,
            open_site,
            autostart,
            set_autostart,
            unpair,
            set_locale,
            gallery_overview,
            set_first_owner,
            mark_swap_done,
            current_page,
            auto_scan,
            set_auto_scan,
            shopping_list,
            game_session,
            gallery_status,
            follow_set,
            toggle_missing_list,
            missing_list_visible,
            ui_prefs,
            set_overlay_mode,
            set_missing_side,
            diagnostics_status,
            set_diagnostics,
            open_diagnostics,
            set_after_play,
            sync_suggested,
            dismiss_sync_suggestion,
            tracking_speed,
            set_tracking_speed,
            sync_summary,
            start_sync,
            sync_and_launch,
            controller,
            open_help,
            updates::check_update,
            updates::install_update,
            cancel_sync,
            open_data_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while starting fc-tracker");
}
