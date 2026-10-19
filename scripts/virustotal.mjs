// VirusTotal scan of the release files (public API v3 – free for non-commercial use; FC-Tracker
// is a free fan tool). Used by release.mjs, or on its own for the current release:
//   node scripts/virustotal.mjs
// The API key is read from %VT_API_KEY% or %USERPROFILE%\.fc-tracker\virustotal.key – never the repo.
// The public API allows 4 requests a minute, so we poll calmly. Uploaded files become visible to
// VirusTotal's community (fine: our downloads are public anyway).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const API = "https://www.virustotal.com/api/v3";
const POLL_MS = Number(process.env.VT_POLL_MS) || 20_000; // ≤ 3 requests a minute while waiting
const TIMEOUT_MS = 15 * 60_000;

export function apiKey() {
  if (process.env.VT_API_KEY) return process.env.VT_API_KEY.trim();
  const file = path.join(os.homedir(), ".fc-tracker", "virustotal.key");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function vt(key, url, init = {}) {
  const res = await fetch(url.startsWith("http") ? url : API + url, { ...init, headers: { "x-apikey": key, ...(init.headers ?? {}) } });
  if (res.status === 429) {
    await sleep(60_000); // over the per-minute quota: wait and retry once
    return vt(key, url, init);
  }
  return res;
}

// The antivirus engines most people know – shown by name on the website when they find nothing.
export const MAJOR_ENGINES = ["Microsoft", "Kaspersky", "BitDefender", "ESET-NOD32", "Avast", "AVG", "Malwarebytes", "Sophos", "Symantec", "TrendMicro", "Google"];

// engines that answered (not "type-unsupported" / "timeout" / "failure")
const summary = (sha256, stats, date, results = {}) => ({
  // who flagged it, and what they said (often a machine-learning guess on new, unsigned files)
  flaggedBy: Object.entries(results)
    .filter(([, x]) => x.category === "malicious" || x.category === "suspicious")
    .map(([engine, x]) => ({ engine, result: x.result ?? x.category })),
  // the well-known engines that looked at the file and found nothing
  majorsClean: MAJOR_ENGINES.filter((e) => ["undetected", "harmless"].includes(results[e]?.category)),
  majorsFlagged: MAJOR_ENGINES.filter((e) => ["malicious", "suspicious"].includes(results[e]?.category)),
  sha256,
  malicious: stats.malicious ?? 0,
  suspicious: stats.suspicious ?? 0,
  engines: (stats.malicious ?? 0) + (stats.suspicious ?? 0) + (stats.undetected ?? 0) + (stats.harmless ?? 0),
  url: `https://www.virustotal.com/gui/file/${sha256}`,
  scanned: date,
});

/** Scans one file (reuses VirusTotal's result if it already knows the file). */
export async function scan(file, key = apiKey()) {
  if (!key) throw new Error("no VirusTotal API key (VT_API_KEY or ~/.fc-tracker/virustotal.key)");
  const data = fs.readFileSync(file);
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");

  const known = await vt(key, `/files/${sha256}`);
  if (known.ok) {
    const a = (await known.json()).data?.attributes;
    if (a?.last_analysis_stats && a.last_analysis_date) {
      return summary(sha256, a.last_analysis_stats, new Date(a.last_analysis_date * 1000).toISOString(), a.last_analysis_results);
    }
  }

  // Upload (≤ 32 MB through the plain endpoint – our files are a few MB).
  const form = new FormData();
  form.append("file", new Blob([data]), path.basename(file));
  const up = await vt(key, "/files", { method: "POST", body: form });
  if (!up.ok) throw new Error(`upload failed: ${up.status} ${await up.text()}`);
  const analysisId = (await up.json()).data?.id;
  const start = Date.now();
  for (;;) {
    await sleep(POLL_MS);
    const res = await vt(key, `/analyses/${analysisId}`);
    if (!res.ok) continue;
    const a = (await res.json()).data?.attributes;
    if (a?.status === "completed") return summary(sha256, a.stats ?? {}, new Date().toISOString(), a.results);
    if (Date.now() - start > TIMEOUT_MS) throw new Error("analysis not finished in 15 minutes");
    process.stdout.write(".");
  }
}

/** Scans app + extension from downloads/latest.json and writes the results into it. */
export async function scanRelease(downloadsDir, key = apiKey()) {
  const latestFile = path.join(downloadsDir, "latest.json");
  const latest = JSON.parse(fs.readFileSync(latestFile, "utf8"));
  for (const part of ["app", "ext"]) {
    if (!latest[part]) continue;
    console.log(`VirusTotal: ${latest[part].file} …`);
    latest[part].virustotal = await scan(path.join(downloadsDir, latest[part].file), key);
    const v = latest[part].virustotal;
    console.log(` ${v.malicious + v.suspicious}/${v.engines} flagged · ${v.url}`);
  }
  fs.writeFileSync(latestFile, JSON.stringify(latest, null, 2) + "\n");
  return latest;
}

// on its own: scan the current release and rebuild the site
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    await scanRelease(path.join(root, "site", "public", "downloads"));
    execFileSync(process.execPath, [path.join(root, "site", "build.mjs")], { stdio: "inherit" });
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
