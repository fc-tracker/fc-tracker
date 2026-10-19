import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/manrope/800.css";
import Launcher from "./Launcher";
import MissingList from "./MissingList";
import Overlay from "./Overlay";
import Toast from "./Toast";
import "./styles.css";

// One bundle serves all windows: ?view=overlay (overlay), ?view=missing (missing-players list).
const view = new URLSearchParams(window.location.search).get("view");
document.documentElement.dataset.view = view === "overlay" || view === "missing" || view === "toast" ? view : "launcher";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {view === "overlay" ? <Overlay /> : view === "missing" ? <MissingList /> : view === "toast" ? <Toast /> : <Launcher />}
  </React.StrictMode>,
);
