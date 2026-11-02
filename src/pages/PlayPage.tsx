import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { GAME_ARTISTS, type GameArtist } from "../game/artists";
import { getDb, isDbLoaded, findNodeByName, bfsShortestPath, findNodeById, getNeighbors } from "../db/graphDb";
import { DebugConsole } from "../components/DebugConsole";
import { ArtistAutocomplete } from "../components/ArtistAutocomplete";
import { debugLog } from "../debug/DebugLog";

/** Only these relationship types are used in the game */
const GAME_REL_TYPES = new Set(["member_of", "former_member_of", "support_musician"]);

/**
 * "loading": the game isn't known yet (a random game needs the graph to find a
 * path). Its start/end may already be known (a shared link to curated artists),
 * and show while the rest loads. "playing" can start before the graph has
 * downloaded (a saved game): only the list of moves waits for it.
 */
interface GameState {
  status: "loading" | "error" | "playing";
  error?: string;
  startArtist?: GameArtist;
  endArtist?: GameArtist;
  startId?: string;
  endId?: string;
  shortestPath?: string[];
  par?: number;
  guesses: string[];
  revealed: boolean;
}

const GAME_STORAGE_KEY = "banded_current_game";
const GAME_TTL_MS = 24 * 60 * 60 * 1000;

interface StoredGame {
  startArtist: GameArtist;
  endArtist: GameArtist;
  startId: string;
  endId: string;
  shortestPath: string[];
  par: number;
  guesses: string[];
  revealed: boolean;
  timestamp: number;
}

function saveGame(state: StoredGame): void {
  try {
    localStorage.setItem(GAME_STORAGE_KEY, JSON.stringify(state));
  } catch { /* full */ }
}

function loadGame(): StoredGame | null {
  const raw = localStorage.getItem(GAME_STORAGE_KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredGame;
    if (Date.now() - stored.timestamp > GAME_TTL_MS) {
      localStorage.removeItem(GAME_STORAGE_KEY);
      return null;
    }
    return stored;
  } catch {
    localStorage.removeItem(GAME_STORAGE_KEY);
    return null;
  }
}

function clearGame(): void {
  localStorage.removeItem(GAME_STORAGE_KEY);
}

function playing(game: StoredGame): GameState {
  return {
    status: "playing",
    startArtist: game.startArtist,
    endArtist: game.endArtist,
    startId: game.startId,
    endId: game.endId,
    shortestPath: game.shortestPath,
    par: game.par,
    guesses: game.guesses,
    revealed: game.revealed,
  };
}

const curatedById = (mbid: string) => GAME_ARTISTS.find((a) => a.mbid === mbid);

/**
 * What can be shown before the graph has downloaded: a saved game in full, or a
 * shared link's start and end (their names when they are curated artists).
 */
