//! Match reminders (SQUADS.md, user 2026-11-01): the match clock is read in every mode – one small
//! look at the scoreboard per `match_ms` – and the user hears what the plan needs in this match:
//! loading in, the bench and when each is subbed on; at the set moments (half time …) the subs still
//! to come; at each player's minute "Sub on Suhonen now". The sub minute is a setting (70:00) and can
//! be changed per player on the bench (75:00 for one who only has to come on).

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Settings → Match reminders (in `ui.json`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Prefs {
    /// Read the match clock in every match (on by default).
    pub on: bool,
    /// Moments to remind of the subs still to come; 0 = loading into the match, 45 = half time.
    pub at: Vec<u16>,
    /// When a bench player is subbed on (each can have his own minute: `SquadPrefs::sub_at`).
    pub sub_at: u16,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { on: true, at: vec![0, 45], sub_at: 70 }
    }
}

pub fn clamp(mut p: Prefs) -> Prefs {
    p.sub_at = p.sub_at.clamp(1, 120);
    for m in &mut p.at {
        *m = (*m).min(120);
    }
    // the old third moment (70) is the sub minute now
    let sub = p.sub_at;
    p.at.retain(|&m| m != sub);
    p.at.sort_unstable();
    p.at.dedup();
    p.at.truncate(2);
    p
}

/// What one match needs, worked out when it starts.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Need {
    pub player: String,
    /// The evolution (its name) or the objectives (names) a sub counts for.
    pub evo: String,
    pub level: u32,
    pub levels: u32,
    /// Starts (the evo needs him from the start); else he is subbed on.
    pub start: bool,
    /// A bench card for objectives (not an evolution).
    pub bench: bool,
    /// The minute he is subbed on.
    pub at: u16,
}

#[derive(Default)]
pub(crate) struct Live {
    pub(crate) needs: Vec<Need>,
    /// Moments already shown in this match.
    fired: Vec<u16>,
    /// Players already told to come on.
    subbed: Vec<String>,
    /// The clock was read at least once (logged once per match).
    clock_seen: bool,
    /// The last minute taken as true, and a run of the same other reading (see `steady`).
    last_ok: Option<u16>,
    run: Option<(u16, u8)>,
}

static LIVE: Mutex<Option<Live>> = Mutex::new(None);

/// The needs of a planned session: evo players and bench cards with their sub minute.
pub fn needs_of(s: &crate::squads::ComboPlan, squad: &crate::squads::SquadPrefs, prefs: &Prefs) -> Vec<Need> {
    // Rush: one player the whole match, no subs to remind of
    if s.rush_format {
        return Vec::new();
    }
    let minute = |key: u64| squad.sub_at.get(&key).copied().unwrap_or(prefs.sub_at);
    let evos = s.evos.iter().filter(|e| e.start || !e.in_xi).map(|e| Need { player: e.player.clone(), evo: e.name.clone(), level: e.level, levels: e.levels, start: e.start && e.in_xi, bench: false, at: minute(e.key) });
    // the bench for objectives that count for a sub (user 2026-11-01)
    let bench = s.bench.iter().map(|b| Need { player: b.name.clone(), evo: b.objectives.iter().take(2).cloned().collect::<Vec<_>>().join(", "), level: 0, levels: 0, start: false, bench: true, at: minute(b.key) });
    evos.chain(bench).collect()
}

/// A match starts (loading in): what it needs comes from the plan – worked out in the background,
/// then the loading-in reminder.
pub fn match_started(app: &AppHandle) {
    *LIVE.lock().unwrap() = Some(Live::default());
    let (prefs, input, squad_prefs) = {
        let state = app.state::<crate::AppState>();
        let ui = state.ui.lock().unwrap();
        let prefs = clamp(ui.reminders.clone());
        if !prefs.on {
            return;
        }
        let input = crate::squads_input(&state.store.lock().unwrap());
        (prefs, input, ui.squads.clone())
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let view = crate::squads::plan(&input, &squad_prefs);
        let mut needs = view.combos.first().map(|s| needs_of(s, &squad_prefs, &prefs)).unwrap_or_default();
        // No plan for this match (another mode than the planned one, no squad yet …): the active
        // evolutions that a match moves on still get their sub reminder – a match without it is a
        // wasted level (user 2026-11-02).
        if needs.is_empty() {
            needs = active_evo_needs(&input, &squad_prefs, &prefs);
        }
        crate::tracking::log(
            &app.state::<crate::AppState>().data_dir,
            &format!("match reminders: {} to remind of ({})", needs.len(), needs.iter().map(|n| format!("{} {}'", n.player, n.at)).collect::<Vec<_>>().join(", ")),
        );
        {
            let mut live = LIVE.lock().unwrap();
            let Some(l) = live.as_mut() else { return };
            l.needs = needs;
        }
        if prefs.at.contains(&0) {
            moment(&app, 0);
        }
    });
}

