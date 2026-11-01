# Hosting the graph database on a CDN

By default the app fetches `graph.db.gz` as a **same-origin** static file from
`public/` (committed to the repo). This is deliberate — same origin means no
CORS to configure (see SUMMARY.md).

Some hosts cap static asset size below the graph file:

| Host | Per-asset limit | Works with committed `graph.db.gz`? |
| --- | --- | --- |
| GitHub Pages | 100 MB (repo file limit) | Yes |
| Cloudflare Pages / Workers | **25 MiB** | **No** (file is ~38 MiB) |

To deploy on Cloudflare Pages, serve `graph.db.gz` from a CDN instead and point
the app at it with the `VITE_GRAPH_DB_URL` env var.

## App configuration

`src/db/graphDb.ts` tries the graph DB in this order:

1. **Same-origin** `${BASE_URL}graph.db.gz` (the committed/local file) — fast, no CORS.
2. **`VITE_GRAPH_DB_URL`** (CDN) — fallback used only if (1) is missing/unreachable
   (a fetch error, a non-OK status, or an SPA `index.html` fallback detected via
   `content-type: text/html`).

Consequences:

- **Local dev / GitHub Pages**: use the committed `public/graph.db.gz`
  automatically. If the local file is absent (e.g. a fresh clone before a
  regen), it transparently falls back to the CDN when `VITE_GRAPH_DB_URL` is set.
- **Cloudflare Pages**: the local file is NOT deployed (over the 25 MiB cap), so
  the same-origin fetch returns the SPA `index.html` fallback; `graphDb.ts`
  detects that (`text/html`) and loads from `VITE_GRAPH_DB_URL`.

Set `VITE_GRAPH_DB_URL` in the Cloudflare Pages project under
**Settings → Environment variables** (a build-time Vite var, inlined at build).

### Keeping the oversized file out of the Cloudflare upload

Vite copies `public/graph.db.gz` into `dist/`, but Cloudflare rejects any asset
over 25 MiB — so the deploy fails even though the app loads the graph from R2.
`public/.assetsignore` solves this: Vite copies it to `dist/.assetsignore`, and
Cloudflare's uploader skips the matching files. It uses the pattern `graph.db*`
to also exclude the uncompressed `graph.db`/`-shm`/`-wal` working files if they
are present in `public/`.

This is Cloudflare-specific and declarative (committed in the repo). GitHub
Pages and local dev ignore `.assetsignore` and keep serving `graph.db.gz`
same-origin, so the Cloudflare build command stays the plain `npm run build`.

### Verify the CDN path locally (no curl needed)

If `curl` is blocked on your machine, verify the whole R2 path (public access +
CORS + decompression) by pointing dev at the CDN and loading the app:

```bash
VITE_GRAPH_DB_URL=https://cdn.banded.fm/graph.db.gz npm run dev
```

Then open http://localhost:5173 and check DevTools → Network: a `200` for
`graph.db.gz` from cdn.banded.fm plus a working Explore graph confirms it.
(To force the CDN path specifically, temporarily rename/remove your local
`public/graph.db.gz` so the same-origin fetch misses and the fallback kicks in.)

## Recommended: Cloudflare R2 (free egress, no size limit)

R2's free tier includes 10 GB storage and **free egress** (no bandwidth
charges). Unlike GitHub Releases (see below), you control the CORS policy, so
cross-origin browser `fetch` works reliably.

1. **Create a bucket** (Cloudflare dashboard → R2 → Create bucket), e.g.
   `musicscenemap-graph`.
2. **Upload** `public/graph.db.gz` to the bucket.
3. **Enable public access** through a custom domain: bucket → Settings →
   Custom Domains → Add (the domain must be a zone in the same Cloudflare
   account). Production uses `cdn.banded.fm`. Don't use the bucket's `r2.dev`
   URL beyond a quick test: it's rate-limited, uncached and meant for
   development only; it's disabled on our bucket.
   - Cache it: a Cache Rule for `cdn.banded.fm/*` with "Eligible for cache"
     (by default Cloudflare only caches some file types). After uploading a
     new `graph.db.gz`, purge `https://cdn.banded.fm/graph.db.gz` from the cache.
4. **Set a CORS policy** on the bucket so the browser can fetch it. Restrict the
   origin to your Pages domain(s):

   ```json
   [
     {
       "AllowedOrigins": [
         "https://banded.fm",
         "https://www.banded.fm"
       ],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

5. **Point the app at it**: Cloudflare builds default to
   `https://cdn.banded.fm/graph.db.gz` (`CLOUDFLARE_R2_GRAPH_URL` in
   `vite.config.ts`); `VITE_GRAPH_DB_URL` overrides it.

### Important: do NOT let the CDN set `Content-Encoding: gzip`

`graphDb.ts` auto-detects gzip by inspecting the first two bytes (the `1f 8b`
magic number) and manually decompresses. This works only if the CDN serves the
**raw** `.gz` bytes. If the host sets `Content-Encoding: gzip`, the browser
transparently decompresses and the magic-number check won't fire — but the
object is a gzip of a SQLite file, so you'd then hand raw SQLite bytes to the
decompressor-detection and skip decompression correctly, OR double-handle them.
R2 serves raw bytes by default (no auto `Content-Encoding`), which is what we
want. Verify after upload:

```bash
curl -sI 'https://<your-cdn>/graph.db.gz' | grep -i 'content-encoding\|content-type\|content-length'
```

Expect **no** `Content-Encoding: gzip` header and a `content-length` matching
the file size on disk. (This matters: the repo history has two past fixes for
gzip/decompression surprises — commits `a2b9bd0` and `987afac`.)

## Refreshing after a graph regen

After re-running `scripts/process_mb_dump.py`, re-upload the new `graph.db.gz`
to the bucket (overwrite the object). Two npm scripts automate this:

```bash
npm run upload-graph   # upload existing public/graph.db.gz to R2
npm run regen-graph    # regenerate the graph, then upload in one step
```

They wrap:

```
wrangler r2 object put musicscenemap-graph/graph.db.gz \
  --file public/graph.db.gz --content-type application/gzip --remote
```

Notes:
- `--remote` targets the real R2 bucket (without it, wrangler writes to local
  simulated storage).
- Do NOT pass `--content-encoding gzip`. The app relies on R2 returning raw
  gzip bytes and decompresses via the magic-number check; setting
  `Content-Encoding` would make the browser pre-decompress and break detection.
- Requires `wrangler login` (or `CLOUDFLARE_API_TOKEN`) with R2 write access.
- If you use a custom domain with caching, purge the cached object afterward so
  clients fetch the new file.

## Why not GitHub Releases

GitHub Release asset URLs (`github.com/<user>/<repo>/releases/download/...`)
**302-redirect** to `objects.githubusercontent.com`. The redirected response
does not reliably include `Access-Control-Allow-Origin`, so browser `fetch`
from another origin fails CORS. This was attempted and abandoned for exactly
this reason. Use R2 (or jsDelivr, which does send permissive CORS headers for
files committed in a public repo) instead.
