const $ = (id) => document.getElementById(id);
const msg = fctI18n.t;
const send = (message) =>
  new Promise((resolve) => chrome.runtime.sendMessage(message, (res) => resolve(chrome.runtime.lastError ? null : res)));

function translatePage(locale) {
  document.documentElement.lang = locale;
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = msg(el.dataset.i18n)));
}

async function refresh() {
  // Ping first: it tells the background which language the app uses.
  const res = await send({ type: "ping" });
  translatePage(await fctI18n.load());

  const running = res && res.app === "fc-tracker";
  const authorized = running && res.authorized;
  $("dot").classList.toggle("on", !!authorized);
  $("status").textContent = msg(!res ? "bgNoResponse" : !running ? "appNotRunning" : authorized ? "connected" : "notConnected");
  // Technical detail helps debugging connection problems.
  // "app not running" says it all; only a real answer with an error status is worth showing
  $("error").textContent = res && !running && res.status ? res.detail ?? res.error ?? `HTTP ${res.status}` : "";
  $("pair").hidden = !running || authorized;
  $("unpairBtn").hidden = !authorized;
  $("openAppBtn").hidden = !!running;
  const syncedAt = Number(res?.synced_at ?? 0);
  $("lastSync").hidden = !authorized || !syncedAt;
  if (syncedAt) $("lastSync").textContent = msg("lastSync", [ago(syncedAt)]);
  if (running && !authorized) $("code").focus();
  await showUpdate();
}

/** "3 min ago" in the app's language (Intl, no extra strings). */
function ago(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || "en", { numeric: "auto" });
  if (minutes < 60) return rtf.format(-Math.max(0, minutes), "minute");
  if (minutes < 48 * 60) return rtf.format(-Math.round(minutes / 60), "hour");
  return rtf.format(-Math.round(minutes / 1440), "day");
}

// ---------- updates: is a newer version out, and the button that gets it ----------
let updateInfo = null;
async function showUpdate() {
  updateInfo = await send({ type: "update-info" });
  if (!updateInfo) return;
  $("update").classList.toggle("new", !!updateInfo.outdated);
  $("updateText").innerHTML = "";
  const line = document.createElement("span");
  line.textContent = updateInfo.outdated ? msg("updateAvailable", [updateInfo.latest]) : msg("upToDate");
  if (updateInfo.outdated) {
    const b = document.createElement("b");
    b.textContent = line.textContent;
    $("updateText").append(b);
  } else {
    $("updateText").append(line);
  }
  $("updateBtn").textContent = msg(updateInfo.outdated ? "updateNow" : "checkUpdates");
  $("updateBtn").className = updateInfo.outdated ? "update-btn" : "secondary";
}

$("updateBtn").onclick = async () => {
  const result = $("updateResult");
  result.hidden = false;
  if (updateInfo?.installType && updateInfo.installType !== "normal") {
    // installed from the .zip: Chrome can't update it – the download page has the new one
    result.textContent = msg("updateManual");
    chrome.tabs.create({ url: "https://www.fc-tracker.com/download" });
    return;
  }
  result.textContent = msg("updateChecking");
  const res = await send({ type: "update-check" });
  const key = {
    update_available: "updateInstalling",
    no_update: updateInfo?.outdated ? "updateRollingOut" : "upToDateChecked",
    throttled: "updateThrottled",
  }[res?.status] ?? "updateFailed";
  result.textContent = msg(key);
};

$("openAppBtn").onclick = () => chrome.tabs.create({ url: "fctracker://open" });
// FC-Tracker Web, told which extension this is (a copy from the .zip has its own id)
$("openWebBtn").onclick = () => chrome.tabs.create({ url: `https://www.fc-tracker.com/web?ext=${chrome.runtime.id}` });

// Shown so it is easy to confirm that a reload picked up the latest version.
$("version").textContent = `v${chrome.runtime.getManifest().version}`;

$("pairBtn").onclick = async () => {
  $("error").textContent = "";
  const res = await send({ type: "pair", code: $("code").value.trim() });
  const pairError = res?.ok ? "" : msg(res?.error === "wrong_code" ? "wrongCode" : "error");
  await refresh();
  if (pairError) $("error").textContent = pairError;
};
$("code").addEventListener("keydown", (e) => e.key === "Enter" && $("pairBtn").click());

$("unpairBtn").onclick = async () => {
  await send({ type: "unpair" });
  refresh();
};

refresh();
