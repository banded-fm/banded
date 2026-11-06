import { describe, expect, it } from "vitest";
import { DAILY_START, PUZZLES, dailyPuzzle, dayNumber, findPuzzle, localDate } from "../game/puzzles";

describe("daily puzzles", () => {
  it("lists about three years of puzzles, each a 3-5 hop connection whose path matches its par", () => {
    expect(PUZZLES.length).toBeGreaterThanOrEqual(1000);
    for (const p of PUZZLES) {
      expect(p.par).toBeGreaterThanOrEqual(3);
      expect(p.par).toBeLessThanOrEqual(5);
      expect(p.path.length - 1).toBe(p.par);
      expect(p.path[0]!.id).toBe(p.start.id);
      expect(p.path[p.path.length - 1]!.id).toBe(p.end.id);
      expect(new Set(p.path.map((a) => a.id)).size).toBe(p.path.length);
    }
    const pairs = new Set(PUZZLES.map((p) => [p.start.id, p.end.id].sort().join("|")));
    expect(pairs.size).toBe(PUZZLES.length);
  });

  it("gives day 0 on DAILY_START, the next puzzle the next day, and wraps around", () => {
    expect(dayNumber(DAILY_START)).toBe(0);
    expect(dayNumber("2026-11-07")).toBe(1);
    expect(dailyPuzzle(DAILY_START)).toBe(PUZZLES[0]);
    expect(dailyPuzzle("2026-11-07")).toBe(PUZZLES[1]);
    expect(dailyPuzzle("2026-11-05")).toBe(PUZZLES[PUZZLES.length - 1]);
    expect(dayNumber("2027-03-28") - dayNumber("2027-03-27")).toBe(1);   // across a clock change
  });

  it("formats local dates and finds a puzzle by its endpoints either way round", () => {
    expect(localDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    const p = PUZZLES[0]!;
    expect(findPuzzle(p.start.id, p.end.id)).toBe(p);
    expect(findPuzzle(p.end.id, p.start.id)).toBe(p);
    expect(findPuzzle("x", "y")).toBeUndefined();
  });
});
