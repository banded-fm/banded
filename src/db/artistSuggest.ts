/**
 * Artist suggestions for the search-as-you-type dropdowns.
 *
 * Suggestions come from the database: the local graph once it has loaded,
 * else Postgres (graph-neighbors' search mode, which never logs misses).
 * MusicBrainz is asked too when the database has no artist of exactly that
 * name (ignoring case and accents): its same-name artists go first. So
 * "Nane" finds Nané even though the graph has Banane and Kyle Kinane.
 * Each suggestion is labelled the way MusicBrainz does it: its disambiguation
 * comment in parentheses, "Fuzz (US garage rock band)", and nothing when
 * MusicBrainz has none (that artist doesn't need telling apart). A graph
 * without the disambiguation column gets its labels from Postgres.
 */

import type { ArtistMatch } from "./graphDb";
import { foldName } from "./fold";
import type { MBArtist } from "../api/musicbrainz";

export interface ArtistSuggestion {
  id: string;
  name: string;
  /** "person" or "group" */
  type: string;
  /** MusicBrainz's disambiguation comment, the only label shown. */
  disambiguation?: string;
  /** Came from the MusicBrainz fallback: the app's database doesn't have this artist. */
  fromMusicBrainz?: true;
}

const GROUP_TYPES = new Set(["Group", "Orchestra", "Choir"]);

export function fromMusicBrainz(a: MBArtist): ArtistSuggestion {
  return {
    id: a.id,
    name: a.name,
    type: a.type && GROUP_TYPES.has(a.type) ? "group" : "person",
    ...(a.disambiguation ? { disambiguation: a.disambiguation } : {}),
    fromMusicBrainz: true,
  };
}

/** A graph or Postgres match as a suggestion. */
function fromMatch(n: ArtistMatch): ArtistSuggestion {
  return {
    id: n.id,
    name: n.name,
    type: n.type,
    ...(n.disambiguation ? { disambiguation: n.disambiguation } : {}),
  };
}

export interface SuggestionSources {
  /** Postgres artist search. */
  searchDb: (query: string, limit: number) => Promise<ArtistMatch[]>;
  searchMusicBrainz: (query: string) => Promise<MBArtist[]>;
}

/** Postgres rows fetched to label graph matches (more than shown, so the shown ones are covered). */
const DB_LABEL_LIMIT = 25;

/**
 * Suggestions for a typed query. The database answers whenever it can:
 *   1. the local graph, when loaded (`local`), labelled from its own columns
 *      if it has them (`localHasLabels`), else from Postgres rows by MBID;
 *   2. Postgres, while the graph is still downloading or has no match.
 * MusicBrainz is only asked when the database has no match or can't be
 * reached. Resolves to null when every source it tried failed.
 */
export async function findSuggestions(
  query: string,
  local: ArtistMatch[] | null,
  localHasLabels: boolean,
  limit: number,
  sources: SuggestionSources
): Promise<ArtistSuggestion[] | null> {
  const graphHits = local?.slice(0, limit) ?? [];
  if (graphHits.length > 0 && localHasLabels && hasExactMatch(query, graphHits)) return graphHits.map(fromMatch);

  let db: ArtistMatch[] = [];
  let dbFailed = false;
  if (graphHits.length === 0 || !localHasLabels) {
    try {
      db = await sources.searchDb(query, graphHits.length > 0 ? DB_LABEL_LIMIT : limit);
    } catch {
      dbFailed = true;
    }
  }

  let found: ArtistSuggestion[];
  if (graphHits.length > 0) {
    const labels = new Map(db.map((d) => [d.id, d]));
    found = graphHits.map((n) => {
      const d = labels.get(n.id);
      return fromMatch({ ...n, disambiguation: n.disambiguation ?? d?.disambiguation });
    });
  } else {
    found = db.slice(0, limit).map(fromMatch);
  }
  // The database has an artist of exactly that name: that's the one being looked for.
  if (hasExactMatch(query, found) || (graphHits.length > 0 && dbFailed && !localHasLabels)) return found;

  // No exact match: MusicBrainz's artists of that name (accents aside) go first, then the database's.
  let mb: MBArtist[];
  try {
    mb = await sources.searchMusicBrainz(query);
  } catch {
    return found.length > 0 ? found : dbFailed ? null : [];
  }
  if (found.length === 0) return mb.slice(0, limit).map(fromMusicBrainz);
  const have = new Set(found.map((f) => f.id));
  const q = foldName(query.trim());
  const sameName = mb.filter((a) => !have.has(a.id) && foldName(a.name) === q).map(fromMusicBrainz);
  return [...sameName, ...found].slice(0, limit);
}

/** Whether one of these artists has exactly that name, ignoring case and accents. */
export function hasExactMatch(query: string, matches: Array<{ name: string }>): boolean {
  const q = foldName(query.trim());
  return matches.some((m) => foldName(m.name) === q);
}

/** The parenthetical shown after the name: MusicBrainz's disambiguation, if any. */
export function suggestionDetail(s: ArtistSuggestion): string | null {
  return s.disambiguation?.trim() || null;
}

/** Share requests for the same query across keystrokes; failed requests aren't kept. */
function memoize<T>(fn: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (key) => {
    const cached = cache.get(key);
    if (cached) return cached;
    const promise = fn(key);
    cache.set(key, promise);
    promise.catch(() => cache.delete(key));
    return promise;
  };
}

const searchDbMemo = memoize(async (key: string) => {
  const [query, limit] = JSON.parse(key) as [string, number];
  const { searchArtistsDb } = await import("../api/supabase");
  const rows = await searchArtistsDb(query, limit);
  return rows.map((r): ArtistMatch => ({
    id: r.id,
    name: r.name,
    type: r.type,
    ...(r.disambiguation ? { disambiguation: r.disambiguation } : {}),
  }));
});

const searchMusicBrainzMemo = memoize(async (query: string) => {
  const { searchArtistsPrefix } = await import("../api/musicbrainz");
  return searchArtistsPrefix(query, 25);
});

/** The app's real sources: Postgres (graph-neighbors search) and MusicBrainz. */
export const defaultSources: SuggestionSources = {
  searchDb: (query, limit) => searchDbMemo(JSON.stringify([query.trim().toLowerCase(), limit])),
  searchMusicBrainz: (query) => searchMusicBrainzMemo(query.trim().toLowerCase()),
};
