const $ = (id) => document.getElementById(id);
const msg = fctI18n.t;
const send = (message) =>
  new Promise((resolve) => chrome.runtime.sendMessage(message, (res) => resolve(chrome.runtime.lastError ? null : res)));

// The last theme, before the first paint (the app's theme arrives with the ping)
try {
  document.documentElement.dataset.theme = localStorage.getItem("fct.theme") ?? "glass";
} catch {}

// Opened as a tab (the badge's "Sign in" when Chrome can't open the popup itself)
if (new URLSearchParams(location.search).has("tab")) document.documentElement.classList.add("tab");

function translatePage(locale) {
  document.documentElement.lang = locale;
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = msg(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => (el.placeholder = msg(el.dataset.i18nPlaceholder)));
}

/** An API error code as text (authError_<code>, else the generic one). */
function errorText(code) {
  const key = `authError_${code}`;
  const t = msg(key);
  return t === key ? msg("error") : t;
}

/** "3 min ago" in the app's language (Intl, no extra strings). */
function ago(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || "en", { numeric: "auto" });
  if (minutes < 60) return rtf.format(-Math.max(0, minutes), "minute");
  if (minutes < 48 * 60) return rtf.format(-Math.round(minutes / 60), "hour");
  return rtf.format(-Math.round(minutes / 1440), "day");
}

/** A named wait (every wait visible): the hero says what is happening, with the busy bar. */
function busy(text) {
  $("busy").hidden = !text;
  if (text) $("sub").textContent = text;
}

let email = "";
let codeStep = false;
let appSeen = true;
let appFailed = false;

async function refresh() {
  // Ping first: it tells the background the app's language and theme.
  const res = await send({ type: "ping" });
  const locale = await fctI18n.load();
  const [status, app] = await Promise.all([send({ type: "status" }), send({ type: "app-account" })]);
  translatePage(locale);
  const theme = status?.theme ?? "glass";
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("fct.theme", theme);
  } catch {}
  requestAnimationFrame(() => document.documentElement.classList.add("ready"));

  const running = res?.app === "fc-tracker";
  const authorized = running && !!res.authorized;
  // a saved pairing the running app doesn't know any more (reinstalled, unpaired there) is no owner
  const paired = !!status?.paired && (!running || authorized);
  const signedIn = !!status?.email;
  const owner = paired ? "app" : signedIn ? "account" : null;
  const appAccount = app?.appAccount ?? null;

  // ---- hero: who gets the club sync
  $("dot").className = `dot ${owner ? "done" : "warn"}`;
  if (owner === "app" && running) {
    $("title").textContent = msg("connected");
    $("sub").textContent = !appAccount
      ? msg("accountAppLocal")
      : appAccount.signedIn && appAccount.email
        ? msg("accountViaApp", [appAccount.email])
        : msg("accountAppSignedOut");
  } else if (owner === "app") {
    $("title").textContent = msg("stateAppClosed");
    $("sub").textContent = msg("subAppClosed");
  } else if (owner === "account") {
    $("title").textContent = msg("stateAccount");
    $("sub").textContent = status.pushPending ? msg("subAccountPending") : msg("subAccount");
  } else {
    $("title").textContent = msg("stateNone");
    $("sub").textContent = msg(running ? "subNoneApp" : "subNone");
  }
  const syncedAt = Math.max(Number(authorized ? res.synced_at ?? 0 : 0), Number(status?.lastSyncAt ?? 0));
  $("lastSync").hidden = !owner || !syncedAt;
  if (syncedAt) $("lastSync").textContent = msg("lastSync", [ago(syncedAt)]);

  // ---- pairing (the app runs here but isn't connected)
  $("pair").hidden = !running || authorized;

  // ---- account
  // paired: the hero already says whose account – the panel only when this extension is signed in too
  $("acct").hidden = owner === "app" && !signedIn;
  $("acctApp").hidden = owner !== "app";
  $("acctAppText").textContent = $("sub").textContent;
  if (owner === "app") $("acctAppText").textContent = !appAccount ? msg("accountAppLocal") : appAccount.signedIn ? msg("accountAppKeeps") : msg("accountAppSignedOut");
  $("acctChip").hidden = !owner;
  $("acctChip").className = `chip ${owner ? "done" : ""}`;
  $("acctChip").textContent = owner === "app" ? msg("chipViaApp") : owner === "account" ? msg("chipSignedIn") : "";
  $("acctIn").hidden = !signedIn;
  $("acctEmail").textContent = status?.email ?? "";
  $("acctPushed").hidden = !signedIn || !status?.pushedAt || owner !== "account";
  if (status?.pushedAt) $("acctPushed").textContent = msg("accountPushed", [ago(status.pushedAt)]);
  // the sign-in form only when nobody owns the sync (paired: the app's account is used)
  const showForm = !owner;
  $("acctEmailStep").hidden = !showForm || codeStep;
  $("acctCodeStep").hidden = !showForm || !codeStep;
  // one primary per view: the pairing code when the app runs here, else the sign-in
  const primary = $("pair").hidden ? "btn-primary" : "btn-secondary ring";
  $("sendBtn").className = `btn ${primary}`;
  $("verifyBtn").className = `btn ${primary}`;

  // ---- app buttons
  $("unpairBtn").hidden = !authorized;
  $("openAppBtn").hidden = running;
  appSeen = running || !!status?.appSeen;
  appFailed = !running && !!status?.openFailed;
  $("openAppBtn").textContent = msg(appSeen && !appFailed ? "openApp" : "getApp");
  $("error").textContent = appFailed ? msg("openFailed") : "";
  // Technical detail helps debugging connection problems: only a real answer with an error status
  if (res && !running && res.status) $("error").textContent = res.detail ?? res.error ?? `HTTP ${res.status}`;
  if (!res) $("error").textContent = msg("bgNoResponse");

  if (!$("pair").hidden) $("code").focus();
  else if (showForm && !codeStep) $("email").focus();
  else if (showForm) $("acctCode").focus();
  await showUpdate();
}

