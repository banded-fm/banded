import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLingering } from "../components/useLingering";
import { SheetScrim } from "../components/SheetScrim";
import { useSearchParams } from "react-router-dom";
import worldLow from "../scenes/world-low.svg?raw";
import { SelectMenu } from "../components/SelectMenu";
import {
  DECADES, HOME, citiesByName, cityBubbles, colorFor, labelCities, decadeColor, filterScenes, loadScenes,
  MAX_ZOOM, MIN_ZOOM, clampView, placeScenes, project, scatterLayout, scenesUrls, shortName, viewBox, zoomAt,
  type CityLabel, type PlacedScene, type Room, type ScenesData, type View,
} from "../scenes/sceneMap";

/**
 * Scenes: the music scenes
 * scripts/find_scenes.py finds in each city, on a world map. Each city is a
 * dot; tap one to open it: its scenes are scattered around it, joined to it
 * by lines, biggest nearest, with their names. A tap anywhere else
 * closes it (the map stays where it is). Colours run from grey
 * (oldest era) to green (newest). Tap a scene for its era, genres and
 * artists; ?scene=<id> opens one. The filters (text, city, eras) are hidden
 * until the filter button above the zoom buttons is on.
 */
const paths = (svg: string) => svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
// The world in two levels of detail: a light outline zoomed out (in this chunk), and a detailed one, loaded when
// first needed, from DETAIL_ZOOM in. Fewer points to draw is most of what keeps panning smooth on a phone.
const WORLD_LOW = paths(worldLow);
const DETAIL_ZOOM = 8;
const CITY_ZOOM = 40;         // zoom when a city is opened
const DOT_PX = 7;             // every city and scene dot: the same size
const LABEL_PX = 11;          // scene names
const CITY_LABEL_PX = 13;     // the open city's name
const TAP_PX = 22;            // tap radius around every dot (44 px across)
const DRAG_PX = 6;            // a press that moves less than this is a tap
const WHEEL_SETTLE_MS = 150;  // wheel zooming is drawn live, then redrawn this long after the last turn

