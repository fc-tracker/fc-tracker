//! Local HTTP bridge between the browser extension and the app.
//!
//! Security:
//! - Listens on 127.0.0.1 only (never the network).
//! - Requests from regular websites (any non-extension Origin) are rejected, so web pages
//!   cannot push data into the app. Extension requests may arrive without an Origin header.
//! - The extension pairs once with a 6-digit code shown in the app; after that a secret
//!   token is sent in the `X-FCT-Token` header.
//! - The extension never forwards EA's session token – only response bodies.

use crate::store::{Store, Summary};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Method, Request, Response, Server};

pub const PORT: u16 = 47827;
const MAX_BODY: usize = 20 * 1024 * 1024;

type Resp = Response<std::io::Cursor<Vec<u8>>>;

#[derive(Default, Serialize, Deserialize)]
struct Pairing {
    token: Option<String>,
    /// The extension's version, last seen in its requests (kept for the next start).
    #[serde(default)]
    extension_version: Option<String>,
}

/// The extension version this app ships with (the one on the website).
pub fn extension_latest() -> String {
    serde_json::from_str::<Value>(include_str!("../../extension/manifest.json"))
        .ok()
        .and_then(|m| m["version"].as_str().map(str::to_string))
        .unwrap_or_default()
}

pub struct Bridge {
    pairing_path: PathBuf,
    token: Option<String>,
    pub pairing_code: String,
    /// UI language chosen in the app; the extension follows it so both speak the same language.
    locale: String,
    extension_version: Option<String>,
    /// An extension without a valid token asked (reinstalled, other browser, other profile):
    /// the launcher shows the pairing code again although an old pairing exists.
    unpaired_seen: Option<std::time::Instant>,
    /// Last check-in with a valid token (the extension pings on start and every minute).
    authorized_seen: Option<std::time::Instant>,
}

pub const LOCALES: [&str; 5] = ["en", "es", "fr", "de", "da"];

#[derive(Serialize, Clone)]
pub struct BridgeInfo {
    pub port: u16,
    pub paired: bool,
    pub pairing_code: String,
    /// Installed extension version (None until it has talked to this app since 0.9.2).
    pub extension_version: Option<String>,
    /// The version on the website; an older installed one should be replaced.
    pub extension_latest: String,
    /// The oldest extension this app works with.
    pub extension_required: String,
    /// Show the pairing code: never paired, or an unpaired extension is asking right now.
    pub needs_pairing: bool,
    /// The paired extension checked in lately – Chrome runs and the connection works.
    pub extension_live: bool,
    /// Chrome or Edge is open (filled in by the command; tells "browser closed" from
    /// "extension removed or off").
    #[serde(default)]
    pub browser_running: bool,
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("OS randomness unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_code() -> String {
    let mut buf = [0u8; 4];
    getrandom::fill(&mut buf).expect("OS randomness unavailable");
    format!("{:06}", u32::from_le_bytes(buf) % 1_000_000)
}

impl Bridge {
    pub fn load(dir: &PathBuf) -> Self {
        let pairing_path = dir.join("pairing.json");
        let saved = fs::read_to_string(&pairing_path).ok().and_then(|s| serde_json::from_str::<Pairing>(&s).ok()).unwrap_or_default();
        Self { pairing_path, token: saved.token, pairing_code: random_code(), locale: "en".into(), extension_version: saved.extension_version, unpaired_seen: None, authorized_seen: None }
    }

    pub fn locale(&self) -> &str {
        &self.locale
    }

    pub fn set_locale(&mut self, locale: &str) -> bool {
        let ok = LOCALES.contains(&locale);
        if ok {
            self.locale = locale.to_string();
        }
        ok
    }

    pub fn info(&self) -> BridgeInfo {
        BridgeInfo {
            port: PORT,
            paired: self.token.is_some(),
            pairing_code: self.pairing_code.clone(),
            extension_version: self.extension_version.clone(),
            extension_latest: extension_latest(),
            extension_required: crate::updates::EXTENSION_REQUIRED.to_string(),
            needs_pairing: self.token.is_none() || self.unpaired_seen.is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(600)),
            // The extension checks in every 30 s (every 60 s before 0.10.1).
            extension_live: self.token.is_some() && self.authorized_seen.is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(100)),
            browser_running: false,
        }
    }

    fn save(&self) {
        let pairing = Pairing { token: self.token.clone(), extension_version: self.extension_version.clone() };
        let _ = fs::write(&self.pairing_path, serde_json::to_string(&pairing).unwrap());
    }

    /// Remembers the version the extension reports in its requests.
    fn saw_extension(&mut self, version: &str) {
        if self.extension_version.as_deref() != Some(version) && version.len() <= 20 {
            self.extension_version = Some(version.to_string());
            // a new extension = Chrome installed a new release: the app's update is out too
            crate::updates::kick();
            if self.token.is_some() {
                self.save();
            }
        }
    }

    pub fn unpair(&mut self) {
        self.token = None;
        self.pairing_code = random_code();
        let _ = fs::remove_file(&self.pairing_path);
    }

    fn pair(&mut self, code: &str) -> Option<String> {
        if code.trim() != self.pairing_code {
            return None;
        }
        let token = random_hex(32);
        self.token = Some(token.clone());
        self.unpaired_seen = None;
        self.authorized_seen = Some(std::time::Instant::now());
        self.save();
        // Rotate the code so it cannot be reused.
        self.pairing_code = random_code();
        Some(token)
    }

    fn authorized(&self, req: &Request) -> bool {
        let Some(expected) = &self.token else { return false };
        header(req, "X-FCT-Token").is_some_and(|t| constant_time_eq(t.as_bytes(), expected.as_bytes()))
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn header<'a>(req: &'a Request, name: &str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str())
}

