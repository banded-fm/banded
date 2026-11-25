/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Optional override for the graph database URL. Defaults to the same-origin
   * `graph.db.gz`. Set to a CDN URL (e.g. Cloudflare R2) when the host caps
   * static asset size (Cloudflare Pages' 25 MiB limit).
   */
  readonly VITE_GRAPH_DB_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Build-time graph DB CDN URL, injected by vite.config.ts `define`.
 * Empty string when not building for a CDN host (e.g. GitHub Pages / dev).
 */
declare const __GRAPH_DB_CDN_URL__: string;
/** True on Cloudflare builds: graph.db.gz and scenes.json are only on the CDN (vite.config.ts). */
declare const __ASSETS_ON_CDN__: boolean;
