//! Diagnostics: for a limited time every picture the tracking reads is saved (JPEG, half size)
//! with what the app concluded, where the picture came from and how old the screen was – so a
//! wrong read can be seen exactly as the app saw it. Off by default, never persisted, 30 minutes.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const RUN_FOR: Duration = Duration::from_secs(30 * 60);
/// At most this many pictures per run (~150 KB each).
const MAX_PICTURES: u32 = 800;

struct Run {
    until: Instant,
    dir: PathBuf,
    n: u32,
}

static RUN: Mutex<Option<Run>> = Mutex::new(None);

/// Starts a run in `<data>/diagnostics/<time>`; returns its folder.
pub fn start(data_dir: &Path) -> Result<PathBuf, String> {
    let stamp = chrono_like_stamp();
    let root = data_dir.join("diagnostics");
    let dir = root.join(stamp);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // keep the 3 newest runs (≈ 100 MB each at most)
    if let Ok(rd) = std::fs::read_dir(&root) {
        let mut runs: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
        runs.sort();
        while runs.len() > 3 {
            let _ = std::fs::remove_dir_all(runs.remove(0));
        }
    }
    // the tracking log of this PC goes along (it explains what the pictures show)
    let _ = std::fs::copy(data_dir.join("tracking.log"), dir.join("tracking-before.log"));
    *RUN.lock().unwrap() = Some(Run { until: Instant::now() + RUN_FOR, dir: dir.clone(), n: 0 });
    Ok(dir)
}

pub fn stop() {
    *RUN.lock().unwrap() = None;
}

/// Seconds left of the running run, or None.
pub fn remaining() -> Option<u64> {
    let mut run = RUN.lock().unwrap();
    match run.as_ref() {
        Some(r) if Instant::now() < r.until => Some((r.until - Instant::now()).as_secs()),
        Some(_) => {
            *run = None;
            None
        }
        None => None,
    }
}

pub fn active() -> bool {
    remaining().is_some()
}

/// One read: the picture and a line in `reads.log`.
pub fn record(frame: &crate::scan::Frame, desc: &str, source: &str, shown_ms: u128) {
    if !active() {
        return;
    }
    let (dir, n) = {
        let mut run = RUN.lock().unwrap();
        let Some(r) = run.as_mut() else { return };
        if r.n >= MAX_PICTURES {
            return;
        }
        r.n += 1;
        (r.dir.clone(), r.n)
    };
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let file = format!("{n:04}.jpg");
    let (w, h, bgra) = (frame.width, frame.height, frame.bgra.clone());
    let (desc, source) = (desc.to_string(), source.to_string());
    // encoding takes a while: never on the tracking thread (reads must not wait for it)
    std::thread::spawn(move || {
        let saved = crate::scan::save_jpeg(&dir.join(&file), w, h, &bgra);
        let line = format!("{secs} {file} {w}x{h} from {source} · on screen {shown_ms} ms · {desc}{}\n", saved.err().map(|e| format!(" (picture not saved: {e})")).unwrap_or_default());
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("reads.log")) {
            let _ = f.write_all(line.as_bytes());
        }
    });
}

/// "2026-10-17_13-45-02" (local time from the system, no extra crate).
fn chrono_like_stamp() -> String {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    // SAFETY: plain query.
    let t = unsafe { GetLocalTime() };
    format!("{:04}-{:02}-{:02}_{:02}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}
