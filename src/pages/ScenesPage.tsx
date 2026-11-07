import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import worldLow from "../scenes/world-low.svg?raw";
import {
  DECADES, HOME, bubbleRadius, citiesBySize, cityBubbles, colorFor, decadeColor, filterScenes, loadScenes,
  MAX_ZOOM, MIN_ZOOM, clampView, placeScenes, project, radiusFor, scenesUrls, separate, spiral, viewBox, zoomAt,
  type PlacedScene, type ScenesData, type View,
} from "../scenes/sceneMap";

/**
 * Scenes (in development, not in the menu): the music scenes
 * scripts/find_scenes.py finds in each city, on a world map. Each city is a
 * bubble (its number of scenes); tap one to open it, and its scenes appear as
 * dots near the venues they're centred on, pushed apart so each can be tapped.
 * Tap a scene for its era, genres and artists; ?scene=<id> opens one.
 */
const paths = (svg: string) => svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
// The world in two levels of detail: a light outline zoomed out (in this chunk), and a detailed one, loaded when
// first needed, from DETAIL_ZOOM in. Fewer points to draw is most of what keeps panning smooth on a phone.
const WORLD_LOW = paths(worldLow);
const DETAIL_ZOOM = 8;
const CITY_ZOOM = 40;         // zoom when a city is opened
const SPACING_PX = 15;        // between scenes spread around one venue, before they're pushed apart
const MIN_DIST_PX = 30;       // between the centres of an open city's dots
const TAP_PX = 22;            // tap radius around every dot (44 px across)
const DRAG_PX = 6;            // a press that moves less than this is a tap
const WHEEL_SETTLE_MS = 150;  // wheel zooming is drawn live, then redrawn this long after the last turn

