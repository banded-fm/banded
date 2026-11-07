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

## find_scenes.py

On demand: groups cities' artists into the scenes they play and record in,
each with a suggested name, a location, and what's needed to name it well.
Writes `scripts/data/scenes/scenes.json` (`--all`) or `<city>.json`
(`--city`); not used by the app yet (a map tab is the plan). Needs networkx
(`pip install networkx`) and banded-data's shows export:

```bash
# in banded-data: every act on every show, with the venue's city and coordinates
.venv/bin/concertdb export shows --musicbrainz-only     # data/export/shows.csv
# here
python3 scripts/find_scenes.py --all                     # every city with 1,000+ shows (~30 s)
python3 scripts/find_scenes.py --all --lastfm ~/Downloads/archive.zip   # + Last.fm tags
python3 scripts/find_scenes.py --city "Los Angeles" --area "Orange County"
python3 scripts/find_scenes.py --city "Portland, Maine"
python3 -m pytest scripts/test_find_scenes.py            # offline tests
```

Defaults: the shows export from `$CONCERTDB_SHOWS`, else
`~/banded-data/data/export/shows.csv`; the graph from `public/graph.db.gz`;
Last.fm from `$LASTFM_ARTISTS` (optional: the Kaggle "Music artists
popularity" dataset, 2019, keyed by MusicBrainz ID; not committed).

How it works (details in the script's docstring):

1. **Cities** are venue cities (name, state, country: Portland, Oregon is not
   Portland, Maine). `--all` takes every city with 1,000+ shows
   (`--min-shows`) that isn't within 45 km of a bigger one: Long Beach and
   Pasadena are Los Angeles, Liverpool isn't Manchester. Where two metros'
   45 km circles overlap, a city goes with the nearer one.
2. **Local artists**: a MusicBrainz area naming one of the metro's cities
   (local spellings too: Wien, München, Köln), or 3+ shows here making up
   60%+ of the artist's shows. A name several cities share (Birmingham) is
   the one the artist plays most, else the one with the most shows. Then
   artists with no city of their own (no area, or just the country or a
   state) are adopted if their ties are mostly here: 3+ in weight and two
   thirds of all their ties (Tim Commerford, "California", Rage Against the
   Machine's bassist). Each artist says why it's local: `area`, `shows` or
   `ties`.
3. **Links**: band membership 3, support musician or opening slot 2,
   producer 1, shared song credits and bills shared here 1 each (up to 3).
4. **Groups**: Louvain communities (resolution 1.5, fixed seed).
5. **Not every artist is in a scene**: one stays only if at least half its
   link weight here is inside its group and that weight is 3+. Groups under 8
   artists are dropped.
6. **For naming**: each scene's top and distinctive MusicBrainz genres; with
   `--lastfm`, its top and distinctive Last.fm tags, tags naming a place or a
   scene ("detroit techno", "la punk scene", "aggro berlin"), and its
   most-listened artists.
7. **Name** (a suggestion): place + most distinctive genre ("Detroit
   techno", "Berkeley nerdcore"), else a Last.fm style tag ("Liverpool
   merseybeat"). Names need a human pass.
8. **Location**: the venue nearest all the others where the scene's artists
   shared bills or played; else the place most of them come from; else the
   city centre.

November 2026 (`--all --lastfm`): 80 cities, 1,479 scenes (Los Angeles: 5,140
local artists, 1,729 of them adopted by ties; 2,833 in 63 scenes). Each city in the
JSON has `id`, `city`, `state`, `country`, `centre`, `radius_km`, `places`,
`shows`, `local_artists`, `local_by`, `in_scenes` and `scenes`; each scene has `id`,
`name`, `size`, `location` (`lat`, `lon`, `place`, `venue`, `source`,
`spread_km`, top `venues`), `top_genres`, `distinctive_genres` (share, lift),
`places`, `lastfm` (`top_tags`, `distinctive_tags`, `place_tags`,
`most_listened`) and `artists` (`id`, `name`, `type`, `links`, `local`).

Limits: no sense of era yet; an area is a name only, so an artist from a
smaller same-named city with no shows lands in the bigger one (Halifax, Nova
Scotia in Halifax, England).

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
