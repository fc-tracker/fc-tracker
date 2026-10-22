//! Controller input on a background thread (gilrs: Xbox via XInput/WGI, PlayStation
//! DualShock 4 / DualSense via WGI raw controllers + SDL mappings).
//!
//! FC 27 receives every press too (we never block input), so the gestures use the button with
//! the least effect in FC (research 2026-10-13): View (Xbox) = Create (PlayStation) = Back.
//! In a match it does nothing for an outfield player; in menus a single press at most opens the
//! Season Pass (closed with Back). L3+R3 was rejected: it is Player Lock in matches.
//! - hold View / Create for `HOLD` → overlay on/off (fires while held);
//! - double-tap View / Create → missing-players list on/off.
//! While the overlay is open: L1/R1 (LB/RB) category, D-pad moves (sets, then cards), ✕ / A
//! opens (a set, a card's menu, a menu choice), ○ / B goes back (and closes at the top), ▢ / X
//! shows a card's info (△ / Y is avoided: in the Gallery it is "Optimize").

use gilrs::{Axis, Button, EventType, Gilrs};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Pad {
    ToggleOverlay,
    ToggleMissing,
    /// Overlay navigation: "prev_category" | "next_category" | "up" | "down" | "left" | "right" |
    /// "select" | "back" | "info" | "prev_section" | "next_section".
    Nav(&'static str),
    /// Right stick held up/down (−1…1, up positive): the overlay scrolls, slowly for small tilts.
    Scroll(f32),
    /// A controller was connected or disconnected (see `controller`).
    ControllerChanged,
}

/// The connected controller, for showing the right button names (Help → Controls).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Controller {
    pub name: String,
    /// "playstation" | "xbox" | "other"
    pub kind: &'static str,
}

static CONTROLLER: std::sync::Mutex<Option<Controller>> = std::sync::Mutex::new(None);

pub fn controller() -> Option<Controller> {
    CONTROLLER.lock().unwrap().clone()
}

/// PlayStation or Xbox, by USB vendor (Sony 054C, Microsoft 045E), else by name.
fn kind_of(vendor: Option<u16>, name: &str) -> &'static str {
    let n = name.to_lowercase();
    match vendor {
        Some(0x054C) => "playstation",
        Some(0x045E) => "xbox",
        _ if ["dualsense", "dualshock", "ps4", "ps5", "playstation", "sony"].iter().any(|k| n.contains(k)) => "playstation",
        _ if ["xbox", "xinput", "microsoft"].iter().any(|k| n.contains(k)) => "xbox",
        _ => "other",
    }
}

/// The first connected pad (the one the user plays with, in practice).
fn refresh_controller(gilrs: &Gilrs) -> bool {
    let now = gilrs.gamepads().find(|(_, p)| p.is_connected()).map(|(_, p)| Controller { name: p.name().to_string(), kind: kind_of(p.vendor_id(), p.name()) });
    let mut cur = CONTROLLER.lock().unwrap();
    let changed = *cur != now;
    *cur = now;
    changed
}

const GESTURE: Button = Button::Select;

/// Buttons held right now (any pad). The overlay closes only once this is 0: FC 27 gets the
/// keyboard/pad focus back at that moment and would otherwise see the still-held ○ / View.
static HELD: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

pub fn any_button_held() -> bool {
    HELD.load(std::sync::atomic::Ordering::Relaxed) > 0
}
const HOLD: Duration = Duration::from_millis(700);
/// A tap is shorter than this …
const TAP: Duration = Duration::from_millis(450);
/// … and a double-tap starts its second tap within this after the first one ended. Generous on
/// purpose (a relaxed double-tap on a DualSense is ~150 ms + ~250 ms); a single View press in FC
/// is harmless, so a slow double-tap that misses only costs the user a retry.
const DOUBLE_GAP: Duration = Duration::from_millis(500);
/// Stick tilt below this is ignored (drift).
const SCROLL_DEADZONE: f32 = 0.15;
// A low polling rate keeps CPU usage near zero; 30 ms is still imperceptible to the user.
const POLL_INTERVAL: Duration = Duration::from_millis(30);

fn nav(button: Button) -> Option<&'static str> {
    Some(match button {
        Button::LeftTrigger => "prev_category",
        Button::RightTrigger => "next_category",
        // L2 / R2 (LT / RT): the overlay's main tabs (Sets, Best value, Planner)
        Button::LeftTrigger2 => "prev_section",
        Button::RightTrigger2 => "next_section",
        Button::DPadUp => "up",
        Button::DPadDown => "down",
        Button::DPadLeft => "left",
        Button::DPadRight => "right",
        Button::South => "select",
        Button::East => "back",
        // ▢ / X: card info. Not △ / Y – that is "Optimize" on the in-game set page.
        Button::West => "info",
        _ => return None,
    })
}

/// Pure gesture logic (tested without a controller).
#[derive(Default)]
struct Gesture {
    down_since: Option<Instant>,
    hold_fired: bool,
    /// End of the last short tap (candidate first half of a double-tap).
    last_tap_end: Option<Instant>,
}

impl Gesture {
    fn press(&mut self, now: Instant) -> Option<Pad> {
        self.down_since = Some(now);
        self.hold_fired = false;
        if self.last_tap_end.is_some_and(|t| now.duration_since(t) <= DOUBLE_GAP) {
            self.last_tap_end = None;
            self.hold_fired = true; // the second tap must not also count as a hold or a tap
            return Some(Pad::ToggleMissing);
        }
        None
    }

    fn release(&mut self, now: Instant) {
        if let Some(since) = self.down_since.take() {
            self.last_tap_end = (!self.hold_fired && now.duration_since(since) < TAP).then_some(now);
        }
    }