enum Caller {
    /// Browser extension (CORS headers are echoed back to this origin).
    Extension(String),
    /// No Origin header: Chrome omits it for extension service-worker requests covered by
    /// host_permissions. Web pages always send Origin on cross-origin POSTs, and every
    /// state-changing endpoint additionally requires the pairing code or token.
    NoOrigin,
    /// A regular website – always rejected.
    Website,
}

fn caller(req: &Request) -> Caller {
    match header(req, "Origin") {
        None => Caller::NoOrigin,
        Some(o) if o.starts_with("chrome-extension://") || o.starts_with("moz-extension://") => {
            Caller::Extension(o.to_string())
        }
        Some(_) => Caller::Website,
    }
}

fn h(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).unwrap()
}

/// CORS headers for the calling extension. Chrome sends a preflight (OPTIONS) before
/// requests with JSON/custom headers, and a Private/Local Network Access preflight for 127.0.0.1.
fn with_cors(resp: Resp, origin: &str) -> Resp {
    resp.with_header(h("Access-Control-Allow-Origin", origin))
        .with_header(h("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
        .with_header(h("Access-Control-Allow-Headers", "Content-Type, X-FCT-Token, X-FCT-Version"))
        .with_header(h("Access-Control-Allow-Private-Network", "true"))
        .with_header(h("Access-Control-Max-Age", "600"))
        .with_header(h("Vary", "Origin"))
}

fn json_response(status: u16, body: Value) -> Resp {
    Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(h("Content-Type", "application/json"))
}

fn read_json(req: &mut Request) -> Option<Value> {
    let mut buf = Vec::new();
    req.as_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut buf).ok()?;
    if buf.len() > MAX_BODY {
        return None;
    }
    serde_json::from_slice(&buf).ok()
}

pub enum BridgeEvent {
    Paired,
    Updated(Summary),
    SyncDone(Summary),
    /// The Web App can't sync: not signed in (`not_signed_in`) or the club never loaded
    /// (`webapp_not_ready`). The user has to act.
    SyncBlocked(String),
    /// Data arrives again after a block: the sync runs.
    SyncResumed,
    /// Sync progress for the notice on top of the game (club players so far, Gallery set n of all).
    SyncProgress(Value),
}

pub fn spawn(
    store: Arc<Mutex<Store>>,
    bridge: Arc<Mutex<Bridge>>,
    notify: impl Fn(BridgeEvent) + Send + 'static,
) -> Result<(), String> {
    let server = Server::http(("127.0.0.1", PORT)).map_err(|e| format!("bridge_port_in_use:{PORT} ({e})"))?;
    std::thread::Builder::new()
        .name("bridge".into())
        .spawn(move || {
            for mut req in server.incoming_requests() {
                let resp = match caller(&req) {
                    Caller::Extension(origin) => with_cors(handle(&mut req, &store, &bridge, &notify), &origin),
                    Caller::NoOrigin => handle(&mut req, &store, &bridge, &notify),
                    Caller::Website => json_response(403, serde_json::json!({ "error": "extension_only" })),
                };
                let _ = req.respond(resp);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn handle(
    req: &mut Request,
    store: &Arc<Mutex<Store>>,
    bridge: &Arc<Mutex<Bridge>>,
    notify: &impl Fn(BridgeEvent),
) -> Resp {
    let path = req.url().split('?').next().unwrap_or("").to_string();
    if let Some(v) = header(req, "X-FCT-Version") {
        let v = v.to_string();
        bridge.lock().unwrap().saw_extension(&v);
    }

    match (req.method(), path.as_str()) {
        (Method::Options, _) => Response::from_string("").with_status_code(204),
        (Method::Get, "/ping") => {
            let (authorized, locale) = {
                let mut b = bridge.lock().unwrap();
                let authorized = b.authorized(req);
                // Only extensions ping; one without our token wants to be paired.
                b.unpaired_seen = if authorized { None } else { Some(std::time::Instant::now()) };
                if authorized {
                    b.authorized_seen = Some(std::time::Instant::now());
                }
                (authorized, b.locale.clone())
            };
            let (sync_active, abort, synced_at) = {
                let s = store.lock().unwrap();
                (authorized && s.sync_active, authorized && s.sync_abort, s.summary().synced_at)
            };
            json_response(
                200,
                serde_json::json!({
                    "app": "fc-tracker",
                    "authorized": authorized,
                    "sync_active": sync_active,
                    // The game entered Ultimate Team: stop and close the Web App now.
                    "abort": abort,
                    // The last club sync (ms): the extension drops a saved sync that is older.
                    "synced_at": if authorized { synced_at } else { None },
                    "locale": locale,
                    // the extension version that belongs to this app – the extension offers an update
                    "extension_latest": extension_latest(),
                    // older than this and the extension updates itself right away (updates.rs)
                    "extension_required": crate::updates::EXTENSION_REQUIRED
                }),
            )
        }
        (Method::Get, "/gallery-sets") => {
            if !bridge.lock().unwrap().authorized(req) {
                return json_response(401, serde_json::json!({ "error": "not_paired" }));
            }
            // The extension only needs the card-database searches (per league and rarity set).
            let sets: Vec<Value> = crate::gallery_sets::sync_filters()
                .into_iter()
                .map(|(key, filter)| serde_json::json!({ "key": key, "filter": filter }))
                .collect();
            json_response(200, serde_json::json!({ "sets": sets }))
        }
        (Method::Post, "/pair") => {
            let code = read_json(req).and_then(|v| v.get("code").and_then(Value::as_str).map(str::to_string));
            let token = code.and_then(|c| bridge.lock().unwrap().pair(&c));
            match token {
                Some(token) => {
                    notify(BridgeEvent::Paired);
                    json_response(200, serde_json::json!({ "token": token }))
                }
                None => json_response(401, serde_json::json!({ "error": "wrong_code" })),
            }
        }
        (Method::Post, "/sync-blocked") => {
            if !bridge.lock().unwrap().authorized(req) {
                return json_response(401, serde_json::json!({ "error": "not_paired" }));
            }
            let reason = read_json(req)
                .and_then(|v| v.get("reason").and_then(Value::as_str).map(str::to_string))
                .filter(|r| r == "not_signed_in" || r == "webapp_not_ready")
                .unwrap_or_else(|| "not_signed_in".into());
            {
                let mut s = store.lock().unwrap();
                if s.sync_active {
                    s.sync_blocked = Some(reason.clone());
                }
            }
            notify(BridgeEvent::SyncBlocked(reason));
            json_response(200, serde_json::json!({ "ok": true }))
        }
        (Method::Post, p) if p == "/capture" || p == "/sync-done" => {
            if !bridge.lock().unwrap().authorized(req) {
                return json_response(401, serde_json::json!({ "error": "not_paired" }));
            }
            if p == "/sync-done" {
                // "at": when a sync the extension saved (app closed) really ended
                let at = read_json(req).and_then(|v| v.get("at").and_then(Value::as_u64));
                let summary = {
                    let mut s = store.lock().unwrap();
                    match at {
                        Some(at) => s.finish_sync_at(at),
                        None => s.finish_sync(),
                    }
                    s.summary()
                };
                notify(BridgeEvent::SyncDone(summary.clone()));
                return json_response(200, serde_json::to_value(summary).unwrap());
            }
            let Some(payload) = read_json(req) else {
                return json_response(400, serde_json::json!({ "error": "invalid_json" }));
            };
            let url = payload.get("url").and_then(Value::as_str).unwrap_or_default().to_string();
            let body = payload.get("body").cloned().unwrap_or(Value::Null);
            let at = payload.get("at").and_then(Value::as_u64);
            let (items, summary, resumed, progress) = {
                let mut s = store.lock().unwrap();
                // Club data from an active sync after a block: the user signed in.
                let resumed = url.starts_with("fct://club/") && s.sync_blocked.take().is_some();
                let n = match at {
                    Some(at) => s.ingest_at(&url, &body, at),
                    None => s.ingest(&url, &body),
                };
                let progress = (url.starts_with("fct://") && s.syncing()).then(|| s.sync_progress(&url));
                (n, s.summary(), resumed, progress)
            };
            if resumed {
                notify(BridgeEvent::SyncResumed);
            }
            if let Some(p) = progress {
                notify(BridgeEvent::SyncProgress(p));
            }
            notify(BridgeEvent::Updated(summary));
            json_response(200, serde_json::json!({ "items": items }))
        }
        _ => json_response(404, serde_json::json!({ "error": "not_found" })),
    }
}
