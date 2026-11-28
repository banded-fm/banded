/**
 * How a pair of artists connects, as the Similarity and Discover panels show it:
 * the strongest path hop by hop (with each hop's weight and why), and the
 * product that makes its score. Both panels use Explore's .info-panel look.
 */
import { FREE_HOPS, HOP_DAMPING, REL_WEIGHTS, type PairScore, type PathStep } from "../pages/similarity";
import { relationSentence } from "../graph/relationships";

export function scoreColor(score: number): string {
  if (score >= 70) return "#1F7A74";
  if (score >= 40) return "#B87A0A";
  if (score >= 15) return "#D4561A";
  return "#6B4A50";
}

/** "1.00 × 0.80 × 0.80 × 0.9 = 0.58 → 58": how the strongest path's weights make the score. */
export function scoreFormula(pair: PairScore, minStrength: number): string {
  const path = pair.path;
  if (path == null) return "0";
  if (path.length === 0) return "Same artist: 100.";
  const extra = Math.max(0, path.length - FREE_HOPS);
  const damping = extra === 0 ? "" : ` × ${HOP_DAMPING}${extra === 1 ? "" : superscript(extra)}`;
  const weights = path.map((s) => s.weight.toFixed(2)).join(" × ");
  const strength = pair.strength ?? 0;
  // Two decimals would read 0.00 for the weakest paths
  const shown = strength < 0.01 ? strength.toFixed(3) : strength.toFixed(2);
  const floor = pair.score === 0 ? ` (under ${minStrength} counts as 0)` : "";
  return `${weights}${damping} = ${shown} → ${pair.score}${floor}`;
}

/**
 * Why a hop counts for what it does: how often it happened ("12 songs: 0.80 → 0.97"),
 * and hub damping ("Damped from 0.97: Taylor Swift has 133 links of this kind").
 */
export function stepNotes(step: PathStep): string[] {
  const notes: string[] = [];
  const base = step.baseWeight ?? step.weight;
  if (step.count !== undefined) {
    const unit = step.relType === "opened_for" ? "show" : "song";
    const times = `${step.count} ${unit}${step.count === 1 ? "" : "s"}`;
    const plain = REL_WEIGHTS[step.relType];
    notes.push(plain !== undefined && base > plain ? `${times}: ${plain.toFixed(2)} → ${base.toFixed(2)}` : times);
  }
  if (step.hubs) {
    const who = step.hubs.map((h) => `${h.node.name} has ${h.count}`).join(", ");
    notes.push(`Damped from ${base.toFixed(2)}: ${who} links of this kind`);
  }
  return notes;
}

function superscript(n: number): string {
  return String(n).replace(/\d/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(d)]!);
}

/** The path as a numbered list: one sentence per hop, its weight, and its notes. */
export function PathSteps({ path }: { path: PathStep[] }) {
  return (
    <ol style={pathStyles.list}>
      {path.map((step, i) => (
        <li key={i} style={pathStyles.step}>
          <span style={pathStyles.weightRow}>
            <span>{relationSentence(step.relType, step.from.name, step.to.name, step.fromIsSource)}</span>
            <span style={pathStyles.weightValue}>{step.weight.toFixed(2)}</span>
          </span>
          {stepNotes(step).map((note) => (
            <span key={note} style={pathStyles.note}>{note}</span>
          ))}
        </li>
      ))}
    </ol>
  );
}

const pathStyles: Record<string, React.CSSProperties> = {
  list: { margin: 0, paddingLeft: "1.25rem", display: "flex", flexDirection: "column", gap: "0.35rem", fontSize: "14px", fontWeight: 400, color: "#2E0A14" },
  step: { overflowWrap: "anywhere" },
  note: { display: "block", fontSize: "0.72rem", color: "#6B4A50", marginTop: "0.1rem" },
  weightRow: { display: "flex", justifyContent: "space-between", gap: "0.75rem", fontSize: "0.8rem", color: "#2E0A14" },
  weightValue: { color: "#2E0A14", fontVariantNumeric: "tabular-nums", flexShrink: 0 },
};

/** The side panel (desktop) / bottom sheet (phones): Explore's InfoPanel look. */
export const panelStyles: Record<string, React.CSSProperties> = {
  panel: { width: "320px", maxWidth: "100%", padding: "16px 24px 20px", background: "#F3ECE1", borderTop: "2px solid #2E0A14", overflowY: "auto", display: "flex", flexDirection: "column", gap: "1rem", flexShrink: 0 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "-0.5rem" },
  badge: { padding: "3px 8px", fontSize: "13px", fontWeight: 500, color: "#F3ECE1" },
  close: { background: "none", border: "none", color: "#2E0A14", fontSize: "1.75rem", cursor: "pointer", lineHeight: 1 },
  title: { fontSize: "36px", fontWeight: 500, lineHeight: 0.95, letterSpacing: "-0.055em", color: "#7A1631", overflowWrap: "anywhere", margin: 0 },
  section: { display: "flex", flexDirection: "column", gap: "0.4rem", borderTop: "1px solid #D8CBBB", paddingTop: "10px" },
  heading: { fontSize: "12px", fontWeight: 500, color: "#2E0A14", textTransform: "uppercase", letterSpacing: "0.1em", margin: 0 },
  muted: { fontSize: "14px", fontWeight: 400, color: "#6B4A50", margin: 0 },
};
