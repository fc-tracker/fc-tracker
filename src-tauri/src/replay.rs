//! Replaying a recording through the app's own readers (user 2026-11-05: "test everything from a
//! stream – create scenarios and watch whether they trigger"). Frames named `<ms>.jpg` (the
//! recording's time) go through what the tracker does in the game, in order and with its own rules:
//! - every frame: the whole-frame OCR, the page reader, the screen classifier and the session
//!   state (with the tracker's two-vote rule for leaving the menu / Ultimate Team);
//! - the Squad screen: the names read on the pitch;
//! - in a match: the scoreboard (abbreviations, score, clock) once per frame like `match_ms` = 1 s,
//!   the match reminders with a scenario plan, and the result card after full time.
//! Run: `FCT_REPLAY_DIR=<frames> cargo test --lib replay -- --ignored --nocapture`.
//! Writes `replay.csv` (one row per frame) and `replay.txt` (the story) into the frames folder.

#[cfg(test)]
mod tests {
    use crate::champions::{board_from_frame, looks_like_result, read_result};
    use crate::remind::{moment_of, on_minute, Live, Need, Prefs};
    use crate::scan::{analyse_bytes, analyse_page, Frame, Page};
    use crate::session::{classify, GameSession, Screen};
    use std::fmt::Write as _;

    /// The scenario plan (user 2026-11-05: "my evos, for example at 30:00"): an evo player subbed on at
    /// 30:00, one who starts, and a bench card for objectives at the default 70:00.
    fn scenario() -> Vec<Need> {
        let need = |player: &str, evo: &str, start: bool, bench: bool, at: u16| Need { player: player.into(), evo: evo.into(), level: 1, levels: 3, start, bench, at };
        vec![need("Evo sub", "Evo – play a match", false, false, 30), need("Evo starter", "Evo – from the start", true, false, 70), need("Bench card", "Objectives", false, true, 70)]
    }

    fn page_kind(p: &Page) -> String {
        if let Page::Cards { context, cards } = p {
            return format!("Cards({context}, {})", cards.len());
        }
        let d = format!("{p:?}");
        d.split(|c: char| c == ' ' || c == '{' || c == '(').next().unwrap_or("").to_string()
    }

