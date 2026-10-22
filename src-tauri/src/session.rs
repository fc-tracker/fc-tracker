//! Where the user is in FC 27 – decides whether a Web App sync is safe right now.
//!
//! EA allows one Ultimate Team session: the game holds it while the user is *inside* Ultimate
//! Team, the Web App holds it during our sync. Outside Ultimate Team (main menu, other modes)
//! the game doesn't need it, so syncing with the game open is fine (user, 2026-10-13).
//!
//! Read from the screen only (tracking.rs), never from the game process or the input devices:
//! - main menu: the upper-case mode list (ULTIMATE TEAM, MANAGER CAREER, KICK OFF …);
//! - Ultimate Team selected: the "Enter Ultimate Team" button that only shows for that entry;
//! - leaving the main menu while Ultimate Team is selected = entering Ultimate Team
//!   (keyboard, PlayStation or Xbox controller alike – we see the screen, not the input);
//! - inside Ultimate Team: Gallery pages or the UT navigation bar (Club, Gallery, Transfers …);
//! - a match about to start: "Searching for Opponent…" or the kit selection ("Select a kit for
//!   you and your opponent", "Your Kit" / "Opponent's Kit") – the app steps aside until the user
//!   is back in a menu (match mode, see tracking.rs).

use crate::scan::{Frame, Page};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GameSession {
    /// FC 27 is not running.
    Closed,
    /// Running, but we haven't seen where the user is yet.
    Unknown,
    MainMenu,
    /// Main menu with Ultimate Team selected (one press away from entering).
    UtSelected,
    /// Left the main menu into another mode (Kick Off, Career …).
    OtherMode,
    InUltimateTeam,
    /// A match is starting or running: our windows are hidden, the screen is barely read.
    InMatch,
}

impl GameSession {
    pub fn sync_allowed(self) -> bool {
        matches!(self, Self::Closed | Self::MainMenu | Self::UtSelected | Self::OtherMode)
    }

