//! Match reminders (SQUADS.md, user 2026-11-01): the match clock is read in every mode – one small
//! look at the scoreboard per `match_ms` – and the user hears what the plan needs in this match:
//! loading in, the bench and when each is subbed on; at the set moments (half time …) the subs still
//! to come; at each player's minute "Sub on Suhonen now". The sub minute is a setting (70:00) and can
//! be changed per player on the bench (75:00 for one who only has to come on).

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

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
struct Live {
    needs: Vec<Need>,
    /// Moments already shown in this match.
    fired: Vec<u16>,
    /// Players already told to come on.
    subbed: Vec<String>,
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
        let needs = view.combos.first().map(|s| needs_of(s, &squad_prefs, &prefs)).unwrap_or_default();
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

pub fn match_ended() {
    *LIVE.lock().unwrap() = None;
}

/// The clock read `minute`: the players whose minute came, else the latest moment passed.
pub fn minute(app: &AppHandle, minute: u16) {
    let prefs = clamp(app.state::<crate::AppState>().ui.lock().unwrap().reminders.clone());
    if !prefs.on {
        return;
    }
    let now: Vec<Need> = {
        let mut live = LIVE.lock().unwrap();
        let Some(l) = live.as_mut() else { return };
        let due: Vec<Need> = l.needs.iter().filter(|n| !n.start && n.at <= minute && !l.subbed.contains(&n.player)).cloned().collect();
        l.subbed.extend(due.iter().map(|n| n.player.clone()));
        due
    };
    if !now.is_empty() {
        show(app, minute, true, now);
        return;
    }
    // a late first reading never shows several moments at once: the latest one
    let due = {
        let live = LIVE.lock().unwrap();
        let Some(l) = live.as_ref() else { return };
        prefs.at.iter().copied().filter(|&m| m > 0 && m <= minute && !l.fired.contains(&m)).max()
    };
    if let Some(m) = due {
        if let Some(l) = LIVE.lock().unwrap().as_mut() {
            l.fired.extend(prefs.at.iter().copied().filter(|&x| x > 0 && x <= m));
        }
        moment(app, m);
    }
}

/// A set moment: loading in (everyone, with their minutes), later the subs still to come.
fn moment(app: &AppHandle, at: u16) {
    let needs = {
        let mut live = LIVE.lock().unwrap();
        let Some(l) = live.as_mut() else { return };
        if at == 0 {
            if l.fired.contains(&0) {
                return;
            }
            l.fired.push(0);
        }
        l.needs.iter().filter(|n| (at == 0 || !n.start) && !l.subbed.contains(&n.player)).cloned().collect::<Vec<_>>()
    };
    show(app, at, false, needs);
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

    #[test]
    fn reminders_default_to_loading_in_and_half_time_and_subs_at_70() {
        assert_eq!(Prefs::default(), Prefs { on: true, at: vec![0, 45], sub_at: 70 });
        assert_eq!(clamp(Prefs { on: true, at: vec![30, 55, 200, 80], sub_at: 75 }).at, vec![30, 55]);
        // a ui.json from before: [0, 45, 70] – the 70 is the sub minute now
        assert_eq!(clamp(Prefs { on: true, at: vec![0, 45, 70], sub_at: 70 }).at, vec![0, 45]);
    }
}
