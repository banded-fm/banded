/**
 * MusicBrainz API client.
 * Docs: https://musicbrainz.org/doc/MusicBrainz_API
 *
 * Rate limit: 1 request per second. We add a simple delay mechanism.
 */

const BASE_URL = "https://musicbrainz.org/ws/2";
const USER_AGENT = "Banded/0.0.1 (https://banded.fm)";

import { debugLog } from "../debug/DebugLog";
import { cachedFetch } from "./cache";

let lastRequestTime = 0;

async function mbFetch<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  // Respect 1 req/sec rate limit (skipped in tests, where fetch is stubbed)
  const isTest = typeof process !== "undefined" && process.env?.VITEST;
  if (!isTest) {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < 1100) {
      await new Promise((r) => setTimeout(r, 1100 - elapsed));
    }
    lastRequestTime = Date.now();
  }

  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("fmt", "json");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  // Browsers send their own User-Agent; setting one is a non-safelisted
  // header that forces a CORS preflight, which can fail. fmt=json covers Accept.
  const isBrowser = typeof window !== "undefined";
  const response = await fetch(url.toString(), isBrowser ? {} : {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`MusicBrainz API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

// --- Types for MusicBrainz responses (simplified) ---

export interface MBArtistSearchResult {
  artists: MBArtist[];
}

export interface MBArtist {
  id: string; // MBID
  name: string;
  type?: "Person" | "Group" | "Orchestra" | "Choir" | "Character" | "Other";
  disambiguation?: string;
  country?: string;
  "life-span"?: { begin?: string; end?: string; ended?: boolean };
  area?: { name: string };
  "begin-area"?: { name: string };
  tags?: Array<{ name: string; count: number }>;
  relations?: MBRelation[];
}

export interface MBRelation {
  type: string; // e.g. "member of band", "label"
  "target-type": string; // e.g. "artist", "label", "url"
  direction: "forward" | "backward";
  begin?: string;
  end?: string;
  ended?: boolean;
  artist?: MBArtist;
  label?: { id: string; name: string };
  attributes?: string[];
}

// --- Public API ---

/**
 * Search for artists by name.
 */
export async function searchArtists(query: string, limit = 10): Promise<MBArtist[]> {
  const cacheKey = `mb_search_${query}_${limit}`;
  return cachedFetch(cacheKey, async () => {
    debugLog.log(`Querying MusicBrainz for "${query}"`);
    const result = await mbFetch<MBArtistSearchResult>("/artist", {
      query: `artist:"${query}"`,
      limit: limit.toString(),
    });
    debugLog.log(`MusicBrainz returned ${result.artists.length} results for "${query}"`);
    return result.artists;
  });
}

/** Escape Lucene query syntax so user input is matched literally. */
function escapeLucene(term: string): string {
  return term.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, "\\$&");
}

/**
 * Search-as-you-type query: the last word is a prefix ("ty seg" matches
 * "Ty Segall"), the full phrase is boosted. Results include the disambiguation
 * comment, which labels the artist dropdown.
 */
export async function searchArtistsPrefix(query: string, limit = 15): Promise<MBArtist[]> {
  const words = query.trim().split(/\s+/).filter(Boolean).map(escapeLucene);
  if (words.length === 0) return [];
  const phrase = `"${words.join(" ")}"`;
  const prefix = words.map((w, i) => (i === words.length - 1 ? `${w}*` : w)).join(" AND ");
  const result = await mbFetch<MBArtistSearchResult>("/artist", {
    query: `artist:${phrase}^3 OR artist:(${prefix}) OR alias:(${prefix})`,
    limit: limit.toString(),
  });
  return result.artists;
}

/**
 * Pick the best match from search results, preferring an exact (case-insensitive)
 * name match over MusicBrainz's relevance ranking.
 *
 * This prevents cases like searching "Fuzz" returning "Buzz Fuzz" (which
 * MusicBrainz ranks higher) instead of the actual band named "Fuzz".
 */
export function pickBestMatch(query: string, results: MBArtist[]): MBArtist | null {
  if (results.length === 0) return null;
  const exact = results.find((a) => a.name.toLowerCase() === query.toLowerCase());
  return exact ?? results[0]!;
}

/**
 * Get a single artist with relationships (members, labels, etc.)
 */
export async function getArtistWithRelations(mbid: string): Promise<MBArtist> {
  const cacheKey = `mb_artist_${mbid}`;
  return cachedFetch(cacheKey, async () => {
    debugLog.log(`Querying MusicBrainz for artist relations (${mbid})`);
    return mbFetch<MBArtist>(`/artist/${mbid}`, {
      inc: "artist-rels+label-rels",
    });
  });
}

/**
 * Get members of a group (artists related as "member of band").
 * A member may have multiple relationships (e.g. "original member" + "member").
 * They are considered current if ANY of their membership relationships is not ended.
 */
export function extractMembers(artist: MBArtist): Array<{
  artist: MBArtist;
  current: boolean;
}> {
  if (!artist.relations) return [];

  const memberMap = new Map<string, { artist: MBArtist; current: boolean }>();

  for (const rel of artist.relations) {
    if (
      rel.type === "member of band" &&
      rel["target-type"] === "artist" &&
      rel.direction === "backward" &&
      rel.artist
    ) {
      const existing = memberMap.get(rel.artist.id);
      if (existing) {
        // If any relationship is not ended, mark as current
        if (!rel.ended) {
          existing.current = true;
        }
      } else {
        memberMap.set(rel.artist.id, {
          artist: rel.artist,
          current: !rel.ended,
        });
      }
    }
  }

  return [...memberMap.values()];
}

/**
 * Get bands a musician belongs to.
 * Deduplicates: a musician is "current" if any membership relationship is not ended.
 */
export function extractBands(artist: MBArtist): Array<{
  artist: MBArtist;
  current: boolean;
}> {
  if (!artist.relations) return [];

  const bandMap = new Map<string, { artist: MBArtist; current: boolean }>();

  for (const rel of artist.relations) {
    if (
      rel.type === "member of band" &&
      rel["target-type"] === "artist" &&
      rel.direction === "forward" &&
      rel.artist
    ) {
      const existing = bandMap.get(rel.artist.id);
      if (existing) {
        if (!rel.ended) {
          existing.current = true;
        }
      } else {
        bandMap.set(rel.artist.id, {
          artist: rel.artist,
          current: !rel.ended,
        });
      }
    }
  }

  return [...bandMap.values()];
}

/**
 * Get supporting musicians for a group (people who supported but aren't full members).
 * MusicBrainz relationship type: "support musician" (direction backward = person supported this group).
 */
export function extractSupportMusicians(artist: MBArtist): Array<{
  artist: MBArtist;
}> {
  if (!artist.relations) return [];

  const seen = new Map<string, { artist: MBArtist }>();

  for (const rel of artist.relations) {
    if (
      rel.type === "supporting musician" &&
      rel["target-type"] === "artist" &&
      rel.direction === "backward" &&
      rel.artist &&
      !seen.has(rel.artist.id)
    ) {
      seen.set(rel.artist.id, { artist: rel.artist });
    }
  }

  return [...seen.values()];
}

/**
 * Get groups a musician has supported (direction forward = person supported that group).
 */
export function extractSupportedBands(artist: MBArtist): Array<{
  artist: MBArtist;
}> {
  if (!artist.relations) return [];

  const seen = new Map<string, { artist: MBArtist }>();

  for (const rel of artist.relations) {
    if (
      rel.type === "supporting musician" &&
      rel["target-type"] === "artist" &&
      rel.direction === "forward" &&
      rel.artist &&
      !seen.has(rel.artist.id)
    ) {
      seen.set(rel.artist.id, { artist: rel.artist });
    }
  }

  return [...seen.values()];
}

/**
 * Get labels associated with an artist.
 */
export function extractLabels(artist: MBArtist): Array<{ id: string; name: string }> {
  if (!artist.relations) return [];
  return artist.relations
    .filter((rel) => rel["target-type"] === "label" && rel.label)
    .map((rel) => rel.label!);
}