    fn tick(&mut self, now: Instant) -> Option<Pad> {
        match self.down_since {
            Some(since) if !self.hold_fired && now.duration_since(since) >= HOLD => {
                self.hold_fired = true;
                Some(Pad::ToggleOverlay)
            }
            _ => None,
        }
    }
}

/// `on_log` gets one line per View / Create press and release (tracking.log), so a gesture that
/// does not trigger can be diagnosed from the user's log.
pub fn spawn(on_pad: impl Fn(Pad) + Send + 'static, on_log: impl Fn(String) + Send + 'static) {
    std::thread::Builder::new()
        .name("gamepad".into())
        .spawn(move || {
            let mut gilrs = match Gilrs::new() {
                Ok(g) => g,
                Err(e) => {
                    eprintln!("gamepad: failed to initialise gilrs: {e}");
                    return;
                }
            };
            for (_, pad) in gilrs.gamepads() {
                on_log(format!("pad: {} connected", pad.name()));
            }
            refresh_controller(&gilrs);
            let mut gesture = Gesture::default();
            let mut stick_y = 0.0f32;
            loop {
                while let Some(ev) = gilrs.next_event() {
                    let now = Instant::now();
                    match ev.event {
                        EventType::ButtonPressed(..) => {
                            HELD.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        }
                        EventType::ButtonReleased(..) => {
                            let _ = HELD.try_update(std::sync::atomic::Ordering::Relaxed, std::sync::atomic::Ordering::Relaxed, |n| Some(n.saturating_sub(1)));
                        }
                        _ => {}
                    }
                    match ev.event {
                        EventType::ButtonPressed(GESTURE, _) => {
                            let gap = gesture.last_tap_end.map(|t| now.duration_since(t).as_millis());
                            let p = gesture.press(now);
                            on_log(format!("pad: View down (since last tap {gap:?} ms) → {p:?}"));
                            if let Some(p) = p {
                                on_pad(p);
                            }
                        }
                        EventType::ButtonReleased(GESTURE, _) => {
                            let held = gesture.down_since.map(|t| now.duration_since(t).as_millis());
                            gesture.release(now);
                            on_log(format!("pad: View up after {held:?} ms"));
                        }
                        EventType::Connected => {
                            on_log(format!("pad: {} connected", gilrs.gamepad(ev.id).name()));
                            if refresh_controller(&gilrs) {
                                on_pad(Pad::ControllerChanged);
                            }
                        }
                        EventType::ButtonPressed(b, _) => {
                            if let Some(action) = nav(b) {
                                on_pad(Pad::Nav(action));
                            }
                        }
                        EventType::AxisChanged(Axis::RightStickY, v, _) => stick_y = v,
                        EventType::Disconnected => {
                            HELD.store(0, std::sync::atomic::Ordering::Relaxed);
                            gesture = Gesture::default();
                            stick_y = 0.0;
                            if refresh_controller(&gilrs) {
                                on_pad(Pad::ControllerChanged);
                            }
                        }
                        _ => {}
                    }
                }
                if let Some(p) = gesture.tick(Instant::now()) {
                    on_log(format!("pad: View held → {p:?}"));
                    on_pad(p);
                }
                if stick_y.abs() > SCROLL_DEADZONE {
                    on_pad(Pad::Scroll(stick_y));
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        })
        .expect("failed to start gamepad thread");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    #[test]
    fn hold_toggles_the_overlay_once() {
        let (mut g, s) = (Gesture::default(), Instant::now());
        assert_eq!(g.press(s), None);
        assert_eq!(g.tick(at(s, 400)), None);
        assert_eq!(g.tick(at(s, 720)), Some(Pad::ToggleOverlay));
        assert_eq!(g.tick(at(s, 1500)), None);
        g.release(at(s, 1600));
        // Releasing a hold is not a tap: a quick press after it is not a double-tap.
        assert_eq!(g.press(at(s, 1700)), None);
    }

    #[test]
    fn double_tap_toggles_the_list_and_single_taps_do_nothing() {
        let (mut g, s) = (Gesture::default(), Instant::now());
        assert_eq!(g.press(s), None);
        g.release(at(s, 120));
        assert_eq!(g.press(at(s, 300)), Some(Pad::ToggleMissing));
        g.release(at(s, 400));
        assert_eq!(g.tick(at(s, 2000)), None);
        // A relaxed double-tap (slow taps, long pause) still counts.
        assert_eq!(g.press(at(s, 3000)), None);
        g.release(at(s, 3350));
        assert_eq!(g.press(at(s, 3800)), Some(Pad::ToggleMissing));
        g.release(at(s, 3900));
        // Two taps too far apart: nothing.
        assert_eq!(g.press(at(s, 6000)), None);
        g.release(at(s, 6100));
        assert_eq!(g.press(at(s, 6700)), None);
    }

    #[test]
    fn controller_kind_by_vendor_then_name() {
        assert_eq!(kind_of(Some(0x054C), "Wireless Controller"), "playstation");
        assert_eq!(kind_of(Some(0x045E), "Controller"), "xbox");
        assert_eq!(kind_of(None, "DualSense Wireless Controller"), "playstation");
        assert_eq!(kind_of(None, "Xbox Series X Controller"), "xbox");
        assert_eq!(kind_of(Some(0x2DC8), "8BitDo Pro 2"), "other");
    }

    /// Prints the controller gilrs sees right now:
    /// cargo test --lib connected_controller -- --ignored --nocapture
    #[test]
    #[ignore]
    fn connected_controller() {
        let g = gilrs::Gilrs::new().unwrap();
        for (_, p) in g.gamepads() {
            println!("{} · vendor {:04X?} · connected {} → {}", p.name(), p.vendor_id(), p.is_connected(), kind_of(p.vendor_id(), p.name()));
        }
    }
}
