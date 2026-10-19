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

**The Chrome extension (optional)**

- Runs only on the EA Web App page (`extension/manifest.json`) and reads the club and Gallery data the
  Web App itself loads (`extension/hook.js`).
- Sends that data only to the FC-Tracker app on your own PC, `127.0.0.1` (`extension/background.js`,
  `extension/relay.js`). It never sends anything to any other server.
- Never reads, stores or sends your EA login, session or token.
- Never buys, sells, bids or searches the market.

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
