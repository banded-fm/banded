/**
 * The text a Play game shares, like Wordle's. Once won (or given up): the puzzle, a square per step coloured by how
 * far that artist was from the end (no names, so it spoils nothing), the result and a link to the same puzzle.
 * Otherwise an invitation to it.
 */
import { parVerdict } from "./result";

/** 🟩 the end, 🟨 one away, 🟧 two away, 🟥 three or more; ⬜ not known (the graph hadn't loaded). */
export function square(away: number | undefined): string {
  return away === 0 ? "🟩" : away === 1 ? "🟨" : away === 2 ? "🟧" : away === undefined ? "⬜" : "🟥";
}

export interface ShareInput {
  start: string;
  end: string;
  /** e.g. "12 Nov 2026" for the daily puzzle. */
  dateLabel?: string;
  /** How far each artist stepped to was from the end, in order (0 last when won; undefined if not known). */
  steps: (number | undefined)[];
  /** The steps picked from a list the hint had coloured (their indices): ❓ before their colour. */
  hinted?: number[];
  won: boolean;
  /** Gave up (revealed the path without winning): ❌ after the steps. */
  gaveUp?: boolean;
  par?: number;
  url: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function shareText(i: ShareInput): string {
  const head = `Six Degrees of Music${i.dateLabel ? ` · ${i.dateLabel}` : ""}`;
  // Still playing: an invitation to the same puzzle.
  if (!i.won && !i.gaveUp) {
    return [head, `Can you connect ${i.start} to ${i.end}?${i.par != null ? ` Par ${i.par}.` : ""}`, i.url].join("\n");
  }
  const hinted = new Set((i.hinted ?? []).filter((n) => n < i.steps.length));
  const squares = i.steps.map((d, n) => (hinted.has(n) ? "❓" : "") + square(d)).join("") + (i.gaveUp && !i.won ? "❌" : "");
  const steps = plural(i.steps.length, "step", "steps");
  const parts = i.won
    ? [steps, ...(i.par != null ? [parVerdict(i.steps.length, i.par).replace(/^On par$/, "on par")] : [])]
    : [`Gave up after ${steps}`];
  if (hinted.size > 0) parts.push(plural(hinted.size, "hint", "hints"));
  return [head, `${i.start} → ${i.end}`, squares, parts.join(" · "), i.url].join("\n");
}
