//! Objective squads (SQUADS.md): the open objectives of an event read from the Web App, their
//! squad requirements ("Min. 3 Premier League players in your starting 11"), and the best XI from
//! the user's own club that meets as many of them as possible – with the chemistry the user aims
//! for and the strongest cards – plus realistic cards to get for what the club can't cover.
//! Pure (no I/O, no clock) so the browser version can build it too.

use crate::names::normalise_name;
use crate::types::Price;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// EA's league id of Icons (every Icon card), and the rarity of Heroes.
const ICON_LEAGUE: u64 = 2118;
const HERO_RAREFLAG: u64 = 72;
/// A price older than this is not good enough to suggest a buy.
const PRICE_FRESH_MS: u64 = 3 * 24 * 3600 * 1000;

// ---------- settings ----------

/// Settings → Squads (user 2026-10-30: chemistry is a target, "as close to X as possible").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SquadPrefs {
    /// 0–33.
    pub chem_target: u32,
    /// Chemistry before the requirements ("I want 33 even if an objective waits").
    pub chem_first: bool,
    /// Loan cards are left out of squads and suggestions.
    pub hide_loans: bool,
    /// Most coins a suggested buy may cost; none = the user's coins.
    pub budget: Option<u64>,
    /// "Has to include" (user 2026-10-30): club cards (item ids) every squad plays – e.g. McGeady and
    /// Bonmatí because the user wants to play with them. Above everything else; a loan card picked
    /// here plays even when loans are left out.
    pub must: Vec<u64>,
    /// "Has to include" cards the user doesn't own yet (card definitions) – they play, marked "to get".
    pub must_cards: Vec<u64>,
    /// Objectives the user marked done (or not done) by hand (user 2026-10-30). A mark counts
    /// only while it is newer than the objectives' last read: the next sync says what EA says, so
    /// a wrong mark is put right by itself.
    pub done_marks: Vec<DoneMark>,
    /// "I'm playing …": the event the first session is built around; none = Auto (the most objectives).
    pub primary: Option<u64>,
    /// Where to play it, when the user picked a place; none = the best one.
    pub place: Option<Mode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DoneMark {
    /// The event (objective group).
    pub group: u64,
    pub objective: u64,
    pub done: bool,
    /// When it was marked (ms).
    pub at: u64,
}

impl Default for SquadPrefs {
    fn default() -> Self {
        Self { chem_target: 33, chem_first: false, hide_loans: true, budget: None, must: Vec::new(), must_cards: Vec::new(), done_marks: Vec::new(), primary: None, place: None }
    }
}

// ---------- input ----------

/// A card that can stand in a squad: a club player, or a card from the catalog (to get).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Player {
    /// Club item id (owned) or card definition (catalog).
    pub key: u64,
    pub def_id: u64,
    pub name: String,
    pub rating: u32,
    /// Positions the card can play (EA `possiblePositions`).
    pub positions: Vec<String>,
    pub league: u64,
    pub club: u64,
    pub nation: u64,
    pub rareflag: u64,
    /// PAC SHO PAS DRI DEF PHY when known.
    pub face: Option<[u32; 6]>,
    /// The 29 in-game attributes by EA's names ("acceleration", "finishing" …) when read.
    pub stats: Option<BTreeMap<String, u32>>,
    /// cm
    pub height: Option<u32>,
    /// PlayStyles by EA's names ("FINESSE_SHOT" …): (name, PlayStyle+).
    pub playstyles: Vec<(String, bool)>,
    pub ps_plus: u32,
    pub roles_pp: u32,
    pub weak_foot: u32,
    pub skill_moves: u32,
    /// 1 = right, 2 = left, 0 = unknown.
    pub foot: u8,
    pub loan: bool,
    pub owned: bool,
}

impl Player {
    fn is_icon(&self) -> bool {
        self.league == ICON_LEAGUE
    }
    fn is_hero(&self) -> bool {
        self.rareflag == HERO_RAREFLAG
    }
    /// The same footballer in any version (one per squad).
    fn person(&self) -> (String, u64) {
        (normalise_name(&self.name), self.nation)
    }
}

/// League / club / nation names in the user's language, from the Web App's own localisation.
#[derive(Debug, Clone, Default)]
pub struct Names {
    pub leagues: BTreeMap<u64, Vec<String>>,
    pub nations: BTreeMap<u64, String>,
    /// id → (names, league)
    pub teams: BTreeMap<u64, (Vec<String>, Option<u64>)>,
    /// Rarity / program names by EA's `rareflag` ("Ultimate Scream").
    pub rarities: BTreeMap<u64, String>,
}

impl Names {
    /// The extension's `fct://webapp/names`: `{ leagues: {id: [full, abbr]}, nations: {id: name},
    /// teams: {id: {names: [...], league}} }`.
    pub fn from_value(v: &Value) -> Names {
        let mut n = Names::default();
        let strs = |x: &Value| -> Vec<String> {
            match x {
                Value::String(s) => vec![s.clone()],
                Value::Array(a) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
                _ => vec![],
            }
            .into_iter()
            .filter(|s| !s.is_empty() && !s.starts_with('*'))
            .collect()
        };
        for (k, x) in v.get("leagues").and_then(Value::as_object).into_iter().flatten() {
            if let Ok(id) = k.parse() {
                n.leagues.insert(id, strs(x));
            }
        }
        for (k, x) in v.get("nations").and_then(Value::as_object).into_iter().flatten() {
            if let (Ok(id), Some(s)) = (k.parse(), strs(x).into_iter().next()) {
                n.nations.insert(id, s);
            }
        }
        for (k, x) in v.get("rarities").and_then(Value::as_object).into_iter().flatten() {
            if let (Ok(id), Some(s)) = (k.parse(), strs(x).into_iter().next()) {
                n.rarities.insert(id, s);
            }
        }
        for (k, x) in v.get("teams").and_then(Value::as_object).into_iter().flatten() {
            if let Ok(id) = k.parse() {
                let names = x.get("names").map(strs).unwrap_or_else(|| strs(x));
                n.teams.insert(id, (names, x.get("league").and_then(Value::as_u64)));
            }
        }
        n
    }

    /// Team names the catalog already knows (the Gallery sync) fill gaps.
    pub fn add_team(&mut self, id: u64, name: &str, league: Option<u64>) {
        let e = self.teams.entry(id).or_insert_with(|| (Vec::new(), league));
        if !e.0.iter().any(|n| n == name) {
            e.0.push(name.to_string());
        }
        e.1 = e.1.or(league);
    }

    pub fn league_name(&self, id: u64) -> Option<&str> {
        self.leagues.get(&id).and_then(|v| v.first()).map(String::as_str)
    }
    pub fn team_name(&self, id: u64) -> Option<&str> {
        self.teams.get(&id).and_then(|v| v.0.first()).map(String::as_str)
    }
}

/// An objective group (an event) with its objectives, texts as the Web App shows them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Group {
    pub id: u64,
    pub title: String,
    /// Unix seconds.
    pub ends_at: Option<u64>,
    pub objectives: Vec<Objective>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Objective {
    pub id: u64,
    pub name: String,
    pub text: String,
    pub progress: u32,
    pub target: u32,
    pub done: bool,
}

/// The extension's `fct://webapp/objectives`: `{ groups: [{ id, title, endTime, objectives:
/// [{ id, name, description, progress, target, state }] }] }`.
pub fn groups_from_value(v: &Value) -> Vec<Group> {
    let s = |x: &Value, k: &str| x.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let u = |x: &Value, k: &str| x.get(k).and_then(Value::as_u64);
    v.get("groups")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|g| {
            let objectives = g
                .get("objectives")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|o| {
                    let target = u(o, "target").unwrap_or(1).max(1) as u32;
                    let state = o.get("state").map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).unwrap_or_default().to_ascii_uppercase();
                    let done = o.get("done").and_then(Value::as_bool).unwrap_or_else(|| matches!(state.as_str(), "COMPLETED" | "REDEEMED" | "REWARDED" | "CLAIMED"));
                    // EA's texts may hold the target as %1
                    let text = s(o, "description").replace("%1", &target.to_string());
                    Objective { id: u(o, "id").unwrap_or(0), name: s(o, "name"), text, progress: u(o, "progress").unwrap_or(0) as u32, target, done }
                })
                .collect::<Vec<_>>();
            Some(Group { id: u(g, "id")?, title: s(g, "title"), ends_at: u(g, "endTime").filter(|&e| e > 0), objectives })
        })
        .collect()
}

/// EA's whole objectives list (`/scmp/objective/categories/all`, read by every sync) in the
/// extension's `fct://webapp/objectives` shape – every event, not only the ones the extension
/// opened (user 2026-10-30: "there are MANY objectives"). `text` turns EA text keys into words.
pub fn groups_from_categories(v: &Value, text: &dyn Fn(&str) -> String) -> Vec<Value> {
    let mut out = Vec::new();
    for c in v.as_array().into_iter().flatten() {
        for g in c.get("groupsList").and_then(Value::as_array).into_iter().flatten() {
            let Some(id) = g.get("groupId").and_then(Value::as_u64) else { continue };
            let objectives: Vec<Value> = g
                .get("objectives")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|o| {
                    serde_json::json!({
                        "id": o.get("objectiveId"),
                        "name": text(o.get("name").and_then(Value::as_str).unwrap_or("")),
                        "description": text(o.get("description").and_then(Value::as_str).unwrap_or("")),
                        "progress": o.get("currentProgress").and_then(Value::as_u64).unwrap_or(0),
                        "target": o.get("multiplier").and_then(Value::as_u64).unwrap_or(1),
                        "state": o.get("state").and_then(Value::as_str).unwrap_or(""),
                    })
                })
                .collect();
            out.push(serde_json::json!({
                "id": id,
                "categoryId": c.get("categoryId"),
                "title": text(g.get("title").and_then(Value::as_str).unwrap_or("")),
                "endTime": g.get("endTime"),
                "objectives": objectives,
            }));
        }
    }
    out
}

// ---------- requirements ----------

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum Need {
    League(u64),
    Club(u64),
    Nation(u64),
    Icon,
    Hero,
    Rating(u32),
    /// Weak foot of at least this many stars ("with 4* or higher WF players").
    WeakFoot(u32),
    /// Skill moves of at least this many stars.
    SkillMoves(u32),
    /// The squad's chemistry ("with 30+ chemistry") – the squad's, not a card's.
    Chemistry(u32),
    /// A rarity / program (EA `rareflag`): "Ultimate Scream", "Future Stars Academy".
    Rarity(u64),
    /// AcceleRATE: "explosive" | "controlled" | "lengthy".
    Accel(String),
    /// A PlayStyle by its name as the text gives it ("finesse shot"); PlayStyle+ when asked for.
    PlayStyle(String, bool),
}

impl Need {
    fn met_by(&self, p: &Player, _links: &BTreeMap<u64, u64>) -> bool {
        match *self {
            Need::SkillMoves(min) => p.skill_moves >= min,
            Need::Chemistry(_) => false,
            Need::Rarity(r) => p.rareflag == r,
            Need::Accel(ref kind) => accelerate(p) == Some(kind.as_str()),
            Need::PlayStyle(ref name, plus) => p.playstyles.iter().any(|(n, pl)| norm(n) == norm(name) && (*pl || !plus)),
            Need::League(id) => p.league == id,
            // the club itself (its women's / men's team links count for chemistry only – "Real
            // Madrid (LALIGA)" is the LALIGA side)
            Need::Club(id) => p.club == id,
            Need::Nation(id) => p.nation == id,
            Need::Icon => p.is_icon(),
            Need::Hero => p.is_hero(),
            Need::Rating(min) => p.rating >= min,
            Need::WeakFoot(min) => p.weak_foot >= min,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Req {
    pub need: Need,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    /// Nothing about the squad ("Play 10 matches").
    None,
    Squad(Req),
    /// A squad part we could not read – shown, never guessed.
    Unknown(String),
}

/// English nation adjectives EA uses in objective texts → the nation's name.
const DEMONYMS: &[(&str, &[&str])] = &[
    ("english", &["England"]), ("french", &["France"]), ("german", &["Germany"]), ("spanish", &["Spain"]),
    ("italian", &["Italy"]), ("portuguese", &["Portugal"]), ("dutch", &["Netherlands", "Holland"]),
    ("belgian", &["Belgium"]), ("brazilian", &["Brazil"]), ("argentine", &["Argentina"]), ("argentinian", &["Argentina"]),
    ("uruguayan", &["Uruguay"]), ("colombian", &["Colombia"]), ("mexican", &["Mexico"]), ("american", &["United States", "USA"]),
    ("canadian", &["Canada"]), ("scottish", &["Scotland"]), ("welsh", &["Wales"]), ("irish", &["Republic of Ireland", "Ireland"]),
    ("northern irish", &["Northern Ireland"]), ("danish", &["Denmark"]), ("swedish", &["Sweden"]), ("norwegian", &["Norway"]),
    ("finnish", &["Finland"]), ("icelandic", &["Iceland"]), ("polish", &["Poland"]), ("czech", &["Czechia", "Czech Republic"]),
    ("slovak", &["Slovakia"]), ("austrian", &["Austria"]), ("swiss", &["Switzerland"]), ("croatian", &["Croatia"]),
    ("serbian", &["Serbia"]), ("slovenian", &["Slovenia"]), ("bosnian", &["Bosnia and Herzegovina", "Bosnia & Herzegovina"]),
    ("hungarian", &["Hungary"]), ("romanian", &["Romania"]), ("bulgarian", &["Bulgaria"]), ("greek", &["Greece"]),
    ("turkish", &["Türkiye", "Turkey"]), ("ukrainian", &["Ukraine"]), ("russian", &["Russia"]), ("georgian", &["Georgia"]),
    ("albanian", &["Albania"]), ("kosovan", &["Kosovo"]), ("montenegrin", &["Montenegro"]), ("macedonian", &["North Macedonia"]),
    ("moroccan", &["Morocco"]), ("algerian", &["Algeria"]), ("tunisian", &["Tunisia"]), ("egyptian", &["Egypt"]),
    ("senegalese", &["Senegal"]), ("nigerian", &["Nigeria"]), ("ghanaian", &["Ghana"]), ("ivorian", &["Côte d'Ivoire", "Ivory Coast"]),
    ("cameroonian", &["Cameroon"]), ("malian", &["Mali"]), ("guinean", &["Guinea"]), ("congolese", &["DR Congo", "Congo DR"]),
    ("south african", &["South Africa"]), ("japanese", &["Japan"]), ("korean", &["Korea Republic", "South Korea"]),
    ("south korean", &["Korea Republic", "South Korea"]), ("chinese", &["China PR", "China"]), ("australian", &["Australia"]),
    ("chilean", &["Chile"]), ("peruvian", &["Peru"]), ("ecuadorian", &["Ecuador"]), ("paraguayan", &["Paraguay"]),
    ("venezuelan", &["Venezuela"]), ("jamaican", &["Jamaica"]), ("saudi", &["Saudi Arabia"]), ("iranian", &["Iran", "IR Iran"]),
    ("israeli", &["Israel"]), ("costa rican", &["Costa Rica"]), ("cape verdean", &["Cape Verde Islands", "Cape Verde"]),
    ("burkinabe", &["Burkina Faso"]), ("gabonese", &["Gabon"]), ("zambian", &["Zambia"]), ("new zealand", &["New Zealand"]),
];

/// Letters folded like player names, digits kept ("Ligue 1" ≠ "Ligue 2").
fn norm(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            out.push(c);
        } else {
            out.push_str(&normalise_name(c.encode_utf8(&mut [0; 4])));
        }
    }
    out
}

/// Best id whose names match `phrase`: exact > one name contains the other (≥ 4 letters).
fn find_named<'a>(phrase: &str, items: impl Iterator<Item = (u64, &'a Vec<String>)>) -> Option<u64> {
    let p = norm(phrase);
    if p.is_empty() {
        return None;
    }
    let mut best: Option<(u32, usize, u64)> = None;
    for (id, names) in items {
        for n in names {
            let n = norm(n);
            if n.is_empty() {
                continue;
            }
            let rank = if n == p {
                3
            } else if (n.len() >= 4 && p.contains(&n)) || (p.len() >= 4 && n.contains(&p)) {
                2
            } else {
                continue;
            };
            let cand = (rank, n.len().min(p.len()), id);
            if best.is_none_or(|b| (cand.0, cand.1) > (b.0, b.1)) {
                best = Some(cand);
            }
        }
    }
    best.map(|b| b.2)
}

fn find_league(phrase: &str, names: &Names) -> Option<u64> {
    let p = norm(phrase);
    // EA writes LALIGA / La Liga / LaLiga EA SPORTS alike
    names.leagues.iter().find(|(_, v)| v.iter().any(|n| norm(n) == p)).map(|(&id, _)| id).or_else(|| find_named(phrase, names.leagues.iter().map(|(&id, v)| (id, v))))
}

fn find_nation(phrase: &str, names: &Names) -> Option<u64> {
    let p = phrase.trim().to_lowercase();
    // "Mexican" and "USA" alike (EA names the nation "United States")
    let np = norm(phrase);
    let wanted: Vec<String> = DEMONYMS.iter().filter(|(a, n)| *a == p || n.iter().any(|x| norm(x) == np)).flat_map(|(_, n)| n.iter().map(|s| norm(s))).collect();
    let by_name = |want: &str| names.nations.iter().find(|(_, n)| norm(n) == want).map(|(&id, _)| id);
    wanted.iter().find_map(|w| by_name(w)).or_else(|| by_name(&norm(phrase)))
}

