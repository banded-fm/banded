import initSqlJs, { type SqlJsConfig } from "sql.js";
import { NotTheFile, downloadWithResume } from "./download";

// Use the proper type from our declaration
interface DB {
  run(sql: string, params?: unknown[]): unknown;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string): {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    get(): unknown[];
    getAsObject(): Record<string, unknown>;
    free(): void;
    reset(): void;
  };
  close(): void;
}

let db: DB | null = null;
let loadingPromise: Promise<DB> | null = null;

/**
 * Load the SQLite database from the public directory.
 * Returns the same instance if already loaded.
 */
export async function getDb(): Promise<DB> {
  if (db) return db;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    // Load sql.js WASM
    const wasmUrl = `${window.location.origin}${import.meta.env.BASE_URL}sql-wasm.wasm`;
    const config: SqlJsConfig = {
      locateFile: () => wasmUrl,
    };

    const SQL = await initSqlJs(config);

    // Fetch the database file (gzipped).
    //
    // Order of preference:
    //   1. Same-origin committed file (`<base>/graph.db.gz`) — fast, no CORS.
    //   2. CDN URL (Cloudflare R2) — fallback when the local file isn't
    //      available (fresh clone without a regen, or a host that can't serve
    //      the file such as Cloudflare's 25 MiB asset cap). The CDN URL comes
    //      from VITE_GRAPH_DB_URL if set, else a build-time default that is the
    //      R2 URL on Cloudflare builds (see vite.config.ts __GRAPH_DB_CDN_URL__).
    //
    // Locally this means dev uses your generated public/graph.db.gz when present
    // and transparently falls back to the CDN when it isn't.
    const localUrl = `${import.meta.env.BASE_URL}graph.db.gz`;
    const cdnUrl = import.meta.env.VITE_GRAPH_DB_URL || __GRAPH_DB_CDN_URL__;
    const candidates = [localUrl, cdnUrl].filter((u): u is string => Boolean(u));

    // A dropped connection is resumed rather than failing the whole download (see download.ts).
    let bytes: Uint8Array | null = null;
    const errors: string[] = [];
    for (const url of candidates) {
      try {
        bytes = await downloadWithResume(url);
        break;
      } catch (e) {
        // Not served here, or a network/CORS failure that retrying didn't fix — try the next candidate.
        errors.push(e instanceof NotTheFile ? e.message : `${url} → ${e instanceof Error ? e.message : "fetch failed"}`);
      }
    }

    if (!bytes) {
      throw new Error(
        "Graph database could not be loaded. Run 'python3 scripts/process_mb_dump.py' to generate " +
        "public/graph.db.gz, or set VITE_GRAPH_DB_URL to a reachable CDN URL. Tried: " +
        errors.join("; ")
      );
    }

    // Check if we need to manually decompress:
    // If Content-Encoding: gzip was set, browser already decompressed it.
    // If not (e.g., GitHub Pages / R2 raw bytes), detect gzip via magic number.
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      // Gzip magic number detected — need manual decompression. Only the
      // decompressed copy is kept, so a phone doesn't hold both at once.
      bytes = new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    }

    const instance = new SQL.Database(bytes);
    db = instance as unknown as DB;
    return db;
  })();

  // Let a later call retry after a failed download instead of reusing the rejection.
  loadingPromise.catch(() => {
    loadingPromise = null;
  });

  return loadingPromise;
}

/**
 * Start downloading the graph in the background without blocking anything.
 * Until it finishes, src/db/graphSource.ts answers lookups from Postgres.
 */
export function preloadDb(): void {
  getDb().catch(() => {
    /* lookups keep using the server; the next getDb() call retries */
  });
}

/**
 * Check if the database is loaded.
 */
export function isDbLoaded(): boolean {
  return db !== null;
}

// --- Query helpers ---

export interface NodeRecord {
  id: string;
  name: string;
  type: string;
}

export interface EdgeRecord {
  source: string;
  target: string;
  rel_type: string;
}

