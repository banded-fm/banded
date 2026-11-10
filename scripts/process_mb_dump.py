#!/usr/bin/env python3
"""
MusicBrainz Data Dump Processor
================================

Builds the browser graph (public/graph.db.gz) from the MusicBrainz data dump.
seed_supabase.py builds Postgres from the same inputs (load_graph_inputs).

Usage:
    python3 scripts/process_mb_dump.py                      # then: python3 scripts/add_concertdb_edges.py
    python3 scripts/process_mb_dump.py --concertdb-hops 2   # fewer hops around banded-data's artists

Requirements:
    - Python 3.10+
    - ~25GB free disk space (download + extracted tables), ~10GB RAM
    - Internet connection (for the initial download)
    - Optional: a banded-data ledger (CONCERTDB_LEDGER, default
      ~/banded-data/data/ledger.sqlite); without it only the curated seeds are used

Which artists: every artist within 6 hops of the curated seeds (src/game/artists.ts, by MBID)
and of each artist with a concert in banded-data (CONCERTDB_HOPS, default 6),
over band relationships (member of / supporting musician), plus the artists whose
records they played on or produced (record_artists: e.g. Zach Bryan, reached only
through the musicians on his records). If graph.db.gz comes out over MAX_GZIP_MB,
it is rebuilt with one hop fewer around banded-data's artists until it fits;
Supabase keeps the full set.

Edges: band relationships, plus collaborations: a producer / vocal / instrument / performer
credit on another artist's record becomes one "produced_for" or
"collaborated_with" edge to that record's artist, and a song credited to several
artists ("Evan Honer & Wyatt Flores", "A feat. B") becomes a "collaborated_with"
edge from each of the others to the first-credited artist (see build_collaborations).

Genres: each artist's MusicBrainz genres (tags that are on MusicBrainz's genre
list) with at least MIN_GENRE_VOTES votes, most voted first: the top
TOP_GENRES, plus any tied with the last of them (see pick_genres). Votes come
from the derived dump (mbdump-derived: tag, artist_tag); the genre list is
fetched once from the MusicBrainz API and cached in scripts/data/genres.txt.
A genre's id is its position in that sorted list, so the ids can change when
MusicBrainz adds genres: rebuild the graph and re-seed Postgres together.
"""

import os
import gzip
import urllib.request
import tarfile
import shutil
from pathlib import Path
from collections import defaultdict

# --- Configuration ---

# Base URL for MusicBrainz dump (use latest available)
DUMP_BASE_URL = "https://data.metabrainz.org/pub/musicbrainz/data/fullexport/LATEST"
DUMP_MIRROR = "https://data.metabrainz.org/pub/musicbrainz/data/fullexport"

# Output paths
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DATA_DIR = SCRIPT_DIR / "data"
OUTPUT_FILE = PROJECT_DIR / "public" / "graph.db"

# Genres (see pick_genres)
MIN_GENRE_VOTES = 2          # a genre one person tagged is too noisy to keep
TOP_GENRES = 3               # plus any tied with the third
GENRE_LIST_URL = "https://musicbrainz.org/ws/2/genre/all?fmt=txt"
GENRES_FILE = DATA_DIR / "genres.txt"
DERIVED_TABLES = ["mbdump/tag", "mbdump/artist_tag"]
USER_AGENT = "Banded/0.1 ( https://banded.fm )"

# Relationship types we care about for artist-to-artist (from MusicBrainz link_type table)
RELEVANT_ARTIST_ARTIST_TYPES = {
    "member of band",
    "supporting musician",
}

# Relationship types we care about for artist-to-recording credits
# Credits kept (see COLLAB_REL_TYPES): producing and performing. Engineering
# credits (mix, engineer, recording) are left out.
RELEVANT_ARTIST_RECORDING_TYPES = {
    "producer",
    "vocal",
    "instrument",
    "performer",
}


def get_latest_dump_url():
    """Get the URL of the latest full export."""
    print("Finding latest dump...")
    try:
        with urllib.request.urlopen(DUMP_BASE_URL) as resp:
            latest = resp.read().decode().strip()
        return f"{DUMP_MIRROR}/{latest}"
    except Exception:
        # Fallback: list directory and pick latest
        print("Could not read LATEST file, will need manual URL.")
        raise


