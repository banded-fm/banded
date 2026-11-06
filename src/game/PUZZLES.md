# Daily puzzles: how they were chosen

`puzzles.json` is three years of Six Degrees puzzles (1,095, one a day from
`DAILY_START` in `puzzles.ts`, then the list repeats). Each puzzle stores its start,
its end and `path`: the artists in between on the **par path**. **Par** is that
path's hops, `path.length + 1`; `puzzles.ts` works it out. This file explains how they were picked and the
testing behind it, so the list can be judged and regenerated.

## The problem

Before this, the game picked two of the 148 curated artists (`artists.ts`) of the
same type at random. It connected them only through band membership (member, former
member, supporting musician) and re-rolled anything under 3 hops. A measurement over
every pair the generator could produce, 6,027 pairs on the October 2026 graph,
showed why it felt far too hard:

| | Members only (the old game) |
|---|---|
| Average hops | 7.4 (par about 8.4) |
| 6, 8 or 10 hops | 81% of games |
| Pairs with no path within 10 hops | 32% |
| Shown path has a step with no Wikipedia article | 72% of games |
| Any shortest path through only known artists | 11% of games |

The endpoints were fine (median 65 Wikipedia editions). The middle of the path was
the problem: band membership alone spreads the graph thin, and many paths ran through
one-off collectives such as charity singles, tribute line-ups and session supergroups.
"Mark Knopfler's Guitar Heroes" alone was a step in 12% of games.

## How "well-known" is measured

**Wikipedia editions:** the number of Wikipedia language editions with an article on
the artist (Wikidata sitelinks), looked up by MusicBrainz ID (Wikidata property P434).
An artist counts as **known** with **10+ editions**. Every one of the graph's 248,647
artists was looked up: 78,319 have a Wikidata item and 18,389 are known.

**Other sources that were tried:**

- **Last.fm listener counts** (Kaggle "Music artists popularity", 1.47M artists by
  MusicBrainz ID, collected around 2019). They undercount individual band members,
  because people scrobble the band (Flea has 27k listeners against 57 Wikipedia
  editions), so they weren't used for picking puzzles.
- **A Spotify top-artists list:** too small to rate anyone but superstars.

## What was tested

1. **Excluding one-off collectives**, with the game still on band membership only.
   Collectives were spotted by size and obscurity: 10+ members, or a collective-style
   name, while the group itself has under 5 Wikipedia editions and under 20k Last.fm
   listeners. That caught 2,073 groups. Steps with no Wikipedia article dropped from
   21% to 14%, but games got longer (7.9 hops) and half of the person pairs could no
   longer connect at all. Collectives had been holding the sparse graph together.
2. **Adding the site's other link types:** featured on (credited on each other's
   records), produced, and opened for. With all of them, nearly every pair connects
   and paths are short and recognisable. This matches Explore and Similarity, so the
   game now uses **every link type**.
3. **Removing MusicBrainz's placeholder artists.** `[unknown]`, `[anonymous]`,
   `[traditional]` and the others were in the graph as if they were artists and linked
   unrelated people (Mick Jagger → [unknown] → Jack White). They were removed from the
   graph build and from Postgres (`SPECIAL_PURPOSE_ARTISTS` in
   `scripts/process_mb_dump.py`, migration 010) before these puzzles were picked.
4. **The closest connection through known artists**, not just the closest connection.
   A breadth-first search where every step in between must be a known artist (the two
   endpoints are exempt), over all link types, on the cleaned graph:

   | Hops through known artists | Share of curated pairs |
   |---|---|
   | 1 | 402 (7%) |
   | 2 | 2,979 (49%) |
   | **3** | **2,287 (38%)** |
   | **4** | **256 (4%)** |
   | **5** | **5 (0.1%)** |
   | no connection through known artists | 98 (2%) |

   For 97% of pairs, the closest connection through known artists is exactly as short
   as the closest connection of any kind. Raising "known" to 20+ editions changed the
   picture very little: 48.6% of pairs were 3–5 hops, against 47.5% at 10+.

## The puzzle rules

- **Endpoints:** two curated artists (`artists.ts`) of the same type, as before.
- **Good puzzle:** the closest connection through known artists is **3–5 hops**.
  Pairs 1–2 hops apart are too easy. That gives 2,548 candidates.
- **Par** = the hops on that connection, with no +1. A player who finds a shorter
  route, for instance through someone obscure, beats par. That is possible on 92 of
  the 1,095 days.
- **Par path:** among the closest connections through known artists, the most
  recognisable one. It maximises the least-known step, then the average of the
  others. Fame is capped at 60 editions for this, so a path through a merely famous
  artist ties with one through Michael Jackson, and the same superstars aren't on
  every path.

## The schedule

Candidates are ranked by:

1. the par path's least-known step (capped at 60);
2. then the less famous endpoint (capped at 60);
3. then the average fame of the steps in between.

Ties are broken at random with a fixed seed. Days are then filled in order, taking
the best remaining puzzle that keeps the schedule varied:

- an endpoint artist doesn't come back within 14 days, and appears at most 7 times in any 365 days;
- an artist on the par path doesn't come back within 2 days, and appears at most 14 times in any 365 days;
- every 4th day prefers a 4–5 hop puzzle.

**Result:**

| | Year 1 | Year 2 | Year 3 |
|---|---|---|---|
| Par 3 | 292 days | 327 days | 336 days |
| Par 4 | 72 days | 38 days | 29 days |
| Par 5 | 1 day | – | – |

The best puzzles go first, so later years are a little easier: only 261 of the
candidates are 4–5 hops. Across all 1,095 days the least-known step on a par path is
11 editions at worst and 72 on the median day.

- Day 0: Justin Timberlake → The Rolling Stones → Jeff Beck → Roger Waters (par 3)
- Day 3: Billie Eilish → Nicki Minaj → Fergie → Slash → Lemmy Kilmister (par 4)

## Which puzzle is on which day

`dailyPuzzle()` takes the player's local date and counts the days since
`DAILY_START` (day 0). Day *n* plays `puzzles[n % puzzles.length]`, so everyone
gets the same puzzle on the same date, and it changes at each player's midnight.

The list is longer than it needs to be so that it can be edited safely:

- **Adding:** put new puzzles at the end. Days already played keep their puzzles,
  as long as the list hasn't wrapped yet (it runs to 2029-11-04).
- **Removing:** replace the puzzle with a new one in the same place. Deleting it
  would move every later day onto a different puzzle. Past days can be edited
  freely, because nobody will see them again until the list wraps.

## Limits and next steps

- **Data snapshot:** fame is a November 2026 Wikidata snapshot, and the graph is the
  October 2026 MusicBrainz build with placeholder artists removed. Puzzles don't change
  when the graph is rebuilt. A rebuild can shorten a connection, and then par would
  be one higher than the best route.
- **Endpoints:** they are still the 148 curated artists. These are very central, so
  4–5 hop puzzles are rare. Drawing endpoints from all 18,389 known artists would give
  more variety, harder puzzles and many more years of them.
- **No player data yet:** "good" is measured, not tested on players. Feedback after
  each puzzle (thumbs up or down) would let the list improve.
- **Regenerating:** the analysis scripts live outside the repo, in the session's
  `cdb-transfer/game` and `cdb-transfer/daily` folders. To regenerate with a new graph,
  turn `gen_puzzles.py` into `scripts/generate_puzzles.py`. It needs the cleaned
  `graph.db` and a fresh Wikidata sitelinks lookup, which takes about 20 minutes.
