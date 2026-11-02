const SUPABASE_FUNCTIONS_URL = "https://lwqkjtzqjgacgvfjiyxg.supabase.co/functions/v1";

/**
 * Pollstar's JSON through our pollstar-city function: fetched by our server
 * and shared by every visitor through a 24-hour cache (and kept for
 * banded-data). Null when the function can't get it (Pollstar refusing
 * with nothing cached, or the function unreachable).
 */
export async function pollstarViaServer<T>(params: {
  search?: string;
  city?: string;
  page?: string;
  from?: string;
  to?: string;
}): Promise<T | null> {
  const qs = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string")
  );
  try {
    const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/pollstar-city?${qs}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: T };
    return body.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Report a search miss (artist not found in SQLite or DB).
 * Fire-and-forget, doesn't block the user.
 */
export function reportMiss(query: string, source: string): void {
  fetch(`${SUPABASE_FUNCTIONS_URL}/report-miss`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, source }),
  }).catch(() => {}); // fire and forget
}

/** A graph node as returned by the graph-neighbors edge function. */
export interface GraphNeighborNode {
  id: string;
  name: string;
  type: string;
}

export interface GraphNeighborsResponse {
  found: boolean;
  artist: GraphNeighborNode | null;
  /** count: song credits for collaborations (absent from older deployments of the function). */
  neighbors: Array<{ node: GraphNeighborNode; relType: string; outgoing?: boolean; count?: number }>;
}

/**
 * Tier-2 graph lookup: resolve an artist and its 1-hop neighbors from Postgres.
 * Used as a fallback when an artist isn't in the browser's core SQLite graph,
 * and for every lookup while that graph is still downloading.
 * Pass either an mbid (preferred) or a name. `logMiss: false` stops the edge
 * function recording a not-found artist in search_misses.
 */
export async function getGraphNeighbors(
  params: { mbid?: string; name?: string },
  options: { logMiss?: boolean } = {}
): Promise<GraphNeighborsResponse> {
  const qs = new URLSearchParams();
  if (params.mbid) qs.set("mbid", params.mbid);
  else if (params.name) qs.set("name", params.name);
  else throw new Error("getGraphNeighbors requires mbid or name");
  if (options.logMiss === false) qs.set("log", "0");

  const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/graph-neighbors?${qs}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

/** An artist search result: enough to label same-name artists in a dropdown. */
export interface ArtistSearchResult {
  id: string;
  name: string;
  type: string;
  disambiguation: string | null;
  area: string | null;
}

/**
 * Search-as-you-type artist lookup in Postgres (graph-neighbors' `q` mode).
 * Ranked exact > prefix > word-prefix > substring. Never logs a search miss.
 */
export async function searchArtistsDb(query: string, limit = 8): Promise<ArtistSearchResult[]> {
  const qs = new URLSearchParams({ q: query, limit: String(limit) });
  const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/graph-neighbors?${qs}`);
  if (!response.ok) throw new Error(`artist search failed: ${response.status}`);
  const body = (await response.json()) as { artists?: ArtistSearchResult[] };
  // A graph-neighbors deploy without search mode answers with an error body instead.
  if (!body.artists) throw new Error("artist search isn't deployed");
  return body.artists;
}
