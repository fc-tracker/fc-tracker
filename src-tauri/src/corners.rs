//! Four small corner marks on the game window while the app watches it – instead of Windows'
//! yellow capture frame all the way round (user, 2026-10-27: "only the corners, so you know it is
//! on"). Each mark is a tiny L-shaped native window: click-through, never focused, kept out of
//! every capture (our own reads, screenshots, the user's recordings). Shown only while the game
//! is in front and the continuous capture runs (`watch::watching`); nothing touches the game.

use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{ClientToScreen, CombineRgn, CreateRectRgn, CreateSolidBrush, DeleteObject, SetWindowRgn, HBRUSH, RGN_OR};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetClientRect, GetForegroundWindow, PeekMessageW, RegisterClassW, SetLayeredWindowAttributes,
    SetWindowDisplayAffinity, SetWindowPos, ShowWindow, HWND_TOPMOST, LWA_ALPHA, MSG, PM_REMOVE, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE,
    WDA_EXCLUDEFROMCAPTURE, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

/// The mint of the scores (`--accent-2` #3fe0b8) as 0x00BBGGRR.
const MINT: COLORREF = COLORREF(0x00b8_e03f);
/// Arm length and thickness at 100 % scaling.
const ARM: i32 = 22;
const THICK: i32 = 3;
const TICK: std::time::Duration = std::time::Duration::from_millis(250);

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: windows::Win32::Foundation::WPARAM, l: windows::Win32::Foundation::LPARAM) -> windows::Win32::Foundation::LRESULT {
    // SAFETY: default handling for our own windows.
    unsafe { DefWindowProcW(hwnd, msg, w, l) }
}

/// Corner `i` (0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right) as an L of `arm` × `thick`.
fn shape(hwnd: HWND, i: usize, arm: i32, thick: i32) {
    let right = i % 2 == 1;
    let bottom = i >= 2;
    // SAFETY: regions are created here and handed to the window (which then owns the result).
    unsafe {
        let bar = if bottom { CreateRectRgn(0, arm - thick, arm, arm) } else { CreateRectRgn(0, 0, arm, thick) };
        let post = if right { CreateRectRgn(arm - thick, 0, arm, arm) } else { CreateRectRgn(0, 0, thick, arm) };
        CombineRgn(Some(bar), Some(bar), Some(post), RGN_OR);
        let _ = DeleteObject(post.into());
        SetWindowRgn(hwnd, Some(bar), true);
    }
}

/// Starts the corner marks (one thread owning four tiny windows) on the game window while the
/// continuous capture of it runs.
pub fn spawn() {
    run(|| crate::watch::watching().then(crate::scan::game_window).flatten());
}

/// The marks on `target()` whenever that window is in front.
fn run(target: impl Fn() -> Option<HWND> + Send + 'static) {
    let _ = std::thread::Builder::new().name("corners".into()).spawn(move || {
        // SAFETY: plain Win32 window creation and positioning on this thread; the windows live as
        // long as the thread (the app's lifetime). Nothing here touches another process.
        unsafe {
            let brush: HBRUSH = CreateSolidBrush(MINT);
            let class = WNDCLASSW { lpfnWndProc: Some(proc), lpszClassName: w!("FcTrackerCorner"), hbrBackground: brush, ..Default::default() };
            if RegisterClassW(&class) == 0 {
                return;
            }
            let ex = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TRANSPARENT;
            let mut marks = Vec::new();
            for _ in 0..4 {
                let Ok(h) = CreateWindowExW(ex, w!("FcTrackerCorner"), w!(""), WS_POPUP, 0, 0, ARM, ARM, None, None, None, None) else { return };
                let _ = SetLayeredWindowAttributes(h, COLORREF(0), 235, LWA_ALPHA);
                let _ = SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE);
                marks.push(h);
            }
            let mut shown: Option<(RECT, i32)> = None;
            let mut sized = 0;
            let mut since_top = 0u32;
            loop {
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    DispatchMessageW(&msg);
                }
                let want = target().filter(|g| GetForegroundWindow() == *g).and_then(|g| {
                    let mut r = RECT::default();
                    GetClientRect(g, &mut r).ok()?;
                    let mut tl = POINT { x: 0, y: 0 };
                    let _ = ClientToScreen(g, &mut tl);
                    let scale = GetDpiForWindow(g).max(96) as i32;
                    Some((RECT { left: tl.x, top: tl.y, right: tl.x + r.right, bottom: tl.y + r.bottom }, scale))
                });
                match want {
                    Some((r, dpi)) if r.right - r.left > 200 => {
                        since_top += 1;
                        // re-assert topmost now and then: a game in front can push us down
                        if shown.is_none_or(|(old, d)| old != r || d != dpi) || since_top >= 8 {
                            since_top = 0;
                            let arm = ARM * dpi / 96;
                            let thick = (THICK * dpi / 96).max(2);
                            if sized != arm {
                                for (i, h) in marks.iter().enumerate() {
                                    shape(*h, i, arm, thick);
                                }
                                sized = arm;
                            }
                            for (i, h) in marks.iter().enumerate() {
                                let x = if i % 2 == 1 { r.right - arm } else { r.left };
                                let y = if i >= 2 { r.bottom - arm } else { r.top };
                                let _ = SetWindowPos(*h, Some(HWND_TOPMOST), x, y, arm, arm, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                            }
                            shown = Some((r, dpi));
                        }
                    }
                    _ => {
                        if shown.take().is_some() {
                            for h in &marks {
                                let _ = ShowWindow(*h, SW_HIDE);
                            }
                        }
                    }
                }
                std::thread::sleep(TICK);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    /// `cargo test --lib corner_marks -- --ignored --nocapture`: the four marks sit in the corners
    /// of the window in front (here: whatever window is focused when the test starts).
    #[test]
    #[ignore]
    fn corner_marks_sit_on_the_corners_of_the_window_in_front() {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, GetForegroundWindow, GetWindowRect, IsWindowVisible};
        // SAFETY: plain window queries.
        unsafe {
            let fg = GetForegroundWindow();
            let fg = fg.0 as isize;
            super::run(move || Some(windows::Win32::Foundation::HWND(fg as *mut _)));
            std::thread::sleep(std::time::Duration::from_millis(800));
            let mut after = None;
            let mut n = 0;
            while let Ok(h) = FindWindowExW(None, after, windows::core::w!("FcTrackerCorner"), None) {
                let mut r = RECT::default();
                let _ = GetWindowRect(h, &mut r);
                println!("mark {n}: visible {} at {:?}", IsWindowVisible(h).as_bool(), (r.left, r.top, r.right, r.bottom));
                assert!(IsWindowVisible(h).as_bool());
                after = Some(h);
                n += 1;
            }
            assert_eq!(n, 4);
        }
    }
}
