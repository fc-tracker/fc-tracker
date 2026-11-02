//! The game's Evolutions screen (My Evolutions): the detail panel names one evolution and says
//! "Active" or "Inactive" (its button: Pause / Activate). Activating or pausing an evolution in the
//! game changes who is on the bench, long before the next sync reads EA's Evolutions hub – so what
//! the screen shows is written into the hub kept from the last sync (`/academy/hub/v2`), and the
//! plan, the bench and the match reminders follow at once. The next sync replaces it with EA's own.
//! Menus only, like every read (Evolutions is never on screen in a match).
use crate::scan::Word;
use serde_json::Value;

/// The evolutions the hub has a player in: (slot id, its name as the game shows it).
pub fn started_slots(hub: &Value) -> Vec<(u64, String)> {
    hub.get("slots")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|s| s.get("realPlayerId").and_then(Value::as_u64).is_some_and(|i| i > 0))
        .filter_map(|s| Some((s.get("id")?.as_u64()?, s.get("slotName")?.as_str()?.trim().to_string())))
        .filter(|(_, n)| !n.is_empty())
        .collect()
}

/// (slot, active) when the screen is the detail of an evolution the hub knows.
pub fn read_screen(words: &[Word], slots: &[(u64, String)]) -> Option<(u64, bool)> {
    let has = |s: &str| words.iter().any(|w| w.text == s);
    if !words.iter().any(|w| w.text.starts_with("Evolution")) {
        return None;
    }
    // the badge ("Active" / "Inactive", capitalised – the challenge text's "your active EVO
    // player" is lower case) and the button must not disagree
    let active = match (has("Active"), has("Inactive")) {
        (true, false) => true,
        (false, true) => false,
        _ => return None,
    };
    if (active && has("Activate") && !has("Pause")) || (!active && has("Pause") && !has("Activate")) {
        return None;
    }
    let screen = crate::names::normalise_name(&words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "));
    // the longest name on screen ("Intro to Evolutions" holds "Evolutions", a tab)
    slots
        .iter()
        .map(|(id, n)| (*id, crate::names::normalise_name(n)))
        .filter(|(_, n)| n.len() >= 5 && n != "evolutions" && screen.contains(n.as_str()))
        .max_by_key(|(_, n)| n.len())
        .map(|(id, _)| (id, active))
}

/// Writes what the screen showed into the hub. False when it already said so.
pub fn apply(hub: &mut Value, slot: u64, active: bool) -> bool {
    let Some(s) = hub.get_mut("slots").and_then(Value::as_array_mut).and_then(|a| a.iter_mut().find(|s| s.get("id").and_then(Value::as_u64) == Some(slot))) else {
        return false;
    };
    let timed = s.get("timed").and_then(Value::as_bool).unwrap_or(false);
    let status = if active { "ACTIVE" } else { "INACTIVE" };
    let was = s.get("status").and_then(Value::as_str) == Some(status);
    s["status"] = Value::from(status);
    let mut changed = !was;
    let mut set = |key: &str, on: bool| {
        let list = hub.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        let mut ids: Vec<u64> = list.iter().filter_map(Value::as_u64).collect();
        let had = ids.contains(&slot);
        if on && !had {
            ids.push(slot);
        } else if !on && had {
            ids.retain(|&i| i != slot);
        } else {
            return;
        }
        changed = true;
        hub[key] = Value::from(ids);
    };
    set("activeSlotIds", active);
    set("activeTimedSlotIds", active && timed);
    set("inactiveSlotIds", !active);
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn w(t: &str) -> Word {
        Word { text: t.into(), x: 0.0, y: 0.0, w: 0.0, h: 0.0 }
    }
    fn words(s: &str) -> Vec<Word> {
        s.split_whitespace().map(w).collect()
    }
    fn hub() -> Value {
        json!({
            "activeSlotIds": [2695, 2815], "activeTimedSlotIds": [], "inactiveSlotIds": [2813], "activeSlotLimit": 2,
            "slots": [
                { "id": 2695, "slotName": "Intro to Evolutions", "status": "ACTIVE", "realPlayerId": 11, "timed": false },
                { "id": 2815, "slotName": "Center Spectre", "status": "ACTIVE", "realPlayerId": 12, "timed": false },
                { "id": 2813, "slotName": "Poor Sophia", "status": "INACTIVE", "realPlayerId": 13, "timed": false },
                { "id": 9, "slotName": "Not started", "status": "INACTIVE", "realPlayerId": 0 }
            ]
        })
    }

    #[test]
    fn the_detail_panel_tells_the_evolution_and_its_state() {
        let slots = started_slots(&hub());
        assert_eq!(slots.len(), 3, "an evolution without a player is not one of the user's");
        let poor = words("Club Evolutions My Evolutions Training Camp Poor Sophia Inactive Level 1: Challenges Play 2 matches using your active EVO player in game. Activate");
        assert_eq!(read_screen(&poor, &slots), Some((2813, false)));
        let intro = words("Club Evolutions My Evolutions Intro to Evolutions Welcome Active Level 3: Rewards Pause");
        assert_eq!(read_screen(&intro, &slots), Some((2695, true)), "the longest name wins over the Evolutions tab");
        // the badge and the button disagree: not read
        assert_eq!(read_screen(&words("Evolutions Center Spectre Active Activate"), &slots), None);
        // another screen with the name on it (no badge)
        assert_eq!(read_screen(&words("Evolutions Center Spectre Level 1 of 3"), &slots), None);
    }

    #[test]
    fn the_hub_follows_the_screen() {
        let mut h = hub();
        assert!(apply(&mut h, 2813, true));
        assert_eq!(h["activeSlotIds"], json!([2695, 2815, 2813]));
        assert_eq!(h["inactiveSlotIds"], json!([]));
        assert!(apply(&mut h, 2815, false));
        assert_eq!(h["activeSlotIds"], json!([2695, 2813]));
        assert_eq!(h["slots"][1]["status"], "INACTIVE");
        assert!(!apply(&mut h, 2815, false), "seen again: nothing new");
    }
}
