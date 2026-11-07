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
    underground"). Not committed; pass --lastfm or set $LASTFM_ARTISTS.

Needs networkx (pip install networkx).

Steps:
  1. Cities are venue cities: a city is its name with its state and country
     (Portland, Oregon is not Portland, Maine). With --all, every city with at
     least 1,000 shows (--min-shows) whose centre isn't within the radius of a
     bigger one is a metro: Long Beach and Pasadena go with Los Angeles. A
     metro is every venue within 45 km of its city's venues, and the cities of
     those venues are its places; where two metros overlap, a city goes with
     the nearer one.
  2. Local artists: a MusicBrainz area that names one of the metro's places
     (MusicBrainz's local spellings too: Wien, München, Köln), or an extra
     --area such as "Orange County"; or an artist who has played at least 3
     shows here and at least 60% of their shows here. An area name several
     cities share (Birmingham, Portland) is the one the artist plays most,
     else the one with the most shows. Then artists with no city of their
     own (no area, or just the country or a state) join if their ties are
     mostly here: at least 3 in weight (see step 3) and two thirds of all
     their ties, e.g. Tim Commerford ("California"), Rage Against the Machine's
     bassist. Each artist in the output says why it's local: "area", "shows"
     or "ties".
  3. Links between local artists: a band membership weighs 3, a support
     musician or an opening slot 2, a producer 1, song credits one per song
     (up to 3), and each bill shared at a venue here 1 (up to 3).
  4. Groups: Louvain communities on that weighted network (resolution 1.5,
     fixed seed, so the same inputs give the same scenes).
  5. Not every artist belongs to a scene. An artist stays in its group only if
     at least half of its link weight here is inside the group and that weight
     is at least 3: a band member, or several songs or shows with the group.
     An actor with one song credit with a rapper is dropped. Groups with fewer
     than 8 artists left are dropped.
  6. What a scene is like, for naming it: its top genres (MusicBrainz genres by
     share of its artists) and its distinctive ones (share times how
     over-represented they are against the metro, capped at 3x); with Last.fm,
     the same for its artists' tags, the tags that mention a place or a scene
     ("canterbury scene", "bay area thrash"), and its most-listened artists.
  7. Name (a suggestion): the place plus the most distinctive genre a bigger
     scene there hasn't taken, e.g. "Los Angeles thrash metal" ("Detroit
     techno", not "Detroit detroit techno"), else its most distinctive Last.fm
     tag that is a style (not a decade, nationality or place), e.g.
     "Liverpool merseybeat". The place is the city, or a place within it that
     at least half of the scene's artists with a narrower area come from.
  8. Location, the first that applies: the venue nearest all the others among
     those where the scene's artists shared bills (3+ shows), or else played
     (5+ shows); the place most of them come from; the city centre.
     `spread_km` is the median distance of those shows from it.

Limits: no sense of era yet; names need a human pass ("Los Angeles rock");
an area named after a country or state ("California") counts for no city;
areas are names only, so an artist from a same-named smaller city with no
shows (Halifax, Nova Scotia) is placed in the bigger one (Halifax, England).
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
DEFAULT_OUT_DIR = ROOT / "scripts" / "data" / "scenes"

RADIUS_KM = 45             # Long Beach and Anaheim are LA; Liverpool (50 km) is not Manchester
MIN_CITY_SHOWS = 1000      # --all: a metro's main city has at least this many shows
REL_WEIGHT = {"member_of": 3, "former_member_of": 3, "support_musician": 2, "opened_for": 2, "produced_for": 1}
CREDIT_CAP = 3             # collaborated_with: one per shared song credit, up to this
BILL_CAP = 3               # one per bill shared here, up to this
LOCAL_MIN_SHOWS = 3
LOCAL_SHARE = 0.6
ADOPT_WEIGHT = 3           # an artist with no city joins one with at least this much tie weight to its artists...
ADOPT_SHARE = 2 / 3        # ...making up at least this share of all its ties
CORE_SHARE = 0.5
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


def home_city(shows: Shows, mbid: str, area: str) -> tuple | None:
    """The city key an artist's area names: of several cities with that name, the one the artist plays most,
    else the one with the most shows. None if no venue city has that name."""
    keys = shows.keys_by_name.get(area_key(area))
    if not keys:
        return None
    if len(keys) == 1:
        return keys[0]
    plays = shows.artist_cities.get(mbid, Counter())
    return max(keys, key=lambda k: (plays[k], shows.city_shows[k]))


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


def _adopted(graph: Graph, shows: Shows, metro: Metro, local: set, homes: dict) -> set:
    """Artists with no city of their own whose ties are mostly to this metro's artists: at least ADOPT_WEIGHT,
    and at least ADOPT_SHARE of all their ties anywhere. Their MusicBrainz area must be empty, this metro's
    country or one of its states, or a place that isn't a country or state at all ("Orange County", "Silver
    Lake"); never another country or state. One round: an adopted artist doesn't bring in others."""
    country = norm(metro.country)
    mine = {country} | {norm(v["state"]) for v in shows.venues.values() if norm(v["country"]) == country and v["state"]}
    regions = {norm(v["country"]) for v in shows.venues.values()} | \
              {norm(v["state"]) for v in shows.venues.values() if v["state"]}

    def may_adopt(m):
        if m in local or m in homes or m not in graph.nodes:
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


def home_cities(shows: Shows, graph: Graph) -> dict:
    """mbid -> the city key its MusicBrainz area names (see home_city), for artists whose area is a venue city."""
    homes = {}
    for m, (_, _, area, _) in graph.nodes.items():
        if area:
            home = home_city(shows, m, area)
            if home is not None:
                homes[m] = home
    return homes


def find(shows: Shows, graph: Graph, metro: Metro, extra_areas: tuple[str, ...] = (), lastfm: dict | None = None,
         min_size: int = MIN_SIZE, resolution: float = RESOLUTION, seed: int = SEED, homes: dict | None = None) -> dict:
    """One metro's scenes, as a JSON-ready dict. homes: home_cities(), computed once for many metros."""
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

    how: dict = {}        # mbid -> why it's local: "area", "shows" or "ties"
    for m, home in homes.items():
        if home in metro.city_keys:
            how[m] = "area"
    if extra:
        for m, (_, _, area, _) in nodes.items():
            if area and area_key(area) in extra:
                how.setdefault(m, "area")
    for m, k in plays_here.items():
        if m in nodes and k >= LOCAL_MIN_SHOWS and k >= LOCAL_SHARE * shows.plays[m]:
            how.setdefault(m, "shows")
    for m in _adopted(graph, shows, metro, set(how), homes):
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
    for group in (_louvain(weights, resolution, seed) if weights else []):
        inside: Counter = Counter()
        for (a, b), w in weights.items():
            if a in group and b in group:
                inside[a] += w
                inside[b] += w
        core = {m for m in group if inside[m] >= CORE_WEIGHT and inside[m] >= CORE_SHARE * strength[m]}
        if len(core) >= min_size:
            scenes.append(_describe(core, inside, graph, base, metro, bills_here, lastfm, how))
    scenes.sort(key=lambda s: -s["weight"])
    used: Counter = Counter()
    mid = metro_id(metro)
    for i, s in enumerate(scenes, 1):
        s["id"] = f"{mid}-{i}"
        styles = [g for g, _, _ in s["distinctive_genres"]]
        if "lastfm" in s:
            styles += [t for t in _style_tags(s["lastfm"]["distinctive_tags"], base.place_words) if t not in styles]
        s["name"] = _name(s.pop("_place"), styles, used)
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


def _name(place: str, genres: list[str], used: Counter) -> str:
    """The place and the first genre (or Last.fm tag) a bigger scene there hasn't taken; "<place> scene" without
    one."""
    for g in genres:
        name = _with_place(place, g)
        if not used[name]:
            used[name] += 1
            return name
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


def _describe(core, inside, graph: Graph, base: _Baseline, metro: Metro, bills_here, lastfm, how) -> dict:
    nodes = graph.nodes
    has = [m for m in core if nodes[m][3]]
    gc = Counter(graph.genre_name.get(g, str(g)) for m in has for g in set(nodes[m][3]))
    gbase = Counter({graph.genre_name.get(g, str(g)): k for g, k in base.genres.items()})
    top_genres, distinctive = _ranked(gc, len(has), gbase, base.with_genres)

    # Places within the city the artists come from (narrower than the city itself).
    city = norm(metro.name)
    homes = Counter(nodes[m][2] for m in core if area_key(nodes[m][2]) in metro.places and area_key(nodes[m][2]) != city)
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

    artists = sorted(core, key=lambda m: (-inside[m], nodes[m][0]))
    scene = {
        "name": None, "_place": place_name, "size": len(core), "weight": sum(inside[m] for m in core) // 2,
        "location": location,
        "top_genres": top_genres, "distinctive_genres": distinctive,
        "places": [[p, k] for p, k in homes.most_common(5)],
        "artists": [{"id": m, "name": nodes[m][0], "type": nodes[m][1], "links": inside[m], "local": how[m]}
                    for m in artists],
    }
    if lastfm is not None:
        scene["lastfm"] = _lastfm_summary(core, nodes, lastfm, base)
    return scene


def _lastfm_summary(core, nodes, lastfm, base: _Baseline) -> dict:
    tagged = [m for m in core if lastfm.get(m, (0, []))[1]]
    tc = Counter(t for m in tagged for t in set(lastfm[m][1]) if t not in GENERIC_TAGS)
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


def default_path(city: str | None) -> Path:
    return DEFAULT_OUT_DIR / (f"{slug(city)}.json" if city else "scenes.json")


def _print_city(c: dict) -> None:
    print(f"{c['city']}, {c['country'] or '?'}: {len(c['scenes'])} scenes, {c['in_scenes']:,} of"
          f" {c['local_artists']:,} local artists")
    for s in c["scenes"]:
        loc = s["location"]
        tags = ", ".join(t for t, *_ in s.get("lastfm", {}).get("distinctive_tags", [])[:3])
        print(f"  {s['name'][:38]:<38} {s['size']:>4}  {loc['place'] or '?'} ({loc['source']})"
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
    p.add_argument("--radius-km", type=float, default=RADIUS_KM)
    p.add_argument("--area", action="append", default=[],
                   help="--city: a MusicBrainz area that also counts as the city, e.g. 'Orange County' (repeatable)")
    p.add_argument("--min-size", type=int, default=MIN_SIZE, help="smallest scene, in artists")
    p.add_argument("--resolution", type=float, default=RESOLUTION, help="higher splits into more, smaller scenes")
    p.add_argument("--out", help="default scripts/data/scenes/<city>.json, or scenes.json with --all")
    args = p.parse_args(argv)

    shows = read_shows(args.shows)
    conn, tmp = open_graph(Path(args.graph))
    try:
        graph = load_graph(conn)
        lastfm = read_lastfm(args.lastfm, set(graph.nodes)) if args.lastfm else None
        metros = (major_metros(shows, args.min_shows, args.radius_km) if args.all
                  else [metro_for(shows, find_city(shows, args.city), args.radius_km)])
        homes = home_cities(shows, graph)
        cities = [find(shows, graph, m, extra_areas=tuple(args.area), lastfm=lastfm, min_size=args.min_size,
                       resolution=args.resolution, homes=homes) for m in metros]
    finally:
        conn.close()
        if tmp:
            tmp.unlink(missing_ok=True)
    meta = {"generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "graph_built_at": graph.built_at, "lastfm": Path(args.lastfm).name if args.lastfm else None}
    result = {**meta, "cities": cities} if args.all else {**meta, **cities[0]}
    out = write(result, args.out or default_path(None if args.all else args.city))
    for c in cities:
        _print_city(c)
    print(f"{len(cities)} cities, {sum(len(c['scenes']) for c in cities)} scenes; wrote {out}")


if __name__ == "__main__":
    main()