export function ScenesPage() {
  const [data, setData] = useState<ScenesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Era toggles; none picked means every era.
  const [decades, setDecades] = useState<ReadonlySet<number>>(new Set());
  const [view, setView] = useState<View>(HOME);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // The filters lie over the top of the map (so opening them doesn't move it); their height, while open.
  const filtersRef = useRef<HTMLDivElement>(null);
  const [filtersH, setFiltersH] = useState(0);
  useLayoutEffect(() => {
    const el = filtersRef.current;
    if (!filtersOpen || !el) { setFiltersH(0); return; }
    const measure = () => setFiltersH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [filtersOpen]);
  // The open city, the map units per screen pixel when it opened (its scenes are laid out in pixels at that zoom:
  // zooming in spreads them apart, zooming out hides their names), and the screen around it then.
  const [open, setOpen] = useState<{ id: string; upp: number; room: Room; avoid: Room[] } | null>(null);
  const openCityId = open?.id ?? null;
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("scene");

  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const centred = useRef(false);
  const [worldHigh, setWorldHigh] = useState<string | null>(null);

  useEffect(() => {
    loadScenes(scenesUrls(import.meta.env.BASE_URL, __GRAPH_DB_CDN_URL__, __ASSETS_ON_CDN__))
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Scenes could not be loaded."));
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const placed = useMemo(() => (data ? placeScenes(data) : []), [data]);
  const shown = useMemo(() => filterScenes(placed, query, decades), [placed, query, decades]);
  const cities = useMemo(() => (data ? citiesByName(data) : []), [data]);
  const centres = useMemo(() => new Map(cities.map((c) => [c.id, c.centre])), [cities]);
  const bubbles = useMemo(() => cityBubbles(shown, centres), [shown, centres]);
  const selected: PlacedScene | null = placed.find((s) => s.id === selectedId) ?? null;
  // The scene's sheet stays a moment after closing, to slide away (phones)
  const [sheetScene, sheetClosing] = useLingering(selected);
  // The scene panel's height: on a phone it's a sheet at the bottom, and the map buttons sit just above it.
  const [sheetH, setSheetH] = useState(0);
  useLayoutEffect(() => {
    const el = boxRef.current?.querySelector<HTMLElement>(".scene-panel");
    if (!el) { setSheetH(0); return; }
    const measure = () => setSheetH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [selected?.id]);   // the panel appears once the data has loaded, and changes with the scene

  // Phones: the heading sits a quarter of the way down the screen, so the world starts lower than centred, a
  // seventh of the map's height down, leaving the heading clear. Once, at the first measure, and only while the view
  // is still the starting one. (Wide screens: centred; the heading may overlap the dots.)
  const dropped = useRef(false);
  useEffect(() => {
    if (dropped.current || size.w === 0 || !window.matchMedia("(max-width: 640px)").matches) return;
    dropped.current = true;
    const down = size.h / 7;
    setView((v) => (v === HOME ? { ...HOME, cy: HOME.cy - down * viewBox(HOME, size.w, size.h).unitsPerPx } : v));
  }, [size.w, size.h]);

  const vb = viewBox(view, size.w, size.h);
  const upp = vb.unitsPerPx;

  const select = (id: string | null) => {
    // On a phone a scene's sheet and the filters together would leave almost no map: the filters close (they
    // still apply).
    if (id && window.matchMedia("(max-width: 640px)").matches) setFiltersOpen(false);
    setParams(id ? { scene: id } : {}, { replace: true });
  };

  /**
   * Open a city: centre it at CITY_ZOOM (or closer, if already closer) with its scenes scattered around it, spread
   * to the shape of the screen. On a phone with a scene's sheet open, they sit in the top half.
   */
  const openCityAt = useCallback((cityId: string, withSheet: boolean) => {
    const c = data?.cities.find((x) => x.id === cityId);
    if (!c) return;
    const [x, y] = project(c.centre.lat, c.centre.lon);
    const k = Math.max(view.k, CITY_ZOOM);
    const next = viewBox({ cx: x, cy: y, k }, size.w, size.h);
    const phone = window.matchMedia("(max-width: 640px)").matches;
    const sheet = phone && withSheet;
    // Around the city on screen: above a phone's sheet (the city a quarter of the way down), clear of the heading.
    const room: Room = sheet
      ? { left: -size.w / 2 + 6, right: size.w / 2 - 6, top: -size.h / 4 + filtersH + 6, bottom: size.h * 0.2 }
      : { left: -size.w / 2 + 6, right: size.w / 2 - 6, top: -(size.h - filtersH) / 2 + 6, bottom: (size.h - filtersH) / 2 - 30 };
    // Clear of the filter and zoom buttons (bottom right; above a phone's sheet) and the close button (top right),
    // measured from the city.
    // The city goes in the middle of what's visible: below the filters, if open.
    const ox = size.w / 2, oy = sheet ? size.h / 4 : (size.h + filtersH) / 2;
    const zoomBottom = sheet ? size.h * 0.45 : size.h;
    const avoid: Room[] = [
      { left: size.w - 64 - ox, right: size.w - ox, top: zoomBottom - 162 - oy, bottom: zoomBottom - oy },
      { left: size.w - 64 - ox, right: size.w - ox, top: filtersH - oy, bottom: filtersH + 64 - oy },
    ];
    setOpen({ id: cityId, upp: next.unitsPerPx, room, avoid });
    setView({ cx: x, cy: sheet ? y + next.h * 0.25 : y - (filtersH / 2) * next.unitsPerPx, k });
  }, [data, view.k, size, filtersH]);

  // A scene in the link (?scene=...) opens its city, once, when the data arrives. Only then: a scene picked later
  // is in a city that's already open, and reopening it would lay its scenes out again.
  useEffect(() => {
    if (centred.current || !data || size.w < 10) return;
    centred.current = true;
    if (selected) openCityAt(selected.cityId, true);
  }, [data, selected, openCityAt, size.w]);

  // ---- pan and zoom: drag, pinch, wheel, double-click, buttons
  // While a finger or the wheel is moving, the map isn't redrawn: the whole SVG is moved and scaled with a CSS
  // transform (cheap, on the GPU), and the view is redrawn once when the gesture ends.
  const live = useRef({ a: 1, e: 0, f: 0 });          // screen' = a * screen + (e, f)
  const committing = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: number; pinch: number | null }>({ moved: 0, pinch: null });
  const wheelTimer = useRef<number | undefined>(undefined);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const applyLive = () => {
    const { a, e, f } = live.current;
    if (svgRef.current) svgRef.current.style.transform = `matrix(${a},0,0,${a},${e},${f})`;
  };
  const livePan = (dx: number, dy: number) => {
    live.current.e += dx;
    live.current.f += dy;
    applyLive();
  };
  const liveZoom = (factor: number, px: number, py: number) => {
    const l = live.current;
    const k = view.k * l.a;
    const f = Math.min(MAX_ZOOM / k, Math.max(MIN_ZOOM / k, factor));
    live.current = { a: l.a * f, e: px - f * (px - l.e), f: py - f * (py - l.f) };
    applyLive();
  };
  /** Turn the live transform into the view, and redraw. */
  const commit = () => {
    const { a, e, f } = live.current;
    if (a === 1 && e === 0 && f === 0) return;
    const cx = vb.x + ((size.w / 2 - e) / a) * upp;
    const cy = vb.y + ((size.h / 2 - f) / a) * upp;
    const next = clampView({ cx, cy, k: view.k * a });
    if (next.cx === view.cx && next.cy === view.cy && next.k === view.k) {
      live.current = { a: 1, e: 0, f: 0 };
      applyLive();
      return;
    }
    committing.current = true;
    setView(next);
  };
  // Drop the transform in the same frame as the redraw, so the map doesn't jump.
  useLayoutEffect(() => {
    if (!committing.current) return;
    committing.current = false;
    live.current = { a: 1, e: 0, f: 0 };
    if (svgRef.current) svgRef.current.style.transform = "";
  }, [view]);

  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 1) gesture.current = { moved: 0, pinch: null };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    if (pointers.current.size === 1) {
      const before = gesture.current.moved;
      gesture.current.moved += Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y);
      pointers.current.set(e.pointerId, p);
      if (gesture.current.moved > DRAG_PX) {
        // Capture only once it's a drag: capturing on press would send the click to the map, not the dot.
        if (before <= DRAG_PX) (e.currentTarget as Element).setPointerCapture(e.pointerId);
        livePan(p.x - prev.x, p.y - prev.y);
      }
    } else if (pointers.current.size === 2) {
      pointers.current.set(e.pointerId, p);
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const last = gesture.current.pinch;
      gesture.current.pinch = dist;
      gesture.current.moved = DRAG_PX + 1;
      if (last) liveZoom(dist / last, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current.pinch = null;
    if (pointers.current.size === 0) commit();
  };

  // The latest commit and liveZoom for the wheel listener (added once).
  const wheelFns = useRef({ liveZoom, commit });
  wheelFns.current = { liveZoom, commit };
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      wheelFns.current.liveZoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      window.clearTimeout(wheelTimer.current);
      wheelTimer.current = window.setTimeout(() => wheelFns.current.commit(), WHEEL_SETTLE_MS);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // The detailed outline, once zoomed in that far.
  useEffect(() => {
    if (view.k < DETAIL_ZOOM || worldHigh) return;
    import("../scenes/world-high.svg?raw").then((m) => setWorldHigh(paths(m.default))).catch(() => {});
  }, [view.k, worldHigh]);
  const worldPaths = view.k >= DETAIL_ZOOM && worldHigh ? worldHigh : WORLD_LOW;

  const zoomButton = (factor: number) => setView((v) => zoomAt(v, factor, size.w / 2, size.h / 2, size.w, size.h));
  const tapped = () => gesture.current.moved <= DRAG_PX;

  const openCity = (cityId: string) => openCityAt(cityId, false);

  /** With a city open, a tap anywhere but a scene, the city or another city closes it, leaving the map where it is. */
  const onMapClick = (e: React.MouseEvent) => {
    if (!open || !tapped() || (e.target as Element).closest(".scenes-hit")) return;
    select(null);
    setOpen(null);
  };

  /** A city's bubble: open the city, or where bubbles overlap under the finger (Europe from afar), zoom in there. */
  const tapBubble = (cityId: string, x: number, y: number, e: React.MouseEvent) => {
    const near = bubbles.filter((o) => {
      const [ox, oy] = project(o.lat, o.lon);
      return Math.hypot(ox - x, oy - y) / upp < TAP_PX;
    });
    if (near.length > 1) {
      const p = local(e);
      setView((v) => zoomAt(v, 4, p.x, p.y, size.w, size.h));
    } else {
      openCity(cityId);
    }
  };

  const zoomToMatches = () => {
    if (shown.length === 0) return;
    const pts = shown.map((s) => project(s.lat, s.lon));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const base = viewBox({ ...HOME, k: 1 }, size.w, size.h);
    const k = Math.min(CITY_ZOOM, Math.max(1, 0.8 * Math.min(base.w / Math.max(1, x1 - x0), base.h / Math.max(1, y1 - y0))));
    setView({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, k });
  };

  // ---- what to draw: a dot per city; the open city in the middle of its scattered scenes
  const openCity_ = data?.cities.find((c) => c.id === openCityId) ?? null;
  const centre = openCity_ ? project(openCity_.centre.lat, openCity_.centre.lon) : null;
  // Laid out once when the city opens, from all its scenes, so nothing moves while it's open: selecting a scene or
  // changing the filters only shows or hides scenes in their places.
  const layout = useMemo(() => {
    if (!open || !centre || !openCity_) return [];
    const width = textWidth(svgRef.current);
    const nameWidth = (s: PlacedScene) => width(shortName(s.name, s.city), LABEL_PX, true);
    return scatterLayout(placed.filter((s) => s.cityId === open.id),
      nameWidth, width(openCity_.city, CITY_LABEL_PX, true), open.room, open.avoid)
      .map(({ scene, dx, dy, side }) =>
        ({ s: scene, x: centre[0] + dx * open.upp, y: centre[1] + dy * open.upp, side, w: nameWidth(scene) }));
  }, [placed, open, openCity_, centre?.[0], centre?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const around = useMemo(() => {
    const ids = new Set(shown.map((s) => s.id));
    return layout.filter((a) => ids.has(a.s.id));
  }, [layout, shown]);
  // Names at the zoom the city opened at or closer; zoomed further out they'd overlap.
  const showNames = open !== null && around.length > 0 && upp <= open.upp * 1.05;
  const otherBubbles = bubbles.filter((b) => b.cityId !== openCityId);
  // Every city on screen gets its name where there's room, biggest first (hidden while a city is open).
  const cityNames = useMemo(() => {
    if (openCityId) return new Map<string, CityLabel & { width: number }>();
    const width = textWidth(svgRef.current);
    const onScreen = bubbles.flatMap((b) => {
      const [x, y] = project(b.lat, b.lon);
      const px = (x - vb.x) / upp, py = (y - vb.y) / upp;
      if (px < -100 || py < -40 || px > size.w + 100 || py > size.h + 40) return [];
      return [{ id: b.cityId, x: px, y: py, count: b.count, width: width(b.city, LABEL_PX) }];
    });
    const widths = new Map(onScreen.map((c) => [c.id, c.width]));
    return new Map([...labelCities(onScreen, DOT_PX)].map(([id, l]) => [id, { ...l, width: widths.get(id)! }]));
  }, [bubbles, openCityId, vb.x, vb.y, upp, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps
  const openName = openCity_?.city;
  const r = DOT_PX * upp;

  const filtering = query.trim() !== "" || decades.size > 0;
  const toggleDecade = (start: number) => setDecades((d) => {
    const next = new Set(d);
    if (next.has(start)) next.delete(start); else next.add(start);
    return next;
  });

  return (
    <div className="scenes-page" style={styles.page}>
      {filtersOpen && <div ref={filtersRef} id="scenes-filters" className="scenes-controls" style={styles.controls}>
        <div style={styles.titleRow}>
          <h2 className="eyebrow" style={styles.title}>Filter scenes</h2>
          <span style={styles.count} aria-live="polite">
            {data ? `${shown.length.toLocaleString()} of ${placed.length.toLocaleString()} scenes` : error ? "" : "Loading…"}
          </span>
        </div>
        <div className="scenes-filters" style={styles.filters}>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Scene, city, genre or artist" aria-label="Filter scenes" style={styles.input} />
          <SelectMenu placeholder="Go to a city…" ariaLabel="Go to a city" onPick={openCity} disabled={!data}
            options={cities.map((c) => ({ value: c.id, label: `${c.city} (${c.scenes.length})` }))} style={styles.select} />
          {filtering && (
            <button type="button" onClick={zoomToMatches} style={styles.button} disabled={shown.length === 0}>
              Zoom to matches
            </button>
          )}
        </div>
        <div className="scenes-decades" style={styles.decades} role="group" aria-label="Era">
          <button type="button" onClick={() => setDecades(new Set())} aria-pressed={decades.size === 0}
            style={{ ...styles.chip, ...(decades.size === 0 ? styles.chipOn : {}) }}>All eras</button>
          {DECADES.map((d) => (
            <button key={d.start} type="button" onClick={() => toggleDecade(d.start)}
              aria-pressed={decades.has(d.start)}
              style={{ ...styles.chip, ...(decades.has(d.start) ? styles.chipOn : {}), borderColor: d.color }}>
              <span className="round" style={{ ...styles.dot, background: d.color }} />{d.label}
            </button>
          ))}
        </div>
      </div>}

      <div ref={boxRef} className={`scenes-map${selected ? " has-panel" : ""}${open ? " city-open" : ""}`} style={{ ...styles.mapWrap, "--filters-h": `${filtersH}px`, "--sheet-h": `${sheetH}px` } as React.CSSProperties}>
        <svg
          ref={svgRef}
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          width="100%" height="100%" style={styles.svg}
          role="img" aria-label="World map of music scenes"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onClick={onMapClick}
          onDoubleClick={(e) => { if (open) return; const p = local(e); setView((v) => zoomAt(v, 2, p.x, p.y, size.w, size.h)); }}
        >
          {/* Land as a field of dots, a fixed size on screen whatever the zoom */}
          <defs>
            <pattern id="land-dots" width={9} height={9} patternUnits="userSpaceOnUse" patternTransform={`scale(${upp})`}>
              <circle cx={4.5} cy={4.5} r={1.7} fill="#CDBCA8" />
            </pattern>
          </defs>
          <g className="scenes-world" dangerouslySetInnerHTML={{ __html: worldPaths }} />
          {/* Two layers: every tap area first, then every dot, so a dot under the finger wins over a
              neighbour's larger (invisible) tap area. */}
          {["hit", "dot"].map((layer) => (
            <g key={layer} opacity={openCityId ? 0.45 : 1}>
              {otherBubbles.map((b) => {
                const [x, y] = project(b.lat, b.lon);
                return (
                  <g key={b.cityId} className="scenes-hit" onClick={(e) => { if (tapped()) tapBubble(b.cityId, x, y, e); }}>
                    {layer === "hit" ? (
                      <circle cx={x} cy={y} r={Math.max(r, TAP_PX * upp)} fill="transparent" />
                    ) : (<>
                      <title>{`${b.city}: ${b.count} scene${b.count === 1 ? "" : "s"}`}</title>
                      <circle cx={x} cy={y} r={r} fill={decadeColor(b.decade)} fillOpacity={0.75}
                        stroke="#F3ECE1" strokeWidth={1 * upp} />
                      {(() => {
                        const n = cityNames.get(b.cityId);
                        if (!n) return null;
                        // The name opens the city too: its tap area is the space labelCities kept free for it.
                        const lx = x + n.dx * upp, ly = y + n.dy * upp, w = n.width * upp;
                        const left = n.anchor === "middle" ? lx - w / 2 : n.anchor === "end" ? lx - w : lx;
                        // A name is never ambiguous: it opens its city even where a tap on the dots would zoom in.
                        const byName = (e: React.MouseEvent) => { e.stopPropagation(); if (tapped()) openCity(b.cityId); };
                        return (<g onClick={byName}>
                          <rect x={left} y={ly - 7 * upp} width={w} height={14 * upp} fill="transparent" />
                          <text x={lx} y={ly} fontSize={LABEL_PX * upp} textAnchor={n.anchor}
                            dominantBaseline="middle" fill="#2E0A14">{b.city}</text>
                        </g>);
                      })()}
                    </>)}
                  </g>
                );
              })}
            </g>
          ))}
          {open && centre && (
            <g>
              {/* lines from the city to each of its scenes */}
              {around.map(({ s, x, y }) => (
                <line key={s.id} x1={centre[0]} y1={centre[1]} x2={x} y2={y} className="scenes-spoke"
                  stroke={s.id === selectedId ? "#2E0A14" : "#6B4A50"} />
              ))}
              {/* the city itself, and its name: tapping either keeps the city open */}
              <g className="scenes-hit">
                <circle cx={centre[0]} cy={centre[1]} r={TAP_PX * upp} fill="transparent" />
                <circle cx={centre[0]} cy={centre[1]} r={r * 1.6} fill="#2E0A14" stroke="#F3ECE1" strokeWidth={upp} />
                <text x={centre[0]} y={centre[1] - r * 1.6 - 6 * upp} fontSize={CITY_LABEL_PX * upp} fontWeight={500}
                  textAnchor="middle" fill="#2E0A14">{openName}</text>
              </g>
            </g>
          )}
          {open && ["hit", "dot"].map((layer) => (
            <g key={layer}>
              {around.map(({ s, x, y, side, w }) => {
                const on = s.id === selectedId;
                const left = side === "left";
                const lx = x + (left ? -1 : 1) * (r + 4 * upp);
                return (
                  <g key={s.id} className="scenes-hit" onClick={() => { if (tapped()) select(s.id); }}>
                    {layer === "hit" ? (
                      <circle cx={x} cy={y} r={TAP_PX * upp} fill="transparent" />
                    ) : (<>
                      <title>{`${s.name}${s.era ? ` · ${s.era.label}` : ""}`}</title>
                      <circle cx={x} cy={y} r={on ? r * 1.3 : r} fill={colorFor(s)}
                        stroke={on ? "#2E0A14" : "#F3ECE1"} strokeWidth={(on ? 2.5 : 1) * upp} />
                      {(showNames || on) && (<>
                        {/* The name opens the scene too: its tap area is the row scatterLayout kept free for it. */}
                        <rect x={left ? lx - w * upp : lx} y={y - 9 * upp} width={w * upp} height={18 * upp} fill="transparent" />
                        <text x={lx} y={y} fontSize={LABEL_PX * upp} fontWeight={on ? 700 : 500} fill={on ? "#7A1631" : "#2E0A14"}
                          textAnchor={left ? "end" : "start"} dominantBaseline="middle">{shortName(s.name, s.city)}</text>
                      </>)}
                    </>)}
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
        <div className="scenes-zoom" style={styles.mapButtons}>
          <div style={styles.zoom}>
            <button type="button" aria-label="Filters" title={filtersOpen ? "Hide filters" : "Show filters"}
              aria-pressed={filtersOpen} aria-controls={filtersOpen ? "scenes-filters" : undefined}
              style={{ ...styles.zoomBtn, ...(filtersOpen ? styles.zoomBtnOn : {}) }}
              onClick={() => setFiltersOpen((o) => !o)}>
              <FilterIcon />
              {/* Filters still apply while hidden: a dot says some are set. */}
              {filtering && !filtersOpen && <span className="round" style={styles.filterDot} aria-hidden="true" />}
            </button>
          </div>
          <div style={styles.zoom}>
            <button type="button" aria-label="Zoom in" style={styles.zoomBtn} onClick={() => zoomButton(2)}>+</button>
            <button type="button" aria-label="Zoom out" style={styles.zoomBtn} onClick={() => zoomButton(0.5)}>−</button>
          </div>
        </div>
        {open && (
          <div className="scenes-close" style={styles.zoom}>
            <button type="button" aria-label={`Close ${openName}`} title={`Close ${openName}`} style={styles.zoomBtn}
              onClick={() => { setOpen(null); select(null); }}>✕</button>
          </div>
        )}
        {/* Only while choosing a city: once one is open, its scene names fill the map (and the close button sits top right) */}
        {!open && <h1 className="scenes-heading" style={styles.heading1}>Select a city to see its scenes</h1>}
        {error && <p role="alert" style={styles.error}>{error}</p>}
        {sheetScene && <SheetScrim closing={sheetClosing} onClose={() => select(null)} />}
        {sheetScene && <ScenePanel scene={sheetScene} artistsBy={data?.artists_by} closing={sheetClosing} onClose={() => select(null)} />}
      </div>
    </div>
  );
}

function ScenePanel({ scene, artistsBy, onClose, closing = false }: {
  closing?: boolean;
  scene: PlacedScene; artistsBy: ScenesData["artists_by"]; onClose: () => void;
}) {
  return (
    <aside className={`scene-panel${closing ? " sheet-closing" : ""}`} style={styles.panel} aria-label={scene.name}>
      <button type="button" onClick={onClose} aria-label="Close" style={styles.close}>✕</button>
      <h2 style={styles.panelTitle}>{scene.name}</h2>
      {scene.era && <p style={styles.panelSub}>{scene.era.label}</p>}
      {/* Genres as pills, without a heading: they read as genres on their own. */}
      {scene.genres.length > 0 && <Chips label="Genres" items={scene.genres} />}
      {/* Best known first when the scenes were found with Last.fm or Wikipedia counts; else most connected. */}
      <h3 style={styles.heading}>{artistsBy === "known" ? "Best-known artists" : "Most connected artists"}</h3>
      <ul style={styles.artists}>
        {scene.artists.map(([id, name]) => <li key={id} style={styles.artist}>{name}</li>)}
      </ul>
    </aside>
  );
}

/** Measures text as the map draws it (its font, at a size in pixels); falls back to an estimate without a canvas. */
function textWidth(el: Element | null): (text: string, px: number, bold?: boolean) => number {
  const ctx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  const family = el ? getComputedStyle(el).fontFamily : "sans-serif";
  return (text, px, bold = false) => {
    if (!ctx) return text.length * px * (bold ? 0.62 : 0.56);
    ctx.font = `${bold ? 700 : 400} ${px}px ${family}`;
    return Math.ceil(ctx.measureText(text).width);
  };
}

/** A funnel, for the filter button. */
function FilterIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5h18l-7 8.5V19l-4 2v-7.5z" />
    </svg>
  );
}

/** A row of pills; `label` names it for screen readers only. */
function Chips({ label, items }: { label: string; items: string[] }) {
  return (
    <div style={{ ...styles.chips, ...styles.chipRow }} role="list" aria-label={label}>
      {items.map((x) => <span key={x} role="listitem" style={styles.tag}>{x}</span>)}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
  // Over the top of the map, not above it, so the map stays put when they open.
  controls: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 20, background: "#F3ECE1", boxShadow: "0 6px 0 #2E0A14", padding: "14px 48px 12px", display: "flex", flexDirection: "column", gap: "12px", borderBottom: "2px solid #2E0A14" },
  titleRow: { display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" },
  title: {},
  badge: { fontSize: "12px", color: "#7A1631", border: "2px solid #7A1631", padding: "1px 6px" },
  count: { marginLeft: "auto", color: "#6B4A50", fontSize: "13px", fontWeight: 400 },
  filters: { display: "flex", gap: "12px 24px", flexWrap: "wrap", alignItems: "flex-end" },
  input: { flex: "1 1 14rem", minWidth: 0, height: "48px", padding: 0, fontSize: "22px" },
  select: { flex: "0 1 14rem", minWidth: 0, height: "48px", padding: 0, fontSize: "18px" },
  button: { height: "48px", padding: "0 22px", background: "#7A1631", border: "none", color: "#F3ECE1", fontSize: "15px", fontWeight: 500, cursor: "pointer" },
  decades: { display: "flex", gap: "8px", overflowX: "auto", paddingBottom: "2px" },
  chip: { flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: "8px", minHeight: "44px", padding: "0 14px", background: "transparent", border: "2px solid #2E0A14", color: "#2E0A14", fontSize: "14px", fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap" },
  chipOn: { background: "#2E0A14", color: "#F3ECE1" },
  dot: { width: "10px", height: "10px", borderRadius: "50%", display: "inline-block" },
  mapWrap: { position: "relative", flex: 1, minHeight: "320px", overflow: "hidden", background: "#F3ECE1", touchAction: "none" },
  svg: { display: "block", cursor: "grab", userSelect: "none", transformOrigin: "0 0", willChange: "transform" },
  // Placed by .scenes-zoom in index.css: bottom right, above a phone's sheet.
  mapButtons: { display: "flex", flexDirection: "column", gap: "8px" },
  zoom: { display: "flex", flexDirection: "column", gap: "8px" },
  zoomBtn: { position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: "48px", height: "48px", background: "#F3ECE1", border: "2px solid #2E0A14", color: "#2E0A14", fontSize: "22px", cursor: "pointer" },
  zoomBtnOn: { background: "#2E0A14", color: "#F3ECE1" },
  filterDot: { position: "absolute", top: "7px", right: "7px", width: "8px", height: "8px", borderRadius: "50%", background: "#7A1631" },
  // The map's title, top left (wide screens only: index.css)
  // The size of the Graph page's intro ("Search an artist to start"), as far in from the top as it is there
  heading1: { position: "absolute", top: "40px", left: "48px", margin: 0, fontSize: "clamp(36px, 5.6vw, 76px)", fontWeight: 500, lineHeight: 0.95, letterSpacing: "-0.055em", color: "#2E0A14", pointerEvents: "none", zIndex: 1 },
  error: { position: "absolute", top: "1rem", left: "48px", right: "1rem", zIndex: 10, background: "#F3ECE1", border: "2px solid #7A1631", color: "#7A1631", padding: "12px 14px", fontSize: "15px" },
  // The scene: a card on a 2px deep border with a hard shadow; its name large in maroon
  panel: { zIndex: 10, background: "#F3ECE1", border: "2px solid #2E0A14", boxShadow: "6px 6px 0 #2E0A14", color: "#2E0A14", overflowY: "auto", padding: "16px 20px 20px" },
  close: { position: "absolute", top: "6px", right: "6px", minWidth: "44px", minHeight: "44px", background: "none", border: "none", color: "#2E0A14", fontSize: "18px", cursor: "pointer" },
  panelTitle: { fontSize: "30px", fontWeight: 500, lineHeight: 1, letterSpacing: "-0.05em", color: "#7A1631", paddingRight: "2.5rem" },
  panelSub: { color: "#6B4A50", fontSize: "12px", letterSpacing: "0.1em", textTransform: "uppercase", marginTop: "10px" },
  chips: { marginTop: "12px" },
  heading: { fontSize: "12px", fontWeight: 500, color: "#2E0A14", textTransform: "uppercase", letterSpacing: "0.1em", margin: "16px 0 6px", borderTop: "1px solid #D8CBBB", paddingTop: "10px" },
  chipRow: { display: "flex", flexWrap: "wrap", gap: "6px" },
  tag: { fontSize: "13px", border: "2px solid #2E0A14", padding: "2px 8px", color: "#2E0A14" },
  artists: { listStyle: "none", columns: 2, columnGap: "1rem", fontSize: "15px" },
  artist: { padding: "3px 0", breakInside: "avoid", color: "#2E0A14" },
};
