import { describe, expect, it } from "vitest";
import {
  labelCities,
  DECADES, HOME, MAX_ZOOM, WORLD, citiesByName, cityBubbles, clampView, colorFor, decadeOf, eraGradient, filterScenes,
  loadScenes, matches, panBy, placeScenes, project, scatterLayout, scenesUrls, shortName, viewBox, zoomAt,
  type Scene, type ScenesData,
} from "../scenes/sceneMap";

function scene(id: string, over: Partial<Scene> = {}): Scene {
  return {
    id, name: `Seattle ${id}`, size: 40, era: { from: 1985, to: 1992, peak: 1987, label: "1985–1992" },
    location: { lat: 47.6, lon: -122.33, place: "Seattle", venue: "The Showbox" },
    genres: ["grunge", "alternative rock"], tags: ["seattle sound"], artists: [["n1", "Nirvana"], ["m1", "Melvins"]],
    ...over,
  };
}

const DATA: ScenesData = {
  cities: [
    { id: "seattle", city: "Seattle", country: "United States", centre: { lat: 47.6, lon: -122.33 },
      scenes: [scene("grunge"), scene("riot", { name: "Olympia riot grrrl", era: { from: 1990, to: 2002, peak: 1991, label: "1990–2002" }, artists: [["b1", "Bikini Kill"]], genres: ["riot grrrl"], tags: [] }),
        scene("funk", { era: { from: 2011, to: 2021, peak: 2014, label: "2011–2021" }, location: { lat: 47.7, lon: -122.3, place: "Seattle", venue: null } })] },
    { id: "liverpool", city: "Liverpool", country: "United Kingdom", centre: { lat: 53.4, lon: -2.98 },
      scenes: [scene("mersey", { name: "Liverpool merseybeat", era: { from: 1959, to: 1963, peak: 1960, label: "1959–1963" }, location: { lat: 53.4, lon: -2.98, place: "Liverpool", venue: "Cavern Club" } })] },
    { id: "nowhere", city: "Nowhere", country: null, centre: { lat: 0, lon: 0 }, scenes: [] },
  ],
};

