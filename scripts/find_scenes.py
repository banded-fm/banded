#!/usr/bin/env python3
"""Find cities' music scenes and place them on the map.

Groups each city's artists into the scenes they play and record in, each with
a suggested name, a location, and what's needed to name it well (genres, and
Last.fm tags when given), and writes them as JSON:

    python3 scripts/find_scenes.py --all                          # every major city
    python3 scripts/find_scenes.py --city "Los Angeles" --area "Orange County"
    python3 scripts/find_scenes.py --all --lastfm ~/Downloads/archive.zip

Inputs:
  - the graph (public/graph.db.gz): each artist's MusicBrainz area and genres,
    and the links between artists (band memberships, support musicians, song
    credits, producers, opening slots);
  - banded-data's shows export (`concertdb export shows --musicbrainz-only`,
    data/export/shows.csv): every act on every show with its venue's city and
    coordinates, so artists who share bills are linked, and so a scene can be
    placed where its artists play. Data flows one way: banded-data -> Banded;
  - optional: Last.fm's tags and listener counts per MusicBrainz ID, from the
    "Music artists popularity" Kaggle dataset (2019; artists.csv or its zip),
    to describe each scene in listeners' words ("bay area thrash", "paisley
    underground") and to list its best-known artists first (by listeners).
    Not committed; pass --lastfm or set $LASTFM_ARTISTS;
  - optional: in how many Wikipedia languages each artist has an article,
    counting only music people (bands, and people with a music occupation:
    not the novelists and actors MusicBrainz credits), from Wikidata by
    MusicBrainz ID (scripts/data/wikipedias.csv; --fetch-wikipedias asks
    Wikidata about the graph's artists it hasn't asked about yet, ~1 hour the
    first time). For artists the 2019 Last.fm data doesn't have (half of them),
    it gives the listeners artists with as many Wikipedias typically have;
  - MusicBrainz's area tree (scripts/data/mbdump: artist, area, l_area_area,
    link, link_type), so an area is placed in its state and country
    (Aberdeen, Washington, not Aberdeen, Scotland), and when artists started
    (artist, release_group, artist_credit_name, release_group_meta, link,
    link_type, l_artist_artist). l_area_area and release_group_meta aren't
    among process_mb_dump.py's tables: --fetch downloads them once. Without
    them, areas are matched by name and scenes get no era.

Needs networkx (pip install networkx).

Steps:
  1. Cities are venue cities: a city is its name with its state and country
     (Portland, Oregon is not Portland, Maine). With --all, every city with at
     least 1,000 shows (--min-shows) whose centre isn't within the radius of a
     bigger one is a metro: Long Beach and Pasadena go with Los Angeles. A
     metro is every venue within 45 km of its city's venues, and the cities of
     those venues are its places; where two metros overlap, a city goes with
     the nearer one.
  2. Local artists, in this order (each artist in the output says which):
     - "area": its MusicBrainz area is one of the metro's cities. With the
       area tree, that's the area or the nearest place it is part of that is a
       venue city in the same state and country (Silver Lake -> Los Angeles;
       Aberdeen, Washington, not Scotland), else a venue city in the smallest
       area below the state that holds both (Montesano -> Grays Harbor County
       -> Aberdeen). Without it, by name (local spellings too: Wien, München),
       and of several cities with the name, the one the artist plays most,
       else the one with the most shows. Or an extra --area ("Orange County").
     - "nearby": its city is a town in no metro, and this is the nearest metro
       within 150 km (--nearby-km): Aberdeen and Olympia count for Seattle.
     - "shows": at least 3 shows here, and at least 60% of all its shows.
     - "band": a person in a local band, wherever MusicBrainz says they're
       from (often where they were born: Krist Novoselic, Compton).
     - "ties": no city that counts for any metro, and its ties are mostly
       here: at least 3 in weight (see step 3) and two thirds of all its ties
       (Tim Commerford, "California", Rage Against the Machine's bassist).
  3. Links between local artists: a band membership weighs 3, a support
     musician or an opening slot 2, a producer 1, song credits one per song
     (up to 3), and each bill shared at a venue here 1 (up to 3).
  4. Groups: Louvain communities on that weighted network (resolution 1.5,
     fixed seed, so the same inputs give the same scenes).
  5. Not every artist belongs to a scene. Each artist is moved to the group
     most of its ties go to (Louvain can leave one elsewhere), and stays only
     if those ties weigh at least 3 (a band member, or several songs or shows
     with the group) and are at least a third of its ties here: a band between
     two scenes stays with the stronger (Green River, with Pearl Jam's side
     over Mudhoney's). An actor with one song credit with a rapper is dropped.
     Groups with fewer than 8 artists left are dropped.
  6. What a scene is like, for naming it: its top genres (MusicBrainz genres by
     share of its artists) and its distinctive ones (share times how
     over-represented they are against the metro, capped at 3x); with Last.fm,
     the same for its artists' tags, the tags that mention a place or a scene
     ("canterbury scene", "bay area thrash"), and its most-listened artists.
  7. Name (a suggestion): the place plus the most distinctive genre a bigger
     scene there hasn't taken, or has but in other years ("Detroit techno
     (1987–1998)"), e.g. "Los Angeles thrash metal" ("Detroit
     techno", not "Detroit detroit techno"), else its most distinctive Last.fm
     tag that is a style (not a decade, nationality or place), e.g.
     "Liverpool merseybeat". The place is the city, or a place within it that
     at least half of the scene's artists with a narrower area come from.
  8. Location, the first that applies: the venue nearest all the others among
     those where the scene's artists shared bills (3+ shows), or else played
     (5+ shows); the place most of them come from; the city centre.
     `spread_km` is the median distance of those shows from it.
  9. Era: when the scene's artists started out. An artist's first year is its
     first release (the 10th percentile of its release groups' first release
     years, past stray early dates), the year a group formed, or its first
     dated band membership. Weighted by each artist's ties inside the scene,
     the era runs from the 20th to the 80th percentile, with the busiest five
     years' middle as its peak: Seattle grunge 1985–1992, Liverpool
     merseybeat 1959–1963, Detroit techno 1991–2001.

Limits: names need a human pass ("Los Angeles rock"); an era describes a
scene, it doesn't split one that spans generations;
an area that is only a country or state ("California") gives no city;
an artist is in one scene at most.
"""

import argparse
import csv
import gzip
import html
import io
import json
import math
import os
import re
import shutil
import sqlite3
import statistics
import tempfile
import unicodedata
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_GRAPH = ROOT / "public" / "graph.db.gz"
DEFAULT_SHOWS = Path(os.environ.get("CONCERTDB_SHOWS")
                     or Path.home() / "banded-data" / "data" / "export" / "shows.csv")
DEFAULT_LASTFM = os.environ.get("LASTFM_ARTISTS")
DEFAULT_WIKIPEDIAS = Path(os.environ.get("WIKIPEDIAS") or ROOT / "scripts" / "data" / "wikipedias.csv")
DEFAULT_OUT_DIR = ROOT / "scripts" / "data" / "scenes"
DEFAULT_MBDUMP = ROOT / "scripts" / "data" / "mbdump"

RADIUS_KM = 45             # Long Beach and Anaheim are LA; Liverpool (50 km) is not Manchester
MIN_CITY_SHOWS = 1000      # --all: a metro's main city has at least this many shows
REL_WEIGHT = {"member_of": 3, "former_member_of": 3, "support_musician": 2, "opened_for": 2, "produced_for": 1}
CREDIT_CAP = 3             # collaborated_with: one per shared song credit, up to this
BILL_CAP = 3               # one per bill shared here, up to this
LOCAL_MIN_SHOWS = 3
LOCAL_SHARE = 0.6
NEARBY_KM = 150           # a town with no metro of its own counts for the nearest metro this close (Aberdeen, WA)
MEMBER_RELS = ("member_of", "former_member_of")
ADOPT_WEIGHT = 3           # an artist with no city joins one with at least this much tie weight to its artists...
ADOPT_SHARE = 2 / 3        # ...making up at least this share of all its ties
CORE_SHARE = 1 / 3         # an artist stays in its group if that's where most of its ties are, and at least a third
CORE_WEIGHT = 3
MIN_SIZE = 8
RESOLUTION = 1.5           # higher splits more: 1.5 separates e.g. LA's West Coast jazz from its session players.
                           # Above 1 a network that is a single group is split up, which is fine for a city.
