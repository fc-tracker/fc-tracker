//! When the side panel opens by itself (Settings → "Side panel opens by itself", a quick setting in
//! the overlay's menu too). "first" (default, user 2026-11-03): on arriving at the Squad screen from
//! outside the Club area – not when moving between the Club area's own tabs (the game's header
//! Club | Squad | Transfer Market: Club → Squad must not bring it back). "always": on every arrival
//! at the Squad screen. "off": never. A panel the user closed on the Squad screen stays closed until
//! they leave (the area for "first", the Squad screen for "always"). Pure logic, tested; lib.rs opens
//! and closes the window.
use crate::scan::Word;

pub const MODES: [&str; 3] = ["off", "first", "always"];

/// What a menu screen is, for the side panel.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Screen {
    Squad,
    /// Another tab of the Club area (Club, Transfer Market / Transfer List).
    ClubArea,
    /// Objectives, Evolutions, Store, Play … (Objectives keeps a panel open: it is about the squad).
    Elsewhere { keeps_panel: bool },
}

/// The Club area's header: "Club" and "Squad" or "Transfer" in the top strip of the screen.
pub fn classify(words: &[Word], height: u32, is_squad: bool) -> Screen {
    if is_squad {
        return Screen::Squad;
    }
    let top = height as f32 * 0.16;
    let at_top = |t: &str| words.iter().any(|w| w.text == t && w.y < top);
    if at_top("Club") && (at_top("Squad") || at_top("Transfer")) && !at_top("Evolutions") && !at_top("Objectives") {
        return Screen::ClubArea;
    }
    Screen::Elsewhere { keeps_panel: words.iter().any(|w| w.text == "Objectives") }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Action {
    Open,
    /// Close – only a panel the app opened (lib.rs keeps one the user opened).
    Close,
    Nothing,
}

#[derive(Debug, Default)]
pub struct State {
    /// The last screen seen.
    last: Option<Screen>,
    /// Inside the Club area since the panel last opened by itself (or was declined).
    in_area: bool,
    /// The user closed the panel here – not reopened until they leave.
    dismissed: bool,
}

impl State {
    pub fn screen(&mut self, mode: &str, s: Screen) -> Action {
        let arrived = self.last != Some(s);
        self.last = Some(s);
        match s {
            Screen::Squad => {
                let open = match mode {
                    "always" => arrived && !self.dismissed,
                    "first" => !self.in_area && !self.dismissed,
                    _ => false,
                };
                self.in_area = true;
                if open {
                    Action::Open
                } else {
                    Action::Nothing
                }
            }
            Screen::ClubArea => {
                self.in_area = true;
                if mode == "always" {
                    self.dismissed = false;
                }
                Action::Close
            }
            Screen::Elsewhere { keeps_panel } => {
                self.in_area = false;
                self.dismissed = false;
                if keeps_panel {
                    Action::Nothing
                } else {
                    Action::Close
                }
            }
        }
    }

    /// The user closed the panel (double-tap View, the ×) while on this screen.
    pub fn user_closed(&mut self) {
        if self.last == Some(Screen::Squad) {
            self.dismissed = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUT: Screen = Screen::Elsewhere { keeps_panel: false };
    const OBJ: Screen = Screen::Elsewhere { keeps_panel: true };

    #[test]
    fn first_time_opens_on_arriving_from_outside_the_club_area() {
        let mut s = State::default();
        assert_eq!(s.screen("first", OUT), Action::Close);
        assert_eq!(s.screen("first", Screen::Squad), Action::Open);
        // read again and again on the Squad screen: no more opens
        assert_eq!(s.screen("first", Screen::Squad), Action::Nothing);
        // Club and back: not again (user 2026-11-03)
        assert_eq!(s.screen("first", Screen::ClubArea), Action::Close);
        assert_eq!(s.screen("first", Screen::Squad), Action::Nothing);
        // Objectives and back: again
        assert_eq!(s.screen("first", OBJ), Action::Nothing);
        assert_eq!(s.screen("first", Screen::Squad), Action::Open);
    }

    #[test]
    fn a_closed_panel_stays_closed_until_the_user_leaves() {
        let mut s = State::default();
        assert_eq!(s.screen("always", Screen::Squad), Action::Open);
        s.user_closed();
        assert_eq!(s.screen("always", Screen::Squad), Action::Nothing);
        assert_eq!(s.screen("always", Screen::ClubArea), Action::Close);
        assert_eq!(s.screen("always", Screen::Squad), Action::Open, "always: every arrival");
        let mut s = State::default();
        assert_eq!(s.screen("first", Screen::Squad), Action::Open);
        s.user_closed();
        assert_eq!(s.screen("first", Screen::ClubArea), Action::Close);
        assert_eq!(s.screen("first", Screen::Squad), Action::Nothing);
        assert_eq!(s.screen("first", OUT), Action::Close);
        assert_eq!(s.screen("first", Screen::Squad), Action::Open);
        assert_eq!(State::default().screen("off", Screen::Squad), Action::Nothing);
    }

    #[test]
    fn the_club_areas_header_is_told_apart() {
        let w = |t: &str, y: f32| Word { text: t.into(), x: 0.0, y, w: 10.0, h: 10.0 };
        let club = vec![w("Club", 40.0), w("Squad", 40.0), w("Transfer", 40.0), w("Market", 40.0), w("Gallery", 400.0)];
        assert_eq!(classify(&club, 1080, false), Screen::ClubArea);
        let evo = vec![w("Club", 40.0), w("Evolutions", 40.0), w("Squad", 40.0)];
        assert_eq!(classify(&evo, 1080, false), Screen::Elsewhere { keeps_panel: false });
        let obj = vec![w("FUT", 40.0), w("Objectives", 40.0)];
        assert_eq!(classify(&obj, 1080, false), Screen::Elsewhere { keeps_panel: true });
        assert_eq!(classify(&club, 1080, true), Screen::Squad);
    }
}
