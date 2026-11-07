"""Offline tests for find_scenes.py: python3 -m pytest scripts/test_find_scenes.py (needs networkx)."""
import csv
import json
import sqlite3
import sys
import zipfile
from collections import Counter
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import find_scenes as fs  # noqa: E402

pytest.importorskip("networkx")

LA, LB, SF = (34.05, -118.25), (33.77, -118.19), (37.77, -122.42)
GENRES = {1: "punk", 2: "hip hop", 3: "pop", 4: "rock"}
HEADER = ["show_id", "date", "is_festival", "venue_id", "venue", "city", "state", "country", "lat", "lon",
          "mbid", "artist", "role", "confidence"]
VENUES = {"The Echo": (1, "Los Angeles", "California", LA), "Bottom of the Hill": (2, "San Francisco", "California", SF),
          "Alex's Bar": (3, "Long Beach", "California", LB), "Coachella": (4, "Indio", "California", (33.68, -116.24)),
          "O2 Institute": (5, "Birmingham", "England", (52.48, -1.89)),
          "Saturn": (6, "Birmingham", "Alabama", (33.52, -86.80)),
          "Arena": (7, "Vienna", "", (48.19, 16.38)),
          "Mississippi Studios": (8, "Portland", "Oregon", (45.55, -122.68)),
          "Port City Music Hall": (9, "Portland", "Maine", (43.66, -70.26))}


def _band(prefix, area, genre, n=9):
    """A group and n-1 members who also all record together (dense enough to stay one group on its own)."""
    nodes = [(f"{prefix}0", f"{prefix.upper()} Band", "group", area, str(genre))]
    nodes += [(f"{prefix}{i}", f"{prefix.upper()} {i}", "person", area, str(genre)) for i in range(1, n)]
    edges = [(f"{prefix}{i}", f"{prefix}0", "member_of", None) for i in range(1, n)]
    edges += [(f"{prefix}{i}", f"{prefix}{j}", "collaborated_with", 3) for i in range(1, n) for j in range(i + 1, n)]
    return nodes, edges


@pytest.fixture
def conn(tmp_path):
    punk_n, punk_e = _band("p", "Los Angeles", 1)
    rap_n, rap_e = _band("r", "Long Beach", 2)
    nodes = punk_n + rap_n + [
        ("kim", "Kim", "person", "Los Angeles", "3"),            # one song with a rapper: no scene
        ("sf", "SF Band", "group", "San Francisco", "4"),        # not local: ignored
        ("local", "Local Openers", "group", "", "1"),            # no area, but plays LA almost only
        ("brum", "Brum Band", "group", "Birmingham", "4"),       # no shows: the bigger Birmingham
        ("bama", "Bama Band", "group", "Birmingham", "4"),       # plays Birmingham, Alabama
        ("wien", "Wiener", "person", "Wien", "4"),               # MusicBrainz's local name for Vienna
        ("adoptee", "No Area", "person", "", "1"),               # in the punk band, no area: adopted
        ("cali", "Cali", "person", "California", "1"),           # in the punk band, a state of the country: adopted
        ("brit", "Brit", "person", "United Kingdom", "1"),       # in the punk band, but another country: not
        ("split", "Split", "person", "", "1"),                   # half its ties elsewhere: not adopted
    ]
    edges = punk_e + rap_e + [("kim", "r1", "collaborated_with", 1), ("sf", "p0", "opened_for", None),
                              ("adoptee", "p0", "member_of", None), ("adoptee", "p1", "collaborated_with", 3),
                              ("cali", "p0", "member_of", None), ("cali", "p2", "collaborated_with", 3),
                              ("brit", "p0", "member_of", None), ("brit", "p3", "collaborated_with", 3),
                              ("split", "p0", "member_of", None), ("split", "sf", "member_of", None)]
    g = sqlite3.connect(tmp_path / "graph.db")
    g.executescript("""
        CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, type TEXT, disambiguation TEXT, area TEXT, genres TEXT);
        CREATE TABLE edges (source TEXT, target TEXT, rel_type TEXT, count INTEGER);
        CREATE TABLE genres (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE graph_meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO graph_meta VALUES ('built_at', '2026-11-01');""")
    g.executemany("INSERT INTO genres VALUES (?, ?)", GENRES.items())
    g.executemany("INSERT INTO nodes VALUES (?, ?, ?, NULL, ?, ?)", nodes)
    g.executemany("INSERT INTO edges VALUES (?, ?, ?, ?)", edges)
    g.commit()
    yield g
    g.close()