/**
 * Look up a node by name (case-insensitive).
 */
export function findNodeByName(name: string): NodeRecord | null {
  if (!db) return null;
  const stmt = db.prepare("SELECT id, name, type FROM nodes WHERE name = ? COLLATE NOCASE");
  stmt.bind([name]);
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as NodeRecord;
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

/**
 * Look up a node by ID.
 */
export function findNodeById(id: string): NodeRecord | null {
  if (!db) return null;
  const stmt = db.prepare("SELECT id, name, type FROM nodes WHERE id = ?");
  stmt.bind([id]);
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as NodeRecord;
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

type Statement = ReturnType<DB["prepare"]>;

/** Per-type link counts ("<id>|<rel_type>" -> count), worked out once per loaded DB and set of types. */
let relDegrees: { db: DB; key: string; counts: Map<string, number> } | null = null;

/**
 * How many `relType` links (either direction) the node has. Counted for all
 * nodes at once, the first time it's asked, for the given types only (one
 * query over their edges). Null while the graph hasn't loaded.
 */
export function getRelDegree(nodeId: string, relType: string, types: string[]): number | null {
  if (!db) return null;
  const key = [...types].sort().join(",");
  if (relDegrees?.db !== db || relDegrees.key !== key) {
    const counts = new Map<string, number>();
    const marks = types.map(() => "?").join(",");
    const rows = db.exec(
      `SELECT id, rel_type, COUNT(*) FROM (` +
        `SELECT source AS id, rel_type FROM edges WHERE rel_type IN (${marks}) ` +
        `UNION ALL SELECT target AS id, rel_type FROM edges WHERE rel_type IN (${marks})` +
        `) GROUP BY id, rel_type`,
      [...types, ...types]
    )[0]?.values ?? [];
    for (const [id, t, n] of rows) counts.set(`${id as string}|${t as string}`, n as number);
    relDegrees = { db, key, counts };
  }
  return relDegrees.counts.get(`${nodeId}|${relType}`) ?? 0;
}

/** getNeighbors' two queries, prepared once per loaded DB: the similarity search calls it thousands of times. */
let neighborStatements: { db: DB; out: Statement; in: Statement } | null = null;

/**
 * Get all neighbors of a node (both directions). `outgoing` says which way the
 * edge points: true when nodeId is its source. Most relationships read the same
 * either way; "opened_for" goes opener -> headliner. `count` is how often (song
 * credits for collaborations, shows for opened_for); absent for band edges and
 * in graphs built before edges had a count.
 */
export function getNeighbors(
  nodeId: string
): Array<{ node: NodeRecord; relType: string; outgoing: boolean; count?: number }> {
  if (!db) return [];
  if (neighborStatements?.db !== db) {
    const hasCount = db.exec("PRAGMA table_info(edges)")[0]?.values.some((r) => r[1] === "count") ?? false;
    const count = hasCount ? "e.count" : "NULL";
    neighborStatements = {
      db,
      // Edges where this node is the source / the target
      out: db.prepare(`SELECT n.id, n.name, n.type, e.rel_type, ${count} FROM edges e JOIN nodes n ON n.id = e.target WHERE e.source = ?`),
      in: db.prepare(`SELECT n.id, n.name, n.type, e.rel_type, ${count} FROM edges e JOIN nodes n ON n.id = e.source WHERE e.target = ?`),
    };
  }

  const results: Array<{ node: NodeRecord; relType: string; outgoing: boolean; count?: number }> = [];
  for (const [stmt, outgoing] of [[neighborStatements.out, true], [neighborStatements.in, false]] as const) {
    stmt.bind([nodeId]);
    while (stmt.step()) {
      const row = stmt.get();
      results.push({
        node: { id: row[0] as string, name: row[1] as string, type: row[2] as string },
        relType: row[3] as string,
        outgoing,
        ...(typeof row[4] === "number" ? { count: row[4] } : {}),
      });
    }
    stmt.reset();
  }
  return results;
}

/**
 * BFS shortest path between two nodes.
 * Returns the path as an array of node IDs (including start and end), or null if no path.
 */
export function bfsShortestPath(startId: string, endId: string, maxDepth = 10, allowedRelTypes?: Set<string>): string[] | null {
  if (!db) return null;
  if (startId === endId) return [startId];

  const visited = new Set<string>([startId]);
  const parent = new Map<string, string>();
  let frontier = [startId];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const nodeId of frontier) {
      const neighbors = getNeighborIds(nodeId, allowedRelTypes);
      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        parent.set(neighborId, nodeId);

        if (neighborId === endId) {
          // Reconstruct path
          const path: string[] = [endId];
          let current = endId;
          while (current !== startId) {
            current = parent.get(current)!;
            path.unshift(current);
          }
          return path;
        }

        nextFrontier.push(neighborId);
      }
    }

    frontier = nextFrontier;
  }

  return null;
}

