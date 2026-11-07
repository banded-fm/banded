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
          "Port City Music Hall": (9, "Portland", "Maine", (43.66, -70.26)),
          "Riverside Plaza": (10, "Riverside", "California", (33.95, -117.40)),   # ~80 km from LA: nearby
          "Riverside Tavern": (11, "Riverside", "England", (51.50, -0.10))}


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
        ("adoptee", "No Area", "person", "", "1"),               # records with the punks, no area: adopted
        ("cali", "Cali", "person", "California", "1"),           # records with the punks, a state: adopted
        ("brit", "Brit", "person", "United Kingdom", "1"),       # records with the punks, another country: not
        ("split", "Split", "person", "", "1"),                   # half its ties elsewhere: not adopted
    ]
    edges = punk_e + rap_e + [("kim", "r1", "collaborated_with", 1), ("sf", "p0", "opened_for", None),
                              ("adoptee", "p1", "collaborated_with", 3), ("adoptee", "p2", "collaborated_with", 3),
                              ("cali", "p2", "collaborated_with", 3), ("cali", "p3", "collaborated_with", 3),
                              ("brit", "p3", "collaborated_with", 3), ("brit", "p4", "collaborated_with", 3),
                              ("split", "p0", "collaborated_with", 3), ("split", "sf", "collaborated_with", 3)]
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
    show("2025-08-08", "Riverside Plaza", ["x7"])
    show("2025-08-09", "Riverside Tavern", ["x8"])
    show("2025-08-10", "Riverside Tavern", ["x9"])          # the English Riverside has more shows
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


# MusicBrainz's area tree, as the dump files in scripts/data/mbdump hold it (tab-separated, \N for null).
AREAS = [  # id, name, type (1 country, 2 subdivision, 3 city, 5 district, 7 county), part of
    ("1", "United States", "1", None), ("2", "California", "2", "1"), ("3", "Los Angeles", "3", "2"),
    ("4", "Silver Lake", "5", "3"), ("6", "Riverside County", "7", "2"), ("5", "Riverside", "3", "6"),
    ("10", "Corona", "3", "6"), ("7", "United Kingdom", "1", None), ("8", "England", "2", "7"),
    ("9", "Riverside", "3", "8")]
AREA_ARTISTS = [  # mbid, name, area id (the graph has the area's name)
    ("rivband", "River Band", "5"), ("silver", "Silver", "4"), ("corona", "Corona Band", "10")]


@pytest.fixture
def mbdump(tmp_path, conn):
    d = tmp_path / "mbdump"
    d.mkdir()
    N = "\\N"
    (d / "area").write_text("".join(f"{i}\tgid{i}\t{n}\t{t}\t0\n" for i, n, t, _ in AREAS))
    (d / "link_type").write_text(f"356\t{N}\t0\tgid\tarea\tarea\tpart of\n"
                                 f"103\t{N}\t0\tgid\tartist\tartist\tmember of band\n")
    (d / "link").write_text("118734\t356\t\n")
    (d / "l_area_area").write_text("".join(f"{k}\t118734\t{p}\t{i}\t0\n"
                                           for k, (i, _, _, p) in enumerate(AREAS) if p))
    rows = []
    for m, name, aid in AREA_ARTISTS:
        rows.append("\t".join([str(len(rows) + 1), m, name, name] + [N] * 7 + [aid] + [N] * 5 + [N, N]))
        conn.execute("INSERT INTO nodes VALUES (?, ?, 'group', NULL, ?, '1')", (m, name, dict((i, n) for i, n, _, _ in AREAS)[aid]))
    (d / "artist").write_text("\n".join(rows) + "\n")
    (d / "l_artist_artist").write_text("")
    return d


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


