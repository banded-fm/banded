import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { GAME_ARTISTS, type GameArtist } from "../game/artists";
import { getDb, isDbLoaded, findNodeByName, bfsShortestPath, findNodeById, distancesFrom } from "../db/graphDb";
import { AWAY_DEPTH, awayLabel } from "../game/distance";
import { walkGame, walkKey, type Walk } from "../game/walk";
import { dailyPuzzle, findPuzzle, localDate, randomPuzzle, type Puzzle } from "../game/puzzles";
import { DebugConsole } from "../components/DebugConsole";
import { ArtistAutocomplete } from "../components/ArtistAutocomplete";
import { debugLog } from "../debug/DebugLog";
import { parVerdict } from "../game/result";
import { shareText } from "../game/shareText";
import { ShareDialog } from "../components/ShareDialog";
import { ShareIcon } from "../components/ShareIcon";

/**
 * "loading": the game isn't known yet (a random game needs the graph to find a
 * path). Its start/end may already be known (a shared link to curated artists),
 * and show while the rest loads. "playing" can start before the graph has
 * downloaded (a listed puzzle or a saved game): the moves come from the server
 * until it has (game/walk.ts).
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
  /** A puzzle from the list (src/game/puzzles.json): par is its closest connection through known artists. */
  listed?: boolean;
  /** The daily puzzle's date (YYYY-MM-DD), when this is one. */
  daily?: string;
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
  listed?: boolean;
  daily?: string;
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
    listed: game.listed,
    daily: game.daily,
    guesses: game.guesses,
    revealed: game.revealed,
  };
}

/** A game of a listed puzzle (the daily one when `daily` is its date). Needs no graph. */
function gameFromPuzzle(p: Puzzle, daily?: string): StoredGame {
  return {
    startArtist: { name: p.start.name, type: p.start.type, mbid: p.start.id },
    endArtist: { name: p.end.name, type: p.end.type, mbid: p.end.id },
    startId: p.start.id,
    endId: p.end.id,
    shortestPath: p.path.map((a) => a.id),
    par: p.par,
    listed: true,
    ...(daily ? { daily } : {}),
    guesses: [],
    revealed: false,
    timestamp: Date.now(),
  };
}

/** Today's puzzle: the saved game if it is today's, else a fresh one. */
function todaysGame(): StoredGame {
  const today = localDate();
  const saved = loadGame();
  return saved && saved.daily === today ? saved : gameFromPuzzle(dailyPuzzle(today), today);
}

const curatedById = (mbid: string) => GAME_ARTISTS.find((a) => a.mbid === mbid);

/**
 * What can be shown before the graph has downloaded: today's puzzle (or a saved
 * game of it), a listed puzzle from a shared link, a saved game, or a shared
 * link's start and end (their names when they are curated artists).
 */
function initialState(params: URLSearchParams): GameState {
  const start = params.get("start");
  const end = params.get("end");
  if (start && end) {
    const saved = loadGame();
    if (saved && saved.startId === start && saved.endId === end) return playing(saved);   // reload mid-game
    const listed = findPuzzle(start, end);
    if (listed) {
      const game = gameFromPuzzle(listed);
      if (listed.start.id !== start) Object.assign(game, flipped(game));   // shared the other way round
      return playing(game);
    }
    return { status: "loading", startId: start, endId: end, startArtist: curatedById(start),
             endArtist: curatedById(end), guesses: [], revealed: false };
  }
  return playing(todaysGame());
}

/** The same game from the other end. */
function flipped(g: StoredGame): Partial<StoredGame> {
  return { startArtist: g.endArtist, endArtist: g.startArtist, startId: g.endId, endId: g.startId,
           shortestPath: [...g.shortestPath].reverse() };
}

