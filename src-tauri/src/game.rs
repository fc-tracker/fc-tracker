//! Finds and launches FC27. Never touches the game process itself – only "is it running?" and "start it".

use std::path::PathBuf;
use std::process::Command;

const EXE_NAME: &str = "FC27.exe";
const DEFAULT_INSTALL_DIR: &str = r"C:\Program Files\EA Games\EA SPORTS FC 27";

pub const WEB_APP_URL: &str = "https://www.ea.com/ea-sports-fc/ultimate-team/web-app/";

pub fn exe_path() -> PathBuf {
    PathBuf::from(DEFAULT_INSTALL_DIR).join(EXE_NAME)
}

/// Is an FC27*.exe process running? A process snapshot (microseconds, no child process – the
/// old `tasklist` call once reported the game closed in the middle of a match).
pub fn is_running() -> bool {
    process_running(|name| name.starts_with("fc27") && name.ends_with(".exe"))
}

/// Chrome or Edge is open (the extension can only check in while one of them runs).
pub fn browser_running() -> bool {
    process_running(|name| name == "chrome.exe" || name == "msedge.exe")
}

/// Screen recorders and capture tools (process → name for the log). While one runs, our own
/// capture is held steady – opening and closing captures of the game window can make Windows change
/// how it presents the game, and a recording then loses the screen (live 2026-10-17: the Snipping
/// Tool's recording frame vanished each time our capture of the game stopped or started).
/// Tools that are also open without recording (the Snipping Tool editor, Game Bar) count only with
/// a window on top of everything (their recording frame, toolbar or selection); dedicated recorders
/// with any window.
const ON_TOP_ONLY: [&str; 4] = ["screenclippinghost.exe", "snippingtool.exe", "gamebarftserver.exe", "gamebar.exe"];
const RECORDERS: [(&str, &str); 11] = [
    ("screenclippinghost.exe", "Snipping Tool"),
    ("snippingtool.exe", "Snipping Tool"),
    ("obs64.exe", "OBS"),
    ("obs32.exe", "OBS"),
    ("gamebarftserver.exe", "Xbox Game Bar"),
    ("gamebar.exe", "Xbox Game Bar"),
    ("sharex.exe", "ShareX"),
    ("bdcam.exe", "Bandicam"),
    ("streamlabs obs.exe", "Streamlabs"),
    ("medal.exe", "Medal"),
    ("xsplit.core.exe", "XSplit"),
];

/// The screen recorder that shows a window right now (its recording frame, toolbar or selection),
/// if any. A process alone is no sign: the Snipping Tool stays in the background for days.
/// Process ids of the recorders seen by the last `recorder_running` (checked every second).
static RECORDER_PIDS: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());

/// Is this process a screen recorder (OBS, Snipping Tool …)? Its window in front doesn't mean the
/// user left the game – they just pressed Record (live 2026-10-17: OBS in front for 4 minutes while
/// the user browsed the Gallery with the controller, and no notice showed).
pub fn is_recorder(pid: u32) -> bool {
    RECORDER_PIDS.lock().unwrap().contains(&pid)
}

pub fn recorder_running() -> Option<&'static str> {
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
    use windows::core::BOOL;
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOPMOST};
    // recorder processes: pid → label
    let mut pids: Vec<(u32, &'static str, bool)> = Vec::new();
    // SAFETY: read-only process list; the snapshot handle is closed below.
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return None };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        while ok {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_ascii_lowercase();
            if let Some((exe, label)) = RECORDERS.iter().find(|(exe, _)| *exe == name) {
                pids.push((entry.th32ProcessID, label, ON_TOP_ONLY.contains(exe)));
            }
            ok = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    *RECORDER_PIDS.lock().unwrap() = pids.iter().map(|p| p.0).collect();
    if pids.is_empty() {
        return None;
    }
    struct Find {
        pids: Vec<(u32, &'static str, bool)>,
        found: Option<&'static str>,
    }
    unsafe extern "system" fn each(hwnd: HWND, data: LPARAM) -> BOOL {
        // SAFETY: `data` points at the Find below for the duration of EnumWindows.
        let find = unsafe { &mut *(data.0 as *mut Find) };
        // SAFETY: read-only window queries.
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                return BOOL(1);
            }
            let mut r = RECT::default();
            if GetWindowRect(hwnd, &mut r).is_err() || r.right - r.left < 8 || r.bottom - r.top < 8 {
                return BOOL(1);
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let Some((_, label, on_top_only)) = find.pids.iter().find(|(p, _, _)| *p == pid) else { return BOOL(1) };
            // a suspended app's window can be "visible" but cloaked: not on screen
            let mut cloaked = 0u32;
            let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut core::ffi::c_void, 4);
            if cloaked != 0 {
                return BOOL(1);
            }
            let topmost = (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOPMOST.0 != 0;
            if !*on_top_only || topmost {
                find.found = Some(label);
                return BOOL(0);
            }
        }
        BOOL(1)
    }
    let mut find = Find { pids, found: None };
    // SAFETY: the callback only reads windows and writes into `find`, which outlives the call.
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut find as *mut Find as isize));
    }
    find.found
}

