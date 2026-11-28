import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { useLingering } from "../components/useLingering";
import { SheetScrim } from "../components/SheetScrim";
import { SwissLine } from "../components/SwissLine";
import { useSearchParams } from "react-router-dom";
import { GAME_ARTISTS, type GameArtist } from "../game/artists";
import { getDb, isDbLoaded, findNodeByName, bfsShortestPath, findNodeById, distancesFromAsync } from "../db/graphDb";
import { AWAY_DEPTH, awayLabel } from "../game/distance";
import { walkGame, walkKey, type Walk } from "../game/walk";
import { dailyPuzzle, findPuzzle, localDate, randomPuzzle, type Puzzle, puzzleNumber } from "../game/puzzles";
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
  /** Where the hint was used: the number of steps taken when it was (its list's position). */
  hints?: number[];
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
  hints?: number[];
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
    hints: game.hints,
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

/** How far from the end, as in the shared squares (green, yellow, orange, red), in Direction B's mark hues: teal
 * the end, ochre 1 away, orange 2 away, maroon 3 or more. */
const AWAY_COLOURS = ["#1F7A74", "#B87A0A", "#D4561A", "#7A1631"];
function awayChip(d: number): React.CSSProperties {
  const c = AWAY_COLOURS[Math.min(d, 3)]!;
  return { display: "inline-flex", alignItems: "center", height: "36px", padding: "0 14px", border: `2px solid ${c}`, fontSize: "15px", letterSpacing: "-0.01em", color: c, whiteSpace: "nowrap" };
}