export function ScenesPage() {
  const [data, setData] = useState<ScenesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [decade, setDecade] = useState<number | null>(null);
  const [view, setView] = useState<View>(HOME);
  const [openCityId, setOpenCityId] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("scene");

  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const centred = useRef(false);
  const [worldHigh, setWorldHigh] = useState<string | null>(null);

  useEffect(() => {
    loadScenes(scenesUrls(import.meta.env.BASE_URL, __GRAPH_DB_CDN_URL__))
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
  const shown = useMemo(() => filterScenes(placed, query, decade), [placed, query, decade]);
  const cities = useMemo(() => (data ? citiesBySize(data) : []), [data]);
  const centres = useMemo(() => new Map(cities.map((c) => [c.id, c.centre])), [cities]);
  const bubbles = useMemo(() => cityBubbles(shown, centres), [shown, centres]);
  const selected: PlacedScene | null = placed.find((s) => s.id === selectedId) ?? null;

  const vb = viewBox(view, size.w, size.h);
  const upp = vb.unitsPerPx;

  const select = (id: string | null) => setParams(id ? { scene: id } : {}, { replace: true });

  /** Centre a point; on a phone, a little above the middle so the scene's sheet doesn't cover it. */
  const goTo = useCallback((lat: number, lon: number, k: number) => {
    const [x, y] = project(lat, lon);
    const phone = window.matchMedia("(max-width: 640px)").matches;
    const next = viewBox({ cx: x, cy: y, k }, size.w, size.h);
    setView({ cx: x, cy: phone ? y + next.h * 0.22 : y, k });
  }, [size]);

  // A scene in the link (?scene=...) opens its city, once, when the data arrives.
  useEffect(() => {
    if (centred.current || !selected || size.w < 10) return;
    centred.current = true;
    setOpenCityId(selected.cityId);
    goTo(selected.lat, selected.lon, CITY_ZOOM);
  }, [selected, goTo, size.w]);

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

  const openCity = (cityId: string) => {
    const c = cities.find((x) => x.id === cityId);
    if (!c) return;
    setOpenCityId(cityId);
    goTo(c.centre.lat, c.centre.lon, Math.max(view.k, CITY_ZOOM));
  };

  const home = () => {
    setOpenCityId(null);
    setView(HOME);
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

  // ---- what to draw: a bubble per city, and the open city's scenes as dots
  const dots = useMemo(() => {
    if (!openCityId) return [];
    const out = shown.filter((s) => s.cityId === openCityId).map((s) => {
      const [bx, by] = project(s.lat, s.lon);
      const [ox, oy] = spiral(s.slot, SPACING_PX * upp);
      return { s, x: bx + ox, y: by + oy, r: radiusFor(s.size) * upp };
    });
    separate(out, MIN_DIST_PX * upp, 6 * upp);
    // the selected one last, so it's on top
    return out.sort((a, b) => Number(a.s.id === selectedId) - Number(b.s.id === selectedId) || b.s.size - a.s.size);
  }, [shown, openCityId, upp, selectedId]);
  const otherBubbles = bubbles.filter((b) => b.cityId !== openCityId);
  const openName = cities.find((c) => c.id === openCityId)?.city;

  const filtering = query.trim() !== "" || decade !== null;

  return (
    <div className="scenes-page" style={styles.page}>
      <div className="scenes-controls" style={styles.controls}>
        <div style={styles.titleRow}>
          <h1 style={styles.title}>Scenes</h1>
          <span style={styles.badge}>Preview</span>
          <span style={styles.count} aria-live="polite">
            {data ? `${shown.length.toLocaleString()} of ${placed.length.toLocaleString()} scenes` : error ? "" : "Loading…"}
          </span>
        </div>
        <div className="scenes-filters" style={styles.filters}>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Scene, city, genre or artist" aria-label="Filter scenes" style={styles.input} />
          <select value="" onChange={(e) => { if (e.target.value) openCity(e.target.value); }}
            aria-label="Go to a city" style={styles.select} disabled={!data}>
            <option value="">Go to a city…</option>
            {cities.map((c) => <option key={c.id} value={c.id}>{c.city} ({c.scenes.length})</option>)}
          </select>
          {filtering && (
            <button type="button" onClick={zoomToMatches} style={styles.button} disabled={shown.length === 0}>
              Zoom to matches
            </button>
          )}
        </div>
        <div className="scenes-decades" style={styles.decades} role="group" aria-label="Era">
          <button type="button" onClick={() => setDecade(null)} aria-pressed={decade === null}
            style={{ ...styles.chip, ...(decade === null ? styles.chipOn : {}) }}>All eras</button>
          {DECADES.map((d) => (
            <button key={d.start} type="button" onClick={() => setDecade(decade === d.start ? null : d.start)}
              aria-pressed={decade === d.start}
              style={{ ...styles.chip, ...(decade === d.start ? styles.chipOn : {}), borderColor: d.color }}>
              <span style={{ ...styles.dot, background: d.color }} />{d.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={boxRef} className="scenes-map" style={styles.mapWrap}>
        <svg
          ref={svgRef}
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          width="100%" height="100%" style={styles.svg}
          role="img" aria-label="World map of music scenes"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onDoubleClick={(e) => { const p = local(e); setView((v) => zoomAt(v, 2, p.x, p.y, size.w, size.h)); }}
        >
          <g className="scenes-world" dangerouslySetInnerHTML={{ __html: worldPaths }} />
          {/* Two layers: every tap area first, then every dot, so a dot under the finger wins over a
              neighbour's larger (invisible) tap area. */}
          {["hit", "dot"].map((layer) => (
            <g key={layer} opacity={openCityId ? 0.45 : 1}>
              {otherBubbles.map((b) => {
                const [x, y] = project(b.lat, b.lon);
                const r = bubbleRadius(b.count) * upp;
                return (
                  <g key={b.cityId} className="scenes-hit" onClick={(e) => { if (tapped()) tapBubble(b.cityId, x, y, e); }}>
                    {layer === "hit" ? (
                      <circle cx={x} cy={y} r={Math.max(r, TAP_PX * upp)} fill="transparent" />
                    ) : (<>
                      <title>{`${b.city}: ${b.count} scene${b.count === 1 ? "" : "s"}`}</title>
                      <circle cx={x} cy={y} r={r} fill={decadeColor(b.decade)} fillOpacity={0.75}
                        stroke="#0f0f0f" strokeWidth={1 * upp} />
                      {view.k >= 2.5 && b.count >= 12 && (
                        <text x={x} y={y + r + 11 * upp} fontSize={11 * upp} textAnchor="middle" fill="#ccc"
                          style={{ pointerEvents: "none" }}>{b.city}</text>
                      )}
                    </>)}
                  </g>
                );
              })}
            </g>
          ))}
          {openCityId && ["hit", "dot"].map((layer) => (
            <g key={layer}>
              {dots.map(({ s, x, y, r }) => {
                const on = s.id === selectedId;
                return (
                  <g key={s.id} className="scenes-hit" onClick={() => { if (tapped()) select(s.id); }}>
                    {layer === "hit" ? (
                      <circle cx={x} cy={y} r={Math.max(r, TAP_PX * upp)} fill="transparent" />
                    ) : (<>
                      <title>{`${s.name}${s.era ? ` · ${s.era.label}` : ""}`}</title>
                      <circle cx={x} cy={y} r={on ? r + 3 * upp : r} fill={colorFor(s)} fillOpacity={on ? 0.95 : 0.75}
                        stroke={on ? "#fff" : "#0f0f0f"} strokeWidth={(on ? 3 : 1) * upp} />
                    </>)}
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
        <div style={styles.zoom}>
          <button type="button" aria-label="Zoom in" style={styles.zoomBtn} onClick={() => zoomButton(2)}>+</button>
          <button type="button" aria-label="Zoom out" style={styles.zoomBtn} onClick={() => zoomButton(0.5)}>−</button>
          <button type="button" aria-label="Whole world" style={styles.zoomBtn} onClick={home}>⌂</button>
        </div>
        {openName && (
          <button type="button" onClick={() => { setOpenCityId(null); select(null); }} style={styles.cityChip}>
            {openName} ✕
          </button>
        )}
        <p style={styles.hint}>{openCityId ? "Tap a scene, or another city" : "Tap a city"}</p>
        {error && <p role="alert" style={styles.error}>{error}</p>}
        {selected && <ScenePanel scene={selected} onClose={() => select(null)} />}
      </div>
    </div>
  );
}

function ScenePanel({ scene, onClose }: { scene: PlacedScene; onClose: () => void }) {
  const where = [scene.location.venue, scene.location.place].filter(Boolean).join(", ");
  return (
    <aside className="scene-panel" style={styles.panel} aria-label={scene.name}>
      <button type="button" onClick={onClose} aria-label="Close" style={styles.close}>✕</button>
      <h2 style={styles.panelTitle}>{scene.name}</h2>
      <p style={styles.panelCity}>{scene.city}{scene.country ? `, ${scene.country}` : ""}</p>
      <dl style={styles.facts}>
        {scene.era && (<>
          <dt style={styles.dt}>Era</dt>
          <dd style={styles.dd}>{scene.era.label} (busiest around {scene.era.peak})</dd>
        </>)}
        <dt style={styles.dt}>Artists</dt>
        <dd style={styles.dd}>{scene.size.toLocaleString()}</dd>
        {where && (<>
          <dt style={styles.dt}>Centred on</dt>
          <dd style={styles.dd}>{where}</dd>
        </>)}
      </dl>
      {scene.genres.length > 0 && <Chips label="Genres" items={scene.genres} />}
      {scene.tags.length > 0 && <Chips label="Last.fm tags" items={scene.tags} />}
      <h3 style={styles.heading}>Most connected artists</h3>
      <ul style={styles.artists}>
        {scene.artists.map(([id, name]) => <li key={id} style={styles.artist}>{name}</li>)}
      </ul>
    </aside>
  );
}

function Chips({ label, items }: { label: string; items: string[] }) {
  return (
    <div style={styles.chips}>
      <h3 style={styles.heading}>{label}</h3>
      <div style={styles.chipRow}>{items.map((x) => <span key={x} style={styles.tag}>{x}</span>)}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
  controls: { padding: "0.75rem 1rem 0.5rem", display: "flex", flexDirection: "column", gap: "0.5rem", borderBottom: "1px solid #2a2a2a" },
  titleRow: { display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" },
  title: { fontSize: "1.3rem", fontWeight: 700, color: "#e0e0e0" },
  badge: { fontSize: "0.7rem", color: "#feca57", border: "1px solid #feca57", borderRadius: "999px", padding: "0.05rem 0.45rem" },
  count: { marginLeft: "auto", color: "#888", fontSize: "0.8rem" },
  filters: { display: "flex", gap: "0.5rem", flexWrap: "wrap" },
  input: { flex: "1 1 14rem", minWidth: 0, minHeight: "44px", padding: "0 0.75rem", background: "#1a1a1a", border: "1px solid #333", borderRadius: "8px", color: "#e0e0e0", fontSize: "1rem" },
  select: { flex: "0 1 12rem", minWidth: 0, minHeight: "44px", padding: "0 0.5rem", background: "#1a1a1a", border: "1px solid #333", borderRadius: "8px", color: "#e0e0e0", fontSize: "0.9rem" },
  button: { minHeight: "44px", padding: "0 0.9rem", background: "#2a2a2a", border: "1px solid #444", borderRadius: "8px", color: "#e0e0e0", fontSize: "0.9rem", cursor: "pointer" },
  decades: { display: "flex", gap: "0.4rem", overflowX: "auto", paddingBottom: "0.25rem" },
  chip: { flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: "0.35rem", minHeight: "44px", padding: "0 0.75rem", background: "#161616", border: "1px solid #333", borderRadius: "999px", color: "#aaa", fontSize: "0.85rem", cursor: "pointer", whiteSpace: "nowrap" },
  chipOn: { background: "#2a2a2a", color: "#fff" },
  dot: { width: "0.6rem", height: "0.6rem", borderRadius: "50%", display: "inline-block" },
  mapWrap: { position: "relative", flex: 1, minHeight: "320px", overflow: "hidden", background: "#0b1a26", touchAction: "none" },
  svg: { display: "block", cursor: "grab", userSelect: "none", transformOrigin: "0 0", willChange: "transform" },
  zoom: { position: "absolute", top: "0.75rem", left: "0.75rem", display: "flex", flexDirection: "column", gap: "1px", borderRadius: "8px", overflow: "hidden", border: "1px solid #333" },
  zoomBtn: { width: "44px", height: "44px", background: "#1a1a1a", border: "none", color: "#e0e0e0", fontSize: "1.2rem", cursor: "pointer" },
  cityChip: { position: "absolute", top: "0.75rem", left: "4.25rem", minHeight: "44px", padding: "0 0.9rem", background: "#1a1a1a", border: "1px solid #444", borderRadius: "999px", color: "#e0e0e0", fontSize: "0.9rem", cursor: "pointer" },
  hint: { position: "absolute", bottom: "0.5rem", left: "0.75rem", color: "#777", fontSize: "0.75rem", pointerEvents: "none" },
  error: { position: "absolute", top: "1rem", left: "4.5rem", right: "1rem", zIndex: 10, background: "#2a1515", border: "1px solid #ff6b6b", color: "#ffb3b3", padding: "0.75rem", borderRadius: "8px", fontSize: "0.85rem" },
  panel: { zIndex: 10, background: "rgba(22, 22, 22, 0.97)", border: "1px solid #333", color: "#e0e0e0", overflowY: "auto", padding: "1rem 1rem 1.25rem" },
  close: { position: "absolute", top: "0.25rem", right: "0.25rem", minWidth: "44px", minHeight: "44px", background: "none", border: "none", color: "#aaa", fontSize: "1.1rem", cursor: "pointer" },
  panelTitle: { fontSize: "1.1rem", fontWeight: 700, paddingRight: "2.5rem", lineHeight: 1.3 },
  panelCity: { color: "#888", fontSize: "0.85rem", marginTop: "0.15rem" },
  facts: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.25rem 0.75rem", margin: "0.75rem 0", fontSize: "0.85rem" },
  dt: { color: "#888" },
  dd: { color: "#e0e0e0" },
  chips: { marginTop: "0.5rem" },
  heading: { fontSize: "0.8rem", fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: "0.04em", margin: "0.75rem 0 0.35rem" },
  chipRow: { display: "flex", flexWrap: "wrap", gap: "0.3rem" },
  tag: { fontSize: "0.8rem", background: "#242424", border: "1px solid #333", borderRadius: "999px", padding: "0.15rem 0.55rem", color: "#ccc" },
  artists: { listStyle: "none", columns: 2, columnGap: "1rem", fontSize: "0.85rem" },
  artist: { padding: "0.15rem 0", breakInside: "avoid", color: "#ccc" },
};