/// Every active evolution a match moves on, its player subbed on at his minute (or starting).
fn active_evo_needs(input: &crate::squads::Input, squad: &crate::squads::SquadPrefs, prefs: &Prefs) -> Vec<Need> {
    input
        .evos
        .iter()
        .filter(|e| !e.modes.is_empty())
        .filter_map(|e| {
            let player = input.club.iter().find(|p| p.key == e.item)?.name.clone();
            Some(Need { player, evo: e.name.clone(), level: e.level, levels: e.levels, start: e.start, bench: false, at: squad.sub_at.get(&e.item).copied().unwrap_or(prefs.sub_at) })
        })
        .collect()
}

pub fn match_ended() {
    *LIVE.lock().unwrap() = None;
}

/// The clock read `minute`: the players whose minute came, else the latest moment passed.
pub fn minute(app: &AppHandle, minute: u16) {
    let prefs = clamp(app.state::<crate::AppState>().ui.lock().unwrap().reminders.clone());
    if !prefs.on {
        return;
    }
    // one misread must never remind early (a replay of a recording read 28' as 23')
    let minute = {
        let mut live = LIVE.lock().unwrap();
        let Some(l) = live.as_mut() else { return };
        match steady(l, minute) {
            Some(m) => m,
            None => return,
        }
    };
    {
        let mut live = LIVE.lock().unwrap();
        if let Some(l) = live.as_mut() {
            if !l.clock_seen {
                l.clock_seen = true;
                crate::tracking::log(&app.state::<crate::AppState>().data_dir, &format!("match clock: first reading {minute}'"));
            }
        }
    }
    // the side panel's match brief (T24, mockup 07): the clock as read and the subs still to come
    {
        let live = LIVE.lock().unwrap();
        let next: Vec<Need> = live.as_ref().map(|l| l.needs.iter().filter(|n| !n.start && !l.subbed.contains(&n.player)).cloned().collect()).unwrap_or_default();
        let _ = app.emit_to(crate::MISSING, "match-clock", serde_json::json!({ "minute": minute, "needs": next }));
    }
    let shown = {
        let mut live = LIVE.lock().unwrap();
        let Some(l) = live.as_mut() else { return };
        on_minute(l, &prefs, minute)
    };
    if let Some(r) = shown {
        show(app, r.at, r.now, r.needs);
    }
}

/// The clock as the reminders take it: a reading moving on from the last one by 0–3 minutes is
/// taken; anything else (a jump, a step back – a misread "28" → "23", "23" → "73") only when the same
/// reading comes three times in a row. The clock moves about a minute every 8–10 s, so a true jump
/// (the app started mid-match) is taken within a few looks, while one misread is never acted on.
pub(crate) fn steady(l: &mut Live, m: u16) -> Option<u16> {
    let near = l.last_ok.is_some_and(|last| m >= last && m <= last + 3);
    let run = match l.run {
        Some((v, n)) if v == m => n + 1,
        _ => 1,
    };
    l.run = Some((m, run));
    if near || run >= 3 {
        l.last_ok = Some(m);
        return Some(m);
    }
    None
}

/// What one reminder shows: at which minute, "sub on now" or a set moment, and who.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Shown {
    pub at: u16,
    pub now: bool,
    pub needs: Vec<Need>,
}

/// The clock read `minute` (pure – the app and the recording replay run the same rules): the
/// players whose minute came, else the latest set moment passed (a late first reading never shows
/// several moments at once).
pub(crate) fn on_minute(l: &mut Live, prefs: &Prefs, minute: u16) -> Option<Shown> {
    let due: Vec<Need> = l.needs.iter().filter(|n| !n.start && n.at <= minute && !l.subbed.contains(&n.player)).cloned().collect();
    if !due.is_empty() {
        l.subbed.extend(due.iter().map(|n| n.player.clone()));
        return Some(Shown { at: minute, now: true, needs: due });
    }
    let m = prefs.at.iter().copied().filter(|&m| m > 0 && m <= minute && !l.fired.contains(&m)).max()?;
    l.fired.extend(prefs.at.iter().copied().filter(|&x| x > 0 && x <= m));
    moment_of(l, m)
}

/// A set moment: loading in (everyone, with their minutes), later the subs still to come.
pub(crate) fn moment_of(l: &mut Live, at: u16) -> Option<Shown> {
    if at == 0 {
        if l.fired.contains(&0) {
            return None;
        }
        l.fired.push(0);
    }
    let needs: Vec<Need> = l.needs.iter().filter(|n| (at == 0 || !n.start) && !l.subbed.contains(&n.player)).cloned().collect();
    (!needs.is_empty()).then_some(Shown { at, now: false, needs })
}

fn moment(app: &AppHandle, at: u16) {
    let shown = {
        let mut live = LIVE.lock().unwrap();
        let Some(l) = live.as_mut() else { return };
        moment_of(l, at)
    };
    if let Some(r) = shown {
        show(app, r.at, r.now, r.needs);
    }
}