describe("scene map helpers", () => {
  it("buckets eras by the peak's decade, with the ends grouped", () => {
    expect(decadeOf(scene("a"))).toBe(1980);
    expect(decadeOf(scene("a", { era: { from: 1940, to: 1950, peak: 1945, label: "" } }))).toBe(1950);
    expect(decadeOf(scene("a", { era: { from: 2015, to: 2024, peak: 2020, label: "" } }))).toBe(2010);
    expect(decadeOf(scene("a", { era: null }))).toBeNull();
    expect(colorFor(scene("a"))).toBe(DECADES.find((d) => d.start === 1980)!.color);
    expect(colorFor(scene("a", { era: null }))).toBe("#4a4a4a");
  });

  it("colours eras from grey (oldest) to green (newest)", () => {
    expect(eraGradient(0)).toBe("#808080");
    expect(eraGradient(1)).toBe("#2ecc71");
    expect(eraGradient(0.5)).toBe("#57a679");
    expect(DECADES[0]!.color).toBe("#808080");
    expect(DECADES[DECADES.length - 1]!.color).toBe("#2ecc71");
    expect(new Set(DECADES.map((d) => d.color)).size).toBe(DECADES.length);
  });

  it("scatters an open city's scenes around it, biggest nearest, names level and never overlapping", () => {
    const many = Array.from({ length: 40 }, (_, i) => scene(`s${i}`, { name: `Seattle scene ${i}`, size: 100 - i }));
    const width = (s: Scene) => 6 * s.name.length;
    const room = { left: -400, right: 400, top: -250, bottom: 250 };
    const out = scatterLayout(many, width, 50, room);
    expect(out.map((o) => o.scene.id)).toEqual(many.map((s) => s.id));                // biggest first
    const dist = out.map((o) => Math.hypot(o.dx, o.dy));
    expect(dist[0]).toBeLessThan(dist[dist.length - 1]!);                              // biggest nearest
    for (const o of out) {
      expect(dist[out.indexOf(o)]).toBeGreaterThanOrEqual(34);                          // clear of the city
      expect(o.side).toBe(o.dx < 0 ? "left" : "right");                                // name away from the city
    }
    const box = (o: (typeof out)[number]) => {
      const w = width(o.scene);
      return o.side === "right" ? [o.dx - 13, o.dy - 9, o.dx + 13 + w, o.dy + 9] : [o.dx - 13 - w, o.dy - 9, o.dx + 13, o.dy + 9];
    };
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
      const [a, b] = [box(out[i]!), box(out[j]!)];
      expect(a[0]! < b[2]! && b[0]! < a[2]! && a[1]! < b[3]! && b[1]! < a[3]!).toBe(false);
    }
    for (const b of out.map(box)) expect(b[0]! >= room.left && b[2]! <= room.right && b[1]! >= room.top && b[3]! <= room.bottom).toBe(true);
    expect(scatterLayout(many, width, 50, room)).toEqual(out);
    const corner = { left: -400, right: -200, top: -250, bottom: -100 };          // say, buttons in a corner
    for (const b of scatterLayout(many, width, 50, room, [corner]).map(box))
      expect(b[0]! < corner.right && corner.left < b[2]! && b[1]! < corner.bottom && corner.top < b[3]!).toBe(false);                          // the same every time
    // A room too small for them all: the rest spill outside it, still without overlapping.
    const small = scatterLayout(many, width, 50, { left: -100, right: 100, top: -80, bottom: 80 });
    expect(small).toHaveLength(many.length);
    expect(small.some((o) => Math.abs(o.dx) > 100 || Math.abs(o.dy) > 80)).toBe(true);
    expect(shortName("Seattle grunge", "Seattle")).toBe("grunge");
    expect(shortName("Olympia riot grrrl", "Seattle")).toBe("Olympia riot grrrl");
  });

  it("names every city that has room, biggest first, moving a name aside before dropping it", () => {
    const labels = labelCities([
      { id: "big", x: 100, y: 100, count: 50, width: 60 },
      { id: "pushed", x: 100, y: 136, count: 5, width: 60 },     // a dot just below it takes its spot below
      { id: "small", x: 100, y: 155, count: 1, width: 60 },      // small but with room: named
    ], 7);
    expect(labels.get("big")).toEqual({ dx: 0, dy: 16.5, anchor: "middle" });
    expect(labels.get("pushed")).toEqual({ dx: 10, dy: 0, anchor: "start" });
    expect(labels.get("small")?.anchor).toBe("middle");
    // Crowded: three cities on one spot; the biggest is named, the rest wait for a closer zoom.
    const crowd = labelCities([0, 1, 2, 3, 4].map((i) => ({ id: `c${i}`, x: 50, y: 50, count: 10 - i, width: 40 })), 7);
    expect(crowd.has("c0")).toBe(true);
    expect(crowd.size).toBeLessThan(5);
  });

  it("projects latitude and longitude onto the Mercator world map", () => {
    const [x0, y0] = project(WORLD.north, WORLD.west);
    expect(x0).toBeCloseTo(0, 6);
    expect(y0).toBeCloseTo(0, 6);
    const [x1, y1] = project(WORLD.south, WORLD.east);
    expect(x1).toBeCloseTo(WORLD.width, 6);
    expect(y1).toBeCloseTo(WORLD.height, 6);
    // Reykjavik sits inside Iceland's outline in MapSVG's world.svg (x 406-437, y 211-232)
    const [rx, ry] = project(64.15, -21.94);
    expect(rx).toBeGreaterThan(406); expect(rx).toBeLessThan(437);
    expect(ry).toBeGreaterThan(211); expect(ry).toBeLessThan(232);
    // east of 190°E wraps: 175°W is 185°E
    expect(project(0, -175)[0]).toBeCloseTo(project(0, 185)[0], 6);
  });

  it("groups scenes into city bubbles coloured by the decade most of their artists share", () => {
    const placed = placeScenes(DATA);
    const centres = new Map([["seattle", { lat: 47.61, lon: -122.33 }]]);
    const b = cityBubbles(placed, centres);
    expect(b.map((x) => [x.cityId, x.count, x.decade])).toEqual([["seattle", 3, 1980], ["liverpool", 1, 1960]]);
    expect(b[0]!.lat).toBe(47.61);                                         // the city's centre
    expect(b[1]!.lat).toBe(53.4);                                          // no centre given: its scene's point
  });

  it("pans and zooms the view, keeping the point under the cursor", () => {
    const wide = viewBox(HOME, 1000, 500);                                 // the whole world fits:
    expect(wide.h).toBeCloseTo(WORLD.height, 6);                           // its height on a wide screen
    expect(wide.w).toBeGreaterThan(WORLD.width);
    expect(viewBox(HOME, 400, 800).w).toBeCloseTo(WORLD.width, 6);         // its width on a tall one
    const v = zoomAt(HOME, 4, 250, 100, 1000, 500);
    const before = viewBox(HOME, 1000, 500), after = viewBox(v, 1000, 500);
    expect(before.x + 250 * before.unitsPerPx).toBeCloseTo(after.x + 250 * after.unitsPerPx, 6);
    expect(before.y + 100 * before.unitsPerPx).toBeCloseTo(after.y + 100 * after.unitsPerPx, 6);
    expect(v.k).toBe(4);
    const moved = panBy(v, 100, 0, 1000, 500);
    expect(moved.cx).toBeCloseTo(v.cx - 100 * after.unitsPerPx, 6);
    expect(clampView({ cx: -50, cy: 9999, k: 1e6 })).toEqual({ cx: 0, cy: WORLD.height, k: MAX_ZOOM });
    expect(zoomAt(HOME, 0.1, 0, 0, 1000, 500).k).toBe(1);
  });

  it("filters by text (name, city, genre, tag, artist) and decades, none picked being all", () => {
    const placed = placeScenes(DATA);
    const ids = (q: string, d: number | null = null) => filterScenes(placed, q, new Set(d === null ? [] : [d])).map((s) => s.id);
    expect(ids("")).toHaveLength(4);
    expect(ids("riot")).toEqual(["riot"]);
    expect(ids("liverpool")).toEqual(["mersey"]);
    expect(ids("GRUNGE")).toEqual(["grunge", "funk", "mersey"]);
    expect(ids("seattle sound")).toEqual(["grunge", "funk", "mersey"]);
    expect(ids("bikini")).toEqual(["riot"]);
    expect(ids("", 1990)).toEqual(["riot"]);
    expect(ids("nirvana", 1960)).toEqual(["mersey"]);
    expect(ids("nirvana", 1950)).toEqual([]);
    expect(matches(placed[0]!, "  ")).toBe(true);
    expect(filterScenes(placed, "", new Set([1960, 1980])).map((s) => s.id)).toEqual(["grunge", "mersey"]);
    expect(filterScenes(placed, "", new Set(DECADES.map((d) => d.start))).map((s) => s.id))
      .toEqual(filterScenes(placed, "", new Set()).map((s) => s.id));
  });

  it("lists cities with scenes, A to Z", () => {
    expect(citiesByName(DATA).map((c) => c.id)).toEqual(["liverpool", "seattle"]);
  });

  it("loads the scenes file next to the app first, then next to the graph on the CDN", async () => {
    expect(scenesUrls("/", "https://cdn.banded.fm/graph.db.gz")).toEqual(["/scenes.json", "https://cdn.banded.fm/scenes.json"]);
    expect(scenesUrls("/banded/", "")).toEqual(["/banded/scenes.json"]);
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return url === "/scenes.json"
        ? new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })
        : new Response(JSON.stringify(DATA), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const data = await loadScenes(["/scenes.json", "https://cdn/scenes.json"], fetchImpl);
    expect(data.cities).toHaveLength(3);
    expect(seen).toEqual(["/scenes.json", "https://cdn/scenes.json"]);
    const failing = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    await expect(loadScenes(["/a.json"], failing)).rejects.toThrow("Scenes could not be loaded. Tried: /a.json → 404");
  });
});