// ---------- updates: is a newer version out, and the button that gets it ----------
let updateInfo = null;
async function showUpdate() {
  updateInfo = await send({ type: "update-info" });
  if (!updateInfo) return;
  $("updateText").textContent = updateInfo.outdated ? msg("updateAvailable", [updateInfo.latest]) : msg("upToDate");
  $("updateText").className = updateInfo.outdated ? "" : "small";
  $("updateBtn").textContent = msg(updateInfo.outdated ? "updateNow" : "checkUpdates");
  $("updateBtn").className = updateInfo.outdated ? "btn btn-primary btn-s" : "btn btn-secondary btn-s ring";
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

const DOWNLOAD = "https://www.fc-tracker.com/download";
// The background opens the app and watches for it (the popup closes when a tab opens); if it
// doesn't answer, the next popup offers the download instead.
$("openAppBtn").onclick = () => (!appSeen || appFailed ? chrome.tabs.create({ url: DOWNLOAD }) : send({ type: "openApp" }));
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

// ---------- sign-in without the app: e-mail → 6-digit code (no password) ----------
$("acctEmailStep").onsubmit = async (e) => {
  e.preventDefault();
  email = $("email").value.trim();
  if (!email) return $("email").focus();
  $("error").textContent = "";
  $("sendBtn").disabled = true;
  busy(msg("sendingCode"));
  const res = await send({ type: "auth-start", email });
  busy(null);
  $("sendBtn").disabled = false;
  if (!res?.ok) {
    await refresh();
    $("error").textContent = errorText(res?.error);
    return;
  }
  codeStep = true;
  $("codeSent").textContent = msg("codeSentTo", [email]);
  await refresh();
};

$("acctCodeStep").onsubmit = async (e) => {
  e.preventDefault();
  const code = $("acctCode").value.replace(/\D/g, "");
  if (code.length !== 6) return $("acctCode").focus();
  $("error").textContent = "";
  $("verifyBtn").disabled = true;
  busy(msg("verifying"));
  const res = await send({ type: "auth-verify", email, code });
  busy(null);
  $("verifyBtn").disabled = false;
  if (!res?.ok) {
    await refresh();
    $("error").textContent = errorText(res?.error);
    return;
  }
  codeStep = false;
  $("acctCode").value = "";
  await refresh();
};

$("otherEmailBtn").onclick = () => {
  codeStep = false;
  $("acctCode").value = "";
  refresh();
};

$("signOutBtn").onclick = async () => {
  busy(msg("signingOut"));
  await send({ type: "sign-out" });
  busy(null);
  refresh();
};

refresh();
