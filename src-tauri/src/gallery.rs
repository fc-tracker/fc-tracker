//! Gallery scoring – our own implementation of FC27's Gallery rules.
//!
//! A set score = base + bonus:
//! - base  = sum of `gradingScore` of the selected cards (max the set's slot count).
//! - bonus = for each bonus tag, count the qualifying cards; the highest reached step gives a
//!   percentage, and the tag's bonus is `floor(sum of qualifying cards' scores × pct / 100)`.
//!   Same Club / Same League: the largest group sets the step and every group at that step pays
//!   with it (Arsenal: men 10 + women 10 → 2 % of all 20; men 11 + women 9 → 2 % of the men only);
//!   Same Nation / Multiples!: the best single group (not verified otherwise);
//!   "Different X" tags count distinct values and use the top card of each group. Position tags
//!   count every position a card can play (EA `possiblePositions`). Only the `TAG_CAP` largest
//!   tag bonuses count.
//! - grade = highest grade in the set's ladder whose threshold the score reaches.
//!
//! Step tables come from in-game observation; verify against the in-game Gallery screen when EA
//! changes them.


use serde::{Deserialize, Serialize};

pub const TAG_CAP: usize = 10;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Card {
    pub score: u64,
    pub nation: Option<u64>,
    pub club: Option<u64>,
    pub league: Option<u64>,
    /// Database id of the player (same player across versions).
    pub player: Option<u64>,
    pub rarity: Option<u64>,
    pub rating: Option<u64>,
    /// Every position the card can play (preferred first) – position tags count all of them.
    pub positions: Vec<String>,
    pub weak_foot: Option<u64>,
    pub skill_moves: Option<u64>,
    pub holo: bool,
    /// Known first owner (seen in the club with `owners == 1`, or marked by the user).
    pub first_owner: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attr {
    Nation,
    Club,
    League,
    Player,
}

#[derive(Debug, Clone)]
pub enum Rule {
    FirstOwner,
    Same(Attr),
    Different(Attr),
    Level(Level),
    Holo,
    Rarity(u64),
    Positions(&'static [&'static str]),
    WeakFootAtLeast(u64),
    SkillMovesAtLeast(u64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Bronze,
    Silver,
    Gold,
}

fn level(rating: u64) -> Level {
    match rating {
        r if r < 65 => Level::Bronze,
        r if r < 75 => Level::Silver,
        _ => Level::Gold,
    }
}

pub struct Tag {
    pub id: u32,
    pub name: &'static str,
    pub rule: Rule,
    /// (minimum qualifying cards, bonus percentage), ascending.
    pub steps: &'static [(usize, u64)],
}

pub const TAGS: &[Tag] = &[
    Tag { id: 1, name: "First Owner", rule: Rule::FirstOwner, steps: &[(5, 150), (10, 300), (20, 500)] },
    Tag { id: 3, name: "Same Nation", rule: Rule::Same(Attr::Nation), steps: &[(5, 1), (10, 2), (20, 4)] },
    Tag { id: 17, name: "Different Nation", rule: Rule::Different(Attr::Nation), steps: &[(5, 1), (10, 2), (20, 4)] },
    Tag { id: 8, name: "Same Club", rule: Rule::Same(Attr::Club), steps: &[(5, 1), (10, 2), (20, 4)] },
    Tag { id: 14, name: "Different Club", rule: Rule::Different(Attr::Club), steps: &[(5, 1), (10, 2), (20, 4)] },
    Tag { id: 16, name: "Same League", rule: Rule::Same(Attr::League), steps: &[(5, 1), (10, 2), (20, 8)] },
    Tag { id: 6, name: "Different League", rule: Rule::Different(Attr::League), steps: &[(5, 1), (10, 2), (20, 4)] },
    Tag { id: 4, name: "Bronze", rule: Rule::Level(Level::Bronze), steps: &[(5, 20), (10, 40), (20, 80)] },
    Tag { id: 11, name: "Silver", rule: Rule::Level(Level::Silver), steps: &[(5, 15), (10, 30), (20, 60)] },
    Tag { id: 7, name: "Golden", rule: Rule::Level(Level::Gold), steps: &[(5, 1), (10, 2), (20, 4)] },
    Tag { id: 12, name: "Holographic", rule: Rule::Holo, steps: &[(2, 8), (4, 12), (6, 20)] },
    Tag { id: 19, name: "Iconic", rule: Rule::Rarity(12), steps: &[(2, 10), (4, 15), (6, 25)] },
    Tag { id: 2, name: "Heroic", rule: Rule::Rarity(72), steps: &[(2, 8), (4, 12), (6, 20)] },
    Tag { id: 18, name: "TOTW", rule: Rule::Rarity(3), steps: &[(3, 4), (6, 8), (10, 15)] },
    Tag { id: 10, name: "Hands Only", rule: Rule::Positions(&["GK"]), steps: &[(3, 3), (6, 6), (10, 15)] },
    Tag { id: 15, name: "Multiples!", rule: Rule::Same(Attr::Player), steps: &[(2, 10), (3, 15), (4, 20)] },
    Tag { id: 20, name: "Ambidextrous", rule: Rule::WeakFootAtLeast(5), steps: &[(3, 3), (5, 6), (10, 12)] },
    Tag { id: 5, name: "Skilled", rule: Rule::SkillMovesAtLeast(5), steps: &[(3, 3), (5, 6), (10, 12)] },
    Tag { id: 21, name: "Defensive Wall", rule: Rule::Positions(&["RB", "CB", "LB"]), steps: &[(5, 3), (10, 6), (15, 10)] },
    Tag {
        id: 22,
        name: "Midfield Control",
        rule: Rule::Positions(&["CDM", "CM", "CAM", "LM", "RM"]),
        steps: &[(5, 3), (10, 6), (15, 10)],
    },
    Tag { id: 23, name: "All out Attack", rule: Rule::Positions(&["ST", "LW", "RW"]), steps: &[(5, 3), (10, 6), (15, 10)] },
];

#[derive(Debug, Clone, Serialize)]
pub struct TagResult {
    pub id: u32,
    pub name: &'static str,
    pub count: usize,
    pub pct: u64,
    pub bonus: u64,
    /// Whether this tag is among the `TAG_CAP` that count.
    pub counts: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Score {
    pub base: u64,
    pub bonus: u64,
    pub total: u64,
    pub tags: Vec<TagResult>,
}

fn attr(card: &Card, a: Attr) -> Option<u64> {
    match a {
        Attr::Nation => card.nation,
        Attr::Club => card.club,
        Attr::League => card.league,
        Attr::Player => card.player,
    }
}

fn qualifies(card: &Card, rule: &Rule) -> bool {
    match rule {
        Rule::FirstOwner => card.first_owner,
        Rule::Level(l) => card.rating.map(level) == Some(*l),
        Rule::Holo => card.holo,
        Rule::Rarity(r) => card.rarity == Some(*r),
        Rule::Positions(any) => card.positions.iter().any(|p| any.contains(&generic_position(p))),
        Rule::WeakFootAtLeast(n) => card.weak_foot.is_some_and(|w| w >= *n),
        Rule::SkillMovesAtLeast(n) => card.skill_moves.is_some_and(|s| s >= *n),
        Rule::Same(_) | Rule::Different(_) => false, // grouped separately
    }
}

/// RCB → CB, LDM → CDM, … so position tags match side-specific positions.
pub fn generic_position(p: &str) -> &str {
    match p {
        "RCB" | "LCB" => "CB",
        "RDM" | "LDM" => "CDM",
        "RCM" | "LCM" => "CM",
        "RAM" | "LAM" => "CAM",
        "RS" | "LS" => "ST",
        other => other,
    }
}

/// Best (count, score) → bonus for a tag, considering every candidate group.
fn best_bonus(candidates: impl Iterator<Item = (usize, u64)>, steps: &[(usize, u64)]) -> (usize, u64, u64) {
    let mut best = (0, 0, 0); // count, pct, bonus
    for (count, score) in candidates {
        let pct = steps.iter().take_while(|(from, _)| count >= *from).last().map_or(0, |s| s.1);
        let bonus = score * pct / 100;
        if bonus > best.2 || (bonus == best.2 && count > best.0) {
            best = (count, pct, bonus);
        }
    }
    best
}

pub fn score(cards: &[Card]) -> Score {
    score_refs(&cards.iter().collect::<Vec<_>>())
}

/// The groups of one attribute, read like a map's values.
struct Groups<'a>(&'a [(u64, (usize, u64, u64))]);

impl Groups<'_> {
    fn values(&self) -> impl Iterator<Item = &(usize, u64, u64)> + '_ {
        self.0.iter().map(|(_, g)| g)
    }
    fn len(&self) -> usize {
        self.0.len()
    }
}

