//! The game's Objectives screen (FUT Objectives → Seasonal / Campaigns …): one event's objectives,
//! each row its name and "progress/target" ("Tricks and Treats 8/10"). Read while the user browses
//! (menus only), the real numbers replace the plan's estimate from the last sync at once
//! (SQUADS.md "read the in-game Objectives screen"). Only rows whose name and target agree with the
//! synced objective are taken – a misread number never moves anything.
use crate::scan::Word;
use crate::squads::Group;

/// Lower case, letters and digits ("Play 3" ≠ "Play 1"; "Lost Your Head?" = "lostyourhead").
fn key(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_digit() { c.to_string() } else { crate::names::normalise_name(&c.to_string()) }).collect()
}

/// The screen's lines: words on one height, left to right.
fn rows(words: &[Word]) -> Vec<Vec<&Word>> {
    let mut ws: Vec<&Word> = words.iter().collect();
    ws.sort_by(|a, b| (a.y + a.h / 2.0).total_cmp(&(b.y + b.h / 2.0)));
    let mut out: Vec<Vec<&Word>> = Vec::new();
    for w in ws {
        let mid = w.y + w.h / 2.0;
        match out.last_mut() {
            Some(r) if (r[0].y + r[0].h / 2.0 - mid).abs() < r[0].h.max(w.h) * 0.6 => r.push(w),
            _ => out.push(vec![w]),
        }
    }
    for r in &mut out {
        r.sort_by(|a, b| a.x.total_cmp(&b.x));
    }
    out
}

/// "8/10", "8 / 10" at the end of a run of words.
fn fraction(ws: &[&Word]) -> Option<(usize, u32, u32)> {
    let t: Vec<&str> = ws.iter().map(|w| w.text.as_str()).collect();
    for i in (0..t.len()).rev() {
        if let Some((a, b)) = t[i].split_once('/') {
            if let (Ok(a), Ok(b)) = (a.parse::<u32>(), b.parse::<u32>()) {
                return Some((i, a, b));
            }
        }
        if i >= 2 && t[i - 1] == "/" {
            if let (Ok(a), Ok(b)) = (t[i - 2].parse::<u32>(), t[i].parse::<u32>()) {
                return Some((i - 2, a, b));
            }
        }
    }
    None
}

/// The event on screen and the progress of each of its objectives the screen shows.
pub fn read_screen(words: &[Word], groups: &[Group]) -> Option<(u64, Vec<(u64, u32)>)> {
    let lines = rows(words);
    // The event: its title as the screen's biggest heading (the left column lists other events too)
    let mut best: Option<(&Group, f32)> = None;
    for g in groups.iter().filter(|g| g.title.len() >= 4) {
        let t = key(&g.title);
        for r in &lines {
            let line = key(&r.iter().map(|w| w.text.as_str()).collect::<String>());
            if line.contains(&t) {
                let h = r.iter().map(|w| w.h).fold(0.0, f32::max);
                if best.is_none_or(|(bg, bh)| h > bh * 1.05 || (h > bh * 0.95 && g.title.len() > bg.title.len())) {
                    best = Some((g, h));
                }
            }
        }
    }
    let (group, _) = best?;
    let mut seen: Vec<(u64, u32)> = Vec::new();
    for r in &lines {
        // a row may hold the detail panel next to it: take every "name … a/b" run in it
        let mut start = 0;
        while start < r.len() {
            let Some((i, progress, target)) = fraction(&r[start..]) else { break };
            let name = key(&r[start..start + i].iter().map(|w| w.text.as_str()).collect::<String>());
            let end = start + i + 1;
            if !name.is_empty() {
                // the longest objective name the run ends with (words before it belong to another column)
                if let Some(o) = group.objectives.iter().filter(|o| o.target == target && progress <= target && !key(&o.name).is_empty() && name.ends_with(&key(&o.name))).max_by_key(|o| o.name.len()) {
                    if !seen.iter().any(|(id, _)| *id == o.id) {
                        seen.push((o.id, progress));
                    }
                }
            }
            start = end.max(start + 1);
        }
    }
    (!seen.is_empty()).then_some((group.id, seen))
}

