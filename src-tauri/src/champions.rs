//! FUT Champions tracker (beta): every Champions match of the weekend, read from the screen.
//!
//! Only pixels of the game window are read (like the Gallery, never the game process). What we
//! read and when (CHAMPIONS.md):
//! - the Champions hub (Wins / Losses / Remaining, rank, points) – **the referee**: a match counts
//!   only when the next hub reading shows it (+1 win or +1 loss), so the record is always right
//!   even if every in-match screen was skipped;
//! - the kit selection titled CHAMPIONS (a Champions match starts), "Your opponent has left the
//!   match." before kickoff (no match);
//! - the versus card (both clubs and their abbreviations);
//! - the scoreboard in play (one look per second: score + clock → goal minutes, last score for a
//!   quit, extra time);
//! - the pause menu (last screen before a quit), the disconnect notice;
//! - the result card right after full time (both gamertags, clubs, the opponent's record, the
//!   final score, coins, SP) – shown ~1.5 s when skipped, so it is read in a burst of looks.
//!
//! Opponent gamertags are personal data: kept in `champions.json` on this PC only, never sent
//! anywhere (no usage count, no upload, never on a share card).

use crate::scan::{Frame, Word};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// ------------------------------------------------------------------------------------------ data

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Hub {
    pub at: u64,
    pub wins: u8,
    pub losses: u8,
    pub remaining: u8,
    pub points: Option<u32>,
    /// "Contender IV"
    pub rank: Option<String>,
    /// Points towards the next rank: [have, need] ("1/2 pts").
    pub rank_pts: Option<[u32; 2]>,
    /// When the event ends (ms), from "Event ends in 3 Days 9 Hours" (to the hour).
    pub ends_at: Option<u64>,
}

