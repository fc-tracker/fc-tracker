//! Match reminders (SQUADS.md, user 2026-11-01): the match clock is read in every mode – one small
//! look at the scoreboard per `match_ms` – and at set moments the user hears what the plan needs
//! in this match: an evolution player to sub on ("Sub on Suhonen – Center Spectre"), one that has
//! to start, a bench card for objectives that count for a sub. Defaults: loading into the match (0), half time (45), 70:00 – each changeable.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Settings → Match reminders (in `ui.json`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Prefs {
    /// Read the match clock in every match (on by default).
    pub on: bool,
    /// Match minutes to remind at; 0 = loading into the match, 45 = half time.
    pub at: Vec<u16>,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { on: true, at: vec![0, 45, 70] }
    }
}

pub fn clamp(mut p: Prefs) -> Prefs {
    for m in &mut p.at {
        *m = (*m).min(120);
    }
    p.at.truncate(3);
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
}

#[derive(Default)]
struct Live {
    needs: Vec<Need>,
    /// Reminder minutes already shown in this match.
    fired: Vec<u16>,
}

static LIVE: Mutex<Option<Live>> = Mutex::new(None);

/// A match starts (loading in): what it needs comes from the plan – worked out in the background,
/// then the 0-minute reminder.
pub fn match_started(app: &AppHandle) {
    *LIVE.lock().unwrap() = Some(Live::default());
    let (prefs, input, squad_prefs) = {
        let state = app.state::<crate::AppState>();
        let ui = state.ui.lock().unwrap();
        let prefs = ui.reminders.clone();
        if !prefs.on {
            return;
        }
        let input = crate::squads_input(&state.store.lock().unwrap());
        (prefs, input, ui.squads.clone())
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let view = crate::squads::plan(&input, &squad_prefs);
        let needs: Vec<Need> = view
            .combos
            .first()
            .map(|s| {
                let evos = s.evos.iter().filter(|e| e.start || !e.in_xi).map(|e| Need { player: e.player.clone(), evo: e.name.clone(), level: e.level, levels: e.levels, start: e.start && e.in_xi, bench: false });
                // the bench for objectives that count for a sub (user 2026-11-01)
                let bench = s.bench.iter().map(|b| Need { player: b.name.clone(), evo: b.objectives.iter().take(2).cloned().collect::<Vec<_>>().join(", "), level: 0, levels: 0, start: false, bench: true });
                evos.chain(bench).collect()
            })
            .unwrap_or_default();
        {
            let mut live = LIVE.lock().unwrap();
            let Some(l) = live.as_mut() else { return };
            l.needs = needs;
        }
        if prefs.at.contains(&0) {
            fire(&app, 0, &prefs);
        }
    });
}

pub fn match_ended() {
    *LIVE.lock().unwrap() = None;
}

/// The clock read `minute`: the reminders it passed.
pub fn minute(app: &AppHandle, minute: u16) {
    let prefs = app.state::<crate::AppState>().ui.lock().unwrap().reminders.clone();
    if !prefs.on {
        return;
    }
    // the latest moment passed (a late first reading never shows three reminders at once)
    let due = {
        let live = LIVE.lock().unwrap();
        let Some(l) = live.as_ref() else { return };
        prefs.at.iter().copied().filter(|&m| m > 0 && m <= minute && !l.fired.contains(&m)).max()
    };
    if let Some(m) = due {
        // everything up to it counts as shown
        if let Some(l) = LIVE.lock().unwrap().as_mut() {
            l.fired.extend(prefs.at.iter().copied().filter(|&x| x > 0 && x <= m));
        }
        fire(app, m, &prefs);
    }
}

fn fire(app: &AppHandle, at: u16, prefs: &Prefs) {
    let needs = {
        let mut live = LIVE.lock().unwrap();
        let Some(l) = live.as_mut() else { return };
        if at == 0 {
            if l.fired.contains(&0) {
                return;
            }
            l.fired.push(0);
        }
        // once he is on, only the subs are left to remind of
        l.needs.iter().filter(|n| at == 0 || !n.start).cloned().collect::<Vec<_>>()
    };
    if needs.is_empty() {
        return;
    }
    // the moment the subs are planned for: the next reminder after loading in
    let sub_at = prefs.at.iter().copied().filter(|&m| m > 0).min();
    let payload = serde_json::json!({ "kind": "match-reminder", "at": at, "subAt": sub_at, "needs": needs });
    crate::tracking::log(&app.state::<crate::AppState>().data_dir, &format!("reminder at {at}': {} evo player(s)", needs.len()));
    let a2 = app.clone();
    let _ = app.run_on_main_thread(move || crate::show_notice(&a2, payload, 8));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reminders_default_to_loading_in_half_time_and_70() {
        assert_eq!(Prefs::default(), Prefs { on: true, at: vec![0, 45, 70] });
        assert_eq!(clamp(Prefs { on: true, at: vec![30, 55, 200, 80] }).at, vec![30, 55, 120]);
    }
}
