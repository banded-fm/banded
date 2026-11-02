#!/usr/bin/env python3
"""Add "opened for" edges from banded-data to the browser graph.

Reads the banded-data ledger (https://github.com/rahuljaisimha/banded-data)
directly and adds one edge per (opener, headliner) pair to public/graph.db.gz:

    edges(source = opener MBID, target = headliner MBID, rel_type = 'opened_for')

Pairs are what `concertdb export --musicbrainz-only` exports: both acts matched to
MusicBrainz, not a festival, not cancelled or postponed, both billings at or above
--min-conf (default 0.4, concertdb's export default). An act that isn't in the graph
yet is added as a node (name, type and MusicBrainz disambiguation from the ledger;
no area), so concert headliners outside the membership graph get scored too.

Safe to re-run: existing opened_for edges are replaced. Run it after
process_mb_dump.py (which rebuilds the graph without them):

    python3 scripts/add_concertdb_edges.py                       # default paths
    python3 scripts/add_concertdb_edges.py --ledger PATH --graph public/graph.db.gz

The ledger defaults to $CONCERTDB_LEDGER, else ~/banded-data/data/ledger.sqlite.
banded-data never reads the graph back: data flows one way, ledger -> graph.
"""

import argparse
import gzip
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

REL_TYPE = "opened_for"
DEFAULT_LEDGER = Path(os.environ.get("CONCERTDB_LEDGER")
                      or Path.home() / "banded-data" / "data" / "ledger.sqlite")
DEFAULT_GRAPH = Path(__file__).resolve().parent.parent / "public" / "graph.db.gz"

# Same rule as banded-data's `export --musicbrainz-only` (concertdb/export.py).
PAIRS = """
SELECT o.artist_id AS opener, h.artist_id AS headliner, COUNT(*) AS shows
FROM billings o
JOIN billings h ON h.show_id = o.show_id AND h.role = 'headliner'
JOIN shows s ON s.id = o.show_id
JOIN artists oa ON oa.id = o.artist_id
JOIN artists ha ON ha.id = h.artist_id
WHERE o.role = 'opener'
  AND s.is_festival = 0
  AND s.status NOT IN ('cancelled', 'postponed')
  AND o.confidence >= :min_conf AND h.confidence >= :min_conf
  AND oa.mbid IS NOT NULL AND ha.mbid IS NOT NULL
  AND o.artist_id != h.artist_id
GROUP BY o.artist_id, h.artist_id
"""


def node_type(ledger_type: str | None) -> str:
    """The graph's two artist types: MusicBrainz 'Person' -> person, anything else -> group."""
    return "person" if (ledger_type or "").lower() == "person" else "group"


def read_pairs(ledger: Path, min_conf: float) -> tuple[list[tuple], dict[str, tuple]]:
    """(opener, headliner, shows) pairs and the acts in them: id -> (name, type, disambiguation)."""
    conn = sqlite3.connect(f"file:{ledger}?mode=ro", uri=True)    # read-only: never touch the ledger
    try:
        pairs = conn.execute(PAIRS, {"min_conf": min_conf}).fetchall()
        ids = {a for p in pairs for a in p[:2]}
        acts = {}
        for i in range(0, len(ids), 500):
            chunk = list(ids)[i:i + 500]
            for row in conn.execute(
                    f"SELECT id, name, type, disambiguation FROM artists WHERE id IN ({','.join('?' * len(chunk))})",
                    chunk):
                acts[row[0]] = row[1:]
    finally:
        conn.close()
    return pairs, acts


def add_edges(graph_db: Path, pairs: list[tuple], acts: dict[str, tuple], ledger: Path) -> dict:
    conn = sqlite3.connect(graph_db)
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(nodes)")}
        removed = conn.execute("DELETE FROM edges WHERE rel_type = ?", (REL_TYPE,)).rowcount
        if conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'graph_meta_added_nodes'").fetchone():
            # Acts an earlier run added: dropped, then added again below if still needed.
            conn.execute("DELETE FROM nodes WHERE id IN (SELECT value FROM graph_meta_added_nodes)"
                         " AND id NOT IN (SELECT source FROM edges) AND id NOT IN (SELECT target FROM edges)")
        have = {r[0] for r in conn.execute("SELECT id FROM nodes")}

        missing = sorted({a for p in pairs for a in p[:2]} - have)
        for mbid in missing:
            name, typ, disamb = acts[mbid]
            if "disambiguation" in cols:
                conn.execute("INSERT INTO nodes (id, name, type, disambiguation) VALUES (?, ?, ?, ?)",
                             (mbid, name, node_type(typ), disamb))
            else:
                conn.execute("INSERT INTO nodes (id, name, type) VALUES (?, ?, ?)", (mbid, name, node_type(typ)))
        # count = shows the opener played before that headliner (graphs built before the
        # count column get it added here; their other edges' counts stay NULL).
        if "count" not in {r[1] for r in conn.execute("PRAGMA table_info(edges)")}:
            conn.execute("ALTER TABLE edges ADD COLUMN count INTEGER")
        conn.executemany("INSERT INTO edges (source, target, rel_type, count) VALUES (?, ?, ?, ?)",
                         [(o, h, REL_TYPE, n) for o, h, n in pairs])

        # Remember which nodes came from the ledger (so a re-run can drop stale ones), and when.
        conn.execute("DROP TABLE IF EXISTS graph_meta_added_nodes")
        conn.execute("CREATE TABLE graph_meta_added_nodes (value TEXT PRIMARY KEY)")
        conn.executemany("INSERT INTO graph_meta_added_nodes VALUES (?)", [(m,) for m in missing])
        conn.execute("CREATE TABLE IF NOT EXISTS graph_meta (key TEXT PRIMARY KEY, value TEXT)")
        conn.executemany("INSERT OR REPLACE INTO graph_meta VALUES (?, ?)", [
            ("opened_for_source", "banded-data ledger"),
            ("opened_for_added_at", datetime.now(timezone.utc).replace(microsecond=0).isoformat()),
            ("opened_for_edges", str(len(pairs))),
            ("opened_for_new_nodes", str(len(missing))),
        ])
        conn.commit()
        conn.execute("VACUUM")
    finally:
        conn.close()
    both = sum(1 for o, h, _ in pairs if o in have and h in have)
    return {"pairs": len(pairs), "both_in_graph": both, "new_nodes": len(missing), "replaced_edges": removed,
            "ledger": str(ledger)}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER, help=f"default: {DEFAULT_LEDGER}")
    p.add_argument("--graph", type=Path, default=DEFAULT_GRAPH, help="graph.db.gz, updated in place")
    p.add_argument("--min-conf", type=float, default=0.4)
    args = p.parse_args(argv)
    if not args.ledger.exists():
        print(f"no banded-data ledger at {args.ledger} (set --ledger or $CONCERTDB_LEDGER)", file=sys.stderr)
        return 1

    pairs, acts = read_pairs(args.ledger, args.min_conf)
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "graph.db"
        with gzip.open(args.graph, "rb") as src, open(db, "wb") as dst:
            shutil.copyfileobj(src, dst)
        stats = add_edges(db, pairs, acts, args.ledger)
        out = Path(tmp) / "graph.db.gz"
        with open(db, "rb") as src, gzip.open(out, "wb", compresslevel=9) as dst:
            shutil.copyfileobj(src, dst)
        shutil.move(out, args.graph)
    print(f"{stats['pairs']:,} opened_for edges ({stats['both_in_graph']:,} between artists already in the graph,"
          f" {stats['new_nodes']:,} acts added as nodes) -> {args.graph}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
