/**
 * Explore's bubbles: rounded rectangles, like message bubbles, with each node's
 * name inside. A name stays on one line unless that line would be too wide, then
 * it wraps onto two or three balanced lines. Sizes are in graph units, so the
 * text zooms with its bubble; the collision force keeps bubbles apart using the
 * same box.
 */

/** Font size of a name, in graph units (the graph's world, not screen pixels). */
export const LABEL_FONT = 4;
export const LINE_HEIGHT = LABEL_FONT * 1.2;
/** Space between the text and the bubble's edge. */
const PAD_X = 2.6;
const PAD_Y = 1.8;
/** Wrap a name whose single line would be wider than this (about 16 characters). */
const MAX_LINE_WIDTH = LABEL_FONT * 9;
const MAX_LINES = 3;
/** The narrowest bubble per node type (a short name still gets a tappable bubble). */
const MIN_WIDTH: Record<string, number> = { artist: 16, musician: 14 };
const DEFAULT_MIN_WIDTH = 12;
/** Corner radius: a single line is a pill; taller bubbles keep the same rounded corners. */
const MAX_CORNER = LABEL_FONT * 1.7;

export interface BubbleLabel {
  lines: string[];
  /** The bubble's full width and height, in graph units. */
  width: number;
  height: number;
  corner: number;
}

/** Every way of splitting the words into exactly `n` lines, in order. */
function splits(words: string[], n: number): string[][] {
  if (n === 1) return [[words.join(" ")]];
  const out: string[][] = [];
  for (let i = 1; i <= words.length - n + 1; i++) {
    for (const rest of splits(words.slice(i), n - 1)) out.push([words.slice(0, i).join(" "), ...rest]);
  }
  return out;
}

/**
 * The name on as few lines as fit within MAX_LINE_WIDTH (each split balanced so
 * its widest line is as narrow as possible); a name that never fits gets the
 * best MAX_LINES split.
 */
export function wrapName(name: string, measure: (text: string) => number): string[] {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [name.trim()];
  const widest = (lines: string[]) => Math.max(...lines.map(measure));
  let best: string[] = [words.join(" ")];
  for (let n = 1; n <= Math.min(MAX_LINES, words.length); n++) {
    let bestOfN: string[] | null = null;
    for (const lines of splits(words, n)) {
      if (!bestOfN || widest(lines) < widest(bestOfN)) bestOfN = lines;
    }
    best = bestOfN!;
    if (widest(best) <= MAX_LINE_WIDTH) break;
  }
  return best;
}

export function layoutBubble(name: string, type: string | undefined, measure: (text: string) => number): BubbleLabel {
  const lines = wrapName(name || "?", measure);
  const min = (type && MIN_WIDTH[type]) || DEFAULT_MIN_WIDTH;
  const width = Math.max(min, Math.max(...lines.map(measure)) + 2 * PAD_X);
  const height = lines.length * LINE_HEIGHT + 2 * PAD_Y;
  return { lines, width, height, corner: Math.min(height / 2, MAX_CORNER) };
}

/**
 * Where the line from a bubble's centre towards (dx, dy) leaves its box: the
 * offset from the centre. Links start and end there, so arrows touch the edge.
 */
export function edgeOffset(b: { width: number; height: number }, dx: number, dy: number): [number, number] {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax === 0 && ay === 0) return [0, 0];
  const t = Math.min(ax > 0 ? b.width / 2 / ax : Infinity, ay > 0 ? b.height / 2 / ay : Infinity);
  return [dx * t, dy * t];
}

interface SimNode { x?: number; y?: number; vx?: number; vy?: number }

/**
 * A d3 force that keeps boxes from overlapping (plus `gap`): any two that
 * overlap are pushed apart along the axis where they overlap least.
 */
export function boxCollide<N extends SimNode>(size: (n: N) => { width: number; height: number }, gap: number, strength = 0.6) {
  let nodes: N[] = [];
  const force = () => {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!, sa = size(a);
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!, sb = size(b);
        const dx = (b.x ?? 0) + (b.vx ?? 0) - ((a.x ?? 0) + (a.vx ?? 0));
        const dy = (b.y ?? 0) + (b.vy ?? 0) - ((a.y ?? 0) + (a.vy ?? 0));
        const ox = (sa.width + sb.width) / 2 + gap - Math.abs(dx);
        const oy = (sa.height + sb.height) / 2 + gap - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        if (ox < oy) {
          const push = (ox / 2) * strength * (dx < 0 ? -1 : 1);
          a.vx = (a.vx ?? 0) - push; b.vx = (b.vx ?? 0) + push;
        } else {
          const push = (oy / 2) * strength * (dy < 0 ? -1 : 1);
          a.vy = (a.vy ?? 0) - push; b.vy = (b.vy ?? 0) + push;
        }
      }
    }
  };
  force.initialize = (n: N[]) => { nodes = n; };
  return force;
}
