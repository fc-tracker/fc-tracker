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
    /// What the plan aims for: "progress" (the most objectives per match), "buys" (the fewest
    /// cards to buy), "changes" (the fewest squad changes) or "matches" (the fewest matches).
    pub goal: String,
    /// The most cards to buy for one squad; none = no limit, 0 = club cards only.
    pub max_buys: Option<u32>,
    /// A formation the user picked (EA's name, "f4312"); none = the best one.
    pub formation: Option<String>,
    /// Follow the plan in the game: count matches, say when to change the squad (on by default).
    pub track: bool,
    /// Matches the app counted since `played_at` (the objectives' read time they follow).
    pub played: u32,
    pub played_at: u64,
    /// Requirements no card we know meets (a closed evolution, an unreadable program): the user said
    /// they're gone (left out of the plan) or still there (kept, not asked again). Lower-case names.
    pub skip: Vec<String>,
    pub keep: Vec<String>,
    /// What FC-Tracker users established together (api.fc-tracker.com/v1/availability): name →
    /// still available. The user's own answer wins over it.
    pub facts: BTreeMap<String, bool>,
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
        Self { chem_target: 33, chem_first: false, hide_loans: true, budget: None, must: Vec::new(), must_cards: Vec::new(), done_marks: Vec::new(), primary: None, place: None, goal: "progress".into(), max_buys: Some(3), formation: None, track: true, played: 0, played_at: 0, skip: Vec::new(), keep: Vec::new(), facts: BTreeMap::new() }
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

    /// A league as players say it (user 2026-11-01): the short name without the sponsor and EA's
    /// own code – "LaLiga (ESP 1)", "Ligue 1 (FRA 1)", "WSL (ENG 1)".
    pub fn league_short(&self, id: u64) -> Option<String> {
        let v = self.leagues.get(&id)?;
        let code = v.iter().find(|n| n.len() <= 6 && n.chars().any(|c| c.is_ascii_digit()) && n.contains(' '));
        let name = v.iter().filter(|n| Some(*n) != code).min_by_key(|n| n.chars().count())?;
        const SPONSORS: [&str; 12] = ["EA SPORTS", "McDonald's", "Enilive", "Moeve", "Barclays", "BBVA", "ROSHN", "Arkema", "Betclic", "Hyundai", "Credit Suisse", "Admiral"];
        let mut short = name.to_string();
        for sp in SPONSORS {
            short = short.replace(sp, "");
        }
        let mut short = short.split_whitespace().collect::<Vec<_>>().join(" ");
        if short.eq_ignore_ascii_case("laliga") {
            short = "LaLiga".into();
        }
        if short.is_empty() {
            short = name.clone();
        }
        Some(match code {
            Some(c) => format!("{short} ({c})"),
            None => short,
        })
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
    /// EA's category as the Web App names it ("Seasonal", "Campaigns", "Foundations" …) and its id.
    pub category: String,
    pub category_id: Option<u64>,
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
                    let progress = u(o, "progress").unwrap_or(0) as u32;
                    // EA's state, or the progress at the target (a reward not yet claimed is still done)
                    let done = o.get("done").and_then(Value::as_bool).unwrap_or(false) || matches!(state.as_str(), "COMPLETED" | "REDEEMED" | "REWARDED" | "CLAIMED") || progress >= target;
                    // EA's texts may hold the target as %1
                    let text = s(o, "description").replace("%1", &target.to_string());
                    Objective { id: u(o, "id").unwrap_or(0), name: s(o, "name"), text, progress, target, done }
                })
                .collect::<Vec<_>>();
            Some(Group { id: u(g, "id")?, title: s(g, "title"), ends_at: u(g, "endTime").filter(|&e| e > 0), objectives, category: s(g, "category"), category_id: u(g, "categoryId") })
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
                "category": text(c.get("name").and_then(Value::as_str).unwrap_or("")),
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
    Rarity(Vec<u64>),
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
            Need::Rarity(ref r) => r.contains(&p.rareflag),
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