@pytest.fixture
def shows_csv(tmp_path):
    """The punk band and its members share bills at the Echo with Local Openers."""
    rows, show_id = [], 0

    def show(date, venue, acts, festival=0):
        nonlocal show_id
        show_id += 1
        vid, city, state, (lat, lon) = VENUES[venue]
        country = "Austria" if city == "Vienna" else "United Kingdom" if state == "England" else "United States"
        for i, m in enumerate(acts):
            rows.append([show_id, date, festival, vid, venue, city, state, country, lat, lon, m, m,
                         "headliner" if i == 0 else "opener", 1.0])
    for d in range(1, 5):
        show(f"2025-0{d}-01", "The Echo", ["p0", "local", f"p{d}"])
    show("2025-06-01", "Bottom of the Hill", ["sf", "p0"])
    show("2025-07-01", "Alex's Bar", ["r0"])
    show("2025-04-20", "Coachella", ["r0", "r1", "r2", "kim"], festival=1)     # festivals don't count
    show("2025-08-01", "O2 Institute", ["x1"])
    show("2025-08-02", "O2 Institute", ["x2"])
    show("2025-08-03", "Saturn", ["bama"])
    show("2025-08-04", "Arena", ["x3"])
    show("2025-08-05", "Mississippi Studios", ["x4"])
    show("2025-08-06", "Mississippi Studios", ["x5"])
    show("2025-08-07", "Port City Music Hall", ["x6"])
    path = tmp_path / "shows.csv"
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(HEADER)
        w.writerows(rows)
    return path


@pytest.fixture
def lastfm_zip(tmp_path):
    """A slice of the Kaggle "Music artists popularity" artists.csv, zipped as it is downloaded."""
    path = tmp_path / "artists.csv"
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["mbid", "artist_mb", "artist_lastfm", "country_mb", "country_lastfm", "tags_mb", "tags_lastfm",
                    "listeners_lastfm", "scrobbles_lastfm", "ambiguous_artist"])
        for i in range(9):
            tags = "punk; seen live; la punk scene; 80s; american; skate punk" if i < 6 else "punk; hardcore"
            w.writerow([f"p{i}", f"P {i}", f"P {i}", "", "", "", tags, 1000 * (10 - i), 0, "FALSE"])
        w.writerow(["r0", "R Band", "R Band", "", "", "", "hip-hop; long beach", 50000, 0, "TRUE"])   # ambiguous
    z = tmp_path / "archive.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.write(path, "artists.csv")
    return z


def _la(shows_csv, conn, **kw):
    shows = fs.read_shows(shows_csv)
    return fs.find(shows, fs.load_graph(conn), fs.metro_for(shows, fs.find_city(shows, "Los Angeles")), **kw)


def test_scenes_for_a_city(conn, shows_csv):
    r = _la(shows_csv, conn)
    by_name = {s["name"]: s for s in r["scenes"]}
    assert set(by_name) == {"Los Angeles punk", "Long Beach hip hop"}
    punk, rap = by_name["Los Angeles punk"], by_name["Long Beach hip hop"]
    members = {a["id"] for a in punk["artists"]}
    assert "local" in members                       # counted as local from its shows
    assert "sf" not in members
    assert all(a["id"] != "kim" for s in r["scenes"] for a in s["artists"])
    assert punk["location"]["source"] == "shared bills" and punk["location"]["venue"] == "The Echo"
    assert punk["location"]["place"] == "Los Angeles" and punk["location"]["spread_km"] == 0.0
    assert punk["top_genres"] == [["punk", 1.0]] and punk["distinctive_genres"][0][0] == "punk"
    assert "lastfm" not in punk
    # The rappers have one show here (too few), but come from Long Beach.
    assert rap["location"]["source"] == "home place" and rap["location"]["place"] == "Long Beach"
    assert r["in_scenes"] == punk["size"] + rap["size"] and r["id"] == "los-angeles"


def test_adopted_by_ties(conn, shows_csv):
    r = _la(shows_csv, conn)
    punk = next(s for s in r["scenes"] if s["name"] == "Los Angeles punk")
    why = {a["id"]: a["local"] for a in punk["artists"]}
    assert why["adoptee"] == "ties" and why["cali"] == "ties"
    assert why["p1"] == "area" and why["local"] == "shows"
    assert "brit" not in why and "split" not in why
    assert r["local_by"]["ties"] == 2


def test_radius_and_min_size(conn, shows_csv):
    shows, graph = fs.read_shows(shows_csv), fs.load_graph(conn)
    # Long Beach is ~31 km away. With one band left, the network is that band, and a resolution of 1 or
    # more splits a whole network up (Louvain scores a group against what chance would give), so this
    # call uses 0.5.
    near = fs.find(shows, graph, fs.metro_for(shows, fs.find_city(shows, "Los Angeles"), radius_km=10), resolution=0.5)
    assert [s["name"] for s in near["scenes"]] == ["Los Angeles punk"]
    assert _la(shows_csv, conn, min_size=20)["scenes"] == []
    with pytest.raises(ValueError):
        fs.find_city(shows, "Nowhere")


def test_extra_area(conn, shows_csv):
    oc_n, oc_e = _band("o", "Orange County", 4)
    conn.executemany("INSERT INTO nodes VALUES (?, ?, ?, NULL, ?, ?)", oc_n)
    conn.executemany("INSERT INTO edges VALUES (?, ?, ?, ?)", oc_e)
    assert len(_la(shows_csv, conn)["scenes"]) == 2
    assert "Los Angeles rock" in {s["name"] for s in _la(shows_csv, conn, extra_areas=("Orange County",))["scenes"]}


