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
  /** How each scene's artists are ordered: "known" (best known: Last.fm listeners, or estimated from Wikipedia
   * languages) or "links" (most connected). */
  artists_by?: "known" | "links";
  cities: SceneCity[];
}

/** A scene with its city. */
export interface PlacedScene extends Scene {
  cityId: string;
  city: string;
  country: string | null;
  lat: number;
  lon: number;
}

const GREY = [128, 128, 128];
const GREEN = [46, 204, 113];
/** A colour from grey (t = 0) to green (t = 1). */
export function eraGradient(t: number): string {
  const c = GREY.map((g, i) => Math.round(g + (GREEN[i]! - g) * Math.min(1, Math.max(0, t))));
  return `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** Decade buckets for the filter and the colours: before 1960, the 60s ... the 00s, 2010 on; grey (oldest) to
 * green (newest). */
export const DECADES: { start: number; label: string; color: string }[] = [
  [1950, "Before 1960"], [1960, "1960s"], [1970, "1970s"], [1980, "1980s"], [1990, "1990s"], [2000, "2000s"],
  [2010, "2010 on"],
].map(([start, label], i, all) => ({ start: start as number, label: label as string, color: eraGradient(i / (all.length - 1)) }));
const NO_ERA_COLOR = "#4a4a4a";

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

/** Every scene, with its city. */
export function placeScenes(data: ScenesData): PlacedScene[] {
  return data.cities.flatMap((c) =>
    c.scenes.map((s) => ({ ...s, cityId: c.id, city: c.city, country: c.country, lat: s.location.lat, lon: s.location.lon })));
}

/** The screen around an open city, in pixels from it (left and top negative). */
export interface Room { left: number; right: number; top: number; bottom: number }

/** A city's name on the map: where it goes from the city's dot, in screen pixels, and how it's aligned there. */
export interface CityLabel { dx: number; dy: number; anchor: "start" | "middle" | "end" }

/**
 * Names for the cities on screen, biggest (most scenes) first: each goes below its dot, or else to its right,
 * left or above, wherever it overlaps no other name or dot; a city with no such spot goes unnamed until zoomed in.
 * Positions are screen pixels; `width` is the name's width there, `dot` the dot's radius.
 */
export function labelCities(
  cities: { id: string; x: number; y: number; count: number; width: number }[], dot: number, height = 13,
): Map<string, CityLabel> {
  type Box = [number, number, number, number];
  const hit = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const dots: Box[] = cities.map((c) => [c.x - dot, c.y - dot, c.x + dot, c.y + dot]);
  const names: Box[] = [];
  const out = new Map<string, CityLabel>();
  const order = cities.map((_, i) => i).sort((a, b) =>
    cities[b]!.count - cities[a]!.count || cities[a]!.id.localeCompare(cities[b]!.id));
  for (const i of order) {
    const c = cities[i]!, w = c.width, g = 3;
    const spots: [CityLabel, Box][] = [
      [{ dx: 0, dy: dot + g + height / 2, anchor: "middle" }, [c.x - w / 2, c.y + dot + g, c.x + w / 2, c.y + dot + g + height]],
      [{ dx: dot + g, dy: 0, anchor: "start" }, [c.x + dot + g, c.y - height / 2, c.x + dot + g + w, c.y + height / 2]],
      [{ dx: -dot - g, dy: 0, anchor: "end" }, [c.x - dot - g - w, c.y - height / 2, c.x - dot - g, c.y + height / 2]],
      [{ dx: 0, dy: -dot - g - height / 2, anchor: "middle" }, [c.x - w / 2, c.y - dot - g - height, c.x + w / 2, c.y - dot - g]],
    ];
    const spot = spots.find(([, box]) => !names.some((n) => hit(n, box)) && !dots.some((d, j) => j !== i && hit(d, box)));
    if (!spot) continue;
    names.push(spot[1]);
    out.set(c.id, spot[0]);
  }
  return out;
}

/** A scattered scene: its offset from the city in screen pixels, and which side of its dot its name goes. */
export interface Scattered<T> { scene: T; dx: number; dy: number; side: "left" | "right" }

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * An open city's scenes scattered around it, each with its name written level beside its dot: the biggest
 * scenes nearest the city. Offsets are in screen pixels. Each scene takes the nearest free spot on a sunflower
 * spiral (which looks scattered but fills evenly), stretched to the shape of the room, where neither its dot nor
 * its name overlaps another's or the city's own name, and inside the room while there's space there. Names go on
 * the side away from the city. `labelWidth` gives a scene's name width in pixels; `cityWidth` the city name's;
 * `room` the screen around the city, in pixels from it; `avoid` places on it to keep clear (buttons over the map).
 */
export function scatterLayout<T extends Scene>(
  scenes: T[], labelWidth: (scene: T) => number, cityWidth: number,
  room: Room = { left: -400, right: 400, top: -300, bottom: 300 }, avoid: Room[] = [],
): Scattered<T>[] {
  const DOT = 9, GAP = 4, ROW = 18, MIN_R = 34, STEP = 7;
  type Box = [number, number, number, number];
  const hit = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  // The city's dot and, above it, its name.
  const taken: Box[] = [[-cityWidth / 2 - GAP, -34, cityWidth / 2 + GAP, DOT + GAP]];
  const keepClear: Box[] = avoid.map((a) => [a.left, a.top, a.right, a.bottom]);
  const aspect = (room.right - room.left) / Math.max(1, room.bottom - room.top);
  const sx = Math.sqrt(Math.max(0.4, Math.min(3, aspect))), sy = 1 / sx;
  // Past this, no spot is inside the room.
  const far = Math.hypot(Math.max(-room.left, room.right) / sx, Math.max(-room.top, room.bottom) / sy) + MIN_R;
  const inside = (b: Box) => b[0] >= room.left && b[2] <= room.right && b[1] >= room.top && b[3] <= room.bottom;
  const ordered = [...scenes].sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  const out: Scattered<T>[] = [];
  for (const scene of ordered) {
    const w = labelWidth(scene);
    // First a spot inside the room; once there's none, anywhere.
    let fit = true;
    for (let i = 0; ; i++) {
      const rho = MIN_R + STEP * Math.sqrt(i);
      if (fit && rho > far) { fit = false; i = -1; continue; }
      const t = i * GOLDEN_ANGLE;
      const dx = rho * sx * Math.cos(t), dy = rho * sy * Math.sin(t);
      const side = dx < 0 ? "left" : "right";
      const box: Box = side === "right"
        ? [dx - DOT - GAP, dy - ROW / 2, dx + DOT + GAP + w, dy + ROW / 2]
        : [dx - DOT - GAP - w, dy - ROW / 2, dx + DOT + GAP, dy + ROW / 2];
      if ((fit && (!inside(box) || keepClear.some((b) => hit(b, box)))) || (taken.some((b) => hit(b, box)) && i < 200000)) continue;
      taken.push(box);
      out.push({ scene, dx, dy, side });
      break;
    }
  }
  return out;
}

/** A scene's name without its city in front ("Los Angeles punk" -> "punk") for labels around that city. */
export function shortName(name: string, city: string): string {
  return name.startsWith(`${city} `) ? name.slice(city.length + 1) : name;
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

/** The scenes to draw: those matching the text, in one of the picked decades. No decade picked is all of them. */
export function filterScenes(scenes: PlacedScene[], query: string, decades: ReadonlySet<number>): PlacedScene[] {
  return scenes.filter((s) => {
    if (decades.size > 0) {
      const d = decadeOf(s);
      if (d === null || !decades.has(d)) return false;
    }
    return matches(s, query);
  });
}

/** Cities with scenes, A to Z, for the "Go to a city" list. */
export function citiesByName(data: ScenesData): SceneCity[] {
  return data.cities.filter((c) => c.scenes.length > 0).sort((a, b) => a.city.localeCompare(b.city));
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