fn find_club(phrase: &str, league: Option<u64>, names: &Names) -> Option<u64> {
    let in_league = names.teams.iter().filter(|(_, (_, l))| league.is_none() || *l == league).map(|(&id, (n, _))| (id, n));
    find_named(phrase, in_league).or_else(|| league.and_then(|_| find_named(phrase, names.teams.iter().map(|(&id, (n, _))| (id, n)))))
}

/// The squad requirement of an objective text (English, EA's templates):
/// "… while having Min. 3 Premier League players in your starting 11 …",
/// "Min. 1 Real Madrid (LALIGA) player item", "Min. 1 French player", "Min. 3 player items from
/// Bundesliga", "Min. 2 Icons". The first count that is about players wins ("Score at least 3
/// goals … while having Min. 1 French player" → the French player).
pub fn parse_requirement(text: &str, names: &Names) -> Parsed {
    let lower = text.to_lowercase();
    // "with 4* or higher WF players" / "4* or higher skill moves": one of them has to play
    for (k, wf) in [("* or higher wf", true), ("* weak foot", true), ("* or higher weak foot", true), ("* or higher sm", false), ("* or higher skill", false), ("* skill move", false), ("* skiller", false)] {
        if let Some(i) = lower.find(k) {
            if let Some(n) = lower[..i].chars().last().and_then(|c| c.to_digit(10)) {
                return Parsed::Squad(Req { need: if wf { Need::WeakFoot(n) } else { Need::SkillMoves(n) }, count: 1 });
            }
        }
    }
    // "with 30+ chemistry" / "min. 25 chemistry" (the squad's)
    if let Some(i) = lower.find(" chemistry").filter(|_| !lower.starts_with("build")) {
        let before: String = lower[..i].trim_end_matches('+').chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
        if let Ok(n) = before.parse::<u32>() {
            return Parsed::Squad(Req { need: Need::Chemistry(n.min(33)), count: 1 });
        }
    }
    // AcceleRATE ("a player with Lengthy AcceleRATE", "Explosive running style")
    if lower.contains("accelerate") || lower.contains("running style") {
        for k in ["explosive", "controlled", "lengthy"] {
            if lower.contains(k) {
                return Parsed::Squad(Req { need: Need::Accel(k.to_string()), count: count_before(&lower, k).unwrap_or(1) });
            }
        }
    }
    // a PlayStyle ("a player with the Finesse Shot+ PlayStyle")
    if let Some(i) = lower.find(" playstyle") {
        let head = &lower[..i];
        let start = ["the ", "a ", "with "].iter().filter_map(|k| head.rfind(k).map(|p| p + k.len())).max().unwrap_or(0);
        let name = head[start..].trim();
        if !name.is_empty() && name.split_whitespace().count() <= 4 {
            let plus = name.ends_with('+');
            return Parsed::Squad(Req { need: Need::PlayStyle(name.trim_end_matches('+').trim().to_string(), plus), count: count_before(&lower, name).unwrap_or(1) });
        }
    }
    let mut starts: Vec<(usize, usize)> =
        ["min. ", "min ", "minimum ", "at least ", "with ", "having "].iter().flat_map(|k| lower.match_indices(k).map(move |(i, _)| (i, k.len()))).collect();
    starts.sort();
    for (i, klen) in starts {
        let parsed = parse_at(&lower[i + klen..], names);
        if parsed != Parsed::None {
            return parsed;
        }
    }
    // who scores or assists: "using a player from Germany", "with a Player Item from Bundesliga",
    // "with a Future Stars Academy player" – one such card has to play
    for k in ["using a player from ", "with a player item from ", "with a player from ", "by a player from "] {
        if let Some(i) = lower.find(k) {
            let tail = &lower[i + k.len()..];
            let end = [" in ", ",", ".", " while", " on "].iter().filter_map(|x| tail.find(x)).min().unwrap_or(tail.len());
            return named_need(tail[..end].trim(), 1, names);
        }
    }
    for k in ["with a ", "using a ", "with an ", "using an "] {
        let mut from = 0;
        while let Some(i) = lower[from..].find(k) {
            let start = from + i + k.len();
            from = start;
            let tail = &lower[start..];
            if let Some(end) = tail.find(" player") {
                let phrase = tail[..end].trim();
                if !phrase.is_empty() && phrase.split_whitespace().count() <= 5 && !["goal", "match", "shot", "header", "ball", "kit"].iter().any(|w| phrase.contains(w)) {
                    return named_need(phrase, 1, names);
                }
            }
        }
    }
    Parsed::None
}

/// The number right before a phrase ("2 players with …"), when there is one.
fn count_before(text: &str, phrase: &str) -> Option<u32> {
    let i = text.find(phrase)?;
    text[..i].split_whitespace().rev().take(4).find_map(|w| w.trim_end_matches('+').parse::<u32>().ok()).filter(|n| (1..=11).contains(n))
}

/// A league / nation / club / rarity by its name, as a requirement of `count` cards.
fn named_need(phrase: &str, count: u32, names: &Names) -> Parsed {
    let req = |need| Parsed::Squad(Req { need, count });
    if let (Some(open), true) = (phrase.find('('), phrase.ends_with(')')) {
        let league = find_league(&phrase[open + 1..phrase.len() - 1], names);
        return match find_club(phrase[..open].trim(), league, names) {
            Some(id) => req(Need::Club(id)),
            None => Parsed::Unknown(phrase.to_string()),
        };
    }
    if let Some(id) = find_rarity(phrase, names) {
        return req(Need::Rarity(id));
    }
    if let Some(id) = find_league(phrase, names) {
        return req(Need::League(id));
    }
    if let Some(id) = find_nation(phrase, names) {
        return req(Need::Nation(id));
    }
    if let Some(id) = find_club(phrase, None, names) {
        return req(Need::Club(id));
    }
    Parsed::Unknown(phrase.to_string())
}

/// A program by its name ("Ultimate Scream" / "Future Stars Academy"), exact or its first words.
fn find_rarity(phrase: &str, names: &Names) -> Option<u64> {
    let p = norm(phrase);
    if p.len() < 4 {
        return None;
    }
    names.rarities.iter().find(|(_, n)| norm(n) == p).or_else(|| names.rarities.iter().find(|(_, n)| norm(n).len() >= 6 && (p.starts_with(&norm(n)) || norm(n).starts_with(&p)))).map(|(&id, _)| id)
}

/// "3 premier league players in your starting 11 …" (what follows "min.").
fn parse_at(rest: &str, names: &Names) -> Parsed {
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    let Ok(count) = digits.parse::<u32>() else { return Parsed::None };
    // "4* or higher WF players" is no count of players
    if !rest[digits.len()..].starts_with(' ') {
        return Parsed::None;
    }
    let after = rest[digits.len()..].trim_start();
    let req = |need| Parsed::Squad(Req { need, count });
    let first = after.split_whitespace().next().unwrap_or("").trim_end_matches([',', '.']);
    if matches!(first, "icon" | "icons") {
        return req(Need::Icon);
    }
    if matches!(first, "hero" | "heroes") {
        return req(Need::Hero);
    }
    let phrase = if first.starts_with("player") {
        // "player items from bundesliga in your starting 11"
        let Some(f) = after.find(" from ") else { return Parsed::None };
        let tail = &after[f + 6..];
        let end = [" in your", " in the", " in a", " and ", ",", "."].iter().filter_map(|k| tail.find(k)).min().unwrap_or(tail.len());
        // "from any premier league team"
        let t = tail[..end].trim();
        let t = t.strip_prefix("any ").unwrap_or(t);
        t.strip_suffix(" teams").or_else(|| t.strip_suffix(" team")).unwrap_or(t).trim()
    } else {
        let Some(end) = after.find(" player") else { return Parsed::None };
        after[..end].trim()
    };
    // the counted thing is a short name – "goals in one match while having …" is not
    if phrase.is_empty() || phrase.split_whitespace().count() > 7 || ["goal", "match", "assist", "min.", "while", "different", "separate", "time"].iter().any(|w| phrase.contains(w)) {
        return Parsed::None;
    }
    // "rated 85+" / "85+ rated"
    if phrase.contains("rated") || phrase.contains("ovr") {
        let num: String = phrase.chars().filter(|c| c.is_ascii_digit()).collect();
        if let Ok(min) = num.parse::<u32>() {
            return req(Need::Rating(min));
        }
    }
    // "real madrid (laliga)" = a club of that league
    if let (Some(open), true) = (phrase.find('('), phrase.ends_with(')')) {
        let league = find_league(&phrase[open + 1..phrase.len() - 1], names);
        return match find_club(phrase[..open].trim(), league, names) {
            Some(id) => req(Need::Club(id)),
            None => Parsed::Unknown(phrase.to_string()),
        };
    }
    if let Some(id) = find_rarity(phrase, names) {
        return req(Need::Rarity(id));
    }
    if let Some(id) = find_league(phrase, names) {
        return req(Need::League(id));
    }
    if let Some(id) = find_nation(phrase, names) {
        return req(Need::Nation(id));
    }
    if let Some(id) = find_club(phrase, None, names) {
        return req(Need::Club(id));
    }
    Parsed::Unknown(phrase.to_string())
}

// ---------- chemistry ----------

/// Men's ↔ women's teams of one club (EA's team links) count as the same club.
fn canonical(club: u64, links: &BTreeMap<u64, u64>) -> u64 {
    links.get(&club).copied().unwrap_or(club)
}

/// EA's links as a lookup: every team → the smallest id of its group.
pub fn link_map(team_links: &BTreeMap<u64, Vec<u64>>) -> BTreeMap<u64, u64> {
    let mut out = BTreeMap::new();
    for (&t, linked) in team_links {
        let min = linked.iter().copied().chain([t]).min().unwrap_or(t);
        for id in linked.iter().copied().chain([t]) {
            let e = out.entry(id).or_insert(min);
            *e = (*e).min(min);
        }
    }
    out
}

/// Chemistry of each of the 11 (all in one of their positions): EA's thresholds – club 2/4/7,
/// league 3/5/8, nation 2/5/8 – capped at 3; Icons and Heroes always 3, an Icon counts twice for
/// its nation, a Hero twice for its league.
pub fn chemistry(xi: &[&Player], links: &BTreeMap<u64, u64>) -> Vec<u32> {
    let mut clubs: BTreeMap<u64, u32> = BTreeMap::new();
    let mut leagues: BTreeMap<u64, u32> = BTreeMap::new();
    let mut nations: BTreeMap<u64, u32> = BTreeMap::new();
    for p in xi {
        if !p.is_icon() {
            *clubs.entry(canonical(p.club, links)).or_default() += 1;
        }
        *leagues.entry(p.league).or_default() += if p.is_hero() { 2 } else { 1 };
        *nations.entry(p.nation).or_default() += if p.is_icon() { 2 } else { 1 };
    }
    let step = |n: u32, t: [u32; 3]| t.iter().filter(|&&x| n >= x).count() as u32;
    xi.iter()
        .map(|p| {
            if p.is_icon() || p.is_hero() {
                return 3;
            }
            let c = step(clubs[&canonical(p.club, links)], [2, 4, 7]);
            let l = step(leagues[&p.league], [3, 5, 8]);
            let n = step(nations[&p.nation], [2, 5, 8]);
            (c + l + n).min(3)
        })
        .collect()
}

// ---------- in-game attributes ----------

/// The club players' in-game attributes as the extension read them (`fct://webapp/attributes`):
/// `{ names: {index: "acceleration"}, traits: {id: "FINESSE_SHOT"}, cards: {defId: { a, h }} }` –
/// the Web App's own enums give the order, nothing is assumed.
#[derive(Debug, Clone, Default)]
pub struct Attributes {
    traits: BTreeMap<u64, String>,
    cards: BTreeMap<u64, (BTreeMap<String, u32>, Option<u32>)>,
}

impl Attributes {
    pub fn from_value(v: &Value) -> Attributes {
        let table = |k: &str| -> BTreeMap<u64, String> {
            v.get(k).and_then(Value::as_object).into_iter().flatten().filter_map(|(i, n)| Some((i.parse().ok()?, n.as_str()?.to_string()))).collect()
        };
        let names = table("names");
        let mut cards = BTreeMap::new();
        for (id, c) in v.get("cards").and_then(Value::as_object).into_iter().flatten() {
            let Ok(id) = id.parse::<u64>() else { continue };
            let mut stats = BTreeMap::new();
            match c.get("a") {
                Some(Value::Array(a)) => {
                    for (i, x) in a.iter().enumerate() {
                        if let (Some(name), Some(x)) = (names.get(&(i as u64)), x.as_u64()) {
                            stats.insert(name.to_lowercase(), x as u32);
                        }
                    }
                }
                Some(Value::Object(o)) => {
                    for (k, x) in o {
                        let name = k.parse::<u64>().ok().and_then(|i| names.get(&i).cloned()).unwrap_or_else(|| k.clone());
                        if let Some(x) = x.as_u64() {
                            stats.insert(name.to_lowercase(), x as u32);
                        }
                    }
                }
                _ => {}
            }
            let height = c.get("h").and_then(Value::as_u64).map(|h| h as u32).filter(|&h| (140..230).contains(&h));
            if !stats.is_empty() || height.is_some() {
                cards.insert(id, (stats, height));
            }
        }
        Attributes { traits: table("traits"), cards }
    }

    fn trait_name(&self, id: u64) -> Option<String> {
        self.traits.get(&id).cloned()
    }
}

// ---------- rating (beta) ----------

/// EA's attributes per position (weights; FC-Tracker's own, SQUADS.md B – tuned by the user's
/// blind test later). Names as the Web App's ItemSubAttribute enum.
fn attribute_weights(pos: &str) -> &'static [(&'static str, f64)] {
    match pos {
        "ST" => &[("finishing", 22.0), ("positioning", 14.0), ("acceleration", 9.0), ("sprintspeed", 8.0), ("shotpower", 9.0), ("composure", 8.0), ("reactions", 8.0), ("ballcontrol", 7.0), ("dribbling", 6.0), ("agility", 4.0), ("longshots", 4.0), ("strength", 3.0), ("headingaccuracy", 3.0), ("volleys", 2.0)],
        "LW" | "RW" | "LM" | "RM" => &[("acceleration", 14.0), ("sprintspeed", 12.0), ("dribbling", 14.0), ("ballcontrol", 11.0), ("agility", 9.0), ("finishing", 9.0), ("crossing", 6.0), ("shortpassing", 6.0), ("reactions", 6.0), ("balance", 5.0), ("composure", 4.0), ("positioning", 4.0), ("curve", 3.0), ("longshots", 3.0), ("vision", 3.0)],
        "CAM" => &[("shortpassing", 12.0), ("vision", 12.0), ("ballcontrol", 11.0), ("dribbling", 11.0), ("composure", 8.0), ("finishing", 8.0), ("agility", 7.0), ("reactions", 7.0), ("longshots", 6.0), ("acceleration", 6.0), ("positioning", 5.0), ("sprintspeed", 4.0), ("balance", 3.0)],
        "CM" => &[("shortpassing", 15.0), ("longpassing", 11.0), ("vision", 10.0), ("ballcontrol", 10.0), ("reactions", 8.0), ("composure", 8.0), ("stamina", 7.0), ("interceptions", 6.0), ("dribbling", 6.0), ("acceleration", 4.0), ("sprintspeed", 4.0), ("marking", 4.0), ("standingtackle", 4.0), ("strength", 3.0)],
        "CDM" => &[("interceptions", 14.0), ("standingtackle", 13.0), ("marking", 12.0), ("shortpassing", 11.0), ("strength", 8.0), ("reactions", 7.0), ("longpassing", 6.0), ("stamina", 6.0), ("composure", 6.0), ("aggression", 5.0), ("ballcontrol", 5.0), ("acceleration", 3.0), ("sprintspeed", 3.0), ("vision", 3.0)],
        "LB" | "RB" => &[("acceleration", 12.0), ("sprintspeed", 12.0), ("standingtackle", 11.0), ("marking", 10.0), ("interceptions", 9.0), ("stamina", 8.0), ("shortpassing", 7.0), ("crossing", 6.0), ("reactions", 6.0), ("slidingtackle", 5.0), ("ballcontrol", 4.0), ("agility", 4.0), ("strength", 4.0), ("dribbling", 3.0)],
        "CB" => &[("marking", 16.0), ("standingtackle", 15.0), ("interceptions", 12.0), ("strength", 11.0), ("headingaccuracy", 8.0), ("jumping", 7.0), ("reactions", 7.0), ("sprintspeed", 7.0), ("acceleration", 6.0), ("slidingtackle", 5.0), ("aggression", 4.0), ("composure", 3.0), ("shortpassing", 3.0)],
        "GK" => &[("gkdiving", 22.0), ("gkreflexes", 22.0), ("gkhandling", 18.0), ("gkpositioning", 18.0), ("gkkicking", 8.0), ("reactions", 8.0), ("sprintspeed", 2.0), ("jumping", 2.0)],
        _ => &[],
    }
}

