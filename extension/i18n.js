// Shared by popup.js and relay.js. Translations come from the background worker, which
// follows the app's language (English by default) instead of Chrome's UI language.
// Message format is Chrome's _locales format: "$NAME$" placeholders mapped to "$1", "$2", …
const fctI18n = (() => {
  let table = {};

  function format(key, subs = []) {
    const entry = table[key];
    if (!entry) return key;
    let text = entry.message;
    for (const [name, { content }] of Object.entries(entry.placeholders ?? {})) {
      const value = content.replace(/\$(\d)/g, (_, i) => subs[Number(i) - 1] ?? "");
      text = text.replace(new RegExp(`\\$${name}\\$`, "gi"), value);
    }
    return text;
  }

  function load() {
    return new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "i18n" }, (res) => {
        if (!chrome.runtime.lastError && res?.messages) table = res.messages;
        resolve(res?.locale ?? "en");
      }),
    );
  }

  return { load, t: format };
})();