def test_area_tree(conn, shows_csv, mbdump):
    shows, graph = fs.read_shows(shows_csv), fs.load_graph(conn)
    areas = fs.read_areas(mbdump, {m: n[2] for m, n in graph.nodes.items() if n[2]})
    assert areas.path("4") == (["4", "3"], "California", "United States")
    by_name = fs.home_cities(shows, graph)
    tree = fs.home_cities(shows, graph, areas)
    riverside_ca, riverside_uk = ("riverside", "california", "united states"), ("riverside", "england", "united kingdom")
    assert by_name["rivband"] == riverside_uk           # by name: the Riverside with more shows
    assert tree["rivband"] == riverside_ca              # the area tree knows it's in California
    assert tree["silver"] == ("los angeles", "california", "united states")   # a district -> its city
    assert tree["corona"] == riverside_ca               # not a venue city: the venue city in its county
    assert "corona" not in by_name
    assert fs.read_areas(mbdump.parent / "nowhere", {}) is None


def test_nearby_towns_and_band_members(conn, shows_csv, mbdump):
    shows, graph = fs.read_shows(shows_csv), fs.load_graph(conn)
    areas = fs.read_areas(mbdump, {m: n[2] for m, n in graph.nodes.items() if n[2]})
    la = fs.metro_for(shows, fs.find_city(shows, "Los Angeles"))
    sf = fs.metro_for(shows, fs.find_city(shows, "San Francisco"))
    fs.assign_nearby(shows, [la, sf])
    assert ("riverside", "california", "united states") in la.nearby and not sf.nearby
    conn.execute("INSERT INTO nodes VALUES ('drummer', 'Drummer', 'person', NULL, 'Warren', '1')")   # Ohio
    conn.execute("INSERT INTO edges VALUES ('drummer', 'p0', 'member_of', NULL)")
    graph = fs.load_graph(conn)
    r = fs.find(shows, graph, la, homes=fs.home_cities(shows, graph, areas))
    assert r["local_by"]["nearby"] == 2                 # River Band and Corona Band
    punk = next(s for s in r["scenes"] if s["name"] == "Los Angeles punk")
    assert {a["id"]: a["local"] for a in punk["artists"]}["drummer"] == "band"


def test_a_band_between_scenes_stays_with_the_stronger(conn, shows_csv):
    oc_n, oc_e = _band("o", "Los Angeles", 4)
    conn.executemany("INSERT INTO nodes VALUES (?, ?, ?, NULL, ?, ?)", oc_n)
    conn.executemany("INSERT INTO edges VALUES (?, ?, ?, ?)", oc_e)
    # 4 of its 10 ties to the punks, 3 to the rock band, 3 to the rappers: under half, but the strongest
    conn.execute("INSERT INTO nodes VALUES ('bridge', 'Bridge', 'group', NULL, 'Los Angeles', '1')")
    conn.executemany("INSERT INTO edges VALUES (?, ?, 'collaborated_with', ?)",
                     [("bridge", "p1", 3), ("bridge", "p2", 1), ("bridge", "o1", 3), ("bridge", "r1", 3)])
    scenes = _la(shows_csv, conn)["scenes"]
    assert [s["name"] for s in scenes if any(a["id"] == "bridge" for a in s["artists"])] == ["Los Angeles punk"]


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


def test_fetch_area_tree(tmp_path, monkeypatch):
    """Streams the dump until it has l_area_area (and area if missing), then stops."""
    import io
    import tarfile
    import urllib.request
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:bz2") as tar:
        for name, data in (("mbdump/artist", b"x\n"), ("mbdump/l_area_area", b"1\t2\t3\t4\n"),
                           ("mbdump/zzz_never_read", b"y\n")):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    urls = []

    def fake_urlopen(req, timeout=None):
        urls.append(req.full_url)
        return io.BytesIO(b"20261104-001001\n" if req.full_url.endswith("LATEST") else buf.getvalue())
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    d = tmp_path / "mbdump"
    d.mkdir()
    (d / "area").write_text("already here\n")
    assert fs.fetch_area_tree(d) == ["mbdump/l_area_area"]
    assert (d / "l_area_area").read_text() == "1\t2\t3\t4\n" and not (d / "artist").exists()
    assert urls[1].endswith("/20261104-001001/mbdump.tar.bz2")
    assert fs.fetch_area_tree(d) == []                  # nothing to do the second time


