//! Tracking speed: how often the game is looked at, and how soon each kind of screen is read.
//! Presets from the PC's specs (CPU threads, RAM, battery), or every value by hand. Persisted in
//! `ui.json` (`UiPrefs::tracking`). In a match only the Champions tracker looks (`match_ms`, one
//! small look per interval; switched off in Settings → Champions).

use serde::{Deserialize, Serialize};

/// The game presents a new frame every ~7–17 ms: looking more often than this sees the same frame.
pub const WATCH_MIN_MS: u32 = 16;
pub const WATCH_MAX_MS: u32 = 1000;
/// Read delays (ms). 0 = read on the first unchanged look.
pub const READ_MAX_MS: u32 = 10_000;
/// In a match (Champions): one look every 0.5–3 s.
pub const MATCH_MIN_MS: u32 = 500;
pub const MATCH_MAX_MS: u32 = 3000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct TrackingPrefs {
    /// "auto" (from the specs) | "light" | "balanced" | "fast" | "max" | "custom".
    pub preset: String,
    /// Watch the game window continuously (one capture session in the menus, scaled down on the
    /// GPU) instead of copying the screen on every look.
    pub continuous: bool,
    /// How often a look is taken (ms).
    pub watch_ms: u32,
    /// One read delay for every kind of screen (`all_ms`) instead of one per kind.
    pub same_for_all: bool,
    pub all_ms: u32,
    /// A still screen (menus, set pages) is read once it was unchanged this long.
    pub still_ms: u32,
    /// A screen that keeps moving (packs, New Items, 3D backgrounds) is read after this long,
    /// and again every time this passes while it keeps moving.
    pub animated_ms: u32,
    /// The transfer market (search results, Bidding Options, the purchase): read after this long.
    pub market_ms: u32,
    /// In a match (Champions tracker): one look at the scoreboard this often (ms). After full time
    /// the screens are read at once, whatever this says (the result card can be gone in ~1.5 s).
    pub match_ms: u32,
}

impl Default for TrackingPrefs {
    fn default() -> Self {
        let mut p = preset("balanced").unwrap();
        p.preset = "auto".into();
        p
    }
}

/// The values of a named preset.
pub fn preset(name: &str) -> Option<TrackingPrefs> {
    let (continuous, watch_ms, still_ms, animated_ms, market_ms, match_ms) = match name {
        "light" => (false, 250, 300, 2000, 800, 2000),
        "balanced" => (true, 100, 150, 1000, 500, 1000),
        "fast" => (true, 50, 50, 600, 300, 1000),
        "max" => (true, WATCH_MIN_MS, 0, 300, 200, 1000),
        _ => return None,
    };
    Some(TrackingPrefs { preset: name.into(), continuous, watch_ms, same_for_all: false, all_ms: animated_ms, still_ms, animated_ms, market_ms, match_ms })
}

/// What this PC can take: the preset "auto" stands for.
#[derive(Debug, Clone, Serialize)]
pub struct Specs {
    pub threads: u32,
    pub ram_gb: u32,
    pub gpu: Option<String>,
    pub on_battery: bool,
    /// The preset "auto" uses on this PC.
    pub recommended: String,
}

pub fn specs() -> Specs {
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get() as u32);
    let ram_gb = ram_gb();
    let on_battery = on_battery();
    let mut level = if threads <= 4 || ram_gb < 8 {
        0
    } else if threads < 12 || ram_gb < 16 {
        1
    } else {
        2
    };
    // On battery: one step lighter (a laptop away from its charger).
    if on_battery && level > 0 {
        level -= 1;
    }
    let recommended = ["light", "balanced", "fast"][level].to_string();
    Specs { threads, ram_gb, gpu: gpu_name(), on_battery, recommended }
}

/// The values in force: "auto" resolves to the recommended preset, a named preset to its values;
/// "custom" keeps the user's numbers. Everything clamped to sane ranges.
/// `specs()` at most once a minute: `effective` runs on every look in two threads, and the
/// graphics adapter query is not free (measured 0.3 ms CPU per call).
fn specs_cached() -> Specs {
    static CACHE: std::sync::Mutex<Option<(std::time::Instant, Specs)>> = std::sync::Mutex::new(None);
    let mut c = CACHE.lock().unwrap();
    match c.as_ref() {
        Some((at, s)) if at.elapsed() < std::time::Duration::from_secs(60) => s.clone(),
        _ => {
            let s = specs();
            *c = Some((std::time::Instant::now(), s.clone()));
            s
        }
    }
}

pub fn effective(p: &TrackingPrefs) -> TrackingPrefs {
    let mut e = match p.preset.as_str() {
        "auto" => preset(&specs_cached().recommended).unwrap(),
        "custom" => p.clone(),
        name => preset(name).unwrap_or_else(|| p.clone()),
    };
    e.preset = p.preset.clone();
    clamp(e)
}