    fn clock(ms: u64) -> String {
        let s = ms / 1000;
        format!("{:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    }

    /// One frame's OCR words with their boxes (debugging a reader): FCT_REPLAY_FRAME=<file>.
    #[test]
    #[ignore]
    fn replay_words() {
        let Ok(file) = std::env::var("FCT_REPLAY_FRAME") else { return };
        let frame = analyse_bytes(&std::fs::read(&file).unwrap()).unwrap();
        for w in &frame.words {
            println!("{:>6.0} {:>6.0} {:>5.0} {:>4.0}  {}", w.x, w.y, w.w, w.h, w.text);
        }
        println!("squad screen: {} · pitch {:?}", crate::squad_screen::is_squad_screen(&frame.words), crate::squad_screen::read_pitch(&frame));
        let (ox, oy, s) = frame.content_box();
        let words = frame.ocr_words_in(ox + 60.0 * s, oy + 30.0 * s, 300.0 * s, 140.0 * s, 2, None).unwrap();
        for w in &words {
            println!("board {:>6.0} {:>6.0} {:>5.0} {:>4.0}  {}", w.x, w.y, w.w, w.h, w.text);
        }
        println!("board read: {:?}", board_from_frame(&Frame { width: frame.width, height: frame.height, bgra: frame.bgra.clone(), words: Vec::new() }));
    }

    #[test]
    #[ignore]
    fn replay_recording() {
        let Ok(dir) = std::env::var("FCT_REPLAY_DIR") else { return };
        let dir = std::path::PathBuf::from(dir);
        let mut files: Vec<(u64, std::path::PathBuf)> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| {
                let p = e.ok()?.path();
                let ms: u64 = p.file_stem()?.to_str()?.parse().ok()?;
                (p.extension()? == "jpg").then_some((ms, p))
            })
            .collect();
        files.sort();
        let prefs = Prefs::default();
        let mut session = GameSession::Unknown;
        let mut votes = 0u8;
        let mut live: Option<Live> = None;
        // the Champions tracker's own match loop, as if it were on (what it would see in this match)
        let mut champ: Option<crate::champions::Live> = None;
        // the Champions record, as if each match were a Champions match (only Champions keeps goals; a
        // recording of Rivals matches tests it – user 2026-11-06)
        let mut record: Option<crate::champions::Data> = None;
        let mut story = String::new();
        let mut csv = String::from("time,ms,screen,session,page,squad_screen,board,minute,result\n");
        let mut last_screen = String::new();
        let mut last_page = String::new();
        let mut match_no = 0;
        let mut first_minute: Option<u16> = None;
        let mut last_minute: Option<u16> = None;
        let mut last_score: Option<(String, u8, String, u8)> = None;
        let mut minutes_read = 0u32;
        let mut boards_missing = 0u32;
        let mut squad_reads = 0u32;
        for (ms, path) in &files {
            let bytes = std::fs::read(path).unwrap();
            let Ok(frame) = analyse_bytes(&bytes) else {
                let _ = writeln!(story, "{} unreadable frame", clock(*ms));
                continue;
            };
            let page = analyse_page(&frame).unwrap_or(Page::Other);
            // in a match the tracker classifies the picture without a page read (tracking.rs: classify(&frame, &Page::Other))
            let screen = if session == GameSession::InMatch { classify(&frame, &Page::Other) } else { classify(&frame, &page) };
            // the session, with the tracker's two-vote rule (tracking.rs observe_screen)
            let before = session;
            let next = session.next(screen);
            let in_menu = |s: GameSession| matches!(s, GameSession::MainMenu | GameSession::UtSelected);
            let leaving = (in_menu(session) && !in_menu(next) && screen != Screen::UltimateTeam) || (session == GameSession::InUltimateTeam && in_menu(next));
            if leaving {
                votes += 1;
            }
            if !leaving || votes >= 2 {
                votes = 0;
                session = next;
            }
            if session != before {
                let _ = writeln!(story, "{} session {before:?} → {session:?}  (screen {screen:?})", clock(*ms));
                if session == GameSession::InMatch {
                    match_no += 1;
                    first_minute = None;
                    last_minute = None;
                    last_score = None;
                    minutes_read = 0;
                    boards_missing = 0;
                    let mut l = Live::default();
                    l.needs = scenario();
                    let _ = writeln!(story, "{} ── match {match_no} starts (the plan: Evo sub 30', Evo starter from the start, Bench card 70')", clock(*ms));
                    if let Some(r) = moment_of(&mut l, 0) {
                        let _ = writeln!(story, "{} REMINDER loading in: {}", clock(*ms), r.needs.iter().map(|n| format!("{} {}", n.player, if n.start { "starts".to_string() } else { format!("{}'", n.at) })).collect::<Vec<_>>().join(", "));
                    }
                    live = Some(l);
                    champ = Some(crate::champions::Live::default());
                    let mut d = crate::champions::Data::default();
                    d.observe(crate::champions::Seen::KitChampions, *ms);
                    record = Some(d);
                }
                if before == GameSession::InMatch {
                    let _ = writeln!(
                        story,
                        "{} ── match {match_no} ends: clock read {minutes_read}× ({}′ → {}′), scoreboard missing {boards_missing}×, last score {}",
                        clock(*ms),
                        first_minute.map_or("–".into(), |m| m.to_string()),
                        last_minute.map_or("–".into(), |m| m.to_string()),
                        last_score.as_ref().map_or("–".into(), |(a, x, b, y)| format!("{a} {x}–{y} {b}"))
                    );
                    if let Some(m) = record.as_ref().and_then(|d| d.pending.clone().or_else(|| d.runs.last().and_then(|r| r.matches.last().cloned()))) {
                        let goals = m.timeline.iter().map(|[min, h, a]| format!("{h}-{a} {min}'")).collect::<Vec<_>>().join(", ");
                        let _ = writeln!(story, "{} ── match {match_no} Champions record: goals [{goals}] · score {:?} · last {:?} · coins {:?} sp {:?}", clock(*ms), m.score, m.last, m.coins, m.sp);
                    }
                    live = None;
                    champ = None;
                    record = None;
                }
            }
            let kind = page_kind(&page);
            let screen_s = format!("{screen:?}");
            if screen_s != last_screen || kind != last_page {
                let _ = writeln!(story, "{} screen {screen_s} · page {kind}", clock(*ms));
                last_screen = screen_s.clone();
                last_page = kind.clone();
            }
            // the Squad screen: the names on the pitch
            let mut squad = String::new();
            if crate::squad_screen::is_squad_screen(&frame.words) {
                let names = crate::squad_screen::read_pitch(&frame);
                squad = names.iter().map(|(r, p)| format!("{r} {p}")).collect::<Vec<_>>().join(" | ");
                if squad_reads < 40 {
                    let _ = writeln!(story, "{} squad screen: {} cards read on the pitch (rating position): {squad}", clock(*ms), names.len());
                }
                squad_reads += 1;
            }
            // in a match: the scoreboard, the reminders, the result card
            let mut board_s = String::new();
            let mut minute_s = String::new();
            let mut result_s = String::new();
            if session == GameSession::InMatch {
                let bare = Frame { width: frame.width, height: frame.height, bgra: frame.bgra.clone(), words: Vec::new() };
                match board_from_frame(&bare) {
                    Some(b) => {
                        board_s = format!("{} {}-{} {}", b.home_abbr, b.home, b.away, b.away_abbr);
                        last_score = Some((b.home_abbr.clone(), b.home, b.away_abbr.clone(), b.away));
                        if let Some(m) = b.minute {
                            minute_s = m.to_string();
                            minutes_read += 1;
                            first_minute.get_or_insert(m);
                            if last_minute.is_some_and(|l| m + 2 < l) {
                                let _ = writeln!(story, "{} clock went back {}′ → {m}′ (misread?)", clock(*ms), last_minute.unwrap());
                            }
                            last_minute = Some(m);
                            if let Some(l) = live.as_mut() {
                                let taken = crate::remind::steady(l, m);
                                if let Some(r) = taken.and_then(|m| on_minute(l, &prefs, m)) {
                                    let who = r.needs.iter().map(|n| format!("{} {}", n.player, if n.start { "starts".to_string() } else { format!("{}'", n.at) })).collect::<Vec<_>>().join(", ");
                                    let _ = writeln!(story, "{} REMINDER at {}′ ({}): {who}", clock(*ms), r.at, if r.now { "sub on now" } else { "subs still to come" });
                                }
                            }
                        }
                    }
                    None => boards_missing += 1,
                }
                if let Some(c) = champ.as_mut() {
                    let (seen, _) = c.look(frame.width, frame.height, frame.bgra.clone(), *ms);
                    if let Some(d) = record.as_mut() {
                        for x in seen.iter().filter(|x| !matches!(x, crate::champions::Seen::OtherMode)) {
                            let before = d.pending.as_ref().map(|m| m.timeline.len()).unwrap_or(0);
                            d.observe(x.clone(), *ms);
                            if let Some(m) = d.pending.as_ref().filter(|m| m.timeline.len() > before) {
                                let [min, h, a] = m.timeline[m.timeline.len() - 1];
                                let _ = writeln!(story, "{} GOAL recorded: {h}-{a} at {min}'", clock(*ms));
                            }
                        }
                    }
                    for x in seen.iter().filter(|x| !matches!(x, crate::champions::Seen::Board(_))) {
                        let d = match x {
                            crate::champions::Seen::Result(c) => format!("Result score {:?} win {:?} coins {:?} sp {:?}", c.score, c.win, c.coins, c.sp),
                            crate::champions::Seen::Versus { .. } => "Versus card".to_string(),
                            other => format!("{other:?}").chars().take(90).collect(),
                        };
                        let _ = writeln!(story, "{} champions loop saw: {d}{}", clock(*ms), if c.bursting() { " (burst after full time)" } else { "" });
                    }
                }
                if looks_like_result(&frame.words) {
                    if let Some(c) = read_result(&frame.words, Some(&frame)) {
                        result_s = format!("{:?} win={:?} coins={:?} sp={:?}", c.score, c.win, c.coins, c.sp);
                        let _ = writeln!(story, "{} result card: score {:?} win {:?} coins {:?} sp {:?}", clock(*ms), c.score, c.win, c.coins, c.sp);
                    }
                }
            }
            let _ = writeln!(csv, "{},{ms},{screen_s},{session:?},{kind},\"{squad}\",{board_s},{minute_s},\"{result_s}\"", clock(*ms));
        }
        // the recording ended in a match (or on its result screens)
        if let Some(m) = record.as_ref().and_then(|d| d.pending.clone()) {
            let goals = m.timeline.iter().map(|[min, h, a]| format!("{h}-{a} {min}'")).collect::<Vec<_>>().join(", ");
            let _ = writeln!(story, "end ── match {match_no} Champions record: goals [{goals}] · score {:?} · last {:?} · coins {:?} sp {:?}", m.score, m.last, m.coins, m.sp);
        }
        std::fs::write(dir.join("replay.csv"), csv).unwrap();
        std::fs::write(dir.join("replay.txt"), &story).unwrap();
        println!("{story}");
    }
}