SEED = 7
GENRE_MIN_SHARE = 0.12
LIFT_CAP = 3               # a genre 3x as common here as in the metro counts as fully distinctive
PLACE_NAME_SHARE = 0.5
PLACE_LOCATION_SHARE = 0.3
MIN_SHARED_BILLS = 3
MIN_SHOWS = 5
LASTFM_TAGS = 10           # tags per artist (Last.fm lists them most-used first)
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
WIKIDATA_BATCH = 500       # MusicBrainz IDs per query: ~7 s each
# A music person: anything but a human (a band, orchestra, duo...), or a human whose occupation is (a kind of)
# musician, composer, singer, songwriter, disc jockey, record producer or rapper.
MUSIC_OCCUPATIONS = ("Q639669", "Q36834", "Q177220", "Q753110", "Q130857", "Q183945", "Q2252262")
# Wikipedia-language buckets (lower bounds) for estimating listeners, and the fewest artists with both a
# bucket needs to count.
WIKI_BUCKETS = (1, 2, 3, 4, 6, 8, 10, 15, 20, 30, 40, 60, 80)
WIKI_MIN_ARTISTS = 20

# MusicBrainz often names a city in its own language; venues use the English name.
AREA_ALIASES = {
    "wien": "vienna", "munchen": "munich", "koln": "cologne", "roma": "rome", "milano": "milan",
    "frankfurt am main": "frankfurt", "washington d c": "washington", "praha": "prague", "kobenhavn": "copenhagen",
    "lisboa": "lisbon", "warszawa": "warsaw", "moskva": "moscow", "sankt peterburg": "saint petersburg",
    "bruxelles": "brussels", "brussel": "brussels", "antwerpen": "antwerp", "gent": "ghent", "goteborg": "gothenburg",
    "geneve": "geneva", "napoli": "naples", "torino": "turin", "firenze": "florence", "athina": "athens",
    "new york city": "new york", "montreal quebec": "montreal",
}
# Tags that say nothing about a scene.
GENERIC_TAGS = {
    "seen live", "favorites", "favourites", "favorite", "favourite", "awesome", "love", "beautiful", "cool",
    "male vocalists", "female vocalists", "male vocalist", "female vocalist", "my favorites", "amazing", "good",
    "great", "best", "under 2000 listeners", "spotify", "albums i own", "all", "music",
}

_PUNCT = re.compile(r"[^\w\s]")
_SPACE = re.compile(r"\s+")


def norm(name: str | None) -> str:
    """banded-data's name normalization: 'The Oh Sees' -> 'oh sees', 'Long Beach' -> 'long beach'."""
    if not name:
        return ""
    s = html.unescape(name)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace("&", " and ")
    s = _PUNCT.sub(" ", s)
    s = _SPACE.sub(" ", s).strip()
    return s[4:] if s.startswith("the ") else s


def area_key(area: str | None) -> str:
    k = norm(area)
    return AREA_ALIASES.get(k, k)


def slug(s: str) -> str:
    return norm(s).replace(" ", "-")