pub fn clamp(mut p: TrackingPrefs) -> TrackingPrefs {
    p.watch_ms = p.watch_ms.clamp(WATCH_MIN_MS, WATCH_MAX_MS);
    // Copying the whole screen on every look is not free: without continuous watching, no
    // faster than every 50 ms.
    if !p.continuous {
        p.watch_ms = p.watch_ms.max(50);
    }
    // the goal banner stays ~4 s: no slower than every 3 s, and no faster than twice a second
    p.match_ms = p.match_ms.clamp(MATCH_MIN_MS, MATCH_MAX_MS);
    for v in [&mut p.all_ms, &mut p.still_ms, &mut p.animated_ms, &mut p.market_ms] {
        *v = (*v).min(READ_MAX_MS);
    }
    p
}

/// The read rules in looks (ticks) for `tracking::ReadGate`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GateCfg {
    /// Unchanged looks in a row before a still screen is read (≥ 1).
    pub still_ticks: u32,
    /// Looks before a moving screen is read, and between reads while it keeps moving.
    pub animated_ticks: u32,
    /// The same on the transfer market.
    pub market_ticks: u32,
}

impl Default for GateCfg {
    /// The rules before the settings existed (250 ms looks): still at once, moving after ~1 s,
    /// transfer market after ~0.5 s.
    fn default() -> Self {
        Self { still_ticks: 1, animated_ticks: 4, market_ticks: 2 }
    }
}

#[cfg(test)]
pub fn gate_cfg(e: &TrackingPrefs) -> GateCfg {
    gate_cfg_for(e, e.watch_ms)
}

/// The read delays in ticks of `tick_ms` (the tracking loop's real tick length).
pub fn gate_cfg_for(e: &TrackingPrefs, tick_ms: u32) -> GateCfg {
    let ticks = |ms: u32| ms.div_ceil(tick_ms.max(1)).max(1);
    if e.same_for_all {
        let t = ticks(e.all_ms);
        GateCfg { still_ticks: t, animated_ticks: t, market_ticks: t }
    } else {
        GateCfg { still_ticks: ticks(e.still_ms), animated_ticks: ticks(e.animated_ms), market_ticks: ticks(e.market_ms) }
    }
}

fn ram_gb() -> u32 {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    // SAFETY: plain out-parameter call.
    if unsafe { GlobalMemoryStatusEx(&mut m) }.is_ok() {
        ((m.ullTotalPhys + (512 << 20)) >> 30) as u32
    } else {
        8
    }
}

fn on_battery() -> bool {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s = SYSTEM_POWER_STATUS::default();
    // SAFETY: plain out-parameter call. ACLineStatus 0 = on battery.
    unsafe { GetSystemPowerStatus(&mut s) }.is_ok() && s.ACLineStatus == 0
}

fn gpu_name() -> Option<String> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
    // SAFETY: read-only DXGI queries.
    unsafe {
        let f: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        let a = f.EnumAdapters1(0).ok()?;
        let d = a.GetDesc1().ok()?;
        let len = d.Description.iter().position(|&c| c == 0).unwrap_or(d.Description.len());
        Some(String::from_utf16_lossy(&d.Description[..len]).trim().to_string()).filter(|s| !s.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_turn_into_looks_and_clamp() {
        let b = effective(&TrackingPrefs { preset: "balanced".into(), ..Default::default() });
        assert_eq!(gate_cfg(&b), GateCfg { still_ticks: 2, animated_ticks: 10, market_ticks: 5 });
        let m = effective(&TrackingPrefs { preset: "max".into(), ..Default::default() });
        assert_eq!(m.watch_ms, WATCH_MIN_MS);
        assert_eq!(gate_cfg(&m).still_ticks, 1);
        // custom: "same for all" uses one value everywhere; nonsense is clamped
        let c = effective(&TrackingPrefs { preset: "custom".into(), continuous: false, watch_ms: 1, same_for_all: true, all_ms: 99_999, ..Default::default() });
        assert_eq!(c.watch_ms, 50, "no continuous watching: not faster than 50 ms");
        assert_eq!(c.all_ms, READ_MAX_MS);
        let g = gate_cfg(&c);
        assert!(g.still_ticks == g.animated_ticks && g.animated_ticks == g.market_ticks);
    }

    #[test]
    fn auto_picks_a_preset_from_the_specs() {
        let s = specs();
        assert!(["light", "balanced", "fast"].contains(&s.recommended.as_str()));
        assert!(s.threads >= 1 && s.ram_gb >= 1);
    }
}