/// A program by its name ("Ultimate Scream"): the exact name, or a longer name the phrase begins
/// ("Ultimate Scream" for "Ultimate Scream Heroes" is not taken). Never a shorter one: "Future Stars
/// Academy" (an evolution, user 2026-11-01) is not the "Future Stars" program.
fn find_rarity(phrase: &str, names: &Names) -> Option<Vec<u64>> {
    let p = norm(phrase);
    if p.len() < 4 {
        return None;
    }
    // EA gives some programs more than one id ("Future Stars Academy" 66 and 67): any of them
    let ids: Vec<u64> = names.rarities.iter().filter(|(_, n)| norm(n) == p).map(|(&id, _)| id).collect();
    (!ids.is_empty()).then_some(ids)
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

/// Chemistry of each of the 11 (FC 27, user 2026-10-31 with the game's own Build Chemistry table):
/// only cards in one of their positions have chemistry and add to anyone's; club 2/4/7, league
/// 3/5/8, nation 2/5/8 (men's and women's sides of a club count as one club), capped at 3. Icons
/// and Heroes always have 3 in position; an Icon adds 1 to every league and 1 to its nation, a Hero
/// 1 to its league and 1 to its nation. The manager adds 1 to its league and 1 to its nation, at
/// most +1 for any one player.
pub fn chemistry_full(xi: &[(&Player, bool)], links: &BTreeMap<u64, u64>, manager: Option<(u64, u64)>) -> Vec<u32> {
    let clubs: Vec<u64> = xi.iter().map(|(p, _)| canonical(p.club, links)).collect();
    let icons = xi.iter().filter(|(p, in_pos)| *in_pos && p.is_icon()).count() as u32;
    let step = |n: u32, t: [u32; 3]| t.iter().filter(|&&x| n >= x).count() as u32;
    xi.iter()
        .enumerate()
        .map(|(k, (p, in_pos))| {
            if !in_pos {
                return 0;
            }
            if p.is_icon() || p.is_hero() {
                return 3;
            }
            let (mut club, mut league, mut nation) = (0u32, icons, 0u32);
            for (j, (q, q_in)) in xi.iter().enumerate() {
                if !q_in {
                    continue;
                }
                nation += u32::from(q.nation == p.nation);
                if q.is_icon() {
                    continue;
                }
                league += u32::from(q.league == p.league);
                club += u32::from(!q.is_hero() && clubs[j] == clubs[k]);
            }
            let of = |l: u32, n: u32| (step(club, [2, 4, 7]) + step(l, [3, 5, 8]) + step(n, [2, 5, 8])).min(3);
            let base = of(league, nation);
            match manager {
                // the manager lifts a card by one point at most
                Some((ml, mn)) => of(league + u32::from(ml == p.league), nation + u32::from(mn == p.nation)).min(base + 1),
                None => base,
            }
        })
        .collect()
}

/// Chemistry with every card in position and no manager.
#[cfg(test)]
pub fn chemistry(xi: &[&Player], links: &BTreeMap<u64, u64>) -> Vec<u32> {
    chemistry_full(&xi.iter().map(|p| (*p, true)).collect::<Vec<_>>(), links, None)
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

/// What a search weighs besides the requirements: the user's own squad, buys, the manager.
#[derive(Debug, Clone, Default)]
struct SolveOpts<'a> {
    /// How much each requirement weighs (the picked event's most, bonus objectives a tie-break); empty = 1 each.
    weights: &'a [f64],
    active: Option<&'a BTreeSet<u64>>,
    active_formation: Option<&'a str>,
    /// The squad's manager (league, nation): counts for both like a player (FC chemistry since FIFA 23).
    manager: Option<(u64, u64)>,
    /// Per player: what playing them costs (0 = in the club; a card to buy weighs its price).
    cost: Vec<f64>,
    /// The most cards to buy in one squad.
    max_buys: Option<u32>,
    /// How much keeping a card of the active squad (and its formation) is worth.
    keep: f64,
}

struct Ctx<'a> {
    players: &'a [Player],
    reqs: &'a [Req],
    prefs: &'a SquadPrefs,
    links: &'a BTreeMap<u64, u64>,
    o: SolveOpts<'a>,
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

/// A card in a slot it has no chemistry in: 0 chemistry, it adds to nobody's, and it plays worse –
/// worth it only for a live requirement (a met one weighs 2e6), never for a bonus one or strength.
const OUT_OF_POSITION: f64 = 5.0e4;

impl Ctx<'_> {
    fn eligible(&self, p: usize, pos: &str) -> bool {
        self.players[p].positions.iter().any(|x| x == pos)
    }

    /// Where a card may stand: its own positions – or anywhere when it's a club card that meets a
    /// requirement (user 2026-10-31: "Corona at RB if that solves the puzzle" – it gets 0 chemistry).
    fn fits(&self, p: usize, pos: &str) -> bool {
        self.eligible(p, pos) || (self.players[p].owned && !self.meets[p].is_empty() && pos != "GK" && !self.players[p].positions.iter().any(|x| x == "GK"))
    }

    fn active(&self, p: usize) -> bool {
        self.o.active.is_some_and(|a| a.contains(&self.players[p].key))
    }

    /// One number, highest best: requirements (each counts by how close it is, a met one fully
    /// twice), the chemistry target, strength at chemistry, few changes from the active squad, few
    /// buys. The weights keep the user's order: a step up in the first never loses to the rest.
    fn score(&self, f: &Formation, slots: &[Option<usize>]) -> f64 {
        let chosen: Vec<(&Player, bool)> = slots.iter().zip(&f.slots).filter_map(|(s, pos)| s.map(|i| (&self.players[i], self.eligible(i, pos)))).collect();
        let mut have = vec![0u32; self.reqs.len()];
        for &i in slots.iter().flatten() {
            for &r in &self.meets[i] {
                have[r] += 1;
            }
        }
        let chem = chemistry_full(&chosen, self.links, self.o.manager);
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
            .map(|(k, (r, &h))| self.o.weights.get(k).copied().unwrap_or(1.0) * (h.min(r.count) as f64 / r.count as f64 + if h >= r.count { 1.0 } else { 0.0 }))
            .sum();
        let short = self.prefs.chem_target.min(33).saturating_sub(total) as f64;
        let mut power = 0.0;
        let mut buys = 0u32;
        for (&s, pos) in slots.iter().zip(&f.slots) {
            let Some(i) = s else { continue };
            power += strength(&self.players[i], pos);
            if !self.eligible(i, pos) {
                power -= OUT_OF_POSITION;
            }
            // the squad the user plays stays unless a change is clearly better (user 2026-10-30:
            // "10 changes from your squad" is not an objective squad)
            if self.active(i) {
                power += self.o.keep;
            }
            let c = self.o.cost.get(i).copied().unwrap_or(0.0);
            if c > 0.0 {
                power -= c;
                buys += 1;
            }
        }
        if self.o.max_buys.is_some_and(|m| buys > m) {
            power -= 1.0e9 * (buys - self.o.max_buys.unwrap_or(0)) as f64;
        }
        if self.o.active_formation == Some(f.name.as_str()) {
            power += 2.0 * self.o.keep;
        }
        power += 0.35 * chem.iter().sum::<u32>() as f64;
        // "has to include" comes before everything
        let must = slots.iter().flatten().filter(|i| self.must.contains(i)).count() as f64 * 1.0e12;
        // "chemistry first" = a playable squad, but objectives still count: a met requirement
        // (2e6) is worth about five chemistry points (user 2026-10-31: squads must not lock up)
        must + if self.prefs.chem_first {
            -short * 4.0e5 + reqs * 1.0e6 + power
        } else {
            reqs * 1.0e6 - short * 2.0e3 + power
        }
    }

    fn used(slots: &[Option<usize>], p: usize, players: &[Player]) -> bool {
        let person = players[p].person();
        slots.iter().flatten().any(|&q| q == p || players[q].person() == person)
    }

    /// Places cards in their own position first (the fewest possible slots first).
    fn place(&self, f: &Formation, slots: &mut [Option<usize>], mut cards: Vec<usize>) {
        cards.sort_by_key(|&p| f.slots.iter().filter(|pos| self.eligible(p, pos)).count());
        for p in cards {
            let own = self.players[p].positions.first();
            let free = |k: &usize| slots[*k].is_none() && self.eligible(p, &f.slots[*k]);
            if let Some(k) = (0..11).filter(free).find(|&k| Some(&f.slots[k]) == own).or_else(|| (0..11).find(free)) {
                if !Self::used(slots, p, self.players) {
                    slots[k] = Some(p);
                }
            }
        }
    }

    /// Greedy start, then the best single change (a card in, or two slots swapped) until none helps.
    fn solve_formation(&self, f: &Formation, pool: &[Vec<usize>], seed: u64) -> Pick {
        self.solve_formation_with(f, pool, seed, true)
    }

    fn solve_formation_with(&self, f: &Formation, pool: &[Vec<usize>], seed: u64, search: bool) -> Pick {
        let mut slots: Vec<Option<usize>> = vec![None; 11];
        // "has to include" first
        self.place(f, &mut slots, self.must.iter().copied().collect());
        // the squad the user plays, in its own formation: the search starts from it and changes only
        // what helps
        if self.o.active_formation == Some(f.name.as_str()) {
            self.place(f, &mut slots, (0..self.players.len()).filter(|&i| self.active(i)).collect());
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
        for _ in 0..if search { 60 } else { 0 } {
            let mut improved = false;
            for k in 0..11 {
                for &p in &pool[k] {
                    if slots[k] == Some(p) {
                        continue;
                    }
                    let at = slots.iter().position(|&s| s == Some(p));
                    let mut next = slots.clone();
                    match at {
                        // swap two slots: both must be able to stand in their new one
                        Some(j) => {
                            if slots[k].is_some_and(|q| self.fits(q, &f.slots[j])) {
                                next.swap(k, j);
                            } else if !self.eligible(p, &f.slots[j]) && self.eligible(p, &f.slots[k]) {
                                // a card out of position goes to its own slot; its old one gets the
                                // best card for it
                                next[k] = Some(p);
                                next[j] = None;
                                let mut fill: Option<(f64, usize)> = None;
                                for &q in &pool[j] {
                                    if Self::used(&next, q, self.players) {
                                        continue;
                                    }
                                    next[j] = Some(q);
                                    let s = self.score(f, &next);
                                    if fill.is_none_or(|b| s > b.0) {
                                        fill = Some((s, q));
                                    }
                                }
                                next[j] = fill.map(|b| b.1);
                            } else {
                                continue;
                            }
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
    solve_with(players, reqs, formations, prefs, links, SolveOpts { active: Some(active), active_formation, keep: 2000.0, ..Default::default() })
}

fn solve_with(players: &[Player], reqs: &[Req], formations: &[Formation], prefs: &SquadPrefs, links: &BTreeMap<u64, u64>, o: SolveOpts) -> Option<(usize, Pick)> {
    let meets: Vec<Vec<usize>> = players.iter().map(|p| reqs.iter().enumerate().filter(|(_, r)| r.need.met_by(p, links)).map(|(i, _)| i).collect()).collect();
    let must = (0..players.len()).filter(|&i| prefs.must.contains(&players[i].key)).collect();
    // a formation the user picked is the only one tried
    let only: Vec<usize> = (0..formations.len()).filter(|&i| prefs.formation.as_deref().is_none_or(|n| formations[i].name == n || formations[i].label == n)).collect();
    let tried: Vec<usize> = if only.is_empty() { (0..formations.len()).collect() } else { only };
    let ctx = Ctx { players, reqs, prefs, links, o, meets, must };
    let mut best: Option<(usize, Pick)> = None;
    // the strongest per position + everyone who meets a requirement + the active squad (keeps the
    // search small); club cards that meet one may also stand out of position
    let mut results: Vec<(usize, Pick, Vec<Vec<usize>>)> = Vec::new();
    for fi in tried {
        let f = &formations[fi];
        let pool: Vec<Vec<usize>> = f
            .slots
            .iter()
            .map(|pos| {
                let mut c: Vec<usize> = (0..players.len()).filter(|&i| ctx.eligible(i, pos)).collect();
                c.sort_by(|&a, &b| strength(&players[b], pos).total_cmp(&strength(&players[a], pos)));
                let (top, rest) = c.split_at(c.len().min(14));
                let mut keep = top.to_vec();
                keep.extend(rest.iter().copied().filter(|&i| !ctx.meets[i].is_empty() || ctx.must.contains(&i) || ctx.active(i)).take(40));
                let oop: Vec<usize> = (0..players.len()).filter(|&i| !ctx.eligible(i, pos) && ctx.fits(i, pos)).take(8).collect();
                keep.extend(oop);
                keep
            })
            .collect();
        if pool.iter().any(Vec::is_empty) {
            continue;
        }
        // a greedy start for every formation; the full search for the promising ones below
        let pick = ctx.solve_formation_with(f, &pool, 1, false);
        results.push((fi, pick, pool));
    }
    results.sort_by(|a, b| b.1.score.total_cmp(&a.1.score));
    // the active squad's formation is always searched (the user's squad lives there)
    if let Some(k) = results.iter().position(|r| ctx.o.active_formation == Some(formations[r.0].name.as_str())) {
        let r = results.remove(k);
        results.insert(0, r);
    }
    for (fi, pick, pool) in results.iter_mut().take(6) {
        *pick = ctx.solve_formation(&formations[*fi], pool, 1);
    }
    results.sort_by(|a, b| b.1.score.total_cmp(&a.1.score));
    // a few restarts on the most promising formations
    for (fi, pick, pool) in results.iter().take(3) {
        let mut cand = pick.clone();
        for seed in [7u64, 2024] {
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
    /// EA's category ("Seasonal" …) and its id (the Web App's order).
    pub category: String,
    pub category_id: Option<u64>,
    /// Ends within a season (Seasonal, Campaigns, FC Pro …), not a long-running one.
    pub live: bool,
    /// Has open objectives a match moves on.
    pub playable: bool,
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
    /// Moved on by playing matches (not an SBC, the market …).
    pub playable: bool,
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
    /// Club cards that meet it (in this squad or not), and the first of them by name.
    pub club: u32,
    pub club_players: Vec<String>,
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
    /// Cards to buy in it, and what the ones with a recent EA price cost together.
    pub buys: usize,
    pub cost: u64,
    /// The manager: the active squad's, or the nation + league that would add chemistry.
    pub manager: Option<ManagerView>,
}

/// A manager shown by nation and league only (user 2026-10-31).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ManagerView {
    pub league: u64,
    pub league_name: Option<String>,
    pub nation: u64,
    pub nation_name: Option<String>,
    /// Chemistry points it adds over the active squad's manager.
    pub gain: u32,
    /// The manager the squad has now.
    pub current: bool,
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
    pub league: u64,
    pub league_name: Option<String>,
    /// Bio: 1 = right foot, 2 = left, 0 = unknown; weak foot and skill moves in stars.
    pub foot: u8,
    pub weak_foot: u32,
    pub skill_moves: u32,
    /// A "has to include" card.
    pub must: bool,
    /// Not in the club yet (a card to buy) and its price.
    pub owned: bool,
    pub price: Option<u64>,
    /// Stands out of its positions: 0 chemistry, but it counts for a requirement.
    pub out_of_position: bool,
    /// A card to buy without a recent EA price: shown as a profile to search for (nation, league,
    /// position), the card itself only as an example.
    pub generic: bool,
    /// In an active evolution (its name).
    pub evo: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GetOption {
    /// "owned" | "reward" | "sbc" | "cheapest" | "value" | "upgrade" | "search" (no price: find it on the market)
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
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rates {
    pub win: f64,
    pub goals: f64,
    pub assists: f64,
}

impl Default for Rates {
    fn default() -> Self {
        Rates { win: 0.55, goals: 2.0, assists: 1.4 }
    }
}

impl Rates {
    /// From the club's record (wins, draws, losses); the defaults below 10 matches.
    pub fn from_record(wins: u64, draws: u64, losses: u64) -> Rates {
        let n = wins + draws + losses;
        if n < 10 {
            return Rates::default();
        }
        let win = (wins as f64 / n as f64).clamp(0.2, 0.95);
        // more wins, more goals (a club that wins most games scores about 2.5 a match)
        Rates { win, goals: 1.2 + 1.5 * win, assists: 0.8 + 1.0 * win }
    }
}

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
    /// Its manager (league, nation).
    pub manager: Option<(u64, u64)>,
    /// The user's own results: how often a match is won, goals and assists per match.
    pub rates: Rates,
    pub coins: Option<u64>,
    pub read_at: Option<u64>,
    pub now_ms: u64,
    /// The active evolutions (`/academy/hub/v2`).
    pub evos: Vec<Evo>,
}

fn need_name(need: &Need, names: &Names) -> String {
    match *need {
        Need::League(id) => names.league_short(id).unwrap_or_else(|| format!("#{id}")),
        Need::Club(id) => names.team_name(id).map(str::to_string).unwrap_or_else(|| format!("#{id}")),
        Need::Nation(id) => names.nations.get(&id).cloned().unwrap_or_else(|| format!("#{id}")),
        Need::Icon | Need::Hero => String::new(),
        Need::Rating(min) | Need::WeakFoot(min) | Need::SkillMoves(min) | Need::Chemistry(min) => min.to_string(),
        Need::Rarity(ref r) => r.first().and_then(|id| names.rarities.get(id)).cloned().unwrap_or_default(),
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

// ---------- evolutions ----------

/// An active evolution (`/academy/hub/v2`): its player and what its level in progress asks.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Evo {
    pub slot: u64,
    pub name: String,
    /// Club item id of the player in it.
    pub item: u64,
    pub level: u32,
    pub levels: u32,
    /// The open objectives of the level in progress.
    pub goals: Vec<EvoGoal>,
    /// s
    pub ends_at: Option<u64>,
    /// Where its matches count (from the open objectives' texts); empty = no match moves it on
    /// (Training Camp).
    pub modes: Vec<Mode>,
    /// An objective needs him on the pitch from the start (starting XI, a goal, an assist …).
    pub start: bool,
    /// Matches its open levels still take (match objectives only).
    pub matches_left: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EvoGoal {
    pub text: String,
    pub progress: u32,
    pub target: u32,
}

/// "Play 2 matches … using your active EVO player in game" counts for a sub; a goal, an assist or
/// "in your starting 11" needs him from the kickoff.
fn needs_start(text: &str) -> bool {
    let l = text.to_lowercase();
    ["starting", "from the start", "score", "goal", "assist", "clean sheet"].iter().any(|k| l.contains(k))
}

/// The players in active evolutions as club players: an evo takes its player off the club pile,
/// so EA's club list leaves him out (Suhonen in Center Spectre, 2026-11-01) – the hub has his item.
pub fn evo_players(v: &Value, club: &[Player], catalog: &BTreeMap<u64, crate::types::GalleryCard>, attrs: &Attributes) -> Vec<Player> {
    let evos = evos_from_hub(v);
    v.get("slots")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|s| s.get("id").and_then(Value::as_u64).is_some_and(|id| evos.iter().any(|e| e.slot == id)))
        .filter_map(|s| s.get("player"))
        .filter(|p| p.get("id").and_then(Value::as_u64).is_some_and(|id| !club.iter().any(|c| c.key == id)))
        .filter_map(|p| crate::sync_data::parse_item(p, 0))
        // no name in the item: the card's (the same order as every club card)
        .filter_map(|item| club_player(&item, catalog, attrs))
        .collect()
}

/// The active evolutions in EA's Evolutions hub.
pub fn evos_from_hub(v: &Value) -> Vec<Evo> {
    let ids = |k: &str| v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect::<Vec<_>>()).unwrap_or_default();
    let mut active = ids("activeSlotIds");
    active.extend(ids("activeTimedSlotIds"));
    let goal = |o: &Value| {
        let target = o.get("multiplier").and_then(Value::as_u64).unwrap_or(1) as u32;
        // Training Camp counts against a timestamp: never a progress past the target
        let progress = o.get("currentProgress").and_then(Value::as_u64).unwrap_or(0).min(target as u64) as u32;
        EvoGoal { text: o.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string(), progress, target }
    };
    let open_obj = |o: &&Value| o.get("state").and_then(Value::as_str) != Some("COMPLETED");
    let open_level = |l: &&&Value| l.get("levelState").and_then(Value::as_str) != Some("COMPLETED");
    let mut out: Vec<Evo> = Vec::new();
    for s in v.get("slots").and_then(Value::as_array).into_iter().flatten() {
        let Some(slot) = s.get("id").and_then(Value::as_u64) else { continue };
        if !(active.contains(&slot) || s.get("status").and_then(Value::as_str) == Some("ACTIVE")) || out.iter().any(|e| e.slot == slot) {
            continue;
        }
        let Some(item) = s.get("realPlayerId").and_then(Value::as_u64).filter(|&i| i > 0) else { continue };
        let levels: Vec<&Value> = s.get("levels").and_then(Value::as_array).into_iter().flatten().filter(|l| l.get("level").and_then(Value::as_u64).unwrap_or(0) >= 1).collect();
        let Some(cur) = levels.iter().find(open_level) else { continue };
        let goals: Vec<EvoGoal> = cur.get("objectives").and_then(Value::as_array).into_iter().flatten().filter(open_obj).map(goal).filter(|g| !g.text.is_empty()).collect();
        let mut modes: Vec<Mode> = Vec::new();
        for g in &goals {
            for m in objective_modes(&g.text).unwrap_or_default() {
                if !modes.contains(&m) {
                    modes.push(m);
                }
            }
        }
        let matches_left = levels
            .iter()
            .filter(open_level)
            .flat_map(|l| l.get("objectives").and_then(Value::as_array).into_iter().flatten())
            .filter(open_obj)
            .map(goal)
            .filter(|g| objective_modes(&g.text).is_some())
            .map(|g| g.target - g.progress)
            .sum();
        out.push(Evo {
            slot,
            name: s.get("slotName").and_then(Value::as_str).unwrap_or("").to_string(),
            item,
            level: cur.get("level").and_then(Value::as_u64).unwrap_or(1) as u32,
            levels: levels.len() as u32,
            start: goals.iter().any(|g| objective_modes(&g.text).is_some() && needs_start(&g.text)),
            goals,
            ends_at: s.get("endTime").and_then(Value::as_u64).filter(|&t| t > 0),
            modes,
            matches_left,
        });
    }
    out
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
    /// Live objectives (Seasonal, Campaigns, FC Pro …) a match here moves on with this squad.
    pub counted: usize,
    /// Long-running ones (Foundations, Milestones, Mastery) that move on too – free: they never
    /// shape the squad beyond a tie.
    pub bonus: usize,
    /// The event the user picked to play (this session is built around it).
    pub primary: Option<u64>,
    /// The match plan: the squads in turn as objectives finish (the first one is `squad`).
    pub stages: Vec<Stage>,
    /// Matches played since the objectives were last read (the app counts them).
    pub played: u32,
    /// A squad for a few matches only ("Play 1 match with 3 Mexicans"): how many.
    pub quick: Option<u32>,
    /// Active evolutions a match here moves on too (user 2026-11-01).
    pub evos: Vec<SessionEvo>,
    /// Club cards on the bench for objectives that count for a sub.
    pub bench: Vec<BenchPick>,
    /// The match brief: before the match in broad strokes, in the match who does what.
    pub brief: MatchBrief,
}

/// The match brief (user 2026-11-01): a to-do list for the next match – before it in broad strokes
/// (build the squad, buy, the kit, the bench), in it something specific to go for, by player
/// ("Mandžukić: score a header, score as a ST").
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct MatchBrief {
    pub before: Vec<BriefStep>,
    /// In the match, by the player who can do it (the one who covers the most first).
    pub players: Vec<BriefPlayer>,
    /// In the match, for anyone: win, keep a clean sheet …
    pub anyone: Vec<BriefTask>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BriefStep {
    /// "squad" (build it: `count` changes) | "ready" (the squad as it is) | "buy" (`text` = card,
    /// `count` = price) | "use" (`text` = a kit, stadium, ball …) | "bench" (`text` = names)
    pub kind: String,
    pub text: String,
    pub count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BriefPlayer {
    pub name: String,
    pub pos: String,
    /// On the bench: subbed on late.
    pub bench: bool,
    pub tasks: Vec<BriefTask>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BriefTask {
    /// The objective's ask, short ("Score 1 header").
    pub text: String,
    /// Still to do.
    pub left: u32,
}

/// "Score 1 header in the Ghoul Fest Live Event." → "Score 1 header": the place and the squad part
/// are said elsewhere (the session, the player it's under).
fn short_task(text: &str) -> String {
    let t = text.trim().trim_end_matches('.');
    let l = t.to_lowercase();
    let cut = [" in the ", " in any ", " in squad battles", " in rivals", " in champions", " in rush", " while ", " using ", " with ", " in your ", " in a ", " across "]
        .iter()
        .filter_map(|k| l.find(k))
        .filter(|&i| i > 4)
        .min()
        .unwrap_or(t.len());
    t[..cut].trim().to_string()
}

/// A kit, stadium or ball an objective asks to use ("… using the Mexico Away kit").
fn gear(text: &str) -> Option<String> {
    let l = text.to_lowercase();
    let end = [" kit", " stadium", " match ball", " ball", " tifo", " badge"].iter().filter_map(|k| l.find(k).map(|i| i + k.len())).min()?;
    let start = ["using the ", "with the ", "wearing the ", "in the ", "using ", "with "].iter().filter_map(|k| l[..end].rfind(k).map(|i| i + k.len())).max().unwrap_or(0);
    let s = text[start..end].trim();
    (!s.is_empty()).then(|| s.to_string())
}

fn is_attacker(pos: &str) -> bool {
    matches!(pos, "ST" | "CF" | "LW" | "RW" | "LF" | "RF")
}

/// The brief of a session for its next match (the stage being played now).
pub fn match_brief(s: &ComboPlan) -> MatchBrief {
    let next = s.played + 1;
    let stage = s.stages.iter().find(|st| st.from <= next && st.to.is_none_or(|t| next <= t));
    let (sq, sreqs) = match (stage, &s.squad) {
        (Some(st), _) => (Some(&st.squad), &st.reqs),
        (None, Some(q)) => (Some(q), &s.reqs),
        _ => (None, &s.reqs),
    };
    let mut b = MatchBrief::default();
    // before: the squad, what to buy, what to wear, the bench
    if let Some(q) = sq {
        match q.changes {
            Some(0) => b.before.push(BriefStep { kind: "ready".into(), text: q.formation.clone(), count: None }),
            n => b.before.push(BriefStep { kind: "squad".into(), text: q.formation.clone(), count: n.map(|n| n as u64) }),
        }
        for x in q.slots.iter().filter(|x| !x.owned) {
            b.before.push(BriefStep { kind: "buy".into(), text: format!("{} · {}", x.name, x.pos), count: x.price });
        }
    }
    for it in s.items.iter().filter(|x| x.counts) {
        if let Some(g) = gear(&it.text) {
            if !b.before.iter().any(|x| x.kind == "use" && x.text.eq_ignore_ascii_case(&g)) {
                b.before.push(BriefStep { kind: "use".into(), text: g, count: None });
            }
        }
    }
    let benched: Vec<String> = s.evos.iter().filter(|e| !e.in_xi).map(|e| e.player.clone()).chain(s.bench.iter().map(|p| p.name.clone())).collect();
    if !benched.is_empty() {
        b.before.push(BriefStep { kind: "bench".into(), text: benched.join(", "), count: None });
    }
    // in the match: what a match moves on, by who can do it
    let mut tasks: Vec<(BriefTask, Vec<(String, String, bool)>)> = Vec::new();
    for it in s.items.iter().filter(|x| x.counts && !x.bonus) {
        let l = it.text.to_lowercase();
        let doable = scores(&l) || ["header", "clean sheet", "win "].iter().any(|k| l.contains(k)) || l.starts_with("win");
        if !doable || it.progress >= it.target {
            continue;
        }
        let task = BriefTask { text: short_task(&it.text), left: it.target - it.progress };
        let mut who: Vec<(String, String, bool)> = Vec::new();
        if let (true, Some(k), Some(q)) = (it.scorer, it.req, sq) {
            let need = &s.reqs[k].need;
            if let Some(j) = sreqs.iter().position(|r| &r.need == need) {
                // a goal or an assist is not the keeper's job
                who.extend(q.slots.iter().filter(|x| x.counts_for.contains(&j) && x.pos != "GK").map(|x| (x.name.clone(), x.pos.clone(), false)));
            }
            who.extend(s.bench.iter().filter(|p| p.reqs.contains(&k) && p.pos != "GK").map(|p| (p.name.clone(), p.pos.clone(), true)));
        }
        tasks.push((task, who));
    }
    // the player who covers the most open tasks first, until every task with a player has one
    let mut left: Vec<usize> = (0..tasks.len()).filter(|&i| !tasks[i].1.is_empty()).collect();
    while !left.is_empty() {
        let mut best: Option<((String, String, bool), usize)> = None;
        for &i in &left {
            for w in &tasks[i].1 {
                let n = left.iter().filter(|&&j| tasks[j].1.contains(w)).count();
                if best.as_ref().is_none_or(|b| n > b.1 || (n == b.1 && !w.2 && b.0 .2)) {
                    best = Some((w.clone(), n));
                }
            }
        }
        let Some((w, _)) = best else { break };
        let mine: Vec<usize> = left.iter().copied().filter(|&j| tasks[j].1.contains(&w)).collect();
        left.retain(|j| !mine.contains(j));
        b.players.push(BriefPlayer { name: w.0, pos: w.1, bench: w.2, tasks: mine.iter().map(|&j| tasks[j].0.clone()).collect() });
    }
    // no player named: a special goal (a header, a chip shot, outside the box …) goes to the striker –
    // the one already in the list, else the XI's first attacker; the rest is for anyone
    let striker = sq.and_then(|q| q.slots.iter().find(|x| is_attacker(&x.pos)).map(|x| (x.name.clone(), x.pos.clone())));
    for (t, _) in tasks.into_iter().filter(|(_, w)| w.is_empty()) {
        let l = t.text.to_lowercase();
        let special = ["header", "chip", "outside the box", "volley", "finesse", "free kick", "penalt", "long shot", "power shot", "trivela", "bicycle", "first time"].iter().any(|k| l.contains(k));
        if special && !b.players.iter().any(|p| is_attacker(&p.pos) && !p.bench) {
            if let Some((n, pos)) = &striker {
                b.players.push(BriefPlayer { name: n.clone(), pos: pos.clone(), bench: false, tasks: Vec::new() });
            }
        }
        let target = if special { b.players.iter_mut().find(|p| is_attacker(&p.pos) && !p.bench) } else { None };
        match target {
            Some(p) if !p.tasks.iter().any(|x| x.text == t.text) => p.tasks.push(t),
            Some(_) => {}
            None => match b.anyone.iter_mut().find(|x| x.text == t.text) {
                Some(x) => x.left = x.left.max(t.left),
                None => b.anyone.push(t),
            },
        }
    }
    // anyone: what asks the most of one match first (3 goals in a match, a clean sheet), then wins,
    // then plain goal counts – a short list to play for, not every objective again
    let rank = |t: &BriefTask| {
        let l = t.text.to_lowercase();
        if l.contains("one match") || l.contains("clean sheet") {
            0
        } else if l.starts_with("win") {
            1
        } else if l.contains("assist") {
            2
        } else {
            3
        }
    };
    b.anyone.sort_by_key(|t| (rank(t), t.left));
    b
}

/// An active evolution in a session: on the bench to be subbed on, or starting when it needs him
/// from the start.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SessionEvo {
    pub name: String,
    pub player: String,
    pub level: u32,
    pub levels: u32,
    pub goal: String,
    pub progress: u32,
    pub target: u32,
    /// An objective needs him from the start (starting XI, a goal, an assist …).
    pub start: bool,
    /// He is in this session's XI.
    pub in_xi: bool,
    /// Matches its open levels still take, and the days left to play them.
    pub matches_left: u32,
    pub days_left: Option<u32>,
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
    /// The requirement is about who scores / assists.
    pub scorer: bool,
    /// Counts with this squad.
    pub counts: bool,
    /// A long-running objective (Foundations, Milestones, Mastery): a free extra.
    pub bonus: bool,
    /// About how many more matches it takes, from the user's own results (win rate …).
    pub matches: Option<f64>,
    /// No card we know meets it: ask the user whether it's still available (lower case).
    pub ask: Option<String>,
    /// Met by a card on the bench (subbed on late).
    pub bench: bool,
}

/// A club card on the bench for objectives that don't need it from the start (user 2026-11-01).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BenchPick {
    pub name: String,
    pub pos: String,
    pub rating: u32,
    pub nation: u64,
    pub nation_name: Option<String>,
    /// The objectives it counts for once subbed on.
    pub objectives: Vec<String>,
    /// The session's requirements (indices) it meets.
    pub reqs: Vec<usize>,
}

/// One step of the match plan.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Stage {
    /// Matches from … to, counted from the last read (1 = the next match); `to` none = until the
    /// rest is done.
    pub from: u32,
    pub to: Option<u32>,
    pub squad: SquadView,
    pub reqs: Vec<ReqView>,
    /// What changes from the stage before.
    pub swaps: Vec<Swap>,
    /// Objectives expected to finish in this stage.
    pub finishing: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Swap {
    pub pos: String,
    pub out_name: String,
    pub in_name: String,
    pub in_rating: u32,
    pub in_owned: bool,
    pub in_price: Option<u64>,
    pub nation: u64,
    pub nation_name: Option<String>,
    pub league_name: Option<String>,
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

/// How a session plays: what a card to buy costs in the search, and what keeping the active squad
/// is worth – from the user's goal (Settings → Squads).
fn goal_weights(prefs: &SquadPrefs) -> (f64, f64) {
    match prefs.goal.as_str() {
        "buys" => (9.0e5, 2000.0),
        "changes" => (2.0e5, 6000.0),
        "matches" => (2.0e5, 0.0),
        // the most objectives per match, few changes, buys only where they open objectives up
        _ => (2.0e5, 2000.0),
    }
}

/// The XI as shown, with each requirement's count in it.
fn squad_view(club: &[Player], f: &Formation, pick: &Pick, reqs: &[Req], prefs: &SquadPrefs, input: &Input, links: &BTreeMap<u64, u64>) -> (SquadView, Vec<ReqView>) {
    let mut req_views: Vec<ReqView> = reqs
        .iter()
        .map(|r| ReqView { need: r.need.clone(), name: need_name(&r.need, &input.names), count: r.count, have: 0, met: false, players: vec![], options: vec![], unpriced: 0, club: 0, club_players: vec![] })
        .collect();
    let placed: Vec<(usize, &String)> = pick.slots.iter().zip(&f.slots).filter_map(|(s, pos)| s.map(|i| (i, pos))).collect();
    let xi: Vec<(&Player, bool)> = placed.iter().map(|&(i, pos)| (&club[i], club[i].positions.iter().any(|x| x == pos))).collect();
    let chem = chemistry_full(&xi, links, input.manager);
    let mut slots = Vec::new();
    let mut cost = 0;
    for (k, &(i, pos)) in placed.iter().enumerate() {
        let p = &club[i];
        let in_pos = xi[k].1;
        let counts_for: Vec<usize> = reqs.iter().enumerate().filter(|(_, r)| r.need.met_by(p, links)).map(|(k, _)| k).collect();
        for &k in &counts_for {
            req_views[k].have += 1;
            req_views[k].players.push(p.name.clone());
        }
        let key = playstyle_weights(pos);
        let key_ps = p.playstyles.iter().filter(|(n, _)| key.iter().any(|(k, _)| k == n)).count() as u32;
        let key_ps_plus = p.playstyles.iter().filter(|(n, plus)| *plus && key.iter().any(|(k, _)| k == n)).count() as u32;
        let price = (!p.owned).then(|| fresh_price(input, p.def_id)).flatten();
        cost += price.unwrap_or(0);
        let evo = p.owned.then(|| input.evos.iter().find(|e| e.item == p.key).map(|e| e.name.clone())).flatten();
        slots.push(SlotView {
            pos: pos.clone(),
            name: p.name.clone(),
            def_id: p.def_id,
            rating: p.rating,
            chem: chem[k],
            strength: round1(strength(p, pos)),
            loan: p.loan,
            counts_for,
            accel: accelerate(p).map(str::to_string),
            key_ps,
            key_ps_plus,
            full: p.stats.as_ref().is_some_and(|s| s.len() >= 20),
            nation: p.nation,
            nation_name: input.names.nations.get(&p.nation).cloned(),
            league: p.league,
            league_name: input.names.league_short(p.league),
            foot: p.foot,
            weak_foot: p.weak_foot,
            skill_moves: p.skill_moves,
            must: (prefs.must.contains(&p.key) && evo.is_none()) || (!p.owned && prefs.must_cards.contains(&p.def_id)),
            owned: p.owned,
            price,
            out_of_position: !in_pos,
            generic: !p.owned && price.is_none() && !prefs.must_cards.contains(&p.def_id),
            evo,
        });
    }
    // what the club has for each (the box says "your club has 1 (Corona) – get 2 more")
    for (k, r) in reqs.iter().enumerate() {
        let with: Vec<&Player> = club.iter().filter(|p| p.owned && r.need.met_by(p, links)).collect();
        req_views[k].club = with.len() as u32;
        req_views[k].club_players = with.iter().take(3).map(|p| p.name.clone()).collect();
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
    // the manager: the one in the active squad, or the nation + league that would add the most
    let manager = {
        let gain_of = |m: Option<(u64, u64)>| chemistry_full(&xi, links, m).iter().sum::<u32>();
        let mut best: Option<((u64, u64), u32)> = None;
        for (p, in_pos) in &xi {
            if !*in_pos || p.is_icon() {
                continue;
            }
            for (q, _) in &xi {
                let m = (p.league, q.nation);
                let c = gain_of(Some(m));
                if best.is_none_or(|b| c > b.1) {
                    best = Some((m, c));
                }
            }
        }
        match (best, input.manager) {
            (Some((m, c)), cur) if c > total && Some(m) != cur => Some(ManagerView {
                league: m.0,
                league_name: input.names.league_short(m.0),
                nation: m.1,
                nation_name: input.names.nations.get(&m.1).cloned(),
                gain: c - total,
                current: false,
            }),
            (_, Some(m)) => Some(ManagerView { league: m.0, league_name: input.names.league_short(m.0), nation: m.1, nation_name: input.names.nations.get(&m.1).cloned(), gain: 0, current: true }),
            _ => None,
        }
    };
    let strength = if slots.is_empty() { 0.0 } else { round1(slots.iter().map(|s| s.strength).sum::<f64>() / slots.len() as f64) };
    let changes = (!input.active.is_empty()).then(|| placed.iter().filter(|&&(i, _)| !input.active.contains(&club[i].key)).count());
    let keys: BTreeSet<u64> = placed.iter().map(|&(i, _)| club[i].key).collect();
    let must_missing = prefs
        .must
        .iter()
        .filter(|k| !keys.contains(k))
        .map(|k| input.club.iter().find(|p| p.key == *k).map(|p| p.name.clone()).unwrap_or_else(|| format!("#{k}")))
        .collect();
    let buys = slots.iter().filter(|s| !s.owned).count();
    let sq = SquadView { formation: f.label.clone(), chem: total, chem_target: prefs.chem_target.min(33), met: req_views.iter().filter(|r| r.met).count(), slots, strength, changes, must_missing, buys, cost, manager };
    (sq, req_views)
}

/// The most sessions shown, the most places fully searched for one, the most plan stages.
const MAX_SESSIONS: usize = 5;
const MAX_TRIES: usize = 3;
const MAX_STAGES: usize = 4;
/// How much a long-running (bonus) objective weighs next to a live one: a tie-break only.
const BONUS_WEIGHT: f64 = 0.02;

/// An open objective a match moves on.
struct Item {
    ev: usize,
    obj: usize,
    modes: Vec<Mode>,
    req: Option<Req>,
    unknown: Option<String>,
    bonus: bool,
    /// Matches it takes from the last read (None: not known).
    matches: Option<f64>,
    /// The requirement to ask about ("is it still available?"), lower case.
    ask: Option<String>,
    /// Met from the bench too: no "starting 11" in its text, and the club has the cards (user
    /// 2026-11-01) – it never makes the plan buy, the XI takes it only when that's free.
    bench: bool,
}

/// Subs a match allows (FC: five).
const MAX_SUBS: usize = 5;
/// What a requirement the bench can meet weighs in the XI's search: about a tie – the XI takes the
/// card only when it costs nothing, the bench meets it otherwise (never a buy: `candidates` skips it).
const BENCH_WEIGHT: f64 = 0.01;

/// A goal or an assist: likelier from the start than from a sub.
fn scores(text: &str) -> bool {
    let l = text.to_lowercase();
    ["score", "goal", "assist"].iter().any(|k| l.contains(k))
}

/// "… in your starting 11" needs the cards from kickoff; any other squad part counts for a sub.
fn bench_counts(text: &str) -> bool {
    !text.to_lowercase().contains("starting")
}

/// One event's data for the plan.
struct Ev {
    g: Group,
    marked: BTreeSet<u64>,
    reqs: Vec<Req>,
    per_obj: Vec<(Option<usize>, Option<String>)>,
    live: bool,
}

/// About how many matches it takes to move an objective on by one, from its text and the user's
/// own results ("Win 7 matches" at a 86 % win rate ≈ 8 matches).
pub fn per_match(text: &str, r: &Rates) -> f64 {
    let l = text.to_lowercase();
    let special = ["header", "chip", "free kick", "outside the box", "volley", "penalt", "through ball", "cross", "finesse", "long shot", "bicycle", "trivela", "power shot"].iter().any(|k| l.contains(k));
    if l.contains("points") {
        // Rush bonus points: about 3,000 a match
        return 3000.0;
    }
    if l.contains("clean sheet") {
        return 0.35;
    }
    if l.starts_with("win the ") && l.contains("tournament") {
        // a tournament: about four wins in a row
        return r.win.powi(3) / 4.0;
    }
    if l.contains("separate matches") || l.contains("in one match") || l.contains("in 1 match") {
        if special {
            return 0.3;
        }
        if l.starts_with("assist") {
            return 0.75;
        }
        let n = l.find("at least ").and_then(|i| l[i + 9..].split_whitespace().next()).and_then(|w| w.parse::<u32>().ok()).unwrap_or(1);
        return match n {
            0 | 1 => 0.85,
            2 => 0.55,
            _ => 0.3,
        };
    }
    if l.starts_with("play") || l.starts_with("complete") {
        return 1.0;
    }
    if l.starts_with("win") {
        return r.win;
    }
    if l.starts_with("score") {
        return if special { 0.35 } else { r.goals };
    }
    if l.starts_with("assist") {
        return if special { 0.3 } else { r.assists };
    }
    1.0
}

/// What the plan works with.
struct Planner<'a> {
    input: &'a Input,
    prefs: &'a SquadPrefs,
    club: &'a [Player],
    formations: &'a [Formation],
    links: &'a BTreeMap<u64, u64>,
    evs: &'a [Ev],
    items: &'a [Item],
    /// Searches already run (the same requirements give the same XI).
    solved: std::cell::RefCell<BTreeMap<String, Option<Solved>>>,
}

/// A search's result: the formation, the pick and the cards it picked from (club + cards to buy).
#[derive(Debug, Clone)]
struct Solved {
    fi: usize,
    pick: Pick,
    players: std::rc::Rc<Vec<Player>>,
}

impl<'a> Planner<'a> {
    /// The same data, ready for other settings.
    fn clone_ref(&self) -> Planner<'a> {
        Planner { input: self.input, prefs: self.prefs, club: self.club, formations: self.formations, links: self.links, evs: self.evs, items: self.items, solved: Default::default() }
    }

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

    /// Cards to buy for the live requirements the club can't cover (the cheapest with a recent EA
    /// price first; without one, the cheapest-looking cards – shown as a profile to search for).
    fn candidates(&self, reqs: &[Req], weights: &[f64]) -> Vec<(Player, f64)> {
        if self.prefs.max_buys == Some(0) {
            return Vec::new();
        }
        let (buy, _) = goal_weights(self.prefs);
        let owned: BTreeSet<u64> = self.club.iter().map(|p| p.def_id).collect();
        let budget = self.prefs.budget.or(self.input.coins);
        let mut out: Vec<(Player, f64)> = Vec::new();
        for (r, &w) in reqs.iter().zip(weights) {
            if w < 0.5 || matches!(r.need, Need::Chemistry(_)) {
                continue;
            }
            let have = self.club.iter().filter(|p| r.need.met_by(p, self.links)).count() as u32;
            if have >= r.count {
                continue;
            }
            let short = (r.count - have) as usize;
            let fit: Vec<&Player> = self.input.catalog.iter().filter(|c| !owned.contains(&c.def_id) && !c.positions.is_empty() && !c.name.is_empty() && r.need.met_by(c, self.links)).collect();
            let mut priced: Vec<(&Player, u64)> = fit.iter().filter_map(|c| fresh_price(self.input, c.def_id).filter(|&p| budget.is_none_or(|b| p <= b)).map(|p| (*c, p))).collect();
            priced.sort_by_key(|x| x.1);
            let mut took = 0;
            for (c, p) in priced.into_iter().take(short + 5) {
                if !out.iter().any(|(x, _)| x.def_id == c.def_id) {
                    out.push((Player { key: c.def_id, owned: false, loan: false, ..c.clone() }, buy + p as f64 * 5.0));
                }
                took += 1;
            }
            if took == 0 {
                let mut cheap: Vec<&Player> = fit.into_iter().filter(|c| (68..=83).contains(&c.rating) && !c.is_icon() && !c.is_hero()).collect();
                cheap.sort_by_key(|c| c.rating);
                for c in cheap.into_iter().take(short + 3) {
                    if !out.iter().any(|(x, _)| x.def_id == c.def_id) {
                        out.push((Player { key: c.def_id, owned: false, loan: false, ..c.clone() }, buy * 1.5));
                    }
                }
            }
        }
        out
    }

    /// The XI for these requirements (club cards first, buys where they open objectives up).
    fn solve(&self, reqs: &[Req], weights: &[f64], keep_from: Option<&Solved>) -> Option<Solved> {
        if self.club.len() < 11 {
            return None;
        }
        // the squad to keep: the stage before, else the one the user plays
        let kept: Option<(BTreeSet<u64>, String)> = keep_from.map(|k| (k.pick.slots.iter().flatten().map(|&i| k.players[i].key).collect(), self.formations[k.fi].name.clone()));
        let key = format!("{reqs:?}{weights:?}{kept:?}");
        if let Some(hit) = self.solved.borrow().get(&key) {
            return hit.clone();
        }
        let (_, keep) = goal_weights(self.prefs);
        // between plan stages only what has to change changes (a kept card ≈ 1.25 chemistry points)
        let keep = if keep_from.is_some() { 5.0e5 } else { keep };
        let cands = self.candidates(reqs, weights);
        let mut players: Vec<Player> = self.club.to_vec();
        let mut cost = vec![0.0; players.len()];
        for (p, c) in cands {
            players.push(p);
            cost.push(c);
        }
        let opts = SolveOpts {
            weights,
            active: Some(kept.as_ref().map(|k| &k.0).unwrap_or(&self.input.active)),
            active_formation: kept.as_ref().map(|k| k.1.as_str()).or(self.input.active_formation.as_deref()),
            manager: self.input.manager,
            cost,
            max_buys: self.prefs.max_buys,
            keep,
        };
        let s = solve_with(&players, reqs, self.formations, self.prefs, self.links, opts).map(|(fi, pick)| Solved { fi, pick, players: std::rc::Rc::new(players) });
        self.solved.borrow_mut().insert(key, s.clone());
        s
    }

    fn weight(&self, i: usize, primary: Option<u64>) -> f64 {
        let it = &self.items[i];
        if it.bonus {
            BONUS_WEIGHT
        } else if it.bench && !scores(&self.evs[it.ev].g.objectives[it.obj].text) {
            // "play / win a match with …": a sub does it, the XI stays as it is; who has to score
            // or assist plays from the start when the club has him (the bench only instead of a buy)
            BENCH_WEIGHT
        } else if primary == Some(self.evs[it.ev].g.id) {
            20.0
        } else {
            1.0
        }
    }

    /// The bench (user 2026-11-01): requirements without "starting 11" the XI doesn't meet get club
    /// cards on the bench – subbed on late, the match reminders say when. Marks them met in `rv`;
    /// returns each bench card with the requirements (indices) it counts for.
    fn bench_for(&self, reqs: &[Req], benchable: &[bool], rv: &mut [ReqView], xi: &BTreeSet<u64>, room: usize) -> Vec<(Player, Vec<usize>)> {
        let mut picks: Vec<(Player, Vec<usize>)> = Vec::new();
        for k in 0..reqs.len() {
            if !benchable[k] || rv[k].met {
                continue;
            }
            let need = &reqs[k].need;
            let short = reqs[k].count.saturating_sub(rv[k].have) as usize;
            let from_picks: Vec<usize> = (0..picks.len()).filter(|&j| need.met_by(&picks[j].0, self.links)).take(short).collect();
            let more = short - from_picks.len();
            let open_here = |p: &Player| (0..reqs.len()).filter(|&j| benchable[j] && !rv[j].met && reqs[j].need.met_by(p, self.links)).count();
            let mut cands: Vec<&Player> = self.club.iter().filter(|p| p.owned && !xi.contains(&p.key) && !picks.iter().any(|(q, _)| q.key == p.key) && need.met_by(p, self.links)).collect();
            // a card that meets more of the open ones first, then the strongest
            cands.sort_by_key(|p| (std::cmp::Reverse(open_here(p)), std::cmp::Reverse(p.rating)));
            if cands.len() < more || picks.len() + more > room {
                continue;
            }
            for j in from_picks {
                picks[j].1.push(k);
            }
            for p in cands.into_iter().take(more) {
                picks.push((p.clone(), vec![k]));
            }
            rv[k].met = true;
            rv[k].have = reqs[k].count;
        }
        picks
    }

    /// A session at `place` over the open objectives in `avail`.
    fn session(&self, place: &Mode, avail: &[usize], primary: Option<u64>) -> (ComboPlan, Option<Solved>) {
        let here: Vec<usize> = avail.iter().copied().filter(|&i| plays_in(&self.items[i].modes, place)).collect();
        let mut reqs: Vec<Req> = Vec::new();
        let mut weights: Vec<f64> = Vec::new();
        let mut req_of: Vec<Option<usize>> = Vec::new();
        let mut benchable: Vec<bool> = Vec::new();
        for &i in &here {
            req_of.push(self.items[i].req.as_ref().map(|r| {
                reqs.push(r.clone());
                weights.push(self.weight(i, primary));
                benchable.push(self.items[i].bench);
                reqs.len() - 1
            }));
        }
        // Rush is played with its own five-a-side squad: no XI, a requirement counts when the club has the cards
        let solved = if here.is_empty() || *place == Mode::Rush { None } else { self.solve(&reqs, &weights, None) };
        let (squad, mut req_views) = match &solved {
            Some(s) => {
                let (sq, rv) = squad_view(&s.players, &self.formations[s.fi], &s.pick, &reqs, self.prefs, self.input, self.links);
                (Some(sq), rv)
            }
            None => (
                None,
                reqs.iter()
                    .map(|r| {
                        let with: Vec<&Player> = if *place == Mode::Rush { self.club.iter().filter(|p| r.need.met_by(p, self.links)).collect() } else { Vec::new() };
                        let have = (with.len() as u32).min(r.count);
                        ReqView { need: r.need.clone(), name: need_name(&r.need, &self.input.names), count: r.count, have, met: have >= r.count && !matches!(r.need, Need::Chemistry(_)), players: with.iter().take(3).map(|p| p.name.clone()).collect(), options: vec![], unpriced: 0, club: with.len() as u32, club_players: with.iter().take(3).map(|p| p.name.clone()).collect() }
                    })
                    .collect(),
            ),
        };
        // evolution players on the bench take subs first; the rest of the bench meets what the XI doesn't
        let evos = self.session_evos(place, solved.as_ref());
        let mut bench_picks: Vec<(Player, Vec<usize>)> = Vec::new();
        if let Some(s) = &solved {
            let xi: BTreeSet<u64> = s.pick.slots.iter().flatten().filter(|&&i| s.players[i].owned).map(|&i| s.players[i].key).collect();
            let room = MAX_SUBS.saturating_sub(evos.iter().filter(|e| !e.in_xi).count());
            bench_picks = self.bench_for(&reqs, &benchable, &mut req_views, &xi, room);
        }
        let on_bench = |k: usize| bench_picks.iter().any(|(_, ks)| ks.contains(&k));
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
                    bonus: it.bonus,
                    matches: it.matches.map(|m| round1((m - self.played() as f64).max(0.0))),
                    ask: it.ask.clone(),
                    bench: r.is_some_and(|k| on_bench(k)),
                }
            })
            .collect();
        let counted = items.iter().filter(|x| x.counts && !x.bonus).count();
        let bonus = items.iter().filter(|x| x.counts && x.bonus).count();
        // the events it moves on (all of them when nothing counts yet), the picked one first
        let mut events_in: Vec<usize> = here.iter().zip(&items).filter(|(_, x)| !x.bonus && (x.counts || counted == 0)).map(|(&i, _)| self.items[i].ev).collect();
        events_in.sort();
        events_in.dedup();
        events_in.sort_by_key(|&e| (primary != Some(self.evs[e].g.id), self.evs[e].g.ends_at.unwrap_or(u64::MAX)));
        let title = events_in.iter().map(|&e| self.evs[e].g.title.as_str()).collect::<Vec<_>>().join(" · ");
        let ends_at = events_in.iter().filter_map(|&e| self.evs[e].g.ends_at).min();
        let plan = ComboPlan { id: 0, place: place.clone(), place_name: self.place_name(place), title, ends_at, reqs: req_views, items, squad, counted, bonus, primary, stages: Vec::new(), played: self.played(), quick: None, evos, bench: Vec::new(), brief: MatchBrief::default() };
        let mut plan = plan;
        plan.bench = bench_picks
            .iter()
            .map(|(p, ks)| BenchPick {
                name: p.name.clone(),
                pos: p.positions.first().cloned().unwrap_or_default(),
                rating: p.rating,
                nation: p.nation,
                nation_name: self.input.names.nations.get(&p.nation).cloned(),
                objectives: plan.items.iter().filter(|x| x.req.is_some_and(|k| ks.contains(&k))).map(|x| if x.name.is_empty() { x.text.clone() } else { x.name.clone() }).collect(),
                reqs: ks.clone(),
            })
            .collect();
        (plan, solved)
    }

    /// The active evolutions a match at `place` moves on (their player in the club).
    fn session_evos(&self, place: &Mode, solved: Option<&Solved>) -> Vec<SessionEvo> {
        let now_s = self.input.now_ms / 1000;
        let xi: BTreeSet<u64> = solved.map(|s| s.pick.slots.iter().flatten().filter(|&&i| s.players[i].owned).map(|&i| s.players[i].key).collect()).unwrap_or_default();
        self.input
            .evos
            .iter()
            // a session that plays anywhere ("Win 10 matches in any mode") can be played where the evo counts
            .filter(|e| !e.modes.is_empty() && (*place == Mode::Any || plays_in(&e.modes, place)))
            .filter_map(|e| {
                let p = self.club.iter().find(|p| p.key == e.item)?;
                let g = e.goals.iter().find(|g| objective_modes(&g.text).is_some())?;
                Some(SessionEvo {
                    name: e.name.clone(),
                    player: p.name.clone(),
                    level: e.level,
                    levels: e.levels,
                    goal: g.text.clone(),
                    progress: g.progress,
                    target: g.target,
                    start: e.start,
                    in_xi: xi.contains(&e.item),
                    matches_left: e.matches_left,
                    days_left: e.ends_at.filter(|&t| t > now_s).map(|t| ((t - now_s) / 86_400) as u32),
                })
            })
            .collect()
    }

    fn played(&self) -> u32 {
        if self.prefs.played_at == self.input.read_at.unwrap_or(0) {
            self.prefs.played
        } else {
            0
        }
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

    /// The best session over `places`: the most live objectives counted (bonus ones break ties).
    /// The places are tried in the order of how many could count there, a full search only while
    /// one could still win.
    fn best(&self, places: &[Mode], avail: &[usize], primary: Option<u64>) -> Option<(ComboPlan, Option<Solved>)> {
        let live = |p: &Mode| avail.iter().filter(|&&i| !self.items[i].bonus && plays_in(&self.items[i].modes, p)).count();
        // Rush (its own squad) ranks at half, as its sessions do below
        let mut ranked: Vec<(usize, &Mode)> = places.iter().map(|p| (if *p == Mode::Rush { live(p) / 2 } else { live(p) }, p)).filter(|(n, _)| *n > 0).collect();
        ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
        let mut best: Option<(ComboPlan, Option<Solved>)> = None;
        let mut seen: Vec<Vec<usize>> = Vec::new();
        let mut tries = 0;
        for (upper, place) in ranked {
            if best.as_ref().is_some_and(|b| if b.0.place == Mode::Rush { b.0.counted / 2 } else { b.0.counted } >= upper) || tries >= MAX_TRIES {
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
            // a mode with its own squad (Rush) counts half against one that uses the user's XI
            let rank = |p: &ComboPlan| (if p.place == Mode::Rush { p.counted / 2 } else { p.counted }, p.bonus);
            if best.as_ref().is_none_or(|b| rank(&s.0) > rank(&b.0)) {
                best = Some(s);
            }
        }
        best
    }

    /// The match plan of a session: play its squad until an objective with a squad requirement is
    /// done, then the squad for what's left, and so on – each change named (out → in).
    fn stages(&self, s: &ComboPlan, first: &Solved, avail: &[usize], primary: Option<u64>) -> Vec<Stage> {
        let played = self.played() as f64;
        let here: Vec<usize> = avail.iter().copied().filter(|&i| plays_in(&self.items[i].modes, &s.place)).collect();
        let finish = |i: usize| self.items[i].matches.unwrap_or(f64::INFINITY);
        let mut out: Vec<Stage> = Vec::new();
        let mut cur = first.clone();
        let mut from = played;
        let mut t = played;
        let mut open: Vec<usize> = here.clone();
        let mut prev_xi: Option<(Vec<(String, Player)>, Vec<Req>)> = None;
        let reqs_of = |set: &[usize]| -> (Vec<Req>, Vec<f64>) {
            let mut r = Vec::new();
            let mut w = Vec::new();
            for &i in set {
                if let Some(q) = &self.items[i].req {
                    r.push(q.clone());
                    w.push(self.weight(i, primary));
                }
            }
            (r, w)
        };
        let bench_of = |set: &[usize]| -> Vec<bool> { set.iter().filter(|&&i| self.items[i].req.is_some()).map(|&i| self.items[i].bench).collect() };
        while out.len() < MAX_STAGES {
            let (reqs, _) = reqs_of(&open);
            let (sq, mut rv) = squad_view(&cur.players, &self.formations[cur.fi], &cur.pick, &reqs, self.prefs, self.input, self.links);
            {
                let xi: BTreeSet<u64> = cur.pick.slots.iter().flatten().filter(|&&i| cur.players[i].owned).map(|&i| cur.players[i].key).collect();
                let room = MAX_SUBS.saturating_sub(s.evos.iter().filter(|e| !e.in_xi).count());
                self.bench_for(&reqs, &bench_of(&open), &mut rv, &xi, room);
            }
            let met: Vec<bool> = rv.iter().map(|r| r.met).collect();
            // the open items this squad moves on, and when the first one with a squad part is done
            let counting: Vec<usize> = {
                let mut k = 0;
                open.iter()
                    .copied()
                    .filter(|&i| {
                        let ok = match &self.items[i].req {
                            Some(_) => {
                                let m = met[k];
                                k += 1;
                                m
                            }
                            None => true,
                        };
                        ok && self.items[i].unknown.is_none()
                    })
                    .collect()
            };
            let next = counting.iter().filter(|&&i| self.items[i].req.is_some() && !self.items[i].bonus).map(|&i| finish(i).ceil()).filter(|&m| m > t && m.is_finite()).fold(f64::INFINITY, f64::min);
            let end = if next.is_finite() && out.len() + 1 < MAX_STAGES { Some(next) } else { None };
            let xi: Vec<(String, Player)> = cur.pick.slots.iter().zip(&self.formations[cur.fi].slots).filter_map(|(p, pos)| p.map(|i| (pos.clone(), cur.players[i].clone()))).collect();
            let swaps = match &prev_xi {
                Some((old, _)) => swaps_between(old, &xi, self.input),
                None => Vec::new(),
            };
            let until = end.unwrap_or_else(|| counting.iter().map(|&i| finish(i).ceil()).filter(|m| m.is_finite()).fold(t, f64::max));
            let finishing: Vec<String> = counting
                .iter()
                .filter(|&&i| {
                    let m = finish(i).ceil();
                    m > from && m <= until && !self.items[i].bonus
                })
                .map(|&i| {
                    let o = &self.evs[self.items[i].ev].g.objectives[self.items[i].obj];
                    if o.name.is_empty() { o.text.clone() } else { o.name.clone() }
                })
                .collect();
            // the same XI as before: one longer stage
            if !out.is_empty() && swaps.is_empty() {
                if let Some(last) = out.last_mut() {
                    last.to = end.map(|e| e as u32);
                    last.finishing.extend(finishing);
                }
            } else {
                out.push(Stage { from: from as u32 + 1, to: end.map(|e| e as u32), squad: sq, reqs: rv, swaps, finishing });
            }
            let Some(e) = end else { break };
            // after `e` matches: what's done drops out, the rest gets its squad
            t = e;
            from = e;
            open.retain(|&i| finish(i).ceil() > e);
            if open.iter().all(|&i| self.items[i].req.is_none() || self.items[i].bonus) {
                if let Some(last) = out.last_mut() {
                    last.to = None;
                }
                break;
            }
            let (r, w) = reqs_of(&open);
            let Some(next_squad) = self.solve(&r, &w, Some(&cur)) else { break };
            prev_xi = Some((xi, reqs));
            cur = next_squad;
        }
        out
    }
}

/// The changes between two XIs: who goes out, who comes in (by position where they match).
fn swaps_between(old: &[(String, Player)], new: &[(String, Player)], input: &Input) -> Vec<Swap> {
    let out: Vec<&(String, Player)> = old.iter().filter(|(_, p)| !new.iter().any(|(_, q)| q.key == p.key)).collect();
    let ins: Vec<&(String, Player)> = new.iter().filter(|(_, p)| !old.iter().any(|(_, q)| q.key == p.key)).collect();
    let mut used = vec![false; out.len()];
    ins.iter()
        .map(|(pos, p)| {
            let k = (0..out.len()).find(|&k| !used[k] && out[k].0 == *pos).or_else(|| (0..out.len()).find(|&k| !used[k]));
            if let Some(k) = k {
                used[k] = true;
            }
            Swap {
                pos: pos.clone(),
                out_name: k.map(|k| out[k].1.name.clone()).unwrap_or_default(),
                in_name: p.name.clone(),
                in_rating: p.rating,
                in_owned: p.owned,
                in_price: (!p.owned).then(|| fresh_price(input, p.def_id)).flatten(),
                nation: p.nation,
                nation_name: input.names.nations.get(&p.nation).cloned(),
                league_name: input.names.league_short(p.league),
            }
        })
        .collect()
}

/// An event is live (Seasonal, Campaigns, FC Pro …) when it ends within this many seconds;
/// Foundations, Milestones and Mastery run for years.
const LIVE_WITHIN_S: u64 = 400 * 24 * 3600;

pub fn plan(input: &Input, prefs: &SquadPrefs) -> SquadsView {
    let links = link_map(&input.team_links);
    let formations = if input.formations.is_empty() { builtin_formations() } else { input.formations.clone() };
    let mut club: Vec<Player> = input.club.iter().filter(|p| !p.positions.is_empty() && (!(prefs.hide_loans && p.loan) || prefs.must.contains(&p.key))).cloned().collect();
    // a card EA names "---" that no catalog knows: its club and position, never an empty name
    for p in club.iter_mut().filter(|p| p.name.trim().is_empty()) {
        let team = input.names.team_name(p.club).unwrap_or("?");
        p.name = format!("{team} ({})", p.positions.first().map(String::as_str).unwrap_or(""));
    }
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
    // an active evolution that needs its player from the start: he starts (user 2026-11-01 – rare,
    // and the squad usually still fits)
    for e in input.evos.iter().filter(|e| e.start && !e.modes.is_empty()) {
        if club.iter().any(|p| p.key == e.item) && !prefs.must.contains(&e.item) {
            prefs.must.push(e.item);
        }
    }
    let prefs = &prefs;
    let owned_defs: BTreeSet<u64> = input.club.iter().map(|p| p.def_id).collect();
    let budget = prefs.budget.or(input.coins);
    let now_s = input.now_ms / 1000;
    // the user's own marks, while newer than the last read (a later sync says what EA says)
    let read_at = input.read_at.unwrap_or(0);
    let marks: Vec<&DoneMark> = prefs.done_marks.iter().filter(|m| m.at > read_at).collect();

    // 1. every event that hasn't ended – done ones too (the Completed filter shows them)
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
        let live = g.ends_at.is_some_and(|e| now_s == 0 || e <= now_s + LIVE_WITHIN_S);
        evs.push(Ev { g, marked, reqs, per_obj, live });
    }
    evs.sort_by_key(|e| e.g.ends_at.unwrap_or(u64::MAX));
    // the club is read (asking whether a card still exists makes sense only then)
    let club_known = club.len() >= 11;
    // a card in the club or among every card that exists meets it
    let obtainable = |need: &Need| matches!(need, Need::Chemistry(_)) || club.iter().any(|p| need.met_by(p, &links)) || input.catalog.iter().any(|p| need.met_by(p, &links));
    // the club has the cards to meet it from the bench
    let club_has = |q: &Req| club.iter().filter(|p| p.owned && q.need.met_by(p, &links)).count() >= q.count as usize;
    let items: Vec<Item> = evs
        .iter()
        .enumerate()
        .flat_map(|(e, ev)| {
            ev.g.objectives.iter().enumerate().filter(|(_, o)| !o.done).filter_map(move |(k, o)| {
                let modes = objective_modes(&o.text)?;
                let (r, u) = &ev.per_obj[k];
                // unreadable (an evolution, a program we can't name) or no card that exists meets it: the
                // user is asked whether it's still there (user 2026-11-01) – "no" leaves it out
                let doubt: Option<String> = match (r, u) {
                    (_, Some(u)) => Some(u.trim().to_lowercase()),
                    (Some(k), None) if !obtainable(&ev.reqs[*k].need) => Some(need_name(&ev.reqs[*k].need, &input.names).to_lowercase()),
                    _ => None,
                };
                // gone: the user said so, or users established it (and the user didn't say otherwise)
                if doubt.as_ref().is_some_and(|d| prefs.skip.contains(d) || (prefs.facts.get(d) == Some(&false) && !prefs.keep.contains(d))) {
                    return None;
                }
                // asked only for live objectives, and only about cards (a "starting squad of First Owned
                // players" is no card that can close)
                let ask = doubt.clone().filter(|d| club_known && ev.live && !d.contains("first owned") && !d.contains("starting squad") && !prefs.keep.contains(d) && !prefs.facts.contains_key(d));
                // an unreadable part with nothing to ask: not planned (the event's checklist shows it)
                if u.is_some() && ask.is_none() && !doubt.as_ref().is_some_and(|d| prefs.keep.contains(d)) {
                    return None;
                }
                let left = o.target.saturating_sub(o.progress) as f64;
                let matches = Some(left / per_match(&o.text, &input.rates).max(0.01));
                let req = r.map(|r| ev.reqs[r].clone());
                let bench = req.as_ref().is_some_and(|q| {
                    // only where it opens a live objective the XI does not meet (user 2026-11-01: a bench
                    // only when it makes sense for other challenges) – never for a long-running one
                    ev.live && bench_counts(&o.text) && !matches!(q.need, Need::Chemistry(_)) && q.count as usize <= MAX_SUBS && club_has(q)
                });
                Some(Item { ev: e, obj: k, modes, req, unknown: u.clone(), bonus: !ev.live, matches, ask, bench })
            })
        })
        .collect();
    let pl = Planner { input, prefs, club: &club, formations: &formations, links: &links, evs: &evs, items: &items, solved: Default::default() };

    // 2. sessions: the user's pick first (at the place they chose, else the best one for it), then
    // the most live objectives with what's left
    let mut avail: Vec<usize> = (0..items.len()).collect();
    let mut sessions: Vec<(ComboPlan, Option<Solved>)> = Vec::new();
    let primary = prefs.primary.filter(|p| evs.iter().any(|e| e.g.id == *p && items.iter().any(|i| evs[i.ev].g.id == *p)));
    let mut place_options: Vec<PlaceOption> = Vec::new();
    let done_in = |s: &ComboPlan, i: usize| s.items.iter().any(|x| x.counts && x.event == evs[items[i].ev].g.id && x.objective == evs[items[i].ev].g.objectives[items[i].obj].id);
    let mut first_avail: Vec<usize> = avail.clone();
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
        // "… or Live Events": every live event open now is a place for it (Phantom Playgrounds
        // in the Ghoul Fest live event – user 2026-10-31)
        if mine.iter().any(|&i| items[i].modes.iter().any(|m| matches!(m, Mode::LiveEvents | Mode::Any))) {
            for m in pl.places(&avail) {
                if matches!(m, Mode::Event(_)) && !places.contains(&m) {
                    places.push(m);
                }
            }
        }
        place_options = places
            .iter()
            .filter(|m| mine.iter().any(|&i| plays_in(&items[i].modes, m)))
            .map(|m| PlaceOption { place: m.clone(), name: pl.place_name(m), objectives: avail.iter().filter(|&&i| !items[i].bonus && plays_in(&items[i].modes, m)).count() })
            .collect();
        place_options.sort_by(|a, b| b.objectives.cmp(&a.objectives));
        let chosen: Vec<Mode> = match &prefs.place {
            Some(m) if place_options.iter().any(|o| &o.place == m) => vec![m.clone()],
            _ => place_options.iter().map(|o| o.place.clone()).collect(),
        };
        if let Some(s) = pl.best(&chosen, &avail, Some(p)) {
            avail.retain(|&i| !done_in(&s.0, i));
            sessions.push(s);
        }
    }
    while sessions.len() < MAX_SESSIONS && avail.iter().any(|&i| !items[i].bonus) {
        let places = pl.places(&avail);
        let Some(s) = pl.best(&places, &avail, None) else { break };
        if s.0.counted == 0 {
            // what no squad of the club can clear yet: one last session shows what to get
            if s.0.reqs.iter().any(|r| !r.met) && sessions.iter().all(|x| x.0.place != s.0.place || x.0.counted > 0) {
                sessions.push(s);
            }
            break;
        }
        if sessions.is_empty() {
            first_avail = avail.clone();
        }
        avail.retain(|&i| !done_in(&s.0, i));
        sessions.push(s);
    }
    // a short squad for what the first one can't clear in a few matches (user 2026-11-01: "3
    // Mexicans for 1 match is a clear option – Play 1: Team X"): chemistry doesn't matter for it
    if let Some(first) = sessions.first().map(|x| x.0.clone()) {
        let cleared = |i: usize| sessions.iter().any(|(s, _)| done_in(s, i));
        let short: Vec<usize> = (0..items.len())
            .filter(|&i| {
                let it = &items[i];
                !it.bonus && it.req.is_some() && it.ask.is_none() && it.unknown.is_none() && it.matches.is_some_and(|m| m <= 3.0) && !cleared(i) && plays_in(&it.modes, &first.place)
            })
            .collect();
        if !short.is_empty() {
            let quick_prefs = SquadPrefs { chem_target: 0, chem_first: false, max_buys: prefs.max_buys.map(|m| m.max(if m == 0 { 0 } else { 3 })), ..prefs.clone() };
            let qp = Planner { prefs: &quick_prefs, solved: Default::default(), ..pl.clone_ref() };
            let (mut q, solved) = qp.session(&first.place, &short, None);
            if q.counted > 0 {
                let n = q.items.iter().filter(|x| x.counts).filter_map(|x| x.matches).fold(1.0f64, f64::max).ceil() as u32;
                q.quick = Some(n.max(1));
                q.items.retain(|x| x.counts);
                sessions.insert(1.min(sessions.len()), (q, solved));
            }
        }
    }
    // the match plan of the first session (the one the user plays now)
    if let Some((s, Some(solved))) = sessions.first_mut() {
        let stages = pl.stages(s, solved, &first_avail, primary);
        s.stages = stages;
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
            .filter(|(e, ev)| ev.live && items.iter().any(|i| i.ev == *e) && !items.iter().any(|i| i.ev == *e && plays_in(&i.modes, &s.place)))
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
                .map(|(o, (r, u))| ObjectiveView { id: o.id, marked: ev.marked.contains(&o.id), name: o.name.clone(), text: o.text.clone(), progress: o.progress.min(o.target), target: o.target, done: o.done, req: *r, unknown: u.clone(), playable: objective_modes(&o.text).is_some() })
                .collect();
            let empty = || ev.reqs.iter().map(|r| ReqView { need: r.need.clone(), name: need_name(&r.need, &input.names), count: r.count, have: 0, met: false, players: vec![], options: vec![], unpriced: 0, club: 0, club_players: vec![] }).collect::<Vec<_>>();
            let best = sessions
                .iter()
                .filter(|(s, _)| s.items.iter().any(|x| x.event == ev.g.id))
                .max_by(|a, b| {
                    let n = |s: &ComboPlan| s.items.iter().filter(|x| x.event == ev.g.id && x.counts).count();
                    n(&a.0).cmp(&n(&b.0)).then(b.0.id.cmp(&a.0.id))
                });
            let (combo, squad, mut reqs) = match best {
                Some((s, Some(sol))) if !ev.reqs.is_empty() => {
                    let (sq, rv) = squad_view(&sol.players, &formations[sol.fi], &sol.pick, &ev.reqs, prefs, input, &links);
                    (Some(s.id), Some(sq), rv)
                }
                Some((s, _)) => (Some(s.id), None, empty()),
                None => (None, None, empty()),
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
            EventPlan {
                id: ev.g.id,
                title: ev.g.title.clone(),
                ends_at: ev.g.ends_at,
                done,
                total: ev.g.objectives.len(),
                objectives,
                reqs,
                squad,
                combo,
                category: ev.g.category.clone(),
                category_id: ev.g.category_id,
                live: ev.live,
                playable: items.iter().any(|i| evs[i.ev].g.id == ev.g.id),
            }
        })
        .collect();
    SquadsView {
        events,
        combos: sessions
            .into_iter()
            .map(|(mut c, _)| {
                c.brief = match_brief(&c);
                c
            })
            .collect(),
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
    // every card with a price that ticks it (when none is as strong as the card it replaces)
    let mut any_priced: Vec<Buy> = Vec::new();
    let mut no_price: Vec<(&Player, String)> = Vec::new();
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
                } else {
                    any_priced.push(Buy { price: c, score, p, strength: strength(p, &pos), pos });
                }
            }
            Some(_) => {}
            None => {
                unpriced += 1;
                no_price.push((p, pos));
            }
        }
    }
    out.truncate(2);
    // for an objective a cheaper card still ticks the box (Ovalle for "3 Mexicans")
    if priced.is_empty() {
        priced = any_priced;
    }
    // no price at all: name cards to search for on the market, the most common kind first
    if priced.is_empty() && out.is_empty() {
        no_price.sort_by_key(|(p, _)| (p.rating < 65, p.rating, p.def_id));
        for (p, pos) in no_price.into_iter().filter(|(p, _)| !p.is_icon() && !p.is_hero()).take(2) {
            unpriced -= 1;
            out.push(GetOption { kind: "search".into(), name: p.name.clone(), def_id: p.def_id, rating: p.rating, pos: pos.clone(), price: None, source: None, strength: round1(strength(p, &pos)), nation: p.nation, nation_name: input.names.nations.get(&p.nation).cloned() });
        }
        return (out, unpriced);
    }
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
    let positions = play.map(|p| p.positions.clone()).filter(|v| !v.is_empty()).or_else(|| card.map(|c| c.positions.clone()).filter(|v| !v.is_empty()))
        // a card the catalog does not have (FC-Tracker Web, 2026-11-01: Therkildsen): its own position
        .or_else(|| item.position.clone().filter(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_uppercase())).map(|p| vec![p]))
        .unwrap_or_default();
    let face = play
        .filter(|p| p.face.len() == 6)
        .map(|p| std::array::from_fn(|i| p.face[i] as u32))
        .or_else(|| card.filter(|c| c.face.len() == 6).map(|c| std::array::from_fn(|i| c.face[i] as u32)));
    Some(Player {
        key: item.id,
        def_id,
        // EA names some cards "---" (no licence): the club stands in
        // each source in turn: EA writes "---" for many cards in the club data – the catalog has the name
        name: [item.name.clone(), card.and_then(|c| c.name.clone()), catalog.get(&crate::sync_data::base_id(def_id)).and_then(|c| c.name.clone()), item.full_name.clone()].into_iter().flatten().find(|n| n.chars().any(char::is_alphanumeric)).or_else(|| card.and_then(|c| c.team_name.clone())).unwrap_or_default(),
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
/// The active squad's manager: (league, nation).
pub fn active_manager(usermassinfo: &Value) -> Option<(u64, u64)> {
    let m = usermassinfo.pointer("/squad/manager/0")?;
    Some((m.get("leagueId")?.as_u64()?, m.get("nation").and_then(Value::as_u64).or_else(|| m.get("nationId").and_then(Value::as_u64))?))
}

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
    fn leagues_show_as_players_say_them() {
        let n = Names::from_value(&json!({ "leagues": { "53": ["LALIGA EA SPORTS", "LALIGA EA SPORTS", "ESP 1"], "16": ["Ligue 1 McDonald's", "Ligue 1 McDonald's", "FRA 1"], "2216": ["Barclays Women’s Super League", "Barclays WSL", "ENG 1"], "341": ["Liga BBVA MX", "Liga BBVA MX", "MEX 1"], "13": ["Premier League", "Premier League", "ENG 1"] } }));
        let s = |id| n.league_short(id).unwrap();
        assert_eq!((s(53), s(16), s(2216), s(341), s(13)), ("LaLiga (ESP 1)".into(), "Ligue 1 (FRA 1)".into(), "WSL (ENG 1)".into(), "Liga MX (MEX 1)".into(), "Premier League (ENG 1)".into()));
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
            league: 0, league_name: None, out_of_position: false, generic: false, evo: None,
        };
        SquadView { formation: "4-3-3".into(), chem: 30, chem_target: 33, slots: vec![slot], strength, met: 0, changes: None, must_missing: vec![], buys: 0, cost: 0, manager: None }
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
        assert_eq!(p("Play 10 matches while having min. 1 Future Stars Academy player in your starting XI in Squad Battles"), sq(Need::Rarity(vec![161]), 1));
        assert_eq!(p("Score 50 goals while having Min. 1 Ultimate Scream Player in your starting XI"), sq(Need::Rarity(vec![160]), 1));
        assert_eq!(p("Score at least 1 goal with a Future Stars Academy player in Squad Battles"), sq(Need::Rarity(vec![161]), 1));
        // no requirement hides in these
        for t in ["Play 3 matches with the Mexico National team Away kit equipped in any FUT game mode.", "Score at least one Chip Shot goal in 5 separate matches", "Win 10 matches in Squad Battles on min. Semi-Pro difficulty (or Rivals/Champions/Live Events/Rush)."] {
            assert_eq!(p(t), Parsed::None, "{t}");
        }
    }

    // ---------- the planner's scenarios (user 2026-10-31: "a valid plan or a precise reason") ----------

    /// A 4-4-2 club of 16 Spanish LALIGA cards (league 53, nation 45), ids 1…16.
    fn spanish_club() -> Vec<Player> {
        let pos = ["GK", "RB", "CB", "CB", "LB", "RM", "CM", "CM", "LM", "ST", "ST", "CB", "CM", "ST", "RB", "GK"];
        pos.iter().enumerate().map(|(i, p)| pl(i as u64 + 1, &letters(i as u64 + 1), 84, &[p], 53, 240 + (i as u64 % 3), 45)).collect()
    }

    fn scenario_names() -> Names {
        let mut n = names();
        n.nations.insert(23, "Hungary".into());
        n.nations.insert(45, "Spain".into());
        n.nations.insert(83, "Mexico".into());
        n
    }

    /// An input with these events (open, ending in a week) over the Spanish club.
    fn scenario(events: serde_json::Value) -> Input {
        let now_s = 1_800_000_000u64;
        let mut groups = groups_from_value(&events);
        for g in &mut groups {
            g.ends_at = g.ends_at.or(Some(now_s + 7 * 86_400));
        }
        Input {
            groups,
            names: scenario_names(),
            names_known: true,
            club: spanish_club(),
            now_ms: now_s * 1000,
            read_at: Some(now_s * 1000 - 60_000),
            rates: Rates { win: 0.5, goals: 2.0, assists: 1.5 },
            ..Input::empty()
        }
    }

    fn ev(id: u64, title: &str, objs: &[(u64, &str, u32, u32)]) -> serde_json::Value {
        json!({ "id": id, "title": title, "categoryId": 3, "category": "Seasonal", "objectives": objs.iter().map(|(oid, text, p, t)| json!({ "id": oid, "name": format!("O{oid}"), "description": text, "progress": p, "target": t })).collect::<Vec<_>>() })
    }

    fn priced(input: &mut Input, def: u64, coins: u64) {
        input.prices.insert(def, Price { bin: 0, listings: 0, at: input.now_ms, avg: Some(coins), shared: false });
    }

    #[test]
    fn scenario_a_nation_requirement_is_only_met_by_that_nation_and_a_card_to_buy_fills_it() {
        let mut input = scenario(json!({ "groups": [ev(1, "Phantom", &[(11, "Win 5 matches while having min. 1 Hungarian player in your starting XI in any FUT game mode.", 0, 5)])] }));
        // the Hungarian on the market (a CB, 900 coins)
        input.catalog = vec![Player { owned: false, ..pl(500, "Szalai", 76, &["CB"], 10, 77, 23) }];
        priced(&mut input, 500, 900);
        let v = plan(&input, &SquadPrefs::default());
        let s = &v.combos[0];
        let sq = s.squad.as_ref().unwrap();
        let hu = sq.slots.iter().find(|x| x.nation == 23).expect("the squad has a Hungarian");
        assert!(!hu.owned && hu.price == Some(900) && !hu.generic && sq.buys == 1);
        assert!(s.items[0].counts);
        // club cards only: no Hungarian → the objective does not count, never "met" without one
        let v = plan(&input, &SquadPrefs { max_buys: Some(0), ..SquadPrefs::default() });
        let s = &v.combos[0];
        assert!(s.squad.as_ref().unwrap().slots.iter().all(|x| x.nation != 23));
        assert!(!s.items[0].counts && !s.reqs[0].met);
    }

    #[test]
    fn scenario_no_price_known_gives_a_profile_to_search_for() {
        let mut input = scenario(json!({ "groups": [ev(1, "Phantom", &[(11, "Win 5 matches while having min. 1 Hungarian player in your starting XI in any FUT game mode.", 0, 5)])] }));
        input.catalog = vec![Player { owned: false, ..pl(500, "Szalai", 76, &["CB"], 10, 77, 23) }];
        let v = plan(&input, &SquadPrefs::default());
        let slot = v.combos[0].squad.as_ref().unwrap().slots.iter().find(|x| x.nation == 23).cloned().expect("a Hungarian profile");
        assert!(slot.generic && slot.price.is_none() && slot.pos == "CB");
    }

    #[test]
    fn scenario_two_challenges_together_without_changes() {
        let input = scenario(json!({ "groups": [
            ev(1, "A", &[(11, "Win 3 matches in any FUT game mode while having min. 2 Spanish players in your starting 11.", 0, 3)]),
            ev(2, "B", &[(21, "Play 3 matches while having min. 3 player items from LALIGA in your starting 11 in any FUT game mode.", 0, 3)]) ] }));
        let v = plan(&input, &SquadPrefs::default());
        assert_eq!(v.combos.len(), 1);
        assert_eq!(v.combos[0].counted, 2);
        assert_eq!(v.combos[0].squad.as_ref().unwrap().buys, 0);
    }

    #[test]
    fn scenario_different_modes_are_never_combined_and_say_why() {
        let input = scenario(json!({ "groups": [
            ev(1, "Ghoul Fest", &[(11, "Score at least 1 goal in 13 separate matches in the Ghoul Fest Live Event.", 0, 13)]),
            ev(2, "Heritage", &[(21, "Win 2 matches in the FC Heritage Circuit Tournament.", 0, 2)]) ] }));
        let v = plan(&input, &SquadPrefs { primary: Some(1), ..SquadPrefs::default() });
        let s = &v.combos[0];
        assert_eq!(s.place, Mode::Event("ghoul fest".into()));
        // an objective for "… or Live Events" picked: the live event is offered as a place
        let mut both = scenario(json!({ "groups": [
            ev(1, "Ghoul Fest", &[(11, "Score at least 1 goal in 13 separate matches in the Ghoul Fest Live Event.", 0, 13)]),
            ev(3, "Phantom", &[(31, "Win 5 matches in Squad Battles on min. Semi-Pro difficulty (or Rivals/Live Events/Rush/Champions).", 0, 5)]) ] }));
        both.now_ms += 1;
        let v2 = plan(&both, &SquadPrefs { primary: Some(3), ..SquadPrefs::default() });
        assert!(v2.places.iter().any(|p| p.place == Mode::Event("ghoul fest".into())));
        assert_eq!(v2.combos[0].place, Mode::Event("ghoul fest".into()), "most objectives: in the live event");
        assert!(s.items.iter().all(|x| x.event == 1));
        let apart = v.apart.iter().find(|a| a.event == 2).expect("Heritage listed apart");
        assert!(!apart.places.is_empty());
    }

    #[test]
    fn scenario_done_and_partly_done_objectives() {
        let input = scenario(json!({ "groups": [ev(1, "Weekly", &[
            (11, "Play 10 matches in any FUT game mode.", 10, 10),
            (12, "Win 10 matches in any FUT game mode.", 6, 10)])] }));
        let v = plan(&input, &SquadPrefs::default());
        let items = &v.combos[0].items;
        // the done one is not planned again; the other from what's left: 4 wins at 50 % ≈ 8 matches
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].objective, 12);
        assert_eq!(items[0].matches, Some(8.0));
        // the event still knows both (the Completed filter)
        assert_eq!(v.events[0].done, 1);
    }

    #[test]
    fn scenario_the_plan_changes_the_squad_when_a_requirement_is_done() {
        let mut input = scenario(json!({ "groups": [
            ev(1, "Short", &[(11, "Play 3 matches while having min. 1 Hungarian player in your starting XI in any FUT game mode.", 0, 3)]),
            ev(2, "Long", &[(21, "Play 8 matches while having min. 1 Mexican player in your starting XI in any FUT game mode.", 0, 8)]) ] }));
        // keepers that tick them: only one can play at a time
        input.club.push(pl(100, "Hungarian GK", 70, &["GK"], 53, 240, 23));
        input.club.push(pl(101, "Mexican GK", 70, &["GK"], 53, 241, 83));
        let v = plan(&input, &SquadPrefs { chem_target: 0, ..SquadPrefs::default() });
        let st = &v.combos[0].stages;
        assert!(st.len() >= 2, "{st:?}");
        assert_eq!((st[0].from, st[0].to), (1, Some(3)));
        assert_eq!(st[1].from, 4);
        // after 3 matches the Hungarian goes; the Mexican stays
        assert!(st[1].swaps.iter().any(|w| w.out_name == "Hungarian GK" && w.in_name == "Mexican GK"));
        assert!(st[1].squad.slots.iter().any(|x| x.nation == 83));
    }

    #[test]
    fn scenario_fc27_chemistry_icons_heroes_manager_and_out_of_position() {
        let links = BTreeMap::new();
        let es = |k| pl(k, "ES", 80, &["CM"], 53, 240 + k, 45);
        let icon = Player { league: ICON_LEAGUE, ..pl(9, "Icon", 90, &["CM"], ICON_LEAGUE, 112658, 45) };
        // two Spaniards: 2 for the nation (1 point); 2 in LALIGA (none yet)
        let (a, b) = (es(1), es(2));
        assert_eq!(chemistry_full(&[(&a, true), (&b, true)], &links, None), vec![1, 1]);
        // an Icon adds 1 to every league (LALIGA → 3 = 1 point) and only 1 to its nation
        let c = chemistry_full(&[(&a, true), (&b, true), (&icon, true)], &links, None);
        assert_eq!(c, vec![2, 2, 3]);
        // a Hero: +1 to its league, +1 to its nation (no longer 2)
        let hero = Player { rareflag: HERO_RAREFLAG, ..pl(8, "Hero", 88, &["ST"], 53, 114605, 18) };
        assert_eq!(chemistry_full(&[(&a, true), (&b, true), (&hero, true)], &links, None), vec![2, 2, 3]);
        // the manager: +1 league and +1 nation, at most one point more for a card
        assert_eq!(chemistry_full(&[(&a, true), (&b, true)], &links, Some((53, 45))), vec![2, 2]);
        // out of position: 0 and adds to nobody
        assert_eq!(chemistry_full(&[(&a, true), (&b, false), (&icon, false)], &links, None), vec![0, 0, 0]);
    }

    #[test]
    fn scenario_a_club_card_may_stand_out_of_position_for_a_requirement() {
        let mut input = scenario(json!({ "groups": [ev(1, "Phantom", &[(11, "Win 5 matches while having min. 1 Hungarian player in your starting XI in any FUT game mode.", 0, 5)])] }));
        // the only Hungarian is a CAM; the formation has no CAM
        input.club.push(pl(100, "Hungarian CAM", 80, &["CAM"], 53, 240, 23));
        let v = plan(&input, &SquadPrefs { formation: Some("f442".into()), max_buys: Some(0), ..SquadPrefs::default() });
        let sq = v.combos[0].squad.as_ref().unwrap();
        let hu = sq.slots.iter().find(|x| x.nation == 23).expect("the Hungarian plays");
        assert!(hu.out_of_position && hu.chem == 0);
        assert!(v.combos[0].items[0].counts);
    }

    #[test]
    fn scenario_bonus_objectives_count_but_never_shape_the_squad() {
        let mut input = scenario(json!({ "groups": [
            ev(1, "Weekly", &[(11, "Play 5 matches in any FUT game mode.", 0, 5)]),
            { "id": 2, "title": "Mastery", "categoryId": 2, "category": "Mastery", "endTime": 1_948_640_399u64, "objectives": [{ "id": 21, "name": "M", "description": "Win 50 matches while having min. 1 Mexican player in your starting 11 in any FUT game mode.", "progress": 0, "target": 50 }] } ] }));
        input.catalog = vec![Player { owned: false, ..pl(500, "Mexican", 76, &["ST"], 10, 77, 83) }];
        priced(&mut input, 500, 500);
        let v = plan(&input, &SquadPrefs::default());
        let s = &v.combos[0];
        // no buy for a Mastery objective
        assert_eq!(s.squad.as_ref().unwrap().buys, 0);
        assert_eq!(s.counted, 1);
        assert!(v.events.iter().any(|e| e.id == 2 && !e.live));
    }

    #[test]
    fn scenario_the_users_formation_and_buy_limit_hold() {
        let mut input = scenario(json!({ "groups": [ev(1, "Mexico", &[(11, "Play 1 match with 3 Mexican players in your starting XI in any FUT game mode.", 0, 1)])] }));
        input.catalog = (0..3).map(|k| Player { owned: false, ..pl(500 + k, &letters(500 + k), 76, &["ST", "CM", "CB"], 10, 77, 83) }).collect();
        for k in 0..3 {
            priced(&mut input, 500 + k, 700);
        }
        let v = plan(&input, &SquadPrefs { max_buys: Some(2), formation: Some("f442".into()), ..SquadPrefs::default() });
        let sq = v.combos[0].squad.as_ref().unwrap();
        assert_eq!(sq.formation, "4-4-2");
        assert!(sq.buys <= 2);
        assert!(!v.combos[0].items[0].counts, "3 needed, 2 allowed: not met, not claimed");
    }

    #[test]
    fn scenario_a_requirement_no_card_meets_is_asked_about_then_left_out() {
        let mut input = scenario(json!({ "groups": [ev(1, "Academy", &[(11, "Play 10 matches while having min. 1 Future Stars Academy player in your starting XI in any FUT game mode.", 0, 10), (12, "Play 2 matches in any FUT game mode.", 0, 2)])] }));
        input.names.rarities.insert(66, "Future Stars".into());
        // "Future Stars Academy" is not the "Future Stars" program: not read, asked about
        let v = plan(&input, &SquadPrefs::default());
        let it = v.combos[0].items.iter().find(|x| x.objective == 11).expect("shown with the question");
        assert_eq!(it.ask.as_deref(), Some("future stars academy"));
        // the user (or the users together) say it's gone: left out, the rest planned again
        for p in [SquadPrefs { skip: vec!["future stars academy".into()], ..SquadPrefs::default() }, SquadPrefs { facts: [("future stars academy".to_string(), false)].into(), ..SquadPrefs::default() }] {
            let v = plan(&input, &p);
            assert!(v.combos[0].items.iter().all(|x| x.objective != 11));
            assert!(v.combos[0].items.iter().any(|x| x.objective == 12 && x.counts));
        }
        // still there: kept, not asked again
        let v = plan(&input, &SquadPrefs { keep: vec!["future stars academy".into()], ..SquadPrefs::default() });
        assert!(v.combos[0].items.iter().any(|x| x.objective == 11 && x.ask.is_none()));
    }

    #[test]
    fn scenario_a_one_match_objective_gets_its_own_squad() {
        let mut input = scenario(json!({ "groups": [
            ev(1, "Weekly", &[(11, "Win 10 matches in any FUT game mode.", 0, 10)]),
            ev(2, "Liga MX", &[(21, "Play 1 match with 3 Mexican players in your starting XI in any FUT game mode.", 0, 1)]) ] }));
        input.catalog = (0..4).map(|k| Player { owned: false, ..pl(600 + k, &letters(600 + k), 70, &["CM", "CB", "ST"], 10 + k, 77 + k, 83) }).collect();
        for k in 0..4 {
            priced(&mut input, 600 + k, 600);
        }
        // high chemistry: the main squad won't take three lone Mexicans …
        let v = plan(&input, &SquadPrefs { chem_first: true, ..SquadPrefs::default() });
        let q = v.combos.iter().find(|c| c.quick.is_some()).expect("a one-match squad");
        assert_eq!(q.quick, Some(1));
        // … the one-match squad does, with the cards to buy named
        assert!(q.items.iter().any(|x| x.objective == 21 && x.counts));
        assert_eq!(q.squad.as_ref().unwrap().slots.iter().filter(|x| x.nation == 83).count(), 3);
    }

    /// EA's Evolutions hub as the sync reads it (texts as EA writes them, 2026-11-01).
    fn evo_hub() -> serde_json::Value {
        let lvl = |level: u64, state: &str, objs: &[(&str, u64, u64, &str)]| json!({ "level": level, "levelState": state, "objectives": objs.iter().map(|(t, p, m, s)| json!({ "name": t, "currentProgress": p, "multiplier": m, "state": s })).collect::<Vec<_>>() });
        let sb = "Play 1 match in Squad Battles on min Semi-Pro difficulty (or Rush/Rivals/Champions/Live Events) using your active EVO player in game.";
        json!({ "activeSlotIds": [2815, 2900, 2839], "activeTimedSlotIds": [2839], "slots": [
            { "id": 2815, "slotName": "Center Spectre", "realPlayerId": 14, "endTime": 1_800_000_000u64 + 8 * 86_400, "status": "ACTIVE", "levels": [
                { "level": 0, "levelState": "COMPLETED" },
                lvl(1, "IN_PROGRESS", &[(sb, 0, 1, "IN_PROGRESS")]),
                lvl(2, "NOT_STARTED", &[(sb, 0, 1, "IN_PROGRESS")]),
                lvl(3, "NOT_STARTED", &[("Play 2 matches in Squad Battles on min. Semi-Pro difficulty (or Rush/Rivals/Champions/Live Events) using your active EVO Player in game.", 0, 2, "IN_PROGRESS")]) ] },
            { "id": 2900, "slotName": "Goal Ghost", "realPlayerId": 13, "endTime": 0, "status": "ACTIVE", "levels": [
                lvl(1, "IN_PROGRESS", &[("Score 2 goals in any mode using your active EVO player.", 1, 2, "IN_PROGRESS")]) ] },
            { "id": 2839, "slotName": "Rise From the Grave", "realPlayerId": 12, "endTime": 0, "status": "ACTIVE", "levels": [
                lvl(1, "COMPLETED", &[("Send your Player to Training Camp.", 17280, 17280, "COMPLETED")]),
                lvl(2, "IN_PROGRESS", &[("Send your Player to Training Camp.", 1_793_541_366, 17280, "IN_PROGRESS")]) ] },
            { "id": 2813, "slotName": "Poor Sophia", "realPlayerId": 16, "status": "INACTIVE", "levels": [
                lvl(1, "IN_PROGRESS", &[("Play 2 matches in any mode using your active EVO player in game.", 0, 2, "IN_PROGRESS")]) ] } ] })
    }

    #[test]
    fn scenario_a_card_that_counts_for_a_sub_waits_on_the_bench() {
        let mut input = scenario(json!({ "groups": [
            ev(1, "Weekly", &[(11, "Win 3 matches in Squad Battles.", 0, 3)]),
            ev(2, "Liga MX", &[(21, "Play 2 matches with min. 1 Mexican player in Squad Battles.", 0, 2), (22, "Win 1 match with min. 1 Mexican player in your starting 11 in Squad Battles.", 0, 1)]) ] }));
        input.club.push(pl(99, "Corona", 70, &["RW"], 99, 99, 83));
        let v = plan(&input, &SquadPrefs::default());
        let s = &v.combos[0];
        let xi = s.squad.as_ref().unwrap();
        // the starting-11 one takes him into the XI …
        if xi.slots.iter().any(|x| x.name == "Corona") {
            assert!(s.bench.is_empty(), "in the XI already: no bench needed");
            return;
        }
        // … or he waits on the bench for the one a sub does, and that one counts
        assert_eq!(s.bench.len(), 1);
        assert_eq!(s.bench[0].name, "Corona");
        let play = s.items.iter().find(|x| x.objective == 21).unwrap();
        assert!(play.counts && play.bench);
        assert!(!s.items.iter().find(|x| x.objective == 22).unwrap().bench, "starting 11 never counts from the bench");
    }

    #[test]
    fn the_match_brief_says_what_to_do_before_and_who_does_what_in_the_match() {
        assert_eq!(short_task("Score 1 header in the Ghoul Fest Live Event."), "Score 1 header");
        assert_eq!(short_task("Score 10 goals in any FUT game mode using a player from Germany."), "Score 10 goals");
        assert_eq!(gear("Play 1 match using the Mexico National team Away kit in any FUT game mode.").as_deref(), Some("Mexico National team Away kit"));
        let mut input = scenario(json!({ "groups": [
            ev(1, "Ghoul Fest", &[
                (11, "Score 3 goals using a player from Spain in Squad Battles.", 0, 3),
                (12, "Score 1 header in Squad Battles.", 0, 1),
                (13, "Win 2 matches in Squad Battles.", 0, 2),
                (14, "Play 1 match using the Mexico National team Away kit in Squad Battles.", 0, 1) ]) ] }));
        input.club.push(pl(99, "Corona", 70, &["RW"], 99, 99, 83));
        let v = plan(&input, &SquadPrefs::default());
        let b = &v.combos[0].brief;
        // before: the squad, the kit
        assert!(b.before.iter().any(|x| x.kind == "squad" || x.kind == "ready"));
        assert!(b.before.iter().any(|x| x.kind == "use" && x.text == "Mexico National team Away kit"));
        // in the match: a Spaniard (never the keeper) scores, the striker heads one in, anyone wins
        let spain = b.players.iter().find(|p| p.tasks.iter().any(|t| t.text == "Score 3 goals")).expect("a scorer");
        assert_ne!(spain.pos, "GK");
        assert!(b.players.iter().any(|p| is_attacker(&p.pos) && p.tasks.iter().any(|t| t.text == "Score 1 header")));
        assert!(b.anyone.iter().any(|t| t.text == "Win 2 matches" && t.left == 2));
    }

    #[test]
    fn scenario_the_bench_is_only_for_what_the_xi_leaves_open() {
        let mut input = scenario(json!({ "groups": [ev(1, "Liga MX", &[(21, "Play 2 matches with min. 1 Mexican player in Squad Battles.", 0, 2)])] }));
        input.club.push(pl(99, "Corona", 70, &["RW"], 99, 99, 83));
        // without objectives a sub could do, nobody waits on the bench
        let none = scenario(json!({ "groups": [ev(1, "Weekly", &[(11, "Win 3 matches in Squad Battles.", 0, 3)])] }));
        assert!(plan(&none, &SquadPrefs::default()).combos[0].bench.is_empty());
        let v = plan(&input, &SquadPrefs::default());
        let s = &v.combos[0];
        assert!(s.items[0].counts);
        // never a buy for a sub's objective
        assert_eq!(s.squad.as_ref().unwrap().buys, 0);
    }

    #[test]
    fn evolutions_are_read_from_eas_hub() {
        let evos = evos_from_hub(&evo_hub());
        assert_eq!(evos.len(), 3, "the inactive one is left out");
        let cs = &evos[0];
        assert_eq!((cs.name.as_str(), cs.item, cs.level, cs.levels, cs.matches_left), ("Center Spectre", 14, 1, 3, 4));
        assert!(!cs.start, "a match in game – a sub counts");
        assert!(cs.modes.contains(&Mode::SquadBattles) && cs.modes.contains(&Mode::Rush) && cs.modes.contains(&Mode::LiveEvents));
        assert_eq!(cs.ends_at, Some(1_800_000_000 + 8 * 86_400));
        assert!(evos[1].start, "a goal needs him from the start");
        // Training Camp: no match moves it on, the timestamp is no progress
        assert!(evos[2].modes.is_empty());
        assert_eq!(evos[2].goals[0].progress, 17280);
    }

    #[test]
    fn scenario_evo_players_play_along_and_one_that_must_score_starts() {
        let mut input = scenario(json!({ "groups": [ev(1, "Weekly", &[(11, "Win 10 matches in Squad Battles.", 0, 10)])] }));
        input.evos = evos_from_hub(&evo_hub());
        let v = plan(&input, &SquadPrefs::default());
        let s = &v.combos[0];
        assert_eq!(s.place, Mode::SquadBattles);
        let names: Vec<&str> = s.evos.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Center Spectre", "Goal Ghost"], "Training Camp is no match");
        let ghost = &s.evos[1];
        assert!(ghost.start && ghost.in_xi, "he has to score: he starts");
        let slot = s.squad.as_ref().unwrap().slots.iter().find(|x| x.evo.as_deref() == Some("Goal Ghost")).unwrap();
        assert!(!slot.must, "shown as the evo, not as the user's own pick");
        assert_eq!(s.evos[0].days_left, Some(8));
        // the user's own settings come back untouched
        assert!(v.prefs.must.is_empty());
    }

    #[test]
    fn scenario_wins_are_planned_from_the_users_win_rate() {
        let r = Rates { win: 0.5, goals: 2.0, assists: 1.5 };
        assert_eq!(per_match("Win 7 matches in Squad Battles", &r), 0.5);
        assert_eq!(per_match("Play 10 matches in Squad Battles", &r), 1.0);
        assert_eq!(per_match("Score 10 headers while having …", &r), 0.35);
        assert_eq!(per_match("Score at least 2 goals in 5 separate matches in the Ghoul Fest Live Event.", &r), 0.55);
        assert!(per_match("Earn 35,000 points by completing bonuses in Rush.", &r) > 1000.0);
    }

    #[test]
    fn a_hand_mark_counts_until_a_newer_sync_says_otherwise() {
        let mut input = Input::empty();
        input.read_at = Some(1_000);
        input.groups = vec![Group {
            id: 7,
            title: "Event".into(),
            category: String::new(),
            category_id: None,
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
        // no price, and a price older than 3 days: never a price we don't know – cards to search for
        let mut input = market(vec![st(1, 80, 13, [85, 80, 70, 80, 35, 75]), st(2, 81, 13, [86, 81, 70, 80, 35, 75])], &[(2, 900)]);
        input.prices.get_mut(&2).unwrap().at = 0;
        let req = Req { need: Need::League(13), count: 1 };
        let (opts, unpriced) = options_for(&req, &squad_with_free_st(74.0), &input, &BTreeSet::new(), &BTreeMap::new(), None);
        assert!(opts.len() == 2 && opts.iter().all(|o| o.kind == "search" && o.price.is_none()), "{opts:?}");
        assert_eq!(unpriced, 0);
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
        // chemistry first (2026-10-31): a playable squad, but a requirement worth a few points still plays
        assert!(xi.iter().any(|p| p.key == 50) && chemistry(&xi, &BTreeMap::new()).iter().sum::<u32>() >= 30);
        // … one that costs a lot of chemistry does not: six lone cards (−18)
        for k in 0..6u64 {
            club.push(pl(60 + k, &letters(60 + k), 84, &["CM", "ST", "CB"], 16 + k * 10, 300 + k, 100 + k));
        }
        let many = vec![Req { need: Need::Rating(84), count: 1 }, Req { need: Need::Nation(100), count: 1 }, Req { need: Need::Nation(101), count: 1 }, Req { need: Need::Nation(102), count: 1 }];
        let (_, c) = solve(&club, &many, &f, &chem_first, &BTreeMap::new(), &BTreeSet::new(), None).unwrap();
        let xi: Vec<&Player> = c.slots.iter().flatten().map(|&i| &club[i]).collect();
        assert!(chemistry(&xi, &BTreeMap::new()).iter().sum::<u32>() >= 24);
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
            manager: None,
            rates: Rates::default(),
            coins: None,
            read_at: None,
            now_ms: 0,
            evos: vec![],
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
            manager: None,
            rates: Rates::default(),
            coins: snap["coins"][0].as_u64(),
            read_at: None,
            evos: vec![],
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
