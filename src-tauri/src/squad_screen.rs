//! The game's Squad screen (Club → Squad): the eleven cards on the pitch, each its rating with its
//! position under it ("82 ST"). Compared with the plan's XI, the match brief can tick "Build the
//! squad" by itself and say who is still to change (user 2026-11-02: "Adeyemi ST (check) – we can
//! see on screen whether he is"). Menus only; nothing but ratings and positions is read.
use crate::scan::Word;

const POSITIONS: [&str; 15] = ["GK", "RB", "LB", "CB", "RWB", "LWB", "CDM", "CM", "CAM", "RM", "LM", "RW", "LW", "CF", "ST"];

/// Is this the Squad screen (its Team Management / Total Chemistry panel)?
pub fn is_squad_screen(words: &[Word]) -> bool {
    let has = |t: &str| words.iter().any(|w| w.text == t);
    has("Chemistry") && has("Total") && (has("Management") || has("Squad"))
}

/// The cards on the pitch as (rating, position): a rating with a position right under it, left of
/// the bench row and right of the left panel.
#[cfg(test)]
pub fn cards(words: &[Word], width: u32, height: u32) -> Vec<(u32, String)> {
    let (w, h) = (width as f32, height as f32);
    let mut out = Vec::new();
    for r in words {
        let Ok(rating) = r.text.parse::<u32>() else { continue };
        if !(40..=99).contains(&rating) || r.y > h * 0.8 || r.x < w * 0.18 || r.x > w * 0.82 {
            continue;
        }
        let cx = r.x + r.w / 2.0;
        let pos = words
            .iter()
            .filter(|p| POSITIONS.contains(&p.text.as_str()))
            .filter(|p| p.y > r.y + r.h * 0.4 && p.y < r.y + r.h * 2.2 && (p.x + p.w / 2.0 - cx).abs() < r.w.max(p.w) * 1.2)
            .min_by(|a, b| (a.y - r.y).total_cmp(&(b.y - r.y)));
        if let Some(p) = pos {
            out.push((rating, p.text.clone()));
        }
    }
    out
}

/// The cards on the pitch, read card by card: the whole-screen text read misses most ratings (they
/// sit on card art) but finds the pitch's slot labels under the cards ("ST", "CM++"). Each card's
/// rating sits a fixed step above its label (≈14 % of the screen's height); that corner is read
/// alone at 4×, as it is and binarised. (rating, the slot's position)
pub fn read_pitch(frame: &crate::scan::Frame) -> Vec<(u32, String)> {
    let (w, h) = (frame.width as f32, frame.height as f32);
    let mut out: Vec<(u32, String, f32, f32)> = Vec::new();
    // the labels: from the screen's read and the pitch read again at 2× (as it is and binarised)
    let mut labels: Vec<crate::scan::Word> = frame.words.clone();
    for light in [None, Some(110u8)] {
        labels.extend(frame.ocr_words_in(w * 0.18, h * 0.08, w * 0.64, h * 0.72, 2, light).unwrap_or_default());
    }
    for l in &labels {
        let pos = l.text.trim_end_matches('+');
        if !POSITIONS.contains(&pos) || l.y > h * 0.8 || l.x < w * 0.18 || l.x > w * 0.82 {
            continue;
        }
        let (cx, top) = (l.x + l.w / 2.0, l.y - h * 0.150);
        if top < 0.0 || out.iter().any(|(_, _, x, y)| (x - cx).abs() < w * 0.03 && (y - top).abs() < h * 0.03) {
            continue;
        }
        let (bx, bw, bh) = (cx - w * 0.040, w * 0.045, h * 0.045);
        let rating = [None, Some(110u8), Some(170u8)].into_iter().find_map(|light| {
            let ws = frame.ocr_words_in(bx, top, bw, bh, 4, light).ok()?;
            ws.iter().find_map(|x| x.text.trim_matches(|c: char| !c.is_ascii_digit()).parse::<u32>().ok().filter(|n| (40..=99).contains(n)))
        });
        if let Some(r) = rating {
            out.push((r, pos.to_string(), cx, top));
        }
    }
    out.into_iter().map(|(r, p, _, _)| (r, p)).collect()
}

/// Planned players seen on the pitch (a rating and position that only they have in the plan's XI).
pub fn confirmed(plan: &[(String, String, u32)], seen: &[(u32, String)]) -> Vec<String> {
    let mut left: Vec<&(u32, String)> = seen.iter().collect();
    let mut out = Vec::new();
    for p in plan {
        if let Some(i) = left.iter().position(|(r, pos)| *r == p.2 && *pos == p.0) {
            left.remove(i);
            out.push(p.1.clone());
        }
    }
    out
}

/// The plan's XI (position, name, rating) against the cards on screen: who is not on it yet.
/// None when the screen doesn't show a whole XI (a half-read or another view).
pub fn missing(plan: &[(String, String, u32)], seen: &[(u32, String)]) -> Option<Vec<(String, String)>> {
    if seen.len() != 11 {
        return None;
    }
    let mut left: Vec<&(u32, String)> = seen.iter().collect();
    let mut out = Vec::new();
    // first the exact card (rating and position), then the rating alone (a card shows its own
    // position, which can differ from the slot's)
    let mut open: Vec<&(String, String, u32)> = Vec::new();
    for p in plan {
        if let Some(i) = left.iter().position(|(r, pos)| *r == p.2 && *pos == p.0) {
            left.remove(i);
        } else {
            open.push(p);
        }
    }
    for p in open {
        if let Some(i) = left.iter().position(|(r, _)| *r == p.2) {
            left.remove(i);
        } else {
            out.push((p.0.clone(), p.1.clone()));
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> Vec<(String, String, u32)> {
        [("ST", "Adeyemi", 82), ("ST", "Mandžukić", 86), ("CAM", "Lavelle", 87), ("CM", "Fermín", 85), ("CM", "Johnny Cardoso", 80), ("CM", "Corona", 84), ("LB", "Hernández", 71), ("CB", "Pepe", 85), ("CB", "Angulo", 73), ("RB", "Llorente", 85), ("GK", "Gulácsi", 82)]
            .iter()
            .map(|(p, n, r)| (p.to_string(), n.to_string(), *r))
            .collect()
    }

    #[test]
    fn the_squad_on_screen_is_compared_with_the_plan() {
        // the video's Squad screen (1:37): Corona 84 CM ↔ the plan, Fermín 85 not in yet (80 CM)
        let seen: Vec<(u32, String)> = [(82, "ST"), (86, "ST"), (87, "CAM"), (84, "CM"), (80, "CM"), (80, "CM"), (71, "LB"), (85, "CB"), (73, "CB"), (85, "RB"), (82, "GK")].iter().map(|(r, p)| (*r, p.to_string())).collect();
        assert_eq!(missing(&plan(), &seen), Some(vec![("CM".to_string(), "Fermín".to_string())]));
        let all: Vec<(u32, String)> = plan().iter().map(|(p, _, r)| (*r, p.clone())).collect();
        assert_eq!(missing(&plan(), &all), Some(vec![]));
        assert_eq!(missing(&plan(), &all[..5]), None, "half a squad read: no verdict");
        assert_eq!(confirmed(&plan(), &all[..2]), vec!["Adeyemi".to_string(), "Mandžukić".to_string()]);
    }
}