impl Hub {
    pub fn played(&self) -> u32 {
        self.wins as u32 + self.losses as u32
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Win,
    Loss,
    /// The user left the match: a loss, no result card; `last` holds the score when he left.
    Quit,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Team {
    pub abbr: Option<String>,
    pub club: Option<String>,
    /// Local only – never leaves this PC.
    pub gamertag: Option<String>,
    /// The opponent's record shown on the result card: [wins, losses].
    pub record: Option<[u16; 2]>,
    /// "Mar 2025" (club established).
    pub est: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Match {
    pub started: u64,
    /// Last moment anything of this match was seen.
    pub seen: u64,
    /// 1–15: the hub's games played after this match.
    pub n: Option<u8>,
    pub outcome: Option<Outcome>,
    /// The hub confirmed it (+1 win / +1 loss).
    pub confirmed: bool,
    /// Only the hub saw it (no screen of the match was read).
    pub hub_only: bool,
    pub home: Team,
    pub away: Team,
    /// Which side is the user: true = home (left on the result card, top on the scoreboard).
    pub me_home: Option<bool>,
    /// Final score [home, away] (result card).
    pub score: Option<[u8; 2]>,
    /// Score changes in play: [minute, home, away].
    pub timeline: Vec<[u16; 3]>,
    /// The last scoreboard reading: [minute, home, away].
    pub last: Option<[u16; 3]>,
    pub extra_time: bool,
    pub disconnect: bool,
    /// The pause menu was the last screen seen before the match ended (ms).
    pub paused_at: Option<u64>,
    /// The result card said WIN / LOSS (before the hub confirms).
    pub card_win: Option<bool>,
    pub coins: Option<u32>,
    pub sp: Option<u32>,
    /// The opponent left before kickoff ("Your opponent has left the match.") – no match.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub left_before_kickoff: bool,
    /// A score read once that jumped (not one goal): taken when the next look reads it again.
    #[serde(skip)]
    pub candidate: Option<[u8; 2]>,
    /// Started without its kit selection / versus card being read: the Champions hub was the last
    /// mode screen before the match. Only the hub can make it count – never kept unconfirmed.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub inferred: bool,
}

impl Match {
    fn new(now: u64) -> Self {
        Self { started: now, seen: now, ..Default::default() }
    }
    /// Anything of a real match was read (not just the kit selection).
    fn played(&self) -> bool {
        self.last.is_some() || self.score.is_some() || self.card_win.is_some()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Run {
    /// First seen (ms) – also the id.
    pub id: u64,
    pub ends_at: Option<u64>,
    /// The latest hub reading of this event.
    pub hub: Hub,
    pub matches: Vec<Match>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Me {
    pub gamertag: Option<String>,
    /// Club names / abbreviations seen as the user's side.
    pub clubs: Vec<String>,
    pub abbrs: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Data {
    pub runs: Vec<Run>,
    pub me: Me,
    pub last_hub: Option<Hub>,
    /// The match being played (or just finished, waiting for the hub).
    pub pending: Option<Match>,
    /// When the Champions hub was last read with no other mode's screen after it: a match that
    /// starts soon after is a Champions match even if its kit selection wasn't read.
    pub hub_seen: Option<u64>,
    /// A hub reading that didn't fit the last one (record went down, the total changed): taken
    /// once it is read again (or followed by a reading that fits it).
    #[serde(skip)]
    pub hub_candidate: Option<Hub>,
}

// --------------------------------------------------------------------------------- what is seen

#[derive(Debug, Clone, PartialEq)]
pub struct Board {
    pub home_abbr: String,
    pub away_abbr: String,
    pub home: u8,
    pub away: u8,
    /// Match minute (the clock's minutes), if read.
    pub minute: Option<u16>,
    pub extra_time: bool,
}

/// The pause menu's top line: "114:08 ET  NICE SC 4 - 4 BAOPROVCL" (the thin score digits are
/// often missed by the OCR – then only the minute).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PauseInfo {
    pub minute: Option<u16>,
    pub score: Option<[u8; 2]>,
    pub extra_time: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Card {
    /// [left = home, right = away]
    pub sides: [Team; 2],
    pub score: Option<[u8; 2]>,
    /// WIN / LOSS label (the user's view), if read.
    pub win: Option<bool>,
    pub coins: Option<u32>,
    pub sp: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Seen {
    Hub(Hub),
    KitChampions,
    OpponentLeft,
    Versus { home: Team, away: Team },
    Board(Board),
    Pause(PauseInfo),
    Disconnect,
    Result(Card),
    RankWin,
    /// Another mode's screen (Rivals / Squad Battles kit selection or hub): what follows is not a
    /// Champions match.
    OtherMode,
}

// -------------------------------------------------------------------------------------- helpers

fn cx(w: &Word) -> f32 {
    w.x + w.w / 2.0
}
fn cy(w: &Word) -> f32 {
    w.y + w.h / 2.0
}

/// A number as Windows OCR reads FC 27's digits: O/o → 0, I/l/| → 1, thousands separators dropped.
pub fn num(s: &str) -> Option<u32> {
    let t: String = s
        .chars()
        .filter(|c| *c != ',' && *c != '.')
        .map(|c| match c {
            'O' | 'o' | 'Q' | 'D' => '0',
            'I' | 'l' | '|' | 'i' | '!' => '1',
            c => c,
        })
        .collect();
    (!t.is_empty() && t.len() <= 7 && t.chars().all(|c| c.is_ascii_digit())).then(|| t.parse().ok()).flatten()
}

fn has(words: &[Word], t: &str) -> bool {
    words.iter().any(|w| w.text == t)
}
fn find<'a>(words: &'a [Word], t: &str) -> Option<&'a Word> {
    words.iter().find(|w| w.text == t)
}
/// Words in reading order of one line (the run of words starting at `i` on the same row).
fn phrase(words: &[Word], parts: &[&str]) -> bool {
    words.windows(parts.len()).any(|w| w.iter().zip(parts).all(|(a, b)| a.text.trim_end_matches(['.', ',']).eq_ignore_ascii_case(b)))
}

/// Groups words into rows (top to bottom), each row left to right.
fn rows(words: &[&Word]) -> Vec<Vec<Word>> {
    let mut sorted: Vec<&Word> = words.to_vec();
    sorted.sort_by(|a, b| cy(a).total_cmp(&cy(b)));
    let mut out: Vec<Vec<Word>> = Vec::new();
    for w in sorted {
        match out.last_mut() {
            Some(row) if (cy(&row[0]) - cy(w)).abs() < row[0].h.max(w.h) * 0.6 => row.push(w.clone()),
            _ => out.push(vec![w.clone()]),
        }
    }
    for row in &mut out {
        row.sort_by(|a, b| a.x.total_cmp(&b.x));
    }
    out
}

fn join(row: &[Word]) -> String {
    row.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")
}

/// Roman numerals as OCR reads them in FC's rank names ("Ill" = III).
fn roman(s: &str) -> String {
    match s {
        "Ill" | "lll" | "IIl" | "IlI" | "111" => "III".into(),
        "Il" | "lI" | "ll" | "11" => "II".into(),
        "l" | "1" => "I".into(),
        "lV" | "1V" => "IV".into(),
        "Vl" | "V1" => "VI".into(),
        s => s.into(),
    }
}

/// "3W-0L" (also misread "OW-IL") → [3, 0].
fn record(s: &str) -> Option<[u16; 2]> {
    let up = s.to_uppercase();
    let (w, l) = up.split_once('-').or_else(|| up.split_once('–'))?;
    let one = |s: &str| s.replace(['T', 'J'], "1");
    let w = num(&one(w.strip_suffix('W')?))?;
    let l = num(&one(l.strip_suffix('L')?))?;
    Some([w as u16, l as u16])
}

/// "6-0", "1-11", "6–O" → [6, 0].
fn score(s: &str) -> Option<[u8; 2]> {
    let t: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    let (a, b) = t.split_once(['-', '–', '—', '~', '=']).filter(|(a, b)| !a.is_empty() && !b.is_empty())?;
    let (a, b) = (num(a)?, num(b)?);
    (a < 40 && b < 40).then_some([a as u8, b as u8])
}

/// "45:00", "114:08" → minutes.
fn clock(s: &str) -> Option<u16> {
    let (m, sec) = s.split_once(':')?;
    let (m, sec) = (num(m)?, num(sec.get(..2.min(sec.len()))?)?);
    (m <= 130 && sec < 60 && sec.to_string().len() <= 2).then_some(m as u16)
}

/// Two abbreviations are the same team when they only differ by OCR look-alikes ("NSS" = "NS5").
pub fn same_abbr(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.chars().map(|c| match c { '5' => 'S', '0' => 'O', '1' => 'I', '8' => 'B', '2' => 'Z', c => c }).collect::<String>();
    norm(a) == norm(b)
}

/// The FUT shield next to a name, as OCR reads it ("FUT", "Fur", "FL/7", "FU7") – not part of a name.
fn shield_noise(s: &str) -> bool {
    matches!(s, "FUT" | "Fur" | "FUR" | "FL/7" | "FU7" | "FUZ" | "FU" | "F/IT")
}

/// A team abbreviation on the scoreboard ("NS5", "NIC", "AZ").
fn abbr(s: &str) -> bool {
    (2..=5).contains(&s.chars().count()) && s.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) && s.chars().any(|c| c.is_ascii_uppercase())
}

// -------------------------------------------------------------------------------------- readers

/// The Champions hub (Rivals → Champions): Wins / Losses / Remaining, Points, rank, event end.
pub fn read_hub(words: &[Word], now: u64) -> Option<Hub> {
    if !has(words, "CHAMPIONS") || !has(words, "Wins") || !has(words, "Losses") || !has(words, "Remaining") {
        return None;
    }
    let below = |label: &str| -> Option<u32> {
        let l = find(words, label)?;
        words
            .iter()
            .filter(|w| w.y > l.y + l.h * 0.5 && w.y < l.y + l.h * 4.0 && (cx(w) - cx(l)).abs() < l.w.max(l.h * 2.0))
            .find_map(|w| num(&w.text))
    };
    let (wins, losses, remaining) = (below("Wins")?, below("Losses")?, below("Remaining")?);
    if wins + losses + remaining > 40 {
        return None;
    }
    // "Points": the big number right above the label.
    let points = find(words, "Points").and_then(|l| {
        words
            .iter()
            .filter(|w| w.y < l.y && w.y > l.y - l.h * 5.0 && (cx(w) - cx(l)).abs() < l.w)
            .find_map(|w| num(&w.text))
    });
    // "1/2 pts" with the rank name on the line above ("Contender IV").
    let mut rank_pts = None;
    let mut rank = None;
    if let Some((i, t)) = words.iter().enumerate().find(|(i, w)| w.text.contains('/') && words.get(i + 1).is_some_and(|n| n.text.starts_with("pts"))) {
        if let Some((a, b)) = t.text.split_once('/') {
            if let (Some(a), Some(b)) = (num(a), num(b)) {
                rank_pts = Some([a, b]);
            }
        }
        let _ = i;
        let name: Vec<String> = words
            .iter()
            .filter(|w| w.y < t.y && w.y > t.y - t.h * 3.0 && w.x >= t.x - t.h && w.x < t.x + t.h * 14.0)
            .map(|w| roman(&w.text))
            .collect();
        if !name.is_empty() {
            rank = Some(name.join(" "));
        }
    }
    // "Event ends in 3 Days 9 Hours"
    let mut ends_at = None;
    if let Some(ev) = find(words, "Event") {
        let (mut ms, mut any) = (0u64, false);
        // the row after "Event ends in" (OCR lists the timer icon and the numbers out of order)
        let line: Vec<&Word> = words.iter().filter(|w| (cy(w) - cy(ev)).abs() < ev.h * 0.7 && w.x > ev.x).collect();
        let rest = rows(&line).into_iter().next().unwrap_or_default();
        for pair in rest.windows(2) {
            if let Some(n) = num(&pair[0].text) {
                let unit = pair[1].text.to_lowercase();
                let per = if unit.starts_with("day") {
                    86_400_000
                } else if unit.starts_with("hour") {
                    3_600_000
                } else if unit.starts_with("min") {
                    60_000
                } else {
                    continue;
                };
                ms += n as u64 * per;
                any = true;
            }
        }
        if any {
            ends_at = Some((now + ms) / 3_600_000 * 3_600_000);
        }
    }
    Some(Hub { at: now, wins: wins as u8, losses: losses as u8, remaining: remaining as u8, points, rank, rank_pts, ends_at })
}

/// Kit selection of a Champions match ("CHAMPIONS" over "Select a kit for you and your opponent").
pub fn is_kit_champions(words: &[Word]) -> bool {
    has(words, "CHAMPIONS") && has(words, "Select") && has(words, "kit")
}

/// The kit selection of another mode (Rivals, Squad Battles, Friendlies …), or the Rivals / Squad
/// Battles hub.
pub fn is_other_mode(words: &[Word]) -> bool {
    let kit = has(words, "Select") && has(words, "kit") && !has(words, "CHAMPIONS");
    let hub = (has(words, "RIVALS") && has(words, "Division")) || (has(words, "SQUAD") && has(words, "BATTLES"));
    kit || hub
}

pub fn is_opponent_left(words: &[Word]) -> bool {
    phrase(words, &["opponent", "has", "left"])
}

pub fn is_disconnect(words: &[Word]) -> bool {
    phrase(words, &["lost", "your", "connection"])
}

pub fn is_rank_win(words: &[Word]) -> bool {
    words.windows(2).any(|w| w[0].text == "MATCH" && w[1].text == "WIN") && (has(words, "Rank") || has(words, "Advance"))
}

/// The versus card before kickoff: "FUT CHAMPIONS", then home abbr + club, away abbr + club.
pub fn read_versus(words: &[Word]) -> Option<(Team, Team)> {
    let title = words.windows(2).find(|w| w[0].text == "FUT" && w[1].text == "CHAMPIONS").map(|w| w[1].clone())?;
    // The two abbreviations are the biggest words below the title, in its column.
    let mut big: Vec<&Word> = words
        .iter()
        .filter(|w| w.y > title.y + title.h && w.x > title.x - title.h * 6.0 && w.x < title.x + title.h * 8.0 && w.h > title.h * 1.5 && abbr(&w.text))
        .collect();
    big.sort_by(|a, b| a.y.total_cmp(&b.y));
    if big.len() < 2 {
        return None;
    }
    let club_under = |a: &Word| -> Option<String> {
        let line: Vec<&Word> = words.iter().filter(|w| w.y > a.y + a.h * 0.8 && w.y < a.y + a.h * 1.8 && w.h < a.h * 0.6 && w.x > a.x - a.h).collect();
        let r = rows(&line);
        r.first().map(|row| join(row)).filter(|s| !s.is_empty())
    };
    let team = |a: &Word| Team { abbr: Some(a.text.clone()), club: club_under(a), ..Default::default() };
    Some((team(big[0]), team(big[1])))
}

/// The scoreboard (top left in play): two rows "ABBR score", then the clock.
/// `words` are from a crop of that corner.
pub fn read_board(words: &[Word]) -> Option<Board> {
    let refs: Vec<&Word> = words.iter().collect();
    let mut teams = Vec::new();
    let mut minute = None;
    let mut et = false;
    for row in rows(&refs) {
        let text = join(&row);
        if let Some(m) = row.iter().find_map(|w| clock(&w.text)) {
            minute = Some(m);
            et |= text.contains("ET");
            continue;
        }
        let Some(a) = row.iter().find(|w| abbr(&w.text)) else { continue };
        let Some(s) = row.iter().rev().filter(|w| w.x > a.x + a.w * 0.5).find_map(|w| num(&w.text)) else { continue };
        if s < 40 {
            teams.push((a.text.clone(), s as u8));
        }
    }
    if teams.len() < 2 || teams[0].0 == teams[1].0 {
        return None;
    }
    let extra_time = et || minute.is_some_and(|m| m > 96);
    Some(Board { home_abbr: teams[0].0.clone(), away_abbr: teams[1].0.clone(), home: teams[0].1, away: teams[1].1, minute, extra_time })
}

/// The pause menu ("RESUME MATCH" … "LEAVE MATCH"); its top line holds clock, clubs and score.
pub fn read_pause(words: &[Word]) -> Option<PauseInfo> {
    if !(phrase(words, &["RESUME", "MATCH"]) || phrase(words, &["LEAVE", "MATCH"])) {
        return None;
    }
    let mut info = PauseInfo::default();
    // "45:00 NICE SC 5 - 0 CLASS ON GRASS"
    if let Some(c) = words.iter().find(|w| clock(&w.text).is_some()) {
        info.minute = clock(&c.text);
        let line: Vec<&Word> = words.iter().filter(|w| (cy(w) - cy(c)).abs() < c.h * 0.7).collect();
        if let Some(row) = rows(&line).into_iter().next() {
            let text = join(&row);
            info.extra_time = row.iter().any(|w| w.text == "ET") || info.minute.is_some_and(|m| m > 96);
            let toks: Vec<&str> = text.split_whitespace().collect();
            if let Some(i) = toks.iter().position(|t| *t == "-" || *t == "–") {
                if let (Some(a), Some(b)) = (i.checked_sub(1).and_then(|j| toks.get(j)).and_then(|t| num(t)), toks.get(i + 1).and_then(|t| num(t))) {
                    info.score = Some([a as u8, b as u8]);
                }
            }
            if info.score.is_none() {
                info.score = toks.iter().find_map(|t| score(t));
            }
        }
    }
    Some(info)
}

/// Is this the result card after full time? (the header with both players, "Advance", awards)
pub fn is_result(words: &[Word]) -> bool {
    looks_like_result(words) && words.iter().filter(|w| w.text == "Est.").count() >= 2
}

/// The result card's big words ("Advance", "… Awarded") – enough on a half-resolution look to read
/// the frame again in full resolution.
pub fn looks_like_result(words: &[Word]) -> bool {
    has(words, "Advance") && has(words, "Awarded")
}

/// The result card: both sides (gamertag, club, Est., the opponent's record), the label, coins, SP.
/// The score is drawn in a thin font Windows OCR misses on the whole frame – `frame` (optional)
/// lets us read it from a binarised crop.
pub fn read_result(words: &[Word], frame: Option<&Frame>) -> Option<Card> {
    let card = read_result_words(words, frame)?;
    // Windows OCR sometimes drops a whole side's name lines on the full frame: read that side again
    // from a crop around its "Est." line
    let Some(f) = frame else { return Some(card) };
    if card.sides.iter().all(|s| s.gamertag.is_some() && s.club.is_some()) {
        return Some(card);
    }
    let mut more: Vec<Word> = words.to_vec();
    for e in words.iter().filter(|w| w.text == "Est.") {
        let u = e.h.max(10.0);
        if let Ok(ws) = f.ocr_words_in(e.x - u * 12.0, e.y - u * 6.0, u * 30.0, u * 9.5, 2, None) {
            for w in ws {
                if !more.iter().any(|m| m.text == w.text && (cx(m) - cx(&w)).abs() < u && (cy(m) - cy(&w)).abs() < u) {
                    more.push(w);
                }
            }
        }
    }
    let again = read_result_words(&more, frame)?;
    let pick = |a: &Team, b: &Team| Team {
        abbr: a.abbr.clone().or(b.abbr.clone()),
        club: a.club.clone().or(b.club.clone()),
        gamertag: a.gamertag.clone().or(b.gamertag.clone()),
        record: a.record.or(b.record),
        est: a.est.clone().or(b.est.clone()),
    };
    Some(Card { sides: [pick(&card.sides[0], &again.sides[0]), pick(&card.sides[1], &again.sides[1])], score: card.score.or(again.score), ..card })
}

fn read_result_words(words: &[Word], frame: Option<&Frame>) -> Option<Card> {
    if !is_result(words) {
        return None;
    }
    let ests: Vec<&Word> = words.iter().filter(|w| w.text == "Est.").collect();
    let (l_est, r_est) = if ests[0].x < ests[1].x { (ests[0], ests[1]) } else { (ests[1], ests[0]) };
    let unit = l_est.h.max(10.0);
    let label = words.iter().find(|w| matches!(w.text.as_str(), "WIN" | "LOSS" | "LOST" | "DEFEAT") && w.y < l_est.y + unit);
    let mid = label.map(cx).unwrap_or((r_est.x + l_est.x + l_est.w) / 2.0);
    let top = l_est.y.min(r_est.y) - unit * 8.0;
    let bottom = l_est.y.max(r_est.y) + unit * 3.5;
    let side = |left: bool| -> Team {
        let est = if left { l_est } else { r_est };
        let ws: Vec<&Word> = words
            .iter()
            .filter(|w| w.y > top && w.y < bottom && if left { cx(w) < mid - unit * 2.0 } else { cx(w) > mid + unit * 2.0 })
            .collect();
        let rs = rows(&ws);
        let est_row = rs.iter().position(|r| r.iter().any(|w| w.text == "Est."));
        let mut t = Team::default();
        if let Some(e) = est_row {
            let row = &rs[e];
            let after: Vec<&str> = row.iter().skip_while(|w| w.text != "Est.").skip(1).map(|w| w.text.as_str()).collect();
            if !after.is_empty() {
                t.est = Some(after.join(" "));
            }
            if e >= 1 {
                let club: Vec<Word> = rs[e - 1].iter().filter(|w| !shield_noise(&w.text)).cloned().collect();
                if !club.is_empty() {
                    t.club = Some(join(&club));
                }
            }
            if e >= 2 {
                // the gamertag: the token farthest from the middle, above the club (the shield /
                // badge OCR noise sits nearer the middle, sometimes on a row of its own)
                t.gamertag = rs[..e - 1]
                    .iter()
                    .flatten()
                    .filter(|w| w.text.chars().count() >= 2 && !shield_noise(&w.text))
                    .max_by(|a, b| (cx(a) - mid).abs().total_cmp(&(cx(b) - mid).abs()))
                    .map(|w| w.text.clone());
            }
            t.record = rs.iter().skip(e + 1).take(2).flat_map(|r| r.iter()).find_map(|w| record(&w.text));
        }
        let _ = est;
        t
    };
    let sides = [side(true), side(false)];
    let win = label.map(|l| l.text == "WIN");
    // the score: on the whole frame, or from a binarised crop around the label / between the sides
    let mut sc = words.iter().filter(|w| w.y > top && w.y < bottom && (cx(w) - mid).abs() < unit * 8.0).find_map(|w| score(&w.text));
    if sc.is_none() {
        if let Some(f) = frame {
            let (y0, y1) = match label {
                Some(l) => (l.y + l.h * 0.9, l.y + l.h * 4.6),
                None => (l_est.y - unit * 7.0, l_est.y + unit * 2.5),
            };
            // thin digits: several binarisations, the most common reading wins (one try alone
            // reads "61-0" or nothing now and then – measured on the user's screenshot)
            let half = unit * 8.0;
            let mut votes: Vec<[u8; 2]> = Vec::new();
            for (fac, t) in [(1u32, Some(130u8)), (1, None), (2, Some(170)), (1, Some(110)), (2, Some(130)), (2, Some(200))] {
                if let Ok(ws) = f.ocr_words_in(mid - half, y0, half * 2.0, y1 - y0, fac, t) {
                    let text: String = ws.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join("");
                    if let Some(s) = score(&text) {
                        votes.push(s);
                    }
                }
            }
            sc = votes.iter().max_by_key(|v| votes.iter().filter(|x| x == v).count()).copied();
        }
    }
    let above = |label: &str| -> Option<u32> {
        let l = words.iter().filter(|w| w.text == "Awarded").find(|a| words.iter().any(|w| w.text == label && (cy(w) - cy(a)).abs() < a.h && w.x < a.x))?;
        words
            .iter()
            .filter(|w| w.y < l.y && w.y > l.y - l.h * 6.0 && (cx(w) - cx(l)).abs() < l.w * 3.0)
            .filter_map(|w| {
                // "d15,973": the coin icon is read as a letter and a digit in front of the number
                let t = w.text.as_str();
                let t = if t.starts_with(|c: char| c.is_ascii_alphabetic()) { t.trim_start_matches(|c: char| c.is_ascii_alphabetic()).get(1..).unwrap_or("") } else { t };
                num(&t.chars().filter(|c| c.is_ascii_digit() || *c == ',').collect::<String>())
            })
            .max()
    };
    Some(Card { sides, score: sc, win, coins: above("Coins"), sp: above("SP") })
}

/// Everything recognisable on a whole-frame read (in a menu or the half-resolution looks in a match).
pub fn read_screen(words: &[Word], frame: Option<&Frame>, now: u64) -> Option<Seen> {
    if let Some(h) = read_hub(words, now) {
        return Some(Seen::Hub(h));
    }
    if is_opponent_left(words) {
        return Some(Seen::OpponentLeft);
    }
    if is_kit_champions(words) {
        return Some(Seen::KitChampions);
    }
    if is_other_mode(words) {
        return Some(Seen::OtherMode);
    }
    if is_disconnect(words) {
        return Some(Seen::Disconnect);
    }
    if let Some(c) = read_result(words, frame) {
        return Some(Seen::Result(c));
    }
    if is_rank_win(words) {
        return Some(Seen::RankWin);
    }
    if let Some(p) = read_pause(words) {
        return Some(Seen::Pause(p));
    }
    if let Some((home, away)) = read_versus(words) {
        return Some(Seen::Versus { home, away });
    }
    None
}

// -------------------------------------------------------------------------------------- tracker

const HOUR: u64 = 3_600_000;
/// Two hub timers this close are the same event ("ends in" is read to the hour, and OCR can drop a
/// "1 Day"): events are a week apart.
const SAME_EVENT: u64 = 48 * HOUR;
/// A match that starts this soon after the Champions hub was read is a Champions match.
const HUB_TO_MATCH: u64 = 20 * 60_000;

impl Data {
    /// The run of the event a hub reading belongs to (a new one for a new weekend).
    fn run_for(&mut self, h: &Hub) -> &mut Run {
        let same = |r: &Run| {
            let ends_close = match (r.ends_at, h.ends_at) {
                (Some(a), Some(b)) => a.abs_diff(b) <= SAME_EVENT,
                _ => h.at.saturating_sub(r.hub.at) < 4 * 24 * HOUR,
            };
            ends_close && h.played() >= r.hub.played()
        };
        if !self.runs.last().is_some_and(same) {
            self.runs.push(Run { id: h.at, ends_at: h.ends_at, hub: h.clone(), matches: Vec::new() });
        }
        self.runs.last_mut().unwrap()
    }

    fn pending(&mut self, now: u64) -> &mut Match {
        // a pending match older than 3 hours without any result is dropped
        if self.pending.as_ref().is_some_and(|m| now.saturating_sub(m.seen) > 3 * HOUR) {
            self.pending = None;
        }
        self.pending.get_or_insert_with(|| Match::new(now))
    }

    /// The Champions match in progress, if one was seen starting (and isn't stale) – or, when its
    /// kit selection / versus card was missed, one that starts right after the Champions hub.
    fn live_pending(&mut self, now: u64) -> Option<&mut Match> {
        if self.pending.as_ref().is_some_and(|m| now.saturating_sub(m.seen) > 3 * HOUR) {
            self.pending = None;
        }
        if self.pending.is_none() && self.expects_match(now) {
            self.hub_seen = None;
            self.pending = Some(Match { inferred: true, ..Match::new(now) });
        }
        self.pending.as_mut()
    }

    /// A Champions match is expected: one was seen starting, or the Champions hub was the last mode
    /// screen read, a moment ago.
    pub fn expects_match(&self, now: u64) -> bool {
        self.pending.is_some() || self.hub_seen.is_some_and(|t| now.saturating_sub(t) < HUB_TO_MATCH)
    }

    /// Which side of a match is the user, from what we know about him.
    fn learn_side(&self, m: &mut Match) {
        if m.me_home.is_some() {
            return;
        }
        let mine = |t: &Team| {
            t.gamertag.as_ref().is_some_and(|g| self.me.gamertag.as_ref().is_some_and(|me| me.eq_ignore_ascii_case(g)))
                || t.club.as_ref().is_some_and(|c| self.me.clubs.iter().any(|m| m.eq_ignore_ascii_case(c)))
                || t.abbr.as_ref().is_some_and(|a| self.me.abbrs.iter().any(|m| same_abbr(m, a)))
        };
        match (mine(&m.home), mine(&m.away)) {
            (true, false) => m.me_home = Some(true),
            (false, true) => m.me_home = Some(false),
            _ => {}
        }
    }

    fn remember_me(&mut self, t: &Team) {
        if let Some(g) = &t.gamertag {
            self.me.gamertag = Some(g.clone());
        }
        for (v, list) in [(&t.club, &mut self.me.clubs), (&t.abbr, &mut self.me.abbrs)] {
            if let Some(v) = v {
                if !list.iter().any(|x| x.eq_ignore_ascii_case(v)) {
                    list.push(v.clone());
                    if list.len() > 6 {
                        list.remove(0);
                    }
                }
            }
        }
    }

    /// One recognised screen. Returns true when the data changed.
    pub fn observe(&mut self, seen: Seen, now: u64) -> bool {
        let before = self.clone();
        match seen {
            Seen::KitChampions => {
                // a previous match that never got its hub reading is kept as it was read (the next
                // hub confirms it); one only guessed from the hub is dropped
                if self.pending.as_ref().is_some_and(|m| m.played()) {
                    let m = self.pending.take().unwrap();
                    if !m.inferred {
                        self.commit_unconfirmed(m);
                    }
                } else if self.pending.as_ref().is_some_and(|m| m.inferred) {
                    self.pending = None;
                }
                self.hub_seen = None;
                let m = self.pending(now);
                m.seen = now;
            }
            Seen::OpponentLeft => {
                if let Some(m) = self.pending.as_mut().filter(|m| !m.played()) {
                    m.left_before_kickoff = true;
                    m.seen = now;
                }
            }
            Seen::Versus { home, away } => {
                let m = self.pending(now);
                m.seen = now;
                m.home.abbr = home.abbr.or(m.home.abbr.take());
                m.home.club = home.club.or(m.home.club.take());
                m.away.abbr = away.abbr.or(m.away.abbr.take());
                m.away.club = away.club.or(m.away.club.take());
                let mut m = self.pending.take().unwrap();
                self.learn_side(&mut m);
                self.pending = Some(m);
            }
            Seen::Board(b) => {
                let Some(m) = self.live_pending(now) else { return false };
                m.seen = now;
                m.home.abbr.get_or_insert(b.home_abbr.clone());
                m.away.abbr.get_or_insert(b.away_abbr.clone());
                m.extra_time |= b.extra_time;
                let minute = b.minute.or(m.last.map(|l| l[0])).unwrap_or(0);
                let prev = m.last.map(|l| [l[1] as u8, l[2] as u8]).unwrap_or([0, 0]);
                let next = [b.home, b.away];
                // a goal: one side +1 (a misread jump or a drop is ignored)
                let goal = (next[0] == prev[0] + 1 && next[1] == prev[1]) || (next[1] == prev[1] + 1 && next[0] == prev[0]);
                if goal {
                    m.timeline.push([minute, next[0] as u16, next[1] as u16]);
                }
                let twice = m.candidate == Some(next);
                if goal || next == prev || twice {
                    m.last = Some([minute, next[0] as u16, next[1] as u16]);
                    m.candidate = None;
                } else {
                    m.candidate = Some(next);
                }
                m.paused_at = None;
                let mut m = self.pending.take().unwrap();
                self.learn_side(&mut m);
                self.pending = Some(m);
            }
            Seen::Pause(p) => {
                let Some(m) = self.live_pending(now) else { return false };
                m.seen = now;
                m.paused_at = Some(now);
                m.extra_time |= p.extra_time;
                if let Some(min) = p.minute {
                    let prev = m.last.map(|l| [l[1] as u8, l[2] as u8]).unwrap_or([0, 0]);
                    // the minute of the last known score (the score itself only when it agrees)
                    if p.score.is_none_or(|s| s == prev) {
                        m.last = Some([min, prev[0] as u16, prev[1] as u16]);
                    }
                }
            }
            Seen::Disconnect => {
                if let Some(m) = self.pending.as_mut() {
                    m.disconnect = true;
                    m.seen = now;
                }
            }
            Seen::RankWin => {
                if let Some(m) = self.pending.as_mut() {
                    m.card_win = Some(true);
                    m.seen = now;
                }
            }
            Seen::Result(c) => {
                let Some(m) = self.live_pending(now) else { return false };
                m.seen = now;
                let [l, r] = c.sides.clone();
                for (t, s) in [(&mut m.home, l), (&mut m.away, r)] {
                    t.gamertag = s.gamertag.or(t.gamertag.take());
                    t.club = s.club.or(t.club.take());
                    t.record = s.record.or(t.record);
                    t.est = s.est.or(t.est.take());
                }
                if c.score.is_some() {
                    m.score = c.score;
                }
                m.card_win = c.win.or(m.card_win);
                m.coins = c.coins.or(m.coins);
                m.sp = c.sp.or(m.sp);
                m.paused_at = None;
                // the opponent's record is shown, the user's is not
                match (c.sides[0].record.is_some(), c.sides[1].record.is_some()) {
                    (false, true) => m.me_home = Some(true),
                    (true, false) => m.me_home = Some(false),
                    _ => {}
                }
                let mut m = self.pending.take().unwrap();
                self.learn_side(&mut m);
                if let Some(home) = m.me_home {
                    let me = if home { m.home.clone() } else { m.away.clone() };
                    self.remember_me(&me);
                }
                self.pending = Some(m);
            }
            Seen::OtherMode => {
                // Rivals / Squad Battles next: no match is expected; a guessed one is dropped
                self.hub_seen = None;
                if self.pending.as_ref().is_some_and(|m| m.inferred || !m.played()) {
                    self.pending = None;
                }
            }
            Seen::Hub(h) => {
                self.hub_seen = Some(now);
                if self.hub_fits(&h) {
                    self.hub_candidate = None;
                    self.on_hub(h, now);
                } else if self.hub_candidate.as_ref().is_some_and(|c| same_reading(c, &h) || follows(c, &h)) {
                    // read twice (or followed by a reading that fits it): it is real
                    self.hub_candidate = None;
                    self.on_hub(h, now);
                } else {
                    self.hub_candidate = Some(h);
                }
            }
        }
        *self != before
    }

    /// The hub reading fits the last one: the same event with a record that only went up (or a new
    /// event). A misread (6 read as 8, a dropped digit) doesn't – it waits for a second reading.
    fn hub_fits(&self, h: &Hub) -> bool {
        let Some(p) = &self.last_hub else { return true };
        if !same_event(p, h) {
            return true;
        }
        follows(p, h) || same_reading(p, h)
    }

    fn on_hub(&mut self, h: Hub, now: u64) {
        let prev = self.last_hub.clone();
        let prev_same_event = prev.as_ref().is_some_and(|p| same_event(p, &h) && h.played() >= p.played());
        let (dw, dl) = match &prev {
            Some(p) if prev_same_event => (h.wins.saturating_sub(p.wins) as u32, h.losses.saturating_sub(p.losses) as u32),
            // a new weekend: it started 0–0, so every game on this hub is new
            Some(_) => (h.wins as u32, h.losses as u32),
            // the very first reading: its games are unknown to us
            None => (0, 0),
        };
        let new_games = (dw + dl) as usize;
        // The matches waiting for the hub: kept unconfirmed (no hub read between two matches),
        // then the pending one – the latest of the new games.
        let mut waiting: Vec<Match> = Vec::new();
        if new_games > 0 && prev_same_event {
            if let Some(run) = self.runs.last_mut() {
                let first = run.matches.iter().rposition(|m| m.confirmed || m.hub_only).map_or(0, |i| i + 1);
                waiting = run.matches.split_off(first);
            }
        }
        match self.pending.take() {
            Some(m) if m.left_before_kickoff && !m.played() => {}
            Some(m) if new_games > 0 && (m.played() || !m.inferred) => waiting.push(m),
            Some(mut m) if m.played() && prev.is_none() => {
                // no earlier hub to compare with: keep it as read
                m.outcome = m.card_win.map(|w| if w { Outcome::Win } else { Outcome::Loss });
                m.n = Some(h.played() as u8);
                self.run_for(&h).matches.push(m);
            }
            // the hub hasn't counted it yet (shown before the update) – wait for the next one
            Some(m) if new_games == 0 => self.pending = Some(m),
            _ => {}
        }
        // more waiting matches than new games: the oldest stay as they were read
        let keep = waiting.len().saturating_sub(new_games);
        let older: Vec<Match> = waiting.drain(..keep).collect();
        let (mut wins, mut losses) = (dw, dl);
        // first the matches whose own result card / score says how they ended, then the rest
        let mut decided: Vec<Option<Outcome>> = vec![None; waiting.len()];
        for (i, m) in waiting.iter().enumerate() {
            match my_result(m) {
                Some(true) if wins > 0 => {
                    wins -= 1;
                    decided[i] = Some(Outcome::Win);
                }
                Some(false) if losses > 0 => {
                    losses -= 1;
                    decided[i] = Some(Outcome::Loss);
                }
                _ => {}
            }
        }
        for (i, m) in waiting.iter_mut().enumerate() {
            let outcome = match decided[i] {
                Some(o) => o,
                None => {
                    let o = if losses > 0 {
                        losses -= 1;
                        Outcome::Loss
                    } else {
                        wins = wins.saturating_sub(1);
                        Outcome::Win
                    };
                    // the hub says otherwise than the score: the sides were read the wrong way round
                    if m.card_win.is_none() && my_result(m).is_some_and(|w| w != (o == Outcome::Win)) {
                        m.me_home = m.me_home.map(|home| !home);
                    }
                    o
                }
            };
            let quit = outcome == Outcome::Loss && m.score.is_none() && m.card_win.is_none() && m.paused_at.is_some_and(|p| now.saturating_sub(p) < 15 * 60_000);
            m.outcome = Some(if quit { Outcome::Quit } else { outcome });
            m.confirmed = true;
            m.inferred = false;
        }
        let run = self.run_for(&h);
        run.matches.extend(older);
        // games the hub counted that we never saw (app closed, another PC)
        let unseen = new_games - waiting.len();
        let base = (h.played() as usize).saturating_sub(new_games);
        for i in 0..unseen {
            let won = (i as u32) < wins;
            run.matches.push(Match { started: now, seen: now, n: Some((base + 1 + i) as u8), outcome: Some(if won { Outcome::Win } else { Outcome::Loss }), confirmed: true, hub_only: true, ..Default::default() });
        }
        for (i, mut m) in waiting.into_iter().enumerate() {
            m.n = Some((base + unseen + 1 + i) as u8);
            run.matches.push(m);
        }
        run.hub = h.clone();
        if run.ends_at.is_none() {
            run.ends_at = h.ends_at;
        }
        self.last_hub = Some(h);
    }

    fn commit_unconfirmed(&mut self, mut m: Match) {
        m.outcome = my_result(&m).map(|w| if w { Outcome::Win } else { Outcome::Loss });
        if let Some(run) = self.runs.last_mut() {
            run.matches.push(m);
        } else {
            self.runs.push(Run { id: m.started, ends_at: None, hub: Hub::default(), matches: vec![m] });
        }
    }
}

fn same_event(a: &Hub, b: &Hub) -> bool {
    match (a.ends_at, b.ends_at) {
        (Some(x), Some(y)) => x.abs_diff(y) <= SAME_EVENT,
        _ => true,
    }
}

fn same_reading(a: &Hub, b: &Hub) -> bool {
    (a.wins, a.losses, a.remaining) == (b.wins, b.losses, b.remaining)
}

/// `b` can come after `a` in one event: wins and losses only go up, and the games of the run stay
/// the same in total (wins + losses + remaining).
fn follows(a: &Hub, b: &Hub) -> bool {
    b.wins >= a.wins && b.losses >= a.losses && a.wins as u32 + a.losses as u32 + a.remaining as u32 == b.wins as u32 + b.losses as u32 + b.remaining as u32
}

/// How the match ended for the user by its own screens: the result card's WIN / LOSS, else the
/// final (or last read) score with the user's side known. None = can't tell (level, or no side).
fn my_result(m: &Match) -> Option<bool> {
    if let Some(w) = m.card_win {
        return Some(w);
    }
    let home = m.me_home?;
    let s = m.score.or(m.last.map(|l| [l[1] as u8, l[2] as u8]))?;
    let (me, them) = if home { (s[0], s[1]) } else { (s[1], s[0]) };
    (me != them).then_some(me > them)
}

/// The notice after a match was counted (shown in the hub): outcome, the user's score, the record.
pub fn notice(m: &Match, hub: &Hub) -> serde_json::Value {
    let home = m.me_home.unwrap_or(true);
    let mine = |p: [u8; 2]| if home { p } else { [p[1], p[0]] };
    let opp = if home { &m.away } else { &m.home };
    let last = m.last.map(|l| mine([l[1] as u8, l[2] as u8]));
    serde_json::json!({
        "kind": "champions",
        "n": m.n,
        "outcome": m.outcome,
        "score": if m.outcome == Some(Outcome::Quit) { Some([0, 3]) } else { m.score.map(mine).or(last) },
        "when_left": if m.outcome == Some(Outcome::Quit) { last } else { None },
        "minute": m.last.map(|l| l[0]),
        "aet": m.extra_time,
        "opponent": opp.club.clone().or(opp.abbr.clone()),
        "wins": hub.wins, "losses": hub.losses, "remaining": hub.remaining,
    })
}

// ------------------------------------------------------------------------------- live (the app)

struct Store {
    path: PathBuf,
    data: Data,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

fn now_ms() -> u64 {
    crate::store::now_ms()
}

/// Loads `champions.json` from the app data folder (once).
pub fn init(dir: &Path) {
    let path = dir.join("champions.json");
    let data = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    *STORE.lock().unwrap() = Some(Store { path, data });
}

/// A Champions match was seen starting (kit selection titled CHAMPIONS / the versus card).
/// A Champions match is in progress or about to start (seen starting, or right after the hub).
pub fn expects_match() -> bool {
    STORE.lock().unwrap().as_ref().is_some_and(|s| s.data.expects_match(now_ms()))
}

pub fn data() -> Data {
    STORE.lock().unwrap().as_ref().map(|s| s.data.clone()).unwrap_or_default()
}

fn save(s: &Store) {
    let tmp = s.path.with_extension("json.tmp");
    if let Ok(bytes) = serde_json::to_vec(&s.data) {
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, &s.path);
        }
    }
}

/// Feeds one recognised screen to the tracker; saves and returns the new data when it changed.
pub fn feed(seen: Seen) -> Option<Data> {
    let mut g = STORE.lock().unwrap();
    let s = g.as_mut()?;
    if s.data.observe(seen, now_ms()) {
        save(s);
        Some(s.data.clone())
    } else {
        None
    }
}

/// Clears everything (Settings → Champions → clear).
pub fn clear() -> Data {
    let mut g = STORE.lock().unwrap();
    if let Some(s) = g.as_mut() {
        s.data = Data::default();
        save(s);
    }
    Data::default()
}

/// The Champions data as it goes to the user's account (account sync): every opponent's
/// gamertag removed – they are personal data and never leave this PC. The user's own stays.
pub fn for_sync(d: &Data) -> Data {
    let mut d = d.clone();
    let mine = d.me.gamertag.clone();
    let strip = |t: &mut Team| {
        if t.gamertag.as_ref().is_some_and(|g| mine.as_ref().is_none_or(|m| !m.eq_ignore_ascii_case(g))) {
            t.gamertag = None;
        }
    };
    for m in d.runs.iter_mut().flat_map(|r| r.matches.iter_mut()).chain(d.pending.iter_mut()) {
        strip(&mut m.home);
        strip(&mut m.away);
    }
    d
}

/// The local opponents' gamertags put back on synced matches (same start time and side).
fn keep_local_tags(into: &mut Data, local: &Data) {
    let tags: std::collections::BTreeMap<u64, (Option<String>, Option<String>)> = local
        .runs
        .iter()
        .flat_map(|r| r.matches.iter())
        .map(|m| (m.started, (m.home.gamertag.clone(), m.away.gamertag.clone())))
        .collect();
    for m in into.runs.iter_mut().flat_map(|r| r.matches.iter_mut()) {
        if let Some((h, a)) = tags.get(&m.started) {
            m.home.gamertag = m.home.gamertag.take().or(h.clone());
            m.away.gamertag = m.away.gamertag.take().or(a.clone());
        }
    }
}

/// Another device's Champions data (account sync). `replace`: it becomes this PC's (the user
/// chose the cloud); else the weekends are merged – a weekend only one side has is added, and of
/// one both have, the one with more matches seen (then the newer) stays. Opponents' gamertags
/// this PC read are kept either way.
pub fn absorb_synced(other: Data, replace: bool) -> Data {
    let mut g = STORE.lock().unwrap();
    let Some(s) = g.as_mut() else { return Data::default() };
    let local = s.data.clone();
    let mut d = if replace { other } else { merge(local.clone(), other) };
    keep_local_tags(&mut d, &local);
    s.data = d;
    save(s);
    s.data.clone()
}

fn merge(mut base: Data, other: Data) -> Data {
    let seen = |r: &Run| (r.matches.len(), r.matches.iter().map(|m| m.seen).max().unwrap_or(0));
    for run in other.runs {
        match base.runs.iter_mut().find(|r| r.id == run.id) {
            Some(b) if seen(&run) > seen(b) => *b = run,
            Some(_) => {}
            None => base.runs.push(run),
        }
    }
    base.runs.sort_by_key(|r| r.id);
    if other.last_hub.as_ref().map(|h| h.at) > base.last_hub.as_ref().map(|h| h.at) {
        base.last_hub = other.last_hub;
    }
    base.hub_seen = base.hub_seen.max(other.hub_seen);
    if base.me.gamertag.is_none() {
        base.me.gamertag = other.me.gamertag;
    }
    for c in other.me.clubs {
        if !base.me.clubs.contains(&c) {
            base.me.clubs.push(c);
        }
    }
    for a in other.me.abbrs {
        if !base.me.abbrs.contains(&a) {
            base.me.abbrs.push(a);
        }
    }
    base
}

/// The scoreboard corner of a frame (2000×1125 reference coordinates, see `Frame::content_box`).
/// The two abbreviations, the scores and the clock come from a 2× crop; a lone "1" (one thin
/// stroke the OCR drops) is recognised from its ink.
pub fn board_from_frame(f: &Frame) -> Option<Board> {
    let (ox, oy, s) = f.content_box();
    let words = f.ocr_words_in(ox + 60.0 * s, oy + 30.0 * s, 300.0 * s, 140.0 * s, 2, None).ok()?;
    if let Some(b) = read_board(&words) {
        return Some(b);
    }
    // the two abbreviation words, top and bottom
    let mut abbrs: Vec<&Word> = words.iter().filter(|w| abbr(&w.text) && clock(&w.text).is_none()).collect();
    abbrs.sort_by(|a, b| a.y.total_cmp(&b.y));
    abbrs.dedup_by(|a, b| (a.y - b.y).abs() < b.h * 0.6);
    if abbrs.len() < 2 {
        return None;
    }
    let (top, bottom) = (abbrs[0], abbrs[1]);
    let h = top.h.max(bottom.h);
    // each row's score: a number read on its row, else a lone "1" from the ink of its cell
    let row_score = |a: &Word| -> Option<u8> {
        let read = words.iter().filter(|w| (cy(w) - cy(a)).abs() < h * 0.6 && w.x > a.x + h * 3.0).find_map(|w| num(&w.text));
        read.map(|n| n as u8).filter(|n| *n < 40).or_else(|| lone_one(f, (a.x + h * 5.0, a.y - h * 0.2, h * 2.0, h * 1.4)).then_some(1))
    };
    let pair = [row_score(top)?, row_score(bottom)?];
    let refs: Vec<&Word> = words.iter().collect();
    let (minute, et) = rows(&refs)
        .iter()
        .find_map(|r| {
            let joined: String = r.iter().map(|w| w.text.as_str()).collect();
            clock(&joined).map(|m| (m, r.iter().any(|w| w.text == "ET")))
        })
        .map_or((None, false), |(m, e)| (Some(m), e));
    Some(Board { home_abbr: top.text.clone(), away_abbr: bottom.text.clone(), home: pair[0], away: pair[1], minute, extra_time: et || minute.is_some_and(|m| m > 96) })
}

/// A lone "1" in a score cell: Windows OCR drops it (one thin stroke), so it is recognised from
/// its ink – one narrow, tall shape (any other digit is at least half as wide as it is tall).
/// The scoreboard's own border at the cell's right edge is left out.
fn lone_one(f: &Frame, c: (f32, f32, f32, f32)) -> bool {
    let (x0, y0, cw, ch) = (c.0.max(0.0) as u32, c.1.max(0.0) as u32, c.2 as u32, c.3 as u32);
    let on = |x: u32, y: u32| x0 + x < f.width && y0 + y < f.height && f.luma(x0 + x, y0 + y) > 150;
    // a column lit over almost the whole cell height is a border line, not a digit
    let cols: Vec<u32> = (0..cw).filter(|&x| {
        let lit = (0..ch).filter(|&y| on(x, y)).count() as u32;
        lit > 0 && lit < ch * 9 / 10
    }).collect();
    // the widest run of neighbouring lit columns is the digit (a badge edge or stray pixels are apart)
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for &x in &cols {
        match runs.last_mut() {
            Some((_, r)) if x <= *r + 1 => *r = x,
            _ => runs.push((x, x)),
        }
    }
    let Some(&(l, r)) = runs.iter().max_by_key(|&&(l, r)| (l..=r).map(|x| (0..ch).filter(|&y| on(x, y)).count()).sum::<usize>()) else { return false };
    let rws: Vec<u32> = (0..ch).filter(|&y| (l..=r).any(|x| on(x, y))).collect();
    let (Some(&t), Some(&b)) = (rws.first(), rws.last()) else { return false };
    let h = b - t + 1;
    if (h as f32) < ch as f32 * 0.4 {
        return false;
    }
    // the stroke below the flag: narrow on every row, and straight (a "7" leans, a "4" has a bar)
    let lower: Vec<(f32, f32)> = (t + h * 11 / 20..=b)
        .filter_map(|y| {
            let xs: Vec<u32> = (l..=r).filter(|&x| on(x, y)).collect();
            Some(((xs.len()) as f32, (*xs.first()? + *xs.last()?) as f32 / 2.0))
        })
        .collect();
    if lower.len() < 3 {
        return false;
    }
    let widest = lower.iter().map(|p| p.0).fold(0.0, f32::max);
    let (lo, hi) = lower.iter().fold((f32::MAX, f32::MIN), |(lo, hi), p| (lo.min(p.1), hi.max(p.1)));
    widest < h as f32 * 0.45 && hi - lo <= h as f32 * 0.15
}

/// How the match loop paces its looks (tracking.rs).
#[derive(Default)]
pub struct Live {
    last_look: Option<Instant>,
    looks: u32,
    /// The scoreboard was seen in this match (kickoff happened).
    kicked_off: bool,
    last_minute: Option<u16>,
    board_missing: u32,
    /// Read every frame until this moment (after full time: the result card can be gone in ~1.5 s).
    burst_until: Option<Instant>,
    result_read: bool,
    versus_read: bool,
}

/// After full time the screens are read this often.
pub const BURST_LOOK: Duration = Duration::from_millis(120);
const BURST_FOR: Duration = Duration::from_secs(25);

impl Live {
    /// Kickoff was seen (the scoreboard is on screen).
    pub fn kicked_off(&self) -> bool {
        self.kicked_off
    }

    pub fn bursting(&self) -> bool {
        self.burst_until.is_some_and(|t| Instant::now() < t)
    }

    fn start_burst(&mut self) {
        if !self.bursting() {
            self.burst_until = Some(Instant::now() + BURST_FOR);
        }
    }

    /// The interval to the next look.
    pub fn interval(&self, normal: Duration) -> Duration {
        if self.bursting() {
            BURST_LOOK
        } else {
            normal
        }
    }

    /// One look in a match: the full picture of the game window. Returns what was recognised and,
    /// when a whole-frame read was made, that frame (half resolution) for the session.
    pub fn look(&mut self, w: u32, h: u32, px: Vec<u8>, now: u64) -> (Vec<Seen>, Option<Frame>) {
        self.last_look = Some(Instant::now());
        self.looks += 1;
        let mut out = Vec::new();
        let bare = Frame { width: w, height: h, bgra: px, words: Vec::new() };
        // 1. the scoreboard (small crop, every look)
        let board = board_from_frame(&bare);
        match &board {
            Some(b) => {
                self.kicked_off = true;
                self.board_missing = 0;
                if b.minute.is_some() {
                    self.last_minute = b.minute;
                }
                out.push(Seen::Board(b.clone()));
            }
            None => {
                self.board_missing += 1;
                // full time: the clock was at the end and the scoreboard is gone
                if self.kicked_off && self.last_minute.is_some_and(|m| m >= 89) && self.board_missing >= 1 {
                    self.start_burst();
                }
            }
        }
        // 2. a whole-frame read (half resolution): before kickoff every look (kit, versus, a
        //    leaver), in play every 3rd look or when the scoreboard is gone, every look in a burst
        let whole = self.bursting() || !self.kicked_off || board.is_none() || self.looks % 3 == 0;
        if !whole {
            return (out, None);
        }
        // half resolution only on big screens (2880 × 1800 …): on a 1080p screen the text would be
        // too small for the OCR
        let (w2, h2, small) = if bare.width > 2200 { crate::scan::downscale2(bare.width, bare.height, &bare.bgra) } else { (bare.width, bare.height, bare.bgra.clone()) };
        let Ok(half) = crate::scan::frame_from_pixels(w2, h2, small) else { return (out, None) };
        if looks_like_result(&half.words) && !self.result_read {
            // the result card: read in full resolution (gamertags are small, the score thin)
            if let Ok(full) = crate::scan::frame_from_pixels(bare.width, bare.height, bare.bgra.clone()) {
                if let Some(c) = read_result(&full.words, Some(&full)) {
                    self.result_read = c.score.is_some();
                    out.push(Seen::Result(c));
                }
            }
            self.start_burst();
        } else if !self.versus_read && half.words.windows(2).any(|w| w[0].text == "FUT" && w[1].text == "CHAMPIONS") {
            // the versus card (~3 s, animated): the club lines are small – full resolution
            if let Ok(full) = crate::scan::frame_from_pixels(bare.width, bare.height, bare.bgra.clone()) {
                if let Some((home, away)) = read_versus(&full.words) {
                    self.versus_read = home.club.is_some() && away.club.is_some();
                    out.push(Seen::Versus { home, away });
                }
            }
        } else if let Some(seen) = read_screen(&half.words, None, now) {
            if matches!(seen, Seen::Disconnect | Seen::RankWin | Seen::OpponentLeft) {
                self.start_burst();
            }
            out.push(seen);
        }
        (out, Some(half))
    }
}

pub static LIVE: Mutex<Option<Live>> = Mutex::new(None);

#[cfg(test)]
mod tests {
    use super::*;

    fn w(x: f32, y: f32, h: f32, t: &str) -> Word {
        Word { text: t.into(), x, y, w: t.len() as f32 * h * 0.55, h }
    }

    /// The hub of the user's screenshot (Contender I, 4 W, 4 L, 7 left), as Windows OCR reads it.
    fn hub_words() -> Vec<Word> {
        vec![
            w(150., 144., 22., "Play"), w(246., 138., 25., "Rivals"), w(426., 145., 18., "Rivals"), w(536., 144., 23., "Champions"),
            w(153., 261., 27., "CHAMPIONS"), w(151., 318., 15., "Event"), w(207., 318., 16., "ends"), w(256., 318., 15., "in"),
            w(322., 317., 16., "3"), w(340., 317., 20., "Days"), w(394., 317., 16., "9"), w(413., 317., 17., "Hours"),
            w(654., 667., 17., "Rank"), w(710., 667., 17., "Rewards"), w(826., 822., 19., "Contender"), w(949., 822., 18., "I"),
            w(826., 867., 25., "4/5"), w(888., 870., 27., "pts"), w(1171., 661., 17., "Performance"), w(1187., 956., 18., "Wins"),
            w(1207., 986., 24., "4"), w(1363., 753., 40., "4"), w(1348., 811., 19., "Points"), w(1317., 956., 18., "Losses"),
            w(1346., 987., 23., "4"), w(1464., 955., 24., "Remaining"), w(1513., 987., 23., "7"),
        ]
    }

    #[test]
    fn reads_the_hub() {
        let h = read_hub(&hub_words(), 0).unwrap();
        assert_eq!((h.wins, h.losses, h.remaining, h.points), (4, 4, 7, Some(4)));
        assert_eq!(h.rank.as_deref(), Some("Contender I"));
        assert_eq!(h.rank_pts, Some([4, 5]));
        assert_eq!(h.ends_at, Some((3 * 24 + 9) * HOUR));
    }

    #[test]
    fn a_zero_read_as_the_letter_o_is_zero() {
        let mut ws = hub_words();
        ws[24].text = "O".into(); // Losses
        assert_eq!(read_hub(&ws, 0).unwrap().losses, 0);
    }

    fn result_words() -> Vec<Word> {
        // witsel2003 (Nice SC) 6-0 Aoazy5652 (Class on Grass, 6W-6L) – the user's screenshot
        vec![
            w(519., 269., 25., "witse12003"), w(717., 302., 24., "FL/7"), w(616., 324., 15., "Nice"), w(661., 324., 15., "SC"),
            w(567., 349., 15., "Est."), w(604., 349., 15., "Mar"), w(641., 349., 15., "2025"), w(774., 699., 53., "941"),
            w(691., 790., 19., "Match"), w(764., 790., 19., "Coins"), w(830., 790., 19., "Awarded"), w(960., 265., 24., "WIN"),
            w(1333., 269., 30., "Aoazy5652"), w(1333., 324., 15., "Class"), w(1386., 328., 11., "on"), w(1412., 324., 15., "Grass"),
            w(1333., 349., 15., "Est."), w(1371., 349., 19., "May"), w(1413., 349., 15., "2022"), w(1333., 375., 16., "6W-6L"),
            w(1311., 699., 53., "64"), w(1244., 790., 19., "SP"), w(1277., 790., 19., "Awarded"), w(94., 1138., 18., "Advance"),
            w(257., 1139., 16., "Back"),
        ]
    }

    #[test]
    fn reads_the_result_card() {
        let c = read_result(&result_words(), None).unwrap();
        assert_eq!(c.sides[0].gamertag.as_deref(), Some("witse12003"));
        assert_eq!(c.sides[0].club.as_deref(), Some("Nice SC"));
        assert_eq!(c.sides[0].est.as_deref(), Some("Mar 2025"));
        assert_eq!(c.sides[0].record, None);
        assert_eq!(c.sides[1].gamertag.as_deref(), Some("Aoazy5652"));
        assert_eq!(c.sides[1].club.as_deref(), Some("Class on Grass"));
        assert_eq!(c.sides[1].record, Some([6, 6]));
        assert_eq!(c.win, Some(true));
        assert_eq!((c.coins, c.sp), (Some(941), Some(64)));
    }

    #[test]
    fn abbreviations_match_through_ocr_slips() {
        assert!(same_abbr("NSS", "NS5"));
        assert!(!same_abbr("NIC", "NS5"));
    }

    #[test]
    fn records_and_scores_survive_ocr_slips() {
        assert_eq!(record("TW-OL"), Some([1, 0]));
        assert_eq!(record("OW-IL"), Some([0, 1]));
        assert_eq!(record("3W-0L"), Some([3, 0]));
        assert_eq!(score("6-O"), Some([6, 0]));
        assert_eq!(score("1 - 11"), Some([1, 11]));
        assert_eq!(clock("114:08"), Some(114));
        assert_eq!(clock("00:04"), Some(0));
    }

    #[test]
    fn reads_the_scoreboard() {
        let ws = vec![w(249., 100., 21., "NS5"), w(394., 97., 24., "o"), w(249., 132., 22., "NIC"), w(394., 133., 24., "O"), w(247., 178., 18., "00:04")];
        let b = read_board(&ws).unwrap();
        assert_eq!((b.home_abbr.as_str(), b.away_abbr.as_str(), b.home, b.away, b.minute), ("NS5", "NIC", 0, 0, Some(0)));
    }

    #[test]
    fn reads_the_versus_card() {
        let ws = vec![
            w(921., 439., 33., "FUT"), w(920., 493., 34., "CHAMPIONS"), w(807., 675., 73., "NS5"), w(803., 781., 26., "NS105"),
            w(807., 959., 73., "NIC"), w(803., 1064., 26., "NICE"), w(916., 1064., 26., "SC"),
        ];
        let (h, a) = read_versus(&ws).unwrap();
        assert_eq!((h.abbr.as_deref(), h.club.as_deref()), (Some("NS5"), Some("NS105")));
        assert_eq!((a.abbr.as_deref(), a.club.as_deref()), (Some("NIC"), Some("NICE SC")));
    }

    fn hub(w: u8, l: u8) -> Seen {
        Seen::Hub(Hub { at: 0, wins: w, losses: l, remaining: 15 - w - l, points: Some(w as u32), ends_at: Some(72 * HOUR), ..Default::default() })
    }

    fn board(h: u8, a: u8, min: u16) -> Seen {
        Seen::Board(Board { home_abbr: "NS5".into(), away_abbr: "NIC".into(), home: h, away: a, minute: Some(min), extra_time: false })
    }

    #[test]
    fn the_hub_confirms_a_win_with_its_goals() {
        let mut d = Data::default();
        d.observe(hub(3, 1), 0);
        d.observe(Seen::KitChampions, 10);
        d.observe(board(0, 0, 0), 20);
        d.observe(board(1, 0, 12), 30);
        d.observe(board(1, 0, 13), 31);
        d.observe(board(1, 1, 44), 40);
        d.observe(board(2, 1, 88), 50);
        let mut card = Card::default();
        card.sides[1].record = Some([2, 2]);
        card.score = Some([2, 1]);
        card.win = Some(true);
        d.observe(Seen::Result(card), 60);
        // a hub before the update: nothing counted yet
        d.observe(hub(3, 1), 61);
        assert!(d.runs[0].matches.is_empty());
        d.observe(hub(4, 1), 70);
        let m = &d.runs[0].matches[0];
        assert_eq!(m.outcome, Some(Outcome::Win));
        assert!(m.confirmed);
        assert_eq!(m.n, Some(5));
        assert_eq!(m.me_home, Some(true));
        assert_eq!(m.timeline, vec![[12, 1, 0], [44, 1, 1], [88, 2, 1]]);
        assert!(d.pending.is_none());
    }

    #[test]
    fn leaving_a_match_is_a_quit_with_the_score_when_left() {
        let mut d = Data::default();
        d.observe(hub(1, 0), 0);
        d.observe(Seen::KitChampions, 10);
        d.observe(board(2, 5, 70), 20);
        d.observe(board(2, 5, 71), 21);
        d.observe(Seen::Pause(PauseInfo::default()), 30);
        d.observe(hub(1, 1), 40);
        let m = &d.runs[0].matches[0];
        assert_eq!(m.outcome, Some(Outcome::Quit));
        assert_eq!(m.last, Some([71, 2, 5]));
    }

    #[test]
    fn an_opponent_leaving_before_kickoff_is_no_match() {
        let mut d = Data::default();
        d.observe(hub(1, 0), 0);
        d.observe(Seen::KitChampions, 10);
        d.observe(Seen::OpponentLeft, 11);
        d.observe(hub(1, 0), 20);
        assert!(d.runs[0].matches.is_empty());
        assert!(d.pending.is_none());
    }

    #[test]
    fn games_the_hub_counted_without_us_are_placeholders() {
        let mut d = Data::default();
        d.observe(hub(1, 0), 0);
        d.observe(hub(3, 1), 10);
        let ms = &d.runs[0].matches;
        assert_eq!(ms.len(), 3);
        assert!(ms.iter().all(|m| m.hub_only));
        assert_eq!(ms.iter().filter(|m| m.outcome == Some(Outcome::Win)).count(), 2);
        assert_eq!(ms.iter().map(|m| m.n.unwrap()).collect::<Vec<_>>(), vec![2, 3, 4]);
    }

    #[test]
    fn a_new_weekend_starts_a_new_run() {
        let mut d = Data::default();
        d.observe(hub(10, 5), 0);
        let mut next = Hub { at: 7 * 24 * HOUR, wins: 0, losses: 0, remaining: 15, ends_at: Some(7 * 24 * HOUR + 72 * HOUR), ..Default::default() };
        d.observe(Seen::Hub(next.clone()), next.at);
        next.wins = 1;
        next.remaining = 14;
        d.observe(Seen::Hub(next), 7 * 24 * HOUR + 1);
        assert_eq!(d.runs.len(), 2);
        assert_eq!(d.runs[1].matches.len(), 1);
    }

    #[test]
    fn the_first_match_of_a_new_weekend_counts_without_a_hub_before_it() {
        let mut d = Data::default();
        d.observe(hub(9, 6), 0); // last weekend's final hub
        let week = 7 * 24 * HOUR;
        d.observe(Seen::KitChampions, week);
        d.observe(board(1, 0, 30), week + 1);
        d.observe(board(1, 0, 31), week + 2);
        let h = Hub { at: week + 3, wins: 1, losses: 0, remaining: 14, ends_at: Some(week + 72 * HOUR), ..Default::default() };
        d.observe(Seen::Hub(h), week + 3);
        assert_eq!(d.runs.len(), 2);
        let m = &d.runs[1].matches;
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].outcome, Some(Outcome::Win));
        assert!(!m[0].hub_only);
    }

    #[test]
    fn a_misread_score_jump_is_ignored() {
        let mut d = Data::default();
        d.observe(Seen::KitChampions, 0);
        d.observe(board(0, 0, 0), 1);
        d.observe(board(8, 0, 10), 2); // "0" read as "8"
        d.observe(board(1, 0, 20), 3);
        assert_eq!(d.pending.as_ref().unwrap().timeline, vec![[20, 1, 0]]);
    }

    #[test]
    fn the_user_is_learned_and_found_again_by_club() {
        let mut d = Data::default();
        d.observe(hub(0, 0), 0);
        d.observe(Seen::KitChampions, 1);
        let mut card = Card::default();
        card.sides[0] = Team { gamertag: Some("witsel2003".into()), club: Some("Nice SC".into()), ..Default::default() };
        card.sides[1] = Team { gamertag: Some("Aoazy5652".into()), club: Some("Class on Grass".into()), record: Some([6, 6]), ..Default::default() };
        card.win = Some(true);
        d.observe(Seen::Result(card), 2);
        d.observe(hub(1, 0), 3);
        assert_eq!(d.me.gamertag.as_deref(), Some("witsel2003"));
        // next match: the user plays away, known from his club on the versus card
        d.observe(Seen::KitChampions, 4);
        d.observe(Seen::Versus { home: Team { abbr: Some("NS5".into()), club: Some("NS105".into()), ..Default::default() }, away: Team { abbr: Some("NIC".into()), club: Some("NICE SC".into()), ..Default::default() } }, 5);
        assert_eq!(d.pending.as_ref().unwrap().me_home, Some(false));
    }

    #[test]
    fn a_rivals_match_is_not_tracked() {
        let mut d = Data::default();
        d.observe(hub(2, 0), 0);
        // the Rivals kit selection after the Champions hub: not a Champions match
        d.observe(Seen::OtherMode, 1);
        assert!(!d.expects_match(2));
        assert!(!d.observe(board(1, 0, 10), 2));
        let mut card = Card::default();
        card.win = Some(true);
        assert!(!d.observe(Seen::Result(card), 2));
        assert!(d.pending.is_none());
    }

    #[test]
    fn a_match_right_after_the_hub_is_tracked_without_its_kit_selection() {
        let mut d = Data::default();
        d.observe(hub(4, 0), 0);
        // the kit selection and the versus card were missed: straight to the scoreboard
        assert!(d.expects_match(60_000));
        d.observe(board(0, 0, 1), 60_000);
        d.observe(board(4, 0, 80), 61_000);
        d.observe(board(4, 0, 90), 62_000);
        let mut card = Card::default();
        card.sides[1].record = Some([3, 3]);
        card.score = Some([4, 0]);
        card.win = Some(true);
        d.observe(Seen::Result(card), 63_000);
        d.observe(hub(5, 0), 70_000);
        let m = d.runs[0].matches.last().unwrap();
        assert!(!m.hub_only, "read from the match itself, not only counted from the hub");
        assert_eq!(m.outcome, Some(Outcome::Win));
        assert_eq!(m.score, Some([4, 0]));
        // long after the hub (and no hub since): not expected
        assert!(!d.expects_match(70_000 + HUB_TO_MATCH + 1) || d.hub_seen == Some(70_000));
    }

    #[test]
    fn a_guess_from_the_hub_that_never_gets_counted_is_dropped() {
        let mut d = Data::default();
        d.observe(hub(4, 0), 0);
        d.observe(board(1, 0, 30), 1);
        d.observe(board(1, 0, 31), 2);
        // a Champions kit selection next, the hub never counted it: it wasn't a Champions match
        d.observe(Seen::KitChampions, 3);
        assert!(d.runs[0].matches.is_empty());
    }

    #[test]
    fn the_match_score_decides_when_one_hub_counts_two_games() {
        let mut d = Data::default();
        d.observe(hub(3, 1), 0);
        // match A: lost 1-2 (result card), no hub read before the next kit selection
        d.observe(Seen::KitChampions, 10);
        d.observe(board(1, 2, 90), 20);
        d.observe(board(1, 2, 91), 21);
        let mut a = Card::default();
        a.sides[1].record = Some([5, 5]);
        a.score = Some([1, 2]);
        a.win = Some(false);
        d.observe(Seen::Result(a), 22);
        // match B: won 3-0
        d.observe(Seen::KitChampions, 30);
        d.observe(board(3, 0, 90), 40);
        d.observe(board(3, 0, 91), 41);
        let mut b = Card::default();
        b.sides[1].record = Some([2, 2]);
        b.score = Some([3, 0]);
        b.win = Some(true);
        d.observe(Seen::Result(b), 42);
        d.observe(hub(4, 2), 50);
        let ms = &d.runs[0].matches;
        assert_eq!(ms.len(), 2, "two games, two rows – no placeholder on top");
        assert_eq!(ms[0].outcome, Some(Outcome::Loss));
        assert_eq!(ms[1].outcome, Some(Outcome::Win));
        assert!(ms.iter().all(|m| m.confirmed && !m.hub_only));
        assert_eq!(ms.iter().map(|m| m.n.unwrap()).collect::<Vec<_>>(), vec![5, 6]);
    }

    #[test]
    fn a_score_read_the_wrong_way_round_is_turned_by_the_hub() {
        let mut d = Data::default();
        d.observe(hub(2, 0), 0);
        d.observe(Seen::KitChampions, 10);
        // the user was taken for the home side, but he is away: 2-1 for the opponent
        d.pending.as_mut().unwrap().me_home = Some(true);
        d.observe(board(2, 1, 90), 20);
        d.observe(board(2, 1, 91), 21);
        d.observe(hub(2, 1), 30);
        let m = &d.runs[0].matches[0];
        assert_eq!(m.outcome, Some(Outcome::Loss));
        assert_eq!(m.me_home, Some(false), "the sides were turned so the score agrees with the loss");
    }

    #[test]
    fn a_misread_hub_waits_for_a_second_reading() {
        let mut d = Data::default();
        d.observe(hub(6, 2), 0);
        // "6" read as "8": doesn't fit (the total of the run changes) – not counted
        let mut bad = Hub { at: 1, wins: 8, losses: 2, remaining: 7, ends_at: Some(72 * HOUR), ..Default::default() };
        d.observe(Seen::Hub(bad.clone()), 1);
        assert!(d.runs[0].matches.is_empty());
        assert_eq!(d.last_hub.as_ref().unwrap().wins, 6);
        // the real record keeps counting
        d.observe(hub(7, 2), 2);
        assert_eq!(d.runs[0].matches.len(), 1);
        // a reading that goes down in the same event is a misread too
        bad.wins = 3;
        bad.remaining = 10;
        d.observe(Seen::Hub(bad), 3);
        d.observe(hub(8, 2), 4);
        assert_eq!(d.runs.len(), 1);
        assert_eq!(d.runs[0].matches.len(), 2);
        assert_eq!(d.last_hub.as_ref().unwrap().wins, 8);
    }

    #[test]
    fn a_timer_read_a_day_off_is_still_the_same_weekend() {
        let mut d = Data::default();
        d.observe(hub(6, 2), 0);
        // "1 Day 18 Hours" read as "18 Hours": 24 h off – the same event, the record keeps counting
        let h = Hub { at: 1, wins: 7, losses: 2, remaining: 6, ends_at: Some(48 * HOUR), ..Default::default() };
        d.observe(Seen::Hub(h), 1);
        assert_eq!(d.runs.len(), 1);
        assert_eq!(d.runs[0].matches.len(), 1);
    }

    #[test]
    #[ignore]
    fn reads_fixture_screens() {
        let Ok(dir) = std::env::var("FCT_CHAMPS_FIXTURES") else { return };
        let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
        files.sort();
        for p in files {
            let frame = crate::scan::analyse_bytes(&std::fs::read(&p).unwrap()).unwrap();
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            let seen = read_screen(&frame.words, Some(&frame), 0);
            let board = board_from_frame(&frame);
            println!("{name}: {seen:?}\n   board: {board:?}");
        }
    }
}

#[cfg(test)]
mod live_sim {
    use super::*;

    /// The user's recording (kit selection → kickoff), one frame per second, through the match loop.
    #[test]
    #[ignore]
    fn the_match_loop_on_a_recording() {
        let Ok(dir) = std::env::var("FCT_CHAMPS_REC") else { return };
        let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
        files.sort();
        let mut live = Live::default();
        let mut data = Data::default();
        data.observe(Seen::Hub(Hub { wins: 4, losses: 4, remaining: 7, ..Default::default() }), 0);
        for (i, p) in files.iter().enumerate() {
            let f = crate::scan::analyse_bytes(&std::fs::read(p).unwrap()).unwrap();
            let t = Instant::now();
            let (seen, half) = live.look(f.width, f.height, f.bgra, i as u64 * 1000);
            let ms = t.elapsed().as_millis();
            let screen = half.as_ref().map(|h| format!("{:?}", crate::session::classify(h, &crate::scan::Page::Other)));
            println!("{i:>3} {ms:>4} ms {screen:?} {seen:?}");
            for s in seen {
                data.observe(s, i as u64 * 1000);
            }
        }
        println!("pending: {:?}", data.pending);
    }
}

#[cfg(test)]
mod live_result {
    use super::*;

    /// The result card and the rank screen through a look after full time.
    #[test]
    #[ignore]
    fn a_look_reads_the_result_card() {
        let Ok(dir) = std::env::var("FCT_CHAMPS_FIXTURES") else { return };
        let mut live = Live { kicked_off: true, last_minute: Some(90), ..Default::default() };
        for file in ["result-win-6-0.webp", "rank-win.webp"] {
            let f = crate::scan::analyse_bytes(&std::fs::read(std::path::Path::new(&dir).join(file)).unwrap()).unwrap();
            let t = Instant::now();
            let (seen, _) = live.look(f.width, f.height, f.bgra, 0);
            println!("{file} {} ms bursting {} {seen:?}", t.elapsed().as_millis(), live.bursting());
        }
    }
}



