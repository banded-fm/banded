# Supabase Edge Functions

## venue-search

On-demand venue lookup for an artist in a city. Resolves artists, fetches from Setlist.fm, caches results, detects touring partners.

### Endpoint

```
GET https://lwqkjtzqjgacgvfjiyxg.supabase.co/functions/v1/venue-search
```

### Parameters

| Param | Required | Description |
|---|---|---|
| `city` | Yes | City name (e.g. "Los Angeles") |
| `artist` | One of these | Artist name (resolved against DB, then MusicBrainz) |
| `artistMbid` | One of these | MusicBrainz ID directly (avoids name ambiguity) |

### Example

```
/venue-search?artist=Ty+Segall&city=Los+Angeles
/venue-search?artistMbid=07a17571-81fc-4cf8-a634-98f0d926d313&city=Austin
```

### Response

```json
{
  "source": "cache" | "api",
  "stale": false,
  "artist": "mbid",
  "city": "Los Angeles",
  "venues": [
    { "venue": "Zebulon", "city": "Los Angeles", "country": "United States", "showCount": 12 },
    { "venue": "Lodge Room", "city": "Los Angeles", "country": "United States", "showCount": 5 }
  ]
}
```

### How it works

1. **Resolve artist**: check our DB by name → if not found, try MusicBrainz API → if found, add to our DB + log miss
2. **Check cache**: look in `crawl_log` for this artist+city. If <14 days old, return cached data.
3. **If stale or miss**: call Setlist.fm API with `cityName` filter → store venues + `played_at` relationships
4. **Detect touring partners**: check venue setlists for other artists on the same date → store `toured_with` relationships
5. **Update crawl_log** timestamp

### Artist resolution fallback

| Scenario | Action |
|---|---|
| Found in our `artists` table | Use directly |
| Not in DB, MusicBrainz resolves it | Add to `artists` table, log to `search_misses` (source: `venue-search-missing-artist`) |
| Not found anywhere (likely mistype) | Log to `search_misses` (source: `venue-search-not-found`), return 404 |

---

## pollstar-city

Discover's Pollstar data, fetched server-side and shared by every visitor through a 24-hour cache (`user_requested_data`, also read by banded-data). Replaces `pollstar-events` (venue by venue), which stays deployed, unused, until it's deleted.

```
GET https://lwqkjtzqjgacgvfjiyxg.supabase.co/functions/v1/pollstar-city?search=Berlin
GET https://lwqkjtzqjgacgvfjiyxg.supabase.co/functions/v1/pollstar-city?city=65443&page=0
```

| Query | Returns | Cached as |
|-------|---------|-----------|
| `search=<city name>` | Pollstar's autocomplete (cities, venues, artists...) | `pollstar_search`, key = lowercased search |
| `city=<id>&page=<n>` | page `n` (0–49) of the city's upcoming events, 100 a page, soonest first, today to 4 years out | `pollstar_city`, key = `<id>:<page>` |
| `city=<id>&page=<n>&from=YYYY-MM-DD&to=YYYY-MM-DD` | the same, between those dates (`from` no earlier than yesterday, `to` on or after it and no more than 4 years out) | `pollstar_city`, key = `<id>:<from>:<to>:<page>` |

