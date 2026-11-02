#!/usr/bin/env python3
"""
Seed Supabase PostgreSQL with the music graph.

Same inputs as process_mb_dump.py (load_graph_inputs): the curated seed artists
at 6 hops plus every artist with a concert in banded-data at CONCERTDB_HOPS
(default 6), over band relationships. Unlike the browser graph it is never cut
down to fit a download size: Postgres answers for the artists graph.db.gz leaves out.

Writes:
  artists        — every reachable artist (mbid, name, type, disambiguation, area,
                   genre_ids: ids into `genres`, most voted first; see pick_genres)
  genres         — every genre an artist uses (id, name), replaced on each run
  relationships  — band relationships between them (member_of, former_member_of,
                   support_musician), and collaborations from each reachable
                   artist to the artists whose records they produced or performed
                   on (produced_for, collaborated_with; `count` = song credits)

No album table and no per-album credit rows (migration 005 removes the old ones).

Usage:
    pip install psycopg2-binary
    export SUPABASE_DB_URL='postgresql://...'
    python3 scripts/seed_supabase.py            # after process_mb_dump.py has extracted the dump
    python3 scripts/seed_supabase.py --dry-run  # count the rows, write nothing (no SUPABASE_DB_URL needed)
"""

import os
import sys
from pathlib import Path

try:
    import psycopg2
    from psycopg2.extras import execute_values
except ImportError:
    psycopg2 = None              # only needed to write; --dry-run works without it

sys.path.insert(0, str(Path(__file__).parent))
import process_mb_dump as mb  # noqa: E402

BATCH_SIZE = 5000

# Needs migrations 004 (artists.area) and 006 (genres, artists.genre_ids).
ARTIST_UPSERT = (
    "INSERT INTO artists (mbid, name, type, disambiguation, country, area, genre_ids) VALUES %s "
    "ON CONFLICT (mbid) DO UPDATE SET name=EXCLUDED.name, type=EXCLUDED.type, "
    "disambiguation=EXCLUDED.disambiguation, country=EXCLUDED.country, area=EXCLUDED.area, "
    "genre_ids=EXCLUDED.genre_ids"
)
GENRE_INSERT = "INSERT INTO genres (id, name) VALUES %s"


def artist_row(d: dict) -> tuple:
    return (d["gid"], d["name"], mb.node_type(d["type"]), d["disambiguation"], None, d["area"],
            d.get("genres") or None)     # NULL, not an empty array, for no genres
REL_UPSERT = (
    "INSERT INTO relationships (source_id, target_id, rel_type, count) VALUES %s "
    "ON CONFLICT (source_id, target_id, rel_type) DO UPDATE SET count=EXCLUDED.count"
)


def get_db_url():
    url = os.environ.get("SUPABASE_DB_URL")
    if not url:
        print("ERROR: Set SUPABASE_DB_URL environment variable.")
        sys.exit(1)
    return url


def insert(conn, sql, rows, label):
    if conn is None:                     # --dry-run
        count = sum(1 for _ in rows)
        print(f"  Would write: {count} {label}")
        return count
    cur = conn.cursor()
    batch, count = [], 0
    for row in rows:
        batch.append(row)
        if len(batch) >= BATCH_SIZE:
            execute_values(cur, sql, batch)
            count += len(batch)
            batch = []
            if count % 50000 == 0:
                print(f"  {count}...")
                conn.commit()
    if batch:
        execute_values(cur, sql, batch)
        count += len(batch)
    conn.commit()
    print(f"  Done: {count} {label}")
    return count


def main():
    print("=" * 60)
    print("Banded: Seed Supabase")
    print("=" * 60)

    if not all((mb.DATA_DIR / t).exists() for t in ["mbdump/artist", *mb.DERIVED_TABLES]):
        print("ERROR: Run 'python3 scripts/process_mb_dump.py' first to download the dump.")
        sys.exit(1)

    dry_run = "--dry-run" in sys.argv[1:]
    if not dry_run and psycopg2 is None:
        print("Install psycopg2: pip install psycopg2-binary")
        sys.exit(1)
    db_url = None if dry_run else get_db_url()
    artists, relationships, collaborations, shared_only, curated, concert = mb.load_graph_inputs()
    reachable = mb.bfs_reachable(mb.seed_budgets(curated, concert, mb.CONCERTDB_HOPS), relationships, artists)

    conn = None
    if not dry_run:
        print("\nConnecting to Supabase...")
        conn = psycopg2.connect(db_url)

    # Every genre a seeded artist uses (graph artists and record artists outside it).
    owners = mb.record_artists(collaborations, reachable, shared_only)
    # A pair known only from a shared song credit is kept only when both artists are seeded.
    kept = {k: n for k, n in collaborations.items()
            if k[0] in reachable and (k not in shared_only or k[1] in reachable or k[1] in owners)}
    by_gid = {d["gid"]: d for d in artists.values()}
    names = mb.genre_names()
    used = sorted({i for g in reachable | owners if g in by_gid for i in by_gid[g].get("genres") or ()})
    print("\nSeeding genres...")
    if conn is not None:
        conn.cursor().execute("DELETE FROM genres")   # ids follow MusicBrainz's list: replace, same transaction
    insert(conn, GENRE_INSERT, ((i, names[i - 1]) for i in used), "genres")

    print("\nSeeding artists...")
    insert(conn, ARTIST_UPSERT, (artist_row(d) for d in artists.values() if d["gid"] in reachable), "artists")

    print("\nSeeding band relationships...")
    insert(conn, REL_UPSERT,
           ((a, b, rel, 1) for (a, b, rel) in mb.band_edges(relationships, artists, reachable)),
           "band relationships")

    # From a reachable artist to whoever's record it is. The record's artist may be
    # outside the graph: add it as an artist row so the edge resolves.
    print("\nSeeding collaborations...")
    insert(conn, ARTIST_UPSERT, (artist_row(by_gid[g]) for g in owners), "record artists outside the graph")
    insert(conn, REL_UPSERT, ((a, b, rel, n) for (a, b, rel), n in kept.items()), "collaborations")

    if conn:
        conn.close()
    print()
    print("=" * 60)
    print("Done! (run VACUUM FULL relationships; once after migration 005 to give the space back)")
    print("=" * 60)


if __name__ == "__main__":
    main()