/** The last puzzle end's distances, kept across visits to Play (the page remounts each time). */
let lastAway: { endId: string; dist: Map<string, number> } | null = null;

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
  // Play opens on a start screen (the design's Play-Start): the two artists large and a Start game button, the
  // connections hidden until then. The game itself loads behind it. A game already under way skips it.
  const [started, setStarted] = useState(() => state.guesses.length > 0 || state.revealed);
  // Set by a step, so the share dialog opens when that step wins (not when a won game is reopened later).
  const justStepped = useRef(false);
  const movesListRef = useRef<HTMLDivElement>(null);
  const customFormRef = useRef<HTMLDivElement>(null);

  // A new puzzle (or a step along this one) replaces the connections: show them from the top.
  useEffect(() => {
    if (movesListRef.current) movesListRef.current.scrollTop = 0;
  }, [state.startId, state.endId, state.guesses.length]);

  // Custom game: a sheet from the bottom of the screen, over the start screen or the game. Escape closes it.
  const openCustom = () => { setShowCustom(true); setCustomError(null); };
  const closeCustom = () => setShowCustom(false);
  // Stays a moment after closing, to slide away (on every width: it's a sheet on wide screens too)
  const [customShown, customClosing] = useLingering(showCustom ? true : null, { phoneOnly: false });
  useEffect(() => {
    if (!showCustom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowCustom(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
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
  // How far every artist near the end is from it: worked out once per puzzle, in the
  // background a slice at a time (a second or more for a well-connected end), so the
  // page shows and responds straight away. Kept for the next visit to Play.
  const [away, setAway] = useState<{ endId: string; dist: Map<string, number> } | null>(
    () => (lastAway && lastAway.endId === state.endId ? lastAway : null));
  useEffect(() => {
    const endId = state.endId;
    if (!endId || !dbReady || away?.endId === endId) return;
    if (lastAway?.endId === endId) { setAway(lastAway); return; }
    const ac = new AbortController();
    distancesFromAsync(endId, AWAY_DEPTH, ac.signal).then((dist) => {
      if (!dist) return;
      lastAway = { endId, dist };
      setAway(lastAway);
    });
    return () => ac.abort();
  }, [state.endId, dbReady]); // eslint-disable-line react-hooks/exhaustive-deps
  const awayOf = (id: string) => (away && away.endId === state.endId ? away.dist.get(id) : undefined);
  const awayKnown = !!away && away.endId === state.endId;

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
    setStarted(false);   // a new puzzle opens on its start screen, from the game too
  }, [setSearchParams, state]);

  const playToday = useCallback(() => {
    const game = todaysGame();
    saveGame(game);
    setInput("");
    setSearchParams({}, { replace: true });
    setState(playing(game));
    // Its start screen too, unless today's game is already under way
    setStarted(game.guesses.length > 0 || game.revealed);
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
    setStarted(false);   // the custom puzzle opens on its start screen
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
      hints: state.hints,
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
      hints: state.hints,
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
      hints: state.hints,
      timestamp: Date.now(),
    });
  };

  // The hint colours the connections here by how far each is from the end. Counted once per position.
  const handleHint = () => {
    if (state.status !== "playing") return;
    const at = state.guesses.length;
    if (state.hints?.includes(at)) return;
    const hints = [...(state.hints ?? []), at];
    setState({ ...state, hints });
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
      revealed: state.revealed,
      hints,
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
    hinted: state.hints,
    won,
    gaveUp: state.revealed && !won,
    par: state.par,
    url: shareUrl,
  }) : "";
  const shareTitle = won ? "You connected them!" : state.revealed ? "You gave up" : "Share this puzzle";
  const shareSummary = won
    ? `${state.guesses.length} ${state.guesses.length === 1 ? "step" : "steps"}${state.par != null ? ` · Par ${state.par}: ${parVerdict(state.guesses.length, state.par)}` : ""}`
    : state.revealed ? `After ${state.guesses.length} ${state.guesses.length === 1 ? "step" : "steps"}` : undefined;
  // A guess's pill, coloured by how far that artist is from the end (plain until that's known)
  const stepChip = (i: number) => {
    const id = current && current.ids.length === state.guesses.length + 1 ? current.ids[i + 1] : undefined;
    return id && awayKnown ? awayChip(awayOf(id) ?? AWAY_DEPTH + 1) : styles.guessChip;
  };
  const hintedHere = !!state.hints?.includes(state.guesses.length);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleGuess();
  };

  // The artist the next step is from (the start before any step)
  const currentName = state.guesses.length > 0 ? state.guesses[state.guesses.length - 1] : state.startArtist?.name;
  const inPlay = state.status === "playing" && !state.revealed && !won;
  // Where the player is now (the start before any step): how far it is from the end shows from the first move
  const hereId = current && current.ids.length > 0 ? current.ids[current.ids.length - 1] : undefined;
  // Start, par and end share one line, as in the design: the names shrink to fit it
  const endpointsRef = useRef<HTMLDivElement>(null);
  useFitEndpoints(endpointsRef, `${started}|${state.startArtist?.name}|${state.endArtist?.name}|${state.par}`);   // the row mounts when the game starts
  // "Give up and reveal" follows the path 24px after its last box; when it wraps onto a line of its own, it lines up
  // with the left edge instead
  const giveUpRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const btn = giveUpRef.current;
    if (!btn?.parentElement) return;
    const place = () => {
      btn.style.marginLeft = "24px";
      btn.style.flexBasis = "";
      btn.style.textAlign = "";
      const prev = btn.previousElementSibling as HTMLElement | null;
      if (prev && btn.offsetTop >= prev.offsetTop + prev.offsetHeight) {
        btn.style.marginLeft = "0";
        btn.style.flexBasis = "100%";   // keeps it on its own line once the indent is gone
        btn.style.textAlign = "left";
      }
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(btn.parentElement);
    return () => ro.disconnect();
  }, [state.guesses.length, inPlay]);

  // Today's puzzle: its date and number (#1 on the first day)
  const dailyLabel = state.daily ? new Date(`${state.daily}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
  const puzzleNo = state.daily ? (
    <span className="puzzle-no" style={styles.puzzleNo}><span style={styles.puzzleHash}>#</span>{puzzleNumber(state.daily)}</span>
  ) : null;

  const showStart = !started && state.status !== "error";
  // Start game: the start and end names (and par) glide from the start screen to their places in the game (a view
  // transition: index.css, .vt-play-*); the rest of the page switches at once. Without view transitions, or with
  // reduced motion, it just switches.
  const startGame = () => {
    const doc = document as Document & { startViewTransition?: (update: () => void) => unknown };
    if (!doc.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setStarted(true); return; }
    doc.startViewTransition(() => flushSync(() => setStarted(true)));
  };
  const startNamesRef = useRef<HTMLDivElement>(null);
  useFitNames(startNamesRef, `${showStart}|${state.startArtist?.name}|${state.endArtist?.name}`);
  // Wide screens: the buttons' top lines up with the bottom of Par (they hang below the row, whose bottom is Par's),
  // as far down as the page has room for; short of room, they sit higher, up to level with Par's bottom
  const startPageRef = useRef<HTMLDivElement>(null);
  const startActionsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const page = startPageRef.current, actions = startActionsRef.current, ends = startNamesRef.current;
    if (!showStart || !page || !actions || !ends) return;
    const place = () => {
      actions.style.marginBottom = "0";
      if (window.matchMedia("(max-width: 640px)").matches) return;
      const bottom = page.getBoundingClientRect().bottom - parseFloat(getComputedStyle(page).paddingBottom);
      const room = bottom - ends.getBoundingClientRect().bottom;
      const drop = Math.max(0, Math.min(actions.offsetHeight, room));
      actions.style.marginBottom = `-${drop}px`;
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(page);
    ro.observe(ends);
    return () => ro.disconnect();
  }, [showStart, state.startArtist?.name, state.endArtist?.name, state.daily]);
  const startScreen = (
    <div ref={startPageRef} className="page-container play-start" style={styles.startPage}>
      <div style={styles.startMain}>
        <div className="play-start-head" style={styles.header}>
          {state.daily && <div className="eyebrow">Today's puzzle · {dailyLabel}</div>}
          <h1 className="page-title play-start-title" style={styles.title}>Six degrees of music{puzzleNo}</h1>
          <p style={styles.subtitle}>
            Connect these two {state.startArtist?.type === "group" ? "groups" : "artists"} in as few steps as you can.
          </p>
        </div>
        {/* The ends on the left, the buttons on the right with their bottom level with Par's (phones: stacked) */}
        <div className="play-start-row" style={styles.startRow}>
        <div ref={startNamesRef} className="play-start-ends" style={styles.startEnds} aria-busy={state.status === "loading"}>
          <span className="eyebrow">Start</span>
          {state.startArtist
            ? <span className="start-name vt-play-start" style={{ ...styles.startName, color: "#7A1631" }}>{state.startArtist.name}</span>
            : <span className="skeleton" style={styles.startSkeleton} aria-label="Picking the start…" />}
          <SwissLine className="play-start-line" height={56} segmentWidth={56} phoneSegmentWidth={44.75} strokeWidth={8} style={styles.startLine} />
          <span className="eyebrow" style={styles.startEndLabel}>End</span>
          {state.endArtist
            ? <span className="start-name vt-play-end" style={styles.startName}>{state.endArtist.name}</span>
            : <span className="skeleton" style={styles.startSkeleton} aria-label="Picking the end…" />}
          {state.par != null
            ? <span className="play-start-par vt-play-par" style={styles.startPar}>Par {state.par}</span>
            : <span className="skeleton skeleton-par" style={{ marginTop: "20px" }} aria-hidden="true" />}
        </div>
      <div ref={startActionsRef} className="play-start-actions" style={styles.startActions}>
        <button type="button" className="start-game-btn" onClick={startGame} disabled={state.status !== "playing"} style={styles.startGameBtn}>
          {state.status === "playing" ? "Start game" : "Loading the puzzle…"}
        </button>
        <div className="play-start-more" style={styles.startMore}>
          {!state.daily && <button type="button" onClick={playToday} style={styles.startMoreBtn}>Today's puzzle</button>}
          <button type="button" onClick={startNewGame} disabled={state.status === "loading"} style={styles.startMoreBtn}>Random puzzle</button>
          <button type="button" onClick={openCustom} aria-haspopup="dialog" style={styles.startMoreBtn}>Custom game</button>
        </div>
      </div>
        </div>
      </div>
    </div>
  );

  return (
    <div style={styles.page}>
      <DebugConsole />
      {/* Two columns on a wide screen: the puzzle (its ends, your path, the actions) on the left, the next step's
          connections (or the custom game) on the right. One column on phones (index.css orders the blocks). */}
      {showStart ? startScreen : (
      <div className="page-container play-page" style={styles.container}>
        <div className="play-left" style={styles.left}>
        <div className="play-head" style={styles.header}>
          {state.daily && <div className="eyebrow">Today's puzzle · {dailyLabel}</div>}
          <h1 className="page-title play-title" style={styles.title}>Six degrees of music{puzzleNo}</h1>
          <p style={styles.subtitle}>
            Connect these two {state.startArtist?.type === "group" ? "groups" : "artists"} in as few steps as you can.
          </p>
        </div>

        {state.status === "error" && (
          <div className="play-error" style={styles.card}>
            <p style={styles.errorText}>{state.error}</p>
            <button onClick={playToday} style={styles.newGameBtn}>Today's puzzle</button>
          </div>
        )}

        {state.status !== "error" && (
          <div ref={endpointsRef} className="endpoints-card" style={styles.endpointsCard} aria-busy={state.status === "loading"}>
            <div style={styles.endpoint}>
              <span className="eyebrow">Start</span>
              {state.startArtist
                ? <span className="endpoint-name vt-play-start" style={{ ...styles.endpointName, color: "#7A1631" }}>{state.startArtist.name}</span>
                : <span className="skeleton skeleton-name" aria-label="Picking the start…" />}
            </div>
            {state.par != null
              ? <div className="par-badge vt-play-par" style={styles.parBadge}>Par {state.par}</div>
              : <span className="skeleton skeleton-par" aria-hidden="true" />}
            <div className="endpoint-end" style={styles.endpoint}>
              <span className="eyebrow">End</span>
              {state.endArtist
                ? <span className="endpoint-name vt-play-end" style={styles.endpointName}>{state.endArtist.name}</span>
                : <span className="skeleton skeleton-name" aria-label="Picking the end…" />}
            </div>
          </div>
        )}

        {state.status === "playing" && (won || state.revealed) && (
          <div className="play-result" style={styles.wonSection} role="status">
            <p style={styles.wonTitle}>
              {won ? `You connected them in ${state.guesses.length} ${state.guesses.length === 1 ? "step" : "steps"}!` : "You gave up!"}
            </p>
            {won && state.par != null && <p className="eyebrow">Par {state.par}: {parVerdict(state.guesses.length, state.par)}</p>}
            {won && <div className="guess-list" style={styles.guessList}>
              <span className="path-chip" style={styles.guessChip}>{state.startArtist!.name}</span>
              {state.guesses.map((g, i) => (
                <span key={i} style={styles.guessStep}>
                  <span className="chain-arrow" style={styles.chainArrow}>→</span>
                  <span className="path-chip" style={stepChip(i)}>{g}</span>
                </span>
              ))}
            </div>}
            {/* The par (or shortest) path, once revealed: after giving up, or asked for after a win */}
            {state.revealed && (
              <>
                {won && <p className="eyebrow" style={{ marginTop: "8px" }}>{state.listed ? "Par path" : "Shortest path"}</p>}
                <div style={styles.chainDisplay}>
                  {state.shortestPath!.map((nodeId, i) => {
                    const node = pathNodes.get(nodeId) ?? findNodeById(nodeId);
                    return (
                      <span key={nodeId} style={styles.chainItem}>
                        <span className="path-chip" style={styles.guessChip}>{node?.name ?? nodeId}</span>
                        {i < state.shortestPath!.length - 1 && <span className="chain-arrow" style={styles.chainArrow}>→</span>}
                      </span>
                    );
                  })}
                </div>
              </>
            )}
            <div style={styles.resultButtons}>
              <button onClick={() => setShareOpen(true)} style={styles.shareResultBtn}>Share result</button>
              {won && !state.revealed && (
                <button onClick={handleReveal} style={styles.outlineBtn}>
                  {state.listed ? "Show par path" : "Show shortest path"}
                </button>
              )}
            </div>
          </div>
        )}

        {state.status === "playing" && inPlay && (
          <div className="play-progress" style={styles.progressSection}>
            <div className="guess-list" style={styles.guessList}>
              <span className="path-chip" style={styles.guessChip}>{state.startArtist!.name}</span>
              {state.guesses.map((g, i) => (
                <span key={i} style={styles.guessStep}>
                  <span className="chain-arrow" style={styles.chainArrow}>→</span>
                  <span className="path-chip" style={stepChip(i)}>{g}</span>
                </span>
              ))}
              <span style={styles.guessStep}>
                <span className="chain-arrow" style={styles.chainArrow}>→</span>
                <span className="path-chip" style={styles.nextChip}>?</span>
              </span>
              {/* At the end of the path's row */}
              <button ref={giveUpRef} className="play-giveup" onClick={handleReveal} style={{ ...styles.revealBtn, marginLeft: "24px" }}>
                Give up and reveal
              </button>
            </div>
          </div>
        )}

        {/* A fixed distance below the puzzle, roughly level with the end of the connections beside it (the design), but
            not tied to them: the list's length and Custom Game don't move it. Phones: index.css puts it in reading order. */}
        <div className="play-bottom" style={styles.bottom}>
        {state.status === "playing" && inPlay && (
            <div className="path-actions" style={styles.pathActions}>
              <span className="path-steps" style={styles.stepCount}>
                <b style={styles.stepsBold}>{state.guesses.length} {state.guesses.length === 1 ? "step" : "steps"}</b>
                {hereId && awayKnown && <> · <span style={styles.away}>{awayLabel(awayOf(hereId))}</span><span className="away-from"> from {state.endArtist!.name}</span></>}
              </span>
              {state.guesses.length > 0 && (
                <button onClick={handleUndo} style={styles.undoBtn}>
                  Undo
                </button>
              )}
              <button
                onClick={handleHint}
                disabled={!awayKnown || hintedHere}
                style={styles.hintBtn}
                title={awayKnown ? "Colour these connections by how far each is from the end" : "Available once the graph has loaded"}
              >
                {hintedHere ? "Hint used" : "Hint"}
              </button>
              <button
                type="button"
                onClick={() => setShareOpen(true)}
                disabled={!share}
                className="share-btn"
                style={styles.shareBtn}
                aria-label="Share this puzzle"
                title="Share this puzzle"
              >
                <ShareIcon />
              </button>
            </div>
        )}

        {state.status !== "error" && (
          <div className="game-buttons" style={styles.gameButtons}>
            {!state.daily && (
              <button onClick={playToday} style={styles.newGameBtn}>
                Today's puzzle
              </button>
            )}
            <button onClick={startNewGame} disabled={state.status === "loading"} style={state.daily ? styles.newGameBtn : styles.outlineBtn}>
              Random puzzle
            </button>
            <button
              onClick={openCustom}
              aria-haspopup="dialog"
              style={styles.outlineBtn}
            >
              Custom game
            </button>
          </div>
        )}
        </div>
        </div>

        <div className="play-right" style={styles.right}>
        {state.status === "loading" && (
          <div className="play-moves" style={styles.movesSection}>
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

        {state.status === "playing" && inPlay && (
          <div className="play-moves" style={styles.movesSection}>
            <div className="eyebrow">Next step from {currentName}</div>
            <div className="moves-input-row" style={styles.inputRow}>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Filter connections"
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
                filteredMoves.map((m) => {
                  const d = hintedHere && awayKnown ? (awayOf(m.id) ?? AWAY_DEPTH + 1) : undefined;
                  const colour = d === undefined ? undefined : AWAY_COLOURS[Math.min(d, 3)];
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => handleGuess(m.name)}
                      className={colour ? "move-item move-hinted" : "move-item"}
                      style={colour ? { ...styles.moveItem, borderLeftColor: colour } : styles.moveItem}
                    >
                      <span className="move-name" style={styles.moveName}>{m.name}</span>
                      <span className="move-rel" style={styles.moveRel}>
                        {formatRelType(m.relType, m.type, m.outgoing)}
                        {d !== undefined && <> · <span style={{ color: colour }}>{awayLabel(d > AWAY_DEPTH ? undefined : d)}</span></>}
                      </span>
                      <span className="move-arrow" aria-hidden="true" style={styles.moveArrow}>→</span>
                    </button>
                  );
                })
              ) : (
                <p style={styles.noMoves}>No matching connections</p>
              )}
            </div>
            {!current && (
              <p style={styles.hint}>
                {movesFailed ? "Couldn't load the connections. Trying again…" : "Loading connections…"}
              </p>
            )}
          </div>
        )}

        </div>
      </div>
      )}
      {customShown && state.status !== "error" && <>
        <SheetScrim onClose={closeCustom} everywhere closing={customClosing} />
          <div ref={customFormRef} className={`play-custom custom-sheet${customClosing ? " sheet-closing" : ""}`} style={styles.customForm} role="dialog" aria-modal="true" aria-label="Custom game">
            <div style={styles.customHead}>
              <span className="eyebrow">Custom game</span>
              <button type="button" onClick={closeCustom} className="info-close" style={styles.customClose} aria-label="Close">×</button>
            </div>
            <p style={styles.customHint}>
              Pick any two artists to connect
            </p>
            <ArtistAutocomplete
              value={customStart}
              onChange={setCustomStart}
              onSelect={(s) => {
                setCustomStart(s.name);
                setCustomStartPick({ id: s.id, name: s.name });
              }}
              placeholder="Start artist or group"
              inputStyle={styles.customInput}
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
              inputStyle={styles.customInput}
              ariaLabel="End artist"
            />
            {customError && <p style={styles.customError}>{customError}</p>}
            <button
              onClick={handleStartCustomGame}
              disabled={customLoading || !customStart.trim() || !customEnd.trim()}
              style={styles.customStartBtn}
            >
              {customLoading ? "Checking…" : "Start"}
            </button>
          </div>
      </>}
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} title={shareTitle} summary={shareSummary} text={share} />
    </div>
  );
}

/**
 * The start screen's names: as large as the design (96px; 60px on phones) while they fit a line, smaller (to 40px;
 * 30px on phones) for a long name, wrapping only past that.
 */
function useFitNames(ref: React.RefObject<HTMLDivElement>, key: string) {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const fit = () => {
      const phone = window.matchMedia("(max-width: 640px)").matches;
      const [max, min] = phone ? [60, 30] : [96, 40];
      box.querySelectorAll<HTMLElement>(".start-name").forEach((n) => {
        n.style.whiteSpace = "nowrap";
        n.style.overflowWrap = "";
        let size = max;
        n.style.fontSize = `${size}px`;
        while (size > min && n.scrollWidth > n.clientWidth + 1) { size -= 2; n.style.fontSize = `${size}px`; }
        if (n.scrollWidth > n.clientWidth + 1) { n.style.whiteSpace = "normal"; n.style.overflowWrap = "anywhere"; }
      });
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let last = box.clientWidth;
    const ro = new ResizeObserver(() => { if (box.clientWidth !== last) { last = box.clientWidth; fit(); } });
    ro.observe(box);
    document.fonts?.ready.then(fit).catch(() => {});
    return () => ro.disconnect();
  }, [ref, key]);
}

/**
 * Fits the Start / Par / End row on one line, as in the design: the names start at the design's size (54px; 26px on
 * phones) and step down until the row fits, to 28px (16px on phones). Past that, Start, Par and End each take a line
 * of their own (Par between the two names), with the names as large as fits a line. Runs again when the names change
 * or the row's width does.
 */
function useFitEndpoints(ref: React.RefObject<HTMLDivElement>, key: string) {
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    const fit = () => {
      const phone = window.matchMedia("(max-width: 640px)").matches;
      const [max, min] = phone ? [26, 16] : [54, 28];
      const names = row.querySelectorAll<HTMLElement>(".endpoint-name");
      const ends = row.querySelectorAll<HTMLElement>(":scope > div");
      const par = row.querySelector<HTMLElement>(".par-badge, .skeleton-par");
      const setStacked = (stacked: boolean) => {
        row.style.flexWrap = stacked ? "wrap" : "nowrap";
        ends.forEach((e) => { e.style.flex = stacked ? "0 1 100%" : "none"; });   // a line each
        if (par) par.style.flexBasis = stacked ? "100%" : "";
        names.forEach((n) => { n.style.whiteSpace = "nowrap"; n.style.overflowWrap = ""; });
      };
      setStacked(false);
      let size = max;
      const apply = () => names.forEach((n) => { n.style.fontSize = `${size}px`; });
      apply();
      while (size > min && row.scrollWidth > row.clientWidth + 1) { size -= 2; apply(); }
      if (row.scrollWidth > row.clientWidth + 1) {
        // Too long for one line: Start, Par and End stacked, the names as large as the longer one allows on a line
        setStacked(true);
        const room = row.clientWidth;
        let fit = max;
        // the text's own width (the name's box spans the line)
        const textWidth = (n: HTMLElement) => { const r = document.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect().width; };
        names.forEach((n) => { const w = textWidth(n); if (w > 0) fit = Math.min(fit, Math.floor((size * room * 0.98) / w)); });
        size = Math.max(min, Math.min(max, fit));
        apply();
        // A name too long even for a line of its own wraps
        names.forEach((n) => { if (textWidth(n) > room + 1) { n.style.whiteSpace = "normal"; n.style.overflowWrap = "anywhere"; } });
      }
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let last = row.clientWidth;
    const ro = new ResizeObserver(() => { if (row.clientWidth !== last) { last = row.clientWidth; fit(); } });
    ro.observe(row);
    // Web fonts change the names' widths once they load
    document.fonts?.ready.then(fit).catch(() => {});
    return () => ro.disconnect();
  }, [ref, key]);
}

const styles: Record<string, React.CSSProperties> = {
  page: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  container: { flex: 1, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "52px", padding: "30px 48px 40px", overflowY: "auto" },
  left: { flex: "0 1 700px", minWidth: 0, display: "flex", flexDirection: "column", gap: "28px" },
  bottom: { marginTop: "28px", display: "flex", flexDirection: "column", gap: "36px" },
  right: { flex: "0 1 512px", minWidth: 0, display: "flex", flexDirection: "column" },
  header: { display: "flex", flexDirection: "column", gap: "8px" },
  title: { fontSize: "clamp(40px, 4.6vw, 62px)", lineHeight: 1, letterSpacing: "-0.055em", color: "#2E0A14" },
  // The daily puzzle's number after the title, two thirds its size, the # smaller again (the design)
  puzzleNo: { fontSize: "0.66em", letterSpacing: "-0.04em", marginLeft: "0.15em", color: "#2E0A14", whiteSpace: "nowrap" },
  puzzleHash: { fontSize: "0.51em" },
  // Start screen (Swiss-Play-Start): the puzzle on the left, Start game and the other puzzles bottom right
  startPage: { flex: 1, display: "flex", padding: "30px 48px 40px", overflowY: "auto" },
  startMain: { flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" },
  startRow: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "48px" },
  startEnds: { marginTop: "60px", display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: 0, flex: "1 1 auto" },
  // As wide as the name (not the line), so its view transition into the game scales the text, not empty space
  startName: { display: "block", width: "fit-content", maxWidth: "100%", marginTop: "4px", fontSize: "96px", lineHeight: 1, letterSpacing: "-0.065em", color: "#2E0A14", whiteSpace: "nowrap" },
  startSkeleton: { display: "block", width: "min(480px, 70%)", height: "72px", marginTop: "8px" },
  startLine: { width: "min(560px, 100%)", marginTop: "28px" },
  startEndLabel: { marginTop: "12px" },
  startPar: { marginTop: "20px", fontSize: "40px", lineHeight: 1, letterSpacing: "-0.04em", color: "#7A1631" },
  startActions: { flex: "0 0 406px", display: "flex", flexDirection: "column", gap: "16px" },
  startGameBtn: { height: "48px", display: "flex", alignItems: "center", padding: "0 20px", border: "none", background: "#7A1631", color: "#F3ECE1", fontWeight: 500, fontSize: "15px", cursor: "pointer", textAlign: "left" },
  // Two buttons share a row; with a third (Today's puzzle, on another puzzle) it takes a row of its own above them
  startMore: { display: "flex", flexWrap: "wrap", gap: "12px" },
  startMoreBtn: { flex: "1 1 calc(50% - 6px)", minWidth: 0, height: "48px", padding: "0 10px", border: "2px solid #2E0A14", background: "transparent", color: "#2E0A14", fontWeight: 500, fontSize: "15px", cursor: "pointer", whiteSpace: "nowrap" },
  subtitle: { color: "#2E0A14", fontSize: "16px", fontWeight: 400, lineHeight: 1.4, marginTop: "2px" },
  card: { borderTop: "2px solid #2E0A14", paddingTop: "14px" },
  loadingText: { color: "#2E0A14", fontSize: "1rem", marginBottom: "0.5rem" },
  hint: { color: "#6B4A50", fontSize: "14px", fontWeight: 400, marginTop: "10px" },
  errorText: { color: "#7A1631", marginBottom: "1rem", fontSize: "16px" },
  // Start, Par, End on a 2px rule; the share button at the row's end
  // One line: Start, Par, End (useFitEndpoints sizes the names; they wrap only if even the smallest size won't fit)
  endpointsCard: { display: "flex", alignItems: "flex-end", gap: "12px 28px", flexWrap: "nowrap", paddingTop: "12px" },
  endpoint: { display: "flex", flexDirection: "column", gap: "6px", flex: "none", minWidth: 0 },
  endpointName: { fontSize: "54px", lineHeight: 1, letterSpacing: "-0.06em", color: "#2E0A14", whiteSpace: "nowrap" },
  parBadge: { fontSize: "28px", lineHeight: 1, letterSpacing: "-0.04em", color: "#7A1631", paddingBottom: "6px" },
  // Room for four rows of the path (44px each, 10px apart), so the steps line below doesn't move as it wraps
  progressSection: { display: "flex", flexDirection: "column", gap: "12px", minHeight: "206px" },
  movesSection: { display: "flex", flexDirection: "column", gap: 0, paddingTop: "12px" },
  inputLabel: { color: "#6B4A50", fontSize: "0.85rem" },
  // 12px under "Next step from…"; the connections follow the filter box directly
  inputRow: { display: "flex", gap: "0.5rem", width: "100%", marginTop: "12px" },
  input: { flex: 1, width: "100%", height: "56px", padding: 0, fontSize: "26px", letterSpacing: "-0.03em" },
  guessBtn: { padding: "0.5rem 1rem", border: "none", background: "#7A1631", color: "#F3ECE1", fontWeight: 500, cursor: "pointer" },
  movesList: { width: "100%", maxHeight: "420px", overflowY: "auto" },
  // A connection per row: a maroon edge (its distance's colour once the hint is used), 1px tint rules
  moveItem: { display: "flex", alignItems: "center", gap: "14px", width: "100%", minHeight: "56px", padding: "0 0 0 16px", background: "none", fontWeight: 500, border: "none", borderTop: "1px solid #D8CBBB", borderLeft: "6px solid transparent", color: "#2E0A14", cursor: "pointer", fontSize: "20px", letterSpacing: "-0.02em", textAlign: "left" },
  moveName: { flex: 1, minWidth: 0 },
  moveRel: { marginLeft: "auto", fontSize: "12px", letterSpacing: "0.1em", textTransform: "uppercase", color: "#6B4A50", whiteSpace: "nowrap", paddingRight: "4px" },
  moveArrow: { color: "#7A1631", fontSize: "18px", paddingRight: "12px" },
  noMoves: { color: "#6B4A50", fontSize: "15px", fontWeight: 400, padding: "14px 0", borderTop: "1px solid #D8CBBB" },
  guessList: { display: "flex", flexWrap: "wrap", gap: "10px 0", alignItems: "center" },
  guessStep: { display: "flex", alignItems: "center" },
  guessLabel: { color: "#6B4A50", fontSize: "0.8rem", width: "100%", marginBottom: "0.25rem" },
  guessChip: { display: "inline-flex", alignItems: "center", height: "36px", padding: "0 14px", border: "2px solid #2E0A14", fontSize: "15px", letterSpacing: "-0.01em", color: "#2E0A14", whiteSpace: "nowrap" },
  nextChip: { display: "inline-flex", alignItems: "center", height: "36px", padding: "0 14px", border: "2px dashed #6B4A50", fontSize: "15px", color: "#6B4A50" },
  chainArrow: { color: "#6B4A50", fontSize: "16px", padding: "0 8px" },
  // Give up: a text link
  revealBtn: { alignSelf: "flex-start", height: "44px", padding: "0 0 0 0", border: "none", background: "none", color: "#7A1631", cursor: "pointer", fontSize: "15px", fontWeight: 500, textDecoration: "underline", textUnderlineOffset: "4px" },
  pathActions: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "12px 20px" },
  hintBtn: { height: "40px", padding: "0 18px", border: "2px solid #1F7A74", background: "transparent", color: "#1F7A74", cursor: "pointer", fontSize: "15px", fontWeight: 500 },
  stepCount: { color: "#2E0A14", fontSize: "18px", fontWeight: 500 },
  stepsBold: { fontWeight: 700 },
  undoBtn: { height: "40px", padding: "0 18px", border: "2px solid #2E0A14", background: "transparent", color: "#2E0A14", cursor: "pointer", fontSize: "15px", fontWeight: 500 },
  revealSection: { display: "flex", flexDirection: "column", gap: "0.75rem" },
  wonSection: { display: "flex", flexDirection: "column", gap: "12px", width: "100%" },
  wonTitle: { color: "#7A1631", fontSize: "clamp(40px, 5.2vw, 76px)", lineHeight: 0.9, letterSpacing: "-0.065em", marginBottom: "10px" },
  wonDetail: { color: "#6B4A50", fontSize: "15px", fontWeight: 400 },
  chainDisplay: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 0" },
  chainItem: { display: "flex", alignItems: "center" },
  newGameBtn: { height: "48px", padding: "0 28px", border: "none", background: "#7A1631", color: "#F3ECE1", fontWeight: 500, cursor: "pointer", fontSize: "15px" },
  gameButtons: { display: "flex", flexWrap: "wrap", gap: "12px" },
  outlineBtn: { height: "48px", padding: "0 28px", border: "2px solid #2E0A14", background: "transparent", color: "#2E0A14", fontWeight: 500, cursor: "pointer", fontSize: "15px" },
  outlineBtnOn: { background: "#2E0A14", color: "#F3ECE1" },
  away: { color: "#7A1631" },
  shareBtn: { width: "40px", height: "40px", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, border: "2px solid #2E0A14", background: "transparent", color: "#2E0A14", cursor: "pointer" },
  resultButtons: { display: "flex", gap: "12px", flexWrap: "wrap", marginTop: "12px" },
  shareResultBtn: { height: "48px", padding: "0 28px", border: "none", background: "#7A1631", color: "#F3ECE1", fontWeight: 500, cursor: "pointer", fontSize: "15px" },
  // The custom game sheet (position, band and animation: .custom-sheet in index.css)
  customForm: { display: "flex", flexDirection: "column", gap: "20px" },
  // The sheet's fields and button at the site's usual sizes: Play's filter box, its Start game button (phones: index.css)
  customInput: { width: "100%", height: "48px", padding: 0, fontSize: "22px", letterSpacing: "-0.03em" },
  customStartBtn: { height: "48px", display: "flex", alignItems: "center", padding: "0 20px", border: "none", background: "#7A1631", color: "#F3ECE1", fontWeight: 500, fontSize: "15px", cursor: "pointer", textAlign: "left" },
  customHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "-8px" },
  customClose: { background: "none", border: "none", color: "#2E0A14", fontSize: "1.75rem", lineHeight: 1, cursor: "pointer", minWidth: "44px", minHeight: "44px", marginRight: "-12px" },
  customHint: { color: "#2E0A14", fontSize: "16px", fontWeight: 400, lineHeight: 1.4, maxWidth: "420px" },
  customError: { color: "#7A1631", fontSize: "15px" },
  startBtn: { height: "64px", marginTop: "16px", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px", border: "none", background: "#7A1631", color: "#F3ECE1", fontWeight: 500, fontSize: "20px", cursor: "pointer", textAlign: "left" },
};
