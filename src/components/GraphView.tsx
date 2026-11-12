import { useRef, useEffect, useMemo } from "react";
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";
import type { ForceGraphData } from "../graph/types";
import { LABEL_FONT, LINE_HEIGHT, boxCollide, edgeOffset, layoutBubble, type BubbleLabel } from "../graph/bubbles";

interface Props {
  data: ForceGraphData;
  onNodeClick: (node: { id?: string | number }) => void;
  /** A click or tap on empty space or a link (not a drag to pan). */
  onBackgroundClick?: () => void;
}

type GraphNode = NodeObject & { name?: string; type?: string; color?: string; expanded?: boolean };
type GraphLink = LinkObject & { color?: string };

// Hover tooltips duplicate the canvas label after a tap on touch screens
const isTouch = typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;

const FONT = `${LABEL_FONT}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
/** Below this many screen pixels the names are unreadable: draw just the bubbles. */
const MIN_READABLE_PX = 3.5;
/** Room between bubbles, and extra length on each link beyond the two bubbles. */
const COLLIDE_GAP = 3;
const LINK_GAP = 16;
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
const FALLBACK: BubbleLabel = { lines: [], width: 12, height: 8, corner: 4 };

// One canvas to measure names with (the graph's own isn't there before the first draw)
let measureCtx: CanvasRenderingContext2D | null = null;
function measure(text: string): number {
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
    if (measureCtx) measureCtx.font = FONT;
  }
  return measureCtx ? measureCtx.measureText(text).width : text.length * LABEL_FONT * 0.55;
}

/** A rounded rectangle centred on (x, y). */
function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, b: BubbleLabel) {
  const l = x - b.width / 2, t = y - b.height / 2, r = x + b.width / 2, bt = y + b.height / 2, c = b.corner;
  ctx.beginPath();
  ctx.moveTo(l + c, t);
  ctx.arcTo(r, t, r, bt, c);
  ctx.arcTo(r, bt, l, bt, c);
  ctx.arcTo(l, bt, l, t, c);
  ctx.arcTo(l, t, r, t, c);
  ctx.closePath();
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
    const map = new Map<string | number, BubbleLabel>();
    for (const n of data.nodes as GraphNode[]) {
      if (n.id !== undefined) map.set(n.id, layoutBubble(n.name ?? "", n.type, measure));
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
        backgroundColor="#0f0f0f"
        // Links run from bubble edge to bubble edge, with the arrowhead touching the target
        linkCanvasObjectMode={() => "replace"}
        linkCanvasObject={(link, ctx, globalScale) => {
          const l = link as GraphLink;
          const s = l.source as GraphNode, t = l.target as GraphNode;
          if (typeof s !== "object" || typeof t !== "object" || s.x === undefined || t.x === undefined) return;
          const dx = (t.x ?? 0) - (s.x ?? 0), dy = (t.y ?? 0) - (s.y ?? 0);
          const len = Math.hypot(dx, dy);
          if (len === 0) return;
          const [sx, sy] = edgeOffset(bubble(s), dx, dy);
          const [tx, ty] = edgeOffset(bubble(t), -dx, -dy);
          const x0 = (s.x ?? 0) + sx, y0 = (s.y ?? 0) + sy;
          const x1 = (t.x ?? 0) + tx, y1 = (t.y ?? 0) + ty;
          if ((x1 - x0) * dx + (y1 - y0) * dy <= 0) return; // the bubbles overlap: no room for a line
          const ux = dx / len, uy = dy / len;
          ctx.strokeStyle = ctx.fillStyle = l.color ?? "#666";
          ctx.lineWidth = 1 / globalScale;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1 - ux * ARROW_LENGTH, y1 - uy * ARROW_LENGTH);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - ux * ARROW_LENGTH - uy * ARROW_WIDTH / 2, y1 - uy * ARROW_LENGTH + ux * ARROW_WIDTH / 2);
          ctx.lineTo(x1 - ux * ARROW_LENGTH + uy * ARROW_WIDTH / 2, y1 - uy * ARROW_LENGTH - ux * ARROW_WIDTH / 2);
          ctx.closePath();
          ctx.fill();
        }}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const n = node as GraphNode;
          const x = n.x ?? 0, y = n.y ?? 0;
          const color = n.color ?? "#fff";
          const b = bubble(n);

          // Expanded: filled with the type's colour, dark text. Not expanded: an
          // outline around the page colour (links never show through it), light text.
          roundedRect(ctx, x, y, b);
          ctx.fillStyle = n.expanded ? color : "#0f0f0f";
          ctx.fill();
          if (!n.expanded) {
            ctx.strokeStyle = color;
            ctx.lineWidth = Math.max(0.6, 1.6 / globalScale);
            ctx.stroke();
          }

          if (b.lines.length === 0 || LABEL_FONT * globalScale < MIN_READABLE_PX) return;
          ctx.font = FONT;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = n.expanded ? "#111" : "#e0e0e0";
          const top = y - ((b.lines.length - 1) * LINE_HEIGHT) / 2;
          b.lines.forEach((line, i) => ctx.fillText(line, x, top + i * LINE_HEIGHT));
        }}
        nodePointerAreaPaint={(node, color, ctx) => {
          const n = node as GraphNode;
          roundedRect(ctx, n.x ?? 0, n.y ?? 0, bubble(n));
          ctx.fillStyle = color;
          ctx.fill();
        }}
      />
      {data.nodes.length === 0 && (
        <div style={styles.placeholder}>
          Search for an artist to start building the scene graph.
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  placeholder: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    color: "#666",
    fontSize: "1.1rem",
    textAlign: "center",
  },
};
