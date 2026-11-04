/**
 * Tiered GraphAccess (Option 4).
 *
 * The similarity scorer uses a SYNCHRONOUS `GraphAccess` (sql.js is sync). Tier-2
 * sources (Postgres edge function, MusicBrainz) are async, so we can't fetch
 * mid-scoring. Instead this module works in two phases:
 *
 *   1. `prepareArtists(artists)` — async. For each artist NOT in the core SQLite
 *      graph, fetch its node + 1-hop neighbors from Tier-2 and stash them in an
 *      in-memory overlay (also cached 24h in localStorage). Fallback chain:
 *        Tier 1: core SQLite (browser)      — instant, but limited coverage
 *        Tier 2: Postgres (graph-neighbors) — same coverage as SQLite today
 *        Tier 3: MusicBrainz (live)         — broad coverage, ~1 req/sec
 *        (Discogs — deferred, follow-up)
 *
 *   2. `build()` — returns a synchronous GraphAccess that reads the core graph
 *      first and falls back to the overlay. Safe to hand to `computeSimilarity`.
 *
 * Only out-of-core artists incur network cost; fully-covered lists stay instant.
 * Tier-2 returns a node + 1 hop, so multi-hop accuracy for out-of-core artists
 * is reduced by design (documented tradeoff; revisit later).
 */

import { refId, refName, type ArtistRef, type GraphAccess, type SimNode, type SimNeighbor } from "./similarity";
import { getCached, setCache } from "../api/cache";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** A resolved artist node plus its 1-hop neighbors, from any tier. */
interface Subgraph {
  node: SimNode;
  neighbors: SimNeighbor[];
}

/** Which tier answered — for debugging / metrics. */
export type Tier = "core" | "postgres" | "musicbrainz" | "miss";

/** An artist to fetch: by MusicBrainz ID when the user picked it, else by name. */
export interface ArtistLookup {
  name: string;
  id?: string;
}

/** Overlay/cache key: "mbid:<id>" for a picked artist, else the lowercased name. */
function lookupKey(ref: ArtistRef): string {
  const id = refId(ref);
  return id ? `mbid:${id}` : refName(ref).toLowerCase();
}

export class TieredGraphAccess {
  /** Overlay of nodes fetched from Tier 2/3, keyed by lookupKey (lowercased name or "mbid:<id>"). */
  private overlayByKey = new Map<string, Subgraph | null>();
  /** Overlay neighbors keyed by node id (so neighbors(id) can find them). */
  private overlayById = new Map<string, Subgraph>();
  /** In-flight resolutions, keyed by lookupKey, to dedupe concurrent fetches. */
  private inFlight = new Map<string, Promise<Tier>>();
  /** Keys Postgres missed while MusicBrainz was held back (`musicBrainz: false`): MusicBrainz can still be asked later. */
  private postgresMisses = new Set<string>();

  // Injected so this class stays testable without sql.js / real network.
  constructor(
    private core: GraphAccess,
    private fetchPostgres: (artist: ArtistLookup) => Promise<Subgraph | null>,
    private fetchMusicBrainz: (artist: ArtistLookup) => Promise<Subgraph | null>
  ) {}

  /**
   * Ensure each artist is resolvable synchronously afterwards. Artists already
   * in the core graph are skipped (no network). Returns which tier answered
   * each, keyed by its MusicBrainz ID when it has one, else by the name given.
   * Duplicates (same ID, or same name case-insensitively) are resolved once.
   *
   * `musicBrainz: false` stops at Postgres: MusicBrainz allows about one request
   * a second, so a caller with many artists (Discover's headliners) can resolve
   * what it can now and ask MusicBrainz for the rest later, a few at a time. An
   * artist missed that way isn't remembered as a miss, so a later call asks
   * MusicBrainz (and not Postgres again).
   */
  async prepareArtists(artists: ArtistRef[], { musicBrainz = true }: { musicBrainz?: boolean } = {}): Promise<Map<string, Tier>> {
    const tiers = new Map<string, Tier>();

    // Dedupe by key, keeping the first original spelling.
    const uniqueByKey = new Map<string, ArtistRef>();
    for (const ref of artists) {
      const key = lookupKey(ref);
      if (!uniqueByKey.has(key)) uniqueByKey.set(key, ref);
    }

    await Promise.all(
      [...uniqueByKey.values()].map(async (ref) => {
        const tier = await this.resolveOne(ref, musicBrainz);
        tiers.set(refId(ref) ?? refName(ref), tier);
      })
    );

    return tiers;
  }

  /** Whether the core graph has this artist (by ID when it has one). */
  private inCore(ref: ArtistRef): boolean {
    const id = refId(ref);
    if (id && this.core.findNodeById) return this.core.findNodeById(id) !== null;
    return this.core.findNodeByName(refName(ref)) !== null;
  }

  /** Resolve a single artist, sharing any in-flight resolution for the same key. */
  private resolveOne(ref: ArtistRef, musicBrainz = true): Promise<Tier> {
    const key = lookupKey(ref);

    // Tier 1: already in core graph?
    if (this.inCore(ref)) return Promise.resolve<Tier>("core");

    // Already resolved this session?
    if (this.overlayByKey.has(key)) {
      const sg = this.overlayByKey.get(key);
      return Promise.resolve<Tier>(sg ? "postgres" : "miss");
    }

    // Share an in-flight fetch for the same key (and if it held MusicBrainz back
    // and missed, ask MusicBrainz after it).
    const existing = this.inFlight.get(key);
    if (existing) {
      return musicBrainz
        ? existing.then((t) => (t === "miss" && this.postgresMisses.has(key) ? this.resolveOne(ref, true) : t))
        : existing;
    }

    // Postgres already missed it while MusicBrainz was held back
    if (this.postgresMisses.has(key) && !musicBrainz) return Promise.resolve<Tier>("miss");

    const id = refId(ref);
    const promise = this.fetchAndStore(key, { name: refName(ref), ...(id ? { id } : {}) }, musicBrainz);
    this.inFlight.set(key, promise);
    return promise;
  }

