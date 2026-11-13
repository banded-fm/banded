import { describe, expect, it } from "vitest";
import { awayLabel, bfsDistances } from "../game/distance";

// a - b - c - d - e, and a - x
const edges: Record<string, string[]> = { a: ["b", "x"], b: ["a", "c"], c: ["b", "d"], d: ["c", "e"], e: ["d"], x: ["a"] };

describe("bfsDistances", () => {
  it("counts the steps from the start, up to the depth asked for", () => {
    const d = bfsDistances("a", (id) => edges[id] ?? [], 3);
    expect(Object.fromEntries(d)).toEqual({ a: 0, b: 1, x: 1, c: 2, d: 3 });
  });
});

describe("awayLabel", () => {
  it("says how far, or that it's further than looked", () => {
    expect(awayLabel(2)).toBe("2 away");
    expect(awayLabel(undefined)).toBe("4+ away");
  });
});
