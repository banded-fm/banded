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

export function GraphView({ data, onNodeClick, onBackgroundClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods | undefined>(undefined);

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
    const link = g.d3Force("link") as { distance?: (d: (l: { source: GraphNode; target: GraphNode }) => number) => void } | undefined;
    link?.distance?.((l) => reach(l.source) + reach(l.target) + LINK_GAP);
    g.d3ReheatSimulation();
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

  // Fit the graph to the view when data changes: once soon, and again when the
  // layout has settled (bubbles spread out for a few seconds)
  const fitPending = useRef(false);
  useEffect(() => {
    if (data.nodes.length > 0) {
      fitPending.current = true;
      setTimeout(() => fit(400), 500);
    }
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
        onBackgroundClick={onBackgroundClick}
        onLinkClick={onBackgroundClick}
        onEngineTick={setForces}
        onEngineStop={() => {
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
