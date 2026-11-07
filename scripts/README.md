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
python3 scripts/find_scenes.py --all --fetch             # once: area tree + release dates (~3 GB streamed)
python3 scripts/find_scenes.py --all                     # every city with 1,000+ shows (~4 min)
python3 scripts/find_scenes.py --all --lastfm ~/Downloads/archive.zip   # + Last.fm tags
python3 scripts/find_scenes.py --city "Los Angeles" --area "Orange County"
python3 scripts/find_scenes.py --city "Portland, Maine"
python3 -m pytest scripts/test_find_scenes.py            # offline tests
# the app's map (#/scenes, not in the menu yet): a smaller file, then to R2
python3 scripts/find_scenes.py --all --lastfm ~/Downloads/archive.zip --app public/scenes.json
npm run upload-scenes                                    # → cdn.banded.fm/scenes.json
```

`--app` writes the map's file (`public/scenes.json`, gitignored, ~2.8 MB,
~1.2 MB gzipped): each scene without its full artist list (its 12 most
connected artists as `[id, name]`) and with genre and tag names only. The
page loads `scenes.json` next to the app first (local dev), then from the CDN
next to the graph.

Defaults: the shows export from `$CONCERTDB_SHOWS`, else
`~/banded-data/data/export/shows.csv`; the graph from `public/graph.db.gz`;
MusicBrainz tables from `scripts/data/mbdump`: those `process_mb_dump.py`
keeps, plus `l_area_area` (the area tree) and `release_group_meta` (release
dates), which `--fetch` streams from the latest dumps (without them, areas are
matched by name and scenes get no era); Last.fm from `$LASTFM_ARTISTS` (optional: the Kaggle "Music
artists popularity" dataset, 2019, keyed by MusicBrainz ID; not committed).

How it works (details in the script's docstring):

1. **Cities** are venue cities (name, state, country: Portland, Oregon is not
   Portland, Maine). `--all` takes every city with 1,000+ shows
   (`--min-shows`) that isn't within 45 km of a bigger one: Long Beach and
   Pasadena are Los Angeles, Liverpool isn't Manchester. Where two metros'
   45 km circles overlap, a city goes with the nearer one.
2. **Local artists**, each marked with why:
   - `area`: its MusicBrainz area is one of the metro's cities. The area tree
     places it in its state and country (Aberdeen, Washington, not Aberdeen,
     Scotland) and walks up from a district to its city (Silver Lake → Los
     Angeles), or across to the venue city in its county (Montesano → Grays
     Harbor County → Aberdeen).
   - `nearby`: its town is in no metro, and this is the nearest within 150 km
     (`--nearby-km`): Aberdeen and Olympia count for Seattle.
   - `shows`: 3+ shows here making up 60%+ of the artist's shows.
   - `band`: a person in a local band, whatever their own area (MusicBrainz
     often has where they were born: Krist Novoselic, Compton).
   - `ties`: no city that counts anywhere, and ties mostly here (3+ in weight,
     two thirds of all its ties): Tim Commerford ("California").
3. **Links**: band membership 3, support musician or opening slot 2,
   producer 1, shared song credits and bills shared here 1 each (up to 3).
4. **Groups**: Louvain communities (resolution 1.5, fixed seed).
5. **Not every artist is in a scene**: one stays with the group most of its
   ties go to if those weigh 3+ and are at least a third of its ties here, so
   a band between two scenes stays with the stronger (Green River, with Pearl
   Jam's side). Groups under 8 artists are dropped.
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
9. **Era**: when the scene's artists started out (first release, year formed,
   or first dated band membership), weighted by their ties inside the scene,
   20th to 80th percentile, with a peak: Seattle grunge 1985–1992, Liverpool
   merseybeat 1959–1963, Detroit techno 1991–2001. A name a bigger scene took
   gets its era instead of a number: "Detroit techno (1987–1998)" for Derrick
   May's circle next to Underground Resistance's.

November 2026 (`--all --lastfm`): 80 cities, 2,917 scenes, 110,473 of 144,926
local artists in one; 2,915 have an era. Seattle: 2,354 local artists (864 by area, 108 nearby,
1,032 through their bands, 343 by ties), 1,927 in 55 scenes: Nirvana, the
Melvins and Kurt Cobain together (Aberdeen), Mudhoney's, Soundgarden and
Pearl Jam's with Green River and Mother Love Bone, Alice in Chains', and
Olympia's riot grrrl (Bikini Kill, Beat Happening).

Each city in the JSON has `id`, `city`, `state`, `country`, `centre`,
`radius_km`, `places`, `shows`, `local_artists`, `local_by`, `in_scenes` and
`scenes`; each scene has `id`, `name`, `size`, `location` (`lat`, `lon`,
`place`, `venue`, `source`, `spread_km`, top `venues`), `era` (`from`, `to`,
`peak`, `label`, `decades`, `dated_artists`), `top_genres`,
`distinctive_genres` (share, lift), `places`, `lastfm` (`top_tags`,
`distinctive_tags`, `place_tags`, `most_listened`) and `artists` (`id`,
`name`, `type`, `links`, `local`).

Limits: an era describes a scene but doesn't split one that spans
generations; an artist is in one scene at most; an area that
is only a country or state gives no city; towns over 150 km out (Ellensburg,
Screaming Trees) count for no metro.

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
