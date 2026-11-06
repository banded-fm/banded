/**
 * Where a game has got to, worked out without waiting for the graph download.
 *
 * Guesses are stored by name. Each one is matched against the neighbors of the
 * artist before it, starting from the puzzle's start. Neighbors come from
 * graphSource: the local graph once it has loaded and has the artist, and the
 * server until then. So a listed puzzle (whose start, end and par are in
 * puzzles.json) is playable straight away.
 */
import { findNodeByName, isDbLoaded } from "../db/graphDb";
import { getArtistNeighbors, getServerNeighbors, inLocalGraph, type Neighbor } from "../db/graphSource";

export interface Walk {
  /** Identifies the start and guesses this walk is for (see walkKey). */
  key: string;
  /** The artists visited, start first. */
  ids: string[];
  /** The moves from the last artist; empty if a guess couldn't be followed. */
  neighbors: Neighbor[];
}

export interface WalkSources {
  neighbors: (id: string) => Promise<Neighbor[]>;
  /** The server's neighbors, for a move it offered before the local graph loaded. */
  serverNeighbors: (id: string) => Promise<Neighbor[]>;
  inLocal: (id: string) => boolean;
  /** A last resort for an older saved game: the local graph's artist with this name. */
  byName: (name: string) => Neighbor["node"] | null;
}

const defaultSources: WalkSources = {
  neighbors: getArtistNeighbors,
  serverNeighbors: getServerNeighbors,
  inLocal: inLocalGraph,
  byName: (name) => (isDbLoaded() ? findNodeByName(name) : null),
};

export const walkKey = (startId: string, guesses: string[]) => [startId, ...guesses].join("\n");

export async function walkGame(startId: string, guesses: string[], sources: WalkSources = defaultSources): Promise<Walk> {
  const key = walkKey(startId, guesses);
  const ids = [startId];
  let neighbors = await sources.neighbors(startId);
  for (const guess of guesses) {
    const lower = guess.toLowerCase();
    const find = (ns: Neighbor[]) => ns.find((n) => n.node.name.toLowerCase() === lower)?.node;
    const prev = ids[ids.length - 1]!;
    // The local graph is cut to fit the download, so a move the server offered may only be there.
    const node = find(neighbors)
      ?? (sources.inLocal(prev) ? find(await sources.serverNeighbors(prev)) : undefined)
      ?? sources.byName(guess);
    if (!node) return { key, ids, neighbors: [] };
    ids.push(node.id);
    neighbors = await sources.neighbors(node.id);
  }
  return { key, ids, neighbors };
}
