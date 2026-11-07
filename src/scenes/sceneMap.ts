/**
 * Data and helpers for the Scenes map (pages/ScenesPage.tsx): the scenes file
 * scripts/find_scenes.py writes with --app, flattened for the map, and the
 * world map's projection and pan/zoom.
 */

export interface SceneEra {
  from: number;
  to: number;
  peak: number;
  label: string;
}

export interface Scene {
  id: string;
  name: string;
  size: number;
  era: SceneEra | null;
  location: { lat: number; lon: number; place: string | null; venue: string | null };
  /** MusicBrainz genres, most common first. */
  genres: string[];
  /** Last.fm tags that set the scene apart (empty without Last.fm data). */
  tags: string[];
  /** [MusicBrainz ID, name] of its most connected artists. */
  artists: [string, string][];
}

export interface SceneCity {
  id: string;
  city: string;
  country: string | null;
  centre: { lat: number; lon: number };
  scenes: Scene[];
}

export interface ScenesData {
  generated_at?: string;
  cities: SceneCity[];
}

/** A scene with its city; `slot` is its place among scenes centred on the same point (0 = the first). */
export interface PlacedScene extends Scene {
  cityId: string;
  city: string;
  country: string | null;
  lat: number;
  lon: number;
  slot: number;
}

/** Decade buckets for the filter and the colours: before 1960, the 60s ... the 00s, 2010 on. */
export const DECADES: { start: number; label: string; color: string }[] = [
  { start: 1950, label: "Before 1960", color: "#a29bfe" },
  { start: 1960, label: "1960s", color: "#48dbfb" },
  { start: 1970, label: "1970s", color: "#1dd1a1" },
  { start: 1980, label: "1980s", color: "#feca57" },
  { start: 1990, label: "1990s", color: "#ff9f43" },
  { start: 2000, label: "2000s", color: "#ff6b6b" },
  { start: 2010, label: "2010 on", color: "#f368e0" },
];
const NO_ERA_COLOR = "#888";

/** The decade bucket of a scene's peak year, or null without an era. */
export function decadeOf(scene: Scene): number | null {
  if (!scene.era) return null;
  const decade = Math.floor(scene.era.peak / 10) * 10;
  return Math.min(Math.max(decade, 1950), 2010);
}

export function decadeColor(decade: number | null): string {
  return DECADES.find((x) => x.start === decade)?.color ?? NO_ERA_COLOR;
}

export function colorFor(scene: Scene): string {
  return decadeColor(decadeOf(scene));
}

/** Marker radius in screen pixels: grows with the scene's size, 5 to 16. */
export function radiusFor(size: number): number {
  return Math.round(Math.min(16, 4 + Math.sqrt(size) * 0.6));
}

/**
 * Every scene, with its city. Several scenes are often centred on the same
 * venue: each gets a slot (0, 1, 2 ...) in the order of the file, and the map
 * sets slots 1, 2 ... around the point on a spiral (spiral()).
 */
export function placeScenes(data: ScenesData): PlacedScene[] {
  const seen = new Map<string, number>();
  const out: PlacedScene[] = [];
  for (const c of data.cities) {
    for (const s of c.scenes) {
      const key = `${s.location.lat.toFixed(4)},${s.location.lon.toFixed(4)}`;
      const slot = seen.get(key) ?? 0;
      seen.set(key, slot + 1);
      out.push({ ...s, cityId: c.id, city: c.city, country: c.country, lat: s.location.lat, lon: s.location.lon, slot });
    }
  }
  return out;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Offset of a slot on a sunflower spiral, `spacing` apart: slot 0 stays on the point. */
export function spiral(slot: number, spacing: number): [number, number] {
  if (slot === 0) return [0, 0];
  const r = spacing * Math.sqrt(slot);
  return [r * Math.cos(slot * GOLDEN_ANGLE), r * Math.sin(slot * GOLDEN_ANGLE)];
}

/**
 * Push overlapping dots apart (in place) so each can be tapped: centres end at least `minDist` apart, or the
 * sum of their radii plus `gap`, whichever is more. A few rounds of pairwise nudges: dots stay near where they
 * started, so a city's scenes keep roughly to their venues.
 */
export function separate(dots: { x: number; y: number; r: number }[], minDist: number, gap: number, rounds = 80): void {
  for (let round = 0; round < rounds; round++) {
    let moved = false;
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const a = dots[i]!, b = dots[j]!;
        const need = Math.max(minDist, a.r + b.r + gap);
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= need) continue;
        if (d < 1e-9) { dx = Math.cos(j); dy = Math.sin(j); d = 1; }     // on top of each other: any direction
        const push = (need - d) / 2;
        a.x -= (dx / d) * push; a.y -= (dy / d) * push;
        b.x += (dx / d) * push; b.y += (dy / d) * push;
        moved = true;
      }
    }
    if (!moved) return;
  }
}

// ---------------------------------------------------------------- the world map

/**
 * src/scenes/world-low.svg and world-high.svg: MapSVG's world map (CC0),
 * Mercator, cut at 83.6°N and 58.5°S, simplified to two levels of detail
 * (scripts' simplify step: see the files' comments). Its geoViewBox gives the
 * longitudes and latitudes of its edges.
 */
export const WORLD = { width: 1009.6727, height: 665.96301, west: -169.110266, north: 83.600842, east: 190.486279, south: -58.508473 };

const mercator = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360));