/// Writes the read progress into the synced objectives (`{ groups: [{ id, objectives: [{ id,
/// progress, target, state }] }] }`). The number of objectives that changed.
pub fn apply(body: &mut serde_json::Value, group: u64, seen: &[(u64, u32)]) -> usize {
    let Some(g) = body.get_mut("groups").and_then(serde_json::Value::as_array_mut).and_then(|a| a.iter_mut().find(|g| g.get("id").and_then(serde_json::Value::as_u64) == Some(group))) else {
        return 0;
    };
    let mut changed = 0;
    for o in g.get_mut("objectives").and_then(serde_json::Value::as_array_mut).into_iter().flatten() {
        let Some(id) = o.get("id").and_then(serde_json::Value::as_u64) else { continue };
        let Some(&(_, p)) = seen.iter().find(|(i, _)| *i == id) else { continue };
        if o.get("progress").and_then(serde_json::Value::as_u64) != Some(p as u64) {
            o["progress"] = serde_json::Value::from(p);
            changed += 1;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::squads::Objective;

    fn w(t: &str, x: f32, y: f32, h: f32) -> Word {
        Word { text: t.into(), x, y, w: 10.0 * t.len() as f32, h }
    }
    fn line(s: &str, x: f32, y: f32, h: f32) -> Vec<Word> {
        let mut out = Vec::new();
        let mut cx = x;
        for t in s.split_whitespace() {
            out.push(w(t, cx, y, h));
            cx += 12.0 * t.len() as f32 + 8.0;
        }
        out
    }
    fn obj(id: u64, name: &str, p: u32, t: u32) -> Objective {
        Objective { id, name: name.into(), text: String::new(), progress: p, target: t, done: p >= t }
    }
    fn groups() -> Vec<Group> {
        vec![
            Group { id: 1, title: "Phantom Playgrounds".into(), ends_at: None, objectives: vec![obj(11, "Tricks and Treats", 6, 10), obj(12, "Lost Your Head?", 7, 10), obj(13, "The Red Countess", 1, 5)], category: String::new(), category_id: None },
            Group { id: 2, title: "Ghoul Fest".into(), ends_at: None, objectives: vec![obj(21, "Score 3", 0, 1), obj(22, "Score 30", 0, 30)], category: String::new(), category_id: None },
        ]
    }

    #[test]
    fn rows_of_the_event_on_screen_are_read() {
        let mut ws = Vec::new();
        ws.extend(line("Ghoul Fest", 60.0, 100.0, 20.0)); // the left column: another event, smaller
        ws.extend(line("Phantom Playgrounds", 200.0, 90.0, 40.0));
        ws.extend(line("Tricks and Treats 8/10", 220.0, 250.0, 18.0));
        ws.extend(line("Lost Your Head? 7/10", 220.0, 280.0, 18.0));
        ws.extend(line("The Red Countess 2/5", 220.0, 310.0, 18.0));
        ws.extend(line("Gulyabani's Wrath 7/7", 220.0, 340.0, 18.0)); // not in the synced list: left alone
        assert_eq!(read_screen(&ws, &groups()), Some((1, vec![(11, 8), (12, 7), (13, 2)])));
    }

    #[test]
    fn a_number_that_does_not_fit_is_never_taken() {
        let mut ws = line("Ghoul Fest", 200.0, 90.0, 40.0);
        ws.extend(line("Score 30 0/30", 220.0, 250.0, 18.0));
        // "Score 3" reads with the wrong target: not "Score 3", and not "Score 30" either
        ws.extend(line("Score 3 4/30", 220.0, 280.0, 18.0));
        assert_eq!(read_screen(&ws, &groups()), Some((2, vec![(22, 0)])));
    }

    /// The user's own screenshots (not in git) against the real synced objectives:
    /// FCT_OBJ_SHOTS=<dir> FCT_WEBDATA=<webdata.json> cargo test --lib real_objective_screens -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_objective_screens() {
        let (Ok(dir), Ok(web)) = (std::env::var("FCT_OBJ_SHOTS"), std::env::var("FCT_WEBDATA")) else { return };
        let web: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(web).unwrap()).unwrap();
        let groups = crate::squads::groups_from_value(&web["objectives"]["body"]);
        let events = crate::event_rules::event_names(&web["objectives"]["body"]);
        let hub = web["latest"]["/ut/game/fc27/academy/hub/v2"]["body"].clone();
        let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).collect();
        files.sort();
        for f in files {
            let frame = crate::scan::analyse_bytes(&std::fs::read(&f).unwrap()).unwrap();
            let name = f.file_name().unwrap().to_string_lossy().to_string();
            let read = read_screen(&frame.words, &groups).map(|(g, seen)| {
                let g = groups.iter().find(|x| x.id == g).unwrap();
                (g.title.clone(), seen.iter().map(|(id, p)| format!("{} {p}/{}", g.objectives.iter().find(|o| o.id == *id).unwrap().name, g.objectives.iter().find(|o| o.id == *id).unwrap().target)).collect::<Vec<_>>())
            });
            println!("{name}
   objectives: {read:?}
   evo: {:?}
   rules: {:?}", crate::evo_screen::read_screen(&frame.words, &crate::evo_screen::started_slots(&hub)), crate::event_rules::read_screen(&frame.words, &events));
        }
    }

    #[test]
    fn the_synced_list_follows() {
        let mut body = serde_json::json!({ "groups": [{ "id": 1, "objectives": [{ "id": 11, "progress": 6, "target": 10 }, { "id": 12, "progress": 7, "target": 10 }] }] });
        assert_eq!(apply(&mut body, 1, &[(11, 8), (12, 7)]), 1);
        assert_eq!(body["groups"][0]["objectives"][0]["progress"], 8);
    }
}