Response: `{ source: "cache" | "pollstar" | "stale", fetchedAt, data }` (data is Pollstar's JSON; past events are dropped from a cached page). `503 { unavailable: true }` when Pollstar refuses and nothing is cached.

## report-miss

Lightweight endpoint for the frontend to report artists missing from the browser SQLite.

### Endpoint

```
POST https://lwqkjtzqjgacgvfjiyxg.supabase.co/functions/v1/report-miss
```

### Body

```json
{ "query": "Frankie and the Witch Fingers", "source": "sqlite-missing" }
```

### Sources

| source | Meaning | Action needed |
|---|---|---|
| `sqlite-missing` | Artist exists in Supabase but not in browser SQLite | Regenerate SQLite |
| `venue-search-missing-artist` | Not in DB, resolved via MusicBrainz, added to Supabase | Will be in SQLite on next regen |
| `venue-search-not-found` | Not found anywhere (mistype) | No action |

### Querying misses

```sql
SELECT query, source, COUNT(*) as times
FROM search_misses
WHERE source IN ('sqlite-missing', 'venue-search-missing-artist')
GROUP BY query, source
ORDER BY times DESC;
```

---

## graph-neighbors

Tier-2 graph lookup for the client's tiered `GraphAccess`: resolves an artist and its 1-hop neighbors from the `relationships` table. Used as a fallback when an artist isn't in the browser's core SQLite graph (Tier 1). If Postgres also misses, the client falls back to MusicBrainz (Tier 3).

### Endpoint

```
GET https://lwqkjtzqjgacgvfjiyxg.supabase.co/functions/v1/graph-neighbors
```

### Parameters

| Param | Required | Description |
|---|---|---|
| `mbid` | One of these | Artist MBID (preferred, unambiguous) |
| `name` | One of these | Artist name (case-insensitive, exact match preferred) |
| `log` | No | `0` skips logging a miss. The app sends it for lookups made while the browser graph is still downloading. |

### Response

```json
{
  "found": true,
  "artist": { "id": "<mbid>", "name": "The Sleeves", "type": "group" },
  "neighbors": [
    { "node": { "id": "<mbid>", "name": "Someone", "type": "person" }, "relType": "member_of", "outgoing": false }
  ]
}
```

Misses are logged to `search_misses` with source `graph-neighbors-not-found`, unless `log=0` is passed.

Besides the Tier-2 fallback, the app calls this for every artist lookup while the ~49MB browser graph is still downloading (see `src/db/graphSource.ts`), always with `log=0`.

### Search mode (artist dropdowns)

```
GET https://lwqkjtzqjgacgvfjiyxg.supabase.co/functions/v1/graph-neighbors?q=fuzz&limit=8
```

| Param | Required | Description |
|---|---|---|
| `q` | Yes | Typed text, at least 2 characters (shorter returns no artists) |
| `limit` | No | Max results, default 8, max 25 |

```json
{ "artists": [
  { "id": "<mbid>", "name": "Fuzz", "type": "group", "disambiguation": "US garage rock band", "area": "San Francisco" }
] }
```

Ranked: exact name, names starting with `q`, names with a word starting with `q`, other substring matches; shorter names first. No neighbors, and never writes to `search_misses`. `area` is null until migration 004 has run and `seed_supabase.py` has been re-run. The app asks MusicBrainz only when this returns nothing or fails (see `src/db/artistSuggest.ts`).

Relationship types returned: `member_of`, `former_member_of`, `support_musician`, `collaborated_with` and `produced_for` (from the credited artist to the record's artist; `outgoing` says which end the looked-up artist is), and `opened_for` once Postgres has it.

> Postgres is seeded (`seed_supabase.py`) with every artist within reach of the curated seeds and of banded-data's artists, never cut down for size; the browser graph is the same set, cut down to fit its 74 MB download limit when it has to be. So Postgres covers the artists the browser graph leaves out.

---

## Deployment

```bash
# Install Supabase CLI
brew install supabase/tap/supabase

# Login
supabase login

# Set secrets
supabase secrets set SETLISTFM_API_KEY=your-key --project-ref lwqkjtzqjgacgvfjiyxg

# Deploy all functions
supabase functions deploy venue-search --no-verify-jwt --project-ref lwqkjtzqjgacgvfjiyxg
supabase functions deploy report-miss --no-verify-jwt --project-ref lwqkjtzqjgacgvfjiyxg
supabase functions deploy graph-neighbors --no-verify-jwt --project-ref lwqkjtzqjgacgvfjiyxg
supabase functions deploy pollstar-city --no-verify-jwt --project-ref lwqkjtzqjgacgvfjiyxg
```

## Migrations

Run in the Supabase SQL Editor (Dashboard → SQL Editor):

1. `migrations/001_schema.sql` — artists, albums, venues, relationships tables
2. `migrations/002_crawl_log.sql` — crawl freshness tracking
3. `migrations/003_search_misses.sql` — logging unknown artist queries
4. `migrations/004_artist_search.sql` — trigram index for `graph-neighbors` search mode, `artists.area` (re-run `seed_supabase.py` after it to fill `area`)
5. `migrations/005_collaborations.sql` — removes the album table and the per-album credit rows (seed_supabase.py now writes `collaborated_with` / `produced_for` artist → artist rows with the song-credit count), and two redundant indexes. Then run `VACUUM FULL relationships;` on its own to give the space back, re-run `seed_supabase.py`, and redeploy `graph-neighbors`.
6. `migrations/006_genres.sql` — `genres` table and `artists.genre_ids` (MusicBrainz genres with 2+ votes, top 3 plus ties). Then re-run `seed_supabase.py` to fill them.
7. `migrations/007_search_misses_reader.sql` — read-only role `concertdb_misses` (can only read `search_misses`) for banded-data's nightly `misses` step. Then give it a login outside git: `ALTER ROLE concertdb_misses LOGIN PASSWORD '…'`, and set `BANDED_MISSES_DB_URL` in banded-data's `.env`.
8. `migrations/008_row_level_security.sql` — row-level security on every table, so the API's `anon` / `authenticated` roles (anyone with the anon key) can't read or change anything. Edge functions (service role), the seed scripts (table owner) and `concertdb_misses` (its own policy) are unaffected. A new table needs `ALTER TABLE … ENABLE ROW LEVEL SECURITY` too.