/// `score` without copying the cards (the optimiser scores thousands of combinations).
pub fn score_refs(cards: &[&Card]) -> Score {
    let base: u64 = cards.iter().map(|c| c.score).sum();
    let mut tags: Vec<TagResult> = TAGS
        .iter()
        .map(|tag| {
            let (count, pct, bonus) = match &tag.rule {
                Rule::Same(a) | Rule::Different(a) => {
                    // group → (count, total score, top score); a small list beats a hash map for ≤ 30 cards
                    let mut list: Vec<(u64, (usize, u64, u64))> = Vec::with_capacity(cards.len());
                    for c in cards.iter().copied() {
                        if let Some(v) = attr(c, *a) {
                            let g = match list.iter_mut().find(|(k, _)| *k == v) {
                                Some((_, g)) => g,
                                None => {
                                    list.push((v, (0, 0, 0)));
                                    &mut list.last_mut().unwrap().1
                                }
                            };
                            g.0 += 1;
                            g.1 += c.score;
                            g.2 = g.2.max(c.score);
                        }
                    }
                    let groups = Groups(&list);
                    if matches!(tag.rule, Rule::Same(Attr::Nation | Attr::Player)) {
                        // Same Nation / Multiples!: the best single group (the group rule below is
                        // only verified for Same Club / Same League)
                        best_bonus(groups.values().map(|g| (g.0, g.1)), tag.steps)
                    } else if matches!(tag.rule, Rule::Same(_)) {
                        // The largest group sets the step; every group at that step pays with it
                        // (Arsenal: men 10 + women 10 → 2 % of all 20; men 11 + women 9 → men only).
                        let top = groups.values().map(|g| g.0).max().unwrap_or(0);
                        match tag.steps.iter().take_while(|(from, _)| top >= *from).last() {
                            Some(&(from, pct)) => {
                                let at_step = groups.values().filter(|g| g.0 >= from);
                                let (count, sum) = at_step.fold((0, 0), |a, g| (a.0 + g.0, a.1 + g.1));
                                (count, pct, sum * pct / 100)
                            }
                            None => (top, 0, 0),
                        }
                    } else {
                        let top_sum = groups.values().map(|g| g.2).sum();
                        best_bonus(std::iter::once((groups.len(), top_sum)), tag.steps)
                    }
                }
                rule => {
                    let (n, sum) = cards.iter().filter(|c| qualifies(c, rule)).fold((0, 0), |a, c| (a.0 + 1, a.1 + c.score));
                    best_bonus(std::iter::once((n, sum)), tag.steps)
                }
            };
            TagResult { id: tag.id, name: tag.name, count, pct, bonus, counts: false }
        })
        .collect();

    tags.sort_by(|a, b| b.bonus.cmp(&a.bonus).then(b.count.cmp(&a.count)));
    let mut bonus = 0;
    for t in tags.iter_mut().filter(|t| t.bonus > 0).take(TAG_CAP) {
        t.counts = true;
        bonus += t.bonus;
    }
    Score { base, bonus, total: base + bonus, tags }
}

