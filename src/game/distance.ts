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

/** Gives the browser a turn (paint, input) before carrying on. */
export function yieldToBrowser(): Promise<void> {
  // Not scheduler.yield(): its continuations go ahead of rendering, so Chrome didn't paint
  // the page until the search had finished.
  return new Promise((resolve) => {
    // A message runs as its own task without setTimeout's 4 ms clamp; tests (no MessageChannel) use a timeout.
    if (typeof MessageChannel === "undefined") { setTimeout(resolve, 0); return; }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(null);
  });
}

/**
 * bfsDistances in slices of about `sliceMs`, giving the browser a turn between them, so a
 * large neighbourhood (a second or more of queries) never holds up the page. Resolves to
 * null if `signal` is aborted first.
 */
export async function bfsDistancesAsync(
  from: string,
  neighbors: (id: string) => string[],
  maxDepth: number,
  { signal, sliceMs = 8, yieldFn = yieldToBrowser }: { signal?: AbortSignal; sliceMs?: number; yieldFn?: () => Promise<void> } = {},
): Promise<Map<string, number> | null> {
  await yieldFn();   // let the page draw first
  if (signal?.aborted) return null;
  const dist = new Map<string, number>([[from, 0]]);
  let frontier = [from];
  let sliceStart = performance.now();
  for (let d = 1; d <= maxDepth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (performance.now() - sliceStart > sliceMs) {
        await yieldFn();
        if (signal?.aborted) return null;
        sliceStart = performance.now();
      }
      for (const n of neighbors(id)) {
        if (dist.has(n)) continue;
        dist.set(n, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  return signal?.aborted ? null : dist;
}

/** How far the distances are looked for: beyond this an artist is "4+ away" (and not in the map). */
export const AWAY_DEPTH = 3;

/** "1 away", "3 away", "4+ away" (an artist not within AWAY_DEPTH). */
export function awayLabel(d: number | undefined): string {
  return d === undefined ? `${AWAY_DEPTH + 1}+ away` : `${d} away`;
}
