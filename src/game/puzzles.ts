/**
 * The daily Six Degrees puzzles (puzzles.json, generated as PUZZLES.md explains).
 * Day 0 is DAILY_START; after the last puzzle the list starts again.
 * The file stores each puzzle's start, end and the artists in between on its
 * closest connection through known artists; par (that connection's hops) and the
 * full path, start and end included, are worked out here.
 */

import data from "./puzzles.json";

export interface PuzzleArtist {
  id: string;
  name: string;
  type: "person" | "group";
}

export interface Puzzle {
  start: PuzzleArtist;
  end: PuzzleArtist;
  /** Hops on the par path: the artists in between plus one. */
  par: number;
  /** The par path, start and end included (shown when the player reveals it). */
  path: PuzzleArtist[];
}

interface StoredPuzzle {
  start: PuzzleArtist;
  end: PuzzleArtist;
  /** The artists in between, in order. */
  path: PuzzleArtist[];
}

export const PUZZLES: Puzzle[] = (data.puzzles as StoredPuzzle[]).map((p) => ({
  start: p.start,
  end: p.end,
  par: p.path.length + 1,
  path: [p.start, ...p.path, p.end],
}));

/** The first daily puzzle's date (local time). */
export const DAILY_START = "2026-11-06";

/** A date as YYYY-MM-DD in local time. */
export function localDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole days from DAILY_START to `date` (both YYYY-MM-DD). */
export function dayNumber(date: string): number {
  const ms = Date.UTC(...ymd(date)) - Date.UTC(...ymd(DAILY_START));
  return Math.round(ms / 86_400_000);
}

function ymd(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [y, m - 1, d];
}

/** The puzzle for a date (today by default). Dates before DAILY_START count back from the end. */
export function dailyPuzzle(date: string = localDate()): Puzzle {
  const n = PUZZLES.length;
  return PUZZLES[((dayNumber(date) % n) + n) % n]!;
}

/** The listed puzzle with these endpoints (either way round), if there is one. */
export function findPuzzle(startId: string, endId: string): Puzzle | undefined {
  return PUZZLES.find((p) => (p.start.id === startId && p.end.id === endId) || (p.start.id === endId && p.end.id === startId));
}

/** A puzzle from the list at random, other than `except`. */
export function randomPuzzle(except?: Puzzle): Puzzle {
  if (PUZZLES.length === 1) return PUZZLES[0]!;
  for (;;) {
    const p = PUZZLES[Math.floor(Math.random() * PUZZLES.length)]!;
    if (p !== except) return p;
  }
}