/** A latitude and longitude as a point on the world map. */
export function project(lat: number, lon: number): [number, number] {
  const east = lon < WORLD.west ? lon + 360 : lon;     // the map runs from 169°W to 190°E
  const x = ((east - WORLD.west) / (WORLD.east - WORLD.west)) * WORLD.width;
  const y = ((mercator(WORLD.north) - mercator(lat)) / (mercator(WORLD.north) - mercator(WORLD.south))) * WORLD.height;
  return [x, y];
}

/** One bubble per city at world scale: its scenes (those shown), and the decade most of their artists share. */
export interface CityBubble {
  cityId: string;
  city: string;
  lat: number;
  lon: number;
  count: number;
  decade: number | null;
}

export function cityBubbles(scenes: PlacedScene[], centres: Map<string, { lat: number; lon: number }>): CityBubble[] {
  const byCity = new Map<string, { b: CityBubble; weights: Map<number | null, number> }>();
  for (const s of scenes) {
    let e = byCity.get(s.cityId);
    if (!e) {
      const c = centres.get(s.cityId) ?? { lat: s.lat, lon: s.lon };
      e = { b: { cityId: s.cityId, city: s.city, lat: c.lat, lon: c.lon, count: 0, decade: null }, weights: new Map() };
      byCity.set(s.cityId, e);
    }
    e.b.count += 1;
    const d = decadeOf(s);
    e.weights.set(d, (e.weights.get(d) ?? 0) + s.size);
  }
  return [...byCity.values()].map(({ b, weights }) => ({
    ...b, decade: [...weights.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
  })).sort((a, b) => b.count - a.count);
}

/** Bubble radius in screen pixels by number of scenes: 4 to 15. */
export function bubbleRadius(count: number): number {
  return Math.round(Math.min(15, 3 + Math.sqrt(count) * 1.1));
}

/** The visible part of the map: its centre (map units) and zoom (1 = the whole world fits). */
export interface View {
  cx: number;
  cy: number;
  k: number;
}
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 200;
export const HOME: View = { cx: WORLD.width / 2, cy: WORLD.height * 0.45, k: 1 };

/** The SVG viewBox for a view in a cw x ch pixel box, and map units per pixel. */
export function viewBox(v: View, cw: number, ch: number) {
  const aspect = cw / Math.max(1, ch);
  const w = Math.max(WORLD.width, WORLD.height * aspect) / v.k;
  const h = w / aspect;
  return { x: v.cx - w / 2, y: v.cy - h / 2, w, h, unitsPerPx: w / Math.max(1, cw) };
}

export function clampView(v: View): View {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k));
  return { k, cx: Math.min(WORLD.width, Math.max(0, v.cx)), cy: Math.min(WORLD.height, Math.max(0, v.cy)) };
}

/** Zoom by `factor` keeping the map point under pixel (px, py) where it is. */
export function zoomAt(v: View, factor: number, px: number, py: number, cw: number, ch: number): View {
  const before = viewBox(v, cw, ch);
  const mx = before.x + px * before.unitsPerPx;
  const my = before.y + py * before.unitsPerPx;
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
  const after = viewBox({ ...v, k }, cw, ch);
  return clampView({ k, cx: mx - px * after.unitsPerPx + after.w / 2, cy: my - py * after.unitsPerPx + after.h / 2 });
}

/** Move the map by a drag of (dx, dy) pixels. */
export function panBy(v: View, dx: number, dy: number, cw: number, ch: number): View {
  const { unitsPerPx } = viewBox(v, cw, ch);
  return clampView({ ...v, cx: v.cx - dx * unitsPerPx, cy: v.cy - dy * unitsPerPx });
}

/** Whether a scene matches typed text: its name, city, genres, tags or artists. */
export function matches(scene: PlacedScene, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    scene.name.toLowerCase().includes(q) ||
    scene.city.toLowerCase().includes(q) ||
    scene.genres.some((g) => g.includes(q)) ||
    scene.tags.some((t) => t.includes(q)) ||
    scene.artists.some(([, name]) => name.toLowerCase().includes(q))
  );
}

/** The scenes to draw: those matching the text, in the decade (if one is picked). */
export function filterScenes(scenes: PlacedScene[], query: string, decade: number | null): PlacedScene[] {
  return scenes.filter((s) => (decade === null || decadeOf(s) === decade) && matches(s, query));
}

/** Cities by number of scenes, for the "jump to" list. */
export function citiesBySize(data: ScenesData): SceneCity[] {
  return [...data.cities].filter((c) => c.scenes.length > 0).sort((a, b) => b.scenes.length - a.scenes.length);
}

/**
 * Where to load the scenes file from: next to the app first (local dev, with
 * public/scenes.json), then next to the graph on the CDN (cdn.banded.fm/scenes.json).
 */
export function scenesUrls(base: string, graphCdnUrl: string): string[] {
  const urls = [`${base}scenes.json`];
  if (graphCdnUrl) urls.push(graphCdnUrl.replace(/[^/]*$/, "scenes.json"));
  return urls;
}

export async function loadScenes(urls: string[], fetchImpl: typeof fetch = fetch): Promise<ScenesData> {
  const errors: string[] = [];
  for (const url of urls) {
    try {
      const res = await fetchImpl(url);
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || type.includes("text/html")) {
        errors.push(`${url} → ${res.status} ${type}`.trim());
        continue;
      }
      const data = (await res.json()) as ScenesData;
      if (!Array.isArray(data.cities)) throw new Error("not a scenes file");
      return data;
    } catch (e) {
      errors.push(`${url} → ${e instanceof Error ? e.message : "failed"}`);
    }
  }
  throw new Error(`Scenes could not be loaded. Tried: ${errors.join("; ")}`);
}
