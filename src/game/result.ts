/** How a finished game went against par: "On par", "2 under par", "1 over par". */
export function parVerdict(steps: number, par: number): string {
  if (steps === par) return "On par";
  const d = Math.abs(steps - par);
  return `${d} ${steps < par ? "under" : "over"} par`;
}
