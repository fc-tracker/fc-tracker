//! Local HTTP bridge between the browser extension and the app.
//!
//! Security:
//! - Listens on 127.0.0.1 only (never the network).
//! - Requests from regular websites (any non-extension Origin) are rejected, so web pages
//!   cannot push data into the app. Extension requests may arrive without an Origin header.
//! - The extension pairs once with a 6-digit code shown in the app; after that a secret
//!   token is sent in the `X-FCT-Token` header.
//! - The extension never forwards EA's session token – only response bodies.
//!
//! Protocol (v2, 2026-11): routes and fields only ever get added, never renamed or removed – the
//! extension 0.13.11 (Chrome Web Store and the .zip) must keep working with every newer app, and
//! a newer extension with the 0.1.101 app. `protocol` in `/ping` says what this app speaks:
//! - 2: `/ping` (paired) carries `account` – which FC-Tracker account the app is signed in to.
//!   A paired extension's club sync always goes to the app, and the app keeps it on its account
//!   (src/account.ts). The extension gets no token of the account – it only shows whose it is.
//!   Missing (an older app): paired still means the app owns the sync.

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
    /// The e-mail of the FC-Tracker account the app is signed in to (None = signed out).
    account: fn() -> Option<String>,
    /// The app's theme (light / dark / glass) – the paired extension's popup and badge follow it.
    theme: Option<String>,
}

pub const THEMES: [&str; 3] = ["light", "dark", "glass"];

/// The app's account (Windows Credential Manager, account.rs): only its e-mail, never the token.
fn app_account() -> Option<String> {
    let secret: Value = serde_json::from_str(&crate::account::secret()?).ok()?;
    secret.get("refresh")?;
    secret.get("email").and_then(Value::as_str).map(str::to_string)
}

/// What this app's bridge speaks (see the top).
pub const PROTOCOL: u32 = 2;

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
        Self { pairing_path, token: saved.token, pairing_code: random_code(), locale: "en".into(), extension_version: saved.extension_version, unpaired_seen: None, authorized_seen: None, account: app_account, theme: None }
    }

    /// The UI tells the bridge its theme (at start and on every change).
    pub fn set_theme(&mut self, theme: &str) -> bool {
        let ok = THEMES.contains(&theme);
        if ok {
            self.theme = Some(theme.to_string());
        }
        ok
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
    serve(server, store, bridge, notify)
}

