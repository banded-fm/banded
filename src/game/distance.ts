/**
 * How far artists are from a puzzle's end: a breadth-first search out from the end artist, to a few steps.
 * Shown after each step ("2 away") and as the colours of the shared result.
 */

/** Steps from `from` to every artist within `maxDepth` (`from` itself is 0). */
export function bfsDistances(from: string, neighbors: (id: string) => string[], maxDepth: number): Map<string, number> {
  const dist = new Map<string, number>([[from, 0]]);
  let frontier = [from];
  for (let d = 1; d <= maxDepth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of neighbors(id)) {
        if (dist.has(n)) continue;
        dist.set(n, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  return dist;
}

/** How far the distances are looked for: beyond this an artist is "4+ away" (and not in the map). */
export const AWAY_DEPTH = 3;

/** "1 away", "3 away", "4+ away" (an artist not within AWAY_DEPTH). */
export function awayLabel(d: number | undefined): string {
  return d === undefined ? `${AWAY_DEPTH + 1}+ away` : `${d} away`;
}