fn process_running(matches: impl Fn(&str) -> bool) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    // SAFETY: read-only process list; the snapshot handle is closed below.
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return false };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = false;
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        while ok {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_ascii_lowercase();
            if matches(&name) {
                found = true;
                break;
            }
            ok = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
        found
    }
}

// Links and the user's own registry keys go through the Windows API directly – no rundll32 or
// reg.exe processes (antivirus heuristics read those as malware tricks; the result is the same).

/// Opens a URL (or folder) with its default program, like a double-click.
pub fn shell_open(target: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    // SAFETY: plain call with owned wide strings; ShellExecuteW returns > 32 on success.
    let r = unsafe { ShellExecuteW(None, &HSTRING::from("open"), &HSTRING::from(target), None, None, SW_SHOWNORMAL) };
    if r.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!("browser_failed:{}", r.0 as isize))
    }
}

/// Writes a string value under HKEY_CURRENT_USER (creates the key; `name` None = default value).
fn reg_set(subkey: &str, name: Option<&str>, value: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Registry::{RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ};
    let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let name = name.map(HSTRING::from);
    // SAFETY: the key handle is created here and closed below; the data slice lives across the call.
    unsafe {
        let mut key = HKEY::default();
        RegCreateKeyExW(HKEY_CURRENT_USER, &HSTRING::from(subkey), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut key, None)
            .ok()
            .map_err(|e| format!("registry_failed:{e}"))?;
        let bytes = std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2);
        let r = RegSetValueExW(key, name.as_ref().map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr())), None, REG_SZ, Some(bytes));
        let _ = RegCloseKey(key);
        r.ok().map_err(|e| format!("registry_failed:{e}"))
    }
}

fn reg_exists(subkey: &str, name: &str) -> bool {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    // SAFETY: existence check only – no buffer is passed.
    unsafe { RegGetValueW(HKEY_CURRENT_USER, &HSTRING::from(subkey), &HSTRING::from(name), RRF_RT_REG_SZ, None, None, None).is_ok() }
}

fn reg_delete(subkey: &str, name: &str) {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegDeleteKeyValueW, HKEY_CURRENT_USER};
    // SAFETY: deletes one value of the user's own key; a missing value is fine.
    let _ = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(subkey), &HSTRING::from(name)) };
}

/// Opens a page of fc-tracker.com in the default browser (path like "/download").
pub fn open_site(path: &str) -> Result<(), String> {
    let path = if path.starts_with('/') && !path.contains("..") { path } else { "/" };
    shell_open(&format!("https://www.fc-tracker.com{path}"))
}

/// Registers fctracker:// for this user (HKCU, no admin): the extension's "Open FC-Tracker"
/// button starts the app with it. Done at every start, so it follows the app if it moves.
pub fn register_protocol() {
    let Ok(exe) = std::env::current_exe() else { return };
    let base = r"Software\Classes\fctracker";
    let _ = reg_set(base, None, "URL:FC-Tracker");
    let _ = reg_set(base, Some("URL Protocol"), "");
    let _ = reg_set(&format!(r"{base}\shell\open\command"), None, &format!("\"{}\" \"%1\"", exe.display()));
}

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// "Start with Windows" is on (the installer's checkbox or the launcher's setting).
pub fn autostart_enabled() -> bool {
    reg_exists(RUN_KEY, "FC-Tracker")
}

/// Turns "Start with Windows" on or off – the same entry the installer writes. At login the app
/// starts with --autostart: quietly, in the tray.
pub fn set_autostart(on: bool) -> Result<(), String> {
    if on {
        let exe = std::env::current_exe().map_err(|e| format!("autostart_failed:{e}"))?;
        reg_set(RUN_KEY, Some("FC-Tracker"), &format!("\"{}\" --autostart", exe.display()))
    } else {
        reg_delete(RUN_KEY, "FC-Tracker");
        Ok(())
    }
}

/// Opens the Web App in the user's default browser (where they are usually already signed in).
pub fn open_web_app() -> Result<(), String> {
    shell_open(WEB_APP_URL)
}

/// Launches the game via its exe; the EA app takes over sign-in and anti-cheat startup.
pub fn launch() -> Result<(), String> {
    if is_running() {
        return Err("game_already_running".into());
    }
    let exe = exe_path();
    if !exe.exists() {
        return Err(format!("game_not_found:{}", exe.display()));
    }
    Command::new(&exe)
        .current_dir(exe.parent().unwrap())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("launch_failed:{e}"))
}

#[cfg(test)]
mod tests {
    /// Which recorder shows a window right now: `cargo test --lib recorder_now -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn recorder_now() {
        let t = std::time::Instant::now();
        println!("recorder showing a window: {:?} (checked in {:?})", super::recorder_running(), t.elapsed());
    }

    #[test]
    #[ignore]
    fn reports_whether_the_game_runs() {
        let t = std::time::Instant::now();
        println!("FC 27 running: {} ({:?})", super::is_running(), t.elapsed());
    }
}