  private async fetchAndStore(key: string, artist: ArtistLookup, musicBrainz: boolean): Promise<Tier> {
    try {
      // 24h cache?
      const cached = getCached<Subgraph | null>(`tier2_${key}`, CACHE_TTL_MS);
      if (cached !== null) {
        this.storeOverlay(key, cached);
        return cached ? "postgres" : "miss";
      }

      // Tier 2: Postgres, then Tier 3: MusicBrainz.
      let sg: Subgraph | null = null;
      let tier: Tier = "miss";
      if (!this.postgresMisses.has(key)) {
        try {
          sg = await this.fetchPostgres(artist);
          if (sg) tier = "postgres";
        } catch { /* fall through */ }
      }

      if (!sg && !musicBrainz) {
        // Not remembered as a miss: MusicBrainz may still have it
        this.postgresMisses.add(key);
        return "miss";
      }

      if (!sg) {
        try {
          sg = await this.fetchMusicBrainz(artist);
          if (sg) tier = "musicbrainz";
        } catch { /* fall through */ }
      }

      this.postgresMisses.delete(key);
      this.storeOverlay(key, sg);
      setCache(`tier2_${key}`, sg);
      return tier;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private storeOverlay(key: string, sg: Subgraph | null): void {
    this.overlayByKey.set(key, sg);
    if (sg) {
      this.overlayById.set(sg.node.id, sg);
      // Neighbors may also be looked up by name during scoring.
      for (const nb of sg.neighbors) {
        const nbKey = nb.node.name.toLowerCase();
        if (!this.overlayByKey.has(nbKey) && !this.core.findNodeByName(nb.node.name)) {
          // Store a shallow entry so findNodeByName resolves it (no neighbors known).
          this.overlayById.set(nb.node.id, this.overlayById.get(nb.node.id) ?? { node: nb.node, neighbors: [] });
        }
      }
    }
  }

  /** A synchronous GraphAccess: core graph first, then the prefetched overlay. */
  build(): GraphAccess {
    return {
      findNodeByName: (name: string): SimNode | null => {
        const core = this.core.findNodeByName(name);
        if (core) return core;
        const sg = this.overlayByKey.get(name.toLowerCase());
        return sg ? sg.node : null;
      },
      findNodeById: (id: string): SimNode | null => {
        const core = this.core.findNodeById?.(id);
        if (core) return core;
        return this.overlayById.get(id)?.node ?? null;
      },
      degree: (nodeId: string, relType: string): number | undefined => {
        // The core graph counts every artist it has (an artist reached over a
        // relType link has at least 1); for one fetched from Postgres/MusicBrainz,
        // count the links that came with it.
        const core = this.core.degree?.(nodeId, relType);
        if (core) return core;
        const sg = this.overlayById.get(nodeId);
        if (!sg || sg.neighbors.length === 0) return undefined;
        return sg.neighbors.filter((n) => n.relType === relType).length;
      },
      neighbors: (nodeId: string): SimNeighbor[] => {
        const core = this.core.neighbors(nodeId);
        if (core.length > 0) return core;
        const sg = this.overlayById.get(nodeId);
        return sg ? sg.neighbors : [];
      },
    };
  }
}

// --- Real wiring (browser) --------------------------------------------------

/**
 * Build a TieredGraphAccess wired to the real core sql.js graph, the Postgres
 * graph-neighbors edge function, and the live MusicBrainz API.
 */
export async function buildTieredGraphAccess(): Promise<TieredGraphAccess> {
  const { buildGraphAccess } = await import("./graphAccess");
  const { isDbLoaded } = await import("../db/graphDb");
  // Core returns nothing until the background graph download finishes, so
  // lookups go to Postgres meanwhile.
  const core = buildGraphAccess();

  const fetchPostgres = async ({ name, id }: ArtistLookup): Promise<Subgraph | null> => {
    // While the local graph is still downloading, a miss here says nothing
    // about SQLite coverage, so don't record it in search_misses. Read before
    // any await: this runs in the same tick as the core-graph check.
    const logMiss = isDbLoaded();
    const { getGraphNeighbors } = await import("../api/supabase");
    const res = await getGraphNeighbors(id ? { mbid: id } : { name }, { logMiss });
    if (!res.found || !res.artist) return null;
    return {
      node: res.artist,
      neighbors: res.neighbors.map((n) => ({
        node: n.node,
        relType: n.relType,
        ...(n.outgoing !== undefined ? { outgoing: n.outgoing } : {}),
        ...(n.count !== undefined ? { count: n.count } : {}),
      })),
    };
  };

  const fetchMusicBrainz = async ({ name, id }: ArtistLookup): Promise<Subgraph | null> => {
    const { musicBrainzSubgraph } = await import("../api/musicbrainzSubgraph");
    return musicBrainzSubgraph({ name, id });
  };

  return new TieredGraphAccess(core, fetchPostgres, fetchMusicBrainz);
}
