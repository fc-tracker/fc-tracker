//! Reads and changes FC27's display mode in `%LOCALAPPDATA%\EA SPORTS FC 27\fcsetup.ini`.
//!
//! Verified 2026-10-12: borderless = `FULLSCREEN = 1` + `WINDOWED_BORDERLESS = 1`.
//! Only `WINDOWED_BORDERLESS` is touched; the rest of the file is preserved byte-for-byte.
//!
//! Errors are returned as i18n codes (`code` or `code:detail`) and translated in the UI.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;

const BORDERLESS_KEY: &str = "WINDOWED_BORDERLESS";
const BACKUP_SUFFIX: &str = ".fctracker.bak";

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DisplayMode {
    Fullscreen,
    Borderless,
    Windowed,
    Unknown,
}

#[derive(Debug, Serialize)]
pub struct SetupStatus {
    pub path: String,
    pub exists: bool,
    pub mode: DisplayMode,
}

pub fn setup_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("EA SPORTS FC 27").join("fcsetup.ini"))
}

fn read_value(contents: &str, key: &str) -> Option<String> {
    contents.lines().find_map(|line| {
        let (k, v) = line.split_once('=')?;
        (k.trim() == key).then(|| v.trim().to_string())
    })
}

pub fn parse_mode(contents: &str) -> DisplayMode {
    let fullscreen = read_value(contents, "FULLSCREEN");
    let borderless = read_value(contents, BORDERLESS_KEY);
    match (fullscreen.as_deref(), borderless.as_deref()) {
        (_, Some("1")) => DisplayMode::Borderless,
        (Some("1"), Some("0")) => DisplayMode::Fullscreen,
        (Some("0"), Some("0")) => DisplayMode::Windowed,
        _ => DisplayMode::Unknown,
    }
}

/// Sets `WINDOWED_BORDERLESS = 1`, keeping every other line and line ending unchanged.
/// Returns `None` if the key is missing (unknown format – then nothing is touched).
pub fn with_borderless(contents: &str) -> Option<String> {
    let mut found = false;
    let out: String = contents
        .split_inclusive('\n')
        .map(|line| {
            let is_key = line
                .split_once('=')
                .is_some_and(|(k, _)| k.trim() == BORDERLESS_KEY);
            if !is_key {
                return line.to_string();
            }
            found = true;
            let ending = if line.ends_with("\r\n") {
                "\r\n"
            } else if line.ends_with('\n') {
                "\n"
            } else {
                ""
            };
            format!("{BORDERLESS_KEY} = 1{ending}")
        })
        .collect();
    found.then_some(out)
}

pub fn status() -> Result<SetupStatus, String> {
    let path = setup_path().ok_or("setup_no_localappdata")?;
    let path_str = path.display().to_string();
    if !path.exists() {
        return Ok(SetupStatus { path: path_str, exists: false, mode: DisplayMode::Unknown });
    }
    let contents = fs::read_to_string(&path).map_err(|e| format!("setup_read_failed:{e}"))?;
    Ok(SetupStatus { path: path_str, exists: true, mode: parse_mode(&contents) })
}

/// Switches to borderless. Only call while FC27 is not running (checked by the caller).
pub fn set_borderless() -> Result<SetupStatus, String> {
    let path = setup_path().ok_or("setup_no_localappdata")?;
    let contents = fs::read_to_string(&path).map_err(|e| format!("setup_read_failed:{e}"))?;
    if parse_mode(&contents) == DisplayMode::Borderless {
        return status();
    }
    let updated = with_borderless(&contents).ok_or("setup_unknown_format")?;

    let mut backup = path.clone().into_os_string();
    backup.push(BACKUP_SUFFIX);
    fs::copy(&path, &backup).map_err(|e| format!("setup_backup_failed:{e}"))?;
    fs::write(&path, updated).map_err(|e| format!("setup_write_failed:{e}"))?;
    status()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULLSCREEN_INI: &str =
        "// version = 102\r\nRESOLUTIONWIDTH = 1680\r\nFULLSCREEN = 1\r\nWINDOWED_BORDERLESS = 0\r\nFULLSCREEN_OUTPUT_INDEX = 0\r\n";

    #[test]
    fn detects_modes() {
        assert_eq!(parse_mode(FULLSCREEN_INI), DisplayMode::Fullscreen);
        assert_eq!(parse_mode("FULLSCREEN = 1\nWINDOWED_BORDERLESS = 1\n"), DisplayMode::Borderless);
        assert_eq!(parse_mode("FULLSCREEN = 0\nWINDOWED_BORDERLESS = 0\n"), DisplayMode::Windowed);
        assert_eq!(parse_mode("FOO = 1\n"), DisplayMode::Unknown);
    }

    #[test]
    fn sets_only_borderless_line_and_keeps_crlf() {
        let out = with_borderless(FULLSCREEN_INI).unwrap();
        assert_eq!(out, FULLSCREEN_INI.replace("WINDOWED_BORDERLESS = 0", "WINDOWED_BORDERLESS = 1"));
        assert_eq!(parse_mode(&out), DisplayMode::Borderless);
    }

    #[test]
    fn refuses_unknown_format() {
        assert!(with_borderless("FULLSCREEN = 1\n").is_none());
    }
}