def km(a: tuple[float, float], b: tuple[float, float]) -> float:
    (la1, lo1), (la2, lo2) = a, b
    p1, p2 = math.radians(la1), math.radians(la2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lo2 - lo1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def _mean(points: list[tuple[float, float]]) -> tuple[float, float]:
    return statistics.fmean(p[0] for p in points), statistics.fmean(p[1] for p in points)


# ---------------------------------------------------------------- inputs

@dataclass
class Shows:
    """banded-data's shows export, festivals and acts without a MusicBrainz ID left out."""
    venues: dict                  # venue_id -> {id, name, city, state, country, lat, lon, key}
    bills: list                   # (show_id, venue_id, mbid)
    city_shows: Counter = field(default_factory=Counter)      # city key -> shows
    city_centre: dict = field(default_factory=dict)           # city key -> (lat, lon) of its venues
    city_name: dict = field(default_factory=dict)             # city key -> (city, state, country) as written
    keys_by_name: dict = field(default_factory=dict)          # norm(city) -> [city key]
    artist_cities: dict = field(default_factory=dict)         # mbid -> Counter of city keys
    plays: Counter = field(default_factory=Counter)           # mbid -> shows anywhere
    by_venue: dict = field(default_factory=dict)              # venue_id -> [(show_id, mbid)]
    countries: set = field(default_factory=set)               # norm(country) of every venue


def read_shows(path: str | Path) -> Shows:
    venues, bills = {}, []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["is_festival"] == "1" or not r["mbid"]:
                continue
            vid = int(r["venue_id"])
            if vid not in venues:
                lat, lon = (float(r["lat"]), float(r["lon"])) if r["lat"] and r["lon"] else (None, None)
                venues[vid] = {"id": vid, "name": r["venue"], "city": r["city"], "state": r["state"],
                               "country": r["country"], "lat": lat, "lon": lon,
                               "key": (norm(r["city"]), norm(r["state"]), norm(r["country"]))}
            bills.append((int(r["show_id"]), vid, r["mbid"]))
    s = Shows(venues, bills)
    seen, points = set(), defaultdict(list)
    artist_cities, by_venue = defaultdict(Counter), defaultdict(list)
    for sid, vid, mbid in bills:
        s.plays[mbid] += 1
        by_venue[vid].append((sid, mbid))
        v = venues[vid]
        if v["lat"] is None or not v["key"][0]:
            continue
        artist_cities[mbid][v["key"]] += 1
        if sid not in seen:
            seen.add(sid)
            s.city_shows[v["key"]] += 1
    for v in venues.values():
        if v["lat"] is not None and v["key"][0]:
            points[v["key"]].append((v["lat"], v["lon"]))
            s.city_name.setdefault(v["key"], (v["city"], v["state"], v["country"]))
    s.city_centre = {k: _mean(p) for k, p in points.items()}
    by_name = defaultdict(list)
    for k in s.city_centre:
        by_name[k[0]].append(k)
    s.keys_by_name = dict(by_name)
    s.artist_cities = dict(artist_cities)
    s.by_venue = dict(by_venue)
    s.countries = {v["key"][2] for v in venues.values() if v["key"][2]}
    return s


@dataclass
class Graph:
    conn: sqlite3.Connection
    nodes: dict                   # mbid -> (name, type, area, [genre ids])
    genre_name: dict
    built_at: str | None


def load_graph(conn: sqlite3.Connection) -> Graph:
    nodes = {}
    for mbid, name, typ, area, genres in conn.execute(
            "SELECT id, name, type, area, genres FROM nodes WHERE type IN ('person', 'group')"):
        nodes[mbid] = (name, typ, area or "", [int(x) for x in (genres or "").split(",") if x.strip()])
    try:
        row = conn.execute("SELECT value FROM graph_meta WHERE key = 'built_at'").fetchone()
    except sqlite3.OperationalError:
        row = None
    return Graph(conn, nodes, dict(conn.execute("SELECT id, name FROM genres")), row[0] if row else None)


def open_graph(path: Path) -> tuple[sqlite3.Connection, Path | None]:
    """A graph.db, or a graph.db.gz decompressed to a temporary file (returned, to delete after)."""
    with open(path, "rb") as f:
        gz = f.read(2) == b"\x1f\x8b"
    if not gz:
        return sqlite3.connect(f"file:{path}?mode=ro", uri=True), None
    tmp = Path(tempfile.mkstemp(suffix=".db")[1])
    with gzip.open(path, "rb") as src, open(tmp, "wb") as dst:
        shutil.copyfileobj(src, dst)
    return sqlite3.connect(str(tmp)), tmp


def read_lastfm(path: str | Path, wanted: set | None = None) -> dict:
    """mbid -> (listeners, [tags, most-used first]) from the Kaggle "Music artists popularity" artists.csv
    (or the zip it comes in). Ambiguous names (Last.fm merged several artists) are skipped."""
    path = Path(path)
    csv.field_size_limit(1 << 30)

    def rows(f):
        for r in csv.DictReader(f):
            if r.get("ambiguous_artist") == "TRUE" or not r.get("mbid") or (wanted and r["mbid"] not in wanted):
                continue
            tags = [t.strip().lower() for t in (r.get("tags_lastfm") or "").split(";") if t.strip()]
            yield r["mbid"], (int(float(r["listeners_lastfm"] or 0)), tags[:LASTFM_TAGS])
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            name = next(n for n in z.namelist() if n.endswith(".csv"))
            with z.open(name) as f:
                return dict(rows(io.TextIOWrapper(f, encoding="utf-8")))
    with open(path, newline="", encoding="utf-8") as f:
        return dict(rows(f))


@dataclass
class Areas:
    """MusicBrainz's areas: each graph artist's area, and what each area is part of (Aberdeen -> Grays Harbor
    County -> Washington -> United States), from the dump files in scripts/data/mbdump."""
    artist_area: dict             # mbid -> area id
    name: dict                    # area id -> name
    type: dict                    # area id -> type (1 country, 2 subdivision, 3 city, 4 municipality, 5 district,
                                  #                  6 island, 7 county)
    parent: dict                  # area id -> the area it is part of

    def path(self, area_id: str) -> tuple[list[str], str, str]:
        """(the area and the places it is part of, smallest first, up to its state, as ids; the state; the
        country)."""
        names, state, country, seen = [], "", "", set()
        a = area_id
        while a and a not in seen:
            seen.add(a)
            t = self.type.get(a)
            if t == "1":
                country = self.name[a]
                if a == area_id:               # a city that is also a country: Singapore, Hong Kong
                    names.append(a)
                break
            if t == "2" and not state:
                state = self.name[a]
                if a == area_id:               # a city that is also a state: Berlin, Hamburg, Wien
                    names.append(a)
            elif not state:
                names.append(a)
            a = self.parent.get(a)
        return names, state, country


AREA_FILES = ("artist", "area", "l_area_area", "link", "link_type")
DUMP_URL = "https://data.metabrainz.org/pub/musicbrainz/data/fullexport/"


def fetch_area_tree(mbdump: str | Path) -> list[str]:
    """Stream MusicBrainz's latest full dump just far enough to extract the area tables process_mb_dump.py
    doesn't keep (l_area_area; area if missing): ~2 GB read in a few minutes, nothing big saved."""
    return _fetch(mbdump, "mbdump.tar.bz2", ("l_area_area", "area"))


def fetch_release_dates(mbdump: str | Path) -> list[str]:
    """The same from the derived dump for release_group_meta (each release group's first release date):
    ~1 GB read in about a minute."""
    return _fetch(mbdump, "mbdump-derived.tar.bz2", ("release_group_meta",))


def _fetch(mbdump: str | Path, archive: str, tables: tuple[str, ...]) -> list[str]:
    import tarfile
    import urllib.request
    d = Path(mbdump)
    d.mkdir(parents=True, exist_ok=True)
    want = {f"mbdump/{t}" for t in tables if not (d / t).exists()}
    if not want:
        return []
    headers = {"User-Agent": "Banded/0.1 ( https://banded.fm )"}
    latest = urllib.request.urlopen(urllib.request.Request(DUMP_URL + "LATEST", headers=headers), timeout=60)
    url = f"{DUMP_URL}{latest.read().decode().strip()}/{archive}"
    print(f"streaming {url} for {', '.join(sorted(want))}")
    got = []
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as resp, \
            tarfile.open(fileobj=resp, mode="r|bz2") as tar:
        for member in tar:
            if member.name in want:
                src = tar.extractfile(member)
                tmp = d / (Path(member.name).name + ".tmp")
                with open(tmp, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                tmp.rename(d / Path(member.name).name)
                got.append(member.name)
                want.discard(member.name)
                if not want:
                    break
    return got
def _wikidata_query(mbids: list[str]) -> str:
    music = " ".join(f"wd:{q}" for q in MUSIC_OCCUPATIONS)
    return ("SELECT ?mbid (COUNT(DISTINCT ?article) AS ?wikipedias) WHERE { "
            f"VALUES ?mbid {{ {' '.join(chr(34) + m + chr(34) for m in mbids)} }} ?item wdt:P434 ?mbid . "
            "FILTER EXISTS { { ?item wdt:P31 ?t . FILTER(?t != wd:Q5) } UNION "
            f"{{ ?item wdt:P106 ?occ . VALUES ?m {{ {music} }} ?occ wdt:P279* ?m . }} }} "
            "?article schema:about ?item ; schema:isPartOf ?site . "
            'FILTER(CONTAINS(STR(?site), ".wikipedia.org")) } GROUP BY ?mbid')


def _wikipedia_counts(mbids: list[str], tries: int = 4) -> dict:
    import time
    import urllib.error
    import urllib.parse
    import urllib.request
    body = urllib.parse.urlencode({"query": _wikidata_query(mbids)}).encode()
    headers = {"Accept": "text/csv", "Content-Type": "application/x-www-form-urlencoded",
               "User-Agent": "Banded/0.1 (https://banded.fm; https://github.com/banded-fm/banded)"}
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(WIKIDATA_SPARQL, data=body, headers=headers),
                                        timeout=90) as resp:
                text = resp.read().decode("utf-8")
            rows = list(csv.DictReader(io.StringIO(text)))
            if text.startswith("mbid,"):
                return {r["mbid"]: int(r["wikipedias"]) for r in rows}
            raise ValueError(f"unexpected answer: {text[:80]!r}")
        except (urllib.error.URLError, TimeoutError, ValueError) as e:   # HTTPError (429, 5xx) is a URLError
            if attempt == tries - 1:
                raise
            time.sleep(10 * (attempt + 1))
    return {}


def fetch_wikipedias(mbids, path: str | Path = DEFAULT_WIKIPEDIAS, batch: int = WIKIDATA_BATCH, log=print) -> int:
    """Ask Wikidata, for each MusicBrainz artist ID not yet in `path`, in how many Wikipedia languages its artist
    has an article, if it's a music person (see MUSIC_OCCUPATIONS), and append the answers (mbid,wikipedias; 0
    for none or not a music person). An interrupted fetch resumes; a later one asks only about new artists.
    Returns how many were asked about."""
    path = Path(path)
    done = set(read_wikipedias(path)) if path.exists() else set()
    todo = sorted(set(mbids) - done)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text("mbid,wikipedias\n")
    for i in range(0, len(todo), batch):
        part = todo[i:i + batch]
        counts = _wikipedia_counts(part)
        with open(path, "a", newline="") as f:
            csv.writer(f).writerows((m, counts.get(m, 0)) for m in part)
        if (i // batch) % 20 == 19 or i + batch >= len(todo):
            log(f"wikidata: {min(i + batch, len(todo)):,} of {len(todo):,} artists")
    return len(todo)


def read_wikipedias(path: str | Path) -> dict:
    """mbid -> Wikipedia languages (0 for none or not a music person), from fetch_wikipedias' file."""
    with open(path, newline="") as f:
        return {r["mbid"]: int(r["wikipedias"]) for r in csv.DictReader(f)}


def wikipedia_listeners(lastfm: dict, wikipedias: dict, min_artists: int = WIKI_MIN_ARTISTS) -> list:
    """What a number of Wikipedia languages is worth in Last.fm listeners: for each of WIKI_BUCKETS with enough
    artists who have both, their median listeners, and never less than a smaller bucket's. [(languages, listeners)]
    ascending."""
    by_bucket = defaultdict(list)
    for m, w in wikipedias.items():
        listeners = lastfm.get(m, (0, []))[0]
        if w > 0 and listeners > 0:
            by_bucket[max(b for b in WIKI_BUCKETS if b <= w)].append(listeners)
    table, best = [], 0
    for b in WIKI_BUCKETS:
        if len(by_bucket[b]) >= min_artists:
            best = max(best, int(statistics.median(by_bucket[b])))
            table.append((b, best))
    return table


class Renown:
    """How well known each artist is, in Last.fm listeners: its own count; else, from its Wikipedia languages,
    what artists of its kind with as many typically have (wikipedia_listeners); else 0. With only Wikipedia
    counts, the count itself. Kinds (`types`: mbid -> "person" or "group") are converted separately: a band
    member's articles are many but Last.fm gives the band the listeners, so a person in 20 Wikipedias typically
    has ~26,000 listeners and a band ~310,000."""

    def __init__(self, lastfm: dict | None = None, wikipedias: dict | None = None, types: dict | None = None,
                 min_artists: int = WIKI_MIN_ARTISTS):
        self.lastfm, self.wikipedias, self.types = lastfm, wikipedias, types
        self.tables = {}
        if lastfm and wikipedias:
            for kind in (("person", "group") if types else ("all",)):
                mine = {m: w for m, w in wikipedias.items() if self._kind(m) == kind}
                self.tables[kind] = wikipedia_listeners(lastfm, mine, min_artists)

    def _kind(self, m: str) -> str:
        if not self.types:
            return "all"
        return "person" if self.types.get(m) == "person" else "group"

    def __bool__(self) -> bool:
        return self.lastfm is not None or self.wikipedias is not None

    def score(self, m: str) -> int:
        listeners = self.lastfm.get(m, (0, []))[0] if self.lastfm is not None else 0
        if listeners:
            return listeners
        w = (self.wikipedias or {}).get(m, 0)
        if not w:
            return 0
        if self.lastfm is None:
            return w
        return next((v for b, v in reversed(self.tables.get(self._kind(m), [])) if b <= w), 0)

    def fields(self, m: str) -> dict:
        out = {}
        if self.lastfm is not None:
            out["listeners"] = self.lastfm.get(m, (0, []))[0]
        if self.wikipedias is not None:
            out["wikipedias"] = self.wikipedias.get(m, 0)
        out["known"] = self.score(m)
        return out


PART_OF = "part of"


def read_areas(mbdump: str | Path, wanted: dict) -> Areas | None:
    """The area tables of a MusicBrainz dump (process_mb_dump.py's scripts/data/mbdump; l_area_area too).
    wanted: mbid -> the area name graph.db has for it. None, with a note, when a file is missing: areas are
    then matched by name only."""
    d = Path(mbdump)
    missing = [f for f in AREA_FILES if not (d / f).exists()]
    if missing:
        print(f"note: no {', '.join(missing)} in {d}: matching areas by name only"
              " (scripts/process_mb_dump.py, then find_scenes.py --fetch-areas)")
        return None
    name, typ = {}, {}
    with open(d / "area", encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t", 4)
            name[p[0]], typ[p[0]] = p[2], p[3]
    artist_area = {}
    with open(d / "artist", encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            if p[1] not in wanted:
                continue
            # The graph's area is the artist's area, or where it began when that's more specific (MusicBrainz
            # often has just the country as the area and the city as the begin area): the one with that name.
            ids = [x for x in (p[11], p[17] if len(p) > 17 else "\\N", p[18] if len(p) > 18 else "\\N") if x != "\\N"]
            match = next((x for x in ids if name.get(x) == wanted[p[1]]), None)
            if match or ids:
                artist_area[p[1]] = match or ids[0]
    part_of = set()
    with open(d / "link_type", encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t", 7)
            if p[4] == "area" and p[5] == "area" and p[6] == PART_OF:
                part_of.add(p[0])
    links = set()
    with open(d / "link", encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t", 2)
            if p[1] in part_of:
                links.add(p[0])
    parent = {}
    with open(d / "l_area_area", encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t", 4)
            if p[1] in links:
                parent.setdefault(p[3], p[2])      # entity0 contains entity1
    return Areas(artist_area, name, typ, parent)


ERA_FILES = ("artist", "release_group", "artist_credit_name", "release_group_meta", "link", "link_type",
             "l_artist_artist")
MEMBER_OF_BAND = "member of band"
ERA_TRIM = 0.1             # an artist's years run from its 10th to 90th percentile release (reissues, late compilations)
ERA_SHARE = 0.2            # a scene's era: the 20th to 80th percentile of when its artists started
FIRST_YEAR = 1900


@dataclass
class Years:
    """When artists were active, from MusicBrainz: release groups' first release years, groups' formed and
    dissolved years, and dated band memberships."""
    span: dict                    # mbid -> (from, to)
    member: dict                  # (person mbid, group mbid) -> (from, to or None)


def read_years(mbdump: str | Path, wanted: set) -> Years | None:
    """None, with a note, when a file is missing (scenes then get no era)."""
    d = Path(mbdump)
    missing = [f for f in ERA_FILES if not (d / f).exists()]
    if missing:
        print(f"note: no {', '.join(missing)} in {d}: no eras (find_scenes.py --fetch adds release_group_meta)")
        return None
    this_year = datetime.now(timezone.utc).year

    def year(x: str) -> int | None:
        return int(x) if x not in ("\\N", "") and FIRST_YEAR <= int(x) <= this_year else None
    mbid_of, formed = {}, {}
    with open(d / "artist", encoding="utf-8") as f:
        for line in f:
            p = line.split("\t", 11)
            if p[1] in wanted:
                mbid_of[p[0]] = p[1]
                if p[10] != "1":                   # not a person: begin and end are formed and dissolved
                    formed[p[1]] = (year(p[4]), year(p[7]))
    credits = defaultdict(list)
    with open(d / "artist_credit_name", encoding="utf-8") as f:
        for line in f:
            p = line.split("\t", 3)
            if p[2] in mbid_of:
                credits[p[0]].append(mbid_of[p[2]])
    first = {}
    with open(d / "release_group_meta", encoding="utf-8") as f:
        for line in f:
            p = line.split("\t", 3)
            y = year(p[2])
            if y:
                first[p[0]] = y
    released = defaultdict(list)
    with open(d / "release_group", encoding="utf-8") as f:
        for line in f:
            p = line.split("\t", 4)
            y = first.get(p[0])
            if y and p[3] in credits:
                for m in credits[p[3]]:
                    released[m].append(y)
    band_type = None
    with open(d / "link_type", encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t", 7)
            if p[4] == "artist" and p[5] == "artist" and p[6] == MEMBER_OF_BAND:
                band_type = p[0]
    dated = {}
    with open(d / "link", encoding="utf-8") as f:
        for line in f:
            p = line.split("\t", 6)
            if p[1] == band_type and year(p[2]):
                dated[p[0]] = (year(p[2]), year(p[5]))
    member = {}
    with open(d / "l_artist_artist", encoding="utf-8") as f:
        for line in f:
            p = line.split("\t", 4)
            if p[1] in dated and p[2] in mbid_of and p[3] in mbid_of:
                member[(mbid_of[p[2]], mbid_of[p[3]])] = dated[p[1]]
    span = {}
    for m, ys in released.items():
        ys.sort()
        n = len(ys) - 1
        span[m] = (ys[round(ERA_TRIM * n)], ys[round((1 - ERA_TRIM) * n)])
    for (person, group), (a, b) in member.items():   # a person's band years widen its span
        for m in (person,):
            lo, hi = span.get(m, (a, b or a))
            span[m] = (min(lo, a), max(hi, b or a))
    for m, (a, b) in formed.items():
        if a:
            lo, hi = span.get(m, (a, b or a))
            span[m] = (a, b if b else max(hi, a))
    return Years(span, member)


def era_of(core: set, years: Years, inside: Counter) -> dict | None:
    """When a scene's artists started out: each artist's first year (first release, formed, or first dated
    band membership), weighted by its ties inside the scene, so the bands at its heart count most and a
    member's later side projects little. From and to are the 20th and 80th percentiles; the peak is the
    middle of the busiest five years. Grunge in Seattle: 1985–1992; merseybeat in Liverpool: 1959–1963."""
    w: Counter = Counter()
    for m in core:
        if m in years.span:
            w[years.span[m][0]] += inside[m] or 1
    if not w:
        return None
    total = sum(w.values())

    def pct(q):
        acc = 0
        for y in sorted(w):
            acc += w[y]
            if acc >= q * total:
                return y
        return max(w)
    lo, hi = pct(ERA_SHARE), pct(1 - ERA_SHARE)
    peak = max(sorted(w), key=lambda y: sum(w[x] for x in range(y - 2, y + 3)))
    decades = Counter()
    for y, x in w.items():
        decades[f"{y // 10 * 10}s"] += x / total
    return {"from": lo, "to": hi, "peak": peak, "label": f"{lo}–{hi}" if hi > lo else str(lo),
            "decades": {k: round(v, 2) for k, v in sorted(decades.items()) if v >= 0.01},
            "dated_artists": sum(1 for m in core if m in years.span)}


# ---------------------------------------------------------------- metros

@dataclass
class Metro:
    key: tuple                    # the main city's key
    name: str
    state: str
    country: str
    centre: tuple
    radius_km: float
    venues: dict                  # venue_id -> venue, within the radius
    places: dict                  # norm(city) -> {"name", "lat", "lon", "venues", "shows"}
    city_keys: set                # city keys whose centre is within the radius
    nearby: set = field(default_factory=set)   # towns beyond the radius that count for its artists (assign_nearby)


def metro_for(shows: Shows, key: tuple, radius_km: float = RADIUS_KM) -> Metro:
    centre = shows.city_centre[key]
    venues = {vid: v for vid, v in shows.venues.items()
              if v["lat"] is not None and km(centre, (v["lat"], v["lon"])) <= radius_km}
    by_place = defaultdict(list)
    for v in venues.values():
        if v["city"]:
            by_place[norm(v["city"])].append(v)
    places = {}
    for k, vs in by_place.items():
        lat, lon = _mean([(v["lat"], v["lon"]) for v in vs])
        places[k] = {"name": Counter(v["city"] for v in vs).most_common(1)[0][0], "lat": lat, "lon": lon,
                     "venues": len(vs), "shows": sum(shows.city_shows[v["key"]] for v in {v["key"]: v for v in vs}.values())}
    city, state, country = shows.city_name[key]
    keys = {k for k, c in shows.city_centre.items() if km(centre, c) <= radius_km}
    return Metro(key, city, state, country, centre, radius_km, venues, places, keys)


def find_city(shows: Shows, city: str) -> tuple:
    """The city key for "Los Angeles", or "Portland, Oregon" / "Portland, Maine" (state or country after a comma).
    Of several matches, the one with the most shows."""
    name, _, qualifier = city.partition(",")
    keys = shows.keys_by_name.get(norm(name), [])
    if qualifier.strip():
        q = norm(qualifier)
        keys = [k for k in keys if q in (k[1], k[2])]
    if not keys:
        raise ValueError(f"no venues with coordinates in {city!r}")
    return max(keys, key=lambda k: shows.city_shows[k])


def major_metros(shows: Shows, min_shows: int = MIN_CITY_SHOWS, radius_km: float = RADIUS_KM) -> list[Metro]:
    """Cities with min_shows+ shows, biggest first; one within the radius of a bigger one joins it."""
    metros: list[Metro] = []
    for key, n in shows.city_shows.most_common():
        if n < min_shows:
            break
        if any(key in m.city_keys for m in metros):
            continue
        metros.append(metro_for(shows, key, radius_km))
    # Where two metros' circles overlap (Wigan is within 45 km of Manchester and Liverpool), a city and its
    # venues go with the nearer one, so no artist or venue is in two metros.
    for m in metros:
        others = [o for o in metros if o is not m]
        nearer = lambda point: any(km(o.centre, point) < km(m.centre, point) for o in others
                                   if km(o.centre, point) <= o.radius_km)
        m.city_keys = {k for k in m.city_keys if not nearer(shows.city_centre[k])}
        m.venues = {vid: v for vid, v in m.venues.items() if not nearer((v["lat"], v["lon"]))}
        kept = {norm(v["city"]) for v in m.venues.values() if v["city"]}
        m.places = {k: p for k, p in m.places.items() if k in kept}
    return metros


def assign_nearby(shows: Shows, metros: list[Metro], nearby_km: float = NEARBY_KM) -> None:
    """Towns in no metro go with the nearest metro within nearby_km (Aberdeen and Olympia, Washington with
    Seattle), so their artists count for it. Only for deciding who is local: venues stay within the radius."""
    claimed = set().union(*(m.city_keys for m in metros)) if metros else set()
    for key, centre in shows.city_centre.items():
        if key in claimed:
            continue
        near = [(km(m.centre, centre), i) for i, m in enumerate(metros) if km(m.centre, centre) <= nearby_km]
        if near:
            metros[min(near)[1]].nearby.add(key)


def venue_areas(shows: Shows, areas: Areas) -> dict:
    """MusicBrainz area id -> the venue cities inside it (a county, a district): each venue city is matched to
    a MusicBrainz area of that name in the same state and country, and registered with every area it is part
    of below its state."""
    by_name = defaultdict(list)
    for aid, n in areas.name.items():
        if areas.type.get(aid) in ("3", "4", "5", "2", "1"):
            by_name[area_key(n)].append(aid)
    inside = defaultdict(set)
    for key in shows.city_centre:
        name, st, co = key
        for aid in by_name.get(name, ()):
            ids, state, country = areas.path(aid)
            if (not co or norm(country) == co or norm(country) not in shows.countries) and \
                    (not st or not state or norm(state) == st):
                for x in ids:
                    inside[x].add(key)
                break
    return inside


def home_city(shows: Shows, mbid: str, area: str, areas: Areas | None = None, inside: dict | None = None
              ) -> tuple | None:
    """The city key an artist's area is in. With MusicBrainz's area tree, the area or the nearest place it is
    part of (Silver Lake -> Los Angeles) that is a venue city in the same state and country (Aberdeen,
    Washington, not Aberdeen, Scotland); failing that, a venue city in the smallest area below the state that
    contains both (Montesano -> Grays Harbor County -> Aberdeen). Without the tree, by name: of several cities
    with that name, the one the artist plays most, else the one with the most shows. None if nothing matches."""
    plays = shows.artist_cities.get(mbid, Counter())
    best = lambda keys: max(keys, key=lambda k: (plays[k], shows.city_shows[k]))
    aid = areas.artist_area.get(mbid) if areas else None
    if aid:
        names, state, country = areas.path(aid)
        st, co = norm(state), norm(country)
        if co not in shows.countries:          # spelled differently in the venue data (Türkiye, Turkey)
            co = ""
        for strict in (True, False):           # the state too; then the country only (state names differ)
            for x in names:
                keys = [k for k in shows.keys_by_name.get(area_key(areas.name.get(x)), [])
                        if (not co or k[2] == co) and (not strict or not st or k[1] == st)]
                if keys:
                    return best(keys)
        for x in names[1:] if inside else ():  # the smallest enclosing area with a venue city
            if inside.get(x):
                return best(inside[x])
        if co:
            return None                        # MusicBrainz knows where it is, and no venue city matches
    keys = shows.keys_by_name.get(area_key(area))
    if not keys:
        return None
    return keys[0] if len(keys) == 1 else best(keys)


# ---------------------------------------------------------------- scenes

def _louvain(weights: dict, resolution: float, seed: int) -> list[set]:
    import networkx as nx   # pip install networkx
    from networkx.algorithms.community import louvain_communities
    g = nx.Graph()
    for (a, b), w in weights.items():
        g.add_edge(a, b, weight=w)
    return louvain_communities(g, weight="weight", resolution=resolution, seed=seed)


def _tie(rel: str, count) -> int:
    return REL_WEIGHT.get(rel, min(count or 1, CREDIT_CAP))


def _adopted(graph: Graph, shows: Shows, metro: Metro, local: set, homes: dict, claimed: set) -> set:
    """Artists with no city of their own whose ties are mostly to this metro's artists: at least ADOPT_WEIGHT,
    and at least ADOPT_SHARE of all their ties anywhere. "No city": no home city, or one that counts for no
    metro (claimed: every metro's cities and nearby towns). Their MusicBrainz area must be empty, this metro's
    country or one of its states, or a place that isn't a country or state at all ("Orange County", "Silver
    Lake"); never another country or state. One round: an adopted artist doesn't bring in others."""
    country = norm(metro.country)
    mine = {country} | {norm(v["state"]) for v in shows.venues.values() if norm(v["country"]) == country and v["state"]}
    regions = {norm(v["country"]) for v in shows.venues.values()} | \
              {norm(v["state"]) for v in shows.venues.values() if v["state"]}

    def may_adopt(m):
        if m in local or m not in graph.nodes or (m in homes and homes[m] in claimed):
            return False
        area = norm(graph.nodes[m][2])
        return not area or area in mine or area not in regions
    to_local: Counter = Counter()
    ids = sorted(local)
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        q = ",".join("?" * len(chunk))
        for s, t, rel, count in graph.conn.execute(
                f"SELECT source, target, rel_type, count FROM edges WHERE source IN ({q}) OR target IN ({q})",
                chunk + chunk):
            for a, b in ((s, t), (t, s)):
                if a in local and may_adopt(b):
                    to_local[b] += _tie(rel, count)
    cands = sorted(m for m, w in to_local.items() if w >= ADOPT_WEIGHT)
    total: Counter = Counter()
    for i in range(0, len(cands), 500):
        chunk = cands[i:i + 500]
        q = ",".join("?" * len(chunk))
        inside = set(chunk)
        for s, t, rel, count in graph.conn.execute(
                f"SELECT source, target, rel_type, count FROM edges WHERE source IN ({q}) OR target IN ({q})",
                chunk + chunk):
            for a in {s, t} & inside:
                total[a] += _tie(rel, count)
    return {m for m in cands if to_local[m] >= ADOPT_SHARE * total[m]}


def _members(graph: Graph, groups: set) -> set:
    """People who are or were in one of these groups: in a local band, they're local, wherever MusicBrainz
    says they're from (often where they were born: Krist Novoselic, Compton; Dave Grohl, Warren, Ohio)."""
    out, ids = set(), sorted(groups)
    rels = ",".join(f"'{r}'" for r in MEMBER_RELS)
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        q = ",".join("?" * len(chunk))
        for (m,) in graph.conn.execute(
                f"SELECT source FROM edges WHERE rel_type IN ({rels}) AND target IN ({q})", chunk):
            if m in graph.nodes and graph.nodes[m][1] == "person":
                out.add(m)
    return out


def home_cities(shows: Shows, graph: Graph, areas: Areas | None = None) -> dict:
    """mbid -> the city key its MusicBrainz area is in (see home_city), for artists whose area is a venue city."""
    homes = {}
    inside = venue_areas(shows, areas) if areas else None
    for m, (_, _, area, _) in graph.nodes.items():
        if area:
            home = home_city(shows, m, area, areas, inside)
            if home is not None:
                homes[m] = home
    return homes


def find(shows: Shows, graph: Graph, metro: Metro, extra_areas: tuple[str, ...] = (), lastfm: dict | None = None,
         min_size: int = MIN_SIZE, resolution: float = RESOLUTION, seed: int = SEED, homes: dict | None = None,
         claimed: set | None = None, years: Years | None = None, renown: Renown | None = None) -> dict:
    """One metro's scenes, as a JSON-ready dict. homes: home_cities(), computed once for many metros.
    claimed: the city keys every metro counts (cities and nearby towns), for adoption; default this one's.
    renown: how well known artists are, to list each scene's best known first; default from lastfm."""
    renown = renown if renown is not None else Renown(lastfm)
    nodes = graph.nodes
    homes = home_cities(shows, graph) if homes is None else homes
    extra = {area_key(a) for a in extra_areas}

    # Shows here.
    here, venue_of, plays_here = defaultdict(list), {}, Counter()
    for vid in metro.venues:
        for sid, mbid in shows.by_venue.get(vid, ()):
            plays_here[mbid] += 1
            here[sid].append(mbid)
            venue_of[sid] = vid
    bills_here = {sid: (venue_of[sid], mbids) for sid, mbids in here.items()}

    how: dict = {}        # mbid -> why it's local: "area", "nearby", "shows", "band" or "ties"
    for m, home in homes.items():
        if home in metro.city_keys:
            how[m] = "area"
        elif home in metro.nearby:
            how[m] = "nearby"
    if extra:
        for m, (_, _, area, _) in nodes.items():
            if area and area_key(area) in extra:
                how.setdefault(m, "area")
    for m, k in plays_here.items():
        if m in nodes and k >= LOCAL_MIN_SHOWS and k >= LOCAL_SHARE * shows.plays[m]:
            how.setdefault(m, "shows")
    for m in _members(graph, {m for m in how if nodes[m][1] == "group"}):
        how.setdefault(m, "band")
    claimed = (metro.city_keys | metro.nearby) if claimed is None else claimed
    for m in _adopted(graph, shows, metro, set(how), homes, claimed):
        how[m] = "ties"
    local = set(how)

    weights: Counter = Counter()

    def link(a, b, w):
        if a != b:
            weights[(a, b) if a < b else (b, a)] += w
    ids = sorted(local)
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        q = ",".join("?" * len(chunk))
        for s, t, rel, count in graph.conn.execute(
                f"SELECT source, target, rel_type, count FROM edges WHERE source IN ({q})", chunk):
            if t in local:
                link(s, t, _tie(rel, count))
    shared = Counter()
    for _, mbids in bills_here.values():
        acts = sorted({m for m in mbids if m in local})
        for i, a in enumerate(acts):
            for b in acts[i + 1:]:
                shared[(a, b)] += 1
    for (a, b), k in shared.items():
        link(a, b, min(k, BILL_CAP))

    strength: Counter = Counter()
    for (a, b), w in weights.items():
        strength[a] += w
        strength[b] += w
    base = _Baseline(strength, nodes, lastfm, metro)

    scenes = []
    groups = _louvain(weights, resolution, seed) if weights else []
    # Each artist's ties to its strongest group: a band between two scenes (Green River: 13 of its 32 to
    # Pearl Jam's side, 11 to Mudhoney's) stays with the stronger one rather than dropping out.
    group_of = {m: i for i, grp in enumerate(groups) for m in grp}
    per_group = defaultdict(Counter)
    for (a, b), w in weights.items():
        per_group[a][group_of[b]] += w
        per_group[b][group_of[a]] += w
    strongest = {m: max(c.values()) for m, c in per_group.items()}
    cores, insides = [], []
    for group in groups:
        inside: Counter = Counter()
        for (a, b), w in weights.items():
            if a in group and b in group:
                inside[a] += w
                inside[b] += w
        cores.append({m for m in group if inside[m] >= CORE_WEIGHT and inside[m] >= CORE_SHARE * strength[m]
                      and inside[m] >= strongest[m]})
        insides.append(inside)
    # Louvain can leave an artist in a group that isn't its strongest; one that would drop out joins its
    # strongest group instead, if that keeps it (nobody else moves, so no group changes under the others).
    kept = set().union(*cores) if cores else set()
    for m, c in per_group.items():
        if m in kept:
            continue
        best = max(c, key=lambda i: (c[i], -i))
        if c[best] >= CORE_WEIGHT and c[best] >= CORE_SHARE * strength[m]:
            cores[best].add(m)
            insides[best][m] = c[best]
    for core, inside in zip(cores, insides):
        if len(core) >= min_size:
            scenes.append(_describe(core, inside, graph, base, metro, bills_here, lastfm, how, years, renown))
    scenes.sort(key=lambda s: -s["weight"])
    used: Counter = Counter()
    mid = metro_id(metro)
    for i, s in enumerate(scenes, 1):
        s["id"] = f"{mid}-{i}"
        styles = [g for g, _, _ in s["distinctive_genres"]]
        if "lastfm" in s:
            styles += [t for t in _style_tags(s["lastfm"]["distinctive_tags"], base.place_words) if t not in styles]
        s["name"] = _name(s.pop("_place"), styles, used, (s["era"] or {}).get("label"))
    top_places = sorted(metro.places.values(), key=lambda p: -p["shows"])[:12]
    return {
        "id": mid, "city": metro.name, "state": metro.state or None, "country": metro.country or None,
        "centre": {"lat": round(metro.centre[0], 5), "lon": round(metro.centre[1], 5)}, "radius_km": metro.radius_km,
        "places": [p["name"] for p in top_places],
        "shows": sum(1 for _ in bills_here), "local_artists": len(local),
        "local_by": dict(Counter(how.values())), "linked_artists": len(strength),
        "in_scenes": sum(s["size"] for s in scenes), "scenes": scenes,
    }


def metro_id(metro: Metro) -> str:
    return slug(metro.name)


class _Baseline:
    """How common each genre and tag is among the metro's linked artists, to tell what's distinctive."""

    def __init__(self, strength, nodes, lastfm, metro):
        linked = list(strength)
        self.genres = Counter(g for m in linked for g in set(nodes[m][3]))
        self.with_genres = sum(1 for m in linked if nodes[m][3]) or 1
        tagged = [m for m in linked if lastfm and lastfm.get(m, (0, []))[1]]
        self.tags = Counter(t for m in tagged for t in set(lastfm[m][1]) if t not in GENERIC_TAGS)
        self.with_tags = len(tagged) or 1
        names = {k for k in metro.places} | {norm(metro.name)}
        self.place_words = re.compile(r"\b(" + "|".join(re.escape(p) for p in sorted(names, key=len, reverse=True)
                                                       if len(p) > 2) + r")\b") if names else None


def _ranked(counts: Counter, n: int, base: Counter, base_n: int, limit: int = 6):
    """(top by share, distinctive by share x over-representation) for items held by n artists."""
    if not n:
        return [], []
    share = {x: k / n for x, k in counts.items()}
    top = [[x, round(s, 2)] for x, s in sorted(share.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]]
    lifted = [(x, s, s / (base[x] / base_n)) for x, s in share.items() if s >= GENRE_MIN_SHARE and base[x]]
    lifted.sort(key=lambda t: (-(t[1] * min(t[2], LIFT_CAP)), -t[1], t[0]))
    return top, [[x, round(s, 2), round(lift, 1)] for x, s, lift in lifted[:limit]]


def _with_place(place: str, genre: str) -> str:
    """"Detroit" + "detroit techno" -> "Detroit techno"; "Berlin" + "punk" -> "Berlin punk"."""
    p, g = norm(place), norm(genre)
    if g == p or g.startswith(p + " "):
        return place + genre[len(p):] if genre.lower().startswith(place.lower()) else genre
    return f"{place} {genre}"


def _name(place: str, genres: list[str], used: Counter, era: str | None = None) -> str:
    """The place and the first genre (or Last.fm tag) a bigger scene there hasn't taken, or has but in other
    years ("Seattle grunge (1985–1994)"); "<place> scene" without one."""
    for g in genres:
        name = _with_place(place, g)
        for candidate in (name, f"{name} ({era})" if era else None):
            if candidate and not used[candidate]:
                used[candidate] += 1
                return candidate
    base = _with_place(place, genres[0]) if genres else f"{place} scene"
    used[base] += 1
    return base if used[base] == 1 else f"{base} {used[base]}"


# Tags that describe where or when, not a style: never used in a name (they stay in the tag lists).
NOT_A_STYLE = {
    "british", "american", "english", "uk", "usa", "us", "german", "deutsch", "french", "canadian", "australian",
    "swedish", "norwegian", "finnish", "danish", "dutch", "japanese", "irish", "scottish", "welsh", "spanish",
    "italian", "austrian", "swiss", "brazilian", "mexican", "belgian", "icelandic", "polish", "russian",
    "oldies", "check this out", "instrumental", "vocal", "singer-songwriter", "male vocalists", "female vocalists",
}


def _style_tags(tags: list, place_words) -> list[str]:
    """Last.fm tags that could name a style: no decades ("60s"), nationalities or places."""
    out = []
    for t, *_ in tags:
        if t in NOT_A_STYLE or any(c.isdigit() for c in t) or (place_words and place_words.search(t)):
            continue
        out.append(t)
    return out


def _describe(core, inside, graph: Graph, base: _Baseline, metro: Metro, bills_here, lastfm, how, years,
              renown: Renown | None = None) -> dict:
    nodes = graph.nodes
    # Sorted, so ties (in genres, home places, tags) break the same way every run: a set's order changes
    # from run to run with Python's hash seed.
    has = [m for m in sorted(core) if nodes[m][3]]
    gc = Counter(graph.genre_name.get(g, str(g)) for m in has for g in set(nodes[m][3]))
    gbase = Counter({graph.genre_name.get(g, str(g)): k for g, k in base.genres.items()})
    top_genres, distinctive = _ranked(gc, len(has), gbase, base.with_genres)

    # Places within the city the artists come from (narrower than the city itself).
    city = norm(metro.name)
    homes = Counter(nodes[m][2] for m in sorted(core)
                    if area_key(nodes[m][2]) in metro.places and area_key(nodes[m][2]) != city)
    narrow = sum(homes.values())
    home, home_n = homes.most_common(1)[0] if homes else (None, 0)
    place_name = home if home and home_n >= PLACE_NAME_SHARE * narrow and home_n >= 3 else metro.name

    together = Counter(vid for vid, mbids in bills_here.values() if sum(1 for m in set(mbids) if m in core) >= 2)
    played = Counter(vid for vid, mbids in bills_here.values() for m in set(mbids) if m in core)
    venues = metro.venues
    location = None
    for counts, minimum, source in ((together, MIN_SHARED_BILLS, "shared bills"), (played, MIN_SHOWS, "shows")):
        if sum(counts.values()) >= minimum:
            pts = [(venues[v]["lat"], venues[v]["lon"]) for v, k in counts.items() for _ in range(k)]
            # The venue closest to all the others: a mean of venues across a big city lands in between them.
            hub = min(counts, key=lambda v: sum(k * km((venues[v]["lat"], venues[v]["lon"]),
                                                       (venues[u]["lat"], venues[u]["lon"])) for u, k in counts.items()))
            point = (venues[hub]["lat"], venues[hub]["lon"])
            location = {"lat": point[0], "lon": point[1], "source": source, "venue": venues[hub]["name"],
                        "place": venues[hub]["city"],
                        "spread_km": round(statistics.median(km(point, p) for p in pts), 1),
                        "venues": [[venues[v]["name"], k] for v, k in counts.most_common(5)]}
            break
    if location is None and home and home_n >= PLACE_LOCATION_SHARE * narrow and home_n >= 3:
        p = metro.places[area_key(home)]
        location = {"lat": p["lat"], "lon": p["lon"], "source": "home place", "venue": None, "place": p["name"],
                    "spread_km": None, "venues": []}
    if location is None:
        location = {"lat": metro.centre[0], "lon": metro.centre[1], "source": "city", "venue": None,
                    "place": metro.name, "spread_km": None, "venues": []}
    location["lat"], location["lon"] = round(location["lat"], 5), round(location["lon"], 5)

    # Best known first (Renown: Last.fm listeners, or estimated from Wikipedia languages); then most links.
    renown = renown or Renown()
    known = renown.score if renown else (lambda m: 0)
    artists = sorted(core, key=lambda m: (-known(m), -inside[m], nodes[m][0], m))
    scene = {
        "name": None, "_place": place_name, "size": len(core), "weight": sum(inside[m] for m in core) // 2,
        "location": location,
        "era": era_of(core, years, inside) if years else None,
        "top_genres": top_genres, "distinctive_genres": distinctive,
        "places": [[p, k] for p, k in homes.most_common(5)],
        "artists": [{"id": m, "name": nodes[m][0], "type": nodes[m][1], "links": inside[m], "local": how[m],
                     **(renown.fields(m) if renown else {})}
                    for m in artists],
    }
    if lastfm is not None:
        scene["lastfm"] = _lastfm_summary(core, nodes, lastfm, base)
    return scene


def _lastfm_summary(core, nodes, lastfm, base: _Baseline) -> dict:
    tagged = [m for m in sorted(core) if lastfm.get(m, (0, []))[1]]
    tc = Counter(t for m in tagged for t in dict.fromkeys(lastfm[m][1]) if t not in GENERIC_TAGS)
    top, distinctive = _ranked(tc, len(tagged), base.tags, base.with_tags, limit=8)
    places = Counter({t: k for t, k in tc.items()
                      if re.search(r"\bscene\b", t) or (k >= 2 and base.place_words and base.place_words.search(t)
                                          and len(t.split()) > 1)})
    listened = sorted((m for m in core if lastfm.get(m, (0, []))[0]), key=lambda m: -lastfm[m][0])
    return {
        "artists_with_tags": len(tagged), "top_tags": top, "distinctive_tags": distinctive,
        "place_tags": [[t, k] for t, k in places.most_common(6)],
        "most_listened": [[nodes[m][0], lastfm[m][0]] for m in listened[:10]],
    }


# ---------------------------------------------------------------- output

def write(result: dict, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False, indent=1))
    return path


APP_ARTISTS = 12           # artists per scene in the app's file


def app_data(cities: list[dict], meta: dict) -> dict:
    """The scenes for the app's map (src/scenes/sceneMap.ts): each scene without its full artist list (its first
    APP_ARTISTS, as [id, name]: best known with Last.fm or Wikipedia counts, else most connected; `artists_by`
    says which) and with
    genre and tag names only. ~3 MB instead of ~26."""
    def scene(s):
        era = s.get("era")
        return {
            "id": s["id"], "name": s["name"], "size": s["size"],
            "era": {k: era[k] for k in ("from", "to", "peak", "label")} if era else None,
            "location": {k: s["location"].get(k) for k in ("lat", "lon", "place", "venue")},
            "genres": [g for g, _ in s["top_genres"][:4]],
            "tags": [t for t, *_ in s["lastfm"]["distinctive_tags"][:5]] if s.get("lastfm") else [],
            "artists": [[a["id"], a["name"]] for a in s["artists"][:APP_ARTISTS]],
        }
    return {**meta, "artists_by": "known" if meta.get("lastfm") or meta.get("wikipedias") else "links",
            "cities": [{"id": c["id"], "city": c["city"], "country": c["country"], "centre": c["centre"],
                                "scenes": [scene(s) for s in c["scenes"]]} for c in cities]}


def default_path(city: str | None) -> Path:
    return DEFAULT_OUT_DIR / (f"{slug(city)}.json" if city else "scenes.json")


def _print_city(c: dict) -> None:
    print(f"{c['city']}, {c['country'] or '?'}: {len(c['scenes'])} scenes, {c['in_scenes']:,} of"
          f" {c['local_artists']:,} local artists")
    for s in c["scenes"]:
        loc = s["location"]
        tags = ", ".join(t for t, *_ in s.get("lastfm", {}).get("distinctive_tags", [])[:3])
        era = (s.get("era") or {}).get("label", "")
        print(f"  {s['name'][:44]:<44} {s['size']:>4}  {era:<9}  {loc['place'] or '?'} ({loc['source']})"
              f"  {', '.join(a['name'] for a in s['artists'][:4])}" + (f"  [{tags}]" if tags else ""))


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    which = p.add_mutually_exclusive_group(required=True)
    which.add_argument("--city", help="'Los Angeles', or 'Portland, Oregon' (a state or country after a comma)")
    which.add_argument("--all", action="store_true", help="every major city (see --min-shows)")
    p.add_argument("--min-shows", type=int, default=MIN_CITY_SHOWS,
                   help=f"--all: a city needs this many shows (default {MIN_CITY_SHOWS})")
    p.add_argument("--graph", default=str(DEFAULT_GRAPH), help="graph.db or graph.db.gz (default public/graph.db.gz)")
    p.add_argument("--shows", default=str(DEFAULT_SHOWS),
                   help="banded-data's `concertdb export shows --musicbrainz-only` CSV"
                        " (default $CONCERTDB_SHOWS, else ~/banded-data/data/export/shows.csv)")
    p.add_argument("--lastfm", default=DEFAULT_LASTFM,
                   help="Last.fm tags: the Kaggle 'Music artists popularity' artists.csv or its zip"
                        " (default $LASTFM_ARTISTS; optional)")
    p.add_argument("--wikipedias", default=str(DEFAULT_WIKIPEDIAS),
                   help="Wikipedia languages per artist, from --fetch-wikipedias (default $WIKIPEDIAS, else"
                        " scripts/data/wikipedias.csv; used if it exists)")
    p.add_argument("--fetch-wikipedias", action="store_true",
                   help="first ask Wikidata about the graph's artists not yet in --wikipedias (~1 hour the first time)")
    p.add_argument("--radius-km", type=float, default=RADIUS_KM)
    p.add_argument("--nearby-km", type=float, default=NEARBY_KM,
                   help=f"towns in no metro count for the nearest within this (default {NEARBY_KM})")
    p.add_argument("--fetch", "--fetch-areas", dest="fetch", action="store_true",
                   help="first download the MusicBrainz tables process_mb_dump.py doesn't keep into --mbdump:"
                        " the area tree (l_area_area) and release dates (release_group_meta), if missing")
    p.add_argument("--mbdump", default=str(DEFAULT_MBDUMP),
                   help="MusicBrainz dump files with the area tree (default scripts/data/mbdump; see scripts/README.md)")
    p.add_argument("--area", action="append", default=[],
                   help="--city: a MusicBrainz area that also counts as the city, e.g. 'Orange County' (repeatable)")
    p.add_argument("--min-size", type=int, default=MIN_SIZE, help="smallest scene, in artists")
    p.add_argument("--resolution", type=float, default=RESOLUTION, help="higher splits into more, smaller scenes")
    p.add_argument("--out", help="default scripts/data/scenes/<city>.json, or scenes.json with --all")
    p.add_argument("--app", help="also write the app's smaller file here (public/scenes.json; npm run upload-scenes)")
    args = p.parse_args(argv)

    if args.fetch:
        for name in fetch_area_tree(args.mbdump) + fetch_release_dates(args.mbdump):
            print(f"saved {name}")
    shows = read_shows(args.shows)
    conn, tmp = open_graph(Path(args.graph))
    try:
        graph = load_graph(conn)
        lastfm = read_lastfm(args.lastfm, set(graph.nodes)) if args.lastfm else None
        if args.fetch_wikipedias:
            print(f"asked Wikidata about {fetch_wikipedias(graph.nodes, args.wikipedias):,} artists")
        wikipedias = read_wikipedias(args.wikipedias) if Path(args.wikipedias).exists() else None
        renown = Renown(lastfm, wikipedias, {m: n[1] for m, n in graph.nodes.items()})
        areas = read_areas(args.mbdump, {m: n[2] for m, n in graph.nodes.items() if n[2]})
        metros = major_metros(shows, args.min_shows, args.radius_km)
        if not args.all:
            # One city, with the major metros around it, so its nearby towns are the ones nearer to it.
            key = find_city(shows, args.city)
            one = next((m for m in metros if m.key == key), None) or metro_for(shows, key, args.radius_km)
            metros = [one] + [m for m in metros if m is not one and key not in m.city_keys]
        assign_nearby(shows, metros, args.nearby_km)
        claimed = set().union(*(m.city_keys | m.nearby for m in metros))
        homes = home_cities(shows, graph, areas)
        years = read_years(args.mbdump, set(graph.nodes))
        cities = [find(shows, graph, m, extra_areas=tuple(args.area), lastfm=lastfm, min_size=args.min_size,
                       resolution=args.resolution, homes=homes, claimed=claimed, years=years, renown=renown)
                  for m in (metros if args.all else metros[:1])]
    finally:
        conn.close()
        if tmp:
            tmp.unlink(missing_ok=True)
    meta = {"generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "graph_built_at": graph.built_at, "lastfm": Path(args.lastfm).name if args.lastfm else None,
            "wikipedias": Path(args.wikipedias).name if wikipedias is not None else None}
    result = {**meta, "cities": cities} if args.all else {**meta, **cities[0]}
    out = write(result, args.out or default_path(None if args.all else args.city))
    if args.app:
        app = Path(args.app)
        app.parent.mkdir(parents=True, exist_ok=True)
        app.write_text(json.dumps(app_data(cities, meta), ensure_ascii=False, separators=(",", ":")))
        print(f"wrote {app} ({app.stat().st_size / 1e6:.1f} MB) for the app")
    for c in cities:
        _print_city(c)
    print(f"{len(cities)} cities, {sum(len(c['scenes']) for c in cities)} scenes; wrote {out}")


if __name__ == "__main__":
    main()
