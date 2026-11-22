import { useEffect, useRef } from "react";
import { SHEET_CLOSE_MS } from "./useLingering";
import { SheetScrim } from "./SheetScrim";
import type { EdgeType } from "../graph/types";
import { EXPLORE_RELATIONSHIPS } from "../graph/relationships";
import { edgeMark } from "../graph/marks";

interface Props {
  visible: EdgeType[];
  onToggle: (type: EdgeType) => void;
  /** Another bottom sheet (the artist panel) is open: on phones the legend's sheet closes so they don't stack. */
  otherSheetOpen?: boolean;
}

/**
 * Explore's legend (starts closed, as in the design): each relationship's mark (hue and stroke pattern) and which way the arrows point, and the node
 * marks. Each relationship type has a checkbox that shows or hides those edges (and the artists only they connect).
 */
export function GraphLegend({ visible, onToggle, otherSheetOpen = false }: Props) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (otherSheetOpen && ref.current?.open && window.matchMedia("(max-width: 640px)").matches) closeLegend(ref.current, true);
  }, [otherSheetOpen]);
  // On phones the legend is a bottom sheet: a tap anywhere outside it (and its button) closes it
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const d = ref.current;
      if (!d?.open || !window.matchMedia("(max-width: 640px)").matches) return;
      if (e.target instanceof Node && d.contains(e.target)) return;
      closeLegend(d);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);
  return (
    <details ref={ref} className="graph-legend" style={styles.panel}>
      <summary className="graph-legend-button" style={styles.summary}
        onClick={(e) => { const d = ref.current; if (d?.open && isAnimatedSheet()) { e.preventDefault(); closeLegend(d); } }}>
        <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true" style={{ flex: "none" }}>
          <path d="M0 3h22" stroke="#7A1631" strokeWidth="4" />
          <path d="M0 8h22" stroke="#1F7A74" strokeWidth="3" />
          <path d="M0 13h22" stroke="#D4561A" strokeWidth="3" strokeDasharray="6 3" />
        </svg>
        <span>Legend</span>
        <span className="graph-legend-sign" aria-hidden="true" style={styles.sign} />
      </summary>
      {/* Below the button on wide screens; a sheet from the bottom of the screen on phones (index.css), as in the design */}
      {/* Phones: the dim layer behind the sheet (inside <details>, so it only shows while the legend is open) */}
      <SheetScrim onClose={() => { if (ref.current) closeLegend(ref.current); }} />
      <div className="graph-legend-body">
      <div className="graph-legend-sheet-head">
        <span className="eyebrow">Legend</span>
        <button type="button" className="graph-legend-hide" onClick={() => { if (ref.current) closeLegend(ref.current); }}>Hide</button>
      </div>
      <div className="graph-legend-section" style={styles.section}>
        {EXPLORE_RELATIONSHIPS.map((r) => (
          <label key={r.type} className="graph-legend-row" style={styles.row} title={r.direction}>
            <input type="checkbox" checked={visible.includes(r.type)} onChange={() => onToggle(r.type)} />
            <MarkSwatch type={r.type} />
            <span style={styles.text}>
              <span>{r.label}</span>
              <span style={styles.direction}>{r.direction}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="graph-legend-section" style={{ ...styles.section, ...styles.nodes }}>
        <span style={styles.nodeRow}><NodeSwatch kind="group" /> Group</span>
        <span style={styles.nodeRow}><NodeSwatch kind="person" /> Person</span>
        <span style={styles.nodeRow}><NodeSwatch kind="unexpanded" /> Not yet expanded</span>
      </div>
      </div>
    </details>
  );
}

/** The legend is a sheet that slides (phones, motion allowed). */
const isAnimatedSheet = () =>
  window.matchMedia("(max-width: 640px)").matches && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Closes the legend; on phones its sheet slides away first (and its scrim fades), then the <details> closes.
 * `now`: at once (another sheet is opening over it).
 */
function closeLegend(d: HTMLDetailsElement, now = false) {
  if (now || !isAnimatedSheet()) { d.open = false; return; }
  if (d.classList.contains("legend-closing")) return;
  d.classList.add("legend-closing");
  setTimeout(() => { d.open = false; d.classList.remove("legend-closing"); }, SHEET_CLOSE_MS);
}

/** A relationship's mark, as drawn on the graph (four times its graph-unit width, in pixels, as in the design). */
function MarkSwatch({ type }: { type: EdgeType }) {
  const m = edgeMark(type);
  return (
    <svg width="56" height="14" viewBox="0 0 56 14" aria-hidden="true" style={{ flex: "none" }}>
      {m.chevrons
        ? <path d="M2 2.5L7 7L2 11.5M11 2.5L16 7L11 11.5M20 2.5L25 7L20 11.5M29 2.5L34 7L29 11.5M38 2.5L43 7L38 11.5M47 2.5L52 7L47 11.5"
            fill="none" stroke={m.color} strokeWidth={m.width * 3} strokeLinejoin="miter" />
        : <path d={m.round ? "M3 7h46" : "M0 7h48"} stroke={m.color} strokeWidth={m.width * 4}
            strokeDasharray={m.dash.map((d) => d * 4).join(" ") || undefined} strokeLinecap={m.round ? "round" : "butt"} />}
      {!m.chevrons && <path d="M47 2L56 7L47 12z" fill={m.color} />}
    </svg>
  );
}

/**
 * A node's mark, as in the design's legend: a person's filled dot, a group's cluster of three, or the dashed outline
 * of one not yet expanded. (On the graph a group is drawn larger relative to a person than here.)
 */
function NodeSwatch({ kind }: { kind: "group" | "person" | "unexpanded" }) {
  if (kind === "group") return (
    <svg width="22" height="21" viewBox="-1 -0.5 22 21" aria-hidden="true" style={{ flex: "none" }}>
      <circle cx="4.55" cy="6.96" r="5.09" fill="#7A1631" stroke="#F3ECE1" strokeWidth="1" />
      <circle cx="15.45" cy="6.96" r="5.09" fill="#7A1631" stroke="#F3ECE1" strokeWidth="1" />
      <circle cx="10" cy="13.56" r="6.25" fill="#7A1631" stroke="#F3ECE1" strokeWidth="1" />
    </svg>
  );
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" style={{ flex: "none" }}>
      {kind === "person" && <circle cx="10" cy="10" r="8" fill="#7A1631" />}
      {kind === "unexpanded" && <circle cx="10" cy="10" r="8" fill="none" stroke="#2E0A14" strokeWidth="1.5" strokeDasharray="2.4 2" />}
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // A bordered button top right, level with the search box (bottom left on phones); open, a panel with a hard shadow
  panel: {
    position: "absolute", right: "48px", top: "20px", zIndex: 5, width: "min(364px, calc(100% - 32px))",
    background: "#F3ECE1", border: "2px solid #2E0A14", color: "#2E0A14", fontSize: "14px",
  },
  summary: {
    display: "flex", alignItems: "center", gap: "12px", height: "44px", padding: "0 18px",
    cursor: "pointer", fontSize: "15px", fontWeight: 500, color: "#2E0A14", userSelect: "none", listStyle: "none",
  },
  sign: { marginLeft: "auto", fontSize: "20px", lineHeight: 1 },
  section: { display: "flex", flexDirection: "column", padding: "0 18px" },
  row: { display: "flex", alignItems: "center", gap: "14px", padding: "8px 0", borderTop: "1px solid #D8CBBB", cursor: "pointer" },
  text: { display: "flex", flexDirection: "column", lineHeight: 1.25, fontSize: "15px" },
  direction: { color: "#6B4A50", fontSize: "12px", fontWeight: 400 },
  nodes: { flexDirection: "row", flexWrap: "wrap", gap: "8px 18px", borderTop: "1px solid #D8CBBB", padding: "10px 18px 12px", fontSize: "13px" },
  nodeRow: { display: "inline-flex", alignItems: "center", gap: "8px" },
};
