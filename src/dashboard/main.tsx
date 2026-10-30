// The FC-Tracker dashboard (fc-tracker.com/dashboard, dashboard.fc-tracker.com): everything the
// account holds, on any device – built with FC-Tracker Web (`npm run build:web`), the same model
// (WebAssembly) and components, fed by the account's synced data instead of a shared screen.
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
import * as backend from "../web/backend";
import { setWebBackend } from "../api";
import { initUsage, track } from "../usage";
import { startPrices } from "../prices";
import { startGallerySets } from "../gallerySets";
import { startAccount, syncSoon } from "../account";
import Dashboard from "./Dashboard";
import "../overlay.css";
import "../web/web.css";
import "../frame.css";
import "./dashboard.css";

const lang = new URLSearchParams(location.search).get("lang");
if (lang && lang in LOCALES) setLocale(lang as Locale);
document.documentElement.dataset.view = "overlay";
document.documentElement.classList.add("web", "dash-page");
document.title = t("dash.title");
setWebBackend(backend);
initUsage("web", "web");
track("dashboard-start");
startPrices();
startGallerySets();
void startAccount();
backend.onClubSynced(() => syncSoon(2_000));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Dashboard />
  </React.StrictMode>,
);