/// Cards outside the top-N by points are only considered if they can add bonus (first owner).
const OPTIMISE_POOL: usize = 150;
const OPTIMISE_MAX_ROUNDS: usize = 40;

/// Picks up to `slots` cards from `cards` that maximise `score().total` (base + bonus), like the
/// in-game "Optimize". Returns indices into `cards`.
///
/// Hill climbing with single swaps (lineup card ↔ a collected card outside it), started from several seeds
/// (highest points, first-owner first) to escape the obvious local optimum where the most
/// valuable cards crowd out a bonus tag such as First Owner 10+ (300 %) → 20+ (500 %).
#[cfg_attr(not(test), allow(dead_code))]
pub fn optimise(cards: &[Card], slots: usize) -> Vec<usize> {
    optimise_from(cards, slots, None)
}

/// Like `optimise`, also starting from `start` (e.g. the user's current in-game lineup), so the
/// result is never worse than that lineup.
pub fn optimise_from(cards: &[Card], slots: usize, start: Option<&[usize]>) -> Vec<usize> {
    if cards.len() <= slots {
        return (0..cards.len()).collect();
    }
    let mut by_score: Vec<usize> = (0..cards.len()).collect();
    by_score.sort_by(|&a, &b| cards[b].score.cmp(&cards[a].score));

    let mut pool: Vec<usize> = by_score.iter().copied().take(OPTIMISE_POOL).collect();
    pool.extend(by_score.iter().copied().skip(OPTIMISE_POOL).filter(|&i| cards[i].first_owner));
    for &i in start.unwrap_or_default() {
        if !pool.contains(&i) {
            pool.push(i);
        }
    }

    let mut first_owner_first = pool.clone();
    first_owner_first.sort_by(|&a, &b| {
        cards[b].first_owner.cmp(&cards[a].first_owner).then(cards[b].score.cmp(&cards[a].score))
    });

    let total = |lineup: &[usize]| score_refs(&lineup.iter().map(|&i| &cards[i]).collect::<Vec<_>>()).total;

    let mut seeds: Vec<Vec<usize>> =
        vec![pool.iter().copied().take(slots).collect(), first_owner_first.iter().copied().take(slots).collect()];
    if let Some(start) = start {
        seeds.push(start.to_vec());
    }

    let mut best: Vec<usize> = Vec::new();
    let mut best_total = 0;
    for seed in seeds {
        let mut lineup: Vec<usize> = seed;
        let mut current = total(&lineup);
        for _ in 0..OPTIMISE_MAX_ROUNDS {
            let mut improved = false;
            for li in 0..lineup.len() {
                for &candidate in &pool {
                    if lineup.contains(&candidate) {
                        continue;
                    }
                    let previous = lineup[li];
                    lineup[li] = candidate;
                    let t = total(&lineup);
                    if t > current {
                        current = t;
                        improved = true;
                    } else {
                        lineup[li] = previous;
                    }
                }
            }
            if !improved {
                break;
            }
        }
        if current > best_total {
            best_total = current;
            best = lineup;
        }
    }
    best.sort_by(|&a, &b| cards[b].score.cmp(&cards[a].score));
    best
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradeStep {
    pub grade: String,
    pub score: u64,
    #[serde(default)]
    pub tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GradeResult {
    pub grade: Option<String>,
    pub next: Option<GradeStep>,
    pub points_to_next: u64,
}

pub fn grade_for(ladder: &[GradeStep], total: u64) -> GradeResult {
    let mut sorted = ladder.to_vec();
    sorted.sort_by_key(|g| g.score);
    let grade = sorted.iter().filter(|g| total >= g.score).last().map(|g| g.grade.clone());
    let next = sorted.into_iter().find(|g| g.score > total);
    let points_to_next = next.as_ref().map_or(0, |n| n.score - total);
    GradeResult { grade, next, points_to_next }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(score: u64, league: u64, club: u64, nation: u64, rating: u64) -> Card {
        Card {
            score,
            league: Some(league),
            club: Some(club),
            nation: Some(nation),
            rating: Some(rating),
            player: Some(score), // unique per card in these tests
            ..Default::default()
        }
    }

    #[test]
    fn base_is_sum_of_scores() {
        let s = score(&[card(100, 1, 1, 1, 80), card(200, 1, 2, 2, 80)]);
        assert_eq!(s.base, 300);
    }

    #[test]
    fn same_league_bonus_uses_steps() {
        // 5 cards in the same league → 1% of their 10,000 points = 100.
        let cards: Vec<Card> = (0..5).map(|i| card(2000, 53, i, i, 80)).collect();
        let s = score(&cards);
        let t = s.tags.iter().find(|t| t.name == "Same League").unwrap();
        assert_eq!((t.count, t.pct, t.bonus), (5, 1, 100));
    }

    #[test]
    fn silver_bonus_and_cap() {
        // 10 silver cards → Silver 30% of 1,000 = 300.
        let cards: Vec<Card> = (0..10).map(|i| card(100, i, i, i, 70)).collect();
        let s = score(&cards);
        let silver = s.tags.iter().find(|t| t.name == "Silver").unwrap();
        assert_eq!(silver.bonus, 300);
        assert!(s.tags.iter().filter(|t| t.counts).count() <= TAG_CAP);
        assert_eq!(s.total, s.base + s.bonus);
    }

    #[test]
    fn different_nation_counts_distinct_values_with_top_score() {
        // 5 nations; nation 0 has two cards (top 900). Sum of tops = 900+100*4 = 1300 → 1% = 13.
        let mut cards: Vec<Card> = (0..5).map(|i| card(100, 1, 1, i, 80)).collect();
        cards.push(card(900, 1, 1, 0, 80));
        let t = score(&cards).tags.into_iter().find(|t| t.name == "Different Nation").unwrap();
        assert_eq!((t.count, t.bonus), (5, 13));
    }

    /// Real in-game numbers (Starter Set screenshot, 2026-10-12): base 59,250, bonus 7,566.
    /// Four Heroes (89 ST 13,750 · 88 ST 10,375 · 89 ST 13,750 · 88 CAM 10,375) + one gold 89 CB 11,000,
    /// all from different leagues and nations.
    #[test]
    fn matches_in_game_starter_set_bonus_exactly() {
        // Heroes share EA's "Heroes" club, so Different Club does not trigger (as in-game).
        const HEROES_CLUB: u64 = 999;
        let hero = |score: u64, i: u64| Card {
            rarity: Some(72),
            club: Some(HEROES_CLUB),
            player: Some(100 + i),
            ..card(score, 10 + i, 0, 30 + i, 89)
        };
        let cards = vec![
            hero(13_750, 0),
            Card { rarity: Some(1), player: Some(101), ..card(11_000, 11, 21, 31, 89) },
            hero(10_375, 2),
            hero(13_750, 3),
            hero(10_375, 4),
        ];
        let s = score(&cards);
        assert_eq!(s.base, 59_250);
        // Heroic 4 → 12% of 48,250 = 5,790; Golden, Different League, Different Nation 5 → 1% of 59,250 = 592 each.
        assert_eq!(s.bonus, 7_566);
    }

    /// Real in-game Arsenal (2026-10-17): 20-slot club set, Arsenal men (club 1, Premier League 13)
    /// and women (116009, Barclays WSL 2216). Two selections with every card known; both reproduce
    /// the game exactly only with (a) every position a card can play and (b) Same Club / Same
    /// League paying every group at the largest group's step (10 + 10 → both; 11 + 9 → men only).
    #[test]
    fn matches_in_game_arsenal_bonus_exactly() {
        #[allow(clippy::too_many_arguments)]
        fn c(score: u64, nation: u64, club: u64, league: u64, rating: u64, rarity: u64, pos: &[&str], fo: bool) -> Card {
            Card {
                score,
                nation: Some(nation),
                club: Some(club),
                league: Some(league),
                rarity: Some(rarity),
                rating: Some(rating),
                positions: pos.iter().map(|p| p.to_string()).collect(),
                first_owner: fo,
                ..Default::default()
            }
        }
        let common = vec![
            c(11000, 54, 1, 13, 89, 0, &["CB"], false),                            // Gabriel
            c(8300, 14, 1, 13, 88, 0, &["CDM", "CM"], false),                      // Rice
            c(8300, 14, 116009, 2216, 88, 0, &["CAM", "ST"], false),               // Russo
            c(5500, 14, 1, 13, 87, 0, &["RM", "RW"], false),                       // Saka
            c(5500, 45, 116009, 2216, 87, 0, &["RB", "LB", "RM", "LM"], false),    // Ona Batlle
            c(4100, 36, 1, 13, 86, 0, &["CM", "CAM"], false),                      // Ødegaard
            c(4100, 14, 116009, 2216, 86, 0, &["CDM", "CM"], false),               // Stanway
            c(4100, 54, 1, 13, 86, 0, &["CDM", "CM"], true),                       // Bruno Guimarães
            c(4100, 14, 116009, 2216, 86, 0, &["RM", "LM", "RW", "LW"], false),    // Kelly
            c(8300, 45, 1, 13, 88, 0, &["GK"], false),                             // David Raya
            c(1038, 21, 116009, 2216, 84, 150, &["CAM", "ST"], true),              // Cerci
            c(410, 34, 116009, 2216, 83, 0, &["GK"], true),                        // van Domselaar
            c(830, 14, 1, 13, 84, 0, &["CM", "LM", "CAM", "LW"], true),            // Eze
            c(830, 45, 1, 13, 84, 0, &["CDM", "CM"], true),                        // Zubimendi
            c(280, 70, 116009, 2216, 81, 0, &["RM", "LM", "RW", "LW"], true),      // Smith
            c(830, 47, 116009, 2216, 84, 0, &["CDM", "RM", "CM", "RW"], true),     // Reuteler
            c(513, 22, 1, 13, 83, 150, &["LM", "LW"], true),                       // Tzolis
            c(2100, 195, 116009, 2216, 85, 0, &["LM", "LW"], false),               // Foord
        ];
        // selection read in-game (snapshot): + Blackstenius, Konsa → base 71,371, bonus 43,502
        let distinct = |v: Vec<Card>| -> Vec<Card> { v.into_iter().enumerate().map(|(i, c)| Card { player: Some(i as u64), ..c }).collect() };
        let mut read = common.clone();
        read.push(c(410, 46, 116009, 2216, 83, 0, &["CAM", "ST"], true));
        read.push(c(830, 14, 1, 13, 84, 0, &["CB"], true));
        let s = score(&distinct(read));
        assert_eq!((s.base, s.bonus), (71_371, 43_502));
        // screenshot before Confirm Changes: + White, Calafiori → base 70,751, bonus 39,811
        let mut shot = common;
        shot.push(c(280, 14, 1, 13, 81, 0, &["RB", "RM"], true));
        shot.push(c(340, 27, 1, 13, 82, 0, &["CB", "LB", "CM"], true));
        let s = score(&distinct(shot));
        assert_eq!((s.base, s.bonus), (70_751, 39_811));
    }

    #[test]
    fn optimiser_trades_points_for_a_bigger_first_owner_bonus() {
        // 3 slots. Two expensive non-first-owner cards vs. a set of 5 first-owner cards is not
        // possible with 3 slots, so use the 10-card step: 10 slots, 12 cards.
        let mut cards: Vec<Card> = (0..10).map(|i| Card { first_owner: true, ..card(1_000, 1, i, i, 80) }).collect();
        cards.push(card(5_000, 1, 50, 50, 80)); // valuable, not first owner
        cards.push(card(4_000, 1, 51, 51, 80));

        let by_points: Vec<Card> = {
            let mut v = cards.clone();
            v.sort_by(|a, b| b.score.cmp(&a.score));
            v.into_iter().take(10).collect()
        };
        let naive = score(&by_points).total;

        let picked = optimise(&cards, 10);
        let lineup: Vec<Card> = picked.iter().map(|&i| cards[i].clone()).collect();
        let best = score(&lineup).total;

        // 10 first owners → 300 % of 10,000 = 30,000 bonus beats +7,000 base from the stars.
        assert!(best > naive, "optimised {best} should beat naive {naive}");
        assert_eq!(lineup.iter().filter(|c| c.first_owner).count(), 10);
    }

    #[test]
    fn optimiser_takes_everything_when_fewer_cards_than_slots() {
        let cards = vec![card(10, 1, 1, 1, 80), card(20, 1, 2, 2, 80)];
        assert_eq!(optimise(&cards, 30).len(), 2);
    }

    #[test]
    fn grade_ladder() {
        let ladder = vec![
            GradeStep { grade: "D".into(), score: 50_000, tokens: 10 },
            GradeStep { grade: "C".into(), score: 200_000, tokens: 10 },
        ];
        let g = grade_for(&ladder, 127_400);
        assert_eq!(g.grade.as_deref(), Some("D"));
        assert_eq!(g.points_to_next, 72_600); // 200,000 − 127,400
    }
}