def download_file(url: str, dest: Path):
    """Download a file with progress indication."""
    if dest.exists():
        print(f"  Already downloaded: {dest.name}")
        return

    print(f"  Downloading: {url}")
    print(f"  To: {dest}")

    def reporthook(block_num, block_size, total_size):
        downloaded = block_num * block_size
        if total_size > 0:
            pct = min(100, downloaded * 100 // total_size)
            mb = downloaded / (1024 * 1024)
            print(f"\r  {pct}% ({mb:.1f} MB)", end="", flush=True)

    urllib.request.urlretrieve(url, dest, reporthook)
    print()


def download_dump_tables(dump_url: str):
    """Download only the tables we need from the dump. Skips if already present."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    tables_needed = [
        "mbdump/area",
        "mbdump/artist",
        "mbdump/artist_credit_name",
        "mbdump/l_artist_artist",
        "mbdump/l_artist_recording",
        "mbdump/link",
        "mbdump/link_type",
        "mbdump/recording",
        "mbdump/track",
        "mbdump/medium",
        "mbdump/release",
        "mbdump/release_group",
    ]

    # Check if all tables are already extracted
    all_extracted = all((DATA_DIR / t).exists() for t in tables_needed)
    if all_extracted:
        print("All required tables already extracted. Skipping download.")
        return

    # Check which tables are missing
    missing = [t for t in tables_needed if not (DATA_DIR / t).exists()]
    print(f"Missing tables: {', '.join(t.split('/')[1] for t in missing)}")

    # Check if we already have a downloaded tar file
    tar_path_zst = DATA_DIR / "mbdump.tar.zst"
    tar_path_bz2 = DATA_DIR / "mbdump.tar.bz2"
    tar_path_plain = DATA_DIR / "mbdump.tar"

    tar_path = None
    if tar_path_plain.exists():
        tar_path = tar_path_plain
        print(f"Found existing decompressed tar: {tar_path.name}")
    elif tar_path_zst.exists():
        tar_path = tar_path_zst
        print(f"Found existing compressed tar: {tar_path.name}")
    elif tar_path_bz2.exists():
        tar_path = tar_path_bz2
        print(f"Found existing compressed tar: {tar_path.name}")
    else:
        # Need to download
        tar_url = f"{dump_url}/mbdump.tar.zst"
        tar_path = tar_path_zst
        try:
            download_file(tar_url, tar_path)
        except Exception:
            tar_url = f"{dump_url}/mbdump.tar.bz2"
            tar_path = tar_path_bz2
            download_file(tar_url, tar_path)

    # Extract missing tables
    print(f"Extracting missing tables from {tar_path.name}...")

    if tar_path.suffix == ".zst":
        # Decompress zst → tar first
        if not tar_path_plain.exists():
            print("  Decompressing .tar.zst (this may take a while)...")
            ret = os.system(f"zstd -d '{tar_path}' -o '{tar_path_plain}'")
            if ret != 0:
                raise RuntimeError("zstd decompression failed. Install with: brew install zstd")
        tar_path = tar_path_plain

    if str(tar_path).endswith(".tar.bz2"):
        open_mode = "r:bz2"
    else:
        open_mode = "r:"

    with tarfile.open(tar_path, open_mode) as tar:
        for member in tar.getmembers():
            if member.name in missing:
                print(f"  Extracting: {member.name}")
                tar.extract(member, DATA_DIR)

    # Verify all extracted
    still_missing = [t for t in tables_needed if not (DATA_DIR / t).exists()]
    if still_missing:
        raise RuntimeError(f"Failed to extract: {still_missing}")


def download_derived_tables(dump_url: str):
    """The tag tables from the derived dump (~0.5 GB, artists' tag votes). Skips if present."""
    missing = [t for t in DERIVED_TABLES if not (DATA_DIR / t).exists()]
    if not missing:
        print("Tag tables already extracted. Skipping the derived dump.")
        return
    tar_path = DATA_DIR / "mbdump-derived.tar.bz2"
    download_file(f"{dump_url}/mbdump-derived.tar.bz2", tar_path)
    print(f"Extracting {', '.join(missing)} from {tar_path.name}...")
    # Streamed with Python's bz2 (no bzip2 binary needed); stops once both tables are out.
    with tarfile.open(tar_path, "r|bz2") as tar:
        for member in tar:
            if member.name in missing:
                print(f"  Extracting: {member.name}")
                tar.extract(member, DATA_DIR)
                missing.remove(member.name)
                if not missing:
                    break
    if missing:
        raise RuntimeError(f"Failed to extract: {missing}")
    tar_path.unlink()


def genre_names() -> list[str]:
    """MusicBrainz's genre list, sorted. A genre's id is its position + 1.
    Fetched once (one API request) and cached in GENRES_FILE."""
    if not GENRES_FILE.exists():
        print("Fetching MusicBrainz's genre list...")
        req = urllib.request.Request(GENRE_LIST_URL, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode("utf-8")
        GENRES_FILE.parent.mkdir(parents=True, exist_ok=True)
        GENRES_FILE.write_text(text, encoding="utf-8")
    return sorted({line.strip() for line in GENRES_FILE.read_text(encoding="utf-8").splitlines() if line.strip()})


def pick_genres(votes: list[tuple[int, str]]) -> list[str]:
    """An artist's genres from (votes, genre) pairs: those with MIN_GENRE_VOTES or more,
    most voted first (ties alphabetical), the top TOP_GENRES plus any tied with the last."""
    kept = sorted((v for v in votes if v[0] >= MIN_GENRE_VOTES), key=lambda v: (-v[0], v[1]))
    if len(kept) > TOP_GENRES:
        cutoff = kept[TOP_GENRES - 1][0]
        kept = [v for v in kept if v[0] >= cutoff]
    return [g for _, g in kept]


def parse_artist_genres(data_dir: Path, artists: dict[int, dict], names: list[str]) -> int:
    """Set artists[id]["genres"] to genre ids (most voted first) for artists that have
    any (see pick_genres). Returns how many artists got genres."""
    genre_id = {n: i + 1 for i, n in enumerate(names)}
    tag_genre = {}
    with open(data_dir / "mbdump" / "tag", "r", encoding="utf-8") as f:
        for line in f:
            # id | name | ref_count
            parts = line.rstrip("\n").split("\t")
            if len(parts) > 1 and parts[1] in genre_id:
                tag_genre[int(parts[0])] = parts[1]
    votes: dict[int, list[tuple[int, str]]] = defaultdict(list)
    with open(data_dir / "mbdump" / "artist_tag", "r", encoding="utf-8") as f:
        for line in f:
            # artist | tag | count | last_updated
            parts = line.split("\t", 3)
            tag, count = int(parts[1]), int(parts[2])
            if tag in tag_genre and count > 0:
                votes[int(parts[0])].append((count, tag_genre[tag]))
    n = 0
    for aid, v in votes.items():
        picked = pick_genres(v)
        if picked and aid in artists:
            artists[aid]["genres"] = [genre_id[g] for g in picked]
            n += 1
    print(f"  {n} artists with genres ({len(tag_genre)} genre tags)")
    return n


def parse_link_types(data_dir: Path) -> dict[int, str]:
    """Parse link_type table to get relationship type names by ID."""
    link_types = {}
    link_type_file = data_dir / "mbdump" / "link_type"

    print("Parsing link_type table...")
    with open(link_type_file, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) >= 4:
                type_id = int(parts[0])
                # Column indices: id, parent, child_order, gid, entity_type0, entity_type1, name, ...
                # name is at index 6
                if len(parts) > 6:
                    name = parts[6]
                    link_types[type_id] = name

    print(f"  Found {len(link_types)} link types")
    return link_types


def parse_links(data_dir: Path) -> dict[int, tuple[int, bool]]:
    """Parse link table to map link_id → (link_type_id, ended)."""
    links = {}
    link_file = data_dir / "mbdump" / "link"

    print("Parsing link table...")
    with open(link_file, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) >= 11:
                link_id = int(parts[0])
                link_type_id = int(parts[1])
                ended = parts[10] == "t"
                links[link_id] = (link_type_id, ended)

    print(f"  Found {len(links)} links")
    return links


def parse_areas(data_dir: Path) -> dict[int, str]:
    """Parse area table (countries, cities, ...). Returns dict of area_id → name."""
    areas = {}
    with open(data_dir / "mbdump" / "area", "r", encoding="utf-8") as f:
        for line in f:
            # Columns: id, gid, name, type, ...
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 3:
                areas[int(parts[0])] = parts[2]
    print(f"  Found {len(areas)} areas")
    return areas


def parse_artists(data_dir: Path, areas: dict[int, str]) -> dict[int, dict]:
    """
    Parse artist table. Returns dict of artist_id → {name, type, gid,
    disambiguation, area}. `area` is the begin area (usually a city: where a
    band formed or a person was born), else the artist's area (often a country).
    Both label artists in the app's search dropdowns.
    """
    artists = {}
    artist_file = data_dir / "mbdump" / "artist"

    print("Parsing artist table...")
    with open(artist_file, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) >= 5:
                # Columns: id, gid, name, sort_name, begin_date_year, ...
                # type is at a specific index - need to check schema
                # Schema: id | gid | name | sort_name | begin_date_year | begin_date_month |
                #         begin_date_day | end_date_year | end_date_month | end_date_day |
                #         type | area | gender | comment | edits_pending | last_updated |
                #         ended | begin_area | end_area
                artist_id = int(parts[0])
                gid = parts[1]  # MBID
                name = parts[2]
                # Type: 1=Person, 2=Group, 3=Orchestra, 4=Choir, 5=Character, 6=Other
                artist_type = parts[10] if len(parts) > 10 and parts[10] != "\\N" else None
                comment = parts[13] if len(parts) > 13 and parts[13] != "\\N" else ""
                area_name = None
                for idx in (17, 11):  # begin_area, then area
                    if len(parts) > idx and parts[idx] != "\\N":
                        area_name = areas.get(int(parts[idx]))
                        if area_name:
                            break

                artists[artist_id] = {
                    "name": name,
                    "gid": gid,
                    "type": artist_type,
                    "disambiguation": comment or None,
                    "area": area_name,
                }

    print(f"  Found {len(artists)} artists")
    return artists


def parse_artist_relationships(
    data_dir: Path,
    links: dict[int, tuple[int, bool]],
    link_types: dict[int, str],
    relevant_type_ids: set[int],
) -> list[tuple[int, int, str, bool]]:
    """Parse l_artist_artist table. Returns list of (artist0_id, artist1_id, rel_type_name, ended)."""
    relationships = []
    rel_file = data_dir / "mbdump" / "l_artist_artist"

    print("Parsing l_artist_artist table...")
    with open(rel_file, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) >= 4:
                # Columns: id, link_id, entity0, entity1, ...
                link_id = int(parts[1])
                entity0 = int(parts[2])
                entity1 = int(parts[3])

                link_info = links.get(link_id)
                if link_info:
                    link_type_id, ended = link_info
                    if link_type_id in relevant_type_ids:
                        type_name = link_types[link_type_id]
                        relationships.append((entity0, entity1, type_name, ended))

    print(f"  Found {len(relationships)} relevant relationships")
    return relationships


def build_recording_to_release_group(data_dir: Path) -> dict[int, int]:
    """
    Build a mapping from recording_id → release_group_id.
    Chain: recording → track → medium → release → release_group
    """
    print("Building recording → release_group mapping...")

    # Step 1: track → (recording_id, medium_id)
    # track columns: id | gid | recording | medium | position | number | name | artist_credit | length | ...
    print("  Parsing track table...")
    recording_to_medium = {}  # recording_id → medium_id (first encountered)
    track_file = data_dir / "mbdump" / "track"
    with open(track_file, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) >= 4:
                recording_id = int(parts[2])
                medium_id = int(parts[3])
                if recording_id not in recording_to_medium:
                    recording_to_medium[recording_id] = medium_id

    print(f"    {len(recording_to_medium)} recordings mapped to media")

    # Step 2: medium → release_id
    # medium columns: id, release, position, format, name, ...
    print("  Parsing medium table...")
    medium_to_release = {}
    medium_file = data_dir / "mbdump" / "medium"
    with open(medium_file, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) >= 2:
                medium_id = int(parts[0])
                release_id = int(parts[1])
                medium_to_release[medium_id] = release_id

    print(f"    {len(medium_to_release)} media mapped to releases")

    # Step 3: release → release_group_id
    # release columns: id | gid | name | artist_credit | release_group | status | ...
    print("  Parsing release table...")
    release_to_rg = {}
    release_file = data_dir / "mbdump" / "release"
    with open(release_file, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) >= 5:
                release_id = int(parts[0])
                try:
                    release_group_id = int(parts[4])
                except ValueError:
                    continue
                release_to_rg[release_id] = release_group_id

    print(f"    {len(release_to_rg)} releases mapped to release groups")

    # Step 4: Parse release_group for names
    # release_group columns: id, gid, name, artist_credit, type, ...
    print("  Parsing release_group table...")
    release_groups = {}  # rg_id → {gid, name, artist_credit}
    rg_file = data_dir / "mbdump" / "release_group"
    with open(rg_file, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) >= 4:
                rg_id = int(parts[0])
                rg_gid = parts[1]
                rg_name = parts[2]
                try:
                    artist_credit = int(parts[3])
                except ValueError:
                    artist_credit = None
                release_groups[rg_id] = {"gid": rg_gid, "name": rg_name, "artist_credit": artist_credit}

    print(f"    {len(release_groups)} release groups")

    # Combine: recording_id → release_group_id
    recording_to_rg = {}
    for rec_id, med_id in recording_to_medium.items():
        rel_id = medium_to_release.get(med_id)
        if rel_id:
            rg_id = release_to_rg.get(rel_id)
            if rg_id:
                recording_to_rg[rec_id] = rg_id

    print(f"  Final mapping: {len(recording_to_rg)} recordings → release groups")
    return recording_to_rg, release_groups


def parse_artist_credit_name(data_dir: Path) -> dict[int, int]:
    """
    Parse artist_credit_name table.
    Returns mapping of artist_credit_id → artist_id (first/primary artist for that credit).
    
    artist_credit_name columns: artist_credit | position | artist | name | join_phrase
    We take position=0 (the primary credited artist).
    """
    credit_to_artist = {}
    acn_file = data_dir / "mbdump" / "artist_credit_name"

    print("Parsing artist_credit_name table...")
    with open(acn_file, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) >= 3:
                credit_id = int(parts[0])
                position = int(parts[1])
                artist_id = int(parts[2])
                # Only keep position 0 (primary artist)
                if position == 0:
                    credit_to_artist[credit_id] = artist_id

    print(f"  Found {len(credit_to_artist)} artist credits (primary)")
    return credit_to_artist


def parse_shared_credits(data_dir: Path) -> dict[int, list[int]]:
    """artist_credit id -> its artists in credit order, for credits naming two or
    more artists ("Evan Honer & Wyatt Flores", "A feat. B")."""
    acn_file = data_dir / "mbdump" / "artist_credit_name"
    print("Parsing artist_credit_name table (credits naming several artists)...")
    multi = set()
    with open(acn_file, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.split("\t", 3)
            if len(parts) >= 3 and parts[1] != "0":
                multi.add(int(parts[0]))
    names: dict[int, list[tuple[int, int]]] = defaultdict(list)
    with open(acn_file, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.split("\t", 3)
            if len(parts) >= 3:
                credit_id = int(parts[0])
                if credit_id in multi:
                    names[credit_id].append((int(parts[1]), int(parts[2])))
    shared = {}
    for credit_id, rows in names.items():
        ids = list(dict.fromkeys(artist for _, artist in sorted(rows)))
        if len(ids) >= 2:
            shared[credit_id] = ids
    print(f"  Found {len(shared)} artist credits naming two or more artists")
    return shared


def parse_shared_songs(data_dir: Path, shared: dict[int, list[int]]) -> list[tuple[int, list[int]]]:
    """(recording id, its artists in credit order) for every song credited to several artists."""
    # recording columns: id | gid | name | artist_credit | length | ...
    songs = []
    print("Parsing recording table (songs credited to several artists)...")
    with open(data_dir / "mbdump" / "recording", "r", encoding="utf-8") as f:
        for line in f:
            parts = line.split("\t", 4)
            if len(parts) >= 4:
                try:
                    ids = shared.get(int(parts[3]))
                except ValueError:
                    continue
                if ids:
                    songs.append((int(parts[0]), ids))
    print(f"  Found {len(songs)} songs credited to several artists")
    return songs


def parse_artist_recording_relationships(
    data_dir: Path,
    links: dict[int, tuple[int, bool]],
    link_types: dict[int, str],
    relevant_type_ids: set[int],
) -> list[tuple[int, int, str]]:
    """Parse l_artist_recording table. Returns list of (artist_id, recording_id, rel_type_name)."""
    relationships = []
    rel_file = data_dir / "mbdump" / "l_artist_recording"

    print("Parsing l_artist_recording table...")
    with open(rel_file, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) >= 4:
                # Columns: id, link_id, entity0 (artist), entity1 (recording), ...
                link_info = links.get(int(parts[1]))
                if link_info and link_info[0] in relevant_type_ids:
                    relationships.append((int(parts[2]), int(parts[3]), link_types[link_info[0]]))

    print(f"  Found {len(relationships)} relevant artist-recording relationships")
    return relationships


# --- Collaborations ----------------------------------------------------------
#
# A credit on someone else's record becomes one edge from the credited artist to
# the album's (release group's) first credited artist, e.g. Josh Homme -> Arctic
# Monkeys for producing and playing on Humbug. Producing and performing are kept
# apart; engineering credits (mix, engineer, recording) are left out. `count` is
# the number of song credits behind the edge (one per credited recording, per role).
# Albums aren't stored: no album nodes, no album table.
#
# A song credited to several artists ("Evan Honer & Wyatt Flores") is a
# collaboration too, even without a vocal / instrument credit: one
# "collaborated_with" edge from each of the other artists to the first-credited
# one, one count per song. A song already counted through a performing credit by
# the same artist isn't counted twice.

COLLAB_REL_TYPES = {
    "producer": "produced_for",        # produced their record
    "vocal": "collaborated_with",      # sang on their record
    "instrument": "collaborated_with", # played on their record
    "performer": "collaborated_with",  # performed on it (MusicBrainz's general performance credit)
}
VARIOUS_ARTISTS = "89ad4ac3-39f7-470e-963a-56509c546377"

# MusicBrainz's special purpose artists: placeholders credited when the real artist
# is unknown or isn't an artist at all ([unknown], [anonymous], [traditional]...).
# They are credited on thousands of records, so left in they would link artists
# who have nothing in common (Mick Jagger -> [unknown] -> Jack White). Dropped with
# all their relationships and credits. (MusicBrainz lists them by the comment
# "Special Purpose Artist"; there is no flag in the dump.)
SPECIAL_PURPOSE_ARTISTS = frozenset({
    VARIOUS_ARTISTS,
    "f731ccc4-e22a-43af-a747-64213329e088",  # [anonymous]
    "33cf029c-63b0-41a0-9855-be2a3665fb3b",  # [data]
    "314e1c25-dde7-4e4d-b2f4-0a7b9f7c56dc",  # [dialogue]
    "eec63d3c-3b81-4ad4-b1e4-7c147d4d2b61",  # [no artist]
    "9be7f096-97ec-4615-8957-8d40b5dcbc41",  # [traditional]
    "125ec42a-7229-4250-afc5-e057484327fe",  # [unknown]
    "66ea0139-149f-4a0c-8fbf-5ea9ec4a6e49",  # [Disney]
    "a0ef7e1d-44ff-4039-9435-7d5fefdeecc9",  # [theatre]
    "90068d37-bae7-4292-be4a-704c145bd616",  # [church chimes]
    "80a8851f-444c-4539-892b-ad2a49292aa9",  # [language instruction]
    "459a4aa6-b6b7-4c89-a42b-03acddbe1f80",  # [unknown animal]
    "7e84f845-ac16-41fe-9ff8-df12eb32af55",  # MusicBrainz Test Artist
})


def drop_special_purpose_artists(artists: dict[int, dict], relationships: list) -> list:
    """Remove the special purpose artists from `artists` (in place) and return the
    relationships without them. Credits to or by them are dropped later because
    the collaboration builders skip artist ids that aren't in `artists`."""
    special = {aid for aid, d in artists.items() if d["gid"] in SPECIAL_PURPOSE_ARTISTS}
    for aid in special:
        del artists[aid]
    kept = [r for r in relationships if r[0] not in special and r[1] not in special]
    print(f"  Dropped {len(special)} special purpose artists and {len(relationships) - len(kept)} of their relationships")
    return kept


def build_collaborations(
    artist_recording_rels: list[tuple[int, int, str]],
    recording_to_rg: dict[int, int],
    release_groups: dict[int, dict],
    credit_to_artist: dict[int, int],
    artists: dict[int, dict],
    relationships: list[tuple[int, int, str, bool]] = (),
    shared_songs: list[tuple[int, list[int]]] = (),
) -> tuple[dict[tuple[str, str, str], int], set[tuple[str, str, str]]]:
    """(contributor MBID, album artist MBID, rel_type) -> number of song credits,
    and the pairs that come only from shared songs.

    shared_songs: (recording id, artists in credit order) for songs credited to
    several artists; each artist after the first gets a collaborated_with credit
    to the first, unless they already have a performing credit on that song.
    Pairs known only from shared songs don't bring new artists into the graph
    (see record_artists): there are about twice as many as all the other
    collaborations, and adding their artists made graph.db.gz ~40 MB bigger.

    Skipped: credits on an artist's own records, credits between a band and its
    (current or former) members (the member_of / former_member_of edge already
    says it; a member is credited on most of the band's records anyway), credits
    on "Various Artists" compilations, and credits by entities without their own
    artist entry.
    """
    print("Building collaborations (credited artist -> album artist)...")
    members = set()
    for e0, e1, rel_type, _ in relationships:
        if rel_type == "member of band":
            members.add((e0, e1))
            members.add((e1, e0))
    counts: dict[tuple[str, str, str], int] = defaultdict(int)
    skipped_members = 0
    for artist_id, recording_id, credit in artist_recording_rels:
        rel = COLLAB_REL_TYPES.get(credit)
        if rel is None or artist_id not in artists:
            continue
        rg = recording_to_rg.get(recording_id)
        info = release_groups.get(rg) if rg is not None else None
        if not info:
            continue
        owner = credit_to_artist.get(info.get("artist_credit"))
        if owner is None or owner == artist_id or owner not in artists:
            continue
        if (artist_id, owner) in members:
            skipped_members += 1
            continue
        owner_gid = artists[owner]["gid"]
        if owner_gid == VARIOUS_ARTISTS:
            continue
        counts[(artists[artist_id]["gid"], owner_gid, rel)] += 1
    shared_recordings = {recording_id for recording_id, _ in shared_songs}
    performed = {(artist_id, recording_id) for artist_id, recording_id, credit in artist_recording_rels
                 if recording_id in shared_recordings and COLLAB_REL_TYPES.get(credit) == "collaborated_with"}
    before = set(counts)
    shared_credits = 0
    for recording_id, ids in shared_songs:
        owner = ids[0]
        if owner not in artists or artists[owner]["gid"] == VARIOUS_ARTISTS:
            continue
        owner_gid = artists[owner]["gid"]
        for artist_id in ids[1:]:
            if artist_id not in artists or (artist_id, recording_id) in performed:
                continue
            if (artist_id, owner) in members:
                skipped_members += 1
                continue
            counts[(artists[artist_id]["gid"], owner_gid, "collaborated_with")] += 1
            shared_credits += 1
    by_type = defaultdict(int)
    for (_, _, rel) in counts:
        by_type[rel] += 1
    print(f"  Collaborations: {len(counts)} ({dict(by_type)}); {skipped_members} song credits between"
          " a band and its members skipped")
    shared_only = set(counts) - before
    print(f"  Songs credited to several artists: {shared_credits} credits, {len(shared_only)} new pairs")
    return counts, shared_only


# --- Which artists are in the graph -------------------------------------------

# Curated seed artists: the Six Degrees game's list (src/game/artists.ts), by
# MusicBrainz ID; plus the artists with concerts in banded-data
# (https://github.com/banded-fm/banded-data), read from its ledger. The
# graph is every artist within a seed's hop budget over band relationships
# (member of / supporting musician).
GAME_ARTISTS_FILE = PROJECT_DIR / "src" / "game" / "artists.ts"


def curated_seed_list(path: Path = GAME_ARTISTS_FILE) -> list[tuple[str, str]]:
    """(name, MBID) of every entry in src/game/artists.ts."""
    import re

    entries = re.findall(r'name:\s*"((?:[^"\\]|\\.)*)"[^}]*?mbid:\s*"([0-9a-f-]{36})"', path.read_text(encoding="utf-8"))
    if not entries:
        raise RuntimeError(f"no artists with an mbid in {path}")
    return entries


CURATED_HOPS = 6
CONCERTDB_HOPS = int(os.environ.get("CONCERTDB_HOPS") or 6)
CONCERTDB_LEDGER = Path(os.environ.get("CONCERTDB_LEDGER")
                        or Path.home() / "banded-data" / "data" / "ledger.sqlite")
# The browser download (graph.db.gz). If the graph comes out bigger, it is rebuilt
# with fewer hops around banded-data's artists (Supabase keeps them all and
# answers for the rest). The app downloads it in the background (preloadDb) and
# answers from Supabase until it has loaded, so a bigger file only delays the
# local graph, it doesn't block the page.
MAX_GZIP_MB = 74

TYPE_MAP = {"1": "person", "2": "group", "3": "group", "4": "group", "5": "person", "6": "person"}


def node_type(raw_type: str | None) -> str:
    """MusicBrainz artist type id -> "person" | "group"."""
    return TYPE_MAP.get(raw_type, "person") if raw_type else "person"


def resolve_curated_seeds(artists: dict[int, dict]) -> set[str]:
    """The curated seeds' MBIDs that are in this dump (a merged or deleted
    MusicBrainz artist is reported, not silently swapped for a namesake)."""
    known = {data["gid"] for data in artists.values()}
    entries = curated_seed_list()
    seeds = set()
    for name, mbid in entries:
        if mbid in known:
            seeds.add(mbid)
        else:
            print(f"  WARNING: curated seed {name} ({mbid}) is not in this dump: update src/game/artists.ts")
    print(f"  Curated seeds: {len(seeds)} / {len(entries)}")
    return seeds


def concertdb_seeds(ledger: Path, artists: dict[int, dict]) -> set[str]:
    """MusicBrainz IDs of artists with at least one concert in the banded-data
    ledger (read-only). Empty, with a warning, if there is no ledger."""
    import sqlite3

    if not ledger.exists():
        print(f"  WARNING: no banded-data ledger at {ledger}: curated seeds only"
              " (set CONCERTDB_LEDGER)")
        return set()
    conn = sqlite3.connect(f"file:{ledger}?mode=ro", uri=True)
    try:
        mbids = {r[0] for r in conn.execute(
            "SELECT DISTINCT a.mbid FROM billings b JOIN artists a ON a.id = b.artist_id"
            " WHERE a.mbid IS NOT NULL")}
    finally:
        conn.close()
    known = {data["gid"] for data in artists.values()}
    seeds = mbids & known
    print(f"  banded-data seeds: {len(seeds)} artists with concerts ({len(mbids) - len(seeds)} not in this dump)")
    return seeds


def seed_budgets(curated: set[str], concert: set[str], concert_hops: int) -> dict[str, int]:
    budgets = {gid: concert_hops for gid in concert}
    for gid in curated:
        budgets[gid] = max(budgets.get(gid, 0), CURATED_HOPS)
    return budgets


def record_artists(collaborations: dict[tuple[str, str, str], int], reachable: set[str],
                   shared_only: set[tuple[str, str, str]] = frozenset()) -> set[str]:
    """Artists outside `reachable` whose records a reachable artist played on or produced.

    Pairs in `shared_only` (known only from a song credited to both) don't count:
    their edges are kept only when both artists are in the graph anyway.

    The browser graph and Postgres both include them (with those collaborations),
    so an artist known only through the records others worked on (e.g. Zach Bryan,
    whose records Bruce Springsteen and Kyle Nix played on) is there too.
    """
    return {key[1] for key in collaborations if key[0] in reachable and key not in shared_only} - reachable


def bfs_reachable(
    budgets: dict[str, int],
    relationships: list[tuple[int, int, str, bool]],
    artists: dict[int, dict],
) -> set[str]:
    """Every artist within some seed's hop budget over band relationships
    (member of / supporting musician). budgets: seed MBID -> hops."""
    gid_to_id = {data["gid"]: aid for aid, data in artists.items()}
    adjacency: dict[int, set[int]] = defaultdict(set)
    for e0, e1, _, _ in relationships:
        adjacency[e0].add(e1)
        adjacency[e1].add(e0)

    # A node keeps the largest budget it is reached with; expand from the biggest first.
    best: dict[int, int] = {}
    for gid, hops in budgets.items():
        aid = gid_to_id.get(gid)
        if aid is not None:
            best[aid] = max(best.get(aid, -1), hops)
    buckets: dict[int, set[int]] = defaultdict(set)
    for aid, hops in best.items():
        buckets[hops].add(aid)
    for hops in range(max(buckets, default=0), 0, -1):
        for aid in buckets.pop(hops, ()):
            if best.get(aid) != hops:
                continue
            for neighbor in adjacency.get(aid, ()):
                if best.get(neighbor, -1) < hops - 1:
                    best[neighbor] = hops - 1
                    buckets[hops - 1].add(neighbor)

    reachable = {artists[aid]["gid"] for aid in best}
    print(f"  BFS from {len(budgets)} seeds: {len(reachable)} artists")
    return reachable


def band_edges(relationships, artists, reachable_gids):
    """(source MBID, target MBID, rel_type) for band relationships between reachable
    artists, deduplicated. A membership is current if ANY of its MusicBrainz
    relationships hasn't ended (so Dave Grohl isn't a former member of Foo Fighters)."""
    id_to_gid = {aid: data["gid"] for aid, data in artists.items() if data["gid"] in reachable_gids}
    current: dict[tuple[str, str], bool] = {}
    for e0, e1, rel_type, ended in relationships:
        if rel_type == "member of band" and e0 in id_to_gid and e1 in id_to_gid:
            key = (id_to_gid[e0], id_to_gid[e1])
            current[key] = current.get(key, False) or not ended
    seen = set()
    for e0, e1, rel_type, ended in relationships:
        gid0, gid1 = id_to_gid.get(e0), id_to_gid.get(e1)
        if not gid0 or not gid1:
            continue
        if rel_type == "member of band":
            mapped = "member_of" if current[(gid0, gid1)] else "former_member_of"
        else:
            mapped = "support_musician"
        key = (gid0, gid1, mapped)
        if key not in seen:
            seen.add(key)
            yield key


def build_graph(
    artists: dict[int, dict],
    relationships: list[tuple[int, int, str, bool]],
    collaborations: dict[tuple[str, str, str], int],
    reachable_gids: set[str],
    output_path: Path,
    meta: dict[str, str] | None = None,
    genres: list[str] | None = None,
):
    """
    Write the browser SQLite graph: reachable artists, band edges between them,
    and collaborations where both artists are reachable.

    Schema:
        nodes(id TEXT PRIMARY KEY, name TEXT, type TEXT, disambiguation TEXT, area TEXT, genres TEXT)
            type: "person", "group"; disambiguation/area NULL when MusicBrainz has none
            genres: genre ids, most voted first ("12,45,301"); NULL when none
        genres(id INTEGER PRIMARY KEY, name TEXT): the genres the nodes use
        edges(source TEXT, target TEXT, rel_type TEXT, count INTEGER)
            rel_type: "member_of", "former_member_of", "support_musician",
                      "collaborated_with", "produced_for" (credited artist -> album artist)
            count: song credits for collaborated_with / produced_for; NULL for band edges
                   (add_concertdb_edges.py sets it to the number of shows for opened_for)
        graph_meta(key TEXT PRIMARY KEY, value TEXT)
        + indexes
    """
    import sqlite3

    print(f"Building graph: {len(reachable_gids)} artists...")
    if output_path.exists():
        output_path.unlink()
    conn = sqlite3.connect(str(output_path))
    cur = conn.cursor()
    cur.execute("PRAGMA synchronous=OFF")
    cur.execute("CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,"
                " disambiguation TEXT, area TEXT, genres TEXT)")
    cur.execute("CREATE TABLE genres (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
    cur.execute("CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, rel_type TEXT NOT NULL,"
                " count INTEGER)")
    cur.execute("CREATE TABLE graph_meta (key TEXT PRIMARY KEY, value TEXT)")

    used: set[int] = set()

    def node_rows():
        for d in artists.values():
            if d["gid"] in reachable_gids:
                ids = d.get("genres")
                if ids:
                    used.update(ids)
                yield (d["gid"], d["name"], node_type(d["type"]), d["disambiguation"], d["area"],
                       ",".join(map(str, ids)) if ids else None)

    cur.executemany(
        "INSERT OR IGNORE INTO nodes (id, name, type, disambiguation, area, genres) VALUES (?, ?, ?, ?, ?, ?)",
        node_rows())
    node_count = cur.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
    if genres:
        cur.executemany("INSERT INTO genres (id, name) VALUES (?, ?)",
                        ((i, genres[i - 1]) for i in sorted(used)))

    cur.executemany("INSERT INTO edges (source, target, rel_type) VALUES (?, ?, ?)",
                    band_edges(relationships, artists, reachable_gids))
    cur.executemany("INSERT INTO edges (source, target, rel_type, count) VALUES (?, ?, ?, ?)",
                    ((a, b, rel, n) for (a, b, rel), n in collaborations.items()
                     if a in reachable_gids and b in reachable_gids))
    edge_count = cur.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
    cur.executemany("INSERT INTO graph_meta (key, value) VALUES (?, ?)", (meta or {}).items())

    print("  Creating indexes...")
    cur.execute("CREATE INDEX idx_edges_source ON edges(source)")
    cur.execute("CREATE INDEX idx_edges_target ON edges(target)")
    cur.execute("CREATE INDEX idx_edges_rel_type ON edges(rel_type)")
    cur.execute("CREATE INDEX idx_nodes_name ON nodes(name COLLATE NOCASE)")
    cur.execute("CREATE INDEX idx_nodes_type ON nodes(type)")
    conn.commit()
    conn.execute("VACUUM")
    conn.close()
    print(f"  Output: {node_count} nodes, {edge_count} edges")
    return node_count, edge_count


def load_graph_inputs():
    """Everything both the browser graph and seed_supabase.py are built from."""
    link_types = parse_link_types(DATA_DIR)
    aa_ids = {t for t, n in link_types.items() if n in RELEVANT_ARTIST_ARTIST_TYPES}
    ar_ids = {t for t, n in link_types.items() if n in RELEVANT_ARTIST_RECORDING_TYPES}
    if not aa_ids:
        raise RuntimeError("Could not find relevant artist-artist relationship types.")
    links = parse_links(DATA_DIR)
    artists = parse_artists(DATA_DIR, parse_areas(DATA_DIR))
    parse_artist_genres(DATA_DIR, artists, genre_names())
    relationships = parse_artist_relationships(DATA_DIR, links, link_types, aa_ids)
    relationships = drop_special_purpose_artists(artists, relationships)
    credits = parse_artist_recording_relationships(DATA_DIR, links, link_types, ar_ids)
    recording_to_rg, release_groups = build_recording_to_release_group(DATA_DIR)
    credit_to_artist = parse_artist_credit_name(DATA_DIR)
    shared_songs = parse_shared_songs(DATA_DIR, parse_shared_credits(DATA_DIR))
    collaborations, shared_only = build_collaborations(credits, recording_to_rg, release_groups, credit_to_artist,
                                                       artists, relationships, shared_songs)
    del credits, recording_to_rg, release_groups, credit_to_artist, shared_songs
    print()
    curated = resolve_curated_seeds(artists)
    concert = concertdb_seeds(CONCERTDB_LEDGER, artists)
    return artists, relationships, collaborations, shared_only, curated, concert


def main():
    import argparse
    from datetime import datetime, timezone

    ap = argparse.ArgumentParser(description="Build public/graph.db.gz from the MusicBrainz dump")
    ap.add_argument("--concertdb-hops", type=int, default=CONCERTDB_HOPS,
                    help="hops around banded-data's artists (lowered automatically to fit --max-gzip-mb)")
    ap.add_argument("--max-gzip-mb", type=float, default=MAX_GZIP_MB)
    args = ap.parse_args()

    print("=" * 60)
    print("MusicBrainz Dump Processor")
    print("=" * 60)
    dump_url = get_latest_dump_url()
    print(f"Latest dump: {dump_url}")
    download_dump_tables(dump_url)
    download_derived_tables(dump_url)
    print()
    artists, relationships, collaborations, shared_only, curated, concert = load_graph_inputs()

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    gz_path = OUTPUT_FILE.with_suffix(".db.gz")
    for hops in range(args.concertdb_hops, -1, -1):
        print(f"\nbanded-data artists at {hops} hops (curated seeds at {CURATED_HOPS}):")
        reachable = bfs_reachable(seed_budgets(curated, concert, hops), relationships, artists)
        owners = record_artists(collaborations, reachable, shared_only)
        print(f"  + {len(owners)} record artists outside it (their records' credits are in the graph)")
        meta = {"built_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                "musicbrainz_dump": dump_url.rsplit("/", 1)[-1], "curated_seeds": str(len(curated)),
                "curated_hops": str(CURATED_HOPS), "concertdb_seeds": str(len(concert)),
                "concertdb_hops": str(hops), "record_artists": str(len(owners))}
        node_count, edge_count = build_graph(artists, relationships, collaborations, reachable | owners, OUTPUT_FILE,
                                             meta, genres=genre_names())
        with open(OUTPUT_FILE, "rb") as f_in, gzip.open(gz_path, "wb", compresslevel=9) as f_out:
            shutil.copyfileobj(f_in, f_out)
        gz_mb = gz_path.stat().st_size / 1e6
        print(f"  graph.db.gz: {gz_mb:.1f} MB (limit {args.max_gzip_mb} MB)")
        if gz_mb <= args.max_gzip_mb or not concert:
            break
        print("  Too big for the browser download: one hop fewer around banded-data's artists")

    print()
    print("=" * 60)
    print(f"Done: {node_count} nodes, {edge_count} edges, banded-data hops {hops}")
    print(f"  SQLite: {OUTPUT_FILE.stat().st_size / 1e6:.1f} MB, gzipped: {gz_mb:.1f} MB")
    print("  Next: python3 scripts/add_concertdb_edges.py (opened_for edges)")
    print("=" * 60)


if __name__ == "__main__":
    main()