function initialState(params: URLSearchParams): GameState {
  const start = params.get("start");
  const end = params.get("end");
  if (start && end) {
    const saved = loadGame();
    if (saved && saved.startId === start && saved.endId === end) return playing(saved);   // reload mid-game
    return { status: "loading", startId: start, endId: end, startArtist: curatedById(start),
             endArtist: curatedById(end), guesses: [], revealed: false };
  }
  const saved = loadGame();
  return saved ? playing(saved) : { status: "loading", guesses: [], revealed: false };
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * Generate a game: pick two artists of the same type, find shortest path,
 * re-roll if distance < 3.
 */
async function generateGame(): Promise<StoredGame | null> {
  await getDb();

  for (let attempt = 0; attempt < 20; attempt++) {
    // Pick a type (person or group)
    const type = Math.random() < 0.5 ? "person" : "group";
    const pool = GAME_ARTISTS.filter((a) => a.type === type);

    const startArtist = pickRandom(pool);
    let endArtist = pickRandom(pool);
    while (endArtist.mbid === startArtist.mbid) {
      endArtist = pickRandom(pool);
    }

    // Resolve by MusicBrainz ID (names can be ambiguous or out of date)
    const startNode = findNodeById(startArtist.mbid);
    const endNode = findNodeById(endArtist.mbid);

    if (!startNode || !endNode) {
      debugLog.log(`Game: could not resolve "${startArtist.name}" or "${endArtist.name}" in DB`);
      continue;
    }

    // Find shortest path
    debugLog.log(`Game: BFS from "${startArtist.name}" to "${endArtist.name}"...`);
    const path = bfsShortestPath(startNode.id, endNode.id, 10, GAME_REL_TYPES);

    if (!path) {
      debugLog.log(`Game: no path found, retrying`);
      continue;
    }

    if (path.length < 4) {
      // Distance < 3 hops (path includes start+end, so length 4 = 3 hops)
      debugLog.log(`Game: path too short (${path.length - 1} hops), retrying`);
      continue;
    }

    const par = path.length; // shortest path length = number of nodes. Par = shortest + 1 step for the player
    debugLog.log(`Game: found path of length ${path.length - 1} hops, par = ${par}`);

    const stored: StoredGame = {
      startArtist,
      endArtist,
      startId: startNode.id,
      endId: endNode.id,
      shortestPath: path,
      par,
      guesses: [],
      revealed: false,
      timestamp: Date.now(),
    };
    saveGame(stored);
    return stored;
  }

  return null;
}
/**
 * Build a game from two resolved nodes. Validates path existence.
 * Note: start and end do NOT need to be the same type (a person can be
 * connected to a band). Same-type matching is only enforced for the
 * auto-generated random games.
 */
function buildGameFromNodes(
  startNode: { id: string; name: string; type: string },
  endNode: { id: string; name: string; type: string }
): { game: StoredGame } | { error: string } {
  if (startNode.id === endNode.id) {
    return { error: "Start and end must be different." };
  }

  const path = bfsShortestPath(startNode.id, endNode.id, 12, GAME_REL_TYPES);
  if (!path) {
    return { error: `No path exists between "${startNode.name}" and "${endNode.name}".` };
  }

  const startType: GameArtist["type"] = startNode.type === "group" ? "group" : "person";
  const endType: GameArtist["type"] = endNode.type === "group" ? "group" : "person";
  const game: StoredGame = {
    startArtist: { name: startNode.name, type: startType, mbid: startNode.id },
    endArtist: { name: endNode.name, type: endType, mbid: endNode.id },
    startId: startNode.id,
    endId: endNode.id,
    shortestPath: path,
    par: path.length,
    guesses: [],
    revealed: false,
    timestamp: Date.now(),
  };
  saveGame(game);
  return { game };
}

/** An artist picked from a dropdown: its exact node, while the input still shows its name. */
interface Pick {
  id: string;
  name: string;
}

/**
 * Generate a game from user-provided start and end artist names. A dropdown
 * pick whose name still matches the input resolves by MBID (same-name artists).
 */
async function generateCustomGame(
  startName: string,
  endName: string,
  startPick: Pick | null,
  endPick: Pick | null
): Promise<{ game: StoredGame } | { error: string }> {
  await getDb();

  const lookup = (name: string, pick: Pick | null) =>
    pick && pick.name === name ? findNodeById(pick.id) : findNodeByName(name);

  const startNode = lookup(startName, startPick);
  if (!startNode) return { error: `"${startName}" was not found.` };

  const endNode = lookup(endName, endPick);
  if (!endNode) return { error: `"${endName}" was not found.` };

  return buildGameFromNodes(startNode, endNode);
}

/**
 * Generate a game from start and end MBIDs (used for sharing — precise, no name ambiguity).
 */
async function generateGameFromIds(
  startId: string,
  endId: string
): Promise<{ game: StoredGame } | { error: string }> {
  await getDb();

  const startNode = findNodeById(startId);
  if (!startNode) return { error: `Start artist not found (${startId}).` };

  const endNode = findNodeById(endId);
  if (!endNode) return { error: `End artist not found (${endId}).` };

  return buildGameFromNodes(startNode, endNode);
}

function relTypePriority(relType: string): number {
  switch (relType) {
    case "member_of": return 0;
    case "former_member_of": return 1;
    case "album_by": return 2;
    case "support_musician": return 3;
    case "vocal": return 4;
    case "instrument": return 5;
    case "producer": return 6;
    case "mix": return 7;
    case "engineer": return 8;
    case "recording": return 9;
    default: return 10;
  }
}

function formatRelType(relType: string, nodeType: string): string {
  switch (relType) {
    case "member_of": return nodeType === "group" ? "group" : "member";
    case "former_member_of": return nodeType === "group" ? "former group" : "former member";
    case "support_musician": return nodeType === "group" ? "supported" : "support musician";
    case "producer": return "producer";
    case "vocal": return "vocals";
    case "instrument": return "instrument";
    case "mix": return "mix";
    case "engineer": return "engineer";
    case "recording": return "recording";
    case "album_by": return "album by";
    default: return relType.replace(/_/g, " ");
  }
}

export function PlayPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<GameState>(() => initialState(searchParams));
  // The graph (~47 MB) downloads in the background; the page doesn't wait for it.
  const [dbReady, setDbReady] = useState(isDbLoaded);
  const [input, setInput] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [customStartPick, setCustomStartPick] = useState<Pick | null>(null);
  const [customEndPick, setCustomEndPick] = useState<Pick | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [customLoading, setCustomLoading] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);

  // Compute current node: last guess resolved to ID, or start node
  const currentNodeId = (() => {
    if (state.status !== "playing") return null;
    if (state.guesses.length === 0) return state.startId!;
    const lastGuess = state.guesses[state.guesses.length - 1]!;
    const node = findNodeByName(lastGuess);
    return node?.id ?? null;
  })();

  // Build set of already-visited node IDs (start + all guesses)
  const visitedIds = (() => {
    if (state.status !== "playing") return new Set<string>();
    const ids = new Set<string>();
    ids.add(state.startId!);
    for (const guess of state.guesses) {
      const node = findNodeByName(guess);
      if (node) ids.add(node.id);
    }
    return ids;
  })();

  // Get valid next moves (neighbors of current node, excluding already-visited and compilations)
  const validMoves = (() => {
    if (!currentNodeId) return [];
    const neighbors = getNeighbors(currentNodeId);
    return neighbors
      .filter((n) => !visitedIds.has(n.node.id))
      .filter((n) => GAME_REL_TYPES.has(n.relType))
      .map((n) => ({ id: n.node.id, name: n.node.name, type: n.node.type, relType: n.relType }))
      .filter((n, i, arr) => arr.findIndex((x) => x.id === n.id) === i) // dedupe
      .sort((a, b) => {
        // Sort by relationship priority first, then alphabetically
        const priority = relTypePriority(a.relType) - relTypePriority(b.relType);
        if (priority !== 0) return priority;
        return a.name.localeCompare(b.name);
      });
  })();

  // Filter valid moves by input text
  const filteredMoves = input.trim()
    ? validMoves.filter((m) => m.name.toLowerCase().includes(input.toLowerCase()))
    : validMoves;

  const startNewGame = useCallback(async () => {
    clearGame();
    setState({ status: "loading", guesses: [], revealed: false });
    const game = await generateGame();
    if (game) {
      setSearchParams({ start: game.startId, end: game.endId }, { replace: true });
      setState(playing(game));
    } else {
      setState({ status: "error", error: "Could not generate a game. Is graph.db loaded?", guesses: [], revealed: false });
    }
  }, [setSearchParams]);

  const handleStartCustomGame = useCallback(async () => {
    const start = customStart.trim();
    const end = customEnd.trim();
    if (!start || !end) {
      setCustomError("Enter both a start and an end.");
      return;
    }
    setCustomLoading(true);
    setCustomError(null);
    clearGame();
    const result = await generateCustomGame(start, end, customStartPick, customEndPick);
    setCustomLoading(false);
    if ("error" in result) {
      setCustomError(result.error);
      return;
    }
    const { game } = result;
    setShowCustom(false);
    setCustomStart("");
    setCustomEnd("");
    setCustomStartPick(null);
    setCustomEndPick(null);
    setInput("");
    setSearchParams({ start: game.startId, end: game.endId }, { replace: true });
    setState(playing(game));
  }, [customStart, customEnd, customStartPick, customEndPick, setSearchParams]);

  const handleShare = useCallback(() => {
    if (!state.startId || !state.endId) return;
    const url = new URL(window.location.href);
    const params = new URLSearchParams({
      start: state.startId!,
      end: state.endId!,
    });
    url.hash = `#/play?${params.toString()}`;
    const shareUrl = url.toString();

    const done = () => {
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(shareUrl).then(done).catch(done);
    } else {
      done();
    }
  }, [state]);

  // Download the graph, then finish whatever the first render couldn't: a shared
  // game's path, or a new random game. A saved game is already playing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await getDb();
      } catch (e) {
        if (!cancelled) setState({ status: "error", error: e instanceof Error ? e.message : "Failed to load database", guesses: [], revealed: false });
        return;
      }
      if (cancelled) return;
      setDbReady(true);
      const initial = initialState(searchParams);
      if (initial.status === "playing") return;

      // 1. Shared game via URL params (?start=<mbid>&end=<mbid>) takes priority
      if (initial.startId && initial.endId) {
        clearGame();
        const result = await generateGameFromIds(initial.startId, initial.endId);
        if (cancelled) return;
        if ("game" in result) {
          setState(playing(result.game));
          return;
        }
        // If the shared game is invalid, fall through to a random game
        debugLog.log(`Shared game invalid: ${result.error}`);
        setState({ status: "loading", guesses: [], revealed: false });
      }

      // 2. A new random game
      const game = await generateGame();
      if (cancelled) return;
      if (game) {
        setSearchParams({ start: game.startId, end: game.endId }, { replace: true });
        setState(playing(game));
      } else {
        setState({ status: "error", error: "Could not generate a game.", guesses: [], revealed: false });
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGuess = (name?: string) => {
    const guess = name ?? input.trim();
    if (!guess || state.status !== "playing") return;
    const newGuesses = [...state.guesses, guess];
    setInput("");

    const newState = { ...state, guesses: newGuesses };
    setState(newState);
    saveGame({
      startArtist: state.startArtist!,
      endArtist: state.endArtist!,
      startId: state.startId!,
      endId: state.endId!,
      shortestPath: state.shortestPath!,
      par: state.par!,
      guesses: newGuesses,
      revealed: state.revealed,
      timestamp: Date.now(),
    });
  };

  const handleUndo = () => {
    if (state.status !== "playing" || state.guesses.length === 0) return;
    const newGuesses = state.guesses.slice(0, -1);
    setInput("");
    const newState = { ...state, guesses: newGuesses };
    setState(newState);
    saveGame({
      startArtist: state.startArtist!,
      endArtist: state.endArtist!,
      startId: state.startId!,
      endId: state.endId!,
      shortestPath: state.shortestPath!,
      par: state.par!,
      guesses: newGuesses,
      revealed: state.revealed,
      timestamp: Date.now(),
    });
  };

  const handleReveal = () => {
    if (state.status !== "playing") return;
    const newState = { ...state, revealed: true };
    setState(newState);
    saveGame({
      startArtist: state.startArtist!,
      endArtist: state.endArtist!,
      startId: state.startId!,
      endId: state.endId!,
      shortestPath: state.shortestPath!,
      par: state.par!,
      guesses: state.guesses,
      revealed: true,
      timestamp: Date.now(),
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleGuess();
  };

  return (
    <div style={styles.page}>
      <DebugConsole />
      <div className="page-container" style={styles.container}>
        <div style={styles.header}>
          <h1 className="page-title" style={styles.title}>Six Degrees of Music</h1>
          <p style={styles.subtitle}>
            Connect these two {state.startArtist?.type === "group" ? "groups" : "artists"} through the shortest path.
          </p>
        </div>

        {state.status === "error" && (
          <div style={styles.card}>
            <p style={styles.errorText}>{state.error}</p>
            <button onClick={startNewGame} style={styles.newGameBtn}>Try Again</button>
          </div>
        )}

        {state.status !== "error" && (
          <div className="endpoints-card" style={styles.endpointsCard} aria-busy={state.status === "loading"}>
            <div style={styles.endpoint}>
              <span style={styles.endpointLabel}>Start</span>
              {state.startArtist
                ? <span className="endpoint-name" style={styles.endpointName}>{state.startArtist.name}</span>
                : <span className="skeleton skeleton-name" aria-label="Picking the start…" />}
            </div>
            {state.par != null
              ? <div style={styles.parBadge}>Par {state.par}</div>
              : <span className="skeleton skeleton-par" aria-hidden="true" />}
            <div style={styles.endpoint}>
              <span style={styles.endpointLabel}>End</span>
              {state.endArtist
                ? <span className="endpoint-name" style={styles.endpointName}>{state.endArtist.name}</span>
                : <span className="skeleton skeleton-name" aria-label="Picking the end…" />}
            </div>
          </div>
        )}

        {(state.status === "loading" || (state.status === "playing" && !dbReady)) && (
          <div style={styles.inputSection}>
            <div className="moves-list" style={styles.movesList} aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="move-item" style={styles.moveItem}>
                  <span className="skeleton skeleton-move" />
                </div>
              ))}
            </div>
            <p style={styles.hint}>
              {dbReady
                ? "Finding a path…"
                : "Loading the music graph (~47 MB, downloaded once in the background)…"}
            </p>
          </div>
        )}

        {state.status !== "error" && (
          <>
            {state.status === "playing" && dbReady && (<>
            {!state.revealed && (
              <div style={styles.inputSection}>
                <div style={styles.guessList}>
                  <span style={styles.guessChip}>{state.startArtist!.name}</span>
                  {state.guesses.map((g, i) => (
                    <span key={i} style={styles.guessStep}>
                      <span style={styles.chainArrow}>→</span>
                      <span style={i === state.guesses.length - 1 ? styles.guessChipCurrent : styles.guessChip}>{g}</span>
                    </span>
                  ))}
                  <span style={styles.chainArrow}>→ ?</span>
                </div>
                <div style={styles.pathActions}>
                  <span style={styles.stepCount}>{state.guesses.length} steps</span>
                  {state.guesses.length > 0 && (
                    <button onClick={handleUndo} style={styles.undoBtn}>
                      ← Undo
                    </button>
                  )}
                </div>
                <div style={styles.inputRow}>
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Filter connections…"
                    style={styles.input}
                    aria-label="Filter connections"
                  />
                </div>
                <div className="moves-list" style={styles.movesList}>
                  {filteredMoves.length > 0 ? (
                    filteredMoves.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => handleGuess(m.name)}
                        className="move-item"
                        style={styles.moveItem}
                      >
                        <span style={styles.moveName}>{m.name}</span>
                        <span style={styles.moveRel}>{formatRelType(m.relType, m.type)}</span>
                      </button>
                    ))
                  ) : (
                    <p style={styles.noMoves}>No matching connections</p>
                  )}
                </div>
                <button onClick={handleReveal} style={styles.revealBtn}>
                  Reveal Shortest Path
                </button>
              </div>
            )}

            {state.revealed && (
              <div style={styles.revealSection}>
                <p style={styles.revealLabel}>Shortest path ({state.shortestPath!.length - 1} hops):</p>
                <div style={styles.chainDisplay}>
                  {state.shortestPath!.map((nodeId, i) => {
                    const node = findNodeById(nodeId);
                    return (
                      <span key={nodeId} style={styles.chainItem}>
                        <span style={node?.type === "person" ? styles.personChip : node?.type === "group" ? styles.bandChip : styles.albumChip}>
                          {node?.name ?? nodeId}
                        </span>
                        {i < state.shortestPath!.length - 1 && <span style={styles.chainArrow}>→</span>}
                      </span>
                    );
                  })}
                </div>
                {state.guesses.length > 0 && (
                  <div style={styles.guessList}>
                    <p style={styles.guessLabel}>Your path ({state.guesses.length + 2} steps):</p>
                    <span style={styles.guessChip}>{state.startArtist!.name}</span>
                    <span style={styles.chainArrow}>→</span>
                    {state.guesses.map((g, i) => (
                      <span key={i}>
                        <span style={styles.guessChip}>{g}</span>
                        <span style={styles.chainArrow}>→</span>
                      </span>
                    ))}
                    <span style={styles.guessChip}>{state.endArtist!.name}</span>
                  </div>
                )}
              </div>
            )}

            </>)}

            <div className="game-buttons" style={styles.gameButtons}>
              <button onClick={startNewGame} disabled={state.status === "loading"} style={styles.newGameBtn}>
                New Game
              </button>
              <button onClick={() => { setShowCustom((s) => !s); setCustomError(null); }} style={styles.customBtn}>
                Custom Game
              </button>
              <button onClick={handleShare} disabled={!state.startId || !state.endId} style={styles.shareBtn}>
                {shareCopied ? "Copied!" : "Share"}
              </button>
            </div>

            {showCustom && (
              <div style={styles.customForm}>
                <p style={styles.customHint}>
                  Pick your own start and end — any two artists or groups that are connected.
                </p>
                <ArtistAutocomplete
                  value={customStart}
                  onChange={setCustomStart}
                  onSelect={(s) => {
                    setCustomStart(s.name);
                    setCustomStartPick({ id: s.id, name: s.name });
                  }}
                  placeholder="Start artist or group"
                  inputStyle={styles.input}
                  ariaLabel="Start artist"
                />
                <ArtistAutocomplete
                  value={customEnd}
                  onChange={setCustomEnd}
                  onSelect={(s) => {
                    setCustomEnd(s.name);
                    setCustomEndPick({ id: s.id, name: s.name });
                  }}
                  placeholder="End artist or group"
                  inputStyle={styles.input}
                  ariaLabel="End artist"
                />
                {customError && <p style={styles.customError}>{customError}</p>}
                <button
                  onClick={handleStartCustomGame}
                  disabled={customLoading || !customStart.trim() || !customEnd.trim()}
                  style={styles.newGameBtn}
                >
                  {customLoading ? "Checking…" : "Start"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  container: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "1.5rem", overflowY: "auto", gap: "1rem" },
  header: { textAlign: "center" },
  title: { fontSize: "1.6rem", fontWeight: 700, color: "#e0e0e0", marginBottom: "0.25rem" },
  subtitle: { color: "#888", fontSize: "0.9rem" },
  card: { background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "2rem", textAlign: "center" },
  loadingText: { color: "#e0e0e0", fontSize: "1rem", marginBottom: "0.5rem" },
  hint: { color: "#666", fontSize: "0.8rem" },
  errorText: { color: "#ff6b6b", marginBottom: "1rem" },
  endpointsCard: { display: "flex", alignItems: "center", gap: "1rem", background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "1.25rem 1.5rem", flexWrap: "wrap", justifyContent: "center" },
  endpoint: { display: "flex", flexDirection: "column", alignItems: "center", gap: "0.25rem" },
  endpointLabel: { fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#888" },
  endpointName: { fontSize: "1.2rem", fontWeight: 700, color: "#feca57" },
  parBadge: { background: "#2a2a2a", color: "#55efc4", padding: "0.3rem 0.8rem", borderRadius: "12px", fontSize: "0.85rem", fontWeight: 600 },
  inputSection: { display: "flex", flexDirection: "column", alignItems: "center", gap: "0.75rem", width: "100%", maxWidth: "400px" },
  inputLabel: { color: "#aaa", fontSize: "0.85rem" },
  inputRow: { display: "flex", gap: "0.5rem", width: "100%" },
  input: { flex: 1, padding: "0.5rem 0.75rem", borderRadius: "4px", border: "1px solid #444", background: "#2a2a2a", color: "#e0e0e0", fontSize: "16px" },
  guessBtn: { padding: "0.5rem 1rem", borderRadius: "4px", border: "none", background: "#feca57", color: "#000", fontWeight: 600, cursor: "pointer" },
  movesList: { width: "100%", background: "#1a1a1a", border: "1px solid #333", borderRadius: "4px", maxHeight: "250px", overflowY: "auto" },
  moveItem: { display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "0.5rem 0.75rem", background: "none", border: "none", borderBottom: "1px solid #2a2a2a", color: "#e0e0e0", cursor: "pointer", fontSize: "0.85rem", textAlign: "left" },
  moveName: { flex: 1 },
  moveRel: { color: "#666", fontSize: "0.7rem", marginLeft: "0.5rem", whiteSpace: "nowrap" },
  noMoves: { color: "#666", fontSize: "0.8rem", padding: "0.75rem", textAlign: "center" },
  guessList: { display: "flex", flexWrap: "wrap", gap: "0.25rem", alignItems: "center" },
  guessStep: { display: "flex", alignItems: "center", gap: "0.25rem" },
  guessLabel: { color: "#888", fontSize: "0.8rem", width: "100%", marginBottom: "0.25rem" },
  guessChip: { padding: "0.2rem 0.6rem", borderRadius: "12px", fontSize: "0.8rem", background: "#2a2a2a", color: "#e0e0e0", border: "1px solid #444" },
  guessChipCurrent: { padding: "0.2rem 0.6rem", borderRadius: "12px", fontSize: "0.8rem", background: "#2a2a2a", color: "#feca57", border: "1px solid #feca57" },
  chainArrow: { color: "#555", fontSize: "0.8rem" },
  revealBtn: { padding: "0.5rem 1rem", borderRadius: "4px", border: "1px solid #444", background: "transparent", color: "#888", cursor: "pointer", fontSize: "0.85rem" },
  pathActions: { display: "flex", alignItems: "center", gap: "0.75rem" },
  stepCount: { color: "#888", fontSize: "0.8rem" },
  undoBtn: { padding: "0.3rem 0.75rem", borderRadius: "4px", border: "1px solid #feca57", background: "transparent", color: "#feca57", cursor: "pointer", fontSize: "0.8rem", fontWeight: 600 },
  revealSection: { display: "flex", flexDirection: "column", alignItems: "center", gap: "0.75rem" },
  revealLabel: { color: "#55efc4", fontWeight: 600, fontSize: "0.9rem" },
  chainDisplay: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: "0.25rem" },
  chainItem: { display: "flex", alignItems: "center", gap: "0.25rem" },
  personChip: { padding: "0.3rem 0.7rem", borderRadius: "12px", fontSize: "0.85rem", background: "rgba(254, 202, 87, 0.15)", color: "#feca57", border: "1px solid #feca57" },
  bandChip: { padding: "0.3rem 0.7rem", borderRadius: "12px", fontSize: "0.85rem", background: "rgba(255, 107, 107, 0.15)", color: "#ff6b6b", border: "1px solid #ff6b6b" },
  albumChip: { padding: "0.3rem 0.7rem", borderRadius: "12px", fontSize: "0.85rem", background: "rgba(85, 239, 196, 0.15)", color: "#55efc4", border: "1px solid #55efc4" },
  newGameBtn: { padding: "0.6rem 1.25rem", borderRadius: "4px", border: "none", background: "#ff6b6b", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: "0.9rem", marginTop: "0.5rem" },
  gameButtons: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "0.5rem", marginTop: "0.5rem" },
  customBtn: { padding: "0.6rem 1.25rem", borderRadius: "4px", border: "1px solid #48dbfb", background: "transparent", color: "#48dbfb", fontWeight: 600, cursor: "pointer", fontSize: "0.9rem", marginTop: "0.5rem" },
  shareBtn: { padding: "0.6rem 1.25rem", borderRadius: "4px", border: "1px solid #55efc4", background: "transparent", color: "#55efc4", fontWeight: 600, cursor: "pointer", fontSize: "0.9rem", marginTop: "0.5rem" },
  customForm: { display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%", maxWidth: "400px", background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "1rem" },
  customHint: { color: "#888", fontSize: "0.8rem", marginBottom: "0.25rem" },
  customError: { color: "#ff6b6b", fontSize: "0.8rem" },
};
