# FC-Tracker

A Windows companion for EA SPORTS FC 27 Ultimate Team. It reads the Gallery screens you open in the
game and shows, on top of the game, the best selection for each set, the swaps that gain points and
the cards worth buying next – and its Champions tracker (beta, off until you switch it on) records
your FUT Champions matches.

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
  reads its memory, injects code or touches its network traffic. During a match it reads no pages.
  The only exception is the **Champions tracker (beta)**, and only in Champions matches: one small
  look at the scoreboard a second (score and clock) and the result screens right after full time
  (`src-tauri/src/champions.rs`). It is off until you switch it on in *Settings → Champions
  tracker* (and off again any time, even mid-match); without it, one look every few seconds notices
  when you are back in the menus.
- **Champions matches stay on your PC.** What the tracker reads (results, scores, the opponent's club,
  record and gamertag) is kept in `%APPDATA%\dk.fctracker.app\champions.json` and is never sent
  anywhere. Only if you join the **Champions leaderboard** yourself (*Settings → Champions
  leaderboard*, a name you pick) does the app send your own weekend – wins, losses, goals, rank, and
  each of your matches' result, score, extra time / lost connection and goal minutes – to `https://www.fc-tracker.com/api/champions` (`src/championsBoard.ts`,
  `site/api/champions.mjs`). Never an opponent, never a gamertag read from the screen.
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
  - `https://cloud.umami.is/api/send` – anonymous usage counts (`src/usage.ts`): that the app was
    started, that it is still in use (every two hours) and the first time setup steps are reached
    (extension connected, first sync, first set read), with the app version and a random number
    made on your PC so one installation counts once. Never your club, players or EA account.
    Off in *Settings → Anonymous usage statistics*.
  - `https://www.fc-tracker.com/api/beat` – while the app runs, every 15 minutes: the same random
    number, the app version and "app". It gives the "online now" count and how many installations
    are in use; what is kept is listed in `site/api/_presence.mjs` on the website (ids only, no IP).
    The same setting turns it off.
  - `https://www.fc-tracker.com/api/prices` – the shared price pool. EA sends its own market
    average with your club cards and your own market searches, but never with the Gallery card
    lists, so a card you lack has no price until someone has seen it. Every 30 minutes the app sends
    the averages it saw – card id, price, when, and whether you're on the PC or the console market –
    and downloads the pool of your market back (`src/prices.ts`, `site/api/prices.mjs`). No id,
    no club, no account. Sending follows the same setting; the download is always on.
  - `127.0.0.1` (your own PC only) – the bridge the Chrome extension talks to
    (`src-tauri/src/bridge.rs`). It never listens on the network.
  - Links you click (the EA Web App, fc-tracker.com, the support page) open in your normal browser.

**The Chrome extension (optional, for the club sync)**

- Runs only on the EA Web App page (`extension/manifest.json`).
- **During a sync it is active:** it pages through your club with the Web App's own club search – the
  same requests the Club screen makes when you scroll through it – and reads the Gallery card list for
  each league set the same way. One page at a time, about one a second, and it stops when nothing new
  comes (`extension/hook.js`). It also opens the Web App's other screens the same way – SBCs,
  objectives, season pass, Champions / Rivals / Squad Battles, leaderboards, evolutions, squads and
  the store – to show where cards come from (SBC and objective rewards), your club record and
  player stats. Read only: it never claims, submits, buys or bids. The club, the Gallery and these
  screens run side by side (three calm lanes, each about one request a second). Outside a sync it
  only reads what the Web App loads anyway.
- Never searches the transfer market, and never buys, sells, bids or lists anything. Prices come only
  from EA's own market average in your club data.
- Sends that data only to the FC-Tracker app on your own PC, `127.0.0.1` (`extension/background.js`,
  `extension/relay.js`) – or, if you use FC-Tracker Web (fc-tracker.com/web), keeps the last sync
  in the extension and hands it to that page in your own browser when it asks (only fc-tracker.com
  may ask: `externally_connectable` in `extension/manifest.json`; the page keeps it in the browser).
  It never sends anything to any server.
- Never reads, stores or sends your EA login, session or token – responses from login and token
  endpoints are dropped before anything is read (`BLOCKED`, `SECRET_KEYS` in `extension/hook.js`).

**Your account.** The optional sync pages through your club in EA's Web App (like scrolling it
yourself, about one page a second). It's an unofficial tool, so EA's terms apply. FC-Tracker is not
endorsed by EA. The app itself only looks at your screen. The sync is the part EA's servers see –
requests from your browser, like clicking through your club – which is why it is kept slow and short.
If you would rather not use it, skip the extension: the app then works from what it sees in the game
(it only knows the cards it has seen on your screen).

If you find anything in the code that contradicts this list, please open an issue – see
[SECURITY.md](SECURITY.md).

## Download

Official builds only come from **https://www.fc-tracker.com/download** and this repository's
**Releases** page. A copy from anywhere else is not ours. The releases here are exactly the versions
the app updates itself to.

Every release is **built by GitHub from its tag in this repository** (`.github/workflows/release.yml`),
not on anyone's PC, and each file gets a build attestation. Check a download yourself:

```bash
gh attestation verify FC-Tracker-setup-<version>.exe --repo fc-tracker/fc-tracker
```

It confirms the file was built from this code, by that workflow, at that tag. The only step after the
build is the in-app updater's signature, added by the project's key; it does not change the installer.

## FC-Tracker Web

A browser version at **https://www.fc-tracker.com/web** – nothing to install. You share the game
window, an Xbox Cloud tab or a capture card (PlayStation / Xbox) with the page; it reads your Gallery
screens in the tab with the same model as the app (`web-core/` builds the app's own Rust files for
WebAssembly, `src/web/`). What it reads stays in your browser. It is slower than the app and has no
overlay on top of the game. The club sync works there too, through the extension below.

## Install the extension yourself

While a new version waits for the Chrome Web Store review, load it from the `.zip` (the download page,
or this repository's Releases) or from the `extension/` folder of this repository:

1. Unzip it into a folder you keep.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Turn off an older FC-Tracker extension, if you have one.
4. **Load unpacked** → choose the folder.
5. Click the FC-Tracker icon: **Open FC-Tracker Web** – or connect it to the app with the code the
   app shows.

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
