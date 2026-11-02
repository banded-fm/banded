import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // Is this a Cloudflare build? Workers Builds sets WORKERS_CI=1; Cloudflare
  // Pages sets CF_PAGES. Either way, Cloudflare serves at the domain root.
  const isCloudflareBuild = Boolean(process.env.WORKERS_CI || process.env.CF_PAGES);

  // Base path precedence:
  //   1. Explicit DEPLOY_BASE env var (manual override, any host).
  //   2. Cloudflare build → "/" (workers.dev / pages.dev serve at root).
  //   3. GitHub Pages production default → "/banded/".
  //   4. Local dev → "/".
  const base =
    process.env.DEPLOY_BASE ??
    (isCloudflareBuild ? "/" : mode === "production" ? "/banded/" : "/");

  // CDN URL for the graph DB. Cloudflare's static-assets-only Worker can't hold
  // env vars, so we can't rely on VITE_GRAPH_DB_URL being set there. Instead,
  // default to the R2 bucket's custom domain on Cloudflare builds (cached by
  // Cloudflare; the bucket's r2.dev URL is off). An explicit VITE_GRAPH_DB_URL
  // env var still overrides.
  const CLOUDFLARE_R2_GRAPH_URL = "https://cdn.banded.fm/graph.db.gz";
  const graphDbCdnUrl =
    process.env.VITE_GRAPH_DB_URL ?? (isCloudflareBuild ? CLOUDFLARE_R2_GRAPH_URL : "");

  return {
    plugins: [react()],
    base,
    define: {
      // Inlined at build; read in src/db/graphDb.ts.
      __GRAPH_DB_CDN_URL__: JSON.stringify(graphDbCdnUrl),
    },
  };
});
