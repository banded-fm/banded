import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { preloadDb } from "./db/graphDb";
import { reloadForNewVersion } from "./staleVersion";
import "./index.css";

// A file of the app failed to load (Vite's event for its dynamic imports): most likely a deploy replaced it since
// this tab opened, so reload to get the new version (once; see staleVersion.ts). Otherwise the page's error shows.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadForNewVersion()) event.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Download the graph database in the background once the first screen is up,
// instead of making pages wait for it (see src/db/graphSource.ts).
if ("requestIdleCallback" in window) {
  window.requestIdleCallback(preloadDb, { timeout: 2000 });
} else {
  setTimeout(preloadDb, 0);
}
