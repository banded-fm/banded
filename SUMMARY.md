# Banded — Project Summary

## What this is

A React app that visualizes music scene connections and includes a "Six Degrees of Music" game. Uses a precomputed SQLite database (from MusicBrainz data dumps) queried in the browser via WebAssembly. Deployed as a static site on GitHub Pages and/or Cloudflare (Workers Builds); see `docs/CDN_HOSTING.md`.

The site is **Banded** (https://banded.fm); this repo is `rahuljaisimha/banded` (formerly Banded). Its data pipeline is `rahuljaisimha/banded-data`.

The app opens on a **Home** page (no nav bar: a one-line summary and a large button per page). Features: **Explore** (graph visualization), **Play** (Six Degrees game), **Discover** (upcoming concert recommendations), and **Similarity** (score how closely an artist fits a set of artists you like, using weighted graph relationships). Discover lists upcoming Pollstar concerts at the city's top venues, streamed in as they're found and ranked by headliner similarity. Every artist input (Explore search, Discover/Similarity lists, Play's custom game) has a search-as-you-type dropdown that labels same-name artists with their MusicBrainz disambiguation: "Fuzz (US garage rock band)"; artists MusicBrainz doesn't disambiguate get no label.

## Tech stack

- Vite + React 18 + TypeScript
- react-router-dom (hash routes via createHashRouter, for GitHub Pages compatibility; a data router so links can use view transitions)
- react-force-graph-2d for graph visualization
- sql.js (SQLite compiled to WASM) for in-browser graph queries
- In-memory SceneGraph with localStorage persistence (Explore view)
- Python script for processing MusicBrainz data dumps into SQLite
- Vitest for testing (offline, fixture-based)

## Architecture

```
Data pipeline (offline, run manually):
    MusicBrainz full dump (~4GB)
        → Python script extracts artists, band relationships, producer/vocal/instrument credits
        → Seeds: ~145 curated artists (6 hops) + every artist with a concert in the
          banded-data ledger (CONCERTDB_HOPS, default 6), BFS via member_of/support_musician
        → Deduplicates memberships (any active = current, not former)
        → Credits on another artist's record → one edge per role from the credited artist
          to the record's artist: produced_for, collaborated_with (no album nodes)
        → Songs credited to several artists ("A & B", "A feat. B") → collaborated_with
          from each of the others to the first-credited artist, one count per song
        → SQLite database: nodes (persons, groups) + edges + graph_meta
        → If graph.db.gz > 74 MB: rebuilt with one hop fewer around banded-data's
          artists until it fits (Supabase keeps the full set)
        → Output: public/graph.db.gz (~49MB, committed to repo; also uploaded to R2 for Cloudflare)
        → seed_supabase.py writes the same artists and edges (uncut) to Postgres
    banded-data ledger (~/banded-data/data/ledger.sqlite, read-only)
        → scripts/add_concertdb_edges.py adds opener → headliner "opened_for" edges
          (same pairs as `concertdb export --musicbrainz-only`), adding acts that
          aren't in the graph as nodes; re-runnable, replaces its previous edges

App loading (lazy, non-blocking):
    UI renders immediately; main.tsx calls preloadDb() once the browser is idle
        → Browser fetches graph.db.gz in the background
        → Auto-detects gzip (magic number 1f8b) and decompresses if needed
        → sql.js opens the SQLite database in WASM
        → From then on queries are local, instant (<50ms)
    Until it has loaded, lookups go to Postgres instead (the same artists, plus any the
    browser graph had to leave out to fit its size budget):
        → src/db/graphSource.ts: findArtist / findArtistById / getArtistNeighbors
          call the graph-neighbors edge function with log=0 (no search_misses rows)
        → Explore search, Similarity and Discover
          (via tieredGraphAccess) all work while the download is in progress
        → Play renders at once: a saved game shows in full (only its moves list
          waits), a shared link shows curated start/end names, and a new random
          game shows placeholders until BFS over the whole graph can pick one

Artist dropdown (ArtistAutocomplete, all artist inputs):
    User types ≥2 chars (artistSuggest.findSuggestions; database first)
        → Graph loaded: graphDb.searchArtists ranks graph artists instantly
          (exact > prefix > word-prefix > substring); only graph artists are offered.
          Labels from the graph's disambiguation/area columns (no request); older
          graphs without them get labels from one debounced Postgres search, by MBID
        → Graph not loaded yet, or no graph match: Postgres search (graph-neighbors
          ?q= mode; same ranking; never logs to search_misses)
        → MusicBrainz ONLY when the database has no match or can't be reached
          (prefix query)
        → Label: "Name (disambiguation)" from MusicBrainz's disambiguation comment
          only; no label when MusicBrainz has none (no city/genre stand-ins)
        → Shows "Searching…" / "No matching artists" / "Couldn't load suggestions";
          re-runs when the graph finishes loading. Browser MusicBrainz calls send no
          custom headers (a User-Agent header would force a CORS preflight)
        → A pick carries the MBID, and every page resolves a pick by ID, never by name
          (several artists share a name: "Fuzz" the USA rock band vs. Disturbed's bassist).
          Discover/Similarity keep picks as PickedArtist (pickedArtists.ts); the scorer
          takes ArtistRef (name or {name, id}) and GraphAccess.findNodeById; the tiered
          access fetches a pick from Postgres/MusicBrainz by MBID; Discover's venue search
          starts from the MBID. Typed-and-added names still go by name

Explore mode:
    User searches artist (or picks from the dropdown)
        → sql.js queries SQLite for node + neighbors
        → Only person/group nodes shown (albums filtered out)
        → Relationships: member_of, former_member_of, support_musician shown by default;
          collaborated_with, produced_for, opened_for ticked on in the legend
          (GraphLegend: checkbox, colour and arrow direction per type; node
          colours; remembered in localStorage). Hidden types also hide the artists
          only they connect. Edges keep their stored direction (member → group, ...)
        → In-memory SceneGraph renders as force-directed graph
        → Graph persists in localStorage across sessions

Game mode (Six Degrees of Music):
    On load → today's puzzle from src/game/puzzles.json (puzzles.ts: day 0 = DAILY_START,
              local date; the list repeats). Shown at once: endpoints and par need no graph.
        → Puzzles: curated artists (artists.ts) of the same type whose closest connection
          through known artists (10+ Wikipedia editions) is 3-5 hops; par = those hops
          (no +1), path = that connection. How they were chosen: src/game/PUZZLES.md
        → Every link type counts as a move (as in Explore); moves are listed one per
          artist with their closest kind of connection, band ties first
        → User navigates by selecting from valid connections list
        → Undo support, no revisiting, game persists 24h in localStorage
    Random Puzzle → another puzzle from the list; Today's Puzzle → back to the daily one
    Custom game → user picks any two connected artists/bands (no same-type requirement);
                  par = shortest path hops over all links (a listed pair keeps its listed par)
    Shared game → URL params (?start=<mbid>&end=<mbid>) load the exact same puzzle;
                  Share button copies an MBID-based link (avoids name ambiguity)

Similarity mode (artist-to-scene fit scoring):
    User enters a list of artists + one target artist to compare
        → Loads browser SQLite (same DB as Explore/Play)
        → Weighted graph: each relationship has a weight (REL_WEIGHTS: member_of 1.0,
          former_member_of 0.85, support_musician / collaborated_with / opened_for 0.8,
          produced_for 0.3), stored as an edge length -ln(weight) (REL_DISTANCES,
          computed once), so strong ties are short; the first FREE_HOPS (2) hops are
          free (bandmates through their band score 100), each hop after that adds
          HOP_DISTANCE (-ln 0.9)
        → Hub damping (HUB_DAMPED): collaborated_with, produced_for and support_musician
          hops are weakened at an artist with more such links than typical (~90th
          percentile: 14 / 6 / 2): x (typical / count) at each end, so being one of
          Taylor Swift's 133 collaborators counts 0.1x. Memberships and opened_for are
          never damped. Counts come from graphDb.getRelDegree (one GROUP BY over those
          edge types the first time it's asked); an artist fetched from Postgres or
          MusicBrainz is counted from the links that came with it
        → Repeats (REPEATS, from edges.count): REL_WEIGHTS is a one-time tie. Each extra
          song credit closes 20% of the gap to 1.0 (collaborated_with 0.8 -> 0.97 at 10
          songs); producing climbs slower to a 0.75 ceiling, below every other
          relationship (0.30 once, 0.61 an album, 0.71 two); opened_for is 0.8 once and
          0.9 for two shows or more, however many.
          graph-neighbors returns the count too (Postgres relationships.count)
        → Pair score = 100 x e^(-path length) = the shortest path's (damped) weights
          multiplied x 0.9 per hop after the second. Each (liked, compared) pair is a
          bidirectional Dijkstra (connect): it grows whichever end has the smaller
          frontier, so a hub's neighbourhood (will.i.am, Taylor Swift) is never searched
          whole, and costs a meeting exactly (each side counts one free hop; joined paths
          over MAX_HOPS are rejected). Paths read liked -> compared. At most MAX_HOPS (6)
          hops and MAX_EXPANDED (10,000) expansions shared by both ends; a pair under
          MIN_STRENGTH (a score of 2) scores 0. The Similarity page runs two passes: a
          quick one (quick: true, down to QUICK_MIN_STRENGTH 0.05) shows every pair scoring
          5+ at once and the rest as 0 ("Looking for a connection…"); after it's painted, a
          closest pass (down to PATH_MIN_STRENGTH 0.001) over just those (pendingPairs)
          fills in their closest connections and any 2-4 scores (mergePairs).
          graphDb.getNeighbors keeps its two prepared statements for the search's
          thousands of calls
        → Overall = best pair + a diminishing bonus for every other pair scoring >= 60
          (2nd adds 25% of its score, 3rd 12.5%, ...), capped at 100: more good matches
          lift it, weak ones never lower it (BONUS_THRESHOLD / BONUS_SHARE)
        → Fully client-side; no backend. Weights are placeholders, tunable in similarity.ts
        → Tapping a breakdown card opens a panel for that pair, styled like Explore's node
          panel (.info-panel: sidebar on desktop, bottom sheet on phones): the pair's
          score, the strongest path as sentences read along each edge's direction
          ("Ty Segall is a member of Fuzz"; relationSentence in graph/relationships.ts)
          with each hop's weight, and the product that makes the score
          ("1.00 × 0.45 × 0.9 = 0.41 → 41")

Discover (upcoming concert recommendations, streamed: concertSearch.ts streamConcerts):
    User enters city + dates (From / To date inputs, a calendar in the browser; default
    today → +7 days, dateRange.ts: clampRange keeps from ≥ today, to ≥ from, ≤ 4 years
    out) + artists, presses Find Concerts
        → The city input suggests Pollstar cities as you type (CityAutocomplete:
          searchCities through pollstar-city, 350 ms debounce, 2+ characters); a
          picked city is used as it is. Typed text: Pollstar autocomplete for the
          city name (one request): pickCity takes an exact
          "City, State" match, else the most prominent city of that name ("Berlin" →
          Berlin, Germany over Berlin, MD)
        → The city's events between those dates, CITY_PAGE_SIZE (100) a page, soonest
          first, at most MAX_CITY_PAGES (10) pages; each page's concerts are
          listed at once, unscored ("scoring")
        → Each page's new headliners are scored together alongside the requests:
          prepareArtists(…, { musicBrainz: false }) for the ones missing from the
          browser graph (Postgres only), then
          scoreArtistsAgainstList (one search from each liked artist to all of them,
          run SCORE_STEP (400) artists at a time in turn as PathSearch steps, yielding
          to the browser between; a headliner is scored, aggregateScore, and its
          concerts move into place as soon as every search has reached it or given
          up, so the closest matches appear first and the weakest last),
          each headliner once, cached on the page per liked-artist list. The list
          re-sorts after each page (sortConcerts: scored by score then date, then
          unscored by date)
        → Headliners neither the browser graph nor Postgres has are put off
          (scoreLater): once every page is in and scored, they're looked up on
          MusicBrainz one at a time (its ~1 request/second limit; tieredGraphAccess
          doesn't remember a Postgres-only miss, so it asks MusicBrainz then) and scored;
          the status line says "looking up N more artists on MusicBrainz"
        → While it runs the Find Concerts button becomes Stop with a progress bar inside
          (searchProgress: pages loaded × concerts scored) and a spinner + status line ("Berlin,
          Germany: 300 of 592 concerts · scoring 64 artists…"); Stop (or a new search,
          or leaving the page) ends the run
        → Cards: headliner + score, "Support from: ..." (the rest of the bill), date ·
          venue. Tapping one opens ConcertPanel (Explore's .info-panel: sidebar on
          desktop, bottom sheet on phones): the strongest path from each liked artist
          (the pairs kept with each HeadlinerScore), best first, with the same hop
          sentences, weights and formula as Similarity's panel (components/ConnectionPath.tsx)
        → Artists not in the graph score 0, shown but ranked last (flagged)
        → Pollstar calls go to the pollstar-city function only: fetched server-side,
          24h cache in Postgres shared by every visitor (plus the browser's own 24h
          localStorage cache). The browser never calls Pollstar; when the function
          can't get the data (Pollstar refusing, nothing cached) the search fails
          ("Pollstar is unavailable right now")

```

## File structure

```
src/
├── db/
│   ├── graphDb.ts        — sql.js wrapper: load DB, BFS (with rel_type filter), neighbor queries, search.
│   │                       Runtime compilation filter (>25 degree albums skipped).
│   │                       Auto-detects gzip and decompresses if browser didn't.
│   │                       preloadDb() starts the background download; a failed load can be retried.
│   │                       searchArtists() ranks name matches for the dropdown (uses the optional
│   │                       disambiguation/area columns when the graph has them).
│   ├── artistSuggest.ts  — Artist-dropdown suggestions: graph → Postgres search → MusicBrainz
│   │                       fallback (findSuggestions, sources injectable for tests); builds the
│   │                       "(disambiguation)" label (MusicBrainz's comment only).
│   └── graphSource.ts    — Async artist lookups: local graph once loaded, else Postgres graph-neighbors
│                           (log=0, memoized). Used by Explore and Discover.
├── game/
│   ├── artists.ts        — Curated list of 148 recognizable artists (name, type, MusicBrainz ID): the game's
│   │                       start/end points and the graph build's curated seeds (process_mb_dump.py reads it).
│   ├── puzzles.json      — The daily Six Degrees puzzles (1,095, schedule order; day n plays n % length): start, end, the artists in between (par = those + 1).
│   ├── puzzles.ts        — Reads puzzles.json: dailyPuzzle(date) (day 0 = DAILY_START), findPuzzle, randomPuzzle.
│   └── PUZZLES.md        — How the puzzles were chosen: difficulty baseline, fame measure, tests, rules, schedule.
├── graph/
│   ├── types.ts          — Node types, edge types, color maps.
│   └── SceneGraph.ts     — In-memory graph with dedup/merge, persistence, expanded tracking.
├── pages/
│   ├── HomePage.tsx      — Default page (#/), no nav bar: one-line summary + a large button per page (HOME_LINKS). Going to or from it, the title glides into the nav brand while the bar slides down, both in 0.4 s on one linear() spring curve (a quick ~11% wind-up the other way, a sweep, ~10% overshoot), no page fade (view transitions: `viewTransition` links, `view-transition-name` in index.css; off with reduced motion).
│   ├── ExplorePage.tsx   — (#/explore) Graph exploration via SQLite. Only person/group nodes. Albums filtered out.
│   ├── PlayPage.tsx      — Six Degrees game: BFS pathfinding, valid moves list with relationship labels,
│   │                       undo, sorted by rel_type priority, par scoring, reveal shortest path.
│   │                       Supports daily, random (from the list), custom (any two connected nodes), and shared (MBID URL) games.
│   │                       Renders before the graph downloads (skeleton start/end/par/moves until known).
│   ├── DiscoverPage.tsx  — Upcoming concerts: city + artists → the Pollstar city's upcoming events,
│   │                       streamed in a page at a time and ranked by headline-artist similarity;
│   │                       spinner, status, Stop. Starts with the last city searched (savedCity.ts)
│   │                       and the liked artists shared with Similarity.
│   ├── savedCity.ts      — The last city Discover searched, as a PollstarCity in localStorage
│   │                       (`discover.city`): prefilled and already picked, so no lookup.
│   ├── concertSearch.ts  — streamConcerts: the Discover search as a stream of updates (deps injected).
│   ├── SimilarityPage.tsx — Similarity Score: list of artists + target artist → 0–100 fit score.
│   │                       The liked-artist list is shared with Discover (loadLikedArtists/saveLikedArtists).
│   │                       Wires graphDb into the similarity.ts GraphAccess; renders weighted breakdown.
│   ├── similarity.ts     — Pure scoring logic (GraphAccess interface, testable without sql.js).
│   │                       REL_WEIGHTS per relationship type (placeholders), album-credit weighting,
│   │                       per-pair + aggregate scoring, scoreArtistAgainstList helper. Uses ALL relationships.
│   ├── concerts.ts       — Pure concert-ranking logic: flatten Pollstar events, score headline artist
│   │                       via similarity.ts, sort by score then date. Memoizes per-artist scores.
│   ├── graphAccess.ts    — Shared builder for a graphDb-backed GraphAccess (core/Tier-1).
│   │                       Doesn't wait for the download; returns nothing until the DB has loaded.
│   ├── tieredGraphAccess.ts — Tiered GraphAccess: core sql.js → Postgres → MusicBrainz.
│   │                       Async prepareArtists() prefetch + sync build() facade. Used by Similarity + Concerts.
│   ├── searchResolution.ts — Pure logic: resolve an Explore search by MBID (just-clicked node) or by name.
│   └── AboutPage.tsx     — Project info, data source credits, GitHub link.
├── components/
│   ├── ArtistAutocomplete.tsx — Artist input + dropdown (keyboard, ARIA combobox, 44px rows on phones).
│   │                       Used by SearchBar, Discover, Similarity and Play's custom game.
│   ├── Layout.tsx        — Shared nav bar with Explore/Play/Discover/Similarity/About links; the brand links home; hidden on the home page. Pins SiteFooter under every page but Home (which puts it after its content) and About (which has the full credits).
│   ├── SiteFooter.tsx    — One-line footer: the data sources (MusicBrainz, setlist.fm, Pollstar) and that connections and shows may be missing.
│   │                       Inline tabs on desktop; hamburger menu below 640px.
│   ├── SearchBar.tsx     — Search input, expand, reset. Responsive layout.
│   ├── GraphView.tsx     — Force-directed 2D graph canvas (filled=expanded, outline=unexpanded).
│   │                       Nodes are rounded-rectangle bubbles with the name inside (graph/bubbles.ts sizes and wraps them); a box collision force keeps them apart; links run edge to edge.
│   ├── GraphLegend.tsx   — Explore legend: per relationship type a checkbox, colour, arrow direction;
│   │                       node colours. Types and defaults in src/graph/relationships.ts.
│   ├── InfoPanel.tsx     — Side panel (desktop) / bottom sheet (mobile) for node details: group/person,
│   │                       name, MusicBrainz disambiguation, genres (graphDb.getArtistDetails, filled in
│   │                       once the graph has loaded) and a link to the artist's MusicBrainz page.
│   └── DebugConsole.tsx  — Collapsible log console, shown when the URL has ?debug=1 or ?debug=true.
├── api/
│   ├── supabase.ts       — Client for Supabase edge functions (Pollstar via our server, graph lookups, misses).
│   ├── pollstar.ts       — Pollstar client: city autocomplete + a city's upcoming events,
│   │                       via the pollstar-city function only (no browser fallback), 24h cache.
│   ├── musicbrainz.ts    — Live MusicBrainz API client (1 req/sec). Fallback only: Tier-3 lookups and
│   ├── musicbrainzSubgraph.ts — An artist + its member/band/support relationships from MusicBrainz (Explore's and the tiered access's last resort).
│   │                       dropdown suggestions the database has no match for (searchArtistsPrefix).
│   └── cache.ts          — localStorage request cache with TTL (used by pollstar.ts, 24h).
├── debug/
│   └── DebugLog.ts       — Singleton log store. Enabled by debug=1/true in the query string or the
│                           hash route's query (#/explore?debug=1); stays on until a reload without it.
├── test/
│   ├── setup.ts          — Vitest setup (localStorage shim for Node env).
│   ├── musicbrainz.integration.test.ts — Regression tests for recurring MB bugs (stubbed fetch).
│   ├── similarity.test.ts / concerts.test.ts — Scoring and concert-ranking logic.
│   ├── tieredGraphAccess.test.ts — Tier fallback order, caching, miss recording.
│   ├── searchResolution.test.ts  — MBID-vs-name search resolution.
│   ├── artistSuggest.test.ts     — Dropdown suggestion merging and labels.
│   └── fixtures/         — Captured MusicBrainz API responses (search-fuzz, artist-arctic-monkeys, etc.).
├── App.tsx               — Router (createHashRouter, 6 routes: Home at /, Explore at /explore, Play, Discover, Similarity, About; unknown paths go home).
├── main.tsx              — Entry point.
├── vite-env.d.ts         — Vite type declarations.
├── sql.js.d.ts           — sql.js type declarations.
└── index.css             — Dark theme, mobile styles (max-width: 640px block), highlight animation.

scripts/
├── process_mb_dump.py    — Downloads MusicBrainz dump, builds browser SQLite graph: curated + banded-data
│                           seeds, person/group nodes, band edges, produced_for / collaborated_with edges
│                           (build_collaborations). Fits the download to MAX_GZIP_MB. load_graph_inputs() is
│                           shared with seed_supabase.py.
├── add_concertdb_edges.py — Adds "opened_for" edges (opener → headliner) to graph.db.gz from the
│                           banded-data ledger. Run after process_mb_dump.py.
├── seed_supabase.py      — Seeds Supabase Postgres with the same artists and edges, uncut (--dry-run counts rows).
├── crawl_setlistfm.py    — Daily crawl job for Setlist.fm venue data.
└── README.md             — Script documentation.

supabase/
├── functions/
│   ├── pollstar-city/    — Edge function: Pollstar autocomplete + a city's upcoming events by page, fetched
│   │                       server-side, 24h cache shared by all visitors. Discover uses it.
│   ├── pollstar-events/  — Edge function (old, unused since pollstar-city; to delete): Pollstar venue
│   │                       search + a venue's upcoming events.
│   ├── venue-search/     — Edge function: on-demand venue lookup (artist + city → venues).
│   │                       Resolves via DB then MusicBrainz. Caches, detects toured_with.
│   ├── report-miss/      — Edge function: logs artists missing from browser SQLite.
│   └── graph-neighbors/  — Edge function (Tier 2): artist + 1-hop neighbors from Postgres.
│                           Logs misses to search_misses (graph-neighbors-not-found) unless log=0.
│                           ?q= search mode for the artist dropdowns (never logs).
├── migrations/
│   ├── 001_schema.sql    — PostgreSQL schema (artists, albums, venues, relationships).
│   ├── 002_crawl_log.sql — Data freshness tracking.
│   ├── 003_search_misses.sql — Unknown artist query logging.
│   ├── 004_artist_search.sql — pg_trgm index on artists.name, artists.area column.
│   ├── 005_collaborations.sql — Drops albums + per-album credit rows and two redundant indexes
│                           (then VACUUM FULL relationships; re-seed; redeploy graph-neighbors).
│   ├── 006_genres.sql      — genres table (id, name) and artists.genre_ids (ids, most voted first).
│   ├── 007_search_misses_reader.sql — read-only role concertdb_misses (SELECT on search_misses only).
│   └── 008_row_level_security.sql — RLS on every table: anon/authenticated see nothing; service role,
│                           owner and concertdb_misses (policy) unaffected.
├── config.toml           — Supabase project config.
└── README.md             — Deployment instructions.

docs/
├── CDN_HOSTING.md        — Hosting graph.db.gz on Cloudflare R2; Cloudflare deploy setup.
└── SPACE_SAVING.md       — Ideas for reducing database storage if needed.

public/
├── graph.db.gz           — Precomputed SQLite graph (committed, ~49MB).
├── .assetsignore         — Keeps graph.db.gz out of the Cloudflare upload (25 MiB asset cap).
└── sql-wasm.wasm         — sql.js WASM binary (committed, ~660KB).

.github/workflows/
└── deploy.yml            — GitHub Actions: build and deploy to GitHub Pages.

wrangler.jsonc            — Cloudflare Workers config (static assets; `previews` block for PR builds).
CLAUDE.md                 — Instructions for Claude Code sessions (imports this file).
```

## SQLite schema

```sql
CREATE TABLE nodes (
    id TEXT PRIMARY KEY,    -- MusicBrainz GID
    name TEXT NOT NULL,
    type TEXT NOT NULL,     -- "person", "group"
    disambiguation TEXT,    -- MusicBrainz comment, e.g. "US garage rock band" (~36% of artists)
    area TEXT,              -- begin area (usually a city), else area (~72% of artists)
    genres TEXT             -- genre ids, most voted first, e.g. "412,25,301" (NULL when none)
);

-- The genres the nodes use. An artist's genres: MusicBrainz genre tags with 2+ votes,
-- the top 3 plus any tied with the third (process_mb_dump.py pick_genres).
CREATE TABLE genres (id INTEGER PRIMARY KEY, name TEXT NOT NULL);

CREATE TABLE edges (
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    rel_type TEXT NOT NULL, -- "member_of", "former_member_of", "support_musician",
                            -- "collaborated_with" / "produced_for" (source sang/played on, or produced,
                            --   target's records), "opened_for" (source opened for target; banded-data)
    count INTEGER           -- how often: song credits (collaborated_with / produced_for), shows
                            --   (opened_for); NULL for band edges and in graphs built before it
);

CREATE TABLE graph_meta (key TEXT PRIMARY KEY, value TEXT);   -- build info: dump, seeds, hops; opened_for counts
CREATE TABLE graph_meta_added_nodes (value TEXT PRIMARY KEY); -- acts it added (so a re-run can drop stale ones)

-- Indexes: edges(source), edges(target), edges(rel_type), nodes(name COLLATE NOCASE), nodes(type)
--
-- The pipeline (process_mb_dump.py) emits person/group nodes only (no album
-- nodes); credits become artist -> record-artist collaborated_with / produced_for
-- edges (older graphs had person<->person "collaborator" edges; similarity.ts
-- still weighs them). Graphs older than the disambiguation/area columns still
-- load: searchArtists checks PRAGMA table_info and the dropdown then gets
-- labels from Postgres.
```

## Key design decisions

- **SQLite in browser**: Precomputed graph loaded via sql.js WASM. ~49MB download (gzipped, kept under 74MB; loaded in the background), instant queries.
- **Lazy graph loading**: Pages never wait for the graph download. It starts in the background after the first render (`preloadDb()` in `main.tsx`), and until it finishes `graphSource.ts` and the tiered access answer from Postgres `graph-neighbors`, which holds every artist. After it finishes they still ask Postgres for an artist the browser graph doesn't have (it's cut to fit the download), so Explore and Discover find e.g. Zach Bryan whether or not the download has finished. An artist Postgres doesn't have either comes live from MusicBrainz (`api/musicbrainzSubgraph.ts`, shared with the tiered access), so anything the search dropdown offers can be explored. Those requests pass `log=0`, so nothing is added to `search_misses` while the graph is downloading. Postgres only returns 1-hop neighborhoods, so Similarity scores computed before the download finishes can be less precise. Play renders immediately too: today's puzzle, a random puzzle and any listed puzzle (including a shared one) show their start, end and par at once from puzzles.json, a saved game comes back in full, and a shared custom game shows its start and end when they are curated artists; only the list of moves (and a custom game's path) waits for the graph.
- **Gzip auto-detection**: Checks first 2 bytes for gzip magic number (1f 8b). Decompresses manually if browser didn't (GitHub Pages). Skips if Vite already decompressed (Content-Encoding: gzip).
- **Game restricted to band relationships**: BFS and valid moves only use member_of, former_member_of, support_musician. Collaborations and opened_for are not used in gameplay (too loose a tie for the puzzle).
- **Compilation filter (runtime)**: Album nodes with >25 connections skipped during BFS. A no-op now that graphs have no album nodes; kept for older graph files.
- **Membership deduplication**: For same (person, band) pair, if ANY relationship is not ended → stored as member_of (not former). Prevents Dave Grohl showing as "former member" of Foo Fighters.
- **Explore only shows artists**: Album nodes (only in old graph files) filtered from search results and neighbor expansion. Directed edges (opened_for, collaborated_with, produced_for) are drawn source → target whichever end was expanded.
- **Artist dropdown: database first, MusicBrainz as fallback only**: ~1,500 names in the graph belong to more than one artist (four "Fuzz"es), so suggestions carry a MusicBrainz-style parenthetical from the database's `disambiguation` and `area` (both pipelines now write them; Postgres already has `disambiguation`). Suggestions come from the local graph, else Postgres via `graph-neighbors`' `?q=` search mode (which never logs misses; it shares the function with the `log=0` lookups rather than adding a second one); MusicBrainz is asked only when the database has no match or is unreachable. Only graph artists are suggested once the graph has loaded and matches, so every pick can be expanded. Genre is only shown for MusicBrainz fallback results (tags aren't in the main dump).
- **Concert recommendations (Pollstar, on demand)**: Discover fetches upcoming events when asked, through the `pollstar-city` function: our server asks Pollstar and keeps the answer 24 hours in Postgres, shared by every visitor, so a page of a city's concerts costs at most one Pollstar request a day and there's no scrape job to maintain. (Before, every browser asked Pollstar through corsproxy.io, whose shared servers Pollstar saw anyway. That fallback is gone: corsproxy.io now wants an API key, so when the function can't get the data the search fails.) Concerts are ranked by headline-artist similarity reusing `similarity.ts` via a shared `graphAccess.ts` adapter. Artists absent from the graph score 0 and rank last (shown, flagged) — hit rate is a known future improvement (more graph artists / backend fallback). Ranking logic (`concerts.ts`) is pure and unit-tested; only the fetch layer touches the network.
- **Tiered graph coverage (Option 4)**: `src/pages/tieredGraphAccess.ts` wraps the core sql.js `GraphAccess` and, for artists NOT in the core graph, falls back through Tier 2 (Postgres `graph-neighbors` edge function) → Tier 3 (MusicBrainz live). (Discogs is a planned Tier 4, deferred.) Because the scorer's `GraphAccess` is synchronous but Tier 2/3 are async, it works in two phases: `prepareArtists(names)` (async prefetch of out-of-core artists → node + 1-hop neighbors, cached 24h, concurrent dupes deduped/shared) then `build()` returns a sync facade (core first, then overlay). Similarity and Concerts call `prepareArtists` before scoring, so out-of-core artists (esp. small concert headliners) now resolve instead of scoring 0. Tier 2 returns 1 hop only — reduced multi-hop accuracy for out-of-core artists is an accepted tradeoff. Postgres holds every artist the build reaches, never cut for size (plus the artists of records they worked on), so it covers what the browser graph leaves out when the size budget trims it; MusicBrainz (Tier 3) covers the rest.
- **Collaborations instead of albums**: a producer, vocal, instrument or performer credit on another artist's record becomes one directed edge from the credited artist to the record's (release group's) first credited artist: `produced_for` for producing, `collaborated_with` for singing/playing/performing (Josh Homme → Arctic Monkeys for Humbug). Engineering credits (mix, engineer, recording), credits on an artist's own records, credits between a band and its current or former members (the membership edge already covers them) and "Various Artists" compilations are left out. MusicBrainz's special purpose artists ([unknown], [anonymous], [traditional], [theatre]...; `SPECIAL_PURPOSE_ARTISTS`) are dropped entirely, with all their relationships and credits: they are credited on thousands of records and linked unrelated artists (Mick Jagger → [unknown] → Jack White). Postgres keeps the number of song credits in `relationships.count`; the browser graph has no count column. No album nodes or album table anywhere (it replaced person↔person `collaborator` co-credit pairs, about half as many edges). A song credited to several artists ("Evan Honer & Wyatt Flores") also counts as a `collaborated_with` credit from each of the other artists to the first-credited one, even without a vocal or instrument credit; a song the same artist already has a performing credit on isn't counted twice (parse_shared_credits / parse_shared_songs read `artist_credit_name` and `recording`). A pair known only from a shared song doesn't bring a new artist into the graph (record_artists skips it): those pairs outnumber all other collaborations about two to one, and letting them add artists pushed graph.db.gz to ~103 MB; their edges are kept when both artists are in the graph anyway. Weights (placeholders): `collaborated_with` 0.5, `produced_for` 0.45.
- **Seeds and size budget**: the graph is every artist within 6 hops of the curated seeds and within `CONCERTDB_HOPS` (default 6) of each artist with a concert in banded-data, over band relationships, plus the artists whose records those artists played on or produced (`record_artists`, ~28k: e.g. Zach Bryan, reached only through the musicians on his records; Postgres always had them). The browser download is held under 74 MB (60.5 MB with the record artists, 48 MB without): if `graph.db.gz` comes out over `MAX_GZIP_MB` (74), `process_mb_dump.py` rebuilds it with one hop fewer around banded-data's artists. The limit can be generous because the download never blocks a page (lazy loading, Postgres answers meanwhile). Postgres is never cut, so Tier 2 covers what the browser graph leaves out. `graph_meta` records the hops used and the number of record artists.
- **Game valid moves**: Scrollable list of all valid connections from current node. Sorted by relationship priority (members → former → support). Filter by typing. No revisiting. Undo support.
- **Par scoring**: Par = shortest path node count. Re-rolls if < 3 hops.
- **Seed artists**: 148 recognizable artists (persons + iconic bands) at 6 hops, the game's puzzle endpoints; plus banded-data's artists (see "Seeds and size budget"). Listed once, in `src/game/artists.ts`, by MusicBrainz ID with the name for readability: names are ambiguous (several "Lemmy"s, five "Nirvana"s) or change ("Kanye West" is "Ye" on MusicBrainz), and the build used to pick an arbitrary namesake. The game resolves them by ID too; a seed missing from the dump is reported by the build.
- **Concert ties from banded-data**: `scripts/add_concertdb_edges.py` reads the banded-data ledger (read-only; data flows one way, banded-data never reads the graph) and adds one `opened_for` edge per (opener, headliner) pair: both matched to MusicBrainz, not a festival, not cancelled, billing confidence ≥ 0.4. Every act in these pairs has a concert, so the build's banded-data seeds already put it in the graph; an act missing from an older or trimmed graph is added as a node (name, type, disambiguation; no area). `graphDb.getNeighbors` reports each edge's direction (`outgoing`) so Explore draws opener → headliner; Similarity weighs `opened_for` at 0.45 (placeholder, below band ties, above a single album credit) and labels "opened for / headlined". The game ignores it (it uses band relationships only). Postgres (`graph-neighbors`) doesn't have these edges yet.
- **Same-type pairs**: Game always pairs person↔person or group↔group.
- **Vite base (host-aware)**: `vite.config.ts` sets `base` by precedence: explicit `DEPLOY_BASE` env var → Cloudflare build (`WORKERS_CI` from Workers Builds, or `CF_PAGES` from Pages) → `/` → GitHub Pages production default `/Banded/` → dev `/`. Cloudflare serves at the domain root, so the GitHub Pages base there causes a blank page (404'd assets) — hence the auto-detection. It also inlines the R2 graph URL on Cloudflare builds (see `__GRAPH_DB_CDN_URL__`), since static-assets-only Workers can't hold env vars.
- **graph.db.gz loader (local-first, CDN fallback)**: `graphDb.ts` tries the same-origin committed file first, then falls back to the CDN URL (`VITE_GRAPH_DB_URL` or the build-time `__GRAPH_DB_CDN_URL__`) if the local file is missing/HTML-fallback. On Cloudflare the local file is excluded from upload via `public/.assetsignore` (25 MiB asset cap), so it loads from R2.
- **graph.db.gz committed to repo**: Deployed with the site, same origin = no CORS. Fits GitHub's 100MB file limit. **Cloudflare Pages caps static assets at 25 MiB**, below the file size — to deploy there, host `graph.db.gz` on a CDN and set `VITE_GRAPH_DB_URL` (see `docs/CDN_HOSTING.md`). `graphDb.ts` uses `VITE_GRAPH_DB_URL || same-origin file`. **GitHub Releases was tried and rejected**: release-asset URLs 302-redirect to `objects.githubusercontent.com` without reliable `Access-Control-Allow-Origin`, so cross-origin `fetch` fails CORS. Use Cloudflare R2 (free egress, controllable CORS policy, serves raw gzip bytes so the magic-number decompression path still works) or jsDelivr.
- **Mostly client-side**: The site is static (GitHub Pages / Cloudflare) and graph queries run in the browser. Network calls are limited to Supabase edge functions (venue search, Tier-2 graph lookups, miss reporting), MusicBrainz (Tier-3 fallback) and Pollstar (concerts).
- **No Spotify import**: removed. Since February 2026 Spotify's Development Mode allows at most 5 allow-listed users, and Extended Quota Mode is only for established businesses, so a public Spotify top-artists import isn't possible (the About page's FAQ explains this to users).
- **Game persistence**: 24h in localStorage. New Game clears and regenerates.
- **Remembered choices**: the liked artists (`likedArtists`: one list for Similarity and Discover, saved on every change, MBIDs kept) and Discover's last searched city (`discover.city`, saved when a search finds it) stay in localStorage in this browser. Unreadable saved data is ignored.
- **Responsive**: Phone layouts come from one `@media (max-width: 640px)` block in `index.css` that targets class hooks on components (inline styles stay the desktop default). Below 640px: hamburger nav, one-row Explore toolbar, bottom-sheet InfoPanel, 44px tap targets, safe-area insets. Tested at 320px and 390px with no horizontal scroll.

## Running

```bash
npm install
npm run dev
# Access at http://localhost:5173/
```

Requires `public/graph.db.gz` — either committed in repo or regenerated:

```bash
brew install zstd
python3 scripts/process_mb_dump.py
```

When hosting the graph on R2 (Cloudflare), re-upload after a regen:

```bash
npm run add-concerts   # refresh the "opened_for" edges from the banded-data ledger
npm run upload-graph   # upload public/graph.db.gz to R2 (wrangler, --remote)
npm run regen-graph    # regenerate (MusicBrainz + banded-data) then upload in one step
```

## Testing

```bash
npm test          # run once
npm run test:watch  # watch mode
```

Vitest tests in `src/test/musicbrainz.integration.test.ts` are regression guards for bugs that recurred during development. They use real MusicBrainz API responses captured as fixtures (`src/test/fixtures/`) with `fetch` stubbed — offline, deterministic, fast (~140ms). Covered cases:
- Exact name match vs relevance ranking (Fuzz vs Buzz Fuzz)
- Same-name disambiguation (multiple "Jack White")
- Current vs former member dedup (member current if any relationship not ended)
- Bands dedup (Nirvana appears twice in Dave Grohl's raw relations)
- Supporting musician extraction (Arctic Monkeys → Tom Rowley, Tyler Parkford)

The rate limiter in `mbFetch` is skipped when `process.env.VITEST` is set. To refresh a fixture, re-capture the MusicBrainz API response for the relevant MBID.

`src/test/similarity.test.ts` unit-tests the Similarity scoring logic (`src/pages/similarity.ts`) against an in-memory fake graph (no sql.js needed). Covers: relationship-weight ordering (member_of > former_member_of > support_musician > album credits), strongest-path scoring (weights multiplied, 0.9 per extra hop; a long strong path beats a short weak one; the hop limit), band-tied vs album-only ranking, unreachable artists scoring zero, unknown/not-found artists, breakdown sort order, and the overall score (best match plus a diminishing bonus for other good matches; never lowered by adding an artist).

`src/test/artistSuggest.test.ts` covers the artist dropdown: source order (graph labels with no request; Postgres labels by MBID; Postgres while the graph downloads; MusicBrainz only when the database has no match or is down), MusicBrainz field mapping (type, and the disambiguation only), and the label (the disambiguation, or none).

`src/test/tieredGraphAccess.test.ts` covers the tiered fallback (core → Postgres → MusicBrainz), Tier-2 caching, per-session dedupe, and miss recording. `src/test/searchResolution.test.ts` covers Explore's MBID-vs-name search resolution.

`src/test/concerts.test.ts` unit-tests the concert-ranking logic (`src/pages/concerts.ts`) and Pollstar response parsing (`src/api/pollstar.ts`). Covers: headline-artist selection, ranking graph-known artists above unknowns (score 0), tie-break by soonest date, per-artist score memoization, supporting-artist listing, event dedupe, and `parseVenues`/`parseEvents`/`formatPollstarDate` field mapping. All offline (no network).

## Backend (Supabase)

PostgreSQL database on Supabase (free tier, 500MB). Stores the full graph + venue data.

**Schema** (`supabase/migrations/`):
- `artists` — mbid, name, type, disambiguation, country, area (migration 004), genre_ids (migration 006: ids into `genres`, most voted first)
- `genres` — id, name: the MusicBrainz genres artists use (replaced on each seed; ids follow MusicBrainz's sorted genre list)
- **Access**: row-level security is on for every table (migration 008) with no policy for `anon` / `authenticated`, so the public API key reads and writes nothing. The edge functions use the service role (bypasses RLS); the seed scripts connect as the owner; `concertdb_misses` reads `search_misses` through its own policy.
- `venues` — id, name, city, state, country
- `relationships` — source_id, target_id, rel_type, count. Seeded: band relationships and `collaborated_with` / `produced_for` (count = song credits); `played_at` / `toured_with` from venue-search. Album table and per-album credit rows removed in migration 005.
- `crawl_log` — artist_mbid, city, last_fetched (tracks data freshness, 14-day stale threshold)
- `search_misses` — query, source, created_at (tracks unknown artist lookups)

**Edge Functions** (`supabase/functions/`):
- `venue-search` — On-demand venue lookup: resolves artist (DB → MusicBrainz fallback), checks cache, fetches Setlist.fm, stores results, detects touring partners. Adds missing artists to DB automatically. Keeps every setlist it fetches, as setlist.fm returned it, as user-requested data (`user_requested_data`, below).
- `report-miss` — Lightweight POST endpoint for frontend to report artists missing from browser SQLite.
- `graph-neighbors` — Tier-2 graph lookup: artist + 1-hop neighbors from Postgres for artists missing from the browser SQLite, and for every lookup while that graph is still downloading. `log=0` skips the miss log. `?q=` is a search mode for the artist dropdowns (ranked matches with disambiguation and area, no neighbors, never logs).

**User-requested data for banded-data** (`user_requested_data`, migration 009: source, key, data JSONB, version, fetched_at, seq; one row per (source, key)). Data the app fetches from outside sources because a user asked for something, kept so banded-data can store it like its own crawls without spending its own requests; nothing kept is about the user:
- `setlistfm` (key = setlist id): venue-search upserts every setlist it fetches (the artist-in-city search and each venue's setlists) as setlist.fm returned it; version = its lastUpdated.
- `pollstar` (key = Pollstar venue id; data = { venue, ...Pollstar's events response }) and `pollstar_search` (key = the lowercased venue search; Pollstar's autocomplete response): written by the `pollstar-events` function (Discover's old venue-by-venue search; `pollstar_search` rows are now written by `pollstar-city` too), which fetched Pollstar server-side for Discover's Concerts and serves every visitor from these rows while they're under 24 hours old (a venue is fetched from Pollstar at most once a day, whoever asks). When Pollstar refuses, an older row is served as stale; with nothing cached the function answers 503. The venue's name and city come from the cached search that found it, so nothing a browser sends is stored. (Migration 009's comments still describe the earlier browser-post design, replaced before it shipped.)
- `pollstar_city` (key = "<Pollstar city id>:<page>", or "<city id>:<from>:<to>:<page>" for a date range; Pollstar's response for that page of the city's upcoming events, 100 a page, each event with its full venue): written by the `pollstar-city` function, same 24-hour cache and stale/503 rules. banded-data stores it like its own Pollstar crawl.
`seq` moves forward only when a row is added or its version changes (trigger). banded-data's `user-requested` step (a step of every run, same read-only login as the misses) reads the rows past its last `seq` and hands each to its source's ingest. A new source: an upsert in the edge function that fetches it, plus an ingest in banded-data (rows from sources it has no ingest for are skipped).


**Search miss tracking** (`search_misses`: query, source). banded-data reads new rows every night
(`concertdb misses`, read-only role from migration 007), resolves them to MusicBrainz IDs and crawls those
artists' concerts first, so they join the graph at the next rebuild:
- `dropdown-musicbrainz-pick` — the user picked an artist only MusicBrainz knows (query = its MBID)
- `explore-not-found` — an Explore search found the artist nowhere: not in the loaded graph nor on the server (query = MBID or typed name)
- `explore-not-in-graph` — an Explore search found the artist on the server but not in the loaded browser graph (query = MBID)
- `sqlite-missing` — in Supabase DB but not browser SQLite (reported by the old Discover venue search; no longer sent)
- `venue-search-missing-artist` — resolved via MusicBrainz, added to Supabase (edge function logs)
- `venue-search-not-found` — not found anywhere, likely mistype (edge function logs)

**Size**: was ~320MB with albums and per-album credits. With the collaborations model and the banded-data seeds, 237MB after re-seeding (Supabase dashboard → Settings → Usage).

## Deploying

**Frontend (GitHub Pages)**: Push to `main`. GitHub Actions builds and deploys to Pages automatically (base `/banded/`, graph served same-origin).

**Frontend (Cloudflare, Workers Builds)**: Build command `npm run build`, deploy `npx wrangler deploy`, output `dist`. No env vars needed — the build auto-detects Cloudflare (`WORKERS_CI`) to set base `/` and inline the R2 graph URL. `public/.assetsignore` keeps the oversized `graph.db.gz` out of the upload (25 MiB cap); the app loads it from R2. R2 bucket needs public access + a CORS policy allowing the site origins. Full setup in `docs/CDN_HOSTING.md`.

**PR previews**: Cloudflare builds every PR branch with `npx wrangler preview` (needs the `previews` block in `wrangler.jsonc`). The `cloudflare-workers-and-pages` bot comments on the PR with the preview URL and build status.

**Edge Functions** (full list in `supabase/README.md`):
```bash
supabase functions deploy venue-search --no-verify-jwt --project-ref lwqkjtzqjgacgvfjiyxg
supabase functions deploy report-miss --no-verify-jwt --project-ref lwqkjtzqjgacgvfjiyxg
supabase functions deploy graph-neighbors --no-verify-jwt --project-ref lwqkjtzqjgacgvfjiyxg
supabase functions deploy pollstar-city --no-verify-jwt --project-ref lwqkjtzqjgacgvfjiyxg
```
Run `migrations/004_artist_search.sql` for fast dropdown search (`graph-neighbors` `?q=` works without it, just slower and with no `area`), and re-run `seed_supabase.py` to fill `area`. Run `migrations/005_collaborations.sql`, then `VACUUM FULL relationships;` on its own, before re-seeding with the collaborations model.

## What's missing / next steps

- **On-demand MusicBrainz refresh**: Edge function that checks if an artist's relationships are stale (e.g. >30 days) when queried, and fetches latest data from MusicBrainz API to update Supabase. Same pattern as venue-search but for band memberships and collaborations. Handles new records/collaborations appearing over time.
- **opened_for in Postgres**: seed `opened_for` edges into `relationships` too (graph-neighbors already returns the type).
- **Weight collaborations by count**: Postgres has the song-credit count per collaboration; the browser graph doesn't yet (it would cost download size).
- **Genre/decade graph splits**: Separate smaller files per genre for faster downloads and focused game experiences.
- **FTS5 search**: Full-text search for fuzzy name matching ("The Arctic Monkeys" → "Arctic Monkeys"). Include artist aliases.
- **Daily puzzle mode**: Same game for all users each day (date-seeded), shareable results, leaderboard.
- **Game difficulty levels**: Easy (short paths, famous artists only), Hard (longer paths, obscure connections).
- **Expand node on click**: Direct expansion from graph without search bar.
- **Scene detection**: Graph algorithms to identify communities/scenes automatically.
- **Travel mode**: Input a city, show relevant venues/scenes filtered by taste (requires venue data).
- **Upcoming shows / Concert Finder (IMPLEMENTED via Pollstar)**: Discover → Concerts toggle recommends upcoming concerts at a city's top venues, ranked by artist similarity. Data-source investigation history:
  - **Setlist.fm API** — only has *past* setlists, no upcoming shows. Website has upcoming shows on venue pages (`upcomingSetlistsList`) and they scrape cleanly, but listings are sparse.
  - **Songkick** — has more complete upcoming show data, but the website blocks scraping (HTTP 406, aggressive bot protection) and the official API requires a paid commercial partnership (no free/hobbyist tier).
  - **JamBase** — excellent fit (MBID-keyed via `/v3/artists/id/musicbrainz:{mbid}`, aggregates 25+ ticketing sources, structured data), but only a 14-day free trial then paid.
  - **Ticketmaster Discovery API** — free, but only lists LiveNation/Ticketmaster events (limited coverage).
  - **Songkick API** with MBID support (`/artists/mbid:{mbid}/calendar`) would be ideal but is paid-only.
  - **Pollstar (IMPLEMENTED)** — Pollstar's website backs onto public JSON endpoints that return genuine *upcoming* events with artist names, dates, and ticket links (the app doesn't show ticket links: lots of duplicates and VIP packages, and possibly against Pollstar's terms): autocomplete (`autocomplete.pollstar.com/global/All/100/{q}`, filter EntityType=Venue) and events (`www.pollstar.com/api/companies/{venueId}/events?fromDate=...`). `fromDate` must be today-or-later (past dates are subscription-gated). This powers the Discover → Concerts toggle: top venues → Pollstar events → ranked by headline-artist similarity. Fetched server-side by the pollstar-city function, 24h shared cache (the browser never calls Pollstar). Artists not in the graph score 0 and rank last. See `src/api/pollstar.ts` + `src/pages/concerts.ts`.
  - **Original decision (superseded)**: Parked pending a free MBID-compatible source; Pollstar's public endpoints filled that gap.
  - **Future hit-rate improvements**: more artists in the SQLite graph, a backend fallback lookup when an artist isn't in the graph, or MBID resolution via MusicBrainz to enrich matching.
- **Setlist.fm integration**: Venue data, touring-together inference via shared date+venue.
- **PostgreSQL backend (future)**: For complex graph queries, venue recommendations, multi-user leaderboards.