/**
 * Get neighbor IDs only (faster than full node lookup, for BFS).
 * Skips album nodes with more than MAX_ALBUM_DEGREE connections (likely compilations).
 */
const MAX_ALBUM_DEGREE = 25;
const albumDegreeCache = new Map<string, number>();

function getAlbumDegree(nodeId: string): number {
  const cached = albumDegreeCache.get(nodeId);
  if (cached !== undefined) return cached;
  if (!db) return 0;

  const result = db.exec(
    "SELECT COUNT(*) FROM edges WHERE target = ? OR source = ?",
    [nodeId, nodeId]
  );
  const count = result.length > 0 ? (result[0]!.values[0]![0] as number) : 0;
  albumDegreeCache.set(nodeId, count);
  return count;
}

function isCompilation(nodeId: string): boolean {
  if (!db) return false;
  // Check if it's an album node
  const stmt = db.prepare("SELECT type FROM nodes WHERE id = ?");
  stmt.bind([nodeId]);
  let nodeType = "";
  if (stmt.step()) {
    nodeType = stmt.get()[0] as string;
  }
  stmt.free();

  if (nodeType !== "album") return false;
  return getAlbumDegree(nodeId) > MAX_ALBUM_DEGREE;
}

function getNeighborIds(nodeId: string, allowedRelTypes?: Set<string>): string[] {
  if (!db) return [];
  const ids: string[] = [];

  const stmt1 = db.prepare("SELECT target, rel_type FROM edges WHERE source = ?");
  stmt1.bind([nodeId]);
  while (stmt1.step()) {
    const id = stmt1.get()[0] as string;
    const relType = stmt1.get()[1] as string;
    if (allowedRelTypes && !allowedRelTypes.has(relType)) continue;
    if (!isCompilation(id)) {
      ids.push(id);
    }
  }
  stmt1.free();

  const stmt2 = db.prepare("SELECT source, rel_type FROM edges WHERE target = ?");
  stmt2.bind([nodeId]);
  while (stmt2.step()) {
    const id = stmt2.get()[0] as string;
    const relType = stmt2.get()[1] as string;
    if (allowedRelTypes && !allowedRelTypes.has(relType)) continue;
    if (!isCompilation(id)) {
      ids.push(id);
    }
  }
  stmt2.free();

  return ids;
}

/**
 * Search nodes by name (partial match).
 */
export function searchNodes(query: string, limit = 10): NodeRecord[] {
  if (!db) return [];
  const results = db.exec(
    "SELECT id, name, type FROM nodes WHERE name LIKE ? COLLATE NOCASE LIMIT ?",
    [`%${query}%`, limit]
  );
  if (results.length === 0) return [];
  return results[0]!.values.map((row) => ({
    id: row[0] as string,
    name: row[1] as string,
    type: row[2] as string,
  }));
}

export interface ArtistMatch extends NodeRecord {
  /** MusicBrainz disambiguation comment, if the graph has that column. */
  disambiguation?: string;
  /** Begin area (often a city) or area, if the graph has that column. */
  area?: string;
}