def test_major_metros_and_cities(shows_csv):
    shows = fs.read_shows(shows_csv)
    metros = fs.major_metros(shows, min_shows=1)
    names = [m.name for m in metros]
    assert names[0] == "Los Angeles" and "Long Beach" not in names and "Indio" not in names   # festival only
    assert {"San Francisco", "Birmingham", "Vienna", "Portland"} <= set(names)
    la = metros[0]
    assert ("long beach", "california", "united states") in la.city_keys
    assert fs.major_metros(shows, min_shows=2)[0].name == "Los Angeles"
    assert [m.name for m in fs.major_metros(shows, min_shows=4)] == ["Los Angeles"]
    # Portland, Oregon has more shows; "Portland, Maine" picks the other.
    assert fs.find_city(shows, "Portland")[1] == "oregon"
    assert fs.find_city(shows, "Portland, Maine")[1] == "maine"


def test_overlapping_metros_split_by_distance(shows_csv):
    shows = fs.read_shows(shows_csv)
    la = fs.metro_for(shows, fs.find_city(shows, "Los Angeles"))
    lb = fs.metro_for(shows, fs.find_city(shows, "Long Beach"))
    assert ("los angeles", "california", "united states") in lb.city_keys    # each alone overlaps the other
    metros = fs.major_metros(shows, min_shows=1, radius_km=40)
    assert [m.name for m in metros].count("Los Angeles") == 1 and "Long Beach" not in [m.name for m in metros]
    assert la.name == "Los Angeles"


def test_home_city_and_aliases(conn, shows_csv):
    shows = fs.read_shows(shows_csv)
    homes = fs.home_cities(shows, fs.load_graph(conn))
    assert homes["brum"] == ("birmingham", "england", "united kingdom")    # no shows: the bigger Birmingham
    assert homes["bama"] == ("birmingham", "alabama", "united states")     # plays there
    assert homes["wien"] == ("vienna", "", "austria")
    assert homes["p1"] == ("los angeles", "california", "united states") and "local" not in homes


def test_lastfm(conn, shows_csv, lastfm_zip):
    lastfm = fs.read_lastfm(lastfm_zip)
    assert "r0" not in lastfm and lastfm["p0"] == (10000, ["punk", "seen live", "la punk scene", "80s", "american",
                                                           "skate punk"])
    assert fs.read_lastfm(lastfm_zip.with_name("artists.csv"), {"p1"}).keys() == {"p1"}
    punk = next(s for s in _la(shows_csv, conn, lastfm=lastfm)["scenes"] if s["name"] == "Los Angeles punk")
    lf = punk["lastfm"]
    assert lf["artists_with_tags"] == 9 and lf["top_tags"][0] == ["punk", 1.0]
    assert "seen live" not in [t for t, _ in lf["top_tags"]]
    assert ["la punk scene", 6] in lf["place_tags"]
    assert lf["most_listened"][0] == ["P Band", 10000]


def test_names():
    used = Counter()
    assert fs._name("LA", ["hip hop", "g-funk"], used) == "LA hip hop"
    assert fs._name("LA", ["hip hop", "g-funk"], used) == "LA g-funk"
    assert fs._name("LA", ["hip hop"], used) == "LA hip hop 2"
    assert fs._name("LA", [], used) == "LA scene"
    assert fs._name("Detroit", ["detroit techno"], Counter()) == "Detroit techno"
    words = fs.re.compile(r"\b(liverpool)\b")
    assert fs._style_tags([["60s", 1], ["british", 1], ["liverpool bands", 1], ["merseybeat", 1]], words) == \
        ["merseybeat"]


def test_km_and_norm():
    assert round(fs.km(LA, SF)) == 559
    assert fs.norm("The Echo") == "echo" and fs.area_key("München") == "munich"


def test_main(conn, shows_csv, lastfm_zip, tmp_path, capsys):
    conn.close()
    graph = str(tmp_path / "graph.db")
    out = tmp_path / "la.json"
    fs.main(["--city", "Los Angeles", "--graph", graph, "--shows", str(shows_csv), "--out", str(out)])
    data = json.loads(out.read_text())
    assert data["city"] == "Los Angeles" and len(data["scenes"]) == 2 and data["graph_built_at"] == "2026-11-01"
    out = tmp_path / "all.json"
    fs.main(["--all", "--min-shows", "1", "--graph", graph, "--shows", str(shows_csv), "--lastfm", str(lastfm_zip),
             "--out", str(out)])
    data = json.loads(out.read_text())
    assert data["lastfm"] == "archive.zip" and data["cities"][0]["city"] == "Los Angeles"
    assert "lastfm" in data["cities"][0]["scenes"][0]
    assert "Los Angeles punk" in capsys.readouterr().out
    assert fs.default_path("Los Angeles") == fs.DEFAULT_OUT_DIR / "los-angeles.json"
    assert fs.default_path(None) == fs.DEFAULT_OUT_DIR / "scenes.json"
