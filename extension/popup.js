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
  $("error").textContent = res && !running ? res.detail ?? res.error ?? `HTTP ${res.status}` : "";
  $("pair").hidden = !running || authorized;
  $("unpairBtn").hidden = !authorized;
  if (running && !authorized) $("code").focus();
}

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
