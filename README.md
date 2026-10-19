# FC-Tracker

A Windows companion for the EA SPORTS FC 27 Ultimate Team Gallery. It reads the Gallery screens you
open in the game and shows, on top of the game, the best selection for each set, the swaps that gain
points and the cards worth buying next.

This repository is the full source code of the app and its Chrome extension, published so anyone can
check what it does. It is **source-available, not open source**: you may read it, build it and use it
for yourself, but not copy, change and redistribute it (see [License](#license)).

FC-Tracker is an independent fan project. It is not affiliated with, endorsed or sponsored by
Electronic Arts Inc. EA SPORTS FC and Ultimate Team are trademarks of Electronic Arts Inc.

## What it does – and what it never does

Everything below can be checked in the code; the file is named for each point.

**The app (Windows, Tauri: Rust + React)**

- **Reads the screen, nothing else.** In the game's menus it looks at the game window the way a
  recording program does (Windows Graphics Capture, `src-tauri/src/watch.rs`, `src-tauri/src/wgc.rs`)
  and recognises text and numbers on it (`src-tauri/src/scan.rs`). It never opens the game process,
  reads its memory, injects code or touches its network traffic. During a match it reads no pages –
  it only takes one small look every few seconds to notice when you are back in the menus.
- **Saves no pictures or video.** Each picture is read in memory and dropped. Pictures are only saved
  if you switch on *Settings → Diagnostics* yourself: then for 30 minutes, on your own PC
  (`src-tauri/src/diag.rs`).
- **Keeps your data on your PC.** Your club and Gallery data are stored in
  `%APPDATA%\dk.fctracker.app\` and nowhere else. There is no account and no FC-Tracker server with
  your data (`src-tauri/src/store.rs`).
- **Never asks for your EA login.** The app has no login and never sees your EA password or session.
- **Network connections – the complete list:**
  - `https://www.fc-tracker.com/updates/latest.json` – the update check, and the update download from
    fc-tracker.com when you accept one. Updates are signed; the app only installs files signed with the
    project's key (`src-tauri/tauri.conf.json`, `plugins.updater`).
  - `127.0.0.1` (your own PC only) – the bridge the Chrome extension talks to
    (`src-tauri/src/bridge.rs`). It never listens on the network.
  - Links you click (the EA Web App, fc-tracker.com, the support page) open in your normal browser.

**The Chrome extension (optional, for the club sync)**

- Runs only on the EA Web App page (`extension/manifest.json`).
- **During a sync it is active:** it pages through your club with the Web App's own club search – the
  same requests the Club screen makes when you scroll through it – and reads the Gallery card list for
  each league set the same way. One page at a time, about one a second, and it stops when nothing new
  comes (`extension/hook.js`). Outside a sync it only reads what the Web App loads anyway.
- Never searches the transfer market, and never buys, sells, bids or lists anything. Prices come only
  from EA's own market average in your club data.
- Sends that data only to the FC-Tracker app on your own PC, `127.0.0.1` (`extension/background.js`,
  `extension/relay.js`). It never sends anything to any other server.
- Never reads, stores or sends your EA login, session or token – responses from login and token
  endpoints are dropped before anything is read (`BLOCKED`, `SECRET_KEYS` in `extension/hook.js`).

**Your account.** FC-Tracker is an unofficial tool: it is not endorsed by EA, and EA's terms apply to
your account. The app itself only looks at your screen. The sync is the part EA's servers see –
requests from your browser, like clicking through your club – which is why it is kept slow and short.
If you would rather not use it, skip the extension: the app then works from what it sees in the game
(it only knows the cards it has seen on your screen).

If you find anything in the code that contradicts this list, please open an issue – see
[SECURITY.md](SECURITY.md).

## Download

Official builds only come from **https://www.fc-tracker.com/download** and this repository's
**Releases** page. Each release lists its SHA-256 and a VirusTotal scan. A copy from anywhere else is
not ours.

## Build it yourself

Requirements: Windows 10/11, Node 22+, Rust stable, Visual Studio C++ Build Tools.

```bash
npm install
npm run tauri build
```

The installer lands in `src-tauri/target/release/bundle/nsis/`. A build you make yourself is unsigned
and does not receive updates – that is expected. The extension can be loaded unpacked from
`extension/` in `chrome://extensions` (Developer mode).

Tests: `cd src-tauri && cargo test`, type check: `npx tsc --noEmit`.

## License

[PolyForm Strict License 1.0.0](LICENSE). In short: you may use the software and read and build the
source for any noncommercial purpose (personal use, study, research). You may **not** distribute it,
change it or make new works based on it. The name FC-Tracker and the fc-tracker.com domain are not
licensed. For anything else, ask: hello@fc-tracker.com.
