# Scripts

Local scripts for data processing and database management.

## process_mb_dump.py

Downloads the MusicBrainz data dump and builds the browser SQLite database (`public/graph.db.gz`).

```bash
brew install zstd
python3 scripts/process_mb_dump.py                       # then add_concertdb_edges.py
python3 scripts/process_mb_dump.py --concertdb-hops 2    # fewer hops around banded-data's artists
```

Artists: within 6 hops of the curated seeds (the game's list in
`src/game/artists.ts`, by MusicBrainz ID), and within `--concertdb-hops`
(`CONCERTDB_HOPS`, default 6) of each artist with a concert in the
banded-data ledger (`CONCERTDB_LEDGER`, default
`~/banded-data/data/ledger.sqlite`; without it, curated seeds only), over
band relationships. If `graph.db.gz` is over `--max-gzip-mb` (74), it is
rebuilt with one hop fewer around banded-data's artists until it fits.

Edges: band relationships, and `produced_for` / `collaborated_with` from an
artist to the artists whose records they produced or sang/played/performed on
(not between a band and its members: the membership edge covers that). A song
credited to several artists ("Evan Honer & Wyatt Flores") adds a
`collaborated_with` from each of the others to the first-credited artist (only
between artists already in the graph: shared songs don't add record artists).

Genres: each artist's MusicBrainz genres with 2+ votes (a genre one person
tagged is dropped), most voted first: the top 3, plus any tied with the third
(Arctic Monkeys: indie rock 19, alternative rock 9, garage rock revival 7,
post-punk revival 7 → all four). Stored as ids in `nodes.genres` ("412,25")
with a `genres` table. Votes come from the derived dump's `tag` / `artist_tag`
tables (`mbdump-derived.tar.bz2`, ~0.5 GB, downloaded once); the genre list is
one MusicBrainz API request, cached in `scripts/data/genres.txt`. A genre's id
is its position in that list, so rebuild the graph and re-seed Postgres
together after deleting the cached list.

## add_concertdb_edges.py

Adds "opened for" edges (opener → headliner, `rel_type = 'opened_for'`) to
`public/graph.db.gz` from a local banded-data ledger, read-only. Pairs are
those `concertdb export --musicbrainz-only` exports (both acts matched to
MusicBrainz, no festivals or cancelled shows, confidence ≥ 0.4). Acts that
aren't in the graph are added as nodes. Re-running replaces the previous
`opened_for` edges, so it can refresh them without rebuilding the graph.

```bash
python3 scripts/process_mb_dump.py        # rebuilds the graph (no opened_for edges)
python3 scripts/add_concertdb_edges.py    # then add them
python3 scripts/add_concertdb_edges.py --ledger ~/banded-data/data/ledger.sqlite --min-conf 0.4
```

## seed_supabase.py

Seeds the Supabase PostgreSQL database with the same artists and edges as the
browser graph, never cut down for size, with the song-credit count on each
collaboration, and each artist's genres (`artists.genre_ids` and the `genres`
table, replaced on each run). Run `supabase/migrations/005_collaborations.sql`
first if the database still has the album table, and `006_genres.sql` before
the first run with genres.

```bash
pip install psycopg2-binary
python3 scripts/seed_supabase.py --dry-run     # count rows, write nothing
export SUPABASE_DB_URL='postgresql://...'
python3 scripts/seed_supabase.py
```

Requires dump tables to already be extracted (run `process_mb_dump.py` first to download).

## crawl_setlistfm.py

Fetches setlist/venue data from the Setlist.fm API for artists in the database.
Designed to run periodically (daily), respects API rate limits.

```bash
pip install psycopg2-binary requests
export SUPABASE_DB_URL='postgresql://...'
export SETLISTFM_API_KEY='your-key'
python3 scripts/crawl_setlistfm.py --limit 50 --pages 3
```

Options:
- `--limit N` — max artists to crawl this run (default: 100)
- `--pages N` — max pages per artist (default: 3)
