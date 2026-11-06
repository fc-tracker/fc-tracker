import React from "react";
import ReactDOM from "react-dom/client";
import Launcher from "./Launcher";
import MissingList from "./MissingList";
import Overlay from "./Overlay";
import Toast from "./Toast";
import UiGallery from "./ui/Gallery";
import "./styles.css";
import "./frame.css";

// One bundle serves all windows: ?view=overlay (overlay), ?view=missing (missing-players list).
const view = new URLSearchParams(window.location.search).get("view");
document.documentElement.dataset.view = view === "overlay" || view === "missing" || view === "toast" ? view : "launcher";
// dev only: `?shot` = a picture for the public site (scripts/site-shots.mjs) – no coin balance, no personal numbers
if (import.meta.env.DEV && new URLSearchParams(location.search).has("shot")) document.documentElement.dataset.shot = "";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {view === "ui" && import.meta.env.DEV ? <UiGallery /> : view === "overlay" ? <Overlay /> : view === "missing" ? <MissingList /> : view === "toast" ? <Toast /> : <Launcher />}
  </React.StrictMode>,
);