/// The PlayStyles that matter in a position (EA's enum names) and how much.
fn playstyle_weights(pos: &str) -> &'static [(&'static str, f64)] {
    match pos {
        "ST" => &[("FINESSE_SHOT", 1.0), ("EXPLOSIVE_SPRINT_BOOST", 1.0), ("LOW_DRIVEN_SHOT", 0.8), ("POWER_SHOT", 0.7), ("TRAP_MASTER", 0.7), ("ACROBATIC", 0.6), ("SPEED_DRIBBLER", 0.6), ("TECHNICAL_DRIBBLER", 0.6), ("PRECISION_HEADER", 0.5), ("CHIP_SHOT", 0.3)],
        "LW" | "RW" | "LM" | "RM" => &[("SPEED_DRIBBLER", 1.0), ("EXPLOSIVE_SPRINT_BOOST", 0.9), ("TECHNICAL_DRIBBLER", 0.9), ("FINESSE_SHOT", 0.9), ("TRAP_MASTER", 0.5), ("TRICKSTER", 0.5), ("WHIPPED_CROSSES", 0.5), ("INVENTIVE", 0.5), ("LOW_DRIVEN_SHOT", 0.5)],
        "CAM" => &[("PASS_INTO_SPACE", 1.0), ("TECHNICAL_DRIBBLER", 0.9), ("FINESSE_SHOT", 0.9), ("INVENTIVE", 0.8), ("POSSESSION_HOLDER", 0.7), ("TRAP_MASTER", 0.6), ("BULLET_PASSES", 0.6), ("LOW_DRIVEN_SHOT", 0.5), ("CHIP_SHOT", 0.3)],
        "CM" => &[("BULLET_PASSES", 1.0), ("PASS_INTO_SPACE", 0.9), ("TIKI_TAKA_MASTER", 0.7), ("TECHNICAL_DRIBBLER", 0.7), ("POSSESSION_HOLDER", 0.7), ("RELENTLESS", 0.6), ("INTERCEPTER", 0.5), ("INVENTIVE", 0.5), ("LOB_PASS_MASTER", 0.4)],
        "CDM" => &[("INTERCEPTER", 1.0), ("TACKLE_VISION", 0.9), ("BULLET_PASSES", 0.9), ("BRICK_WALL", 0.6), ("PASS_INTO_SPACE", 0.6), ("RELENTLESS", 0.6), ("BRUISER", 0.5), ("TIKI_TAKA_MASTER", 0.5), ("LOB_PASS_MASTER", 0.4)],
        "LB" | "RB" => &[("FAST_JOCKEY", 0.8), ("INTERCEPTER", 0.8), ("EXPLOSIVE_SPRINT_BOOST", 0.7), ("WHIPPED_CROSSES", 0.7), ("TACKLE_VISION", 0.6), ("RELENTLESS", 0.6), ("BRICK_WALL", 0.4)],
        "CB" => &[("INTERCEPTER", 1.0), ("TACKLE_VISION", 1.0), ("BRICK_WALL", 0.8), ("BRUISER", 0.8), ("AERIAL_DEFENSE", 0.6), ("FAST_JOCKEY", 0.6), ("BULLET_PASSES", 0.4), ("SLIDE_TACKLER", 0.3)],
        "GK" => &[("FAR_REACH", 1.0), ("DEFLECTOR", 0.6), ("SAVE_WITH_FOOT", 0.6), ("RUSHES_OUT_OF_GOAL", 0.5), ("COMES_FOR_CROSSES", 0.5)],
        _ => &[],
    }
}

/// EA's AcceleRATE (FC 26 rule, SQUADS.md): "explosive", "lengthy" or "controlled".
pub fn accelerate(p: &Player) -> Option<&'static str> {
    let s = p.stats.as_ref()?;
    let (acc, agi, str) = (*s.get("acceleration")? as i64, *s.get("agility")? as i64, *s.get("strength")? as i64);
    let h = p.height? as i64;
    Some(if agi >= 65 && agi - str >= 10 && acc >= 80 && h <= 182 {
        "explosive"
    } else if str >= 65 && str - agi >= 4 && acc >= 40 && h >= 183 {
        "lengthy"
    } else {
        "controlled"
    })
}

/// FC-Tracker rating (beta): how good a card plays in a position. With the in-game attributes
/// (after a sync with extension 0.13): the position's attributes, its PlayStyles (PlayStyle+
/// twice), AcceleRATE, height, weak foot and skill moves; without them, the face stats. Chemistry
/// is added by the solver (each point boosts the card's stats).
pub fn strength(p: &Player, pos: &str) -> f64 {
    let ovr = p.rating as f64;
    if let Some(stats) = p.stats.as_ref().filter(|s| s.len() >= 20) {
        let w = attribute_weights(pos);
        let (sum, total) = w.iter().fold((0.0, 0.0), |(s, t), (name, wt)| match stats.get(*name) {
            Some(&v) => (s + v as f64 * wt, t + wt),
            None => (s, t),
        });
        let mut s = if total > 0.0 { 0.35 * ovr + 0.65 * (sum / total) } else { ovr };
        let ps: f64 = playstyle_weights(pos)
            .iter()
            .filter_map(|(name, wt)| p.playstyles.iter().find(|(n, _)| n == name).map(|(_, plus)| if *plus { 2.0 * wt } else { *wt }))
            .sum();
        s += 0.6 * ps.min(4.0);
        if let Some(h) = p.height {
            let h = h as f64;
            s += match pos {
                "CB" => ((h - 183.0) * 0.15).clamp(-1.5, 1.5),
                "GK" => ((h - 188.0) * 0.2).clamp(-2.0, 1.5),
                "ST" => ((h - 183.0) * 0.08).clamp(-0.5, 1.0),
                "CDM" => ((h - 180.0) * 0.05).clamp(-0.5, 0.8),
                _ => 0.0,
            };
        }
        s += match (accelerate(p), pos) {
            (Some("explosive"), "ST" | "LW" | "RW" | "LM" | "RM" | "CAM") => 0.8,
            (Some("explosive"), "LB" | "RB") => 0.5,
            (Some("lengthy"), "CB") => 0.4,
            (Some("lengthy"), "LW" | "RW" | "LM" | "RM" | "CAM") => -0.3,
            _ => 0.0,
        };
        if matches!(pos, "ST" | "LW" | "RW" | "CAM" | "LM" | "RM") {
            s += 0.4 * (p.weak_foot as f64 - 3.0).max(0.0) + 0.3 * (p.skill_moves as f64 - 3.0).max(0.0);
        }
        s += 0.3 * p.roles_pp.min(2) as f64;
        if p.positions.first().is_some_and(|f| f != pos) {
            s -= 0.3;
        }
        return s;
    }
    strength_face(p, pos)
}

/// The rating without in-game attributes: OVR + the face stats for the position.
fn strength_face(p: &Player, pos: &str) -> f64 {
    let ovr = p.rating as f64;
    // PAC SHO PAS DRI DEF PHY
    let w: [f64; 6] = match pos {
        "ST" => [0.25, 0.35, 0.05, 0.2, 0.0, 0.15],
        "LW" | "RW" | "LM" | "RM" => [0.35, 0.2, 0.15, 0.3, 0.0, 0.0],
        "CAM" => [0.15, 0.2, 0.3, 0.35, 0.0, 0.0],
        "CM" => [0.15, 0.1, 0.35, 0.2, 0.1, 0.1],
        "CDM" => [0.15, 0.0, 0.25, 0.1, 0.3, 0.2],
        "LB" | "RB" => [0.35, 0.0, 0.15, 0.1, 0.3, 0.1],
        "CB" => [0.2, 0.0, 0.05, 0.0, 0.45, 0.3],
        _ => [0.0; 6],
    };
    let mut s = match (&p.face, pos) {
        (Some(f), pos) if pos != "GK" => {
            let weighted: f64 = f.iter().zip(w).map(|(&v, w)| v as f64 * w).sum();
            0.5 * ovr + 0.5 * weighted
        }
        _ => ovr,
    };
    s += 0.4 * p.ps_plus.min(3) as f64 + 0.3 * p.roles_pp.min(2) as f64;
    if matches!(pos, "ST" | "LW" | "RW" | "CAM" | "LM" | "RM") {
        s += 0.3 * (p.weak_foot as f64 - 3.0).max(0.0) + 0.3 * (p.skill_moves as f64 - 3.0).max(0.0);
    }
    // the card's own position first, the others it can play right after
    if p.positions.first().is_some_and(|f| f != pos) {
        s -= 0.3;
    }
    s
}

// ---------- formations ----------

#[derive(Debug, Clone, PartialEq)]
pub struct Formation {
    /// EA's name ("f433").
    pub name: String,
    pub label: String,
    /// 11 positions, the keeper first.
    pub slots: Vec<String>,
}

/// EA position ids → FC 27's positions (wing-backs play as full-backs, a CF as a striker).
fn base_position(id: u64) -> Option<&'static str> {
    Some(match id {
        0 => "GK",
        2 | 3 => "RB",
        1 | 4..=6 => "CB",
        7 | 8 => "LB",
        9..=11 => "CDM",
        12 => "RM",
        13..=15 => "CM",
        16 => "LM",
        17..=19 => "CAM",
        20..=22 | 24..=26 => "ST",
        23 => "RW",
        27 => "LW",
        _ => return None,
    })
}

/// The game's formations as the Web App knows them (`fct://webapp/formations`: `[{ name, label,
/// positions: [ids] }]`).
pub fn formations_from_value(v: &Value) -> Vec<Formation> {
    v.get("formations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|f| {
            let mut slots: Vec<String> = f.get("positions")?.as_array()?.iter().filter_map(Value::as_u64).filter_map(base_position).map(str::to_string).collect();
            // the keeper first, whichever end EA keeps it at
            if let Some(gk) = slots.iter().position(|p| p == "GK") {
                let g = slots.remove(gk);
                slots.insert(0, g);
            }
            let name = f.get("name")?.as_str()?.to_string();
            (slots.len() == 11 && slots[0] == "GK").then(|| Formation { label: f.get("label").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| label_of(&name)), name, slots })
        })
        .collect()
}

fn label_of(name: &str) -> String {
    let digits = name.trim_start_matches('f');
    let (core, variant) = digits.split_once('-').unwrap_or((digits, ""));
    let mut s: String = core.chars().map(|c| c.to_string()).collect::<Vec<_>>().join("-");
    if !variant.is_empty() {
        s.push_str(&format!(" ({variant})"));
    }
    s
}

/// FC's formations, used until the Web App's own list has been read.
pub fn builtin_formations() -> Vec<Formation> {
    const F: &[(&str, &str)] = &[
        ("f433", "RB CB CB LB CM CM CM RW ST LW"),
        ("f433-2", "RB CB CB LB CM CDM CM RW ST LW"),
        ("f433-3", "RB CB CB LB CDM CDM CM RW ST LW"),
        ("f433-4", "RB CB CB LB CM CAM CM RW ST LW"),
        ("f442", "RB CB CB LB RM CM CM LM ST ST"),
        ("f442-2", "RB CB CB LB RM CDM CDM LM ST ST"),
        ("f4231", "RB CB CB LB CDM CDM CAM CAM CAM ST"),
        ("f4231-2", "RB CB CB LB CDM CDM RM CAM LM ST"),
        ("f41212", "RB CB CB LB CDM CM CM CAM ST ST"),
        ("f41212-2", "RB CB CB LB CDM RM LM CAM ST ST"),
        ("f4222", "RB CB CB LB CDM CDM CAM CAM ST ST"),
        ("f4312", "RB CB CB LB CM CM CM CAM ST ST"),
        ("f451", "RB CB CB LB RM CM CAM CAM LM ST"),
        ("f451-2", "RB CB CB LB RM CM CDM CM LM ST"),
        ("f4141", "RB CB CB LB CDM RM CM CM LM ST"),
        ("f424", "RB CB CB LB CM CM RW ST ST LW"),
        ("f4411", "RB CB CB LB RM CM CM LM CAM ST"),
        ("f4213", "RB CB CB LB CDM CDM CAM RW ST LW"),
        ("f3412", "CB CB CB RM CM CM LM CAM ST ST"),
        ("f3421", "CB CB CB RM CM CM LM CAM CAM ST"),
        ("f343", "CB CB CB RM CM CM LM RW ST LW"),
        ("f352", "CB CB CB CDM CDM RM CAM LM ST ST"),
        ("f3142", "CB CB CB CDM RM CM CM LM ST ST"),
        ("f532", "RB CB CB CB LB CM CM CM ST ST"),
        ("f523", "RB CB CB CB LB CM CM RW ST LW"),
        ("f541", "RB CB CB CB LB RM CM CM LM ST"),
        ("f5212", "RB CB CB CB LB CM CM CAM ST ST"),
    ];
    F.iter()
        .map(|(name, slots)| Formation {
            name: name.to_string(),
            label: label_of(name),
            slots: std::iter::once("GK").chain(slots.split(' ')).map(str::to_string).collect(),
        })
        .collect()
}

// ---------- solver ----------

struct Ctx<'a> {
    players: &'a [Player],
    reqs: &'a [Req],
    prefs: &'a SquadPrefs,
    links: &'a BTreeMap<u64, u64>,
    active: &'a BTreeSet<u64>,
    active_formation: Option<&'a str>,
    /// How much each requirement weighs (the picked event's most); empty = 1 each.
    weights: &'a [f64],
    /// player → requirements it meets
    meets: Vec<Vec<usize>>,
    /// "Has to include" players (indices).
    must: BTreeSet<usize>,
}

#[derive(Debug, Clone)]
struct Pick {
    /// player index per slot
    slots: Vec<Option<usize>>,
    score: f64,
}

impl Ctx<'_> {
    fn eligible(&self, p: usize, pos: &str) -> bool {
        self.players[p].positions.iter().any(|x| x == pos)
    }

    /// One number, highest best: requirements (each counts by how close it is, a met one fully
    /// twice), the chemistry target, strength at chemistry, and few changes from the active squad.
    /// The weights keep the user's order: a step up in the first never loses to the rest.
    fn score(&self, f: &Formation, slots: &[Option<usize>]) -> f64 {
        let chosen: Vec<&Player> = slots.iter().flatten().map(|&i| &self.players[i]).collect();
        let mut have = vec![0u32; self.reqs.len()];
        for &i in slots.iter().flatten() {
            for &r in &self.meets[i] {
                have[r] += 1;
            }
        }
        let chem = chemistry(&chosen, self.links);
        let total: u32 = chem.iter().sum::<u32>() + 3 * (11 - chosen.len() as u32);
        for (r, h) in self.reqs.iter().zip(have.iter_mut()) {
            if let Need::Chemistry(min) = r.need {
                *h = u32::from(total >= min);
            }
        }
        let reqs: f64 = self
            .reqs
            .iter()
            .zip(&have)
            .enumerate()
            .map(|(k, (r, &h))| self.weights.get(k).copied().unwrap_or(1.0) * (h.min(r.count) as f64 / r.count as f64 + if h >= r.count { 1.0 } else { 0.0 }))
            .sum();
        let short = self.prefs.chem_target.min(33).saturating_sub(total) as f64;
        let mut power = 0.0;
        for (&s, pos) in slots.iter().zip(&f.slots) {
            let Some(i) = s else { continue };
            power += strength(&self.players[i], pos);
            // the squad the user plays stays unless a change is clearly better (user 2026-10-30:
            // "10 changes from your squad" is not an objective squad)
            if self.active.contains(&self.players[i].key) {
                power += 2000.0;
            }
        }
        if self.active_formation == Some(f.name.as_str()) {
            power += 4000.0;
        }
        power += 0.35 * chem.iter().sum::<u32>() as f64;
        // "has to include" comes before everything
        let must = slots.iter().flatten().filter(|i| self.must.contains(i)).count() as f64 * 1.0e12;
        must + if self.prefs.chem_first {
            -short * 1.0e7 + reqs * 2.0e4 + power
        } else {
            reqs * 1.0e6 - short * 2.0e3 + power
        }
    }

    fn used(slots: &[Option<usize>], p: usize, players: &[Player]) -> bool {
        let person = players[p].person();
        slots.iter().flatten().any(|&q| q == p || players[q].person() == person)
    }

    /// Greedy start, then the best single change (a card in, or two slots swapped) until none helps.
    fn solve_formation(&self, f: &Formation, pool: &[Vec<usize>], seed: u64) -> Pick {
        let mut slots: Vec<Option<usize>> = vec![None; 11];
        // "has to include" first: the fewest possible slots first, its own position if it can
        let mut must: Vec<usize> = self.must.iter().copied().collect();
        must.sort_by_key(|&p| f.slots.iter().filter(|pos| self.eligible(p, pos)).count());
        for p in must {
            let own = self.players[p].positions.first();
            let free = |k: &usize| slots[*k].is_none() && self.eligible(p, &f.slots[*k]);
            if let Some(k) = (0..11).filter(free).find(|&k| Some(&f.slots[k]) == own).or_else(|| (0..11).find(free)) {
                if !Self::used(&slots, p, self.players) {
                    slots[k] = Some(p);
                }
            }
        }
        // the squad the user plays, in its own formation: the search starts from it and changes only
        // what helps
        if self.active_formation == Some(f.name.as_str()) {
            let mut act: Vec<usize> = (0..self.players.len()).filter(|&i| self.active.contains(&self.players[i].key)).collect();
            act.sort_by_key(|&p| f.slots.iter().filter(|pos| self.eligible(p, pos)).count());
            for p in act {
                let own = self.players[p].positions.first();
                let free = |k: &usize| slots[*k].is_none() && self.eligible(p, &f.slots[*k]);
                if let Some(k) = (0..11).filter(free).find(|&k| Some(&f.slots[k]) == own).or_else(|| (0..11).find(free)) {
                    if !Self::used(&slots, p, self.players) {
                        slots[k] = Some(p);
                    }
                }
            }
        }
        // scarce slots first
        let mut order: Vec<usize> = (0..11).filter(|&k| slots[k].is_none()).collect();
        order.sort_by_key(|&k| pool[k].len());
        let mut rng = seed.max(1);
        for &k in &order {
            let mut best: Option<(f64, usize)> = None;
            for &p in &pool[k] {
                if Self::used(&slots, p, self.players) {
                    continue;
                }
                slots[k] = Some(p);
                let mut s = self.score(f, &slots);
                if seed > 1 {
                    rng ^= rng << 13;
                    rng ^= rng >> 7;
                    rng ^= rng << 17;
                    s += (rng % 1000) as f64 * 0.004; // restarts: a little noise in the start
                }
                slots[k] = None;
                if best.is_none_or(|b| s > b.0) {
                    best = Some((s, p));
                }
            }
            slots[k] = best.map(|b| b.1);
        }
        let mut score = self.score(f, &slots);
        for _ in 0..60 {
            let mut improved = false;
            for k in 0..11 {
                for &p in &pool[k] {
                    if slots[k] == Some(p) {
                        continue;
                    }
                    let at = slots.iter().position(|&s| s == Some(p));
                    let mut next = slots.clone();
                    match at {
                        // swap two slots: both must play their new position
                        Some(j) => {
                            if !slots[k].is_some_and(|q| self.eligible(q, &f.slots[j])) {
                                continue;
                            }
                            next.swap(k, j);
                        }
                        None => {
                            let person = self.players[p].person();
                            if slots.iter().enumerate().any(|(j, s)| j != k && s.is_some_and(|q| self.players[q].person() == person)) {
                                continue;
                            }
                            next[k] = Some(p);
                        }
                    }
                    let s = self.score(f, &next);
                    if s > score + 1e-9 {
                        slots = next;
                        score = s;
                        improved = true;
                    }
                }
            }
            if !improved {
                break;
            }
        }
        Pick { slots, score }
    }
}

