/**
 * The text a Play game shares, like Wordle's. Once won: the puzzle, a square per step coloured by how far that
 * artist was from the end (no names, so it spoils nothing), the result and a link to the same puzzle. Otherwise an
 * invitation to it.
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
  won: boolean;
  par?: number;
  url: string;
}

const plural = (n: number) => `${n} ${n === 1 ? "step" : "steps"}`;

export function shareText(i: ShareInput): string {
  const head = `Six Degrees of Music${i.dateLabel ? ` · ${i.dateLabel}` : ""}`;
  // Not won (still playing, or given up): an invitation to the same puzzle.
  if (!i.won) {
    return [head, `Can you connect ${i.start} to ${i.end}?${i.par != null ? ` Par ${i.par}.` : ""}`, i.url].join("\n");
  }
  const squares = i.steps.map(square).join("");
  const result = `${plural(i.steps.length)}${i.par != null ? ` · ${parVerdict(i.steps.length, i.par).replace(/^On par$/, "on par")}` : ""}`;
  return [head, `${i.start} → ${i.end}`, squares, result, i.url].join("\n");
}
