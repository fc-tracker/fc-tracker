// Puts a release on the website – one command:
//   node scripts/release.mjs --from-github (the normal way, run by scripts/ship.mjs: takes the
//                                           installer and extension GitHub built and attested from
//                                           the public tag, and signs it for the updater here)
//   node scripts/release.mjs               (builds on this PC – only for a local test release)
//   node scripts/release.mjs --no-build    (reuses the last local build)
//   … --required                            (this release must be installed: older apps show
//                                            "Update required"; see scripts/require-update.mjs)
// 1. Builds the NSIS installer, signed for the in-app updater with the private key in
//    %USERPROFILE%\.tauri\fc-tracker-updater.key (never in the repo – back it up: without it,
//    installed apps can't be updated any more).
// 2. Copies the installer and a zip of the extension into site/public/downloads (older builds
//    are removed) and writes downloads/latest.json (version, size, sha256) for the website. These
//    are the files the in-app updater fetches – the download button never changes with a release:
//    it gives the fixed site/public/installer/FC-Tracker-Installer.exe (scripts/pin-installer.mjs).
// 3. Writes updates/feed.json – the feed installed apps check (tauri-plugin-updater) at
//    updates/latest.json, which site/api/update-feed.mjs serves and counts.
// 4. Writes the stable links /download/windows (the fixed installer) and /download/extension.
// 5. Scans both files on VirusTotal when an API key is set (scripts/virustotal.mjs) – the
//    website shows the result and links the report. Without a key the release goes out unscanned.
// Then commit and push: Vercel deploys, and installed apps offer the update.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { apiKey, scanRelease } from "./virustotal.mjs";

const SITE = "https://www.fc-tracker.com";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "site", "public");
const out = path.join(pub, "downloads");
const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const ext = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));

const keyFile = path.join(os.homedir(), ".tauri", "fc-tracker-updater.key");
const fromGithub = process.argv.includes("--from-github");
if (!fromGithub && !process.argv.includes("--no-build")) {
  if (!fs.existsSync(keyFile)) {
    console.error(`missing updater key ${keyFile}`);
    process.exit(1);
  }
  execSync("npm run tauri build", {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(keyFile, "utf8"), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" },
  });
}

const appFile = `FC-Tracker-setup-${conf.version}.exe`;
const extFile = `FC-Tracker-extension-${ext.version}.zip`;
let signature;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

if (fromGithub) {
  // the files GitHub built from the public tag (attested there) – byte for byte what people get
  if (!fs.existsSync(keyFile)) {
    console.error(`missing updater key ${keyFile}`);
    process.exit(1);
  }
  const base = `https://github.com/fc-tracker/fc-tracker/releases/download/v${conf.version}`;
  for (const file of [appFile, extFile]) {
    const r = await fetch(`${base}/${file}`);
    if (!r.ok) {
      console.error(`${file} is not on the GitHub release v${conf.version} (HTTP ${r.status}) – run scripts/publish-public.mjs first`);
      process.exit(1);
    }
    fs.writeFileSync(path.join(out, file), Buffer.from(await r.arrayBuffer()));
  }
  // the in-app updater signature, made here with the key that never leaves this PC
  execSync(`npx tauri signer sign -f "${keyFile}" "${path.join(out, appFile)}"`, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" },
  });
  const sigFile = path.join(out, `${appFile}.sig`);
  signature = fs.readFileSync(sigFile, "utf8").trim();
  fs.rmSync(sigFile);
} else {
  const installer = path.join(root, "src-tauri", "target", "release", "bundle", "nsis", `${conf.productName}_${conf.version}_x64-setup.exe`);
  for (const f of [installer, `${installer}.sig`]) {
    if (!fs.existsSync(f)) {
      console.error(`missing ${path.relative(root, f)} – build first (without --no-build)`);
      process.exit(1);
    }
  }
  fs.copyFileSync(installer, path.join(out, appFile));
  signature = fs.readFileSync(`${installer}.sig`, "utf8").trim();
  // The extension folder as a zip (its contents at the zip's top level → "Load unpacked" on the
  // unzipped folder works directly). Windows tar writes standard zips with / paths.
  const extDir = path.join(root, "extension");
  const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-a", "-c", "-f", path.join(out, extFile), ...fs.readdirSync(extDir)], { cwd: extDir });
}