fn serve(
    server: Server,
    store: Arc<Mutex<Store>>,
    bridge: Arc<Mutex<Bridge>>,
    notify: impl Fn(BridgeEvent) + Send + 'static,
) -> Result<(), String> {
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
            let (authorized, locale, account, theme) = {
                let mut b = bridge.lock().unwrap();
                let authorized = b.authorized(req);
                // Only extensions ping; one without our token wants to be paired.
                b.unpaired_seen = if authorized { None } else { Some(std::time::Instant::now()) };
                if authorized {
                    b.authorized_seen = Some(std::time::Instant::now());
                }
                (authorized, b.locale.clone(), b.account, b.theme.clone())
            };
            // the account only for the paired extension (it shows whose account the sync lands on)
            let account = authorized.then(account).map(|email| {
                serde_json::json!({ "signed_in": email.is_some(), "email": email })
            });
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
                    "extension_required": crate::updates::EXTENSION_REQUIRED,
                    // v2 (additions only – an older extension ignores them)
                    "protocol": PROTOCOL,
                    "account": account,
                    // null until the UI has told it (the extension then keeps dark glass)
                    "theme": theme
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

/// The bridge protocol as the extensions speak it – a real server on a free port, raw HTTP.
/// The 0.13.11 extension (Chrome Web Store and .zip) must keep working with this app, and a newer
/// extension with the 0.1.101 app: every route and field it uses is checked here.
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;

    const OLD_PING_FIELDS: [&str; 8] = ["app", "authorized", "sync_active", "abort", "synced_at", "locale", "extension_latest", "extension_required"];
    const OLD_EXT: (&str, &str) = ("X-FCT-Version", "0.13.11");
    const JSON: (&str, &str) = ("Content-Type", "application/json");

    struct Fixture {
        port: u16,
        bridge: Arc<Mutex<Bridge>>,
    }

    fn start(account: fn() -> Option<String>) -> Fixture {
        let dir = std::env::temp_dir().join(format!("fct-bridge-{}-{}", std::process::id(), random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        let store = Arc::new(Mutex::new(Store::load(dir.clone())));
        let mut b = Bridge::load(&dir);
        b.account = account;
        let bridge = Arc::new(Mutex::new(b));
        let server = Server::http(("127.0.0.1", 0)).unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        serve(server, store, bridge.clone(), |_| {}).unwrap();
        Fixture { port, bridge }
    }

    /// One request → (status, head lower-cased, JSON body).
    fn req(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: Option<Value>) -> (u16, String, Value) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let body = body.map(|b| b.to_string()).unwrap_or_default();
        let mut head = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
        for (k, v) in headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        s.write_all(format!("{head}\r\n{body}").as_bytes()).unwrap();
        let mut raw = String::new();
        s.read_to_string(&mut raw).unwrap();
        let (top, rest) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
        let status = top.split_whitespace().nth(1).unwrap().parse().unwrap();
        // the JSON is everything from the first { to the last } (tiny_http may answer chunked)
        let json = match (rest.find('{'), rest.rfind('}')) {
            (Some(a), Some(b)) => serde_json::from_str(&rest[a..=b]).unwrap_or(Value::Null),
            _ => Value::Null,
        };
        (status, top.to_ascii_lowercase(), json)
    }

    fn pair(f: &Fixture) -> String {
        let code = f.bridge.lock().unwrap().pairing_code.clone();
        let (status, _, body) = req(f.port, "POST", "/pair", &[OLD_EXT, JSON], Some(serde_json::json!({ "code": code })));
        assert_eq!(status, 200);
        body["token"].as_str().unwrap().to_string()
    }

    #[test]
    fn an_unpaired_ping_has_every_field_the_old_extension_reads() {
        let f = start(|| None);
        let (status, _, body) = req(f.port, "GET", "/ping", &[OLD_EXT], None);
        assert_eq!(status, 200);
        for k in OLD_PING_FIELDS {
            assert!(body.get(k).is_some(), "/ping lost `{k}`: {body}");
        }
        assert_eq!(body["app"], "fc-tracker");
        assert_eq!(body["authorized"], false);
        assert_eq!(body["synced_at"], Value::Null);
        assert_eq!(body["protocol"], PROTOCOL);
        // the account is only for the paired extension
        assert_eq!(body["account"], Value::Null);
        assert_eq!(body["theme"], Value::Null, "no theme until the UI told it");
        assert!(f.bridge.lock().unwrap().set_theme("light"));
        assert!(!f.bridge.lock().unwrap().set_theme("midnight"));
        let (_, _, body) = req(f.port, "GET", "/ping", &[], None);
        assert_eq!(body["theme"], "light");
        let info = f.bridge.lock().unwrap().info();
        assert!(info.needs_pairing);
        assert_eq!(info.extension_version.as_deref(), Some("0.13.11"));
    }

    #[test]
    fn pairing_then_the_paired_routes() {
        let f = start(|| Some("player@example.com".into()));
        let (status, _, body) = req(f.port, "POST", "/pair", &[JSON], Some(serde_json::json!({ "code": "nope" })));
        assert_eq!((status, body["error"].as_str()), (401, Some("wrong_code")));
        let first_code = f.bridge.lock().unwrap().pairing_code.clone();
        let token = pair(&f);
        assert_eq!(token.len(), 64);
        assert_ne!(f.bridge.lock().unwrap().pairing_code, first_code, "a used code is rotated");
        let auth = ("X-FCT-Token", token.as_str());

        let (_, _, ping) = req(f.port, "GET", "/ping", &[OLD_EXT, auth], None);
        for k in OLD_PING_FIELDS {
            assert!(ping.get(k).is_some(), "/ping lost `{k}`");
        }
        assert_eq!(ping["authorized"], true);
        assert_eq!(ping["sync_active"], false);
        assert_eq!(ping["abort"], false);
        assert_eq!(ping["account"], serde_json::json!({ "signed_in": true, "email": "player@example.com" }));
        assert!(f.bridge.lock().unwrap().info().extension_live);

        let (status, _, sets) = req(f.port, "GET", "/gallery-sets", &[auth], None);
        assert_eq!(status, 200);
        assert!(sets["sets"].as_array().is_some_and(|s| !s.is_empty() && s.iter().all(|x| x["key"].is_string())));

        let at = 1_700_000_000_000u64;
        let (status, _, r) = req(f.port, "POST", "/capture", &[auth, JSON], Some(serde_json::json!({ "url": "fct://webapp/names", "body": { "leagues": {} }, "at": at })));
        assert_eq!(status, 200);
        assert!(r["items"].is_u64());
        let (status, _, _) = req(f.port, "POST", "/sync-blocked", &[auth, JSON], Some(serde_json::json!({ "reason": "not_signed_in" })));
        assert_eq!(status, 200);
        let (status, _, summary) = req(f.port, "POST", "/sync-done", &[auth, JSON], Some(serde_json::json!({ "at": at })));
        assert_eq!(status, 200);
        assert!(summary.is_object());
    }

    #[test]
    fn a_signed_out_app_says_so_without_an_e_mail() {
        let f = start(|| None);
        let token = pair(&f);
        let (_, _, ping) = req(f.port, "GET", "/ping", &[("X-FCT-Token", &token)], None);
        assert_eq!(ping["account"], serde_json::json!({ "signed_in": false, "email": null }));
    }

    #[test]
    fn without_the_token_nothing_goes_in() {
        let f = start(|| None);
        pair(&f);
        for path in ["/capture", "/sync-done", "/sync-blocked"] {
            let (status, _, body) = req(f.port, "POST", path, &[OLD_EXT, JSON, ("X-FCT-Token", "0000")], Some(serde_json::json!({})));
            assert_eq!((status, body["error"].as_str()), (401, Some("not_paired")), "{path}");
        }
        let (status, _, _) = req(f.port, "GET", "/gallery-sets", &[], None);
        assert_eq!(status, 401);
        let (status, _, _) = req(f.port, "GET", "/nope", &[], None);
        assert_eq!(status, 404);
    }

    #[test]
    fn websites_are_refused_and_extensions_get_cors() {
        let f = start(|| None);
        let (status, _, body) = req(f.port, "GET", "/ping", &[("Origin", "https://evil.example")], None);
        assert_eq!((status, body["error"].as_str()), (403, Some("extension_only")));
        let ext = "chrome-extension://bpinmgkhbofecfagbehkmpmcnnehclem";
        let (status, head, _) = req(f.port, "OPTIONS", "/capture", &[("Origin", ext)], None);
        assert_eq!(status, 204);
        assert!(head.contains(&format!("access-control-allow-origin: {ext}")));
        assert!(head.contains("x-fct-token") && head.contains("x-fct-version"));
        assert!(head.contains("access-control-allow-private-network: true"));
        let (status, _, body) = req(f.port, "GET", "/ping", &[("Origin", ext)], None);
        assert_eq!((status, body["app"].as_str()), (200, Some("fc-tracker")));
    }
}
