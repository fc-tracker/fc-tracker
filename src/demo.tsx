// The website demo (fc-tracker.com, iframe at /demo/): the real overlay with sample data on a
// drawn stand-in for the game screen. Built with `npm run build:demo`; never part of the app.
import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/manrope/800.css";
import { LOCALES, setLocale, type Locale } from "./i18n";
import DemoPad from "./DemoPad";
import Overlay from "./Overlay";
import { THEMES } from "./theme";
import "./demo.css";

const params = new URLSearchParams(location.search);
const lang = params.get("lang");
if (lang && lang in LOCALES) setLocale(lang as Locale);
const theme = params.get("theme");
if (theme && (THEMES as readonly string[]).includes(theme)) {
  try {
    localStorage.setItem("fct.theme", theme);
  } catch {}
}
// ?section=champions opens that tab (the Champions page); otherwise Sets – the demo never
// remembers a tab from an earlier visit
try {
  localStorage.setItem("fct.section", params.get("section") ?? "sets");
} catch {}
document.documentElement.dataset.view = "overlay";
document.documentElement.classList.add("demo");

// The site's theme buttons switch the overlay theme live.
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  if (e.data?.type === "fct-theme" && (THEMES as readonly string[]).includes(e.data.theme)) {
    try {
      localStorage.setItem("fct.theme", e.data.theme);
    } catch {}
    window.dispatchEvent(new Event("fct-theme-change"));
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Overlay />
    <DemoPad />
  </React.StrictMode>,
);
