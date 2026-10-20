// FC-Tracker Web (fc-tracker.com/web): the real overlay and side panel, fed by reading the game
// from a shared window, tab or capture card in this tab. Built with `npm run build:web`.
import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/manrope/800.css";
import { LOCALES, setLocale, t, type Locale } from "../i18n";
import WebApp from "./WebApp";
import { browserPad } from "../browserPad";
import * as backend from "./backend";
import { setWebBackend } from "../api";
import { initUsage, startPresence, track } from "../usage";
import * as reader from "./reader";
import "../overlay.css";
import "./web.css";

const lang = new URLSearchParams(location.search).get("lang");
if (lang && lang in LOCALES) setLocale(lang as Locale);
document.documentElement.dataset.view = "overlay";
document.documentElement.classList.add("web");
document.title = t("web.title");
setWebBackend(backend);
initUsage("web", "web");
track(null);
track("web-start");
startPresence("web");
browserPad.requireFocus(true);
// local testing only: feed a picture instead of a shared screen
if (location.hostname === "localhost") Object.assign(window, { __fctWeb: { attach: backend.attach, reader } });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WebApp />
  </React.StrictMode>,
);