@pytest.fixture
def era_dump(tmp_path):
    """The MusicBrainz tables read_years reads: a band formed in 1985 and dissolved in 1994, a member who
    joined in 1987, and a solo artist with releases from 1989 to 2010."""
    d = tmp_path / "era"
    d.mkdir()
    N = "\\N"

    def artist(rid, mbid, typ, begin=N, end=N):
        return "\t".join([rid, mbid, mbid, mbid, begin, N, N, end, N, N, typ, N, N, "", "0", "", "f"])
    (d / "artist").write_text("\n".join([artist("1", "g1", "2", "1985", "1994"), artist("2", "p1", "1"),
                                         artist("3", "p2", "1"), artist("4", "other", "1")]) + "\n")
    (d / "artist_credit_name").write_text("10\t0\t1\tG\t\n11\t0\t3\tP2\t\n12\t0\t1\tG\t & \n12\t1\t3\tP2\t\n")
    (d / "release_group").write_text("".join(f"{i}\tgid{i}\tname\t{ac}\t1\t\t0\t\n"
                                             for i, ac in ((1, 10), (2, 11), (3, 11), (4, 11), (5, 12))))
    (d / "release_group_meta").write_text(f"1\t1\t1988\t1\t1\t{N}\t{N}\n2\t1\t1990\t{N}\t{N}\t{N}\t{N}\n"
                                          f"3\t1\t1991\t{N}\t{N}\t{N}\t{N}\n4\t1\t2010\t{N}\t{N}\t{N}\t{N}\n"
                                          f"5\t1\t1989\t{N}\t{N}\t{N}\t{N}\n")
    (d / "link_type").write_text(f"103\t{N}\t0\tgid\tartist\tartist\tmember of band\t\n")
    (d / "link").write_text(f"500\t103\t1987\t{N}\t{N}\t{N}\t{N}\t{N}\t0\t\tf\n")
    (d / "l_artist_artist").write_text("1\t500\t2\t1\t0\t\t0\t\t\n")
    return d


def test_years_and_era(era_dump, tmp_path):
    years = fs.read_years(era_dump, {"g1", "p1", "p2"})
    assert years.span["g1"] == (1985, 1994)          # formed and dissolved
    assert years.span["p1"] == (1987, 1987)          # only a dated membership
    assert years.span["p2"] == (1989, 2010)          # its releases (10th to 90th percentile)
    assert years.member == {("p1", "g1"): (1987, None)} and "other" not in years.span
    era = fs.era_of({"g1", "p1", "p2"}, years, Counter({"g1": 6, "p1": 3, "p2": 1}))
    assert (era["from"], era["to"], era["peak"], era["label"]) == (1985, 1987, 1987, "1985–1987")
    assert era["decades"] == {"1980s": 1.0} and era["dated_artists"] == 3
    assert fs.era_of({"other"}, years, Counter()) is None
    assert fs.read_years(tmp_path / "nowhere", set()) is None


def test_names_with_era():
    used = Counter()
    assert fs._name("Seattle", ["grunge"], used, "1985–1992") == "Seattle grunge"
    assert fs._name("Seattle", ["grunge", "punk"], used, "1995–2003") == "Seattle grunge (1995–2003)"
    assert fs._name("Seattle", ["grunge"], used, "1995–2003") == "Seattle grunge 2"


def test_fetch_release_dates(tmp_path, monkeypatch):
    import io
    import tarfile
    import urllib.request
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:bz2") as tar:
        for name, data in (("mbdump/artist_tag", b"x\n"), ("mbdump/release_group_meta", b"1\t1\t1988\n")):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    urls = []

    def fake_urlopen(req, timeout=None):
        urls.append(req.full_url)
        return io.BytesIO(b"20261104-001001\n" if req.full_url.endswith("LATEST") else buf.getvalue())
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    assert fs.fetch_release_dates(tmp_path) == ["mbdump/release_group_meta"]
    assert urls[1].endswith("/mbdump-derived.tar.bz2") and (tmp_path / "release_group_meta").exists()