const info = (file) => {
  const data = fs.readFileSync(path.join(out, file));
  return { file, size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
};
const now = new Date();
const latest = {
  version: conf.version,
  released: now.toISOString().slice(0, 10),
  app: info(appFile),
  ext: { ...info(extFile), version: ext.version },
};
fs.writeFileSync(path.join(out, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
if (apiKey()) {
  try {
    Object.assign(latest, await scanRelease(out));
  } catch (e) {
    console.warn(`VirusTotal skipped: ${e.message ?? e} (run node scripts/virustotal.mjs later)`);
  }
} else {
  console.warn("VirusTotal skipped: no API key (VT_API_KEY or ~/.fc-tracker/virustotal.key)");
}

// The updater feed: the installer's minisign signature is checked by the app before it runs.
fs.mkdirSync(path.join(pub, "updates"), { recursive: true });
// `required`: the oldest app that may keep running (--required = this release must be installed).
// `extension`: the extension this release goes with – the feed holds the release back until the
// Chrome Web Store has accepted it (site/api/update-feed.mjs), so app and extension arrive together.
const oldFeed = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(pub, "updates", "feed.json"), "utf8"));
  } catch {
    return {};
  }
})();
const required = process.argv.includes("--required") ? conf.version : oldFeed.required;
const feed = {
  version: conf.version,
  ...(required ? { required } : {}),
  extension: ext.version,
  pub_date: now.toISOString(),
  platforms: {
    "windows-x86_64": { signature, url: `${SITE}/downloads/${appFile}` },
  },
};
fs.writeFileSync(path.join(pub, "updates", "feed.json"), JSON.stringify(feed, null, 2) + "\n");

// Stable links that always give the newest files.
const vercelFile = path.join(root, "site", "vercel.json");
const vercel = JSON.parse(fs.readFileSync(vercelFile, "utf8"));
vercel.redirects = [
  // dashboard.fc-tracker.com → the dashboard on the main site (a file there would win over a rewrite)
  { source: "/", has: [{ type: "host", value: "dashboard.fc-tracker.com" }], destination: "https://www.fc-tracker.com/dashboard", permanent: false },
  { source: "/:path*", has: [{ type: "host", value: "dashboard.fc-tracker.com" }], destination: "https://www.fc-tracker.com/dashboard", permanent: false },
  // one address for Google: fc-tracker.com → www (canonical links already point to www)
  // "/:path*" does not match the root itself, so "/" gets its own rule
  { source: "/", has: [{ type: "host", value: "fc-tracker.com" }], destination: "https://www.fc-tracker.com/", permanent: true },
  { source: "/:path*", has: [{ type: "host", value: "fc-tracker.com" }], destination: "https://www.fc-tracker.com/:path*", permanent: true },
  { source: "/support", destination: "https://ko-fi.com/fctracker", permanent: false },
  // the public source code (source-available, PolyForm Strict)
  { source: "/source", destination: "https://github.com/fc-tracker/fc-tracker", permanent: false },
  // the fixed installer Chrome already knows – never the new release file (see pin-installer.mjs)
  { source: "/download/windows", destination: "/installer/FC-Tracker-Installer.exe", permanent: false },
  // the extension .zip as GitHub built it from the public tag (attested)
  { source: "/download/extension-zip", destination: `https://github.com/fc-tracker/fc-tracker/releases/download/v${conf.version}/${extFile}`, permanent: false },
  // the extension lives in the Chrome Web Store (the zip stays in /downloads for Edge-only setups)
  { source: "/download/extension", destination: "https://chromewebstore.google.com/detail/fc-tracker/bpinmgkhbofecfagbehkmpmcnnehclem", permanent: false },
  // analytics.fc-tracker.com → the Umami dashboard (Umami's own login keeps it private)
  { source: "/:path*", has: [{ type: "host", value: "analytics.fc-tracker.com" }], destination: "https://cloud.umami.is/analytics/eu/websites/a5548dcf-cd54-4723-ac06-c871f6718a5a", permanent: false },
];
fs.writeFileSync(vercelFile, JSON.stringify(vercel, null, 2) + "\n");

console.log(latest);
execFileSync(process.execPath, [path.join(root, "site", "build.mjs")], { stdio: "inherit" });
