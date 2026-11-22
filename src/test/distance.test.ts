import { describe, expect, it } from "vitest";
import { awayLabel, bfsDistances, bfsDistancesAsync } from "../game/distance";

// a - b - c - d - e, and a - x
const edges: Record<string, string[]> = { a: ["b", "x"], b: ["a", "c"], c: ["b", "d"], d: ["c", "e"], e: ["d"], x: ["a"] };

describe("bfsDistances", () => {
  it("counts the steps from the start, up to the depth asked for", () => {
    const d = bfsDistances("a", (id) => edges[id] ?? [], 3);
    expect(Object.fromEntries(d)).toEqual({ a: 0, b: 1, x: 1, c: 2, d: 3 });
  });
});

describe("bfsDistancesAsync", () => {
  it("gives the same distances, yielding between slices", async () => {
    let yields = 0;
    const d = await bfsDistancesAsync("a", (id) => edges[id] ?? [], 3, { sliceMs: -1, yieldFn: async () => { yields++; } });
    expect(Object.fromEntries(d!)).toEqual({ a: 0, b: 1, x: 1, c: 2, d: 3 });
    expect(yields).toBeGreaterThan(0);
  });

  it("stops when aborted", async () => {
    const ac = new AbortController();
    const d = await bfsDistancesAsync("a", (id) => edges[id] ?? [], 3, { signal: ac.signal, sliceMs: -1, yieldFn: async () => ac.abort() });
    expect(d).toBeNull();
  });
});

describe("awayLabel", () => {
  it("says how far, or that it's further than looked", () => {
    expect(awayLabel(2)).toBe("2 away");
    expect(awayLabel(undefined)).toBe("4+ away");
  });
});