let detailColumns: { disambiguation: boolean; area: boolean; genres: boolean } | null = null;

/** Whether the loaded graph stores disambiguation/area (graphs from newer pipeline runs). */
export function hasDetailColumns(): boolean {
  if (!db) return false;
  const cols = getDetailColumns();
  return cols.disambiguation || cols.area;
}

/** Which optional detail columns this graph's nodes table has (added by newer pipeline runs). */
function getDetailColumns(): { disambiguation: boolean; area: boolean; genres: boolean } {
  if (detailColumns) return detailColumns;
  const cols = new Set<string>();
  const res = db!.exec("PRAGMA table_info(nodes)");
  for (const row of res[0]?.values ?? []) cols.add(row[1] as string);
  const genreTable = db!.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'genres'").length > 0;
  detailColumns = { disambiguation: cols.has("disambiguation"), area: cols.has("area"),
                    genres: cols.has("genres") && genreTable };
  return detailColumns;
}

export interface ArtistDetails {
  /** MusicBrainz disambiguation comment. */
  disambiguation?: string;
  /** MusicBrainz genres, most voted first (2+ votes; top 3 plus ties). Empty when none. */
  genres: string[];
}

let genreNames: Map<number, string> | null = null;

/**
 * What the info panel shows about an artist beyond its name, from the local
 * graph. Null when the graph hasn't loaded or doesn't have the artist; a graph
 * built before the genre columns existed gives no genres.
 */
export function getArtistDetails(id: string): ArtistDetails | null {
  if (!db) return null;
  const cols = getDetailColumns();
  const stmt = db.prepare(
    `SELECT ${cols.disambiguation ? "disambiguation" : "NULL"}, ${cols.genres ? "genres" : "NULL"} FROM nodes WHERE id = ?`
  );
  stmt.bind([id]);
  const row = stmt.step() ? stmt.get() : null;
  stmt.free();
  if (!row) return null;
  if (cols.genres && !genreNames) {
    genreNames = new Map((db.exec("SELECT id, name FROM genres")[0]?.values ?? []).map((r) => [r[0] as number, r[1] as string]));
  }
  const genres = typeof row[1] === "string" && row[1]
    ? row[1].split(",").map((g) => genreNames?.get(Number(g))).filter((g): g is string => Boolean(g))
    : [];
  return { ...(row[0] ? { disambiguation: row[0] as string } : {}), genres };
}

/**
 * Search-as-you-type artist lookup (persons and groups, no albums). Ranks an
 * exact name first, then names starting with the query, then names with a
 * word starting with it, then any substring match; shorter names first within
 * each rank.
 */
export function searchArtists(query: string, limit = 10): ArtistMatch[] {
  const q = query.trim();
  if (!db || !q) return [];
  const cols = getDetailColumns();
  const like = q.replace(/[\\%_]/g, "\\$&");
  const select = [
    "id", "name", "type",
    cols.disambiguation ? "disambiguation" : "NULL",
    cols.area ? "area" : "NULL",
  ].join(", ");
  const results = db.exec(
    `SELECT ${select} FROM nodes
     WHERE type != 'album' AND name LIKE ? ESCAPE '\\'
     ORDER BY CASE
       WHEN name = ? COLLATE NOCASE THEN 0
       WHEN name LIKE ? ESCAPE '\\' THEN 1
       WHEN name LIKE ? ESCAPE '\\' THEN 2
       ELSE 3 END, length(name), name
     LIMIT ?`,
    [`%${like}%`, q, `${like}%`, `% ${like}%`, limit]
  );
  if (results.length === 0) return [];
  return results[0]!.values.map((row) => ({
    id: row[0] as string,
    name: row[1] as string,
    type: row[2] as string,
    ...(row[3] ? { disambiguation: row[3] as string } : {}),
    ...(row[4] ? { area: row[4] as string } : {}),
  }));
}