/// The best XI over all formations. `players` = the candidates (the club, loans already left out
/// when the user wants that).
#[cfg(test)]
fn solve(players: &[Player], reqs: &[Req], formations: &[Formation], prefs: &SquadPrefs, links: &BTreeMap<u64, u64>, active: &BTreeSet<u64>, active_formation: Option<&str>) -> Option<(usize, Pick)> {
    solve_weighted(players, reqs, &[], formations, prefs, links, active, active_formation)
}

#[allow(clippy::too_many_arguments)]
fn solve_weighted(players: &[Player], reqs: &[Req], weights: &[f64], formations: &[Formation], prefs: &SquadPrefs, links: &BTreeMap<u64, u64>, active: &BTreeSet<u64>, active_formation: Option<&str>) -> Option<(usize, Pick)> {
    let meets: Vec<Vec<usize>> = players.iter().map(|p| reqs.iter().enumerate().filter(|(_, r)| r.need.met_by(p, links)).map(|(i, _)| i).collect()).collect();
    let must = (0..players.len()).filter(|&i| prefs.must.contains(&players[i].key)).collect();
    let ctx = Ctx { players, reqs, prefs, links, active, active_formation, weights, meets, must };
    let mut best: Option<(usize, Pick)> = None;
    // the strongest per position + everyone who meets a requirement (keeps the search small)
    let mut results: Vec<(usize, Pick, Vec<Vec<usize>>)> = Vec::new();
    for (fi, f) in formations.iter().enumerate() {
        let pool: Vec<Vec<usize>> = f
            .slots
            .iter()
            .map(|pos| {
                let mut c: Vec<usize> = (0..players.len()).filter(|&i| ctx.eligible(i, pos)).collect();
                c.sort_by(|&a, &b| strength(&players[b], pos).total_cmp(&strength(&players[a], pos)));
                let (top, rest) = c.split_at(c.len().min(14));
                let mut keep = top.to_vec();
                keep.extend(rest.iter().filter(|&&i| !ctx.meets[i].is_empty()).take(30));
                let musts: Vec<usize> = rest.iter().copied().filter(|i| ctx.must.contains(i) && !keep.contains(i)).collect();
                keep.extend(musts);
                keep
            })
            .collect();
        if pool.iter().any(Vec::is_empty) {
            continue;
        }
        let pick = ctx.solve_formation(f, &pool, 1);
        results.push((fi, pick, pool));
    }
    // a few restarts on the most promising formations
    results.sort_by(|a, b| b.1.score.total_cmp(&a.1.score));
    for (fi, pick, pool) in results.iter().take(5) {
        let mut cand = pick.clone();
        for seed in [7u64, 99, 2024] {
            let p = ctx.solve_formation(&formations[*fi], pool, seed);
            if p.score > cand.score {
                cand = p;
            }
        }
        if best.as_ref().is_none_or(|b| cand.score > b.1.score) {
            best = Some((*fi, cand));
        }
    }
    best
}

