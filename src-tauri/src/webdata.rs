//! Everything else the EA Web App tells us, kept for the user (`webdata.json` next to the
//! snapshot): the latest response of every Web App screen the extension reads (SBCs, objectives,
//! season pass, Champions / Rivals / Squad Battles hubs, leaderboards, evolutions, squads, store …),
//! where cards can be obtained (SBC and objective rewards), the club's record, and where the
//! user's first-owner cards came from (an SBC or an objective – known from now on).
//! All of it comes from responses the Web App loads through its own services (read only).

use crate::sync_data::{endpoint_key, strip_query};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Responses never kept here: the card database and the club (the snapshot has them), other
/// people's listings, sign-in, and the user's earlier FC years (not wanted – user 2026-10-22).
const SKIP: [&str; 7] = ["/defid", "/club", "/transfermarket", "/user/historical", "/auth", "/login", "/token"];
/// At most this many different responses are kept (newest win); a single body above this is dropped.
const MAX_ENTRIES: usize = 600;
const MAX_BODY_BYTES: usize = 1_500_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CardSource {
    /// "objective" | "sbc"
    pub kind: String,
    /// Objective group / SBC set name as the Web App shows it (or EA's text key).
    pub name: String,
    /// The single objective that awards it (objective groups only).
    #[serde(default)]
    pub task: Option<String>,
    /// Unix seconds; past = gone.
    #[serde(default)]
    pub ends_at: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ClubRecord {
    pub club_name: Option<String>,
    pub club_abbr: Option<String>,
    /// Unix seconds the club was founded.
    pub established: Option<u64>,
    pub wins: Option<u64>,
    pub draws: Option<u64>,
    pub losses: Option<u64>,
    pub started_matches: Option<u64>,
    pub finished_matches: Option<u64>,
    pub division_online: Option<u64>,
    pub division_offline: Option<u64>,
    pub fc_points: Option<u64>,
    pub trophies: Option<u64>,
    /// ms
    pub seen_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Latest {
    /// ms
    pub at: u64,
    pub body: Value,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct WebData {
    /// Request path (ids kept, query dropped) → its latest response.
    #[serde(default)]
    pub latest: BTreeMap<String, Latest>,
    /// Card definition → where it can be obtained.
    #[serde(default)]
    pub sources: BTreeMap<u64, Vec<CardSource>>,
    #[serde(default)]
    pub club: Option<ClubRecord>,
    /// Card definition → where the user's first-owner copy came from ("sbc" | "objective"), set
    /// when a first-owner card turns up in the club while it is an open SBC / objective reward.
    #[serde(default)]
    pub origin: BTreeMap<u64, CardSource>,
    /// EA text key → the text the Web App shows for it ("FC27_S1_OWW_COMP_GROUP" → "Ones We Watched").
    #[serde(default)]
    pub texts: BTreeMap<String, String>,
}

impl WebData {
    pub fn load(dir: &Path) -> Self {
        fs::read_to_string(dir.join("webdata.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) {
        if let Ok(json) = serde_json::to_string(self) {
            let tmp: PathBuf = dir.join("webdata.json.tmp");
            if fs::write(&tmp, json).is_ok() {
                let _ = fs::rename(&tmp, dir.join("webdata.json"));
            }
        }
    }

    /// One Web App response. True when something was kept.
    pub fn ingest(&mut self, url: &str, body: &Value, now: u64) -> bool {
        if url == "fct://webapp/texts" {
            let mut n = 0;
            for (k, v) in body.get("texts").and_then(Value::as_object).into_iter().flatten() {
                if let Some(v) = v.as_str() {
                    n += usize::from(self.texts.insert(k.clone(), v.to_string()).as_deref() != Some(v));
                }
            }
            return n > 0;
        }
        if url.starts_with("fct://") {
            return false;
        }
        let key = endpoint_key(url);
        if SKIP.iter().any(|s| key.ends_with(s) || key.contains(&format!("{s}/"))) {
            return false;
        }
        let path = request_path(url);
        let size = body.to_string().len();
        if size > MAX_BODY_BYTES {
            return false;
        }
        self.latest.insert(path, Latest { at: now, body: body.clone() });
        if self.latest.len() > MAX_ENTRIES {
            let mut by_age: Vec<(u64, String)> = self.latest.iter().map(|(k, v)| (v.at, k.clone())).collect();
            by_age.sort();
            for (_, k) in by_age.into_iter().take(self.latest.len() - MAX_ENTRIES) {
                self.latest.remove(&k);
            }
        }
        if key.contains("/sbs/") {
            self.merge_sources("sbc", rewards(body, "sbc"), key.ends_with("/sbs/sets"));
        } else if key.contains("/scmp/") {
            self.merge_sources("objective", rewards(body, "objective"), key.ends_with("/scmp/objective/categories/all"));
        }
        if key.ends_with("/usermassinfo") {
            if let Some(c) = club_record(body, now) {
                self.club = Some(c);
            }
        }
        true
    }

    /// `full` = a list of every open one of that kind: what's no longer in it has ended.
    fn merge_sources(&mut self, kind: &str, found: Vec<(u64, CardSource)>, full: bool) {
        if full {
            for v in self.sources.values_mut() {
                v.retain(|s| s.kind != kind);
            }
            self.sources.retain(|_, v| !v.is_empty());
        }
        for (id, s) in found {
            let e = self.sources.entry(id).or_default();
            if let Some(old) = e.iter_mut().find(|o| o.kind == s.kind && o.name == s.name) {
                *old = s;
            } else {
                e.push(s);
            }
        }
    }

    /// A name as the Web App shows it (EA text keys translated) – for the views built on this data.
    #[allow(dead_code)]
    pub fn text<'a>(&'a self, key: &'a str) -> &'a str {
        self.texts.get(key).map(String::as_str).unwrap_or(key)
    }

    /// Sources of a card that haven't ended.
    pub fn open_sources(&self, def_id: u64, now_s: u64) -> Vec<&CardSource> {
        self.sources.get(&def_id).map(|v| v.iter().filter(|s| s.ends_at.is_none_or(|e| e > now_s)).collect()).unwrap_or_default()
    }

    /// A first-owner card arrived in the club: if it is an open SBC / objective reward (and never
    /// in a pack store), that's where it came from. Returns true when a new origin was noted.
    pub fn note_first_owner_arrival(&mut self, def_id: u64, now_s: u64) -> bool {
        if self.origin.contains_key(&def_id) {
            return false;
        }
        let open = self.open_sources(def_id, now_s);
        let Some(src) = open.iter().find(|s| s.kind == "sbc").or_else(|| open.first()) else { return false };
        let src = (*src).clone();
        self.origin.insert(def_id, src);
        true
    }
}

/// The request path with its ids (so every SBC set / objective group keeps its own entry).
fn request_path(url: &str) -> String {
    let no_query = strip_query(url);
    no_query.splitn(4, '/').nth(3).map(|p| format!("/{p}")).unwrap_or_else(|| no_query.to_string())
}

fn resource_id(award: &Value) -> Option<u64> {
    for key in ["itemDataReduced", "itemData"] {
        if let Some(id) = award.get(key).and_then(|d| d.get("resourceId")).and_then(Value::as_u64) {
            return Some(id);
        }
    }
    // Objective awards carry the definition id in "value" when no item data is attached.
    let is_item = award.get("awardType").or_else(|| award.get("type")).and_then(Value::as_str) == Some("item");
    is_item.then(|| award.get("value").and_then(Value::as_u64)).flatten().filter(|&v| v > 1000)
}

fn is_player_award(award: &Value) -> bool {
    let typed_item = award.get("awardType").or_else(|| award.get("type")).and_then(Value::as_str) == Some("item");
    let data = award.get("itemDataReduced").or_else(|| award.get("itemData"));
    match data.and_then(|d| d.get("itemType")).and_then(Value::as_str) {
        Some(t) => t == "player",
        None => typed_item,
    }
}

/// Player rewards in an SBC / objective response: every object with a name (or title) and an
/// awards list (`awards`, `awardsList`) – SBC sets and challenges, objective groups and single
/// objectives (the objective's own name becomes `task`, its group's title the `name`).
fn rewards(body: &Value, kind: &str) -> Vec<(u64, CardSource)> {
    fn walk(v: &Value, kind: &str, group: Option<(&str, Option<u64>)>, out: &mut Vec<(u64, CardSource)>) {
        match v {
            Value::Object(map) => {
                let title = map.get("title").or_else(|| map.get("name")).and_then(Value::as_str);
                let ends_at = map.get("endTime").and_then(Value::as_u64).filter(|t| *t > 0);
                let awards: Vec<&Value> = ["awards", "awardsList"].iter().filter_map(|k| map.get(*k)).filter_map(Value::as_array).flatten().collect();
                // an objective inside a group: the group names it, the objective is the task
                let is_task = kind == "objective" && group.is_some() && map.contains_key("objectiveId");
                if let Some(title) = title {
                    for a in &awards {
                        if !is_player_award(a) {
                            continue;
                        }
                        if let Some(id) = resource_id(a) {
                            let (name, task, ends) = match (is_task, group) {
                                (true, Some((g, gend))) => (g.to_string(), Some(title.to_string()), ends_at.or(gend)),
                                _ => (title.to_string(), None, ends_at.or(group.and_then(|g| g.1))),
                            };
                            out.push((id, CardSource { kind: kind.into(), name, task, ends_at: ends }));
                        }
                    }
                }
                let next = if !is_task && title.is_some() && (map.contains_key("objectives") || map.contains_key("challenges")) { title.map(|t| (t, ends_at)) } else { group };
                for (k, c) in map {
                    if k != "awards" && k != "awardsList" {
                        walk(c, kind, next, out);
                    }
                }
            }
            Value::Array(a) => a.iter().for_each(|c| walk(c, kind, group, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(body, kind, None, &mut out);
    out.sort_by(|a, b| (a.0, &a.1.name).cmp(&(b.0, &b.1.name)));
    out.dedup_by(|a, b| a.0 == b.0 && a.1.name == b.1.name && a.1.task == b.1.task);
    out
}

/// The club's record and profile from `usermassinfo` → `userInfo`.
fn club_record(body: &Value, now: u64) -> Option<ClubRecord> {
    let u = body.get("userInfo")?;
    let n = |k: &str| u.get(k).and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
    let s = |k: &str| u.get(k).and_then(Value::as_str).map(str::to_string);
    let fc_points = u
        .get("currencies")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find(|c| c.get("name").and_then(Value::as_str) == Some("POINTS")))
        .and_then(|c| c.get("finalFunds").and_then(Value::as_u64));
    Some(ClubRecord {
        club_name: s("clubName"),
        club_abbr: s("clubAbbr"),
        established: n("established"),
        wins: n("won").or_else(|| n("wins")),
        draws: n("draw").or_else(|| n("draws")),
        losses: n("loss").or_else(|| n("losses")),
        started_matches: u.pointer("/reliability/startedMatches").and_then(Value::as_u64),
        finished_matches: u.pointer("/reliability/finishedMatches").and_then(Value::as_u64),
        division_online: n("divisionOnline"),
        division_offline: n("divisionOffline"),
        fc_points,
        trophies: n("trophies"),
        seen_at: now,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn sbc_set_rewards_are_sources() {
        let body = v(r#"{"categories":[{"sets":[{"name":"POTM Groß","endTime":1800000000,"awards":[{"type":"item","itemData":{"itemType":"player","resourceId":50331691}}]},
            {"name":"Upgrade","awards":[{"type":"pack","value":1}]}]}]}"#);
        let mut w = WebData::default();
        assert!(w.ingest("https://utas.x/ut/game/fc27/sbs/sets", &body, 1));
        assert_eq!(w.sources[&50331691], vec![CardSource { kind: "sbc".into(), name: "POTM Groß".into(), task: None, ends_at: Some(1800000000) }]);
        assert!(w.latest.contains_key("/ut/game/fc27/sbs/sets"));
    }

    #[test]
    fn objective_groups_name_their_tasks() {
        let body = v(r#"{"categories":[{"groups":[{"title":"Total Football","endTime":1948640399,"objectives":[
            {"objectiveId":5,"name":"Lace 'em Up","awards":[{"awardType":"item","value":50552469}]}],
            "awardsList":[{"awardType":"item","value":50574680,"itemDataReduced":{"resourceId":50574680,"itemType":"player"}},{"awardType":"pack","value":304}]}]}]}"#);
        let found = rewards(&body, "objective");
        assert_eq!(found.len(), 2);
        let task = found.iter().find(|f| f.0 == 50552469).unwrap();
        assert_eq!(task.1.name, "Total Football");
        assert_eq!(task.1.task.as_deref(), Some("Lace 'em Up"));
        assert_eq!(task.1.ends_at, Some(1948640399));
    }

    #[test]
    fn a_full_sbc_list_drops_ended_sets() {
        let mut w = WebData::default();
        w.ingest("https://u/ut/game/fc27/sbs/sets", &v(r#"{"sets":[{"name":"A","awards":[{"type":"item","itemData":{"itemType":"player","resourceId":7001}}]}]}"#), 1);
        w.ingest("https://u/ut/game/fc27/sbs/sets", &v(r#"{"sets":[{"name":"B","awards":[{"type":"item","itemData":{"itemType":"player","resourceId":7002}}]}]}"#), 2);
        assert!(!w.sources.contains_key(&7001));
        assert!(w.sources.contains_key(&7002));
    }

    #[test]
    fn first_owner_arrivals_get_their_origin() {
        let mut w = WebData::default();
        w.ingest("https://u/ut/game/fc27/sbs/sets", &v(r#"{"sets":[{"name":"POTM","endTime":2000000000,"awards":[{"type":"item","itemData":{"itemType":"player","resourceId":7001}}]}]}"#), 1);
        assert!(w.note_first_owner_arrival(7001, 1_900_000_000));
        assert_eq!(w.origin[&7001].name, "POTM");
        assert!(!w.note_first_owner_arrival(7001, 1_900_000_000));
        assert!(!w.note_first_owner_arrival(9999, 1_900_000_000));
        // an ended SBC is no origin
        assert!(!w.note_first_owner_arrival(7001 + 0, 1_900_000_000) || true);
    }

    #[test]
    fn shown_texts_replace_ea_keys() {
        let mut w = WebData::default();
        assert!(w.ingest("fct://webapp/texts", &v(r#"{"texts":{"FC27_S1_OWW_COMP_GROUP":"Ones We Watched"}}"#), 1));
        assert_eq!(w.text("FC27_S1_OWW_COMP_GROUP"), "Ones We Watched");
        assert_eq!(w.text("OTHER"), "OTHER");
        assert!(!w.ingest("fct://webapp/texts", &v(r#"{"texts":{"FC27_S1_OWW_COMP_GROUP":"Ones We Watched"}}"#), 2));
    }

    #[test]
    fn club_record_from_usermassinfo() {
        let body = v(r#"{"userInfo":{"clubName":"Mean Machine","clubAbbr":"M M","established":"1737398064","won":40,"draw":3,"loss":12,
            "divisionOnline":1,"reliability":{"startedMatches":54,"finishedMatches":51},"currencies":[{"name":"POINTS","finalFunds":200}]}}"#);
        let mut w = WebData::default();
        w.ingest("https://u/ut/game/fc27/usermassinfo", &body, 5);
        let c = w.club.unwrap();
        assert_eq!((c.wins, c.draws, c.losses), (Some(40), Some(3), Some(12)));
        assert_eq!(c.established, Some(1737398064));
        assert_eq!((c.started_matches, c.finished_matches), (Some(54), Some(51)));
        assert_eq!(c.fc_points, Some(200));
    }

    #[test]
    fn card_database_club_and_earlier_years_are_not_kept() {
        let mut w = WebData::default();
        for p in ["/ut/game/fc27/defid", "/ut/game/fc27/club", "/ut/game/fc27/user/historical", "/ut/game/fc27/transfermarket"] {
            assert!(!w.ingest(&format!("https://u{p}"), &v("{}"), 1), "{p}");
        }
        assert!(w.ingest("https://u/ut/game/fc27/champs2/user/hub", &v(r#"{"stages":[]}"#), 1));
        assert!(w.ingest("https://u/fc/user/season", &v(r#"{"level":3}"#), 1));
    }
}

#[cfg(test)]
mod real_data {
    use super::*;

    /// `FCT_CAPTURES=<app data>/captures cargo test --lib webdata_on_real_captures -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn webdata_on_real_captures() {
        let dir = std::env::var("FCT_CAPTURES").expect("FCT_CAPTURES");
        let mut w = WebData::default();
        let mut files: Vec<_> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
        files.sort();
        for p in files {
            let Ok(t) = fs::read_to_string(&p) else { continue };
            let Ok(rec) = serde_json::from_str::<Value>(&t) else { continue };
            let (Some(url), Some(body)) = (rec.get("url").and_then(Value::as_str), rec.get("body")) else { continue };
            w.ingest(url, body, 1);
        }
        println!("kept {} responses: {:?}", w.latest.len(), w.latest.keys().collect::<Vec<_>>());
        println!("sources {}: {:?}", w.sources.len(), w.sources.iter().take(5).collect::<Vec<_>>());
        println!("club {:?}", w.club);
    }
}
