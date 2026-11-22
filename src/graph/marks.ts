/**
 * How each relationship is drawn (Direction B's "marks"): its own hue and its own stroke pattern, so it reads either
 * way. Widths and dashes are in graph units (a name is LABEL_FONT tall), and in pixels at 1:1 in the legend.
 */
import type { EdgeType } from "./types";

export interface EdgeMark {
  color: string;
  width: number;
  /** Dash and gap lengths; empty for a solid line. A near-zero dash with round caps draws dots. */
  dash: number[];
  round?: boolean;
  /** Drawn as a run of chevrons (>>>>) pointing along the link instead of a line. */
  chevrons?: boolean;
}

export const EDGE_MARKS: Partial<Record<EdgeType, EdgeMark>> = {
  member_of: { color: "#7A1631", width: 1.5, dash: [] },
  former_member_of: { color: "#6B4A50", width: 1.5, dash: [2.5, 1.5] },
  support_musician: { color: "#7A1631", width: 1, dash: [1.5, 1.25] },
  collaborated_with: { color: "#1F7A74", width: 1, dash: [] },
  produced_for: { color: "#5B3E9A", width: 1, dash: [] },
  opened_for: { color: "#D4561A", width: 0.65, dash: [], chevrons: true },
};

const FALLBACK_MARK: EdgeMark = { color: "#6B4A50", width: 1, dash: [] };
export const edgeMark = (type: EdgeType | string | undefined): EdgeMark =>
  (type && EDGE_MARKS[type as EdgeType]) || FALLBACK_MARK;

/** Node marks: a person is a filled dot, a group a cluster of three; not yet expanded, dashed outlines on paper. */
export const NODE_INK = "#7A1631";
export const PAPER = "#F3ECE1";
export const DEEP = "#2E0A14";
export const ROSE = "#E8C9C3";