/** A new random game: a listed puzzle other than the current one. */
function generateGame(current?: { startId?: string; endId?: string }): StoredGame {
  const except = current?.startId && current.endId ? findPuzzle(current.startId, current.endId) : undefined;
  const game = gameFromPuzzle(randomPuzzle(except));
  saveGame(game);
  return game;
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

  // A listed puzzle keeps its par (closest connection through known artists)
  const listed = findPuzzle(startNode.id, endNode.id);
  if (listed) {
    const game = gameFromPuzzle(listed);
    if (listed.start.id !== startNode.id) Object.assign(game, flipped(game));
    saveGame(game);
    return { game };
  }

  // Every connection counts, as in Explore; par is the shortest path's hops
  const path = bfsShortestPath(startNode.id, endNode.id, 12);
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
    par: path.length - 1,
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

/** Order of a move's connection in the list: band ties first, then records and shows. */
function relTypePriority(relType: string): number {
  switch (relType) {
    case "member_of": return 0;
    case "former_member_of": return 1;
    case "support_musician": return 2;
    case "collaborated_with": return 3;
    case "produced_for": return 4;
    case "opened_for": return 5;
    default: return 6;
  }
}

/**
 * How a move is connected to the current artist. `outgoing`: the current
 * artist is the edge's source (the member, the credited musician, the
 * producer, the opener).
 */
function formatRelType(relType: string, nodeType: string, outgoing: boolean): string {
  switch (relType) {
    case "member_of": return nodeType === "group" ? "group" : "member";
    case "former_member_of": return nodeType === "group" ? "former group" : "former member";
    case "support_musician": return nodeType === "group" ? "supported" : "support musician";
    case "collaborated_with": return "collaborator";
    case "produced_for": return outgoing ? "produced for" : "producer";
    case "opened_for": return outgoing ? "headliner" : "opener";
    default: return relType.replace(/_/g, " ");
  }
}

export function PlayPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<GameState>(() => initialState(searchParams));
  // The graph (~72 MB) downloads in the background; the page doesn't wait for it.
  const [dbReady, setDbReady] = useState(isDbLoaded);
  const [input, setInput] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [customStartPick, setCustomStartPick] = useState<Pick | null>(null);
  const [customEndPick, setCustomEndPick] = useState<Pick | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [customLoading, setCustomLoading] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Set by a step, so the share dialog opens when that step wins (not when a won game is reopened later).
  const justStepped = useRef(false);
  const movesListRef = useRef<HTMLDivElement>(null);
  const customFormRef = useRef<HTMLDivElement>(null);

  // A new puzzle (or a step along this one) replaces the connections: show them from the top.
  useEffect(() => {
    if (movesListRef.current) movesListRef.current.scrollTop = 0;
  }, [state.startId, state.endId, state.guesses.length]);

  // Opening Custom Game brings its start and end boxes into view (they open below the buttons, often off screen).
  useEffect(() => {
    if (showCustom) customFormRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [showCustom]);

  // Where the game has got to and the moves from there: from the server until the
  // graph has downloaded, then from the graph (worked out again when it arrives).
  const key = state.status === "playing" ? walkKey(state.startId!, state.guesses) : null;
  const [walk, setWalk] = useState<(Walk & { failed?: boolean }) | null>(null);
  const [walkRetry, setWalkRetry] = useState(0);
  useEffect(() => {
    if (state.status !== "playing" || !key) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    walkGame(state.startId!, state.guesses)
      // No moves at all before the graph has loaded means the server couldn't be reached: try again shortly.
      .then((w): Walk & { failed?: boolean } => w.neighbors.length === 0 && !isDbLoaded() ? { ...w, failed: true } : w)
      .catch((): Walk & { failed?: boolean } => ({ key, ids: [], neighbors: [], failed: true }))
      .then((w) => {
        if (cancelled) return;
        setWalk(w);
        if (w.failed) timer = setTimeout(() => setWalkRetry((n) => n + 1), 5000);
      });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key, dbReady, walkRetry]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = walk && walk.key === key && !walk.failed ? walk : null;
  const movesFailed = !!walk && walk.key === key && !!walk.failed;
  const visitedIds = new Set(current?.ids ?? []);
  // How far every artist near the end is from it (worked out once per puzzle, after the page has drawn).
  const [away, setAway] = useState<{ endId: string; dist: Map<string, number> } | null>(null);
  useEffect(() => {
    const endId = state.endId;
    if (!endId || !dbReady || away?.endId === endId) return;
    const t = setTimeout(() => { const dist = distancesFrom(endId, AWAY_DEPTH); if (dist) setAway({ endId, dist }); }, 0);
    return () => clearTimeout(t);
  }, [state.endId, dbReady]); // eslint-disable-line react-hooks/exhaustive-deps
  const awayOf = (id: string) => (away && away.endId === state.endId ? away.dist.get(id) : undefined);
  const awayKnown = !!away && away.endId === state.endId;
  const lastId = current && current.ids.length > 1 ? current.ids[current.ids.length - 1] : undefined;

  // Won: the last step reached the end artist (by ID, so a namesake or a typed name that isn't a move doesn't count).
  const won = !!current && state.guesses.length > 0 && current.ids.length === state.guesses.length + 1
    && current.ids[current.ids.length - 1] === state.endId;
  useEffect(() => {
    if (won && justStepped.current) setShareOpen(true);
    if (won) justStepped.current = false;
  }, [won]);

  // Valid next moves: neighbors of the current artist, excluding ones already visited
  const validMoves = (() => {
    if (!current) return [];
    return current.neighbors
      .filter((n) => !visitedIds.has(n.node.id))
      .map((n) => ({ id: n.node.id, name: n.node.name, type: n.node.type, relType: n.relType, outgoing: n.outgoing ?? false }))
      // one entry per artist, labelled with its closest kind of connection
      .sort((a, b) => relTypePriority(a.relType) - relTypePriority(b.relType))
      .filter((n, i, arr) => arr.findIndex((x) => x.id === n.id) === i)
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

  const startNewGame = useCallback(() => {
    const game = generateGame(state);
    setInput("");
    setSearchParams({ start: game.startId, end: game.endId }, { replace: true });
    setState(playing(game));
  }, [setSearchParams, state]);

  const playToday = useCallback(() => {
    const game = todaysGame();
    saveGame(game);
    setInput("");
    setSearchParams({}, { replace: true });
    setState(playing(game));
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


  // Download the graph, then finish whatever the first render couldn't: a shared
  // game's path, or a new random game. A saved game is already playing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await getDb();
      } catch (e) {
        // A game already playing carries on with the server's moves.
        if (!cancelled) setState((s) => s.status === "playing" ? s : { status: "error", error: e instanceof Error ? e.message : "Failed to load database", guesses: [], revealed: false });
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
        // An invalid shared game falls back to today's puzzle
        debugLog.log(`Shared game invalid: ${result.error}`);
      }
      setSearchParams({}, { replace: true });
      setState(playing(todaysGame()));
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGuess = (name?: string) => {
    const guess = name ?? input.trim();
    if (!guess || state.status !== "playing") return;
    const newGuesses = [...state.guesses, guess];
    setInput("");
    justStepped.current = true;

    const newState = { ...state, guesses: newGuesses };
    setState(newState);
    saveGame({
      startArtist: state.startArtist!,
      endArtist: state.endArtist!,
      startId: state.startId!,
      endId: state.endId!,
      shortestPath: state.shortestPath!,
      par: state.par!,
      listed: state.listed,
      daily: state.daily,
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
      listed: state.listed,
      daily: state.daily,
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
      listed: state.listed,
      daily: state.daily,
      guesses: state.guesses,
      revealed: true,
      timestamp: Date.now(),
    });
  };

  // Names for the revealed path: a listed puzzle has them in puzzles.json, so they show before the graph loads.
  const listedPuzzle = state.startId && state.endId ? findPuzzle(state.startId, state.endId) : undefined;
  const pathNodes = new Map((listedPuzzle?.path ?? []).map((a) => [a.id, a] as const));

  // What the share dialog shares: the result once won, else the puzzle (also after giving up).
  const shareUrl = (() => {
    if (!state.startId || !state.endId) return "";
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = `#/play?${new URLSearchParams({ start: state.startId, end: state.endId }).toString()}`;
    return url.toString();
  })();
  // How far each step was from the end: past AWAY_DEPTH counts as AWAY_DEPTH + 1 once the distances are known.
  const steps = current && awayKnown
    ? current.ids.slice(1).map((id) => awayOf(id) ?? AWAY_DEPTH + 1)
    : (current?.ids.slice(1) ?? state.guesses).map(() => undefined);
  const share = state.startArtist && state.endArtist ? shareText({
    start: state.startArtist.name,
    end: state.endArtist.name,
    dateLabel: state.daily ? new Date(`${state.daily}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : undefined,
    steps,
    won,
    par: state.par,
    url: shareUrl,
  }) : "";
  const shareTitle = won ? "You connected them!" : "Share this puzzle";
  const shareSummary = won
    ? `${state.guesses.length} ${state.guesses.length === 1 ? "step" : "steps"}${state.par != null ? ` · Par ${state.par}: ${parVerdict(state.guesses.length, state.par)}` : ""}`
    : undefined;

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
            {state.daily ? "Today's puzzle: c" : "C"}onnect these two {state.startArtist?.type === "group" ? "groups" : "artists"} in as few steps as you can.
          </p>
        </div>

        {state.status === "error" && (
          <div style={styles.card}>
            <p style={styles.errorText}>{state.error}</p>
            <button onClick={playToday} style={styles.newGameBtn}>Today's Puzzle</button>
          </div>
        )}

        {state.status !== "error" && (
          <div className="endpoints-card" style={styles.endpointsCard} aria-busy={state.status === "loading"}>
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              disabled={!share}
              className="share-btn"
              style={styles.shareBtn}
              aria-label={won ? "Share your result" : "Share this puzzle"}
              title={won ? "Share your result" : "Share this puzzle"}
            >
              <ShareIcon />
            </button>
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

        {state.status === "loading" && (
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
                : "Loading the music graph (~72 MB, downloaded once in the background)…"}
            </p>
          </div>
        )}

        {state.status !== "error" && (
          <>
            {state.status === "playing" && (<>
            {(won || state.revealed) && (
              <div style={styles.wonSection} role="status">
                <p style={styles.wonTitle}>
                  {won ? `You connected them in ${state.guesses.length} ${state.guesses.length === 1 ? "step" : "steps"}!` : "You gave up!"}
                </p>
                {won && state.par != null && <p style={styles.wonDetail}>Par {state.par}: {parVerdict(state.guesses.length, state.par)}</p>}
                {won && <div style={styles.guessList}>
                  <span style={styles.guessChip}>{state.startArtist!.name}</span>
                  {state.guesses.map((g, i) => (
                    <span key={i} style={styles.guessStep}>
                      <span style={styles.chainArrow}>→</span>
                      <span style={i === state.guesses.length - 1 ? styles.guessChipCurrent : styles.guessChip}>{g}</span>
                    </span>
                  ))}
                </div>}
                {/* The par (or shortest) path, once revealed: after giving up, or asked for after a win */}
                {state.revealed && (
                  <>
                    {won && <p style={styles.wonDetail}>{state.listed ? "Par path" : "Shortest path"}:</p>}
                    <div style={styles.chainDisplay}>
                      {state.shortestPath!.map((nodeId, i) => {
                        const node = pathNodes.get(nodeId) ?? findNodeById(nodeId);
                        return (
                          <span key={nodeId} style={styles.chainItem}>
                            <span style={styles.guessChip}>{node?.name ?? nodeId}</span>
                            {i < state.shortestPath!.length - 1 && <span style={styles.chainArrow}>→</span>}
                          </span>
                        );
                      })}
                    </div>
                  </>
                )}
                <div style={styles.resultButtons}>
                  <button onClick={() => setShareOpen(true)} style={styles.shareResultBtn}>Share</button>
                  {won && !state.revealed && (
                    <button onClick={handleReveal} style={styles.revealBtn}>
                      {state.listed ? "Show Par Path" : "Show Shortest Path"}
                    </button>
                  )}
                </div>
              </div>
            )}

            {!state.revealed && !won && (
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
                  <span style={styles.stepCount}>
                    {state.guesses.length} {state.guesses.length === 1 ? "step" : "steps"}
                    {lastId && awayKnown && <> · <strong style={styles.away}>{awayLabel(awayOf(lastId))}</strong> from {state.endArtist!.name}</>}
                  </span>
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
                <div ref={movesListRef} className="moves-list" style={styles.movesList} aria-busy={!current}>
                  {!current ? (
                    // The path so far, Undo and the filter stay put while the moves load.
                    [0, 1, 2, 3].map((i) => (
                      <div key={i} className="move-item" style={styles.moveItem} aria-hidden="true">
                        <span className="skeleton skeleton-move" />
                      </div>
                    ))
                  ) : filteredMoves.length > 0 ? (
                    filteredMoves.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => handleGuess(m.name)}
                        className="move-item"
                        style={styles.moveItem}
                      >
                        <span style={styles.moveName}>{m.name}</span>
                        <span style={styles.moveRel}>{formatRelType(m.relType, m.type, m.outgoing)}</span>
                      </button>
                    ))
                  ) : (
                    <p style={styles.noMoves}>No matching connections</p>
                  )}
                </div>
                {!current && (
                  <p style={styles.hint}>
                    {movesFailed ? "Couldn't load the connections. Trying again…" : "Loading connections…"}
                  </p>
                )}
                <button onClick={handleReveal} style={styles.revealBtn}>
                  Give up and reveal
                </button>
              </div>
            )}


            </>)}

            <div className="game-buttons" style={styles.gameButtons}>
              {!state.daily && (
                <button onClick={playToday} style={styles.newGameBtn}>
                  Today's Puzzle
                </button>
              )}
              <button onClick={startNewGame} disabled={state.status === "loading"} style={state.daily ? styles.newGameBtn : styles.customBtn}>
                Random Puzzle
              </button>
              <button onClick={() => { setShowCustom((s) => !s); setCustomError(null); }} style={styles.customBtn}>
                Custom Game
              </button>
            </div>

            {showCustom && (
              <div ref={customFormRef} style={styles.customForm}>
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
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} title={shareTitle} summary={shareSummary} text={share} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  container: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "1.5rem", overflowY: "auto", gap: "1rem" },
  header: { textAlign: "center" },
  // The share button hangs off the end of the title (the title stays centred).
  title: { fontSize: "1.6rem", fontWeight: 700, color: "#e0e0e0", marginBottom: "0.25rem" },
  subtitle: { color: "#888", fontSize: "0.9rem" },
  card: { background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "2rem", textAlign: "center" },
  loadingText: { color: "#e0e0e0", fontSize: "1rem", marginBottom: "0.5rem" },
  hint: { color: "#666", fontSize: "0.8rem" },
  errorText: { color: "#ff6b6b", marginBottom: "1rem" },
  endpointsCard: { position: "relative", display: "flex", alignItems: "center", gap: "1rem", background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "1.25rem 44px", flexWrap: "wrap", justifyContent: "center" },
  endpoint: { display: "flex", flexDirection: "column", alignItems: "center", gap: "0.25rem" },
  endpointLabel: { fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#888" },
  endpointName: { fontSize: "1.2rem", fontWeight: 700, color: "#feca57" },
  parBadge: { background: "#2a2a2a", color: "#fff", padding: "0.3rem 0.8rem", borderRadius: "12px", fontSize: "0.85rem", fontWeight: 600 },
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
  wonSection: { display: "flex", flexDirection: "column", alignItems: "center", gap: "0.6rem", width: "100%", maxWidth: "600px", textAlign: "center" },
  wonTitle: { color: "#fff", fontWeight: 700, fontSize: "1.15rem" },
  wonDetail: { color: "#888", fontSize: "0.9rem" },
  chainDisplay: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: "0.25rem" },
  chainItem: { display: "flex", alignItems: "center", gap: "0.25rem" },
  newGameBtn: { padding: "0.6rem 1.25rem", borderRadius: "4px", border: "none", background: "#ff6b6b", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: "0.9rem", marginTop: "0.5rem" },
  gameButtons: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "0.5rem", marginTop: "0.5rem" },
  customBtn: { padding: "0.6rem 1.25rem", borderRadius: "4px", border: "1px solid #48dbfb", background: "transparent", color: "#48dbfb", fontWeight: 600, cursor: "pointer", fontSize: "0.9rem", marginTop: "0.5rem" },
  away: { color: "#e0e0e0", fontWeight: 600 },
  // In the card's right edge, centred: the card leaves 44 px for it
  shareBtn: { position: "absolute", top: "50%", right: 0, transform: "translateY(-50%)", width: "44px", height: "44px", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, border: "none", borderRadius: "8px", background: "transparent", color: "#aaa", cursor: "pointer" },
  resultButtons: { display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "center" },
  shareResultBtn: { minHeight: "44px", padding: "0.5rem 1.25rem", borderRadius: "4px", border: "none", background: "#ff6b6b", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: "0.9rem" },
  customForm: { display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%", maxWidth: "400px", background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "1rem" },
  customHint: { color: "#888", fontSize: "0.8rem", marginBottom: "0.25rem" },
  customError: { color: "#ff6b6b", fontSize: "0.8rem" },
};