// ---------- output ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SquadsView {
    pub events: Vec<EventPlan>,
    /// Play sessions: the user's pick (or the most objectives) first, then what's left.
    pub combos: Vec<ComboPlan>,
    /// Events the first session can't play for (another mode or live event).
    pub apart: Vec<Apart>,
    /// Where the picked event can be played.
    pub places: Vec<PlaceOption>,
    /// The picked event, when it still has open match objectives.
    pub primary: Option<u64>,
    /// The sync hasn't brought objectives yet (extension older than 0.13 or never synced).
    pub needs_sync: bool,
    /// Requirements can't be read without the names (a sync with the new extension brings them).
    pub names_missing: bool,
    /// Club players with their positions known.
    pub club_players: usize,
    pub coins: Option<u64>,
    /// ms
    pub read_at: Option<u64>,
    pub prefs: SquadPrefs,
    /// The club, strongest first – the "has to include" list to pick from.
    pub club: Vec<ClubEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClubEntry {
    /// Club item id (owned) or card definition (not owned).
    pub key: u64,
    pub name: String,
    pub rating: u32,
    pub positions: Vec<String>,
    pub nation: u64,
    pub nation_name: Option<String>,
    pub loan: bool,
    pub owned: bool,
    /// EA's price (not owned, when known and recent).
    pub price: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EventPlan {
    pub id: u64,
    pub title: String,
    pub ends_at: Option<u64>,
    pub done: usize,
    pub total: usize,
    pub objectives: Vec<ObjectiveView>,
    pub reqs: Vec<ReqView>,
    pub squad: Option<SquadView>,
    /// The session (`ComboPlan::id`) shown for this event.
    pub combo: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ObjectiveView {
    pub id: u64,
    /// Done / not done by the user's own mark (newer than the last sync).
    pub marked: bool,
    pub name: String,
    pub text: String,
    pub progress: u32,
    pub target: u32,
    pub done: bool,
    /// Index into the event's `reqs`.
    pub req: Option<usize>,
    /// A squad part that could not be read.
    pub unknown: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ReqView {
    pub need: Need,
    /// The league / club / nation as the Web App names it.
    pub name: String,
    pub count: u32,
    pub have: u32,
    pub met: bool,
    pub players: Vec<String>,
    /// Realistic cards to get when the squad falls short.
    pub options: Vec<GetOption>,
    /// Cards that would do but have no recent price.
    pub unpriced: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SquadView {
    pub formation: String,
    pub chem: u32,
    pub chem_target: u32,
    pub slots: Vec<SlotView>,
    /// Average FC-Tracker rating (beta) of the 11.
    pub strength: f64,
    pub met: usize,
    pub changes: Option<usize>,
    /// "Has to include" cards that found no place (their positions don't fit any formation together).
    pub must_missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SlotView {
    pub pos: String,
    pub name: String,
    pub def_id: u64,
    pub rating: u32,
    pub chem: u32,
    pub strength: f64,
    pub loan: bool,
    /// Indices of the event's requirements this card counts for.
    pub counts_for: Vec<usize>,
    /// "explosive" | "controlled" | "lengthy" (in-game attributes read).
    pub accel: Option<String>,
    /// PlayStyles that matter in this position (PlayStyles+ among them).
    pub key_ps: u32,
    pub key_ps_plus: u32,
    /// The rating comes from the in-game attributes (else from the face stats).
    pub full: bool,
    /// EA's nation id (the flag).
    pub nation: u64,
    /// The nation as the Web App names it (a flag for a nation the table doesn't know yet).
    pub nation_name: Option<String>,
    /// Bio: 1 = right foot, 2 = left, 0 = unknown; weak foot and skill moves in stars.
    pub foot: u8,
    pub weak_foot: u32,
    pub skill_moves: u32,
    /// A "has to include" card.
    pub must: bool,
    /// Not in the club yet (a "has to include" card to get) and its price.
    pub owned: bool,
    pub price: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GetOption {
    /// "owned" | "reward" | "sbc" | "cheapest" | "value" | "upgrade"
    pub kind: String,
    pub name: String,
    pub def_id: u64,
    pub rating: u32,
    pub pos: String,
    pub price: Option<u64>,
    /// Objective / SBC name for "reward" and "sbc".
    pub source: Option<String>,
    pub strength: f64,
    pub nation: u64,
    pub nation_name: Option<String>,
}

/// Everything the plan needs, gathered by the app (or the browser) from its own data.
pub struct Input {
    pub groups: Vec<Group>,
    pub names: Names,
    pub names_known: bool,
    pub club: Vec<Player>,
    /// Every card that exists (the Gallery catalog), owned or not.
    pub catalog: Vec<Player>,
    pub prices: BTreeMap<u64, Price>,
    /// Card definition → open objective / SBC that awards it: (kind, name).
    pub rewards: BTreeMap<u64, Vec<(String, String)>>,
    pub formations: Vec<Formation>,
    pub team_links: BTreeMap<u64, Vec<u64>>,
    /// Item ids of the user's active squad.
    pub active: BTreeSet<u64>,
    /// Its formation (EA's name, "f4312").
    pub active_formation: Option<String>,
    pub coins: Option<u64>,
    pub read_at: Option<u64>,
    pub now_ms: u64,
}

fn need_name(need: &Need, names: &Names) -> String {
    match *need {
        Need::League(id) => names.league_name(id).map(str::to_string).unwrap_or_else(|| format!("#{id}")),
        Need::Club(id) => names.team_name(id).map(str::to_string).unwrap_or_else(|| format!("#{id}")),
        Need::Nation(id) => names.nations.get(&id).cloned().unwrap_or_else(|| format!("#{id}")),
        Need::Icon | Need::Hero => String::new(),
        Need::Rating(min) | Need::WeakFoot(min) | Need::SkillMoves(min) | Need::Chemistry(min) => min.to_string(),
        Need::Rarity(r) => names.rarities.get(&r).cloned().unwrap_or_else(|| format!("#{r}")),
        Need::Accel(ref k) => k.clone(),
        Need::PlayStyle(ref n, _) => n.clone(),
    }
}

/// The squad requirements of an event, one per need (the highest count wins).
fn event_reqs(g: &Group, names: &Names) -> (Vec<Req>, Vec<(Option<usize>, Option<String>)>) {
    let mut reqs: Vec<Req> = Vec::new();
    let mut per_obj = Vec::new();
    for o in &g.objectives {
        let parsed = parse_requirement(&o.text, names);
        per_obj.push(match parsed {
            Parsed::Squad(r) => {
                if o.done {
                    (None, None)
                } else if let Some(i) = reqs.iter().position(|x| x.need == r.need) {
                    reqs[i].count = reqs[i].count.max(r.count);
                    (Some(i), None)
                } else {
                    reqs.push(r);
                    (Some(reqs.len() - 1), None)
                }
            }
            Parsed::Unknown(s) => (None, (!o.done).then_some(s)),
            Parsed::None => (None, None),
        });
    }
    (reqs, per_obj)
}

/// EA's price of a card when it's recent enough to plan with.
fn fresh_price(input: &Input, def: u64) -> Option<u64> {
    input.prices.get(&def).filter(|x| input.now_ms.saturating_sub(x.at) <= PRICE_FRESH_MS).and_then(Price::value)
}

/// "Has to include" search over every card that exists (the club list covers the owned ones):
/// name words, a position or a rating, strongest first.
pub fn search(input: &Input, q: &str, limit: usize) -> Vec<ClubEntry> {
    let words: Vec<String> = q.split_whitespace().map(normalise_name).filter(|w| !w.is_empty()).collect();
    let raw: Vec<String> = q.split_whitespace().map(|w| w.to_uppercase()).collect();
    if words.is_empty() && raw.is_empty() {
        return Vec::new();
    }
    let owned: BTreeSet<u64> = input.club.iter().map(|p| p.def_id).collect();
    let mut out: Vec<ClubEntry> = input
        .catalog
        .iter()
        .filter(|c| !owned.contains(&c.def_id) && !c.name.is_empty())
        .filter(|c| {
            let name = normalise_name(&c.name);
            raw.iter().zip(&words).all(|(r, w)| name.contains(w.as_str()) || c.positions.iter().any(|p| p == r) || c.rating.to_string() == *r)
        })
        .map(|c| ClubEntry {
            key: c.def_id,
            name: c.name.clone(),
            rating: c.rating,
            positions: c.positions.clone(),
            nation: c.nation,
            nation_name: input.names.nations.get(&c.nation).cloned(),
            loan: false,
            owned: false,
            price: fresh_price(input, c.def_id),
        })
        .collect();
    out.sort_by(|a, b| b.rating.cmp(&a.rating).then_with(|| a.name.cmp(&b.name)));
    out.truncate(limit);
    out
}

// ---------- where an objective counts ----------

/// Where a match counts for an objective (user 2026-10-30: objectives that need different modes –
/// the Ghoul Fest live event and an FC Heritage event – can never be played together).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(tag = "kind", content = "name", rename_all = "snake_case")]
pub enum Mode {
    SquadBattles,
    Rivals,
    Champions,
    Rush,
    Draft,
    CoOp,
    /// Any live event ("… or Live Events").
    LiveEvents,
    /// One named live event or tournament, lower case ("ghoul fest", "fc heritage circuit tournament").
    Event(String),
    /// "in any FUT game mode" – and a match objective that names no place.
    Any,
}

/// Where an objective's matches count, read from its text. None = not played in a match (SBCs,
/// the market, the Gallery, the club, building a squad): it never shapes a play session.
pub fn objective_modes(text: &str) -> Option<Vec<Mode>> {
    let l = text.to_lowercase();
    let matchy = ["match", "goal", "score", "assist", "win ", "clean sheet", "header", "points", "division", "tournament"].iter().any(|k| l.contains(k));
    // "Complete the … objective 5 times" moves on by itself
    if !matchy || l.starts_with("complete ") || l.contains("squad building challenge") || l.contains(" sbc") || l.contains("transfer market") {
        return None;
    }
    if l.contains("any fut game mode") || l.contains("any football ultimate team game mode") || l.contains("any game mode") {
        return Some(vec![Mode::Any]);
    }
    let mut out: Vec<Mode> = Vec::new();
    // a named event: "in the Ghoul Fest Live Event", "Win the FC Heritage Circuit Tournament 3 times"
    for key in ["in the ", "win the "] {
        let mut from = 0;
        while let Some(i) = l[from..].find(key) {
            let start = from + i + key.len();
            from = start;
            let rest = &l[start..];
            let stop = [" while", " and ", ",", ".", " (", " with ", " on ", " to "].iter().filter_map(|k| rest.find(k)).min().unwrap_or(rest.len());
            let phrase = rest[..stop].trim();
            // the name runs to its last "event" / "tournament" / "cup N"
            let mut cut = None;
            for kw in ["event", "tournament", "cup"] {
                if let Some(p) = phrase.rfind(kw) {
                    let mut end = p + kw.len();
                    if kw == "cup" {
                        end += phrase[end..].chars().take_while(|c| *c == ' ' || c.is_ascii_digit()).count();
                    }
                    cut = Some(cut.map_or(end, |c: usize| c.max(end)));
                }
            }
            if let Some(c) = cut {
                let name = phrase[..c].trim().trim_end_matches(" live event").trim().to_string();
                if !name.is_empty() && !matches!(name.as_str(), "event" | "live event") && !out.contains(&Mode::Event(name.clone())) {
                    out.push(Mode::Event(name));
                }
            }
        }
    }
    let named = !out.is_empty();
    for (k, m) in [("squad battle", Mode::SquadBattles), ("rivals", Mode::Rivals), ("champions", Mode::Champions), ("rush", Mode::Rush), ("draft", Mode::Draft), ("co-op", Mode::CoOp)] {
        if l.contains(k) && !out.contains(&m) {
            out.push(m);
        }
    }
    if l.contains("live events") || (!named && l.contains("live event")) {
        out.push(Mode::LiveEvents);
    }
    if out.is_empty() {
        out.push(Mode::Any);
    }
    Some(out)
}

/// Does a match played at `place` count for an objective of these modes?
pub fn plays_in(modes: &[Mode], place: &Mode) -> bool {
    modes.iter().any(|m| match (m, place) {
        // a drafted squad is not the user's: never a place for squad objectives by itself
        (Mode::Any, Mode::Draft | Mode::CoOp) => false,
        (Mode::Any, _) => true,
        (Mode::LiveEvents, Mode::Event(_)) => true,
        (a, b) => a == b,
    })
}

// ---------- play sessions ----------

/// One way to play right now: a place (mode or live event), the XI for it and every open
/// objective a match there moves on – across events. The first is the user's own pick ("I'm
/// playing Ghoul Fest") or, on Auto, the one that moves the most; the rest take what's left.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ComboPlan {
    /// 1, 2, 3 …
    pub id: u64,
    pub place: Mode,
    /// The place as the game names it (a live event by its event's title).
    pub place_name: String,
    /// The events it plays for, soonest-ending first.
    pub title: String,
    pub ends_at: Option<u64>,
    /// The squad requirements (an item's `req` points here).
    pub reqs: Vec<ReqView>,
    pub items: Vec<SessionItem>,
    pub squad: Option<SquadView>,
    /// Objectives a match here moves on with this squad.
    pub counted: usize,
    /// The event the user picked to play (this session is built around it).
    pub primary: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SessionItem {
    pub event: u64,
    pub event_title: String,
    pub objective: u64,
    pub name: String,
    pub text: String,
    pub progress: u32,
    pub target: u32,
    /// Index into the session's `reqs`; none = counts with any squad.
    pub req: Option<usize>,
    /// A squad part that could not be read (shown, never guessed).
    pub unknown: Option<String>,
    /// The requirement is about who scores / assists ("using a player from Germany").
    pub scorer: bool,
    /// Counts with this squad.
    pub counts: bool,
}

/// An event with open match objectives that can't be played at the first session's place.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Apart {
    pub event: u64,
    pub title: String,
    pub places: Vec<String>,
}

/// A place the picked event can be played at, and how many open objectives count there.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PlaceOption {
    pub place: Mode,
    pub name: String,
    pub objectives: usize,
}

/// The XI as shown, with each requirement's count in it.
fn squad_view(club: &[Player], f: &Formation, pick: &Pick, reqs: &[Req], prefs: &SquadPrefs, input: &Input, links: &BTreeMap<u64, u64>) -> (SquadView, Vec<ReqView>) {
    let mut req_views: Vec<ReqView> = reqs
        .iter()
        .map(|r| ReqView { need: r.need.clone(), name: need_name(&r.need, &input.names), count: r.count, have: 0, met: false, players: vec![], options: vec![], unpriced: 0 })
        .collect();
    let xi: Vec<&Player> = pick.slots.iter().flatten().map(|&i| &club[i]).collect();
    let chem = chemistry(&xi, links);
    let mut slots = Vec::new();
    for ((s, pos), c) in pick.slots.iter().zip(&f.slots).zip(chem.iter().copied().chain(std::iter::repeat(0))) {
        let Some(i) = *s else { continue };
        let p = &club[i];
        let counts_for: Vec<usize> = reqs.iter().enumerate().filter(|(_, r)| r.need.met_by(p, links)).map(|(k, _)| k).collect();
        for &k in &counts_for {
            req_views[k].have += 1;
            req_views[k].players.push(p.name.clone());
        }
        let key = playstyle_weights(pos);
        let key_ps = p.playstyles.iter().filter(|(n, _)| key.iter().any(|(k, _)| k == n)).count() as u32;
        let key_ps_plus = p.playstyles.iter().filter(|(n, plus)| *plus && key.iter().any(|(k, _)| k == n)).count() as u32;
        slots.push(SlotView {
            pos: pos.clone(),
            name: p.name.clone(),
            def_id: p.def_id,
            rating: p.rating,
            chem: c,
            strength: round1(strength(p, pos)),
            loan: p.loan,
            counts_for,
            accel: accelerate(p).map(str::to_string),
            key_ps,
            key_ps_plus,
            full: p.stats.as_ref().is_some_and(|s| s.len() >= 20),
            nation: p.nation,
            nation_name: input.names.nations.get(&p.nation).cloned(),
            foot: p.foot,
            weak_foot: p.weak_foot,
            skill_moves: p.skill_moves,
            must: prefs.must.contains(&p.key) || (!p.owned && prefs.must_cards.contains(&p.def_id)),
            owned: p.owned,
            price: (!p.owned).then(|| fresh_price(input, p.def_id)).flatten(),
        });
    }
    // a chemistry requirement is the squad's, not a card's
    let total: u32 = chem.iter().sum();
    for (k, r) in reqs.iter().enumerate() {
        if let Need::Chemistry(min) = r.need {
            req_views[k].have = u32::from(total >= min);
        }
    }
    for r in &mut req_views {
        r.met = r.have >= r.count;
    }
    let strength = if slots.is_empty() { 0.0 } else { round1(slots.iter().map(|s| s.strength).sum::<f64>() / slots.len() as f64) };
    let changes = (!input.active.is_empty()).then(|| pick.slots.iter().flatten().filter(|&&i| !input.active.contains(&club[i].key)).count());
    let placed: BTreeSet<u64> = pick.slots.iter().flatten().map(|&i| club[i].key).collect();
    let must_missing = prefs
        .must
        .iter()
        .filter(|k| !placed.contains(k))
        .map(|k| input.club.iter().find(|p| p.key == *k).map(|p| p.name.clone()).unwrap_or_else(|| format!("#{k}")))
        .collect();
    let sq = SquadView { formation: f.label.clone(), chem: total, chem_target: prefs.chem_target.min(33), met: req_views.iter().filter(|r| r.met).count(), slots, strength, changes, must_missing };
    (sq, req_views)
}

/// The most sessions shown, and the most places fully searched for one.
const MAX_SESSIONS: usize = 5;
const MAX_TRIES: usize = 2;

/// An open objective a match moves on.
struct Item {
    ev: usize,
    obj: usize,
    modes: Vec<Mode>,
    req: Option<Req>,
    unknown: Option<String>,
}

/// One event's data for the plan.
struct Ev {
    g: Group,
    marked: BTreeSet<u64>,
    reqs: Vec<Req>,
    per_obj: Vec<(Option<usize>, Option<String>)>,
}

/// What the plan works with for one session search.
struct Planner<'a> {
    input: &'a Input,
    prefs: &'a SquadPrefs,
    club: &'a [Player],
    formations: &'a [Formation],
    links: &'a BTreeMap<u64, u64>,
    evs: &'a [Ev],
    items: &'a [Item],
    /// Searches already run (the same requirements give the same XI).
    solved: std::cell::RefCell<BTreeMap<String, Option<(usize, Pick)>>>,
}

impl Planner<'_> {
    /// The place as the game names it: a live event by its event's title.
    fn place_name(&self, place: &Mode) -> String {
        match place {
            Mode::Event(name) => {
                let n = norm(name);
                self.evs
                    .iter()
                    .map(|e| &e.g.title)
                    .find(|t| {
                        let t = norm(t);
                        !t.is_empty() && (t == n || n.contains(&t) || t.contains(&n))
                    })
                    .cloned()
                    .unwrap_or_else(|| name.split(' ').map(|w| w.chars().next().map(|c| c.to_uppercase().collect::<String>() + &w[c.len_utf8()..]).unwrap_or_default()).collect::<Vec<_>>().join(" "))
            }
            other => serde_json::to_value(other).ok().and_then(|v| v.get("kind").and_then(Value::as_str).map(str::to_string)).unwrap_or_default(),
        }
    }

    /// A session at `place` over the open objectives in `avail`; the picked event's
    /// requirements weigh most.
    fn session(&self, place: &Mode, avail: &[usize], primary: Option<u64>) -> (ComboPlan, Option<(usize, Pick)>) {
        let here: Vec<usize> = avail.iter().copied().filter(|&i| plays_in(&self.items[i].modes, place)).collect();
        let mut reqs: Vec<Req> = Vec::new();
        let mut weights: Vec<f64> = Vec::new();
        let mut req_of: Vec<Option<usize>> = Vec::new();
        for &i in &here {
            let it = &self.items[i];
            req_of.push(it.req.as_ref().map(|r| {
                reqs.push(r.clone());
                weights.push(if primary == Some(self.evs[it.ev].g.id) { 20.0 } else { 1.0 });
                reqs.len() - 1
            }));
        }
        let solved = if self.club.len() >= 11 && !here.is_empty() {
            let key = format!("{reqs:?}{weights:?}");
            let hit = self.solved.borrow().get(&key).cloned();
            hit.unwrap_or_else(|| {
                let s = solve_weighted(self.club, &reqs, &weights, self.formations, self.prefs, self.links, &self.input.active, self.input.active_formation.as_deref());
                self.solved.borrow_mut().insert(key, s.clone());
                s
            })
        } else {
            None
        };
        let (squad, req_views) = match &solved {
            Some((fi, pick)) => {
                let (sq, rv) = squad_view(self.club, &self.formations[*fi], pick, &reqs, self.prefs, self.input, self.links);
                (Some(sq), rv)
            }
            None => (None, reqs.iter().map(|r| ReqView { need: r.need.clone(), name: need_name(&r.need, &self.input.names), count: r.count, have: 0, met: false, players: vec![], options: vec![], unpriced: 0 }).collect()),
        };
        let items: Vec<SessionItem> = here
            .iter()
            .zip(&req_of)
            .map(|(&i, &r)| {
                let it = &self.items[i];
                let ev = &self.evs[it.ev];
                let o = &ev.g.objectives[it.obj];
                let counts = it.unknown.is_none() && r.is_none_or(|k| req_views[k].met);
                SessionItem {
                    event: ev.g.id,
                    event_title: ev.g.title.clone(),
                    objective: o.id,
                    name: o.name.clone(),
                    text: o.text.clone(),
                    progress: o.progress.min(o.target),
                    target: o.target,
                    req: r,
                    unknown: it.unknown.clone(),
                    scorer: r.is_some() && !o.text.to_lowercase().contains("starting"),
                    counts,
                }
            })
            .collect();
        let counted = items.iter().filter(|x| x.counts).count();
        // the events it moves on (all of them when nothing counts yet)
        let mut events_in: Vec<usize> = here.iter().zip(&items).filter(|(_, x)| x.counts || counted == 0).map(|(&i, _)| self.items[i].ev).collect();
        events_in.sort();
        events_in.dedup();
        events_in.sort_by_key(|&e| (primary != Some(self.evs[e].g.id), self.evs[e].g.ends_at.unwrap_or(u64::MAX)));
        let title = events_in.iter().map(|&e| self.evs[e].g.title.as_str()).collect::<Vec<_>>().join(" · ");
        let ends_at = events_in.iter().filter_map(|&e| self.evs[e].g.ends_at).min();
        let plan = ComboPlan { id: 0, place: place.clone(), place_name: self.place_name(place), title, ends_at, reqs: req_views, items, squad, counted, primary };
        (plan, solved)
    }

    /// The places a match can be played at for these objectives (Any alone when nothing narrower).
    fn places(&self, avail: &[usize]) -> Vec<Mode> {
        let mut out: Vec<Mode> = Vec::new();
        for &i in avail {
            for m in &self.items[i].modes {
                if !matches!(m, Mode::Any | Mode::LiveEvents) && !out.contains(m) {
                    out.push(m.clone());
                }
            }
        }
        if avail.iter().any(|&i| self.items[i].modes.contains(&Mode::Any)) && !out.iter().any(|m| matches!(m, Mode::SquadBattles | Mode::Rivals | Mode::Champions | Mode::Event(_))) {
            out.push(Mode::Any);
        }
        out
    }

    /// The best session over `places`: the most objectives counted. The places are tried in the
    /// order of how many objectives could count there, a full search only while one could win.
    fn best(&self, places: &[Mode], avail: &[usize], primary: Option<u64>) -> Option<(ComboPlan, Option<(usize, Pick)>)> {
        let mut ranked: Vec<(usize, &Mode)> = places.iter().map(|p| (avail.iter().filter(|&&i| plays_in(&self.items[i].modes, p)).count(), p)).filter(|(n, _)| *n > 0).collect();
        ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
        let mut best: Option<(ComboPlan, Option<(usize, Pick)>)> = None;
        let mut seen: Vec<Vec<usize>> = Vec::new();
        let mut tries = 0;
        for (upper, place) in ranked {
            if best.as_ref().is_some_and(|b| b.0.counted >= upper) || tries >= MAX_TRIES {
                break;
            }
            // places where the same objectives count give the same session
            let set: Vec<usize> = avail.iter().copied().filter(|&i| plays_in(&self.items[i].modes, place)).collect();
            if seen.contains(&set) {
                continue;
            }
            seen.push(set);
            tries += 1;
            let s = self.session(place, avail, primary);
            if best.as_ref().is_none_or(|b| s.0.counted > b.0.counted) {
                best = Some(s);
            }
        }
        best
    }
}

pub fn plan(input: &Input, prefs: &SquadPrefs) -> SquadsView {
    let links = link_map(&input.team_links);
    let formations = if input.formations.is_empty() { builtin_formations() } else { input.formations.clone() };
    let mut club: Vec<Player> = input.club.iter().filter(|p| !p.positions.is_empty() && (!(prefs.hide_loans && p.loan) || prefs.must.contains(&p.key))).cloned().collect();
    // "has to include" cards not owned yet play as cards to get (a must by their definition)
    let owned_now: BTreeSet<u64> = input.club.iter().map(|p| p.def_id).collect();
    // the settings as the user made them go back to the UI; the plan adds the cards to get to `must`
    let mut shown_prefs = prefs.clone();
    // marks a later sync has overtaken are dropped (EA's word stands from then on)
    shown_prefs.done_marks.retain(|m| m.at > input.read_at.unwrap_or(0));
    let mut prefs = prefs.clone();
    for &def in &prefs.must_cards.clone() {
        if owned_now.contains(&def) {
            continue;
        }
        if let Some(p) = input.catalog.iter().find(|c| c.def_id == def) {
            club.push(Player { key: def, owned: false, ..p.clone() });
            prefs.must.push(def);
        }
    }
    let prefs = &prefs;
    let owned_defs: BTreeSet<u64> = input.club.iter().map(|p| p.def_id).collect();
    let budget = prefs.budget.or(input.coins);
    let now_s = input.now_ms / 1000;
    // the user's own marks, while newer than the last read (a later sync says what EA says)
    let read_at = input.read_at.unwrap_or(0);
    let marks: Vec<&DoneMark> = prefs.done_marks.iter().filter(|m| m.at > read_at).collect();

    // 1. the open events a match moves on (or with a hand mark to take back)
    let mut evs: Vec<Ev> = Vec::new();
    for g0 in &input.groups {
        if g0.ends_at.is_some_and(|e| input.now_ms > 0 && e <= now_s) || evs.iter().any(|e| e.g.id == g0.id) {
            continue;
        }
        let mut g = g0.clone();
        let mut marked: BTreeSet<u64> = BTreeSet::new();
        for o in &mut g.objectives {
            if let Some(m) = marks.iter().find(|m| m.group == g0.id && m.objective == o.id) {
                o.done = m.done;
                if m.done {
                    o.progress = o.target;
                }
                marked.insert(o.id);
            }
        }
        let (reqs, per_obj) = event_reqs(&g, &input.names);
        let open_match = g.objectives.iter().any(|o| !o.done && objective_modes(&o.text).is_some());
        if open_match || !marked.is_empty() {
            evs.push(Ev { g, marked, reqs, per_obj });
        }
    }
    evs.sort_by_key(|e| e.g.ends_at.unwrap_or(u64::MAX));
    let items: Vec<Item> = evs
        .iter()
        .enumerate()
        .flat_map(|(e, ev)| {
            ev.g.objectives.iter().enumerate().filter(|(_, o)| !o.done).filter_map(move |(k, o)| {
                let modes = objective_modes(&o.text)?;
                let (r, u) = &ev.per_obj[k];
                Some(Item { ev: e, obj: k, modes, req: r.map(|r| ev.reqs[r].clone()), unknown: u.clone() })
            })
        })
        .collect();
    let pl = Planner { input, prefs, club: &club, formations: &formations, links: &links, evs: &evs, items: &items, solved: Default::default() };

    // 2. sessions: the user's pick first (at the place they chose, else the best one for it), then
    // the most objectives with what's left
    let mut avail: Vec<usize> = (0..items.len()).collect();
    let mut sessions: Vec<(ComboPlan, Option<(usize, Pick)>)> = Vec::new();
    let primary = prefs.primary.filter(|p| evs.iter().any(|e| e.g.id == *p && items.iter().any(|i| evs[i.ev].g.id == *p)));
    let mut place_options: Vec<PlaceOption> = Vec::new();
    if let Some(p) = primary {
        let mine: Vec<usize> = avail.iter().copied().filter(|&i| evs[items[i].ev].g.id == p).collect();
        let mut places = pl.places(&mine);
        // "any mode" objectives can be played wherever the rest can
        if places == [Mode::Any] {
            places = pl.places(&avail);
            if !places.contains(&Mode::Any) {
                places.push(Mode::Any);
            }
        }
        place_options = places
            .iter()
            .filter(|m| mine.iter().any(|&i| plays_in(&items[i].modes, m)))
            .map(|m| PlaceOption { place: m.clone(), name: pl.place_name(m), objectives: avail.iter().filter(|&&i| plays_in(&items[i].modes, m)).count() })
            .collect();
        place_options.sort_by(|a, b| b.objectives.cmp(&a.objectives));
        let chosen: Vec<Mode> = match &prefs.place {
            Some(m) if place_options.iter().any(|o| &o.place == m) => vec![m.clone()],
            _ => place_options.iter().map(|o| o.place.clone()).collect(),
        };
        if let Some(s) = pl.best(&chosen, &avail, Some(p)) {
            avail.retain(|i| !s.0.items.iter().any(|x| x.counts && x.event == evs[items[*i].ev].g.id && x.objective == evs[items[*i].ev].g.objectives[items[*i].obj].id));
            sessions.push(s);
        }
    }
    while sessions.len() < MAX_SESSIONS && !avail.is_empty() {
        let places = pl.places(&avail);
        let Some(s) = pl.best(&places, &avail, None) else { break };
        if s.0.counted == 0 {
            // what no squad of the club can clear yet: one last session shows what to get
            if s.0.reqs.iter().any(|r| !r.met) && sessions.iter().all(|x| x.0.place != s.0.place || x.0.counted > 0) {
                sessions.push(s);
            }
            break;
        }
        avail.retain(|i| !s.0.items.iter().any(|x| x.counts && x.event == evs[items[*i].ev].g.id && x.objective == evs[items[*i].ev].g.objectives[items[*i].obj].id));
        sessions.push(s);
    }
    // what no squad clears yet is shown once, in the first session it belongs to
    let mut shown: BTreeSet<(u64, u64)> = BTreeSet::new();
    for (s, _) in sessions.iter_mut() {
        s.items.retain(|x| x.counts || shown.insert((x.event, x.objective)));
    }
    // what to get for the requirements a session's squad misses
    for (k, (s, _)) in sessions.iter_mut().enumerate() {
        s.id = k as u64 + 1;
        let Some(sq) = s.squad.clone() else { continue };
        let reqs: Vec<Req> = s.reqs.iter().map(|r| Req { need: r.need.clone(), count: r.count }).collect();
        for (r, view) in reqs.iter().zip(s.reqs.iter_mut()) {
            if !view.met {
                let (options, unpriced) = options_for(r, &sq, input, &owned_defs, &links, budget);
                view.options = options;
                view.unpriced = unpriced;
            }
        }
    }
    // events the first session can't play for (they need another place)
    let apart: Vec<Apart> = match sessions.first() {
        Some((s, _)) => evs
            .iter()
            .enumerate()
            .filter(|(e, _)| items.iter().any(|i| i.ev == *e) && !items.iter().any(|i| i.ev == *e && plays_in(&i.modes, &s.place)))
            .map(|(e, ev)| {
                let mut places: Vec<String> = Vec::new();
                for i in items.iter().filter(|i| i.ev == e) {
                    for m in &i.modes {
                        let n = pl.place_name(m);
                        if !places.contains(&n) {
                            places.push(n);
                        }
                    }
                }
                Apart { event: ev.g.id, title: ev.g.title.clone(), places }
            })
            .collect(),
        None => Vec::new(),
    };

    // 3. each event shows the session that moves it on most
    let events = evs
        .iter()
        .map(|ev| {
            let objectives = ev
                .g
                .objectives
                .iter()
                .zip(&ev.per_obj)
                .map(|(o, (r, u))| ObjectiveView { id: o.id, marked: ev.marked.contains(&o.id), name: o.name.clone(), text: o.text.clone(), progress: o.progress.min(o.target), target: o.target, done: o.done, req: *r, unknown: u.clone() })
                .collect();
            let best = sessions
                .iter()
                .filter(|(s, _)| s.items.iter().any(|x| x.event == ev.g.id))
                .max_by(|a, b| {
                    let n = |s: &ComboPlan| s.items.iter().filter(|x| x.event == ev.g.id && x.counts).count();
                    n(&a.0).cmp(&n(&b.0)).then(b.0.id.cmp(&a.0.id))
                });
            let (combo, squad, mut reqs) = match best {
                Some((s, Some((fi, pick)))) if !ev.reqs.is_empty() => {
                    let (sq, rv) = squad_view(&club, &formations[*fi], pick, &ev.reqs, prefs, input, &links);
                    (Some(s.id), Some(sq), rv)
                }
                Some((s, _)) => (Some(s.id), None, ev.reqs.iter().map(|r| ReqView { need: r.need.clone(), name: need_name(&r.need, &input.names), count: r.count, have: 0, met: false, players: vec![], options: vec![], unpriced: 0 }).collect()),
                None => (None, None, ev.reqs.iter().map(|r| ReqView { need: r.need.clone(), name: need_name(&r.need, &input.names), count: r.count, have: 0, met: false, players: vec![], options: vec![], unpriced: 0 }).collect()),
            };
            if let Some(sq) = &squad {
                for (k, r) in ev.reqs.iter().enumerate() {
                    if !reqs[k].met {
                        let (options, unpriced) = options_for(r, sq, input, &owned_defs, &links, budget);
                        reqs[k].options = options;
                        reqs[k].unpriced = unpriced;
                    }
                }
            }
            let done = ev.g.objectives.iter().filter(|o| o.done).count();
            EventPlan { id: ev.g.id, title: ev.g.title.clone(), ends_at: ev.g.ends_at, done, total: ev.g.objectives.len(), objectives, reqs, squad, combo }
        })
        .collect();
    SquadsView {
        events,
        combos: sessions.into_iter().map(|(c, _)| c).collect(),
        apart,
        places: place_options,
        primary,
        needs_sync: input.groups.is_empty(),
        names_missing: !input.names_known,
        club_players: input.club.iter().filter(|p| !p.positions.is_empty()).count(),
        coins: input.coins,
        read_at: input.read_at,
        prefs: shown_prefs,
        club: {
            let mut c: Vec<ClubEntry> = input
                .club
                .iter()
                .filter(|p| !p.positions.is_empty())
                .map(|p| ClubEntry { key: p.key, name: p.name.clone(), rating: p.rating, positions: p.positions.clone(), nation: p.nation, nation_name: input.names.nations.get(&p.nation).cloned(), loan: p.loan, owned: true, price: None })
                .collect();
            // the cards to get the user picked, so their chips have a name
            for &def in &prefs.must_cards {
                if let Some(p) = input.catalog.iter().find(|c| c.def_id == def) {
                    if !c.iter().any(|x| x.key == def) {
                        c.push(ClubEntry { key: def, name: p.name.clone(), rating: p.rating, positions: p.positions.clone(), nation: p.nation, nation_name: input.names.nations.get(&p.nation).cloned(), loan: false, owned: false, price: fresh_price(input, def) });
                    }
                }
            }
            c.sort_by(|a, b| b.rating.cmp(&a.rating).then_with(|| a.name.cmp(&b.name)));
            c
        },
    }
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// EA's quality tier by OVR: 2 gold (75+), 1 silver (65–74), 0 bronze.
fn tier(rating: u32) -> u8 {
    match rating {
        75.. => 2,
        65..=74 => 1,
        _ => 0,
    }
}

/// The card's pace: EA's PAC from the in-game attributes (45 % acceleration, 55 % sprint speed),
/// else the face stat; none when neither is known.
fn pace(p: &Player) -> Option<f64> {
    if let Some(s) = p.stats.as_ref() {
        if let (Some(&a), Some(&sp)) = (s.get("acceleration"), s.get("sprintspeed")) {
            return Some(0.45 * a as f64 + 0.55 * sp as f64);
        }
    }
    p.face.map(|f| f[0] as f64)
}

/// How a card to buy ranks for a slot (the "meta" view the rating sites take): the FC-Tracker
/// rating (attributes for the position, PlayStyles, AcceleRATE, height …), less a penalty for very
/// low pace where pace wins matches – forwards, wingers and attacking mids below 70 PAC (0.4 a
/// point), full-backs below 65 (0.3 a point). No pace known → just the rating (as before).
fn buy_score(p: &Player, pos: &str) -> f64 {
    let s = strength(p, pos);
    let (floor, per) = match pos {
        "ST" | "LW" | "RW" | "LM" | "RM" | "CAM" => (70.0, 0.4),
        "LB" | "RB" | "LWB" | "RWB" => (65.0, 0.3),
        _ => return s,
    };
    s - pace(p).map_or(0.0, |v| (floor - v).max(0.0) * per)
}

/// A card to buy for a slot: price, rank score (`buy_score`), the card, the slot, its rating there.
struct Buy<'a> {
    price: u64,
    score: f64,
    p: &'a Player,
    pos: String,
    strength: f64,
}

/// Realistic cards for a requirement the squad misses (SQUADS.md D): the slot they'd take is the
/// one whose card counts for nothing else and is weakest; cards from objectives in progress and
/// SBCs first, then buys with a recent EA price within the budget – the cheapest that works, the
/// best value (nearly as cheap), and the best upgrade if it's still in reach.
///
/// Buys are ranked the way the rating sites rank cards – by how well they play the slot
/// (`buy_score`), not by OVR or price alone (user 2026-10-30: no silver or slow, bad gold just
/// because it ticks the box cheaply):
/// 1. Quality: only the best tier that ticks the requirement – gold if any gold card does, silver
///    only when no gold does, bronze only when nothing better does.
/// 2. Level: a card must play within 4 of the card it replaces and within 6 of the best card in
///    the cheap band (≤ 3× the cheapest, or +2K) – a far worse card at a similar price is dropped.
/// 3. "Cheapest that works" = the best-playing card that costs at most the cheapest + 25 % (at
///    least +1K coins): a bit dearer but better wins when the difference is small.
/// 4. "Best value" (≤ 3× / +2K) and "Best upgrade" (≤ 10× / +10K) as before, on the same score.
///
/// Ties go to the cheaper card, then the lower card id, so the result is deterministic.
fn options_for(r: &Req, sq: &SquadView, input: &Input, owned: &BTreeSet<u64>, links: &BTreeMap<u64, u64>, budget: Option<u64>) -> (Vec<GetOption>, usize) {
    // slots a new card could take: not counting for any requirement, weakest first
    let mut free: Vec<&SlotView> = sq.slots.iter().filter(|s| s.counts_for.is_empty()).collect();
    free.sort_by(|a, b| a.strength.total_cmp(&b.strength));
    // the slot a card would take (the weakest free one it can play) and how strong that card is
    let fits = |p: &Player| free.iter().find(|s| p.positions.iter().any(|x| *x == s.pos)).map(|s| (s.pos.clone(), s.strength));
    let mut out: Vec<GetOption> = Vec::new();
    let mut seen: BTreeSet<(String, u64)> = BTreeSet::new();
    let mut priced: Vec<Buy> = Vec::new();
    let mut unpriced = 0;
    for p in &input.catalog {
        if owned.contains(&p.def_id) || !r.need.met_by(p, links) {
            continue;
        }
        let Some((pos, replaced)) = fits(p) else { continue };
        if let Some(src) = input.rewards.get(&p.def_id).and_then(|v| v.first()) {
            if seen.insert(p.person()) {
                out.push(GetOption { kind: if src.0 == "sbc" { "sbc".into() } else { "reward".into() }, name: p.name.clone(), def_id: p.def_id, rating: p.rating, pos: pos.clone(), price: None, source: Some(src.1.clone()), strength: round1(strength(p, &pos)), nation: p.nation, nation_name: input.names.nations.get(&p.nation).cloned() });
            }
            continue;
        }
        match fresh_price(input, p.def_id) {
            Some(c) if budget.is_none_or(|b| c <= b) => {
                // realistic: about as strong as the card it replaces – a bronze ticks the box but loses matches
                let score = buy_score(p, &pos);
                if score >= replaced - 4.0 {
                    priced.push(Buy { price: c, score, p, strength: strength(p, &pos), pos });
                }
            }
            Some(_) => {}
            None => unpriced += 1,
        }
    }
    out.truncate(2);
    // 1. only the best quality tier that ticks the requirement
    if let Some(top) = priced.iter().map(|b| tier(b.p.rating)).max() {
        priced.retain(|b| tier(b.p.rating) == top);
    }
    priced.sort_by(|a, b| a.price.cmp(&b.price).then(b.score.total_cmp(&a.score)).then(a.p.def_id.cmp(&b.p.def_id)));
    // the better of two cards: higher score, then cheaper, then the lower id
    let better = |a: &&Buy, b: &&Buy| a.score.total_cmp(&b.score).then(b.price.cmp(&a.price)).then(b.p.def_id.cmp(&a.p.def_id));
    let Some(c0) = priced.first().map(|b| b.price) else { return (out, unpriced) };
    // 2. nothing far below the best card in the cheap band
    let cap = c0.saturating_mul(3).max(c0 + 2_000);
    let best = priced.iter().filter(|b| b.price <= cap).map(|b| b.score).fold(f64::MIN, f64::max);
    priced.retain(|b| b.score >= best - 6.0);
    let push = |kind: &str, c: &Buy, out: &mut Vec<GetOption>| {
        if out.iter().any(|o| o.def_id == c.p.def_id) {
            return;
        }
        out.push(GetOption { kind: kind.into(), name: c.p.name.clone(), def_id: c.p.def_id, rating: c.p.rating, pos: c.pos.clone(), price: Some(c.price), source: None, strength: round1(c.strength), nation: c.p.nation, nation_name: input.names.nations.get(&c.p.nation).cloned() });
    };
    // 3. the cheapest that works: the best card within +25 % (at least +1K) of the lowest price
    let c0 = priced.first().map_or(c0, |b| b.price);
    let near = c0.saturating_add((c0 / 4).max(1_000));
    let Some(cheapest) = priced.iter().filter(|b| b.price <= near).max_by(better) else { return (out, unpriced) };
    push("cheapest", cheapest, &mut out);
    // best value: the strongest card at most 3× the cheapest (never the Pelé for one Brazilian)
    let cap = c0.saturating_mul(3).max(c0 + 2_000);
    if let Some(v) = priced.iter().filter(|b| b.price <= cap).max_by(better) {
        if v.p.def_id != cheapest.p.def_id && v.score > cheapest.score + 0.5 {
            push("value", v, &mut out);
        }
    }
    // best upgrade: clearly stronger, still at most 10× the cheapest and within budget
    let ucap = c0.saturating_mul(10).max(c0 + 10_000);
    if let Some(u) = priced.iter().filter(|b| b.price <= ucap).max_by(better) {
        if out.iter().all(|o| o.strength + 1.0 < u.strength) {
            push("upgrade", u, &mut out);
        }
    }
    (out, unpriced)
}

// ---------- building the input from EA's data ----------

/// A club item → a squad player (positions and face stats come from the raw club data, the
/// in-game attributes from the player bio's data).
pub fn club_player(item: &crate::types::Item, catalog: &BTreeMap<u64, crate::types::GalleryCard>, attrs: &Attributes) -> Option<Player> {
    if item.item_type.as_deref().is_some_and(|t| t != "player") {
        return None;
    }
    let play = item.play.as_ref();
    let def_id = play.and_then(|p| p.def_id).or(item.asset_id).unwrap_or(0);
    // a card from a dream squad or an opponent's squad carries its card id as item id: not owned
    if Some(item.id) == item.asset_id || item.id == def_id {
        return None;
    }
    let card = catalog.get(&def_id);
    let positions = play.map(|p| p.positions.clone()).filter(|v| !v.is_empty()).or_else(|| card.map(|c| c.positions.clone()).filter(|v| !v.is_empty())).unwrap_or_default();
    let face = play
        .filter(|p| p.face.len() == 6)
        .map(|p| std::array::from_fn(|i| p.face[i] as u32))
        .or_else(|| card.filter(|c| c.face.len() == 6).map(|c| std::array::from_fn(|i| c.face[i] as u32)));
    Some(Player {
        key: item.id,
        def_id,
        // EA names some cards "---" (no licence): the club stands in
        name: item.name.clone().or_else(|| card.and_then(|c| c.name.clone())).filter(|n| n.chars().any(char::is_alphanumeric)).or_else(|| card.and_then(|c| c.team_name.clone())).unwrap_or_default(),
        rating: item.rating.or(card.and_then(|c| c.rating)).unwrap_or(0) as u32,
        positions,
        league: item.league_id.or(card.and_then(|c| c.league)).unwrap_or(0),
        club: item.team_id.or(card.and_then(|c| c.team)).unwrap_or(0),
        nation: item.nation_id.or(card.and_then(|c| c.nation)).unwrap_or(0),
        rareflag: item.rareflag.or(card.and_then(|c| c.rareflag)).unwrap_or(0),
        face,
        stats: attrs.cards.get(&def_id).map(|c| c.0.clone()).filter(|s| !s.is_empty()),
        height: attrs.cards.get(&def_id).and_then(|c| c.1),
        playstyles: play
            .map(|p| {
                let base = p.ps.iter().filter(|id| !p.ps_plus.contains(id)).filter_map(|&id| attrs.trait_name(id).map(|n| (n, false)));
                let plus = p.ps_plus.iter().filter_map(|&id| attrs.trait_name(id).map(|n| (n, true)));
                base.chain(plus).collect()
            })
            .unwrap_or_default(),
        ps_plus: play.map(|p| p.ps_plus.len() as u32).unwrap_or(0),
        roles_pp: play.map(|p| p.roles_pp.len() as u32).unwrap_or(0),
        weak_foot: play.and_then(|p| p.weak_foot).or(card.and_then(|c| c.weak_foot)).unwrap_or(3) as u32,
        skill_moves: play.and_then(|p| p.skill_moves).or(card.and_then(|c| c.skill_moves)).unwrap_or(3) as u32,
        loan: play.and_then(|p| p.loans).is_some(),
        foot: play.and_then(|p| p.foot).unwrap_or(0) as u8,
        owned: true,
    })
}

/// A catalog card → a candidate to get.
pub fn catalog_player(c: &crate::types::GalleryCard, attrs: &Attributes) -> Option<Player> {
    let positions = if c.positions.is_empty() { c.position.clone().into_iter().collect() } else { c.positions.clone() };
    if positions.is_empty() || positions.iter().any(|p| p == "GK") && positions.len() == 1 && c.rating.is_none() {
        return None;
    }
    Some(Player {
        key: c.def_id,
        def_id: c.def_id,
        name: c.name.clone().unwrap_or_default(),
        rating: c.rating.unwrap_or(0) as u32,
        positions,
        league: c.league.unwrap_or(0),
        club: c.team.unwrap_or(0),
        nation: c.nation.unwrap_or(0),
        rareflag: c.rareflag.unwrap_or(0),
        face: (c.face.len() == 6).then(|| std::array::from_fn(|i| c.face[i] as u32)),
        stats: attrs.cards.get(&c.def_id).map(|x| x.0.clone()).filter(|s| !s.is_empty()),
        height: attrs.cards.get(&c.def_id).and_then(|x| x.1),
        playstyles: Vec::new(),
        ps_plus: 0,
        roles_pp: 0,
        weak_foot: c.weak_foot.unwrap_or(3) as u32,
        skill_moves: c.skill_moves.unwrap_or(3) as u32,
        foot: 0,
        loan: false,
        owned: false,
    })
}

/// Item ids of the active squad (`/usermassinfo` → `squad.players[].itemData.id`).
/// The active squad's formation (EA's name).
pub fn active_formation(usermassinfo: &Value) -> Option<String> {
    usermassinfo.pointer("/squad/formation").and_then(Value::as_str).map(str::to_string)
}

pub fn active_squad(usermassinfo: &Value) -> BTreeSet<u64> {
    usermassinfo
        .pointer("/squad/players")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(11)
        .filter_map(|p| p.pointer("/itemData/id").and_then(Value::as_u64))
        .filter(|&id| id > 0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn names() -> Names {
        Names::from_value(&json!({
            "leagues": { "13": ["Premier League", "Premier League"], "16": ["Ligue 1 McDonald's", "Ligue 1"], "31": ["Serie A Enilive", "Serie A"], "19": ["Bundesliga", "Bundesliga"], "53": ["LALIGA EA SPORTS", "LALIGA"], "10": ["Eredivisie", "Eredivisie"] },
            "nations": { "18": "France", "14": "England", "34": "Netherlands", "7": "Belgium", "54": "Brazil" },
            "teams": { "243": { "names": ["Real Madrid", "RMA"], "league": 53 }, "21": { "names": ["FC Bayern", "FCB"], "league": 19 }, "73": { "names": ["Paris SG", "PSG"], "league": 16 }, "1": { "names": ["Arsenal", "ARS"], "league": 13 } }
        }))
    }

    #[test]
    fn ea_objective_texts_become_requirements() {
        let n = names();
        let p = |t: &str| parse_requirement(t, &n);
        assert_eq!(p("Win 2 matches while having Min. 3 Premier League players in your starting 11 in the FC Heritage Circuit Professional Event."), Parsed::Squad(Req { need: Need::League(13), count: 3 }));
        assert_eq!(p("Score at least 3 goals in one match while having Min. 1 French player in your starting 11 in the FC Heritage Circuit Professional Event."), Parsed::Squad(Req { need: Need::Nation(18), count: 1 }));
        assert_eq!(p("Score at least 1 goal in 3 separate matches while having Min. 1 Real Madrid (LALIGA) player item in your starting 11"), Parsed::Squad(Req { need: Need::Club(243), count: 1 }));
        assert_eq!(p("Score 5 goals while having Min. 1 FC Bayern München (Bundesliga) player item in your starting 11"), Parsed::Squad(Req { need: Need::Club(21), count: 1 }));
        assert_eq!(p("Assist 4 goals while having Min. 1 PSG (Ligue 1) player item in your starting 11"), Parsed::Squad(Req { need: Need::Club(73), count: 1 }));
        assert_eq!(p("Win 2 matches while having Min. 2 Ligue 1 players in your starting 11 in the FC Heritage Circuit Tournament."), Parsed::Squad(Req { need: Need::League(16), count: 2 }));
        assert_eq!(p("Win 1 Quarter-Finals match while having Min. 2 Serie A players in your starting 11"), Parsed::Squad(Req { need: Need::League(31), count: 2 }));
        assert_eq!(p("Assist at least 1 goal in 3 separate matches while having Min. 1 Dutch player in your starting 11"), Parsed::Squad(Req { need: Need::Nation(34), count: 1 }));
        assert_eq!(p("Win 3 matches while having Min. 3 player items from Bundesliga in your starting 11"), Parsed::Squad(Req { need: Need::League(19), count: 3 }));
        assert_eq!(p("Play 10 matches in the Season 2 Daily Knockout Tournament."), Parsed::None);
        assert_eq!(p("Score at least 1 goal in 50 separate matches in the Season 2 Daily Knockout Tournament."), Parsed::None);
        assert_eq!(p("Win 1 match while having Min. 2 Icons in your starting 11"), Parsed::Squad(Req { need: Need::Icon, count: 2 }));
        assert!(matches!(p("Win 1 match while having Min. 1 Atlantean player in your starting 11"), Parsed::Unknown(_)));
    }

    /// Distinct names (normalised names drop digits).
    fn letters(k: u64) -> String {
        let (a, b) = ((k / 26) as u8, (k % 26) as u8);
        format!("Player {}{}", (b'a' + a) as char, (b'a' + b) as char)
    }

    fn pl(key: u64, name: &str, rating: u32, pos: &[&str], league: u64, club: u64, nation: u64) -> Player {
        Player { key, def_id: key, name: name.into(), rating, positions: pos.iter().map(|s| s.to_string()).collect(), league, club, nation, weak_foot: 3, skill_moves: 3, owned: true, ..Default::default() }
    }

    #[test]
    fn the_rating_reads_the_web_apps_attributes_by_name() {
        // the Web App's enums give the order: index → name, id → PlayStyle
        let attrs = Attributes::from_value(&json!({
            "names": { "0": "acceleration", "1": "agility", "2": "strength", "3": "marking", "4": "standingtackle", "5": "interceptions" },
            "traits": { "7": "INTERCEPTER", "9": "FINESSE_SHOT" },
            "cards": { "1": { "a": [70, 60, 85, 90, 91, 89], "h": 191 }, "2": { "a": [95, 92, 60, 30, 32, 35], "h": 172 } }
        }));
        let card = |id: u64, ps: &[u64]| {
            let mut p = pl(id, &letters(id), 85, &["CB", "ST"], 13, 1, 14);
            p.stats = attrs.cards.get(&id).map(|c| {
                let mut s = c.0.clone();
                // the rest of the 29 at a neutral 70
                for k in ["sprintspeed", "balance", "jumping", "stamina", "reactions", "aggression", "composure", "positioning", "vision", "ballcontrol", "crossing", "dribbling", "finishing", "headingaccuracy", "shortpassing", "longpassing", "shotpower", "longshots", "slidingtackle", "volleys"] {
                    s.entry(k.to_string()).or_insert(70);
                }
                s
            });
            p.height = attrs.cards.get(&id).and_then(|c| c.1);
            p.playstyles = ps.iter().filter_map(|&i| attrs.trait_name(i).map(|n| (n, false))).collect();
            p
        };
        let defender = card(1, &[7]);
        let runner = card(2, &[9]);
        assert_eq!(accelerate(&defender), Some("lengthy"));
        assert_eq!(accelerate(&runner), Some("explosive"));
        assert!(strength(&defender, "CB") > strength(&runner, "CB") + 5.0);
        assert!(strength(&runner, "ST") > strength(&runner, "CB"));
    }

    #[test]
    fn has_to_include_plays_even_when_weaker() {
        let mut club = Vec::new();
        let mut k = 0;
        for (pos, n) in [("GK", 1), ("CB", 2), ("RB", 1), ("LB", 1), ("CM", 3), ("RW", 1), ("LW", 1), ("ST", 2)] {
            for _ in 0..n {
                k += 1;
                club.push(pl(k, &letters(k), 88, &[pos], 13, 1, 14));
            }
        }
        // two weak favourites the user wants to play with
        club.push(pl(90, "Mc Geady", 70, &["RW", "RM"], 13, 2, 30));
        club.push(pl(91, "Bonmati", 72, &["CM", "CAM"], 53, 3, 45));
        let prefs = SquadPrefs { must: vec![90, 91], ..Default::default() };
        let (_, pick) = solve(&club, &[Req { need: Need::League(13), count: 3 }], &builtin_formations(), &prefs, &BTreeMap::new(), &BTreeSet::new(), None).unwrap();
        let keys: Vec<u64> = pick.slots.iter().flatten().map(|&i| club[i].key).collect();
        assert!(keys.contains(&90) && keys.contains(&91), "both favourites play");
        assert_eq!(keys.len(), 11);
    }

    #[test]
    fn chemistry_follows_eas_thresholds() {
        let links = BTreeMap::new();
        let a = pl(1, "A", 80, &["ST"], 13, 1, 14);
        let b = pl(2, "B", 80, &["ST"], 13, 1, 14);
        let c = pl(3, "C", 80, &["ST"], 13, 5, 18);
        // two from one club, three from one league, two English
        let chem = chemistry(&[&a, &b, &c], &links);
        assert_eq!(chem, vec![3, 3, 1]);
        let icon = Player { league: ICON_LEAGUE, ..pl(4, "I", 90, &["CM"], ICON_LEAGUE, 9, 18) };
        let chem = chemistry(&[&c, &icon], &links);
        assert_eq!(chem, vec![1, 3], "an Icon counts twice for France");
    }

    #[test]
    fn the_squad_meets_every_requirement_it_can_and_names_the_rest() {
        let mut club = Vec::new();
        let positions = [("GK", 2), ("CB", 4), ("RB", 2), ("LB", 2), ("CM", 4), ("CDM", 2), ("CAM", 2), ("RW", 2), ("LW", 2), ("ST", 3)];
        let mut k = 0;
        for (pos, n) in positions {
            for _ in 0..n {
                k += 1;
                // strong cards from league 1, nation 1
                club.push(pl(k, &letters(k), 88, &[pos], 1, 100 + k, 1));
            }
        }
        // weaker cards that tick requirements: three Premier League (13), one French (18)
        club.push(pl(100, "PL CB", 80, &["CB"], 13, 1, 14));
        club.push(pl(101, "PL ST", 80, &["ST"], 13, 2, 14));
        club.push(pl(102, "PL CM", 79, &["CM"], 13, 3, 14));
        club.push(pl(103, "French LB", 78, &["LB"], 16, 73, 18));
        let reqs = vec![Req { need: Need::League(13), count: 3 }, Req { need: Need::Nation(18), count: 1 }, Req { need: Need::Nation(7), count: 1 }];
        let prefs = SquadPrefs { chem_target: 0, ..Default::default() };
        let (fi, pick) = solve(&club, &reqs, &builtin_formations(), &prefs, &BTreeMap::new(), &BTreeSet::new(), None).unwrap();
        let f = &builtin_formations()[fi];
        let xi: Vec<&Player> = pick.slots.iter().flatten().map(|&i| &club[i]).collect();
        assert_eq!(xi.len(), 11);
        for (s, pos) in pick.slots.iter().zip(&f.slots) {
            assert!(club[s.unwrap()].positions.contains(pos));
        }
        assert_eq!(xi.iter().filter(|p| p.league == 13).count(), 3, "3 Premier League");
        assert!(xi.iter().any(|p| p.nation == 18), "a French player");
        // no Belgian in the club: as good as possible, not "no squad"
        assert!(xi.iter().all(|p| p.nation != 7));
    }

    /// A squad whose only free slot (counting for no requirement) is a striker of this strength.
    fn squad_with_free_st(strength: f64) -> SquadView {
        let slot = SlotView {
            pos: "ST".into(), name: "Owned ST".into(), def_id: 9_999, rating: 80, chem: 3, strength, loan: false, counts_for: vec![], accel: None, key_ps: 0, key_ps_plus: 0,
            full: false, nation: 1, nation_name: None, foot: 0, weak_foot: 3, skill_moves: 3, must: false, owned: true, price: None,
        };
        SquadView { formation: "4-3-3".into(), chem: 30, chem_target: 33, slots: vec![slot], strength, met: 0, changes: None, must_missing: vec![] }
    }

    /// A striker to buy: PAC SHO PAS DRI DEF PHY.
    fn st(key: u64, rating: u32, league: u64, face: [u32; 6]) -> Player {
        Player { owned: false, face: Some(face), ..pl(key, &letters(key), rating, &["ST"], league, 200 + key, 30) }
    }

    #[test]
    fn where_an_objective_counts_decides_what_plays_together() {
        let m = |t: &str| objective_modes(t);
        let ghoul = m("Score at least 1 goal in 13 separate matches in the Ghoul Fest Live Event.").unwrap();
        assert_eq!(ghoul, vec![Mode::Event("ghoul fest".into())]);
        let heritage = m("Win 3 matches while having Min. 3 player items from Bundesliga in your starting 11 in the FC Heritage Circuit World Class Event.").unwrap();
        assert_eq!(heritage, vec![Mode::Event("fc heritage circuit world class event".into())]);
        assert_eq!(m("Win the Season 2 Daily Knockout Tournament five times.").unwrap(), vec![Mode::Event("season 2 daily knockout tournament".into())]);
        let phantom = m("Score 10 headers while having Min. 1 USA player in your starting XI in Squad Battles on Min. Semi-Pro difficulty (or Rivals/Live Events/Rush/Champions).").unwrap();
        let any = m("Win 3 matches in any FUT game mode while having min. 1 player from Bundesliga in your starting 11.").unwrap();
        assert_eq!(any, vec![Mode::Any]);
        // not played in a match: never part of a session
        for t in ["Complete 3 Squad Building Challenge groups.", "Buy 10 Player Items using Buy Now in the Transfer Market.", "Achieve S Rank in the Ultimate Scream Gallery Set.", "Complete the Season 2 Daily Knockout Tournament Weekly Play Objective 5 times.", "Build 20+ Chemistry in your squad."] {
            assert_eq!(m(t), None, "{t}");
        }
        assert_eq!(m("Play 50 Co-Op matches.").unwrap(), vec![Mode::CoOp]);
        let ghoul_fest = Mode::Event("ghoul fest".into());
        let world_class = Mode::Event("fc heritage circuit world class event".into());
        // Ghoul Fest + Phantom Playgrounds (any live event) + "any mode" play together …
        assert!(plays_in(&ghoul, &ghoul_fest) && plays_in(&phantom, &ghoul_fest) && plays_in(&any, &ghoul_fest));
        // … Ghoul Fest and an FC Heritage event never
        assert!(!plays_in(&heritage, &ghoul_fest) && !plays_in(&ghoul, &world_class));
        assert!(plays_in(&phantom, &world_class) && plays_in(&phantom, &Mode::SquadBattles) && !plays_in(&ghoul, &Mode::SquadBattles));
        // a drafted squad is not the user's
        assert!(!plays_in(&any, &Mode::Draft));
    }

    #[test]
    fn every_kind_of_squad_requirement_is_read() {
        let mut n = names();
        n.nations.insert(95, "United States".into());
        n.nations.insert(21, "Germany".into());
        n.nations.insert(83, "Mexico".into());
        n.rarities.insert(160, "Ultimate Scream".into());
        n.rarities.insert(161, "Future Stars Academy".into());
        let p = |t: &str| parse_requirement(t, &n);
        let sq = |need, count| Parsed::Squad(Req { need, count });
        assert_eq!(p("Score at least 1 goal from outside the box in 10 separate matches with 4* or higher WF players in Squad Battles"), sq(Need::WeakFoot(4), 1));
        assert_eq!(p("Score 5 skill move goals with 5* skill move players"), sq(Need::SkillMoves(5), 1));
        assert_eq!(p("Win 3 matches with 30+ Chemistry in any FUT game mode"), sq(Need::Chemistry(30), 1));
        assert_eq!(p("Score 3 goals with a player with Lengthy AcceleRATE"), sq(Need::Accel("lengthy".into()), 1));
        assert_eq!(p("Score 2 goals with a player with the Finesse Shot+ PlayStyle"), sq(Need::PlayStyle("finesse shot".into(), true), 1));
        assert_eq!(p("Play 3 matches in any Football Ultimate Team game mode while having at least 2 players from USA in your starting 11."), sq(Need::Nation(95), 2));
        assert_eq!(p("Play 1 match with 3 Mexican players in your starting XI in any FUT game mode."), sq(Need::Nation(83), 3));
        assert_eq!(p("Score 10 goals in any FUT game mode using a player from Germany."), sq(Need::Nation(21), 1));
        assert_eq!(p("Score 4 goals in any FUT game mode with a Player Item from Bundesliga."), sq(Need::League(19), 1));
        assert_eq!(p("Play 10 matches while having min. 1 Future Stars Academy player in your starting XI in Squad Battles"), sq(Need::Rarity(161), 1));
        assert_eq!(p("Score 50 goals while having Min. 1 Ultimate Scream Player in your starting XI"), sq(Need::Rarity(160), 1));
        assert_eq!(p("Score at least 1 goal with a Future Stars Academy player in Squad Battles"), sq(Need::Rarity(161), 1));
        // no requirement hides in these
        for t in ["Play 3 matches with the Mexico National team Away kit equipped in any FUT game mode.", "Score at least one Chip Shot goal in 5 separate matches", "Win 10 matches in Squad Battles on min. Semi-Pro difficulty (or Rivals/Champions/Live Events/Rush)."] {
            assert_eq!(p(t), Parsed::None, "{t}");
        }
    }

    #[test]
    fn a_hand_mark_counts_until_a_newer_sync_says_otherwise() {
        let mut input = Input::empty();
        input.read_at = Some(1_000);
        input.groups = vec![Group {
            id: 7,
            title: "Event".into(),
            ends_at: None,
            objectives: vec![Objective { id: 1, name: "A".into(), text: "Win 1 match with min. 2 85+ rated players in your starting 11".into(), progress: 0, target: 1, done: false }],
        }];
        let obj = |p: &SquadPrefs| plan(&input, p).events[0].objectives[0].clone();
        // marked done after the last read: done, and its squad part drops out
        let mark = |at| SquadPrefs { done_marks: vec![DoneMark { group: 7, objective: 1, done: true, at }], ..SquadPrefs::default() };
        let o = obj(&mark(2_000));
        assert!(o.done && o.marked && o.req.is_none());
        assert_eq!(plan(&input, &mark(2_000)).prefs.done_marks.len(), 1);
        // a sync after the mark (EA says not done): the mark no longer counts and is dropped
        let o = obj(&mark(500));
        assert!(!o.done && !o.marked && o.req.is_some());
        assert!(plan(&input, &mark(500)).prefs.done_marks.is_empty());
    }

    fn market(cards: Vec<Player>, prices: &[(u64, u64)]) -> Input {
        let mut input = Input::empty();
        input.catalog = cards;
        input.now_ms = 10 * 24 * 3600 * 1000;
        for &(def, coins) in prices {
            input.prices.insert(def, Price { bin: 0, listings: 5, at: input.now_ms, avg: Some(coins), shared: false });
        }
        input
    }

    #[test]
    fn buys_are_ranked_by_how_they_play_not_by_the_lowest_price() {
        // a Premier League (13) player is missing; the striker slot is free
        let silver = st(1, 72, 13, [80, 70, 60, 72, 30, 70]);
        let slow_gold = st(2, 76, 13, [60, 75, 60, 70, 30, 80]);
        let good_gold = st(3, 78, 13, [88, 77, 65, 78, 35, 72]);
        let input = market(vec![silver, slow_gold, good_gold], &[(1, 300), (2, 400), (3, 700)]);
        let req = Req { need: Need::League(13), count: 1 };
        let (opts, unpriced) = options_for(&req, &squad_with_free_st(74.0), &input, &BTreeSet::new(), &BTreeMap::new(), None);
        assert_eq!(unpriced, 0);
        assert_eq!(opts.first().map(|o| (o.kind.as_str(), o.def_id)), Some(("cheapest", 3)), "the sensible gold, 400 coins dearer: {opts:?}");
        assert!(opts.iter().all(|o| o.def_id != 1), "no silver when a gold ticks it");
        assert!(opts.iter().all(|o| o.def_id != 2), "no slow, weak gold");
        // a decent gold at half the price of a better one: the dearer one is too far up to be the
        // "cheapest that works" (more than +25 %), but it is the better value
        let input = market(vec![st(4, 77, 13, [82, 76, 62, 76, 35, 72]), st(3, 78, 13, [88, 77, 65, 78, 35, 72])], &[(4, 20_000), (3, 40_000)]);
        let (opts, _) = options_for(&req, &squad_with_free_st(70.0), &input, &BTreeSet::new(), &BTreeMap::new(), None);
        assert_eq!(opts.iter().map(|o| (o.kind.as_str(), o.def_id)).collect::<Vec<_>>(), vec![("cheapest", 4), ("value", 3)]);
    }

    #[test]
    fn silver_is_suggested_when_only_silver_ticks_it() {
        // a lower league (50) without gold cards: its silver plays, bronze doesn't
        let silver = st(1, 70, 50, [80, 70, 60, 72, 30, 70]);
        let bronze = st(2, 60, 50, [70, 55, 50, 60, 30, 60]);
        let input = market(vec![silver, bronze], &[(1, 500), (2, 200)]);
        let req = Req { need: Need::League(50), count: 1 };
        let (opts, _) = options_for(&req, &squad_with_free_st(66.0), &input, &BTreeSet::new(), &BTreeMap::new(), None);
        assert_eq!(opts.iter().map(|o| (o.kind.as_str(), o.def_id)).collect::<Vec<_>>(), vec![("cheapest", 1)]);
    }

    #[test]
    fn no_recent_price_no_buy() {
        // no price, and a price older than 3 days: counted as "price unknown", never suggested
        let mut input = market(vec![st(1, 80, 13, [85, 80, 70, 80, 35, 75]), st(2, 81, 13, [86, 81, 70, 80, 35, 75])], &[(2, 900)]);
        input.prices.get_mut(&2).unwrap().at = 0;
        let req = Req { need: Need::League(13), count: 1 };
        let (opts, unpriced) = options_for(&req, &squad_with_free_st(74.0), &input, &BTreeSet::new(), &BTreeMap::new(), None);
        assert!(opts.is_empty(), "{opts:?}");
        assert_eq!(unpriced, 2);
        // no stats at all (no face, no attributes): the OVR stands in, as before
        let input = market(vec![Player { face: None, ..st(3, 80, 13, [0; 6]) }], &[(3, 900)]);
        let (opts, _) = options_for(&req, &squad_with_free_st(74.0), &input, &BTreeSet::new(), &BTreeMap::new(), None);
        assert_eq!(opts.iter().map(|o| o.def_id).collect::<Vec<_>>(), vec![3]);
    }

    #[test]
    fn the_chemistry_target_decides_when_it_comes_first() {
        // one requirement that costs chemistry: a lone Ligue 1 player among a Premier League side
        let mut club = Vec::new();
        let mut k = 0;
        for (pos, n) in [("GK", 1), ("CB", 2), ("RB", 1), ("LB", 1), ("CM", 3), ("RW", 1), ("LW", 1), ("ST", 2)] {
            for _ in 0..n {
                k += 1;
                club.push(pl(k, &letters(k), 85, &[pos], 13, 1, 14));
            }
        }
        club.push(pl(50, "Lone", 84, &["ST"], 16, 73, 18));
        let reqs = vec![Req { need: Need::League(16), count: 1 }];
        let f = builtin_formations();
        let req_first = SquadPrefs { chem_target: 33, ..Default::default() };
        let (_, a) = solve(&club, &reqs, &f, &req_first, &BTreeMap::new(), &BTreeSet::new(), None).unwrap();
        assert!(a.slots.iter().flatten().any(|&i| club[i].key == 50), "requirements first: the Ligue 1 player plays");
        let chem_first = SquadPrefs { chem_target: 33, chem_first: true, ..Default::default() };
        let (_, b) = solve(&club, &reqs, &f, &chem_first, &BTreeMap::new(), &BTreeSet::new(), None).unwrap();
        let xi: Vec<&Player> = b.slots.iter().flatten().map(|&i| &club[i]).collect();
        assert_eq!(chemistry(&xi, &BTreeMap::new()).iter().sum::<u32>(), 33, "chemistry first: 33");
    }
}

impl Input {
    /// Nothing read yet.
    pub fn empty() -> Input {
        Input {
            groups: vec![],
            names: Names::default(),
            names_known: false,
            club: vec![],
            catalog: vec![],
            prices: BTreeMap::new(),
            rewards: BTreeMap::new(),
            formations: vec![],
            team_links: BTreeMap::new(),
            active: BTreeSet::new(),
            active_formation: None,
            coins: None,
            read_at: None,
            now_ms: 0,
        }
    }
}

/// The user's real club against the FC Heritage Circuit events (texts as EA writes them):
/// `FCT_REAL_DIR=<app data dir> cargo test --lib real_club -- --ignored --nocapture`.
#[cfg(test)]
mod real_data {
    use super::*;
    use serde_json::json;

    #[test]
    #[ignore]
    fn real_club_heritage_events() {
        let Ok(dir) = std::env::var("FCT_REAL_DIR") else { return };
        let dir = std::path::PathBuf::from(dir);
        let snap: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("snapshot.json")).unwrap()).unwrap();
        let mut gallery: BTreeMap<u64, crate::types::GalleryCard> = serde_json::from_value(snap["gallery"].clone()).unwrap();
        let mut items: BTreeMap<u64, crate::types::Item> = serde_json::from_value(snap["items"].clone()).unwrap();
        // the raw club responses carry positions and face stats
        for e in std::fs::read_dir(dir.join("captures")).unwrap().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            // the card database's raw responses carry the face stats of cards to get
            if name.ends_with("_defid.json") {
                let v: Value = serde_json::from_str(&std::fs::read_to_string(e.path()).unwrap()).unwrap();
                for c in crate::sync_data::raw_concept_cards(&v["body"]) {
                    if let Some(g) = gallery.get_mut(&c.def_id) {
                        if g.face.is_empty() {
                            g.face = c.face;
                        }
                    }
                }
                continue;
            }
            if !name.ends_with("_club.json") {
                continue;
            }
            let v: Value = serde_json::from_str(&std::fs::read_to_string(e.path()).unwrap()).unwrap();
            let mut found = Vec::new();
            crate::sync_data::collect_items(&v["body"], &mut found, 0);
            for (it, _, _) in found {
                if let Some(old) = items.get_mut(&it.id) {
                    old.play = it.play.or(old.play.take());
                }
            }
        }
        let prices: BTreeMap<u64, Price> = serde_json::from_value(snap["prices"].clone()).unwrap();
        let links: BTreeMap<u64, Vec<u64>> = serde_json::from_value(snap["team_links"].clone()).unwrap_or_default();
        let mut names = Names::from_value(&json!({
            "leagues": { "13": ["Premier League"], "16": ["Ligue 1 McDonald's", "Ligue 1"], "31": ["Serie A Enilive", "Serie A"], "19": ["Bundesliga"], "53": ["LALIGA EA SPORTS", "LALIGA"] },
            "nations": { "18": "France", "14": "England", "34": "Netherlands", "7": "Belgium" }
        }));
        for c in gallery.values() {
            if let (Some(t), Some(n)) = (c.team, c.team_name.as_deref()) {
                names.add_team(t, n, c.league);
            }
        }
        // EA's objective names, in order
        const NAMES: [&str; 16] = ["", "Premier Pride", "French Connection", "Belgian Tower", "Three Lions Legacy", "Win 1", "Bundesliga Backbone", "Bavarian Thunder", "Paris Power Surge", "Bernabéu Thunder", "Thunder Final", "Ligue 1 Finest", "Oranje Legacy", "Madrid Royalty", "French Thrill", "Serie A after Dark"];
        let obj = |id: usize, text: &str| json!({ "id": id, "name": NAMES.get(id).copied().unwrap_or("Check"), "description": text, "progress": 0, "target": 1, "state": "IN_PROGRESS" });
        let groups = groups_from_value(&json!({ "groups": [
            { "id": 157, "title": "FC Heritage Circuit Professional Event", "endTime": 1796284799, "objectives": [
                obj(1, "Win 2 matches while having Min. 3 Premier League players in your starting 11 in the FC Heritage Circuit Professional Event."),
                obj(2, "Score at least 3 goals in one match while having Min. 1 French player in your starting 11 in the FC Heritage Circuit Professional Event."),
                obj(3, "Assist at least 3 goals while having Min. 1 Belgian player in your starting 11 in the FC Heritage Circuit Professional Event."),
                obj(4, "Score at least 1 goal in 2 separate matches while having Min. 1 English player in your starting 11 in the FC Heritage Circuit Professional Event."),
                obj(5, "Win 1 match in the FC Heritage Circuit Professional Event and qualify for the FC Heritage Circuit World Class Event.") ] },
            { "id": 161, "title": "FC Heritage Circuit World Class Event", "endTime": 1796284799, "objectives": [
                obj(6, "Win 3 matches while having Min. 3 player items from Bundesliga in your starting 11 in the FC Heritage Circuit World Class Event"),
                obj(7, "Score 5 goals while having Min. 1 FC Bayern München (Bundesliga) player item in your starting 11 in the FC Heritage Circuit World Class Event"),
                obj(8, "Assist 4 goals while having Min. 1 PSG (Ligue 1) player item in your starting 11 in the FC Heritage Circuit World Class Event"),
                obj(9, "Score at least 1 goal in 3 separate matches while having Min. 1 Real Madrid (LALIGA) player item in your starting 11 in the FC Heritage Circuit World Class Event") ] },
            { "id": 158, "title": "FC Heritage Circuit Tournament", "endTime": 1796284799, "objectives": [
                obj(10, "Win the FC Heritage Circuit Tournament while having Min. 2 Premier League players in your starting 11."),
                obj(11, "Win 2 matches while having Min. 2 Ligue 1 players in your starting 11 in the FC Heritage Circuit Tournament."),
                obj(12, "Assist at least 1 goal in 3 separate matches while having Min. 1 Dutch player in your starting 11 in the FC Heritage Circuit Tournament."),
                obj(13, "Score at least 1 goal in 3 separate matches while having Min. 1 Real Madrid (LALIGA) player in your starting 11 in the FC Heritage Circuit Tournament."),
                obj(14, "Score at least 2 goals in 1 match while having Min. 1 French player in your starting 11 in the FC Heritage Circuit Tournament."),
                obj(15, "Win 1 Quarter-Finals match while having Min. 2 Serie A players in your starting 11 in the FC Heritage Circuit Tournament.") ] }
        ] }));
        let input = Input {
            groups,
            names,
            names_known: true,
            club: items.values().filter_map(|i| club_player(i, &gallery, &Attributes::default())).collect(),
            catalog: gallery.values().filter_map(|c| catalog_player(c, &Attributes::default())).collect(),
            prices,
            rewards: BTreeMap::new(),
            formations: vec![],
            team_links: links,
            active: BTreeSet::new(),
            active_formation: None,
            coins: snap["coins"][0].as_u64(),
            read_at: None,
            now_ms: snap["prices"].as_object().unwrap().values().filter_map(|p| p["at"].as_u64()).max().unwrap_or(0),
        };
        println!("club players with positions: {}", input.club.iter().filter(|p| !p.positions.is_empty()).count());
        // "has to include" McGeady and Bonmatí – not in this club: they play as cards to get
        let wanted: Vec<u64> = ["mcgeady", "bonmati"]
            .iter()
            .filter_map(|n| search(&input, n, 1).first().map(|c| c.key))
            .collect();
        println!("must cards: {wanted:?} {:?}", wanted.iter().map(|k| input.catalog.iter().find(|c| c.def_id == *k).map(|c| format!("{} {} {:?}", c.name, c.rating, c.positions))).collect::<Vec<_>>());
        let with = plan(&input, &SquadPrefs { must_cards: wanted.clone(), ..Default::default() });
        for e in &with.events {
            let sq = e.squad.as_ref().unwrap();
            let picked: Vec<String> = sq.slots.iter().filter(|s| s.must).map(|s| format!("{} {} owned={} {:?}", s.name, s.pos, s.owned, s.price)).collect();
            println!("MUST {} – {} · {}/{} reqs · chem {} · {:?} missing {:?}", e.title, sq.formation, sq.met, e.reqs.len(), sq.chem, picked, sq.must_missing);
        }
        assert!(with.events.iter().all(|e| e.squad.as_ref().unwrap().slots.iter().filter(|s| s.must).count() == wanted.len()));
        // the browser preview (src/devMock.ts) shows this real plan
        if let Ok(out) = std::env::var("FCT_SQUADS_OUT") {
            std::fs::write(out, serde_json::to_string_pretty(&plan(&input, &SquadPrefs::default())).unwrap()).unwrap();
        }
        // suggestions: requirements this club can't meet (a check only – not an EA event)
        let mut check = input.groups.clone();
        check.truncate(0);
        let mut gaps = Input { groups: groups_from_value(&json!({ "groups": [{ "id": 1, "title": "Design check – leagues left out of the club", "objectives": [
            obj(1, "Win 1 match while having Min. 2 ROSHN Saudi League players in your starting 11"),
            obj(2, "Win 1 match while having Min. 1 MLS player in your starting 11") ] }] })), ..Input::empty() };
        gaps.names = input.names.clone();
        gaps.names.leagues.insert(350, vec!["ROSHN Saudi League".into()]);
        gaps.names.leagues.insert(39, vec!["MLS".into()]);
        gaps.names_known = true;
        // as if the club had none of them
        gaps.club = input.club.iter().filter(|p| p.league != 350 && p.league != 39).cloned().collect();
        gaps.catalog = input.catalog.clone();
        gaps.prices = input.prices.clone();
        gaps.coins = input.coins;
        gaps.now_ms = input.now_ms;
        let _ = check;
        let gap_plan = plan(&gaps, &SquadPrefs::default());
        // the browser preview's ?squads-gaps (design only: the options block)
        if let Ok(out) = std::env::var("FCT_SQUADS_GAPS_OUT") {
            std::fs::write(out, serde_json::to_string_pretty(&gap_plan).unwrap()).unwrap();
        }
        for e in gap_plan.events {
            for r in &e.reqs {
                println!("CHECK {:?} {} {}/{} {:?}", r.need, r.name, r.have, r.count, r.players);
                for o in &r.options {
                    println!("     → {} {} {} {} {:?} ({})", o.kind, o.name, o.rating, o.pos, o.price, o.strength);
                }
                println!("     unpriced {}", r.unpriced);
            }
        }
        for prefs in [SquadPrefs::default(), SquadPrefs { chem_target: 30, ..Default::default() }] {
            let t = std::time::Instant::now();
            let view = plan(&input, &prefs);
            println!("\n=== chem target {} – {} ms", prefs.chem_target, t.elapsed().as_millis());
            for e in &view.events {
                let sq = e.squad.as_ref().unwrap();
                println!("\n{} – {} · chem {}/{} · {} of {} requirements · avg {}", e.title, sq.formation, sq.chem, sq.chem_target, sq.met, e.reqs.len(), sq.strength);
                for o in &e.objectives {
                    println!("  [{}] {}{}", o.req.map(|r| if e.reqs[r].met { "✓" } else { "✗" }).unwrap_or("·"), o.text.chars().take(90).collect::<String>(), o.unknown.as_ref().map(|u| format!("  (NOT READ: {u})")).unwrap_or_default());
                }
                for r in &e.reqs {
                    println!("  {:?} {} {}/{} {:?}", r.need, r.name, r.have, r.count, r.players);
                    for o in &r.options {
                        println!("     → {} {} {} {} {:?} ({})", o.kind, o.name, o.rating, o.pos, o.price, o.strength);
                    }
                    if r.unpriced > 0 {
                        println!("     ({} more without a recent price)", r.unpriced);
                    }
                }
                for s in &sq.slots {
                    println!("    {:4} {:22} {} chem {} {:?}", s.pos, s.name, s.rating, s.chem, s.counts_for);
                }
            }
        }
    }
}
