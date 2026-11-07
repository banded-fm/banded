import { describe, expect, it } from "vitest";
import {
  DECADES, HOME, MAX_ZOOM, WORLD, bubbleRadius, citiesBySize, cityBubbles, clampView, colorFor, decadeOf, filterScenes,
  loadScenes, matches, panBy, placeScenes, project, radiusFor, scenesUrls, separate, spiral, viewBox, zoomAt,
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
    expect(colorFor(scene("a", { era: null }))).toBe("#888");
  });

  it("sizes markers by scene size, within bounds", () => {
    expect(radiusFor(8)).toBe(6);
    expect(radiusFor(100)).toBe(10);
    expect(radiusFor(10_000)).toBe(16);
  });

  it("gives scenes at the same point slots, spread on a spiral", () => {
    const placed = placeScenes(DATA);
    expect(placed.map((s) => [s.id, s.slot, s.cityId])).toEqual([
      ["grunge", 0, "seattle"], ["riot", 1, "seattle"], ["funk", 0, "seattle"], ["mersey", 0, "liverpool"]]);
    expect(spiral(0, 15)).toEqual([0, 0]);
    expect(Math.hypot(...spiral(1, 15))).toBeCloseTo(15, 6);
    expect(Math.hypot(...spiral(4, 15))).toBeCloseTo(30, 6);
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
    expect(bubbleRadius(1)).toBe(4);
    expect(bubbleRadius(400)).toBe(15);
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

  it("filters by text (name, city, genre, tag, artist) and decade", () => {
    const placed = placeScenes(DATA);
    const ids = (q: string, d: number | null = null) => filterScenes(placed, q, d).map((s) => s.id);
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
  });

  it("lists cities with scenes, biggest first", () => {
    expect(citiesBySize(DATA).map((c) => c.id)).toEqual(["seattle", "liverpool"]);
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

describe("separate", () => {
  it("pushes overlapping dots apart until each pair is far enough, and leaves spaced ones alone", () => {
    const dots = [{ x: 0, y: 0, r: 5 }, { x: 0, y: 0, r: 5 }, { x: 3, y: 0, r: 10 }, { x: 500, y: 500, r: 5 }];
    separate(dots, 30, 6);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const need = Math.max(30, dots[i]!.r + dots[j]!.r + 6);
      expect(Math.hypot(dots[i]!.x - dots[j]!.x, dots[i]!.y - dots[j]!.y)).toBeGreaterThanOrEqual(need - 1e-6);
    }
    expect(dots[3]).toEqual({ x: 500, y: 500, r: 5 });
    const far = [{ x: 0, y: 0, r: 5 }, { x: 100, y: 0, r: 5 }];
    separate(far, 30, 6);
    expect(far).toEqual([{ x: 0, y: 0, r: 5 }, { x: 100, y: 0, r: 5 }]);
  });
});
