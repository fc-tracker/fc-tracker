//! Live events' entry rules, read on the event's page in the game (LIVE-EVENTS.md). EA's Web App
//! has no list of them, so a live event without read rules gets no squad. The page names the event
//! and lists what may play in it ("Min. OVR 65", "Max. Silver", "No requirements"); what the text
//! reader finds is kept (webdata `event_rules`) and the plan follows at once. Only what the screen
//! says is taken – an event's name never sets a rule. Menus only.
use crate::scan::Word;
use crate::squads::{EntryRules, Mode};
use serde_json::Value;

/// The live events the open objectives play in (the planner's names: lower case, no "event").
pub fn event_names(objectives: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for g in crate::squads::groups_from_value(objectives) {
        for o in g.objectives.iter().filter(|o| !o.done) {
            for m in crate::squads::objective_modes(&o.text).unwrap_or_default() {
                if let Mode::Event(n) = m {
                    let n = n.trim_end_matches(" event").to_string();
                    if n.len() >= 4 && !out.contains(&n) {
                        out.push(n);
                    }
                }
            }
        }
    }
    out
}

/// What one look at an event page found.
#[derive(Debug, Clone, PartialEq)]
pub enum Read {
    /// The rules (an empty set = any card).
    Rules(String, EntryRules),
    /// The event's requirements are on screen but nothing in them could be read (logged, so the
    /// reader can learn the wording).
    Unread(String),
}

/// The words that say a requirements list is on screen.
fn requirements_on_screen(l: &str) -> bool {
    l.contains("requirement") || l.contains("entry rule") || l.contains("squad rule")
}

pub fn read_screen(words: &[Word], events: &[String]) -> Option<Read> {
    let text = words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
    let screen = crate::names::normalise_name(&text);
    // the longest event name on screen
    let event = events.iter().filter(|n| screen.contains(crate::names::normalise_name(n).as_str())).max_by_key(|n| n.len())?.clone();
    let l = text.to_lowercase();
    if !requirements_on_screen(&l) && !l.contains("no requirements") {
        return None;
    }
    let rules = parse(&l);
    if rules != EntryRules::default() {
        return Some(Read::Rules(event, rules));
    }
    // Entry and squad requirements both say none (Ghoul Fest: "No Entry Requirements" next to a
    // squad rule – a "none" is only "any card" when no other requirement is left on screen)
    let none = ["no requirements", "no entry requirements", "no squad requirements"].iter().filter(|k| l.contains(*k)).count();
    let lists = ["entry requirements", "squad requirements"].iter().filter(|k| l.contains(*k)).count();
    Some(if none > 0 && (l.contains("no requirements") || none >= lists) { Read::Rules(event, EntryRules::default()) } else { Read::Unread(event) })
}

