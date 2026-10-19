// Puts a release on the website – one command:
//   node scripts/release.mjs            (builds, signs and publishes into site/)
//   node scripts/release.mjs --no-build (reuses the last build)
// 1. Builds the NSIS installer, signed for the in-app updater with the private key in
//    %USERPROFILE%\.tauri\fc-tracker-updater.key (never in the repo – back it up: without it,
//    installed apps can't be updated any more).
// 2. Copies the installer and a zip of the extension into site/public/downloads (older builds
//    are removed) and writes downloads/latest.json (version, size, sha256) for the website.
// 3. Writes updates/latest.json – the feed installed apps check (tauri-plugin-updater).
// 4. Points the stable links /download/windows and /download/extension at the new files.
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
if (!process.argv.includes("--no-build")) {
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

const installer = path.join(root, "src-tauri", "target", "release", "bundle", "nsis", `${conf.productName}_${conf.version}_x64-setup.exe`);
for (const f of [installer, `${installer}.sig`]) {
  if (!fs.existsSync(f)) {
    console.error(`missing ${path.relative(root, f)} – build first (without --no-build)`);
    process.exit(1);
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const appFile = `FC-Tracker-setup-${conf.version}.exe`;
fs.copyFileSync(installer, path.join(out, appFile));

// The extension folder as a zip (its contents at the zip's top level → "Load unpacked" on the
// unzipped folder works directly). Windows tar writes standard zips with / paths.
const extFile = `FC-Tracker-extension-${ext.version}.zip`;
const extDir = path.join(root, "extension");
const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
execFileSync(tar, ["-a", "-c", "-f", path.join(out, extFile), ...fs.readdirSync(extDir)], { cwd: extDir });

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
const feed = {
  version: conf.version,
  pub_date: now.toISOString(),
  platforms: {
    "windows-x86_64": { signature: fs.readFileSync(`${installer}.sig`, "utf8").trim(), url: `${SITE}/downloads/${appFile}` },
  },
};
fs.writeFileSync(path.join(pub, "updates", "latest.json"), JSON.stringify(feed, null, 2) + "\n");

// Stable links that always give the newest files.
const vercelFile = path.join(root, "site", "vercel.json");
const vercel = JSON.parse(fs.readFileSync(vercelFile, "utf8"));
vercel.redirects = [
  // one address for Google: fc-tracker.com → www (canonical links already point to www)
  // "/:path*" does not match the root itself, so "/" gets its own rule
  { source: "/", has: [{ type: "host", value: "fc-tracker.com" }], destination: "https://www.fc-tracker.com/", permanent: true },
  { source: "/:path*", has: [{ type: "host", value: "fc-tracker.com" }], destination: "https://www.fc-tracker.com/:path*", permanent: true },
  { source: "/support", destination: "https://ko-fi.com/fctracker", permanent: false },
  { source: "/download/windows", destination: `/downloads/${appFile}`, permanent: false },
  // the extension lives in the Chrome Web Store (the zip stays in /downloads for Edge-only setups)
  { source: "/download/extension", destination: "https://chromewebstore.google.com/detail/fc-tracker/bpinmgkhbofecfagbehkmpmcnnehclem", permanent: false },
  // analytics.fc-tracker.com → the Umami dashboard (Umami's own login keeps it private)
  { source: "/:path*", has: [{ type: "host", value: "analytics.fc-tracker.com" }], destination: "https://cloud.umami.is/analytics/eu/websites/a5548dcf-cd54-4723-ac06-c871f6718a5a", permanent: false },
];
fs.writeFileSync(vercelFile, JSON.stringify(vercel, null, 2) + "\n");

console.log(latest);
execFileSync(process.execPath, [path.join(root, "site", "build.mjs")], { stdio: "inherit" });