fn show(app: &AppHandle, at: u16, now: bool, needs: Vec<Need>) {
    if needs.is_empty() {
        return;
    }
    let payload = serde_json::json!({ "kind": "match-reminder", "at": at, "now": now, "needs": needs });
    crate::tracking::log(&app.state::<crate::AppState>().data_dir, &format!("reminder at {at}'{}: {} player(s)", if now { " (sub on)" } else { "" }, needs.len()));
    let a2 = app.clone();
    let _ = app.run_on_main_thread(move || crate::show_notice(&a2, payload, 8));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn need(player: &str, start: bool, at: u16) -> Need {
        Need { player: player.into(), evo: "Evo".into(), level: 1, levels: 3, start, bench: false, at }
    }
    fn who(r: &Option<Shown>) -> Vec<String> {
        r.as_ref().map(|r| r.needs.iter().map(|n| n.player.clone()).collect()).unwrap_or_default()
    }

    /// The user's scenario (2026-11-05): an evo player subbed on at 30:00, one who starts, a bench
    /// card at 70:00 – minute by minute as the clock reads them, each reminder exactly once.
    #[test]
    fn an_evo_sub_at_30_fires_once_and_the_rest_at_their_minutes() {
        let prefs = Prefs::default();
        let mut l = Live { needs: vec![need("Suhonen", false, 30), need("Starter", true, 70), need("Bench", false, 70)], ..Default::default() };
        // loading in: everyone, the starter too
        assert_eq!(who(&moment_of(&mut l, 0)), vec!["Suhonen", "Starter", "Bench"]);
        assert_eq!(moment_of(&mut l, 0), None, "loading in shows once");
        let mut log = Vec::new();
        for m in 0..=95u16 {
            if let Some(r) = on_minute(&mut l, &prefs, m) {
                log.push((m, r.now, r.needs.iter().map(|n| n.player.clone()).collect::<Vec<_>>()));
            }
        }
        assert_eq!(
            log,
            vec![
                (30, true, vec!["Suhonen".to_string()]),
                // half time: the subs still to come (never the starter, never one already on)
                (45, false, vec!["Bench".to_string()]),
                (70, true, vec!["Bench".to_string()]),
            ]
        );
    }

    /// The clock can be read late (the app started mid-match) or skip minutes: the due sub still
    /// comes, and several passed moments show as one.
    #[test]
    fn a_late_or_skipping_clock_still_reminds_once() {
        let prefs = Prefs { on: true, at: vec![30, 45], sub_at: 70 };
        let mut l = Live { needs: vec![need("Late", false, 70)], ..Default::default() };
        // first reading at 50': the 30' and 45' moments are one reminder
        let r = on_minute(&mut l, &prefs, 50).unwrap();
        assert_eq!((r.at, r.now), (45, false));
        assert_eq!(on_minute(&mut l, &prefs, 51), None);
        // the clock jumps from 66' to 74' (a missed look): the sub still comes, once
        assert_eq!(on_minute(&mut l, &prefs, 66), None);
        assert_eq!(who(&on_minute(&mut l, &prefs, 74)), vec!["Late"]);
        assert_eq!(on_minute(&mut l, &prefs, 80), None);
    }

    /// One misread never counts: a jump up (23' read as 73') or back needs three readings in a row;
    /// normal steps are taken at once, and a true jump (the app started mid-match) within three looks.
    #[test]
    fn a_misread_minute_is_never_taken() {
        let mut l = Live::default();
        // the first readings of a match: three in a row (0' at kickoff)
        assert_eq!([0u16, 0, 0].map(|m| steady(&mut l, m)), [None, None, Some(0)]);
        assert_eq!(steady(&mut l, 1), Some(1));
        assert_eq!(steady(&mut l, 3), Some(3));
        // "23" read as "73" once: not taken; the true minute goes on
        assert_eq!(steady(&mut l, 73), None);
        assert_eq!(steady(&mut l, 4), Some(4));
        // "28" read as "23" (back): not taken
        assert_eq!(steady(&mut l, 1), None);
        assert_eq!(steady(&mut l, 5), Some(5));
        // the app started late / a long gap: 60' three times → taken
        assert_eq!([60u16, 60, 60].map(|m| steady(&mut l, m)), [None, None, Some(60)]);
    }

    /// A misread clock that goes back (the replay found "10:36" read as 0') must not fire anything
    /// twice or early.
    #[test]
    fn a_clock_going_back_never_fires_again() {
        let prefs = Prefs::default();
        let mut l = Live { needs: vec![need("Sub", false, 30)], ..Default::default() };
        assert_eq!(who(&on_minute(&mut l, &prefs, 31)), vec!["Sub"]);
        for m in [3u16, 13, 30, 31] {
            assert_eq!(on_minute(&mut l, &prefs, m), None, "{m}'");
        }
    }

    #[test]
    fn reminders_default_to_loading_in_and_half_time_and_subs_at_70() {
        assert_eq!(Prefs::default(), Prefs { on: true, at: vec![0, 45], sub_at: 70 });
        assert_eq!(clamp(Prefs { on: true, at: vec![30, 55, 200, 80], sub_at: 75 }).at, vec![30, 55]);
        // a ui.json from before: [0, 45, 70] – the 70 is the sub minute now
        assert_eq!(clamp(Prefs { on: true, at: vec![0, 45, 70], sub_at: 70 }).at, vec![0, 45]);
    }
}
