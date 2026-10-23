//! Follows the in-game Gallery while the user plays and reads every set / swap page it sees.
//!
//! Loop (only while FC27 is the foreground window):
//! 1. capture pixels every `TICK` (BitBlt, no OCR – cheap);
//! 2. compare a coarse 64×36 brightness signature with the previous capture;
//! 3. when the page changed and then stayed still for one tick, OCR + analyse it once;
//!    a set page that doesn't verify against Base Grade (cards animate) is read again.
//!
//! Every analysed page is written to `tracking.log` in the app data folder (diagnostics).
//!
//! Our own windows are hidden while we capture (`scan::while_own_windows_hidden`), so the overlay
//! and the missing-players list can stay on screen.

use crate::lineup::{self, SetCard, SlotObs};
use crate::session::{self, GameSession};
use crate::scan::{self, Page};
use crate::{gallery_sets, AppState};
use serde::Serialize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Page-change watch: a 64×36 GDI-scaled signature (see `scan::capture_signature`, ≈35 ms of
/// mostly GPU read-back, no 20 MB copy) twice a second outside Ultimate Team …
const TICK: Duration = Duration::from_millis(500);
/// Animated screens (shimmering cards, moving backgrounds) are rarely "still": a page whose
/// signature changes at most this much for `CALM_TICKS` ticks in a row is read anyway – a
/// transition between pages changes far more.
const CALM: u32 = 12;
const CALM_TICKS: u32 = 2;
/// A page read while it still moved is read once more after this many calm ticks (~1 s), even
/// when it never gets fully still (holo shimmer).
const RECHECK_CALM_TICKS: u32 = 4;
/// Change without any moving tick that still counts as a new page (a slow fade into another
/// page); below it, still-but-drifting pages are not read again.
const DRIFT: u32 = 18;
const IDLE: Duration = Duration::from_millis(2500);
/// How often the resource use is written to tracking.log.
const USAGE_LOG: Duration = Duration::from_secs(60);
/// In a match the screen is only checked this often (half resolution), to notice the menus again.
const MATCH_PROBE: Duration = Duration::from_millis(5000);
/// % of the swap screen's left-panel cells that must change (another card highlighted).
const PREVIEW_CHANGED: u32 = 8;
/// Animated screens (the main menu's 3D lobby + video carousel) are never "still": they get a
/// cheap half-resolution read this often, only to know where the user is.
const PROBE: Duration = Duration::from_millis(3000);
const PROBE_FAST: Duration = Duration::from_millis(1000);
/// % of signature cells that must change before we call it a new page.
const CHANGED: u32 = 6;
/// % of cells allowed to differ between two ticks for the page to count as "still"
/// (animated special cards shimmer a little).
const STILL: u32 = 3;
/// Motion is measured over at least this long, whatever the look interval: the STILL / CALM /
/// CHANGED thresholds were tuned on 250 ms looks, and with 16 ms looks every single step of a
/// page transition is small – it would never count as moving.
const MOTION_WINDOW: Duration = Duration::from_millis(120);
/// Extra reads of a set page that didn't verify.
const RETRIES: u32 = 4;
const LOG_MAX_BYTES: u64 = 256 * 1024;

/// When to read the screen, from the cheap signature of each tick (pure, unit-tested).
///
/// - A page is read once it settled: still (≤ `STILL`) or calm (≤ `CALM`) for `CALM_TICKS`.
/// - It must differ from the last read page (≥ `CHANGED`), or the swap preview panel changed.
/// - Animated pages drift past `CHANGED` without any real transition; without a moving tick
///   (> `CALM`) since the last read such a drift is read only once the page is still – no endless
///   re-reads of shimmering cards, no throttle that could swallow a short New Items screen.
/// - A page read while it still moved (score counting up after a regrade) is read once more
///   when still or after ~1 s of calm.
#[derive(Default)]
pub(crate) struct ReadGate {
    calm_ticks: u32,
    moved: bool,
    recheck: bool,
    /// Ticks since the last read.
    since_read: u32,
    /// The last read came from drift alone: no second drift read before a real move.
    drifted: bool,
    /// Ticks in a row that were not settled.
    busy_ticks: u32,
    /// Busy ticks before a forced read (0 = `FORCE_FIRST`); doubles while the page keeps moving.
    force_after: u32,
    /// The last read page was on the transfer market: force reads sooner.
    pub(crate) urgent: bool,
    /// Unchanged looks in a row (for `GateCfg::still_ticks`).
    still_run: u32,
    /// Read delays in looks, from the tracking settings.
    pub(crate) cfg: crate::speed::GateCfg,
    /// Verification: looks until the same page is read once more (0 = none planned).
    verify_in: u32,
    /// The read this tick returned is that verification.
    pub(crate) verifying: bool,
    /// Ticks the due verification waited for a calm frame.
    verify_waited: u32,
}

/// A due verification read waits at most this many ticks for a calm frame.
const VERIFY_WAIT_MAX: u32 = 40;

impl ReadGate {
    /// `tick_change`: % change since the previous tick; `page_change`: since the last read page;
    /// `preview_changed`: the swap preview panel changed. Returns whether to read now.
    pub(crate) fn tick(&mut self, tick_change: u32, page_change: u32, preview_changed: bool) -> bool {
        self.verifying = false;
        // Verification: a planned second read of the same page (a pack, a purchase, a set page)
        // – catches what the first read missed. Dropped when the page changed meanwhile: the new
        // page gets its own read.
        if self.verify_in > 0 {
            // a real page change (not a moving 3D background behind New Items)
            if tick_change >= 35 {
                self.verify_in = 0;
            } else if self.verify_in > 1 {
                self.verify_in -= 1;
            } else if tick_change <= CALM {
                // due, on a calm frame: read (mid-scroll / mid-fade frames are misread)
                self.verify_in = 0;
                self.verify_waited = 0;
                self.verifying = true;
                self.since_read = 0;
                return true;
            } else {
                self.verify_waited += 1;
                if self.verify_waited >= VERIFY_WAIT_MAX {
                    self.verify_in = 0;
                    self.verify_waited = 0;
                }
            }
        }
        let still = tick_change <= STILL;
        self.still_run = if still { self.still_run + 1 } else { 0 };
        self.calm_ticks = if tick_change <= CALM { self.calm_ticks + 1 } else { 0 };
        self.moved |= tick_change > CALM;
        // still long enough (setting "still"), or calm for a while (shimmering cards)
        let calm_needed = CALM_TICKS.max(self.cfg.still_ticks);
        let settled = self.still_run >= self.cfg.still_ticks.max(1) || self.calm_ticks >= calm_needed;
        // A real change (a moving tick since the last read), or – without one – a page that drifted
        // far and is still: shimmering cards drift past CHANGED within seconds while still (live
        // log 2026-10-14: a set page re-read every 1–2 s, 25–50 % CPU).
        let new_page = (page_change >= CHANGED && self.moved) || (page_change >= DRIFT && still && !self.drifted) || preview_changed;
        self.since_read += 1;
        let recheck_due = self.recheck && tick_change <= CALM && (still || self.since_read >= RECHECK_CALM_TICKS);
        // Never settles (animated background): read it anyway after the setting's delay, and
        // again every time that passes while it keeps moving.
        self.busy_ticks = if settled { 0 } else { self.busy_ticks + 1 };
        let force_after = if self.urgent { self.cfg.market_ticks } else { self.cfg.animated_ticks }.max(1);
        let forced = !settled && self.busy_ticks >= force_after && page_change >= CHANGED && tick_change < 35;
        if forced {
            self.busy_ticks = 0;
            self.force_after = force_after;
            self.moved = false;
            self.since_read = 0;
            self.recheck = true;
            return true;
        }
        let read = settled && (new_page || recheck_due);
        if read {
            self.force_after = 0;
            // One recheck at most: a page that never gets still isn't re-read forever.
            self.recheck = !still && !recheck_due;
            self.drifted = !self.moved && !preview_changed && !recheck_due;
            self.moved = false;
            self.since_read = 0;
        }
        read
    }

    /// Plan a verification read of the current page after `ticks` looks.
    pub(crate) fn verify_after(&mut self, ticks: u32) {
        self.verify_in = ticks.max(1);
    }

    /// Read again on the next settled tick (a set page that didn't verify).
    pub(crate) fn retry(&mut self) {
        self.moved = true;
    }
}

/// The Gallery page the user is looking at (sent to the overlay as `page-changed`).
#[derive(Debug, Clone, Serialize)]
pub struct CurrentPage {
    /// "set" | "swap"
    pub kind: &'static str,
    pub set_key: String,
    pub set_name: String,
    /// Set page only: points sum matched the in-game Base Grade.
    pub verified: bool,
    pub cards_read: usize,
    /// First-owner facts that changed thanks to this page.
    pub facts_changed: usize,
    pub identified: usize,
    pub ambiguous: usize,
    /// Swap screen with the game's preview: our check + the best card for that slot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advice: Option<gallery_sets::SwapAdvice>,
    /// Cards on a New Items screen that add to a Gallery set.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub impacts: Vec<PackedCard>,
    /// Set page: our best lineup scores higher than the one in-game.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub better: Option<Better>,
    /// Incomplete set page: cards in the club that can fill its open slots.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<Fill>,
}

/// Open slots on an incomplete set that cards in the club can fill (live 2026-10-17: Newcastle 7/15
/// read with 3 more Newcastle cards in the club said "nothing to change").
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Fill {
    pub count: usize,
    /// Which cards and their points – only when certain (every read slot's points match exactly as
    /// many club cards as slots), else empty / None.
    pub names: Vec<String>,
    pub points: Option<u64>,
}

/// The club cards of a set that are not in the read lineup, for its open slots.
fn open_slot_fill(slots: usize, read: &std::collections::BTreeMap<u32, i32>, owned: &[SetCard], name: impl Fn(u64) -> Option<String>) -> Option<Fill> {
    let free = slots.checked_sub(read.values().map(|k| *k as usize).sum())?;
    let mut rest: Vec<&SetCard> = owned.iter().collect();
    let mut unknown = 0usize;
    let mut certain = true;
    for (p, k) in read {
        let k = *k as usize;
        let n = rest.iter().filter(|c| c.points == *p).count();
        if n > k {
            // more club cards with these points than slots: which ones are out is unknown
            certain = false;
            unknown += n - k;
        }
        rest.retain(|c| c.points != *p);
    }
    let count = free.min(rest.len() + unknown);
    if count == 0 {
        return None;
    }
    if !certain {
        return Some(Fill { count, names: Vec::new(), points: None });
    }
    rest.sort_by(|a, b| b.points.cmp(&a.points));
    let pick = &rest[..count];
    Some(Fill { count, names: pick.iter().filter_map(|c| name(c.def_id)).collect(), points: Some(pick.iter().map(|c| c.points as u64).sum()) })
}

#[derive(Debug, Clone, Serialize)]
pub struct Better {
    pub ingame: u64,
    pub best: u64,
    pub gain: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PackedCard {
    pub def_id: u64,
    pub name: String,
    pub rating: Option<u64>,
    /// Not in the Gallery yet.
    pub new: bool,
    /// The set it adds the most to, and how much.
    pub set: String,
    pub gain: u64,
    /// Counted as first owner (packed / reward) or not (bought).
    pub first_owner: bool,
    /// Already collected and known *not* first owner – this pack made it first owner (EA upgrades
    /// the Gallery card). Only when the old status was certain (in-game read or the user's mark).
    pub upgraded: bool,
    /// Packed and not first owner before (new card or upgrade): always worth a notice.
    pub new_first_owner: bool,
    /// A new card for an incomplete set: (cards in it afterwards, slots).
    pub fills: Option<(u32, u32)>,
}

pub fn spawn(app: AppHandle) {
    std::thread::Builder::new()
        .name("gallery-tracking".into())
        .spawn(move || {
            let mut last_sig: Vec<u8> = Vec::new();
            let mut analysed_sig: Vec<u8> = Vec::new();
            let mut retries = 0;
            let mut last_probe = std::time::Instant::now();
            let mut leave_votes = 0u8;
            // The last analysed page was a swap screen with the game's preview: moving the
            // highlight only changes the left panel, so watch that region more closely.
            let mut on_preview = false;
            let mut gate = ReadGate::default();
            let mut not_running = 0u32;
            // When the screen started to differ from the last read page, and when we last read.
            let mut changed_at: Option<std::time::Instant> = None;
            let mut last_running_check = std::time::Instant::now() - IDLE * 10;
            // Resource log: CPU share and memory of this process per minute, with the session.
            let mut usage_at = (std::time::Instant::now(), scan::own_usage().0);
            let mut was_in_view = true;
            // Signatures of the last looks, for motion over `MOTION_WINDOW`.
            let mut history: std::collections::VecDeque<(std::time::Instant, Vec<u8>)> = std::collections::VecDeque::new();
            // Verification reads: what the first read of the page said, and the last notice shown
            // (a second read must not show the same notice twice).
            let mut last_read_desc = String::new();
            let mut read_errors_logged = 0u32;
            // the last result notice per page (set / kind): the same page read again after Swap
            // Player and Back stays quiet unless its result changed (live 2026-10-17: Manchester
            // United said "nothing to change" again and again)
            let mut last_result: std::collections::HashMap<String, (String, std::time::Instant)> = std::collections::HashMap::new();
            let mut last_progress: std::collections::HashMap<String, std::time::Instant> = std::collections::HashMap::new();
            let mut last_notice: (String, std::time::Instant) = (String::new(), std::time::Instant::now());
            let (mut n_verified, mut n_corrected) = (0u32, 0u32);
            // GDI vs the game window (see scan::capture_signature_game): checked every ~2 s.
            let mut gdi_checked = std::time::Instant::now() - std::time::Duration::from_secs(60);
            let mut use_game_sig = false;
            // A recorder runs and we have no current picture of the game (the watcher sends none
            // and the screen copy is black or shows another program): since when, and told yet?
            let mut blind_since: Option<std::time::Instant> = None;
            let mut blind_told = false;
            // Minute diagnostics: ticks, reads, capture errors, signature source.
            let (mut n_ticks, mut n_reads, mut n_errors, mut n_game_sig, mut n_watched) = (0u32, 0u32, 0u32, 0u32, 0u32);
            loop {
                let state = app.state::<AppState>();
                if usage_at.0.elapsed() >= USAGE_LOG {
                    let (cpu_ms, ram_mb) = scan::own_usage();
                    let wall_ms = usage_at.0.elapsed().as_millis() as u64;
                    let pct = (cpu_ms.saturating_sub(usage_at.1)) as f64 * 100.0 / wall_ms.max(1) as f64;
                    let session = *state.session.lock().unwrap();
                    let overlay = app.get_webview_window("overlay").is_some_and(|w| w.is_visible().unwrap_or(false));
                    log(
                        &state.data_dir,
                        &format!(
                            "usage: {session:?}{} · cpu {pct:.1} % of one core · ram {ram_mb} MB · looks {n_ticks} (continuous {n_watched}, game window {n_game_sig}) reads {n_reads} (verified {n_verified}, corrected {n_corrected}) capture errors {n_errors}{}",
                            if overlay { " + overlay" } else { "" },
                            if state.auto_scan.load(Ordering::Relaxed) { "" } else { " · TRACKING OFF" }
                        ),
                    );
                    (n_ticks, n_reads, n_errors, n_game_sig, n_watched, n_verified, n_corrected) = (0, 0, 0, 0, 0, 0, 0);
                    usage_at = (std::time::Instant::now(), cpu_ms);
                }
                // The overlay takes focus; the game behind it is still what we read.
                let in_view = scan::game_in_view();
                // Another program in front (a recorder, a browser) but the game window still open:
                // keep reading the game window itself – a pack or a purchase must never be missed
                // (live 2026-10-17: the Snipping Tool in front paused reads during a pick). Only
                // the game's own picture then (never the screen copy, which shows the other
                // program) and no notices on top of the other program.
                let behind = !in_view && scan::game_window().is_some();
                if in_view != was_in_view {
                    was_in_view = in_view;
                    log(
                        &state.data_dir,
                        if in_view {
                            "view: the game is in view again – reading"
                        } else if behind {
                            "view: another program is in front – reading the game window behind it, no notices"
                        } else {
                            "view: the game is not on screen – reads paused"
                        },
                    );
                }
                if behind {
                    crate::hide_toast(&app);
                }
                if !in_view && !behind {
                    last_sig.clear();
                    // The toast belongs to the game screen it describes.
                    crate::hide_toast(&app);
                    on_preview = false;
                    // Closed game = sync is always safe. Checked every ~10 s (tasklist is not free).
                    if last_running_check.elapsed() > IDLE * 4 {
                        last_running_check = std::time::Instant::now();
                        let running = crate::game::is_running();
                        let current = *state.session.lock().unwrap();
                        // Closed only when two checks in a row (~20 s apart) find no game.
                        not_running = if running { 0 } else { not_running + 1 };
                        if not_running >= 2 && current != GameSession::Closed {
                            set_session(&app, GameSession::Closed);
                        } else if running && current == GameSession::Closed {
                            set_session(&app, GameSession::Unknown);
                        }
                        // Not seen yet (e.g. the app started while the game sat in the menu): look
                        // anyway – if the game is visible behind other windows, its menu is read.
                        if running && *state.session.lock().unwrap() == GameSession::Unknown {
                            probe_unknown(&app);
                        }
                    }
                    std::thread::sleep(IDLE);
                    continue;
                }
                if *state.session.lock().unwrap() == GameSession::Closed {
                    set_session(&app, GameSession::Unknown);
                }
                // Match mode: nothing of ours on screen, no page reads. The Champions tracker looks
                // at the scoreboard once per `match_ms` (and reads every frame after full time);
                // without it one cheap look every few seconds to see the menus again.
                if *state.session.lock().unwrap() == GameSession::InMatch {
                    last_sig.clear();
                    // Not a Champions match (Rivals, Squad Battles …): once it kicked off, the
                    // tracker stops looking – only the cheap probe below runs.
                    let other_match = !crate::champions::has_pending() && crate::champions::LIVE.lock().unwrap().as_ref().is_some_and(|l| l.kicked_off());
                    if state.ui.lock().unwrap().champions && !other_match {
                        let every = Duration::from_millis(crate::speed::effective(&state.ui.lock().unwrap().tracking).match_ms as u64);
                        let interval = crate::champions::LIVE.lock().unwrap().get_or_insert_with(Default::default).interval(every);
                        if last_probe.elapsed() >= interval {
                            last_probe = std::time::Instant::now();
                            match scan::capture_pixels_game() {
                                Ok((w, h, px)) => {
                                    let (seen, half) = crate::champions::LIVE.lock().unwrap().get_or_insert_with(Default::default).look(w, h, px, crate::store::now_ms());
                                    for s in seen {
                                        champions_feed(&app, s);
                                    }
                                    if let Some(frame) = half {
                                        observe_screen(&app, session::classify(&frame, &Page::Other), &mut leave_votes);
                                    }
                                }
                                Err(e) => {
                                    if read_errors_logged < 3 {
                                        read_errors_logged += 1;
                                        log(&state.data_dir, &format!("champions: no picture in the match ({e})"));
                                    }
                                }
                            }
                        }
                        std::thread::sleep(interval.min(TICK) / 2);
                        continue;
                    }
                    if last_probe.elapsed() >= MATCH_PROBE {
                        last_probe = std::time::Instant::now();
                        if let Ok((w2, h2, small)) = scan::capture_pixels_game().map(|(w, h, px)| scan::downscale2(w, h, &px)) {
                            if let Ok(frame) = scan::frame_from_pixels(w2, h2, small) {
                                observe_screen(&app, session::classify(&frame, &Page::Other), &mut leave_votes);
                            }
                        }
                    }
                    std::thread::sleep(TICK);
                    continue;
                }
                n_ticks += 1;
                let speed = crate::speed::effective(&state.ui.lock().unwrap().tracking);
                let look = Duration::from_millis(speed.watch_ms as u64);
                // The loop's real tick: the look interval wherever a Gallery screen can show up
                // (Unknown too – right after a restart the session isn't known yet), slower only in
                // the main menu / other modes. The gate counts ticks, so its delays use this length
                // (live 2026-10-17: 500 ms ticks against 100 ms delays made it 5× too slow and a
                // pack over a moving background was never read).
                let tick = match *state.session.lock().unwrap() {
                    GameSession::UtSelected | GameSession::InUltimateTeam | GameSession::Unknown => look,
                    _ => TICK.max(look),
                };
                let tick_ms = (tick.as_millis() as u32).max(1);
                gate.cfg = crate::speed::gate_cfg_for(&speed, tick_ms);
                // Continuous watching: the watcher's newest signature – no screen copy at all.
                let watched = if speed.continuous { crate::watch::fresh_signature(look * 4 + Duration::from_millis(500)) } else { None };
                let gdi = if watched.is_some() || behind { Err(String::new()) } else { scan::capture_signature() };
                // Trust check: GDI black, or GDI disagreeing with the game window → use the game
                // window's own picture until a check agrees again.
                if watched.is_none() && !behind && (gdi_checked.elapsed() >= std::time::Duration::from_secs(1) || gdi.as_ref().is_ok_and(|s| scan::signature_is_black(s))) {
                    gdi_checked = std::time::Instant::now();
                    if let Ok(game) = scan::capture_signature_game() {
                        let unreliable = match &gdi {
                            Ok(s) => scan::signature_is_black(s) || scan::signature_disagreement(s, &game) > 25,
                            Err(_) => true,
                        };
                        if unreliable != use_game_sig {
                            use_game_sig = unreliable;
                            log(&state.data_dir, if unreliable { "capture: the screen copy doesn't show the game (fullscreen-like presentation) – watching the game window instead" } else { "capture: the screen copy shows the game again" });
                        }
                    }
                }
                // Every wait visible: while recording, if we can't see the game, say so (once per spell)
                // (only in Ultimate Team, where pages are read – live 2026-10-17 the notice came on leaving it,
                // where the watcher is off on purpose)
                let in_ut = *state.session.lock().unwrap() == GameSession::InUltimateTeam;
                let blind = in_ut && scan::STEADY.load(Ordering::Relaxed) && watched.is_none() && (behind || use_game_sig || gdi.as_ref().map_or(true, |s| scan::signature_is_black(s)));
                if blind {
                    let since = *blind_since.get_or_insert_with(std::time::Instant::now);
                    if !blind_told && since.elapsed() >= Duration::from_secs(2) {
                        blind_told = true;
                        log(&state.data_dir, "recording: no current picture of the game – reads paused (notice shown)");
                        crate::show_notice(&app, serde_json::json!({ "kind": "recording" }), 10);
                    }
                } else if blind_since.take().is_some() && blind_told {
                    blind_told = false;
                    log(&state.data_dir, "recording: the game is visible again – reads resume");
                }
                let sig = if let Some(w) = watched {
                    n_watched += 1;
                    Ok(w)
                } else if (use_game_sig || behind) && !scan::STEADY.load(Ordering::Relaxed) {
                    n_game_sig += 1;
                    scan::capture_signature_game()
                } else if behind || use_game_sig {
                    // a recorder runs: no one-frame capture session, and the screen copy doesn't
                    // show the game (another program in front, or the game presented like
                    // fullscreen) – wait for the watcher
                    Err("recording_steady".into())
                } else {
                    gdi
                };
                let Ok(sig) = sig else {
                    n_errors += 1;
                    std::thread::sleep(if behind { look.max(Duration::from_millis(100)) } else { IDLE });
                    continue;
                };
                // motion over MOTION_WINDOW (not just since the previous look)
                let now = std::time::Instant::now();
                while history.len() > 1 && history.get(1).is_some_and(|(t, _)| now.duration_since(*t) >= MOTION_WINDOW) {
                    history.pop_front();
                }
                let tick_change = match history.front() {
                    _ if last_sig.is_empty() => 100,
                    Some((_, old)) => scan::signature_change(&sig, old),
                    None => 100,
                };
                history.push_back((now, sig.clone()));
                let page_change = scan::signature_change(&sig, &analysed_sig);
                let preview_changed = on_preview && scan::region_change(&sig, &analysed_sig, 2..21, 9..30) >= PREVIEW_CHANGED;
                if page_change >= CHANGED && changed_at.is_none() {
                    changed_at = Some(std::time::Instant::now());
                }
                last_sig = sig.clone();
                let still = tick_change <= STILL;
                if gate.tick(tick_change, page_change, preview_changed) {
                    n_reads += 1;
                    let shown_ms = changed_at.take().map_or(0, |t| t.elapsed().as_millis());
                    let read_start = std::time::Instant::now();
                    let previous = std::mem::replace(&mut analysed_sig, sig);
                    // The page settled: now the one full capture + OCR for it.
                    let pixels = if behind { scan::capture_pixels_game() } else { scan::capture_pixels() };
                    let frame = pixels.and_then(|(w, h, pixels)| scan::frame_from_pixels(w, h, pixels));
                    if let Err(e) = &frame {
                        // Not read = not seen: the page stays "new" and is read on the next tick
                        // (before, a failed capture counted as read and a pack could be lost).
                        analysed_sig = previous.clone();
                        gate.retry();
                        n_errors += 1;
                        if read_errors_logged < 3 {
                            read_errors_logged += 1;
                            log(&state.data_dir, &format!("read: no picture ({e}) – trying again"));
                        }
                    }
                    if let Ok(frame) = frame {
                        read_errors_logged = 0;
                        let page = scan::analyse_page(&frame).unwrap_or(Page::Other);
                        // Transfer market: watch extra closely – a purchase must never be missed.
                        gate.urgent = frame.has_word("TRANSFER")
                            || matches!(&page, Page::Bidding { .. } | Page::BuySuccess | Page::BuyConfirm { .. } | Page::Cards { context: "bought", .. });
                        observe_screen(&app, session::classify(&frame, &page), &mut leave_votes);
                        if matches!(page, Page::Other) {
                            champions_menu(&app, &frame);
                        }
                        on_preview = matches!(&page, Page::Swap { preview: Some(_), .. });
                        // A notice belongs to its screen: hide it on any other page.
                        if !matches!(&page, Page::Cards { context: "pack" | "bought", .. } | Page::Set { .. }) {
                            crate::hide_toast(&app);
                        }
                        // EA's Auto-Complete fills by points and can push first owners out: say so
                        // before the user confirms, and name the set the best selection is for
                        if matches!(page, Page::AutoComplete) && !behind {
                            let set = state.current_page.lock().unwrap().as_ref().map(|p| p.set_name.clone()).unwrap_or_default();
                            crate::show_notice(&app, serde_json::json!({ "kind": "autocomplete", "set_name": set }), 8);
                        }
                        let gallery = !matches!(page, Page::Other | Page::AutoComplete);
                        // Every wait visible: say what is being read before the model works on it
                        // (not for the second, verifying read of the same page, not behind another
                        // program).
                        // Only the first read of a page in a while says so: going into Swap Player and
                        // back, or flicking between sets, re-reads quietly (user 2026-10-17: a
                        // "Reading …" on every load is too much).
                        let mut progress_seq = None;
                        if !behind && !gate.verifying && state.auto_scan.load(Ordering::Relaxed) {
                            if let Some(p) = progress_notice(&page) {
                                let key = p.to_string();
                                if last_progress.get(&key).is_none_or(|at| at.elapsed() >= NOTICE_CALM) {
                                    last_progress.insert(key, std::time::Instant::now());
                                    crate::show_toast(&app, p);
                                    progress_seq = Some(crate::toast_seq());
                                }
                            }
                        }
                        let desc = describe(&page);
                        let source = *scan::LAST_SOURCE.lock().unwrap();
                        crate::diag::record(&frame, &format!("{}{desc}", if behind { "[game behind another program] " } else { "" }), source, shown_ms);
                        let verifying = gate.verifying;
                        if verifying {
                            n_verified += 1;
                            if desc != last_read_desc {
                                n_corrected += 1;
                                log(&state.data_dir, &format!("verify: the second read differs – {desc}"));
                            }
                        }
                        last_read_desc = desc;
                        if gallery && state.auto_scan.load(Ordering::Relaxed) {
                            if let Some(page) = process(&app, page, scan::read_coins(&frame)) {
                                // A pack, a purchase, a set page or a selection after Optimize: read
                                // it once more ~2 s later to catch what this read missed.
                                if !verifying && matches!(page.kind, "cards" | "bought" | "set" | "pending" | "bidding") {
                                    gate.verify_after(2000u32.div_ceil(tick_ms));
                                }
                                // the same notice twice (the verification read found nothing new): once
                                let notice_key = format!("{}:{:?}", page.kind, page.impacts.iter().map(|c| c.def_id).collect::<Vec<_>>());
                                let repeat = notice_key == last_notice.0 && last_notice.1.elapsed() < Duration::from_secs(60);
                                if !page.impacts.is_empty() {
                                    last_notice = (notice_key, std::time::Instant::now());
                                }
                                if page.kind == "set" && !page.verified && retries < RETRIES {
                                    // Read the same page again on the next tick.
                                    analysed_sig = previous;
                                    gate.retry();
                                    retries += 1;
                                } else {
                                    retries = 0;
                                }
                                if !page.set_key.is_empty() {
                                    *state.current_page.lock().unwrap() = Some(page.clone());
                                    crate::set_missing_set(&app, &page.set_key);
                                }
                                // the same notice for the same page within NOTICE_CALM: once (also after
                                // Swap Player → Back)
                                let page_key = format!("{}:{}", page.kind, page.set_key);
                                let mut fresh = |payload: &serde_json::Value| {
                                    let key = payload.to_string();
                                    let told = last_result.get(&page_key).is_some_and(|(k, at)| *k == key && at.elapsed() < NOTICE_CALM);
                                    if !told {
                                        last_result.insert(page_key.clone(), (key, std::time::Instant::now()));
                                    }
                                    !told
                                };
                                if behind {
                                    // read and stored, but no notice on top of another program
                                } else if let Some(better) = page.better.as_ref().filter(|b| b.gain == 0 && page.kind == "pending") {
                                    // in-game Optimize hit the best selection – say so before Confirm
                                    let p = serde_json::json!({ "kind": "optimized", "set_key": page.set_key, "set_name": page.set_name, "total": better.ingame });
                                    if fresh(&p) {
                                        crate::show_toast(&app, p);
                                    }
                                } else if let Some(better) = page.better.as_ref().filter(|b| b.gain > 0) {
                                    // The moment a set page is read: a better lineup exists.
                                    let p = serde_json::json!({ "kind": "better", "set_key": page.set_key, "set_name": page.set_name, "better": better });
                                    if fresh(&p) {
                                        crate::show_toast(&app, p);
                                    }
                                } else if page.kind == "cards" && !page.impacts.is_empty() && !repeat {
                                    let first_owner = page.impacts.iter().any(|c| c.first_owner);
                                    crate::show_toast(&app, serde_json::json!({ "kind": "pack", "cards": page.impacts, "regrade": true, "first_owner": first_owner }));
                                } else if page.kind == "bought" && !page.impacts.is_empty() && !repeat {
                                    *LAST_PURCHASE.lock().unwrap() = Some(std::time::Instant::now());
                                    // A purchase: the user moves on right away, so the notice stays a few seconds.
                                    crate::show_notice(&app, serde_json::json!({ "kind": "pack", "cards": page.impacts, "regrade": false, "first_owner": false }), 8);
                                } else if !verifying && matches!(page.kind, "set" | "pending" | "cards" | "bought" | "swap") {
                                    // Read, nothing to act on: say so – a silent read looks like no read.
                                    // Open slots the club can fill come first. (Once per page and
                                    // result: the same page read again stays quiet for 3 minutes.)
                                    let (notice, secs) = match &page.fill {
                                        Some(f) => (serde_json::json!({ "kind": "fill", "set_name": page.set_name, "count": f.count, "names": f.names, "points": f.points }), 8),
                                        None => (read_result_notice(&page), 4),
                                    };
                                    let after_purchase = matches!(page.kind, "cards" | "bought") && page.impacts.is_empty() && purchase_just_told();
                                    if !after_purchase && fresh(&notice) {
                                        crate::show_notice(&app, notice, secs);
                                    }
                                }
                                // "Reading …" with nothing after it (the result was told already):
                                // take it away – it must never hang
                                if progress_seq.is_some_and(|s| s == crate::toast_seq()) {
                                    crate::hide_toast(&app);
                                }
                                let _ = app.emit("page-changed", page);
                                log(&state.data_dir, &format!("  timing: on screen {shown_ms} ms before the read, read + processed in {} ms", read_start.elapsed().as_millis()));
                            }
                        }
                    }
                }
                if !still {
                    let current = *state.session.lock().unwrap();
                    let every = if current == GameSession::UtSelected { PROBE_FAST } else { PROBE };
                    if last_probe.elapsed() >= every {
                        last_probe = std::time::Instant::now();
                        if let Ok((w2, h2, small)) = scan::capture_pixels_game().map(|(w, h, px)| scan::downscale2(w, h, &px)) {
                            if let Ok(frame) = scan::frame_from_pixels(w2, h2, small) {
                                observe_screen(&app, session::classify(&frame, &Page::Other), &mut leave_votes);
                            }
                        }
                    }
                }
                std::thread::sleep(tick);
            }
        })
        .expect("failed to start gallery tracking thread");
}

/// One half-resolution read while the session is unknown. Only a recognised menu or Ultimate
/// Team screen changes anything (`Unknown` stays on any other screen), so a covered game is safe.
pub fn probe_unknown(app: &AppHandle) {
    if *app.state::<AppState>().session.lock().unwrap() != GameSession::Unknown {
        return;
    }
    // the game window's own picture only: a screen copy could show a browser or the Web App and
    // move the session on another program's screen
    let Ok((w, h, px)) = scan::capture_pixels_game() else { return };
    let (w2, h2, small) = scan::downscale2(w, h, &px);
    if let Ok(frame) = scan::frame_from_pixels(w2, h2, small) {
        let mut votes = 0;
        observe_screen(app, session::classify(&frame, &Page::Other), &mut votes);
    }
}

/// A whole-frame read in a menu or Ultimate Team: the Champions hub, the kit selection, a result
/// card still on screen after match mode ended.
fn champions_menu(app: &AppHandle, frame: &scan::Frame) {
    if !app.state::<AppState>().ui.lock().unwrap().champions {
        return;
    }
    if let Some(seen) = crate::champions::read_screen(&frame.words, Some(frame), crate::store::now_ms()) {
        champions_feed(app, seen);
    }
}

/// One Champions screen to the tracker: logged (no gamertags in the log), saved, sent to the UI.
fn champions_feed(app: &AppHandle, seen: crate::champions::Seen) {
    use crate::champions::Seen;
    let what = match &seen {
        Seen::Hub(h) => format!("hub {}W {}L {} left", h.wins, h.losses, h.remaining),
        Seen::KitChampions => "kit selection".into(),
        Seen::OpponentLeft => "opponent left before kickoff".into(),
        Seen::Versus { home, away } => format!("versus {:?} – {:?}", home.abbr, away.abbr),
        Seen::Board(b) => format!("score {} {}-{} {} at {:?}'", b.home_abbr, b.home, b.away, b.away_abbr, b.minute),
        Seen::Pause(p) => format!("pause menu at {:?}'", p.minute),
        Seen::Disconnect => "connection lost".into(),
        Seen::Result(c) => format!("result card {:?} win {:?}", c.score, c.win),
        Seen::RankWin => "rank screen: match win".into(),
    };
    let quiet = matches!(seen, Seen::Board(_) | Seen::Hub(_));
    let counted = |d: &crate::champions::Data| d.runs.iter().map(|r| r.matches.len()).sum::<usize>();
    let before = counted(&crate::champions::data());
    if let Some(d) = crate::champions::feed(seen) {
        log(&app.state::<AppState>().data_dir, &format!("champions: {what}"));
        let _ = app.emit("champions", &d);
        // a match was counted by the hub: say so there (never in a match)
        if counted(&d) > before && *app.state::<AppState>().session.lock().unwrap() != GameSession::InMatch {
            if let Some(run) = d.runs.last() {
                if let Some(m) = run.matches.last().filter(|m| !m.hub_only) {
                    crate::show_notice(app, crate::champions::notice(m, &run.hub), 8);
                }
            }
        }
    } else if !quiet {
        log(&app.state::<AppState>().data_dir, &format!("champions: {what} (no change)"));
    }
}

/// Updates the session from one classified screen. Leaving the main menu must be seen twice in a
/// row (one OCR miss on an animated menu must not stop a sync); a real Ultimate Team screen counts
/// at once.
fn observe_screen(app: &AppHandle, screen: session::Screen, leave_votes: &mut u8) {
    let current = *app.state::<AppState>().session.lock().unwrap();
    let next = current.next(screen);
    let in_menu = |s: GameSession| matches!(s, GameSession::MainMenu | GameSession::UtSelected);
    // Leaving the menu, or Ultimate Team → menu, must be seen twice (one misread screen must not
    // allow a sync while the user is in Ultimate Team)
    let leaving_menu = in_menu(current) && !in_menu(next) && screen != session::Screen::UltimateTeam;
    let leaving_ut = current == GameSession::InUltimateTeam && in_menu(next);
    if leaving_menu || leaving_ut {
        *leave_votes += 1;
        if *leave_votes < 2 {
            return;
        }
    }
    *leave_votes = 0;
    if next != current {
        set_session(app, next);
    }
}

/// Records where the user is in FC 27; entering Ultimate Team stops a running Web App sync
/// (the game needs the Ultimate Team session).
pub fn set_session(app: &AppHandle, next: GameSession) {
    let state = app.state::<AppState>();
    let previous = std::mem::replace(&mut *state.session.lock().unwrap(), next);
    if previous == next {
        return;
    }
    log(&state.data_dir, &format!("session: {previous:?} → {next:?}"));
    // the game started: remember where it runs from, for the launcher's next start
    if previous == GameSession::Closed && next != GameSession::Closed {
        crate::remember_game_exe(app);
    }
    // A new match (or its end): the Champions looks start over.
    if next == GameSession::InMatch || previous == GameSession::InMatch {
        *crate::champions::LIVE.lock().unwrap() = None;
    }
    // A match starts: step aside (no window of ours over the game – Windows can then present
    // it like fullscreen). After it: the missing list comes back if it was open.
    if next == GameSession::InMatch {
        crate::enter_match_mode(app);
    } else if matches!(next, GameSession::InUltimateTeam | GameSession::MainMenu | GameSession::UtSelected) {
        // Back in a menu (also via Closed/Unknown, e.g. the game lost focus mid-match).
        crate::leave_match_mode(app);
    }
    // While a sync runs, the game only has to stay out of Ultimate Team: starting the game
    // (Closed → Unknown) and its menus are fine – a notice on top says to wait.
    let (syncing, blocked) = {
        let s = state.store.lock().unwrap();
        (s.sync_active, s.sync_blocked.clone())
    };
    if syncing && next != GameSession::Closed && (next.sync_allowed() || next == GameSession::Unknown) {
        // Not signed in to the Web App: the sync waits for the user – say that, not "running".
        let notice = match &blocked {
            Some(reason) => serde_json::json!({ "kind": "sync", "state": "login", "reason": reason }),
            None => serde_json::json!({ "kind": "sync", "state": "running" }),
        };
        crate::show_notice(app, notice, if blocked.is_some() { 900 } else { 600 });
    }
    if next == GameSession::InUltimateTeam {
        state.played_ut.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    // The game closed after Ultimate Team: catch up on the club right away.
    if next == GameSession::Closed {
        state.welcomed.store(false, std::sync::atomic::Ordering::SeqCst);
        crate::sync_after_play(app);
    }
    if next == GameSession::InUltimateTeam {
        let aborted = {
            let mut store = state.store.lock().unwrap();
            let was = store.sync_active;
            if was {
                store.abandon_sync();
                store.sync_abort = true;
            }
            was
        };
        if aborted {
            log(&state.data_dir, "sync stopped: the user entered Ultimate Team");
            crate::show_notice(app, serde_json::json!({ "kind": "sync", "state": "aborted" }), 10);
            let _ = app.emit("sync-aborted", ());
        } else if !state.welcomed.swap(true, std::sync::atomic::Ordering::SeqCst) {
            // Ultimate Team is loaded: say FC-Tracker is running (once per game run)
            let players = state.store.lock().unwrap().summary().player_count;
            crate::show_notice(app, serde_json::json!({ "kind": "welcome", "players": players }), 6);
        }
    }
    let _ = app.emit("game-session", next);
}

/// When a purchase was last confirmed (by the coins or the success dialog): its New Items screen
/// right after must not say "nothing new" over the purchase notice (live 2026-10-17: Oblak bought,
/// "+8,881 for Atlético" replaced by "Nothing new for your Gallery" in the same tick).
static LAST_PURCHASE: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

fn purchase_just_told() -> bool {
    LAST_PURCHASE.lock().unwrap().is_some_and(|at| at.elapsed() < Duration::from_secs(60))
}

/// The same notice for the same page is shown once within this time (progress, better
/// selection, read result) – unless its content changes.
const NOTICE_CALM: Duration = Duration::from_secs(180);

/// "Reading …" for a page the model now works on (set page, Swap Player, New Items, Bidding).
fn progress_notice(page: &Page) -> Option<serde_json::Value> {
    let set = |title: &str| gallery_sets::find_set_by_title(title).map(|s| s.name);
    let (what, name) = match page {
        Page::Set { title, .. } | Page::Pending { title, .. } => ("set", set(title)),
        Page::Swap { title, .. } => ("swap", set(title)),
        Page::Cards { context: "pack" | "bought", .. } => ("new_items", None),
        Page::Bidding { card, .. } => ("bidding", Some(card.name.clone())),
        _ => return None,
    };
    if what != "new_items" && what != "bidding" && name.is_none() {
        return None;
    }
    Some(serde_json::json!({ "kind": "progress", "what": what, "name": name }))
}

/// The result of a read that needs no action: "✓ Premier League read · your selection is the best",
/// "✓ New Items read · nothing new for your Gallery", "✓ Swap Player read · 12 cards".
fn read_result_notice(page: &CurrentPage) -> serde_json::Value {
    let state = match (page.kind, &page.better) {
        ("set" | "pending", Some(b)) if b.gain == 0 => "best",
        ("set" | "pending", _) if !page.verified => "unclear",
        ("set" | "pending", _) => "read",
        ("cards" | "bought", _) => "nothing_new",
        ("swap", _) => "swap",
        _ => "read",
    };
    serde_json::json!({ "kind": "read", "state": state, "set_name": page.set_name, "cards": page.cards_read, "identified": page.identified,
        "total": page.better.as_ref().map(|b| b.ingame) })
}

/// Reads one Gallery page into the store.
pub fn process(app: &AppHandle, page: Page, coins: Option<u32>) -> Option<CurrentPage> {
    let state = app.state::<AppState>();
    let what = describe(&page);
    let (result, bought) = {
        let mut store = state.store.lock().unwrap();
        // A purchase confirmed by the coins: any screen after the purchase showing the balance
        // minus the Buy Now price (the user may skip the dialogs and New Items entirely). First,
        // because the same screen can set up the next purchase (the club search's transfer panel
        // shows the new balance and the next card).
        let bought = coins.and_then(|c| confirm_by_coins(&mut store, c));
        store.last_coins = coins.or(store.last_coins);
        if let Some(c) = coins {
            store.note_coins(c as u64, crate::store::now_ms());
        }
        let result = process_page(&mut store, page);
        (result, bought)
    };
    if let Some(page) = &bought {
        *LAST_PURCHASE.lock().unwrap() = Some(std::time::Instant::now());
        log(&state.data_dir, &format!("purchase confirmed by the coins → {} {}", page.set_name, page.impacts.iter().map(|c| format!("{} +{}", c.set, c.gain)).collect::<Vec<_>>().join(", ")));
        if !page.impacts.is_empty() {
            crate::show_notice(app, serde_json::json!({ "kind": "pack", "cards": page.impacts, "regrade": false, "first_owner": false }), 8);
        }
        let _ = app.emit("page-changed", page.clone());
    }
    let outcome = match &result {
        Some(p) => format!(
            "→ {} ({}) verified={} cards={} identified={} ambiguous={} facts={}",
            p.set_name, p.kind, p.verified, p.cards_read, p.identified, p.ambiguous, p.facts_changed
        ),
        None => "→ not a known Gallery page".into(),
    };
    log(&state.data_dir, &format!("{what} {outcome}"));
    result
}

fn describe(page: &Page) -> String {
    match page {
        Page::Set { title, total, base, cards, .. } => format!(
            "SET {title:?} total={total:?} base={base:?} points=[{}]",
            cards
                .iter()
                .map(|c| format!("{}{}", c.points.map_or("?".into(), |p| p.to_string()), if c.first_owner { "*" } else { "" }))
                .collect::<Vec<_>>()
                .join(" ")
        ),
        Page::Swap { title, cards, .. } => format!(
            "SWAP {title:?} cards=[{}]",
            cards.iter().map(|c| format!("{}{}", c.name, if c.first_owner { "*" } else { "" })).collect::<Vec<_>>().join(", ")
        ),
        Page::Pending { title, set } => format!("PENDING {title:?} (not confirmed in-game{})", if set.is_some() { " – selection read, marked unconfirmed" } else { " – not readable" }),
        Page::SetList { tiles } => format!(
            "LIST [{}]",
            tiles
                .iter()
                .map(|t| match (t.score, t.filled) {
                    (Some(s), _) => format!("{}={s}", t.title),
                    (_, Some((a, b))) => format!("{}={a}/{b}", t.title),
                    _ => t.title.clone(),
                })
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Page::Summary(s) => format!("SUMMARY {s:?}"),
        Page::Cards { context, cards } => format!(
            "CARDS {context} [{}]",
            cards.iter().map(|c| format!("{} {}", c.name, c.rating.map_or("?".into(), |r| r.to_string()))).collect::<Vec<_>>().join(", ")
        ),
        Page::Bidding { card, price } => format!("BIDDING {} {:?} price {:?}", card.name, card.rating, price),
        Page::BuySuccess => "BUY SUCCESS".into(),
        Page::BuyConfirm { price } => format!("BUY CONFIRM price {price:?}"),
        Page::OwnedActions { name, points } => format!("OWNED ACTIONS {name} points {points:?}"),
        Page::Other => "OTHER".into(),
        Page::AutoComplete => "AUTO-COMPLETE question".into(),
    }
}

/// Appends one line to `tracking.log` (restarted when it grows past `LOG_MAX_BYTES`).
pub fn log(dir: &std::path::Path, line: &str) {
    use std::io::Write;
    let path = dir.join("tracking.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_MAX_BYTES) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let secs = crate::store::now_ms() / 1000;
        let _ = writeln!(f, "{secs} {line}");
    }
}

/// A lineup stored before the strict Base Grade check may hold misreads that cancelled out in
/// the sum (seen 2026-10-13). Such an observation is no longer trusted.
pub fn revalidate(store: &mut crate::store::Store) -> usize {
    let mut dropped = 0;
    let keys: Vec<String> = store.snapshot.set_obs.keys().cloned().collect();
    for key in keys {
        let Some(set) = gallery_sets::set_by_key(&key) else { continue };
        let mut available: std::collections::BTreeMap<u32, usize> = std::collections::BTreeMap::new();
        // Every card of the set: a verified lineup may hold cards we only know from that page
        // (bought without us seeing it) – they are proven by the Base Grade, not misreads.
        for c in gallery_sets::cards_of_set(&set, &store.snapshot.gallery, &store.snapshot.team_links) {
            *available.entry(c.score as u32).or_default() += 1;
        }
        let Some(obs) = store.snapshot.set_obs.get_mut(&key) else { continue };
        if !obs.verified || available.is_empty() {
            continue;
        }
        let mut used: std::collections::BTreeMap<u32, usize> = std::collections::BTreeMap::new();
        for s in &obs.slots {
            *used.entry(s.points).or_default() += 1;
        }
        if !used.iter().all(|(p, n)| available.get(p).is_some_and(|have| n <= have)) {
            obs.verified = false;
            obs.identified.clear();
            dropped += 1;
        }
    }
    // Category tiles with a score no lineup of the set can reach (misreads of other windows).
    let tiles: Vec<String> = store.snapshot.set_list.keys().cloned().collect();
    for key in tiles {
        let Some(set) = gallery_sets::set_by_key(&key) else { continue };
        let cap = gallery_sets::base_cap(&set, &store.snapshot.gallery, &store.snapshot.team_links) * 4;
        if store.snapshot.set_list.get(&key).and_then(|l| l.score).is_some_and(|s| cap > 0 && s as u64 > cap) {
            store.snapshot.set_list.remove(&key);
            dropped += 1;
        }
    }
    if dropped > 0 {
        store.snapshot.first_owner_version += 1;
        store.save();
    }
    dropped
}

/// Store side of `process` (separate so it can be tested without a running app).
pub fn process_page(store: &mut crate::store::Store, page: Page) -> Option<CurrentPage> {
    match page {
        Page::Set { title, total, base, bonus, mut cards } => {
            let set = gallery_sets::find_set_by_title(&title)?;
            let to_set_card = |c: &crate::store::GalleryCard| SetCard {
                def_id: c.def_id,
                points: c.score as u32,
                rating: c.rating.map(|r| r as u32),
                position: c.position.clone(),
                nation: c.nation,
            };
            let all_cards: Vec<SetCard> =
                gallery_sets::cards_of_set(&set, &store.snapshot.gallery, &store.snapshot.team_links).into_iter().map(to_set_card).collect();
            let availability = |cs: &[&SetCard]| {
                let mut m = std::collections::BTreeMap::new();
                for c in cs {
                    *m.entry(c.points).or_insert(0usize) += 1;
                }
                m
            };
            let collected = |store: &crate::store::Store, id: u64| store.snapshot.gallery.get(&id).is_some_and(|c| c.collected);
            let owned: Vec<&SetCard> = all_cards.iter().filter(|c| collected(store, c.def_id)).collect();
            let mut verified = scan::resolve_points(&mut cards, &availability(&owned), base);
            // Slots whose card we can't name from what the user is known to own: the points are
            // proven, but no first-owner facts or flags are taken from this read.
            let mut unnamed = false;
            if !verified {
                // The lineup itself proves ownership: cards bought without us seeing New Items
                // (stored straight away, autofill) sit in it. Read the chips against every card of
                // the set; when that adds up to the Base Grade, cards that are certainly in the
                // lineup (the only cards with that points + rating) are marked collected.
                let mut wide = cards.clone();
                let every: Vec<&SetCard> = all_cards.iter().collect();
                if scan::resolve_points(&mut wide, &availability(&every), base) {
                    let slots: Vec<SlotObs> = wide
                        .iter()
                        .filter_map(|c| Some(SlotObs { points: c.points?, rating: c.rating, position: c.position.clone(), first_owner: c.first_owner, flag: Some(c.flag.clone()), uncertain: !c.first_owner && c.marker_score >= scan::TRIANGLE_GRAY }))
                        .collect();
                    let unselected = store.snapshot.set_obs.get(&set.key).map(|o| o.unselected.clone()).unwrap_or_default();
                    // No flag guesses here: only "the only card with these points + rating" counts
                    // as proof, and only on a complete set (sum checked against the Base Grade).
                    let id = lineup::identify(&slots, &all_cards, &unselected, false, &Default::default());
                    // A complete set proves its chips by the Base Grade sum. An incomplete one
                    // (no Base Grade) only where the slot's rating was read too and matches the
                    // card – the only card with these points + rating (Nnadozie 2,100 · 85).
                    let rating_of = |d: u64| all_cards.iter().find(|c| c.def_id == d).and_then(|c| c.rating);
                    let newly: Vec<u64> = id
                        .slots
                        .iter()
                        .filter(|(_, d)| !collected(store, **d))
                        .filter(|(slot, d)| base.is_some() || slots.get(**slot).and_then(|s| s.rating).is_some_and(|r| Some(r) == rating_of(**d)))
                        .map(|(_, d)| *d)
                        .collect();
                    if store.mark_collected(&newly) > 0 {
                        log(store.dir(), &format!("set page {}: {} card(s) in the lineup were not known as collected → collected", set.name, newly.len()));
                    }
                    let owned: Vec<&SetCard> = all_cards.iter().filter(|c| collected(store, c.def_id)).collect();
                    verified = scan::resolve_points(&mut cards, &availability(&owned), base);
                    if !verified {
                        // Still cards we can't name: the reading itself is proven – keep it, the
                        // unnamed slots stay anonymous.
                        cards = wide;
                        verified = true;
                        unnamed = true;
                    }
                }
            }
            let set_cards: Vec<SetCard> = all_cards.iter().filter(|c| collected(store, c.def_id)).cloned().collect();
            let slots: Vec<SlotObs> = cards
                .iter()
                .filter_map(|c| {
                    Some(SlotObs { points: c.points?, rating: c.rating, position: c.position.clone(), first_owner: c.first_owner, flag: Some(c.flag.clone()), uncertain: !c.first_owner && c.marker_score >= scan::TRIANGLE_GRAY })
                })
                .collect();
            // Before this read replaces the lineup: what we knew, and what we suggested swapping.
            let points_of = |v: &[SlotObs]| {
                let mut m = std::collections::BTreeMap::<u32, i32>::new();
                for o in v {
                    *m.entry(o.points).or_default() += 1;
                }
                m
            };
            let old = store.snapshot.set_obs.get(&set.key).filter(|o| o.verified && !o.slots.is_empty()).cloned();
            let lineup_changed = old.as_ref().is_some_and(|o| points_of(&o.slots) != points_of(&slots));
            let suggested: Vec<gallery_sets::SwapSuggestion> = if verified && lineup_changed {
                let snap = &store.snapshot;
                let fo = gallery_sets::FirstOwnerInfo { known: &snap.first_owner, manual: &snap.first_owner_manual, scanned: &snap.first_owner_scanned, club_no: &snap.first_owner_club_no };
                gallery_sets::set_summary(&set.key, &snap.gallery, &fo, &snap.team_links, &snap.set_obs, &snap.prices, &snap.set_list).map(|s| s.swaps).unwrap_or_default()
            } else {
                Vec::new()
            };
            let new_points = points_of(&slots);
            // an incomplete set (no total) with open slots: can the club fill them?
            let fill = if verified && total.is_none() {
                open_slot_fill(set.slots, &new_points, &set_cards, |id| store.snapshot.gallery.get(&id).and_then(|c| c.name.clone()))
            } else {
                None
            };
            store.observe_set_page(&set.key, slots, verified, total, base, bonus);
            if verified {
                if let Some(o) = store.snapshot.set_obs.get_mut(&set.key) {
                    o.unnamed = unnamed;
                }
            }
            store.enforce_box(&set.key, &owned_by_points(&set_cards));
            // Swaps we suggested that the new lineup shows done (in-game Swap Player or Optimize):
            // their out cards are in the box now, their in cards in the lineup.
            if let Some(old) = &old {
                let mut counts = points_of(&old.slots);
                let mut box_in = Vec::new();
                let mut box_out = Vec::new();
                for sw in &suggested {
                    let (out_p, in_p) = (sw.out.score as u32, sw.into.score as u32);
                    let out_left = counts.get(&out_p).copied().unwrap_or(0) > new_points.get(&out_p).copied().unwrap_or(0);
                    let in_came = counts.get(&in_p).copied().unwrap_or(0) < new_points.get(&in_p).copied().unwrap_or(0);
                    if out_left && in_came {
                        *counts.entry(out_p).or_default() -= 1;
                        *counts.entry(in_p).or_default() += 1;
                        if sw.out.slot.is_none() {
                            box_in.push(sw.out.def_id);
                        }
                        box_out.push(sw.into.def_id);
                    }
                }
                if let Some(o) = store.snapshot.set_obs.get_mut(&set.key) {
                    for id in &box_out {
                        o.unselected.remove(id);
                    }
                    o.unselected.extend(box_in.iter().copied());
                    if !box_in.is_empty() || !box_out.is_empty() {
                        store.dirty = true;
                    }
                }
                if !box_in.is_empty() {
                    log(store.dir(), &format!("set page {}: {} suggested swap(s) done in-game – their out cards are in the box", set.name, box_in.len()));
                }
            }
            let (mut identified, mut ambiguous, mut facts_changed) = identify_and_apply(store, &set.key, &set_cards, verified);
            // Known cards that left a lineup we now know in full are in the box too.
            if let (Some(old), true) = (&old, verified) {
                let now_ids: std::collections::BTreeSet<u64> =
                    store.snapshot.set_obs.get(&set.key).map(|o| o.identified.values().copied().collect()).unwrap_or_default();
                let full = store.snapshot.set_obs.get(&set.key).is_some_and(|o| o.identified.len() == o.slots.len());
                let left: Vec<u64> = old.identified.values().copied().filter(|id| !now_ids.contains(id)).collect();
                if full && !left.is_empty() {
                    if let Some(o) = store.snapshot.set_obs.get_mut(&set.key) {
                        o.unselected.extend(left.iter().copied());
                    }
                    store.dirty = true;
                    let again = identify_and_apply(store, &set.key, &set_cards, verified);
                    (identified, ambiguous) = (again.0, again.1);
                    facts_changed += again.2;
                }
            }
            // Better lineup than the one in-game? Known the moment the page is read.
            let better = total.filter(|_| verified).and_then(|ingame| {
                let snap = &store.snapshot;
                let fo = gallery_sets::FirstOwnerInfo { known: &snap.first_owner, manual: &snap.first_owner_manual, scanned: &snap.first_owner_scanned, club_no: &snap.first_owner_club_no };
                // Only when our model gives exactly the game's score for the lineup on screen –
                // tag rules differ per set (Holographics has no First Owner tag), so no claim
                // without that proof.
                let model = gallery_sets::ingame_model_total(&set.key, &snap.gallery, &fo, &snap.team_links, &snap.set_obs)?;
                if model != ingame as u64 {
                    return None;
                }
                let s = gallery_sets::set_summary(&set.key, &snap.gallery, &fo, &snap.team_links, &snap.set_obs, &snap.prices, &snap.set_list)?;
                // gain 0 = proven already the best (shown after in-game Optimize)
                (s.best_model >= ingame as u64).then(|| Better { ingame: ingame as u64, best: s.best_model, gain: s.best_model - ingame as u64 })
            });
            Some(CurrentPage {
                kind: "set",
                set_key: set.key,
                set_name: set.name,
                verified,
                cards_read: cards.len(),
                facts_changed,
                identified,
                ambiguous,
                advice: None,
                impacts: Vec::new(),
                better,
                fill,
            })
        }
        Page::Swap { title, cards, preview } => {
            let set = gallery_sets::find_set_by_title(&title)?;
            let to_candidate = |c: &crate::store::GalleryCard| {
                Some(scan::Candidate { def_id: c.def_id, name: c.name.clone()?, rating: c.rating.map(|r| r as u32), points: c.score as u32 })
            };
            let of_set = gallery_sets::cards_of_set(&set, &store.snapshot.gallery, &store.snapshot.team_links);
            let candidates: Vec<scan::Candidate> = of_set.iter().filter(|c| c.collected).filter_map(|c| to_candidate(c)).collect();
            let everyone: Vec<scan::Candidate> = of_set.iter().filter_map(|c| to_candidate(c)).collect();
            // Every card on Swap Player is owned: one we didn't know as collected (a purchase we
            // missed) is matched against the whole set – exact name, points and rating.
            let matched: Vec<(u64, bool)> = cards
                .iter()
                .filter_map(|s| {
                    let m = scan::match_card(s, &candidates).map(|m| m.def_id).or_else(|| {
                        // Strict for cards we didn't know as owned: exact name, points and rating.
                        let (points, rating) = (s.points?, s.rating?);
                        let name = scan::normalise_name(&s.name);
                        match everyone.iter().filter(|c| scan::normalise_name(&c.name) == name && c.points == points && c.rating == Some(rating)).collect::<Vec<_>>().as_slice() {
                            [one] => Some(one.def_id),
                            _ => None,
                        }
                    }).or_else(|| {
                        // same name, rating and points, different nations: the card's flag decides
                        let pool: Vec<u64> = scan::exact_name_matches(s, &candidates).iter().map(|c| c.def_id).collect();
                        (pool.len() >= 2).then(|| pick_by_flag(store, s.flag.as_ref()?, &pool)).flatten()
                    })?;
                    Some((m, s.first_owner))
                })
                .collect();
            // cards named for certain teach the flag of their nation as it looks on cards
            for s in cards.iter() {
                if scan::exact_name_matches(s, &everyone).len() != 1 {
                    continue;
                }
                let Some(m) = scan::match_card(s, &everyone).map(|m| m.def_id) else { continue };
                if let (Some(flag), Some(nation)) = (s.flag.as_ref(), store.snapshot.gallery.get(&m).and_then(|c| c.nation)) {
                    store.learn_card_flag(nation, flag);
                }
            }
            let newly: Vec<u64> = matched.iter().map(|(id, _)| *id).filter(|id| !candidates.iter().any(|c| c.def_id == *id)).collect();
            if store.mark_collected(&newly) > 0 {
                log(store.dir(), &format!("swap page {}: {} card(s) not known as collected → collected", set.name, newly.len()));
            }
            let mut facts_changed = store.apply_scan(&matched);
            store.observe_swap_page(&set.key, &matched.iter().map(|(id, _)| *id).collect::<Vec<_>>());
            let set_cards: Vec<SetCard> = gallery_sets::cards_of_set(&set, &store.snapshot.gallery, &store.snapshot.team_links)
                .into_iter()
                .filter(|c| c.collected)
                .map(|c| SetCard { def_id: c.def_id, points: c.score as u32, rating: c.rating.map(|r| r as u32), position: c.position.clone(), nation: c.nation })
                .collect();
            store.enforce_box(&set.key, &owned_by_points(&set_cards));
            let verified = store.snapshot.set_obs.get(&set.key).is_some_and(|o| o.verified);
            let (identified, ambiguous, more) = identify_and_apply(store, &set.key, &set_cards, verified);
            facts_changed += more;
            // The box and newly known cards are kept even when nothing else changed.
            store.save();
            let advice = preview.as_ref().and_then(|p| advice_for(store, &set.key, p, &cards, &candidates));
            Some(CurrentPage {
                kind: "swap",
                set_key: set.key,
                set_name: set.name,
                verified,
                cards_read: cards.len(),
                facts_changed,
                identified,
                ambiguous,
                advice,
                impacts: Vec::new(),
                better: None,
                fill: None,
            })
        }
        Page::Pending { title, set: Some(inner) } => {
            // Not confirmed in-game yet (e.g. right after Optimize): read like a set page, kept as
            // unconfirmed – the next confirmed read of the set replaces it.
            let mut page = process_page(store, *inner)?;
            if let Some(o) = store.snapshot.set_obs.get_mut(&page.set_key) {
                o.user_swapped = true;
                store.dirty = true;
            }
            let _ = &title;
            page.kind = "pending";
            Some(page)
        }
        Page::Pending { title, set: None } => {
            // The lineup on screen isn't saved in-game yet and couldn't be read: never stored.
            let set = gallery_sets::find_set_by_title(&title)?;
            Some(CurrentPage { kind: "pending", set_key: set.key, set_name: set.name, verified: false, cards_read: 0, facts_changed: 0, identified: 0, ambiguous: 0, advice: None, impacts: Vec::new(), better: None, fill: None })
        }
        Page::SetList { tiles } => {
            let mut read = 0;
            for t in &tiles {
                let Some(set) = gallery_sets::find_set_by_title(&t.title) else {
                    // A real tile (a score or filled/slots under it) with a name the list doesn't
                    // have: a Gallery set EA added since the list was written.
                    if (t.score.is_some() || t.filled.is_some()) && !gallery_sets::is_category_name(&t.title) && store.note_unknown_set(&t.title) {
                        log(store.dir(), &format!("unknown Gallery set on a category page: {:?} (set list revision {})", t.title, gallery_sets::revision()));
                    }
                    continue;
                };
                // A score no lineup of this set can reach is a misread: the bonus never reaches
                // 4× the base (Premier League: 69,302 base, 149,939 bonus).
                let cap = gallery_sets::base_cap(&set, &store.snapshot.gallery, &store.snapshot.team_links) * 4;
                if t.score.is_some_and(|s| cap > 0 && s as u64 > cap) || t.filled.is_some_and(|(f, n)| f > n || n as usize != set.slots) {
                    continue;
                }
                store.observe_list_tile(&set.key, t.score, t.filled);
                read += 1;
            }
            store.save();
            (read > 0).then(|| CurrentPage {
                kind: "list",
                set_key: String::new(),
                set_name: String::new(),
                verified: true,
                cards_read: read,
                facts_changed: 0,
                identified: 0,
                ambiguous: 0,
                advice: None,
                impacts: Vec::new(),
                better: None,
                fill: None,
            })
        }
        Page::Summary(s) => {
            store.observe_summary(s);
            store.save();
            Some(CurrentPage { kind: "summary", set_key: String::new(), set_name: String::new(), verified: true, cards_read: 0, facts_changed: 0, identified: 0, ambiguous: 0, advice: None, impacts: Vec::new(), better: None, fill: None })
        }
        Page::Cards { context, cards } => {
            // Only New Items screens are acquisitions; other card lists are never counted.
            if context == "other" {
                return None;
            }
            let impacts = cards_impact(store, context, &cards);
            Some(CurrentPage {
                kind: "cards",
                set_key: String::new(),
                // The screen context ("pack" | "unassigned" | "other") for the toast.
                set_name: context.to_string(),
                verified: false,
                cards_read: cards.len(),
                facts_changed: 0,
                identified: impacts.len(),
                ambiguous: 0,
                advice: None,
                impacts,
                better: None,
                fill: None,
            })
        }
        Page::Bidding { card, price } => {
            // The card about to be bought: remembered until the purchase is confirmed.
            let ids = match_cards(store, std::slice::from_ref(&card));
            let def_id = *ids.first()?;
            // A card already in the Gallery changes nothing when bought again (and the panel is
            // shown again right after a purchase – no second "purchase" of the same card).
            if store.snapshot.gallery.get(&def_id).is_some_and(|c| c.collected) {
                return None;
            }
            store.pending_buy = Some(crate::store::PendingBuy { def_id, price, coins_before: store.last_coins, at: std::time::Instant::now() });
            let name = store.snapshot.gallery.get(&def_id).and_then(|c| c.name.clone()).unwrap_or_default();
            Some(CurrentPage { kind: "bidding", set_key: String::new(), set_name: name, verified: false, cards_read: 1, facts_changed: 0, identified: 1, ambiguous: 0, advice: None, impacts: Vec::new(), better: None, fill: None })
        }
        Page::BuySuccess => {
            let pending = store.pending_buy.take().filter(|p| p.at.elapsed() < crate::store::PendingBuy::KEEP)?;
            Some(bought_page(store, pending.def_id))
        }
        // "Get this item for 700 FUT Coins?": the price the coins will drop by.
        Page::BuyConfirm { price } => {
            if let (Some(p), Some(price)) = (store.pending_buy.as_mut(), price) {
                p.price = Some(price);
            }
            None
        }
        // The owned card's actions wheel right after a purchase shows the bought card.
        Page::OwnedActions { name, points } => {
            let p = store.pending_buy.as_ref().filter(|p| p.at.elapsed() < crate::store::PendingBuy::KEEP)?;
            let card = store.snapshot.gallery.get(&p.def_id)?;
            let wanted = card.name.clone().unwrap_or_default().to_lowercase();
            let header = name.to_lowercase();
            let same_name = !wanted.is_empty() && (header == wanted || header.ends_with(&format!(" {wanted}")));
            let same_points = points.is_none_or(|pts| pts as u64 == card.score as u64);
            if !(same_name && same_points) {
                return None;
            }
            let p = store.pending_buy.take()?;
            Some(bought_page(store, p.def_id))
        }
        Page::Other | Page::AutoComplete => None,
    }
}

/// A pending purchase whose price came off the coin balance.
fn confirm_by_coins(store: &mut crate::store::Store, coins: u32) -> Option<CurrentPage> {
    let p = store.pending_buy.as_ref()?;
    if p.at.elapsed() >= crate::store::PendingBuy::KEEP {
        store.pending_buy = None;
        return None;
    }
    let (before, price) = (p.coins_before?, p.price?);
    if before.checked_sub(price) != Some(coins) {
        return None;
    }
    let p = store.pending_buy.take()?;
    Some(bought_page(store, p.def_id))
}

/// A confirmed purchase: recorded like a bought card on New Items (collected, never first owner,
/// ✓ in the missing list) with its Gallery impact for the toast.
fn bought_page(store: &mut crate::store::Store, def_id: u64) -> CurrentPage {
    let impacts = record_acquisitions(store, "bought", &[def_id]);
    let name = store.snapshot.gallery.get(&def_id).and_then(|c| c.name.clone()).unwrap_or_default();
    CurrentPage { kind: "bought", set_key: String::new(), set_name: name, verified: false, cards_read: 1, facts_changed: 0, identified: 1, ambiguous: 0, advice: None, impacts, better: None, fill: None }
}

/// Scanned names → card definitions (name ties broken by the set the user works on).
/// Learned flags must be this close to call a nation (same layout as the set grid's: the same
/// nation measures ~10–35 apart, different flags 100+). With the other nation not learned yet only
/// a near-perfect match counts.
const CARD_FLAG_MATCH: f32 = 60.0;
const CARD_FLAG_SURE: f32 = 30.0;

fn flag_distance(a: &[u8], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (*x as f32 - y).powi(2)).sum::<f32>().sqrt()
}

/// Cards that differ only by nation (EA keeps e.g. Bourabaa as France and as Morocco, same rating
/// and points): the flag on the card decides – the best nation must match its learned flag and every
/// other nation must be clearly further away (or, when not learned yet, the match must be near
/// perfect). Otherwise nothing is chosen (never guessed).
fn pick_by_flag(store: &crate::store::Store, flag: &[u8], pool: &[u64]) -> Option<u64> {
    let gallery = &store.snapshot.gallery;
    let nations: Vec<(u64, Option<u64>)> = pool.iter().map(|id| (*id, gallery.get(id).and_then(|c| c.nation))).collect();
    // every candidate must have a different nation, or the flag can't tell them apart
    let distinct: std::collections::BTreeSet<Option<u64>> = nations.iter().map(|(_, n)| *n).collect();
    if distinct.len() != nations.len() || distinct.contains(&None) {
        return None;
    }
    let dist = |n: Option<u64>| n.and_then(|n| store.snapshot.card_flags.get(&n)).map(|s| flag_distance(flag, &s.sig));
    let (best, d) = nations.iter().filter_map(|(id, n)| dist(*n).map(|d| (*id, d))).min_by(|a, b| a.1.total_cmp(&b.1))?;
    if d > CARD_FLAG_MATCH {
        return None;
    }
    let others_ok = nations.iter().filter(|(id, _)| *id != best).all(|(_, n)| match dist(*n) {
        Some(o) => o > CARD_FLAG_MATCH && o > d * 2.0,
        None => d <= CARD_FLAG_SURE,
    });
    others_ok.then_some(best)
}

fn match_cards(store: &mut crate::store::Store, cards: &[scan::ScannedCard]) -> Vec<u64> {
    let candidates: Vec<scan::Candidate> = store
        .snapshot
        .gallery
        .values()
        .filter_map(|c| Some(scan::Candidate { def_id: c.def_id, name: c.name.clone()?, rating: c.rating.map(|r| r as u32), points: c.score as u32 }))
        .collect();
    let focus: std::collections::BTreeSet<u64> = store
        .focus_set
        .as_deref()
        .and_then(gallery_sets::set_by_key)
        .map(|set| gallery_sets::cards_of_set(&set, &store.snapshot.gallery, &store.snapshot.team_links).iter().map(|c| c.def_id).collect())
        .unwrap_or_default();
    let mut ids: Vec<u64> = Vec::new();
    let mut ties: Vec<(&scan::ScannedCard, Vec<u64>)> = Vec::new();
    for s in cards {
        match scan::match_card_preferring(s, &candidates, |id| focus.contains(&id)) {
            Some(m) => {
                ids.push(m.def_id);
                // named for certain by name and stats: learn the nation's flag as it looks on cards
                let alone = scan::exact_name_matches(s, &candidates).len() <= 1;
                if let (true, Some(flag), Some(nation)) = (alone, s.flag.as_ref(), store.snapshot.gallery.get(&m.def_id).and_then(|c| c.nation)) {
                    store.learn_card_flag(nation, flag);
                }
            }
            None => {
                let pool: Vec<u64> = scan::exact_name_matches(s, &candidates).iter().map(|c| c.def_id).collect();
                if pool.len() >= 2 {
                    ties.push((s, pool));
                }
            }
        }
    }
    // after learning from this screen's certain cards: name ties by the flag
    for (s, pool) in ties {
        if let Some(id) = s.flag.as_ref().and_then(|f| pick_by_flag(store, f, &pool)) {
            let nation = store.snapshot.gallery.get(&id).and_then(|c| c.nation);
            crate::tracking::log(store.dir(), &format!("  {}: one of {} cards with this name – the flag says nation {:?}", s.name, pool.len(), nation));
            ids.push(id);
        }
    }
    ids.dedup();
    ids
}

/// Gallery impact of cards on a pack / Unassigned / list screen. Names are matched against the
/// whole card database (rating must agree when read; ambiguous names are skipped). Packed cards
/// count as first owner; elsewhere the origin is unknown, so no first-owner bonus is assumed.
/// Nothing is stored – the next sync records ownership (and owners == 1) for certain.
fn cards_impact(store: &mut crate::store::Store, context: &str, cards: &[scan::ScannedCard]) -> Vec<PackedCard> {
    // Name ties ("Adli" 76 and 77, rating not read): the card of the set the user works on.
    let ids = match_cards(store, cards);
    // The purchase from Bidding Options shows up here: nothing pending any more.
    if store.pending_buy.as_ref().is_some_and(|p| ids.contains(&p.def_id)) {
        store.pending_buy = None;
    }
    record_acquisitions(store, context, &ids)
}

/// Records acquisitions (collected / first owner) and returns their Gallery impact, measured
/// against the collection *before* they arrived.
fn record_acquisitions(store: &mut crate::store::Store, context: &str, ids: &[u64]) -> Vec<PackedCard> {
    let ids = ids.to_vec();
    // 1. What each card adds, measured against the collection *before* it arrived (afterwards it
    //    already sits in the best lineup and would add nothing).
    let mut out = Vec::new();
    {
        let snap = &store.snapshot;
        let fo = gallery_sets::FirstOwnerInfo { known: &snap.first_owner, manual: &snap.first_owner_manual, scanned: &snap.first_owner_scanned, club_no: &snap.first_owner_club_no };
        let mut cache = gallery_sets::LineupCache::new();
        for &def_id in &ids {
            let Some(card) = snap.gallery.get(&def_id) else { continue };
            // The first source seen wins (a bought card left in New Items stays "bought").
            let packed = store.source_for(def_id, context, crate::store::now_ms()) == "pack";
            let was_new = !card.collected;
            let was_not_fo = card.collected && matches!(fo.status(card), gallery_sets::FirstOwnerStatus::ScannedNo | gallery_sets::FirstOwnerStatus::ManualNo);
            let upgraded = packed && was_not_fo;
            let new_first_owner = packed && !fo.known_or_manual(def_id);
            let impact = gallery_sets::card_impact(def_id, packed, &snap.gallery, &fo, &snap.team_links, &snap.set_obs, &snap.prices, &mut cache);
            // A new first owner for a Gallery set is news even when it changes no lineup (user:
            // "New first owner collected · Bournemouth" – always).
            // A set it helps complete is the news ("new card for Tottenham"), else the biggest gain.
            let headline = impact.iter().find(|i| i.fills.is_some()).or(impact.first());
            let fills = headline.and_then(|i| i.fills);
            let best = headline.map(|b| (b.set_name.clone(), b.gain)).or_else(|| {
                new_first_owner.then(|| gallery_sets::set_names_of(def_id, &snap.gallery, &snap.team_links).into_iter().next().map(|s| (s, 0))).flatten()
            });
            if best.is_none() && !upgraded {
                continue;
            }
            let (set, gain) = best.unwrap_or_default();
            out.push(PackedCard { def_id, name: card.name.clone().unwrap_or_default(), rating: card.rating, new: was_new, set, gain, first_owner: packed, upgraded, new_first_owner, fills });
        }
    }
    // 2. Record the acquisitions (collected / first owner).
    for &def_id in &ids {
        let (source, _) = store.acquire(def_id, context);
        if source == "pack" && out.iter().any(|c| c.def_id == def_id && c.upgraded) {
            // The pack beats an older "not first owner" mark of the user too.
            store.snapshot.first_owner_manual.remove(&def_id);
        }
    }
    store.save();
    // Upgrades first (the user asked to be told), then by gain.
    out.sort_by(|a, b| b.upgraded.cmp(&a.upgraded).then(b.gain.cmp(&a.gain)));
    out
}

/// The game's swap preview → our check of the same swap and the best card for that slot.
/// Only with a verified lineup, and only when the chip readings agree with the game's base change.
fn advice_for(
    store: &crate::store::Store,
    key: &str,
    p: &scan::SwapPreview,
    cards: &[scan::ScannedCard],
    candidates: &[scan::Candidate],
) -> Option<gallery_sets::SwapAdvice> {
    let (out_points, in_points) = (p.out_points?, p.in_points?);
    if in_points as i64 - out_points as i64 != p.base_delta {
        return None; // a chip was misread
    }
    let snap = &store.snapshot;
    let obs = snap.set_obs.get(key).filter(|o| o.verified)?;
    // Cards on this swap page with the in-card's points: one of them is highlighted.
    let visible_in: Vec<u64> = cards
        .iter()
        .filter(|c| c.points.is_none_or(|pts| pts == in_points))
        .filter_map(|c| scan::match_card(c, candidates))
        .filter(|c| c.points == in_points)
        .map(|c| c.def_id)
        .collect();
    let fo = gallery_sets::FirstOwnerInfo { known: &snap.first_owner, manual: &snap.first_owner_manual, scanned: &snap.first_owner_scanned, club_no: &snap.first_owner_club_no };
    let input = gallery_sets::PreviewInput {
        out_points,
        in_points,
        in_rating: p.in_rating,
        in_position: p.in_position.as_deref(),
        total_after: p.total,
        total_delta: p.total_delta,
        visible_in,
    };
    let advice = gallery_sets::swap_advice(key, &snap.gallery, &fo, &snap.team_links, obs, &snap.prices, &input)?;
    log(
        store.dir(),
        &format!(
            "swap preview {key}: in-game {:+} · model {:?} (exact {}) · best {:?} {:+}",
            advice.ingame_delta,
            advice.model_delta,
            advice.model_exact,
            advice.best.as_ref().and_then(|c| c.name.clone()),
            advice.best_gain
        ),
    );
    Some(advice)
}

fn owned_by_points(cards: &[SetCard]) -> std::collections::BTreeMap<u32, usize> {
    let mut m = std::collections::BTreeMap::new();
    for c in cards {
        *m.entry(c.points).or_insert(0) += 1;
    }
    m
}

/// Re-identifies a set's lineup with everything known so far and stores the certain facts.
/// Only a lineup verified against the in-game Base Grade is trusted for first-owner facts.
fn identify_and_apply(store: &mut crate::store::Store, key: &str, set_cards: &[SetCard], verified: bool) -> (usize, usize, usize) {
    let Some(obs) = store.snapshot.set_obs.get(key).cloned() else { return (0, 0, 0) };
    if obs.slots.is_empty() {
        return (0, 0, 0);
    }
    // A lineup holding cards we can't name: a same-points card we do know could be given their
    // slot – no first-owner facts or flags from it until it is read fully named.
    let verified = verified && !obs.unnamed;
    // The swap pages are complete when lineup + seen-on-swap covers every collected card.
    let swap_complete = set_cards.len() == obs.slots.len() + obs.unselected.len();
    let learned: std::collections::BTreeMap<u64, Vec<f32>> =
        store.snapshot.flags.iter().map(|(n, f)| (*n, f.sig.clone())).collect();
    let mut id = lineup::identify(&obs.slots, set_cards, &obs.unselected, swap_complete, &learned);
    // Learn flag colours from slots whose card is certain (only from a verified lineup); with
    // new nations learned, identify once more – the same page may now tell twins apart.
    if verified {
        let mut learned_new = false;
        for slot in &id.unique {
            let (Some(def_id), Some(flag)) = (id.slots.get(slot), obs.slots.get(*slot).and_then(|s| s.flag.as_ref())) else { continue };
            if let Some(nation) = store.snapshot.gallery.get(def_id).and_then(|c| c.nation) {
                learned_new |= !learned.contains_key(&nation);
                store.learn_flag(nation, flag);
            }
        }
        if learned_new {
            let learned: std::collections::BTreeMap<u64, Vec<f32>> =
                store.snapshot.flags.iter().map(|(n, f)| (*n, f.sig.clone())).collect();
            id = lineup::identify(&obs.slots, set_cards, &obs.unselected, swap_complete, &learned);
        }
    }
    // Not every slot named: the selection proven from the club (its total equals the game's, see
    // gallery_sets::prove_selection) names the rest – remembered with the set, and the slots'
    // first-owner marks become facts for those cards. No Swap Player paging needed next time.
    // (Also for a selection read with cards we didn't know then: the proof only uses collected
    // cards, so once the sync knows them they can be named.)
    if obs.verified && obs.total.is_some() && id.slots.len() < obs.slots.len() {
        let mut probe = obs.clone();
        probe.identified = id.slots.clone();
        let snap = &store.snapshot;
        let fo = gallery_sets::FirstOwnerInfo { known: &snap.first_owner, manual: &snap.first_owner_manual, scanned: &snap.first_owner_scanned, club_no: &snap.first_owner_club_no };
        if let Some(ids) = gallery_sets::prove_selection(key, &snap.gallery, &fo, &snap.team_links, &probe) {
            let added: Vec<(usize, u64)> = ids.iter().filter(|(s, _)| !id.slots.contains_key(s)).map(|(s, d)| (*s, *d)).collect();
            for (slot, def_id) in &added {
                if let Some(s) = obs.slots.get(*slot) {
                    id.first_owner.insert(*def_id, s.first_owner);
                }
            }
            if !added.is_empty() {
                log(store.dir(), &format!("set {key}: {} slot(s) named from the club – the selection scores the game's total {}", added.len(), obs.total.unwrap_or(0)));
            }
            id.ambiguous = 0;
            id.slots = ids;
        }
    }
    // A proof that names every slot: nothing in it is unnamed any more.
    let proven_all = obs.verified && id.slots.len() == obs.slots.len();
    if proven_all && obs.unnamed {
        if let Some(o) = store.snapshot.set_obs.get_mut(key) {
            o.unnamed = false;
        }
    }
    let verified = verified || proven_all;
    // a "no" from a slot whose triangle score was close is no fact (it may be a missed triangle)
    let uncertain: std::collections::BTreeSet<u64> = id.slots.iter().filter(|(s, _)| obs.slots.get(**s).is_some_and(|o| o.uncertain)).map(|(_, d)| *d).collect();
    let facts: Vec<(u64, bool)> = if verified { id.first_owner.iter().filter(|(k, v)| **v || !uncertain.contains(k)).map(|(k, v)| (*k, *v)).collect() } else { Vec::new() };
    let changed = store.apply_scan(&facts);
    let mut moved = false;
    if let Some(o) = store.snapshot.set_obs.get_mut(key) {
        moved = o.identified != id.slots || o.ambiguous != id.ambiguous;
        o.identified = id.slots.clone();
        o.ambiguous = id.ambiguous;
    }
    // Only a real change is saved: an identical re-read must not rewrite the snapshot and make
    // the model recompute every set (that cost 25–50 % CPU on shimmering pages).
    if moved || changed > 0 || store.dirty {
        store.save();
    }
    (id.slots.len(), id.ambiguous, changed)
}

/// Every read selection proven again with everything known now (after a sync, at startup): the
/// club may now hold the cards that couldn't be named when the page was read, and the slots'
/// triangles then become facts – no page has to be opened again. Returns the facts changed.
pub fn reprove_all(store: &mut crate::store::Store) -> usize {
    let keys: Vec<String> = store.snapshot.set_obs.iter().filter(|(_, o)| o.verified && !o.slots.is_empty() && o.identified.len() < o.slots.len()).map(|(k, _)| k.clone()).collect();
    let mut changed = 0;
    for key in keys {
        let Some(set) = gallery_sets::set_by_key(&key) else { continue };
        let set_cards: Vec<SetCard> = gallery_sets::cards_of_set(&set, &store.snapshot.gallery, &store.snapshot.team_links)
            .into_iter()
            .filter(|c| c.collected)
            .map(|c| SetCard { def_id: c.def_id, points: c.score as u32, rating: c.rating.map(|r| r as u32), position: c.position.clone(), nation: c.nation })
            .collect();
        changed += identify_and_apply(store, &key, &set_cards, true).2;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_slots_the_club_can_fill_are_named() {
        // Newcastle 7/15 live 2026-10-17: 410, 5 × 280, 140 in the set; Barnes, Wissa, Murphy in the club
        let card = |id: u64, points: u32| SetCard { def_id: id, points, rating: None, position: None, nation: None };
        let owned = vec![card(1, 410), card(2, 280), card(3, 280), card(4, 280), card(5, 280), card(6, 280), card(7, 140), card(8, 180), card(9, 180), card(10, 160)];
        let read: std::collections::BTreeMap<u32, i32> = [(410, 1), (280, 5), (140, 1)].into_iter().collect();
        let names = |id: u64| Some(match id { 8 => "Barnes", 9 => "Wissa", 10 => "Murphy", _ => "?" }.to_string());
        let f = open_slot_fill(15, &read, &owned, names).unwrap();
        assert_eq!((f.count, f.points), (3, Some(520)));
        assert_eq!(f.names, ["Barnes", "Wissa", "Murphy"]);
        // a sixth 280 card in the club: which one sits out is unknown – count only
        let mut more = owned.clone();
        more.push(card(11, 280));
        let f = open_slot_fill(15, &read, &more, names).unwrap();
        assert_eq!((f.count, f.points, f.names.len()), (4, None, 0));
        // nothing left in the club: no notice
        assert!(open_slot_fill(15, &read, &owned[..7], names).is_none());
    }

    /// One screenshot end to end against the real snapshot: page → selection → swaps.
    /// `FCT_ONE=<png/webp> FCT_REAL_SNAPSHOT=<snapshot.json> cargo test --lib one_page_end_to_end -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn one_page_end_to_end() {
        let (Ok(one), Ok(_)) = (std::env::var("FCT_ONE"), std::env::var("FCT_REAL_SNAPSHOT")) else { return };
        let mut store = crate::store::Store::copy_of_user_data();
        let frame = scan::analyse_bytes(&std::fs::read(&one).unwrap()).unwrap();
        let page = scan::analyse_page(&frame).unwrap();
        println!("page: {}", describe(&page));
        let Some(p) = process_page(&mut store, page) else { println!("not processed"); return };
        println!("kind {} set {} verified {} identified {}/{} better {:?}", p.kind, p.set_name, p.verified, p.identified, p.cards_read, p.better.as_ref().map(|b| (b.ingame, b.best, b.gain)));
        println!("impacts: {}", serde_json::to_string(&p.impacts).unwrap());
        if p.set_key.is_empty() { return; }
        let snap = &store.snapshot;
        let fo = gallery_sets::FirstOwnerInfo { known: &snap.first_owner, manual: &snap.first_owner_manual, scanned: &snap.first_owner_scanned, club_no: &snap.first_owner_club_no };
        let s = gallery_sets::set_summary(&p.set_key, &snap.gallery, &fo, &snap.team_links, &snap.set_obs, &snap.prices, &snap.set_list).unwrap();
        println!("score {} best {} in-game {:?}", s.score, s.best_model, s.ingame.as_ref().and_then(|g| g.total));
        for w in &s.swaps {
            println!("  swap {} {} {} → {} {} {} ({:?})", w.out.name.clone().unwrap_or(format!("slot {}", w.out.slot.map_or(0, |x| x + 1))), w.out.rating.unwrap_or(0), w.out.score, w.into.name.clone().unwrap_or_default(), w.into.rating.unwrap_or(0), w.into.score, w.into.first_owner);
        }
        println!("best selection: {}", s.lineup.iter().map(|c| format!("{} {} {}", c.name.clone().unwrap_or("?".into()), c.rating.unwrap_or(0), c.score)).collect::<Vec<_>>().join(", "));
    }

    #[test]
    fn the_card_flag_tells_apart_two_definitions_of_one_player() {
        let dir = std::env::temp_dir().join(format!("fct-flag-{}", std::process::id()));
        let mut store = crate::store::Store::load(dir.clone());
        // Bourabaa as France (18) and as Morocco (97): same rating and points (EA, 2026-10-17)
        for (id, nation) in [(83817u64, 18u64), (50415465, 97)] {
            store.snapshot.gallery.insert(id, crate::store::GalleryCard { def_id: id, score: 35, rating: Some(66), nation: Some(nation), name: Some("Bourabaa".into()), ..Default::default() });
        }
        let france: Vec<u8> = vec![0x0a, 0x24, 0x49, 0xe1, 0xe7, 0xe9, 0xc6, 0x5a, 0x66, 0x0d, 0x25, 0x48, 0xe0, 0xe6, 0xeb, 0xc2, 0x5b, 0x6b];
        let pool = [83817u64, 50415465];
        // nothing learned yet: no decision
        assert_eq!(pick_by_flag(&store, &france, &pool), None);
        // France learned from a card named for certain: the French flag picks the French card
        store.learn_card_flag(18, &france);
        assert_eq!(pick_by_flag(&store, &france, &pool), Some(83817));
        // a flag only roughly like the learned one, Morocco not learned: no decision (never guessed)
        let rough: Vec<u8> = france.iter().map(|v| v.saturating_add(14)).collect();
        assert_eq!(pick_by_flag(&store, &rough, &pool), None);
        // Morocco learned too (red / green): the Moroccan flag picks the Moroccan card
        let morocco: Vec<u8> = vec![0xc1, 0x27, 0x2d, 0xb8, 0x2a, 0x2e, 0xc0, 0x28, 0x2c, 0xc2, 0x26, 0x2d, 0x1f, 0x6e, 0x3a, 0xc0, 0x27, 0x2c];
        store.learn_card_flag(97, &morocco);
        assert_eq!(pick_by_flag(&store, &morocco, &pool), Some(50415465));
        assert_eq!(pick_by_flag(&store, &france, &pool), Some(83817));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A whole video replayed page by page against the real snapshot: every stitched frame of
    /// `FCT_TILES` (see `scan::tests::tiles_dir`) in time order through `process_page` – what the
    /// store records and which notice the user would get.
    /// `FCT_TILES=<dir> cargo test --release --lib video_replay -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn video_replay() {
        let Ok(dir) = std::env::var("FCT_TILES") else { return };
        let dir = std::path::PathBuf::from(dir);
        let mut store = crate::store::Store::copy_of_user_data();
        let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter_map(|n| n.strip_suffix("_q00.jpg").map(str::to_string)).collect();
        names.sort_by(|a, b| a.parse::<f64>().unwrap_or(0.0).partial_cmp(&b.parse::<f64>().unwrap_or(0.0)).unwrap());
        for name in names {
            let Some((w, h, px)) = scan::tests::stitch_tiles(&dir, &name) else { continue };
            let frame = scan::frame_from_pixels(w, h, px).unwrap();
            let page = scan::analyse_page(&frame).unwrap_or(Page::Other);
            let what = describe(&page);
            let progress = progress_notice(&page);
            match process_page(&mut store, page) {
                Some(p) => {
                    let notice = if !p.impacts.is_empty() { format!("pack notice {}", serde_json::to_string(&p.impacts).unwrap()) } else { read_result_notice(&p).to_string() };
                    println!("{name:>6}s {what}
        progress {progress:?}
        → {} {} identified {}/{} · {notice}", p.kind, p.set_name, p.identified, p.cards_read);
                }
                None => println!("{name:>6}s {what} → no Gallery page (progress {progress:?})"),
            }
        }
    }

    /// Feeds (tick change, change since the last read page) per 250 ms tick; returns the ticks
    /// where the screen is read. After a read, "since the last read page" restarts at 0.
    fn reads(ticks: &[(u32, u32)]) -> Vec<usize> {
        let mut g = ReadGate::default();
        let mut out = Vec::new();
        let mut base = 0u32;
        for (i, &(tick, page)) in ticks.iter().enumerate() {
            if g.tick(tick, page.saturating_sub(base), false) {
                out.push(i);
                base = page;
            }
        }
        out
    }

    #[test]
    fn a_new_screen_is_read_within_half_a_second() {
        // Transition (40 %), then a calm animated New Items screen (5 % shimmer per tick).
        assert_eq!(reads(&[(40, 40), (5, 42), (5, 44)]), vec![2]);
        // The same, but the user leaves after 0.5 s: it was read just in time.
        assert_eq!(reads(&[(40, 40), (5, 42), (5, 44), (60, 100)]), vec![2]);
    }

    #[test]
    fn a_screen_that_never_settles_is_read_at_the_settings_interval() {
        // A transition, then New Items over a moving 3D background: 20 % change every look, forever.
        let mut t = vec![(40, 40)];
        for i in 0..60 {
            t.push((20, 60 + 20 * i));
        }
        let r = reads(&t);
        assert!(r.first().is_some_and(|&i| i <= 6), "read within ~1 s: {r:?}");
        assert!(r.windows(2).all(|w| w[1] - w[0] == 4), "then every `animated_ticks`: {r:?}");
        // a slower setting reads less often
        let mut g = ReadGate { cfg: crate::speed::GateCfg { still_ticks: 1, animated_ticks: 10, market_ticks: 2 }, ..Default::default() };
        let mut base = 0u32;
        let mut slow = Vec::new();
        for (i, &(tick, page)) in t.iter().enumerate() {
            if g.tick(tick, page.saturating_sub(base), false) {
                slow.push(i);
                base = page;
            }
        }
        assert!(slow.windows(2).all(|w| w[1] - w[0] == 10), "{slow:?}");
    }

    #[test]
    fn on_the_transfer_market_a_moving_page_is_read_within_half_a_second() {
        let mut g = ReadGate { urgent: true, ..Default::default() };
        let mut first = None;
        for i in 0..10u32 {
            if g.tick(if i == 0 { 40 } else { 20 }, 40 + 20 * i, false) {
                first = Some(i);
                break;
            }
        }
        assert!(first.is_some_and(|i| i <= 2), "{first:?}");
    }

    #[test]
    fn a_verification_read_follows_and_is_dropped_on_a_new_page() {
        let mut g = ReadGate::default();
        assert!(g.tick(40, 40, false) || g.tick(2, 40, false), "first read");
        g.verify_after(4);
        // the same page, a moving background (8 %): the verification read comes after 4 looks
        let fired: Vec<bool> = (0..4).map(|_| g.tick(8, 2, false)).collect();
        assert_eq!(fired, vec![false, false, false, true]);
        assert!(g.verifying);
        // planned, then the user leaves the page: no verification of the old page
        g.verify_after(4);
        let _ = g.tick(60, 80, false);
        assert!((0..6).all(|_| { let r = g.tick(1, 0, false); !(r && g.verifying) }));
    }

    #[test]
    fn a_due_verification_waits_for_a_calm_frame() {
        let mut g = ReadGate::default();
        assert!(g.tick(40, 40, false) || g.tick(2, 40, false), "first read");
        g.verify_after(2);
        // due while the frame moves 20 % (mid-scroll): no read yet …
        assert!(!g.tick(20, 2, false));
        assert!(!(g.tick(20, 2, false) && g.verifying));
        // … then calm: the verification read
        assert!(g.tick(5, 2, false) && g.verifying);
    }

    #[test]
    fn read_delays_count_in_the_real_tick_length() {
        // balanced: 1 s for animated screens; in 500 ms ticks that is 2 ticks, not 10
        let p = crate::speed::TrackingPrefs { preset: "custom".into(), continuous: true, watch_ms: 100, same_for_all: false, all_ms: 500, still_ms: 150, animated_ms: 1000, market_ms: 500, match_ms: 1000 };
        assert_eq!(crate::speed::gate_cfg_for(&p, 500).animated_ticks, 2);
        assert_eq!(crate::speed::gate_cfg_for(&p, 100).animated_ticks, 10);
    }

    #[test]
    fn shimmering_cards_are_not_read_again_and_again() {
        // A set page read, then 40 ticks of shimmer that drift far from the read page.
        let mut t = vec![(40, 40), (2, 40), (2, 40)];
        for i in 0..40 {
            t.push((8, 40 + 2 * i));
        }
        let r = reads(&t);
        assert_eq!(r, vec![1], "{r:?}");
    }

    #[test]
    fn a_score_counting_up_is_read_again_when_it_ends() {
        // Regrade: the page is read while the number still counts (calm), then it stops.
        let r = reads(&[(30, 30), (6, 31), (6, 32), (5, 33), (1, 34), (1, 34)]);
        assert_eq!(r, vec![2, 4], "{r:?}");
        // Never fully still (holo shimmer): re-read once after ~1 s of calm, not forever.
        let r = reads(&[(30, 30), (6, 31), (6, 32), (5, 33), (5, 34), (5, 35), (5, 36), (5, 37), (5, 38), (5, 39), (5, 40)]);
        assert_eq!(r, vec![2, 6], "{r:?}");
    }

    #[test]
    fn a_still_page_that_drifts_slowly_is_not_read_again_every_few_seconds() {
        // Live log 2026-10-14: a set page (holo shimmer) is still every tick but drifts ~1 % per
        // tick from the read page – it was re-read every 1–2 s. 40 ticks = 10 s.
        let mut t = vec![(40, 40), (1, 40), (1, 40)];
        for i in 0..40 {
            t.push((1, 40 + i));
        }
        let r = reads(&t);
        // The first read, and at most one more once the drift is really large.
        assert!(r.len() <= 2 && r[0] == 1, "{r:?}");
    }

    #[test]
    fn quick_paging_on_swap_player_reads_every_page() {
        // Next, Next, Next – each page shown ~0.75 s.
        let r = reads(&[(35, 35), (1, 35), (1, 35), (35, 70), (1, 70), (1, 70), (35, 105), (1, 105), (1, 105)]);
        assert_eq!(r, vec![1, 4, 7], "{r:?}");
    }


    /// Fictional sessions replayed with the user's screenshots on a copy of the user's real data
    /// (`FCT_REAL_SNAPSHOT`): what each screen reads, what is stored, what the list and toast show.
    #[test]
    #[ignore]
    fn scenarios_on_real_data() {
        let (Ok(fixtures), Ok(real)) = (std::env::var("FCT_SCAN_FIXTURES"), std::env::var("FCT_REAL_SNAPSHOT")) else { return };
        let tmp = std::env::temp_dir().join(format!("fct-scen-{}", crate::store::now_ms()));
        std::fs::create_dir_all(tmp.join("captures")).unwrap();
        std::fs::copy(&real, tmp.join("snapshot.json")).unwrap();
        let mut store = crate::store::Store::load(tmp.clone());
        store.snapshot.acquired.clear();
        if let Ok(f) = std::env::var("FCT_DEBUG_SET") {
            let page = scan::analyse_page(&scan::analyse_bytes(&std::fs::read(std::path::Path::new(&fixtures).join(&f)).unwrap()).unwrap()).unwrap();
            if let Page::Set { title, cards, base, .. } = &page {
                let set = gallery_sets::find_set_by_title(title).unwrap();
                let all = gallery_sets::cards_of_set(&set, &store.snapshot.gallery, &store.snapshot.team_links);
                for c in cards {
                    let owned = all.iter().filter(|x| c.points.is_some_and(|p| x.score as u32 == p)).map(|x| (x.name.clone().unwrap_or_default(), x.collected)).collect::<Vec<_>>();
                    println!("slot {} readings {:?} points {:?} rating {:?} fo {} → cards {:?}", c.slot, c.readings, c.points, c.rating, c.first_owner, owned);
                }
                println!("base {base:?}");
            }
            return;
        }
        let read = |file: &str| scan::analyse_page(&scan::analyse_bytes(&std::fs::read(std::path::Path::new(&fixtures).join(file)).unwrap()).unwrap()).unwrap();
        let list = |store: &crate::store::Store, key: &str| crate::model::ModelInput::from_store(store).shopping_list(key).unwrap();
        let fo = |store: &crate::store::Store, id: u64| {
            let s = &store.snapshot;
            let f = gallery_sets::FirstOwnerInfo { known: &s.first_owner, manual: &s.first_owner_manual, scanned: &s.first_owner_scanned, club_no: &s.first_owner_club_no };
            s.gallery.get(&id).map(|c| f.status(c))
        };

        // Before the packs: Gabri Veiga, Petersson and María Pérez not owned yet; Hjulmand owned
        // as a bought copy (known not first owner) – so the pack makes him first owner.
        for id in [258729u64, 73072, 268945] {
            store.snapshot.gallery.get_mut(&id).unwrap().collected = false;
            store.snapshot.first_owner.remove(&id);
            store.snapshot.first_owner_scanned.remove(&id);
        }
        store.snapshot.first_owner.remove(&244669);
        store.snapshot.first_owner_scanned.insert(244669, false);
        println!("
== 1. Pack hunt with the missing list open (New Items after a pack)");
        for file in ["u-newitems-pack-12.webp", "u-newitems-untradeable.webp"] {
            let page = read(file);
            println!("{file}: {}", describe(&page));
            let p = process_page(&mut store, page).expect("New Items after a pack is read");
            assert_eq!(p.kind, "cards");
            for (id, a) in &store.snapshot.acquired {
                let c = &store.snapshot.gallery[id];
                println!("   acquired {:?} {:?} ({}) via {} – status {:?}", c.name, c.rating, c.score, a.source, fo(&store, *id));
            }
            for c in &p.impacts {
                println!("   toast: {} {:?} → {} +{} first_owner={} upgraded={} | status now {:?}", c.name, c.rating, c.set, c.gain, c.first_owner, c.upgraded, fo(&store, c.def_id));
                if c.def_id == 244669 {
                    assert!(c.upgraded, "Hjulmand: bought copy, now packed → upgraded");
                }
                assert!(c.first_owner, "packed = first owner");
                assert_eq!(store.snapshot.acquired[&c.def_id].source, "pack");
                assert!(store.snapshot.gallery[&c.def_id].collected);
            }
            if let Some(c) = p.impacts.iter().find(|c| c.gain > 0) {
                let set = gallery_sets::find_set_by_title(&c.set).unwrap();
                let l = list(&store, &set.key);
                let got: Vec<_> = l.entries.iter().filter(|e| e.got).map(|e| (e.card.name.clone(), e.gain, e.got_source.clone())).collect();
                println!("   missing list {}: ✓ {:?}", l.name, got);
                assert!(l.entries.iter().any(|e| e.got && e.card.def_id == c.def_id), "{} gets a ✓ in {}", c.name, l.name);
            }
        }

        println!("
== 2. Purchase (New Items after Transfer Search)");
        let page = read("u-newitems-bought.webp");
        println!("{}", describe(&page));
        let p = process_page(&mut store, page).expect("bought New Items is read");
        for c in &p.impacts {
            println!("   toast: {} → {} +{} first_owner={} | status {:?} | acquired {:?}", c.name, c.set, c.gain, c.first_owner, fo(&store, c.def_id), store.snapshot.acquired.get(&c.def_id).map(|a| a.source.clone()));
            assert!(!c.first_owner);
        }

        println!("
== 3. Screens that must never count");
        for file in ["u-transfer-list.webp", "u-club-players.webp", "u-squad-ps.webp"] {
            let page = read(file);
            let r = process_page(&mut store, page);
            println!("{file}: {:?}", r.as_ref().map(|p| p.kind));
            assert!(r.is_none() || r.as_ref().is_some_and(|p| p.kind != "cards"), "{file} must not be an acquisition");
        }

        println!("
== 4. Set pages");
        for file in ["u-pl-set-a.webp", "u-arsenal-set.webp", "u-totw-incomplete.webp", "u-holo-set.webp", "u-bournemouth-complete.webp"] {
            let page = read(file);
            let what = describe(&page);
            let p = process_page(&mut store, page).expect("set page");
            println!("{file}: {} → {} verified={} identified={}/{} ambiguous={} facts={} better={:?}", what.chars().take(60).collect::<String>(), p.set_name, p.verified, p.identified, p.cards_read, p.ambiguous, p.facts_changed, p.better.as_ref().map(|b| b.gain));
            assert!(p.verified, "{file}");
        }
        for (name, id) in [("Lucy Bronze (holo)", 50558894u64), ("Gabriel", 232580)] {
            println!("   {name}: {:?}", fo(&store, id));
        }
        assert!(!store.snapshot.first_owner_scanned.contains_key(&50558894), "holo triangle is no fact");

        println!("
== 5. Swap Player pages, then the set page again (the box must stay)");
        for file in ["u-pl-swap-p1.webp", "u-pl-swap-p2.webp", "u-pl-swap-p3.webp"] {
            let p = process_page(&mut store, read(file)).expect("swap page");
            let o = &store.snapshot.set_obs[&p.set_key];
            println!("{file}: {} cards read, box {} cards, identified {}/{}", p.cards_read, o.unselected.len(), o.identified.len(), o.slots.len());
        }
        let key = gallery_sets::find_set_by_title("Premier League").unwrap().key;
        let before = store.snapshot.set_obs[&key].unselected.clone();
        process_page(&mut store, read("u-pl-set-a.webp")).unwrap();
        let after = &store.snapshot.set_obs[&key];
        println!("set page again: box {} → {}, identified {}/{}", before.len(), after.unselected.len(), after.identified.len(), after.slots.len());
        assert_eq!(before, after.unselected, "re-reading the same lineup keeps the box");

        println!("
== 6. Set on screen for View / double-tap");
        for file in ["u-pl-swap-p2.webp", "u-bournemouth-complete.webp", "u-newitems-bought.webp"] {
            let t = scan::gallery_title(&scan::analyse_bytes(&std::fs::read(std::path::Path::new(&fixtures).join(file)).unwrap()).unwrap());
            println!("{file}: {:?} → {:?}", t, t.as_deref().and_then(gallery_sets::find_set_by_title).map(|s| s.name));
        }
        let _ = std::fs::remove_dir_all(tmp);
    }

    /// A store pack with a Bournemouth player (Jebbison) the user didn't have as first owner:
    /// always a notice, even when no lineup changes (user, 2026-10-14).
    #[test]
    #[ignore]
    fn a_new_first_owner_from_a_pack_is_always_announced() {
        let Ok(fixtures) = std::env::var("FCT_SCAN_FIXTURES") else { return };
        let mut store = crate::store::Store::copy_of_user_data();
        store.snapshot.acquired.clear();
        let id = store.snapshot.gallery.values().find(|c| c.name.as_deref() == Some("Jebbison")).map(|c| c.def_id).expect("Jebbison");
        store.snapshot.first_owner.remove(&id);
        store.snapshot.first_owner_scanned.remove(&id);
        store.snapshot.first_owner_manual.remove(&id);
        let f = scan::analyse_bytes(&std::fs::read(std::path::Path::new(&fixtures).join("u-newitems-store-12.webp")).unwrap()).unwrap();
        let p = process_page(&mut store, scan::analyse_page(&f).unwrap()).expect("New Items");
        let j = p.impacts.iter().find(|c| c.def_id == id).expect("Jebbison announced");
        println!("{} → {} +{} new_first_owner={}", j.name, j.set, j.gain, j.new_first_owner);
        assert!(j.new_first_owner && j.set == "Bournemouth");
    }

    /// A purchase from Transfer Search (user screenshots 2026-10-14): Bidding Options, then the
    /// success dialog – or only the coins dropping on the next screen.
    #[test]
    #[ignore]
    fn purchases_are_caught_before_new_items() {
        let Ok(fixtures) = std::env::var("FCT_SCAN_FIXTURES") else { return };
        let read = |file: &str| {
            let f = scan::analyse_bytes(&std::fs::read(std::path::Path::new(&fixtures).join(file)).unwrap()).unwrap();
            let coins = scan::read_coins(&f);
            (scan::analyse_page(&f).unwrap(), coins)
        };
        let fresh = || {
            let mut s = crate::store::Store::copy_of_user_data();
            s.snapshot.acquired.clear();
            s
        };
        let gomes = |s: &crate::store::Store| s.snapshot.gallery.values().find(|c| c.name.as_deref() == Some("João Gomes") && c.rating == Some(78)).map(|c| c.def_id).unwrap();

        // 1. Bidding Options → success dialog.
        let mut store = fresh();
        let id = gomes(&store);
        store.snapshot.gallery.get_mut(&id).unwrap().collected = false;
        let (page, coins) = read("buy-bidding.webp");
        store.last_coins = coins;
        let p = process_page(&mut store, page).expect("bidding page");
        assert_eq!(p.kind, "bidding");
        assert_eq!(store.pending_buy.as_ref().map(|p| (p.def_id, p.price)), Some((id, Some(1300))));
        let (page, _) = read("buy-success.webp");
        let p = process_page(&mut store, page).expect("success dialog");
        println!("success → {:?}", p.impacts.iter().map(|c| (c.name.clone(), c.set.clone(), c.gain)).collect::<Vec<_>>());
        assert_eq!(store.snapshot.acquired.get(&id).map(|a| a.source.as_str()), Some("bought"));
        assert!(store.snapshot.gallery[&id].collected);

        // 2. Bidding Options → the dialogs skipped: the coins (258,659 − 1,300) confirm it.
        let mut store = fresh();
        store.snapshot.gallery.get_mut(&id).unwrap().collected = false;
        let (page, coins) = read("buy-bidding.webp");
        store.last_coins = coins;
        process_page(&mut store, page).unwrap();
        assert!(confirm_by_coins(&mut store, 258_000).is_none(), "another amount is no proof");
        assert!(confirm_by_coins(&mut store, 257_359).is_some());
        assert_eq!(store.snapshot.acquired.get(&id).map(|a| a.source.as_str()), Some("bought"));

        // 3. Club / squad search (2026-10-15): transfer panel → "get this item for 700 FUT Coins?"
        //    → the owned card's actions wheel ("Ross Barkley", ◆ 120) proves the purchase.
        let barkley = |s: &crate::store::Store| {
            s.snapshot.gallery.values().find(|c| c.name.as_deref() == Some("Barkley") && c.rating == Some(77)).map(|c| c.def_id).unwrap()
        };
        let mut store = fresh();
        let id = barkley(&store);
        store.snapshot.gallery.get_mut(&id).unwrap().collected = false;
        let (page, coins) = read("club-buy-market.webp");
        store.last_coins = coins;
        process_page(&mut store, page).expect("transfer panel");
        assert_eq!(store.pending_buy.as_ref().map(|p| (p.def_id, p.price, p.coins_before)), Some((id, Some(700), Some(258_570))));
        let (page, _) = read("club-buy-confirm.webp");
        assert!(process_page(&mut store, page).is_none());
        let (page, _) = read("club-buy-actions.webp");
        let p = process_page(&mut store, page).expect("the actions wheel confirms it");
        println!("club buy → {:?}", p.impacts.iter().map(|c| (c.name.clone(), c.set.clone(), c.gain, c.fills, c.first_owner)).collect::<Vec<_>>());
        assert_eq!(store.snapshot.acquired.get(&id).map(|a| a.source.as_str()), Some("bought"));
        assert!(store.pending_buy.is_none());

        // 4. The same, but back on the transfer panel with the new balance (258,570 − 700): the
        //    coins confirm it, and the panel doesn't start a second purchase of the same card.
        let mut store = fresh();
        store.snapshot.gallery.get_mut(&id).unwrap().collected = false;
        let (page, coins) = read("club-buy-market.webp");
        store.last_coins = coins;
        process_page(&mut store, page).unwrap();
        assert!(confirm_by_coins(&mut store, 257_870).is_some());
        let (page, _) = read("club-buy-market.webp");
        assert!(process_page(&mut store, page).is_none(), "owned now: no new pending purchase");
        assert!(store.pending_buy.is_none());

        // 5. A new card for an incomplete set (Tottenham, 2026-10-15): the notice names that set
        //    and the slot it fills, even if another set gains more.
        let mut store = fresh();
        let spurs = crate::gallery_sets::set_by_key("set-8").expect("Tottenham");
        let candidate = crate::gallery_sets::cards_of_set(&spurs, &store.snapshot.gallery, &store.snapshot.team_links)
            .into_iter()
            .find(|c| !c.collected)
            .map(|c| c.def_id)
            .expect("a Tottenham card not in the Gallery yet");
        let out = record_acquisitions(&mut store, "bought", &[candidate]);
        println!("new for Tottenham → {:?}", out.iter().map(|c| (c.name.clone(), c.set.clone(), c.gain, c.fills)).collect::<Vec<_>>());
        assert_eq!(out.first().map(|c| c.set.as_str()), Some("Tottenham Hotspur"));
        assert!(out.first().is_some_and(|c| c.fills.is_some_and(|(n, slots)| n <= slots)));
    }

    /// Bournemouth after autofill (2026-10-13 late): 15 cards in-game, one of them (Adli 77, 120)
    /// bought without us seeing New Items. The page must still be read (the lineup proves
    /// ownership) and the set must count as complete.
    #[test]
    #[ignore]
    fn set_page_proves_ownership() {
        let Ok(fixtures) = std::env::var("FCT_SCAN_FIXTURES") else { return };
        let real = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("dk.fctracker.app");
        let tmp = std::env::temp_dir().join(format!("fct-own-{}", crate::store::now_ms()));
        std::fs::create_dir_all(tmp.join("captures")).unwrap();
        std::fs::copy(real.join("snapshot.json"), tmp.join("snapshot.json")).unwrap();
        let mut store = crate::store::Store::load(tmp.clone());
        store.snapshot.gallery.get_mut(&255223).unwrap().collected = false; // Adli: purchase missed
        store.snapshot.set_list.clear();
        let bytes = std::fs::read(std::path::Path::new(&fixtures).join("u-bournemouth-complete.webp")).unwrap();
        let page = scan::analyse_page(&scan::analyse_bytes(&bytes).unwrap()).unwrap();
        println!("{}", describe(&page));
        let p = process_page(&mut store, page).expect("set page");
        println!("verified={} identified={} ambiguous={}", p.verified, p.identified, p.ambiguous);
        println!("Adli collected: {}", store.snapshot.gallery[&255223].collected);
        let snap = &store.snapshot;
        let fo = gallery_sets::FirstOwnerInfo { known: &snap.first_owner, manual: &snap.first_owner_manual, scanned: &snap.first_owner_scanned, club_no: &snap.first_owner_club_no };
        let s = gallery_sets::set_summary(&p.set_key, &snap.gallery, &fo, &snap.team_links, &snap.set_obs, &snap.prices, &snap.set_list).unwrap();
        println!("summary: score={} base={} bonus={} collected={}/{} complete={}", s.score, s.base, s.bonus, s.collected, s.slots, s.complete);
        assert!(p.verified);
        assert!(s.complete && s.score == 2768, "{} {}", s.complete, s.score);
        // Lauren James (WSL Chelsea 85): in the club as a bought copy (owners 2) → not first owner.
        let lj = &snap.gallery[&265249];
        println!("Lauren James: {:?}, club bought copies: {}", fo.status(lj), snap.first_owner_club_no.len());
        // Not first owner either way: the club's bought copy, or since then read in-game.
        assert!(matches!(fo.status(lj), gallery_sets::FirstOwnerStatus::ClubNo | gallery_sets::FirstOwnerStatus::ScannedNo));
        let _ = std::fs::remove_dir_all(tmp);
    }

    /// The user's screenshots (2026-10-13 evening): New Items (bought / packs), an incomplete
    /// set, and the "better lineup" notice on set pages.
    #[test]
    #[ignore]
    fn screenshots_round3() {
        let Ok(fixtures) = std::env::var("FCT_SCAN_FIXTURES") else { return };
        let real = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("dk.fctracker.app");
        let tmp = std::env::temp_dir().join(format!("fct-r3-{}", crate::store::now_ms()));
        std::fs::create_dir_all(tmp.join("captures")).unwrap();
        std::fs::copy(real.join("snapshot.json"), tmp.join("snapshot.json")).unwrap();
        let mut store = crate::store::Store::load(tmp.clone());
        store.snapshot.acquired.clear();
        for file in ["u-newitems-bought.webp", "u-newitems-untradeable.webp", "u-newitems-pack-12.webp", "u-transfer-list.webp", "u-club-players.webp",
            "u-totw-incomplete.webp", "u-arsenal-set.webp", "u-pl-set-a.webp", "u-holo-set.webp"] {
            let bytes = std::fs::read(std::path::Path::new(&fixtures).join(file)).unwrap();
            let page = scan::analyse_page(&scan::analyse_bytes(&bytes).unwrap()).unwrap();
            let what = describe(&page);
            let r = process_page(&mut store, page);
            println!("{file}: {}", what.chars().take(140).collect::<String>());
            if let Some(p) = r {
                println!("   → {} {} verified={} better={:?} impacts={:?}", p.kind, p.set_name, p.verified, p.better.map(|b| (b.ingame, b.best, b.gain)),
                    p.impacts.iter().map(|c| (c.name.clone(), c.first_owner, c.set.clone(), c.gain)).collect::<Vec<_>>());
            }
        }
        {
            let snap = &store.snapshot;
            let fo = gallery_sets::FirstOwnerInfo { known: &snap.first_owner, manual: &snap.first_owner_manual, scanned: &snap.first_owner_scanned, club_no: &snap.first_owner_club_no };
            for key in ["set-113", "set-108"] {
                let Some(sum) = gallery_sets::set_summary(key, &snap.gallery, &fo, &snap.team_links, &snap.set_obs, &snap.prices, &snap.set_list) else { continue };
                println!("{} best {} · in-game {:?} · identified {:?}/{:?}", sum.name, sum.best_model, sum.ingame.as_ref().map(|g| g.total), sum.ingame.as_ref().map(|g| g.identified), sum.ingame.as_ref().map(|g| g.slots));
                println!("  best lineup: {:?}", sum.lineup.iter().map(|c| (c.name.clone(), c.score, c.holo, format!("{:?}", c.first_owner))).collect::<Vec<_>>());
                println!("  tags: {:?}", sum.tags.iter().map(|t| (t.name, t.count, t.bonus)).collect::<Vec<_>>());
                if let Some(o) = snap.set_obs.get(key) {
                    println!("  in-game slots: {:?}", o.slots.iter().enumerate().map(|(i, s)| (s.points, s.first_owner, o.identified.get(&i).and_then(|d| snap.gallery.get(d)).and_then(|c| c.name.clone()))).collect::<Vec<_>>());
                }
            }
        }
        let name = |n: &str| store.snapshot.gallery.values().find(|c| c.name.as_deref() == Some(n)).map(|c| c.def_id);
        for n in ["Hjulmand", "Gabri Veiga", "Petersson", "María Pérez"] {
            let id = name(n);
            println!("{n}: acquired {:?} · first owner {:?}", id.and_then(|d| store.snapshot.acquired.get(&d)).map(|a| a.source.clone()), id.and_then(|d| store.snapshot.first_owner_scanned.get(&d)));
        }
        let _ = std::fs::remove_dir_all(tmp);
    }

    /// The user's Gallery video (2026-10-13): category pages, summary and a pending set page.
    #[test]
    #[ignore]
    fn video_pages_end_to_end() {
        let Ok(fixtures) = std::env::var("FCT_SCAN_FIXTURES") else { return };
        let real = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("dk.fctracker.app");
        let tmp = std::env::temp_dir().join(format!("fct-video-{}", crate::store::now_ms()));
        std::fs::create_dir_all(tmp.join("captures")).unwrap();
        std::fs::copy(real.join("snapshot.json"), tmp.join("snapshot.json")).unwrap();
        let mut store = crate::store::Store::load(tmp.clone());
        store.snapshot.set_list.clear();
        for file in ["vid-6.jpg", "vid-10.jpg", "vid-22.jpg", "vid-48.jpg", "vid-38.jpg"] {
            let bytes = std::fs::read(std::path::Path::new(&fixtures).join(file)).unwrap();
            let page = scan::analyse_page(&scan::analyse_bytes(&bytes).unwrap()).unwrap();
            println!("{file}: {:?}", process_page(&mut store, page).map(|p| (p.kind, p.set_name, p.cards_read)));
        }
        let snap = &store.snapshot;
        println!("summary: {:?}", snap.summary);
        let names: std::collections::BTreeMap<String, String> =
            gallery_sets::overview(&snap.gallery, &gallery_sets::FirstOwnerInfo { known: &snap.first_owner, manual: &snap.first_owner_manual, scanned: &snap.first_owner_scanned, club_no: &snap.first_owner_club_no }, &snap.team_links, &snap.set_obs, &snap.prices, &snap.set_list)
                .into_iter()
                .flat_map(|c| c.sets)
                .filter(|s| s.listed.is_some())
                .map(|s| (s.name.clone(), format!("listed {:?} · ours {} · slots {}", s.listed.as_ref().map(|l| (l.score, l.filled)), s.score, s.slots)))
                .collect();
        println!("{} sets read from category pages", names.len());
        for (n, v) in &names {
            println!("  {n:24} {v}");
        }
        let _ = std::fs::remove_dir_all(tmp);
    }

    /// Arsenal from the video: set page, then the game's swap previews → our advice.
    #[test]
    #[ignore]
    fn video_swap_advice() {
        let Ok(fixtures) = std::env::var("FCT_SCAN_FIXTURES") else { return };
        let real = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("dk.fctracker.app");
        let tmp = std::env::temp_dir().join(format!("fct-advice-{}", crate::store::now_ms()));
        std::fs::create_dir_all(tmp.join("captures")).unwrap();
        std::fs::copy(real.join("snapshot.json"), tmp.join("snapshot.json")).unwrap();
        let mut store = crate::store::Store::load(tmp.clone());
        for file in ["arsenal-set-26.jpg", "swap-28.jpg", "swap-30.jpg", "swap-34.jpg", "swap-36.jpg"] {
            let bytes = std::fs::read(std::path::Path::new(&fixtures).join(file)).unwrap();
            let page = scan::analyse_page(&scan::analyse_bytes(&bytes).unwrap()).unwrap();
            let r = process_page(&mut store, page);
            println!("{file}: {:?}", r.as_ref().map(|p| (p.kind, p.verified, p.identified, p.ambiguous)));
            if let Some(a) = r.and_then(|p| p.advice) {
                println!("   in-game {:+} · model {:?} · exact {} · best {:?} {:+} · highlighted best {}", a.ingame_delta, a.model_delta, a.model_exact, a.best.as_ref().and_then(|c| c.name.clone()), a.best_gain, a.highlighted_is_best);
            }
        }
        let _ = std::fs::remove_dir_all(tmp);
    }

    /// End to end on the user's own screenshots against a *copy* of their real snapshot:
    /// set page → swap page → identification, first-owner facts and swap suggestions.
    /// `FCT_SCAN_FIXTURES=… cargo test --lib tracking -- --ignored --nocapture`
    #[test]
    fn a_category_tile_with_an_unknown_name_is_noted_once() {
        let tmp = std::env::temp_dir().join(format!("fct-unknown-{}", crate::store::now_ms()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut store = crate::store::Store::load(tmp.clone());
        let tile = |title: &str, score: Option<u32>| scan::ListTile { title: title.into(), score, filled: None };
        let page = || Page::SetList { tiles: vec![tile("Wrexham AFC", Some(1200)), tile("MLS", Some(5000)), tile("Gallery Level", None), tile("Arsenal", Some(900))] };
        process_page(&mut store, page());
        process_page(&mut store, page());
        assert_eq!(store.unknown_new, vec!["Wrexham AFC".to_string()]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    #[ignore]
    fn pl_set_then_swap_page_end_to_end() {
        let Ok(fixtures) = std::env::var("FCT_SCAN_FIXTURES") else { return };
        let real = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("dk.fctracker.app");
        let tmp = std::env::temp_dir().join(format!("fct-e2e-{}", crate::store::now_ms()));
        std::fs::create_dir_all(tmp.join("captures")).unwrap();
        std::fs::copy(real.join("snapshot.json"), tmp.join("snapshot.json")).unwrap();
        let mut store = crate::store::Store::load(tmp.clone());

        store.snapshot.flags.clear();
        let files: Vec<String> = std::env::var("FCT_E2E").map(|v| v.split(",").map(String::from).collect()).unwrap_or_else(|_| vec!["own-set-pl-2.webp".into(), "own-swap-pl.webp".into()]);
        for file in files.iter().map(String::as_str) {
            let bytes = std::fs::read(std::path::Path::new(&fixtures).join(file)).unwrap();
            let page = scan::analyse_page(&scan::analyse_bytes(&bytes).unwrap()).unwrap();
            let current = process_page(&mut store, page).expect("gallery page");
            println!("{file}: {current:?}");
        }
        let snap = &store.snapshot;
        let fo = gallery_sets::FirstOwnerInfo { known: &snap.first_owner, manual: &snap.first_owner_manual, scanned: &snap.first_owner_scanned, club_no: &snap.first_owner_club_no };
        let cats = gallery_sets::overview(&snap.gallery, &fo, &snap.team_links, &snap.set_obs, &snap.prices, &snap.set_list);
        let pl = cats.iter().flat_map(|c| &c.sets).find(|s| s.name == "Premier League").unwrap();
        println!("in-game: {:?}", pl.ingame);
        println!("best possible: {}", pl.score);
        let name_of = |n: &str| snap.gallery.values().find(|c| c.name.as_deref() == Some(n) && c.collected && c.league == Some(13)).map(|c| c.def_id);
        for n in ["Ødegaard", "Bruno Guimarães", "David Raya", "Rice", "Grealish", "Gakpo", "Muñoz", "Dunk"] {
            let id = name_of(n);
            println!("  {n}: scanned first owner = {:?}", id.and_then(|d| snap.first_owner_scanned.get(&d)));
        }
        println!("  flags learned for {} nations", snap.flags.len());
        if let Some(o) = snap.set_obs.get("set-108") {
            for (i, sl) in o.slots.iter().enumerate().filter(|(_, s)| s.points == 340) {
                println!("  slot {i}: 340 r{:?} {:?} fo={} id={:?}", sl.rating, sl.position, sl.first_owner, o.identified.get(&i).and_then(|d| snap.gallery.get(d)).and_then(|c| c.name.clone()));
            }
            for c in snap.gallery.values().filter(|c| c.collected && c.league == Some(13) && c.score == 340) {
                println!("  cand {:?} r{:?} {:?} nation {:?} outside={} flag_learned={}", c.name, c.rating, c.position, c.nation, o.unselected.contains(&c.def_id), c.nation.is_some_and(|n| snap.flags.contains_key(&n)));
            }
        }
        for sw in &pl.swaps {
            println!(
                "  swap out {} ({}, {:?}) → in {} {} ({}) fo={:?}",
                sw.out.name.clone().unwrap_or_else(|| format!("slot {}", sw.out.slot.unwrap_or(0) + 1)),
                sw.out.score,
                sw.out.first_owner,
                sw.into.rating.unwrap_or(0),
                sw.into.name.clone().unwrap_or_default(),
                sw.into.score,
                sw.into.first_owner
            );
        }
        let _ = std::fs::remove_dir_all(tmp);
    }
}