    /// The next state after an analysed (still) frame.
    pub fn next(self, screen: Screen) -> Self {
        match screen {
            Screen::MainMenu { ut_selected: true } => Self::UtSelected,
            Screen::MainMenu { ut_selected: false } => Self::MainMenu,
            Screen::UltimateTeam => Self::InUltimateTeam,
            Screen::PreMatch => Self::InMatch,
            Screen::Other => match self {
                // Left the menu with Ultimate Team selected: the user entered it.
                Self::UtSelected => Self::InUltimateTeam,
                Self::MainMenu => Self::OtherMode,
                // Closed/Unknown/OtherMode/InUltimateTeam stay until a menu or UT screen is seen.
                s => s,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    MainMenu { ut_selected: bool },
    UltimateTeam,
    /// Matchmaking or kit selection right before a match.
    PreMatch,
    Other,
}

/// Mode names of the FC 27 main menu (shown in capitals there, mixed case elsewhere).
const MENU_WORDS: [&str; 6] = ["ULTIMATE", "MANAGER", "CAREER", "KICK", "PLAYER", "GROUNDS"];
/// Ultimate Team navigation (top bar of every UT screen).
/// "Squad" / "Transfer" / "Market": the Squad screen's tab bar (Club · Squad · Transfer Market) –
/// where a match usually ends, so match mode must see it as Ultimate Team.
/// "Rivals" / "Champions": the Play → Rivals tab bar (the Champions hub, where a Champions match ends).
const UT_NAV: [&str; 14] = ["Club", "Gallery", "Squad", "Squads", "Transfer", "Transfers", "Market", "Store", "Objectives", "Evolutions", "Home", "SBC", "Rivals", "Champions"];

pub fn classify(frame: &Frame, page: &Page) -> Screen {
    let has = |t: &str| frame.words.iter().any(|w| w.text == t);
    let starts = |t: &str| frame.words.iter().any(|w| w.text.starts_with(t));
    // Before Gallery pages: "Searching for Opponent…" is drawn over the (dimmed) Squad screen.
    if (has("Searching") && starts("Opponent")) || (starts("Opponent") && has("Kit")) || (has("Select") && has("kit") && has("opponent")) {
        return Screen::PreMatch;
    }
    if !matches!(page, Page::Other) {
        return Screen::UltimateTeam;
    }
    // The Champions hub (after a Champions match): its Performance panel
    if has("Wins") && has("Losses") && has("Remaining") {
        return Screen::UltimateTeam;
    }
    if MENU_WORDS.iter().filter(|w| has(w)).count() >= 3 {
        // The action button exists only while Ultimate Team is the selected entry.
        let ut_selected = frame
            .words
            .windows(3)
            .any(|w| w[0].text == "Enter" && w[1].text == "Ultimate" && w[2].text.starts_with("Team"));
        return Screen::MainMenu { ut_selected };
    }
    let top = frame.height as f32 * 0.16;
    let nav = UT_NAV.iter().filter(|n| frame.words.iter().any(|w| w.text == **n && w.y < top)).count();
    if nav >= 2 {
        return Screen::UltimateTeam;
    }
    Screen::Other
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entering_ultimate_team_is_seen_from_the_menu() {
        let s = GameSession::Unknown;
        assert!(!s.sync_allowed());
        let s = s.next(Screen::MainMenu { ut_selected: false });
        assert_eq!(s, GameSession::MainMenu);
        assert!(s.sync_allowed());
        // Carousel or other menu animation: still the menu.
        let s = s.next(Screen::MainMenu { ut_selected: true }).next(Screen::MainMenu { ut_selected: true });
        assert_eq!(s, GameSession::UtSelected);
        // Loading screen after pressing Enter / X / A.
        let s = s.next(Screen::Other);
        assert_eq!(s, GameSession::InUltimateTeam);
        assert!(!s.sync_allowed());
        // Unknown screens inside UT keep the state; only the main menu releases it.
        assert_eq!(s.next(Screen::Other), GameSession::InUltimateTeam);
        assert_eq!(s.next(Screen::MainMenu { ut_selected: true }), GameSession::UtSelected);
    }

    #[test]
    fn a_match_is_entered_from_matchmaking_and_left_in_a_menu() {
        let s = GameSession::InUltimateTeam.next(Screen::PreMatch);
        assert_eq!(s, GameSession::InMatch);
        assert!(!s.sync_allowed());
        // The match itself and the result screens: still in the match.
        assert_eq!(s.next(Screen::Other), GameSession::InMatch);
        // Back in Ultimate Team (or the main menu).
        assert_eq!(s.next(Screen::UltimateTeam), GameSession::InUltimateTeam);
        assert_eq!(s.next(Screen::MainMenu { ut_selected: true }), GameSession::UtSelected);
    }

    #[test]
    fn other_modes_allow_a_sync() {
        let s = GameSession::MainMenu.next(Screen::Other);
        assert_eq!(s, GameSession::OtherMode);
        assert!(s.sync_allowed());
        assert_eq!(s.next(Screen::UltimateTeam), GameSession::InUltimateTeam);
    }

    #[test]
    #[ignore]
    fn classifies_fixture_screens() {
        let Ok(dir) = std::env::var("FCT_SCAN_FIXTURES") else { return };
        for file in ["main-menu-ut.webp", "own-set-pl.webp", "own-swap-pl.webp", "own-summary.webp", "prematch-searching.webp", "prematch-kit.webp", "prematch-kit-zoom.webp", "u-squad-ps.webp"] {
            let Ok(bytes) = std::fs::read(std::path::Path::new(&dir).join(file)) else { continue };
            let frame = crate::scan::analyse_bytes(&bytes).unwrap();
            let page = crate::scan::analyse_page(&frame).unwrap();
            // The cheap probe used on animated screens: half resolution, no page analysis.
            let (w, h, px) = crate::scan::downscale2(frame.width, frame.height, &frame.bgra);
            let small = crate::scan::frame_from_pixels(w, h, px).unwrap();
            println!("{file}: {:?} · half-res probe {:?}", classify(&frame, &page), classify(&small, &Page::Other));
        }
    }
}
