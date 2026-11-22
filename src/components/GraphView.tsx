import { useRef, useEffect, useMemo } from "react";
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";
import type { ForceGraphData } from "../graph/types";
import { LABEL_FONT, LINE_HEIGHT, boxCollide, layoutBubble, type BubbleLabel } from "../graph/bubbles";
import { DEEP, NODE_INK, PAPER, edgeMark } from "../graph/marks";
import { SwissLine } from "./SwissLine";

interface Props {
  data: ForceGraphData;
  onNodeClick: (node: { id?: string | number }) => void;
  /** A click or tap on empty space or a link (not a drag to pan). */
  onBackgroundClick?: () => void;
}

type GraphNode = NodeObject & { name?: string; type?: string; color?: string; expanded?: boolean };
type GraphLink = LinkObject & { color?: string; type?: string };

// Hover tooltips duplicate the canvas label after a tap on touch screens
const isTouch = typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;

const FONT = `500 ${LABEL_FONT}px "Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
/** A node is a dot (graph units): bigger once expanded. Its name sits under it. */
const DOT_R = 3.2;
const DOT_R_EXPANDED = 4.2;
/** A group's cluster of three dots is this much wider than a person's dot, as in the design (bigger than in the legend). */
const GROUP_SCALE = 1.8;
/**
 * Paper left between a person's dot and the links touching it, as a share of the dot's radius (the design: about
 * half the radius round an expanded dot, a third round a dashed one). Groups need none: their dots are edged in paper.
 */
const PERSON_PAD = 0.55, PERSON_PAD_UNEXPANDED = 0.33;
/**
 * The design's group mark: three circles in a 20-unit box centred on (10, 10.5), half as wide as GROUP_HALF.
 * Expanded, filled with paper edges; not yet expanded, dashed outlines (smaller radii, so both span the same box).
 */
const GROUP_HALF = 10.7;
const GROUP_DOTS: { x: number; y: number; filled: number; open: number }[] = [
  { x: 4.55, y: 6.96, filled: 5.09, open: 4.29 },
  { x: 15.45, y: 6.96, filled: 5.09, open: 4.29 },
  { x: 10, y: 13.56, filled: 6.25, open: 5.45 },
];
const NAME_GAP = 1.4;
/** Below this many screen pixels the names are unreadable: draw just the bubbles. */
const MIN_READABLE_PX = 3.5;
/** Room between bubbles, and extra length on each link beyond the two bubbles. */
const COLLIDE_GAP = 3;
const LINK_GAP = 16;
/** opened_for's chevrons (>>>>), in graph units: spacing, depth, half height. */
const CHEVRON_STEP = 2.6, CHEVRON_LEN = 1.3, CHEVRON_HALF = 1.3;
/** Link arrowheads, in graph units. */
const ARROW_LENGTH = 3.5;
const ARROW_WIDTH = 2.4;
/** Screen pixels kept clear around the fitted graph, and the closest a fit zooms in. */
const FIT_PADDING = 16;
const MAX_FIT_ZOOM = 4;
/** The longest artists already on the graph stay put while it changes around them (normally until the layout stops). */
const HOLD_MS = 15000;
/** How hard a held artist is pulled back to its place each tick (0..1). */
const HOLD_STRENGTH = 0.15;
/**
 * A node's mark: its dot and the name under it. `width` × `height` is the box the layout keeps clear (the dot and
 * the name); the dot is `dy` above the box's centre (where the simulation puts the node).
 */
type Mark = BubbleLabel & { r: number; dy: number };
const FALLBACK: Mark = { lines: [], width: 12, height: 8, corner: 0, r: DOT_R, dy: 0 };
/** The box for a dot of radius r with these lines of name under it. */
function markFor(b: BubbleLabel, expanded: boolean | undefined, group: boolean): Mark {
  const r = (expanded ? DOT_R_EXPANDED : DOT_R) * (group ? GROUP_SCALE : 1);
  const textW = b.lines.length ? Math.max(...b.lines.map(measure)) : 0;
  const height = 2 * r + NAME_GAP + b.lines.length * LINE_HEIGHT;
  return { ...b, width: Math.max(textW + 2, 2 * r + 2), height, r, dy: -height / 2 + r };
}

// One canvas to measure names with (the graph's own isn't there before the first draw)
let measureCtx: CanvasRenderingContext2D | null = null;
function measure(text: string): number {
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
    if (measureCtx) measureCtx.font = FONT;
  }
  return measureCtx ? measureCtx.measureText(text).width : text.length * LABEL_FONT * 0.55;
}

export function GraphView({ data: incoming, onNodeClick, onBackgroundClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods | undefined>(undefined);

  // Adding or removing artists shouldn't shake up the rest of the graph. The page hands over fresh node objects
  // on every change, and the layout keeps each node's position on its object: reuse the objects the layout
  // already has (updating their name, colour and expanded state), and start each new node next to a neighbour
  // that's already placed, so new connections grow out of the artist rather than flying in from anywhere.
  const placed = useRef(new Map<string | number, GraphNode>());
  const reachOf = (n: GraphNode) => { const b = layoutBubble(n.name ?? "", n.type, measure); return (b.width + b.height) / 4; };
  // Nodes held in place while the graph changes around them: the layout restarts at full strength on every change,
  // and without this newcomers (or gaps left by removals) push everything around. Held, not pinned: a strong pull
  // back to where each was (the "hold" force), so a newcomer can still nudge its neighbours aside instead of
  // landing on top of them. Released when the layout stops (so nothing is left to drift), or after HOLD_MS.
  // They're held in shape, not to fixed spots: the layout's centring force keeps moving the whole graph so its
  // middle stays put, and holding fixed spots against that made only the newcomers slide away from where they were
  // added. Instead the held artists move along with it (`shift`, how far their middle has moved) and the camera
  // follows them, so on screen they stay where they were.
  const held = useRef<{
    nodes: GraphNode[]; at: Map<GraphNode, [number, number]>; timer?: ReturnType<typeof setTimeout>;
    shift: [number, number]; followed: [number, number]; count: number;
  }>({ nodes: [], at: new Map(), shift: [0, 0], followed: [0, 0], count: 0 });
  const release = () => {
    const hold = held.current;
    clearTimeout(hold.timer);
    hold.nodes = [];
    hold.at.clear();
    hold.shift = [0, 0]; hold.followed = [0, 0]; hold.count = 0;
  };
  const data = useMemo(() => {
    const before = placed.current;
    release();
    const hold = held.current;
    const next = new Map<string | number, GraphNode>();
    const nodes = (incoming.nodes as GraphNode[]).map((n) => {
      const old = n.id !== undefined ? before.get(n.id) : undefined;
      const node = old ? Object.assign(old, { name: n.name, type: n.type, color: n.color, expanded: n.expanded, val: n.val }) : { ...n };
      if (node.id !== undefined) next.set(node.id, node);
      return node;
    });
    const endId = (e: unknown) => (typeof e === "object" && e !== null ? (e as GraphNode).id : e) as string | number;
    const neighbours = new Map<string | number, (string | number)[]>();
    for (const l of incoming.links) {
      const a = endId(l.source), b = endId(l.target);
      neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
      neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
    }
    // Start each new node where its links will want it, so it doesn't travel across the graph:
    // - next to two or more placed neighbours: between them (their average), nudged apart from the others there;
    // - next to one: on its outer side (away from the middle of the graph, where the other artists are), fanned
    //   out with that neighbour's other newcomers.
    // A few passes, so a new node next to another new one is placed once that one is.
    const placedNow = nodes.filter((n) => n.x !== undefined && n.y !== undefined);
    const cx = placedNow.reduce((t, n) => t + n.x!, 0) / Math.max(1, placedNow.length);
    const cy = placedNow.reduce((t, n) => t + n.y!, 0) / Math.max(1, placedNow.length);
    const single = new Map<GraphNode, GraphNode[]>();   // anchor -> new nodes with only it placed, in order
    const between: [GraphNode, GraphNode[]][] = [];
    for (let pass = 0; pass < 3; pass++) {
      for (const n of nodes) {
        if (n.x !== undefined || n.id === undefined) continue;
        const placedAnchors = [...new Set((neighbours.get(n.id) ?? []).map((id) => next.get(id)))]
          .filter((m): m is GraphNode => m !== undefined && m.x !== undefined && m.y !== undefined);
        if (placedAnchors.length === 0) continue;
        if (placedAnchors.length === 1) single.set(placedAnchors[0]!, [...(single.get(placedAnchors[0]!) ?? []), n]);
        else between.push([n, placedAnchors]);
        n.x = placedAnchors[0]!.x; n.y = placedAnchors[0]!.y;   // for now, so the next pass can anchor to it
      }
    }
    for (const [anchor, news] of single) {
      const out = Math.hypot(anchor.x! - cx, anchor.y! - cy) > 1
        ? Math.atan2(anchor.y! - cy, anchor.x! - cx) : Math.random() * 2 * Math.PI;
      const fan = Math.min(Math.PI * 0.8, 0.45 * news.length);   // wider for more newcomers, up to ±72°
      news.forEach((n, i) => {
        const angle = out + (news.length === 1 ? 0 : -fan + (2 * fan * i) / (news.length - 1));
        const r = reachOf(anchor) + reachOf(n) + LINK_GAP + 10 + (i % 2) * 18;
        n.x = anchor.x! + r * Math.cos(angle);
        n.y = anchor.y! + r * Math.sin(angle);
      });
    }
    between.forEach(([n, anchors], i) => {
      const mx = anchors.reduce((t, a) => t + a.x!, 0) / anchors.length;
      const my = anchors.reduce((t, a) => t + a.y!, 0) / anchors.length;
      const angle = (i * 2.4) % (2 * Math.PI);   // spread several around the same spot (golden-angle steps)
      n.x = mx + 12 * Math.cos(angle);
      n.y = my + 12 * Math.sin(angle);
    });
    placed.current = next;
    // Hold the artists that were already placed when artists were added or removed (a change in names or colours
    // alone doesn't move anything).
    const changed = nodes.some((n) => n.id !== undefined && !before.has(n.id)) || [...before.keys()].some((id) => !next.has(id));
    if (changed) {
      for (const n of nodes) {
        if (n.id !== undefined && before.has(n.id) && n.x !== undefined && n.y !== undefined && n.fx === undefined) {
          hold.at.set(n, [n.x, n.y]);
          hold.nodes.push(n);
        }
      }
      hold.count = hold.at.size;   // so the camera follows from the very first tick
      hold.timer = setTimeout(release, HOLD_MS);
    }
    return { nodes, links: incoming.links.map((l) => ({ ...l, source: endId(l.source), target: endId(l.target) })) } as ForceGraphData;
  }, [incoming]);

  // Each node's lines and box, worked out once per graph
  const bubbles = useMemo(() => {
    const map = new Map<string | number, Mark>();
    for (const n of data.nodes as GraphNode[]) {
      if (n.id !== undefined) map.set(n.id, markFor(layoutBubble(n.name ?? "", n.type, measure), n.expanded, n.type === "artist"));
    }
    return map;
  }, [data]);
  // The forces read the current bubbles through a ref: they're set up once, and
  // the simulation re-reads sizes whenever it's given new nodes
  const bubblesRef = useRef(bubbles);
  bubblesRef.current = bubbles;
  const bubble = (n: GraphNode) => (n.id !== undefined ? bubblesRef.current.get(n.id) : undefined) ?? FALLBACK;
  const reach = (n: GraphNode) => (bubble(n).width + bubble(n).height) / 4;

  // Bubbles don't overlap, and links are long enough to leave a gap between the two.
  // Set on the first tick: the graph's engine isn't there when this component's
  // effects first run.
  const forcesSet = useRef(false);
  const setForces = () => {
    const g = graphRef.current;
    if (!g || forcesSet.current) return;
    forcesSet.current = true;
    g.d3Force("collide", boxCollide<GraphNode>(bubble, COLLIDE_GAP) as Parameters<ForceGraphMethods["d3Force"]>[1]);
    // Held nodes are pulled back towards where they were, every tick (not scaled down as the layout cools).
    const hold = () => {
      const [sx, sy] = held.current.shift;
      for (const [n, [x, y]] of held.current.at) {
        n.vx = (n.vx ?? 0) + (x + sx - (n.x ?? x)) * HOLD_STRENGTH;
        n.vy = (n.vy ?? 0) + (y + sy - (n.y ?? y)) * HOLD_STRENGTH;
      }
    };
    g.d3Force("hold", hold as unknown as Parameters<ForceGraphMethods["d3Force"]>[1]);
    const link = g.d3Force("link") as { distance?: (d: (l: { source: GraphNode; target: GraphNode }) => number) => void } | undefined;
    link?.distance?.((l) => reach(l.source) + reach(l.target) + LINK_GAP);
    g.d3ReheatSimulation();
  };

  // Each tick: how far the held artists' middle has moved from where it was, and the camera moves by as much, so
  // they stay put on screen. When the held set changes (an artist dragged away) only the new baseline is taken.
  const follow = () => {
    const g = graphRef.current, hold = held.current;
    if (!g || hold.at.size === 0) return;
    let dx = 0, dy = 0;
    for (const [n, [x, y]] of hold.at) { dx += (n.x ?? x) - x; dy += (n.y ?? y) - y; }
    const shift: [number, number] = [dx / hold.at.size, dy / hold.at.size];
    hold.shift = shift;
    if (hold.count === hold.at.size) {
      const mx = shift[0] - hold.followed[0], my = shift[1] - hold.followed[1];
      if (Math.abs(mx) > 0.01 || Math.abs(my) > 0.01) {
        const c = g.centerAt() as unknown as { x: number; y: number } | undefined;
        if (c) g.centerAt(c.x + mx, c.y + my);
      }
    }
    hold.followed = shift;
    hold.count = hold.at.size;
  };

  // Fit every bubble (not just node centres, as zoomToFit does) into the view
  const fit = (ms: number) => {
    const g = graphRef.current, el = containerRef.current;
    const nodes = data.nodes as GraphNode[];
    if (!g || !el || nodes.length === 0) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      if (n.x === undefined || n.y === undefined) continue;
      const b = bubble(n);
      x0 = Math.min(x0, n.x - b.width / 2); x1 = Math.max(x1, n.x + b.width / 2);
      y0 = Math.min(y0, n.y - b.height / 2); y1 = Math.max(y1, n.y + b.height / 2);
    }
    if (!Number.isFinite(x0)) return;
    const k = Math.min((el.clientWidth - 2 * FIT_PADDING) / (x1 - x0), (el.clientHeight - 2 * FIT_PADDING) / (y1 - y0), MAX_FIT_ZOOM);
    g.centerAt((x0 + x1) / 2, (y0 + y1) / 2, ms);
    g.zoom(Math.max(k, 0.05), ms);
  };

  // Fit the graph to the view when it first appears (the first search, or the first after Reset): once soon,
  // and again when the layout has settled. Later additions and removals leave the camera where it is.
  const fitPending = useRef(false);
  const wasEmpty = useRef(true);
  useEffect(() => {
    const empty = data.nodes.length === 0;
    if (!empty && wasEmpty.current) {
      fitPending.current = true;
      setTimeout(() => fit(400), 500);
    }
    wasEmpty.current = empty;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  return (
    <div ref={containerRef} style={{ flex: 1, position: "relative", overflow: "hidden", minWidth: 0 }}>
      <ForceGraph2D
        ref={graphRef as React.MutableRefObject<ForceGraphMethods | undefined>}
        graphData={data}
        nodeLabel={isTouch ? "" : "name"}
        nodeColor="color"
        onNodeClick={onNodeClick}
        onNodeDrag={(node) => { held.current.at.delete(node as GraphNode); }}
        onBackgroundClick={onBackgroundClick}
        onLinkClick={onBackgroundClick}
        onEngineTick={() => { setForces(); follow(); }}
        onEngineStop={() => {
          release();
          if (!fitPending.current) return;
          fitPending.current = false;
          fit(400);
        }}
        backgroundColor="#F3ECE1"
        // Links run from dot to dot, drawn as their relationship's mark (colour and stroke pattern)
        linkCanvasObjectMode={() => "replace"}
        linkCanvasObject={(link, ctx, globalScale) => {
          const l = link as GraphLink;
          const s = l.source as GraphNode, t = l.target as GraphNode;
          if (typeof s !== "object" || typeof t !== "object" || s.x === undefined || t.x === undefined) return;
          const dx = (t.x ?? 0) - (s.x ?? 0), dy = (t.y ?? 0) - (s.y ?? 0);
          const len = Math.hypot(dx, dy);
          if (len === 0) return;
          // From dot to dot: start and end at their edges, the arrowhead touching the target's dot
          const ms = bubble(s), mt = bubble(t);
          const reach = (n: GraphNode, m: Mark) =>
            n.type === "artist" ? m.r : m.r * (1 + (n.expanded ? PERSON_PAD : PERSON_PAD_UNEXPANDED));
          const rs = reach(s, ms), rt = reach(t, mt);
          const sxc = s.x ?? 0, syc = (s.y ?? 0) + ms.dy, txc = t.x ?? 0, tyc = (t.y ?? 0) + mt.dy;
          const ddx = txc - sxc, ddy = tyc - syc, dlen = Math.hypot(ddx, ddy);
          if (dlen <= rs + rt) return; // the dots touch: no room for a line
          const ux = ddx / dlen, uy = ddy / dlen;
          const x0 = sxc + ux * rs, y0 = syc + uy * rs;
          const tGap = t.type === "artist" ? rt + 0.6 : rt;
          const x1 = txc - ux * tGap, y1 = tyc - uy * tGap;
          const mark = edgeMark(l.type);
          const arrowL = ARROW_LENGTH * Math.max(1, mark.width), arrowW = ARROW_WIDTH * Math.max(1, mark.width);
          ctx.strokeStyle = ctx.fillStyle = mark.color;
          ctx.lineWidth = Math.max(mark.width, 1 / globalScale);
          ctx.lineCap = mark.round ? "round" : "butt";
          ctx.setLineDash(mark.dash);
          ctx.beginPath();
          if (mark.chevrons) {
            // A run of >'s pointing at the target, every CHEVRON_STEP, up to its dot (they show the direction: no arrowhead)
            const run = Math.hypot(x1 - x0, y1 - y0);
            for (let d = CHEVRON_STEP; d <= run; d += CHEVRON_STEP) {
              const px = x0 + ux * d, py = y0 + uy * d;
              ctx.moveTo(px - ux * CHEVRON_LEN - uy * CHEVRON_HALF, py - uy * CHEVRON_LEN + ux * CHEVRON_HALF);
              ctx.lineTo(px, py);
              ctx.lineTo(px - ux * CHEVRON_LEN + uy * CHEVRON_HALF, py - uy * CHEVRON_LEN - ux * CHEVRON_HALF);
            }
          } else {
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1 - ux * arrowL, y1 - uy * arrowL);
          }
          ctx.stroke();
          ctx.setLineDash([]);
          if (mark.chevrons) return;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - ux * arrowL - uy * arrowW / 2, y1 - uy * arrowL + ux * arrowW / 2);
          ctx.lineTo(x1 - ux * arrowL + uy * arrowW / 2, y1 - uy * arrowL - ux * arrowW / 2);
          ctx.closePath();
          ctx.fill();
        }}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const n = node as GraphNode;
          const m = bubble(n);
          const x = n.x ?? 0, cy = (n.y ?? 0) + m.dy;
          const group = n.type === "artist";

          // As in the design: a person is a filled dot, a group a cluster of three filled dots edged in paper.
          // Not expanded: dashed outlines filled with paper (so links never show through), deep for a person and
          // maroon for a group.
          if (group) {
            const s = m.r / GROUP_HALF;
            for (const [i, d] of GROUP_DOTS.entries()) {
              ctx.beginPath();
              ctx.arc(x + (d.x - 10) * s, cy + (d.y - 10.5) * s, (n.expanded ? d.filled : d.open) * s, 0, 2 * Math.PI);
              ctx.fillStyle = n.expanded ? NODE_INK : PAPER;
              ctx.fill();
              // Not expanded: the same thin, deep, dashed outline as a person not yet expanded
              ctx.strokeStyle = n.expanded ? PAPER : DEEP;
              ctx.lineWidth = n.expanded ? (i === 2 ? 1.7 : 1) * s : 0.7;
              ctx.setLineDash(n.expanded ? [] : [1, 1]);
              ctx.stroke();
            }
          } else if (n.expanded) {
            ctx.beginPath();
            ctx.arc(x, cy, m.r, 0, 2 * Math.PI);
            ctx.fillStyle = NODE_INK;
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.arc(x, cy, m.r - 0.35, 0, 2 * Math.PI);
            ctx.fillStyle = PAPER;
            ctx.fill();
            ctx.strokeStyle = DEEP;
            ctx.lineWidth = 0.7;
            ctx.setLineDash([1, 1]);
            ctx.stroke();
          }
          ctx.setLineDash([]);

          if (m.lines.length === 0 || LABEL_FONT * globalScale < MIN_READABLE_PX) return;
          // The name under the dot, on a paper halo so links passing behind don't cut through it
          ctx.font = FONT;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.lineJoin = "round";
          ctx.lineWidth = 1.4;
          ctx.strokeStyle = PAPER;
          ctx.fillStyle = DEEP;
          const top = cy + m.r + NAME_GAP + LINE_HEIGHT / 2;
          m.lines.forEach((line, i) => {
            ctx.strokeText(line, x, top + i * LINE_HEIGHT);
            ctx.fillText(line, x, top + i * LINE_HEIGHT);
          });
        }}
        nodePointerAreaPaint={(node, color, ctx) => {
          const n = node as GraphNode, m = bubble(n);
          ctx.fillStyle = color;
          ctx.fillRect((n.x ?? 0) - m.width / 2, (n.y ?? 0) - m.height / 2, m.width, m.height);
        }}
      />
      {data.nodes.length === 0 && (
        <div className="graph-empty" style={styles.placeholder}>
          <p className="graph-empty-text" style={styles.placeholderText}>Search an artist to start</p>
          {/* Phones: the design's tighter, taller zigzag (65px segments, 118px high: index.css) */}
          <SwissLine layered bleed height={150} phoneSegmentWidth={65} style={styles.placeholderLine} />
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Empty: the invitation, large, flush left; the line runs across the foot of the page
  placeholder: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    padding: "40px 48px 28px",
  },
  placeholderText: {
    maxWidth: "700px",
    color: "#2E0A14",
    fontSize: "clamp(36px, 5.6vw, 76px)",
    lineHeight: 0.95,
    letterSpacing: "-0.055em",
  },
  placeholderLine: { marginLeft: "-48px", width: "calc(100% + 96px)" },
};