/// "Min. OVR 65" / "OVR: Max. 74" / "Min. 75 OVR" / "Player quality: Max. Silver" / "Exactly Silver".
fn parse(l: &str) -> EntryRules {
    let t: Vec<&str> = l.split(|c: char| c.is_whitespace() || c == ':' || c == ',').filter(|s| !s.is_empty()).collect();
    let num = |s: &str| s.trim_matches(|c: char| !c.is_ascii_digit()).parse::<u32>().ok().filter(|n| (40..=99).contains(n));
    let kind = |s: &str| {
        let s = s.trim_end_matches('.');
        if s == "min" || s == "minimum" {
            Some(-1)
        } else if s == "max" || s == "maximum" {
            Some(1)
        } else if s == "exactly" {
            Some(0)
        } else {
            None
        }
    };
    let mut r = EntryRules::default();
    // "88 and higher ovr players: max. 1 in squad" / "74 and lower ovr players: min. 11"
    for i in 0..t.len().saturating_sub(5) {
        let (Some(rating), "and") = (num(t[i]), t[i + 1]) else { continue };
        let higher = match t[i + 2] {
            "higher" => true,
            "lower" => false,
            _ => continue,
        };
        if !t[i + 3].starts_with("ovr") && !t[i + 3].starts_with("rated") {
            continue;
        }
        let rest = &t[i + 4..(i + 9).min(t.len())];
        let Some(k) = rest.iter().position(|w| kind(w).is_some()) else { continue };
        let Some(n) = rest.get(k + 1).and_then(|w| w.trim_matches(|c: char| !c.is_ascii_digit()).parse::<u32>().ok()) else { continue };
        match (higher, kind(rest[k]).unwrap()) {
            (true, 1) => r.cap = Some([rating, n]),
            (true, -1 | 0) if n >= 11 => r.min_rating = Some(rating),
            (false, -1 | 0) if n >= 11 => r.max_rating = Some(rating),
            (false, 1) if n == 0 => r.min_rating = Some(rating + 1),
            _ => {}
        }
    }
    let mut set = |k: i32, lo: u32, hi: u32| match k {
        -1 => r.min_rating = Some(r.min_rating.map_or(lo, |m| m.max(lo))),
        1 => r.max_rating = Some(r.max_rating.map_or(hi, |m| m.min(hi))),
        _ => {
            r.min_rating = Some(lo);
            r.max_rating = Some(hi);
        }
    };
    for i in 0..t.len() {
        let Some(k) = kind(t[i]) else { continue };
        // part of a count rule (read above)
        if t[i.saturating_sub(4)..i].iter().any(|w| *w == "higher" || *w == "lower") {
            continue;
        }
        // a team (squad) rating is no limit on one card
        let lo = i.saturating_sub(3);
        if (lo..(i + 3).min(t.len())).any(|j| t[j].starts_with("rating") && j > 0 && matches!(t[j - 1], "team" | "squad")) {
            continue;
        }
        // the next few words: a number next to OVR / rating, or a card quality
        let near = &t[i + 1..(i + 4).min(t.len())];
        let ovr = near.iter().chain(t[i.saturating_sub(2)..i].iter()).any(|w| w.starts_with("ovr") || w.starts_with("rating") || w.starts_with("rated"));
        if let Some(n) = near.iter().find_map(|w| num(w)).filter(|_| ovr) {
            set(k, n, n);
            continue;
        }
        let quality = near.iter().find_map(|w| match w.trim_end_matches('.') {
            "bronze" => Some((40, 64)),
            "silver" => Some((65, 74)),
            "gold" => Some((75, 99)),
            _ => None,
        });
        if let Some((lo, hi)) = quality {
            set(k, lo, hi);
        }
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &str) -> Vec<Word> {
        s.split_whitespace().map(|t| Word { text: t.into(), x: 0.0, y: 0.0, w: 0.0, h: 0.0 }).collect()
    }
    fn ev() -> Vec<String> {
        vec!["ghoul fest".into(), "silver bullets flash rush".into()]
    }

    #[test]
    fn ratings_and_qualities_are_read() {
        let r = |s: &str| read_screen(&words(s), &ev());
        assert_eq!(r("Silver Bullets Flash Rush Entry Requirements Player Quality: Max. Silver Min. OVR 65"), Some(Read::Rules("silver bullets flash rush".into(), EntryRules { min_rating: Some(65), max_rating: Some(74), cap: None })));
        assert_eq!(r("Ghoul Fest Squad Requirements Exactly Gold"), Some(Read::Rules("ghoul fest".into(), EntryRules { min_rating: Some(75), max_rating: Some(99), cap: None })));
        assert_eq!(r("Ghoul Fest Squad Requirements Player Rating: Min. 80"), Some(Read::Rules("ghoul fest".into(), EntryRules { min_rating: Some(80), max_rating: None, cap: None })));
        // a team rating limits the squad, not each card: not taken as a card rule
        assert_eq!(r("Ghoul Fest Squad Requirements Team Rating: Min. 80"), Some(Read::Unread("ghoul fest".into())));
        assert_eq!(r("Ghoul Fest No Requirements Play"), Some(Read::Rules("ghoul fest".into(), EntryRules::default())));
        // the real Ghoul Fest page (video 2026-11-02)
        assert_eq!(
            r("Play Ghoul Fest Your Squad Your Progress GHOUL FEST Event Ends In 3 Days 19 Hours Player vs Player • Casual • Co-op • No Rules Squad Requirements 88 and Higher OVR Players: Max. 1 in Squad Entry Requirements No Entry Requirements Select Squad Play Event"),
            Some(Read::Rules("ghoul fest".into(), EntryRules { min_rating: None, max_rating: None, cap: Some([88, 1]) }))
        );
        assert_eq!(r("Ghoul Fest Squad Requirements Entry Requirements No Entry Requirements"), Some(Read::Unread("ghoul fest".into())), "a squad list we can't read is no 'any card'");
        assert_eq!(r("Ghoul Fest Entry Requirements No Entry Requirements"), Some(Read::Rules("ghoul fest".into(), EntryRules::default())));
    }

    #[test]
    fn nothing_is_guessed() {
        // requirements we can't read yet: noted, never "any card"
        assert_eq!(read_screen(&words("Ghoul Fest Squad Requirements Min. 3 Players from Halloween"), &ev()), Some(Read::Unread("ghoul fest".into())));
        // the event's name alone (its objectives page) is no read
        assert_eq!(read_screen(&words("Ghoul Fest Score 30 Score a total of 30 goals"), &ev()), None);
        assert_eq!(read_screen(&words("Rivals Requirements Min. OVR 80"), &ev()), None);
    }
}
