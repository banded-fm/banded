import { describe, expect, it } from "vitest";
import { walkGame, walkKey, type WalkSources } from "../game/walk";
import type { Neighbor } from "../db/graphSource";

const n = (id: string, name: string): Neighbor => ({ node: { id, name, type: "person" }, relType: "collaborated_with", outgoing: true });
const GRAPH: Record<string, Neighbor[]> = {
  a: [n("b", "Bee"), n("c", "Cee")],
  b: [n("a", "Ay"), n("d", "Dee")],
  c: [n("a", "Ay")],
  d: [n("b", "Bee"), n("e", "Ee")],
};

function sources(over: Partial<WalkSources> = {}): WalkSources {
  return {
    neighbors: async (id) => GRAPH[id] ?? [],
    serverNeighbors: async () => [],
    inLocal: () => false,
    byName: () => null,
    ...over,
  };
}

describe("walkGame", () => {
  it("starts with the start's moves", async () => {
    const w = await walkGame("a", [], sources());
    expect(w.ids).toEqual(["a"]);
    expect(w.neighbors.map((x) => x.node.id)).toEqual(["b", "c"]);
    expect(w.key).toBe(walkKey("a", []));
  });

  it("follows each guess through the neighbors of the artist before it, ignoring case", async () => {
    const w = await walkGame("a", ["bee", "Dee"], sources());
    expect(w.ids).toEqual(["a", "b", "d"]);
    expect(w.neighbors.map((x) => x.node.id)).toEqual(["b", "e"]);
  });

  it("finds a move the server offered that the local graph doesn't have", async () => {
    const w = await walkGame("a", ["Zed"], sources({
      inLocal: () => true,
      serverNeighbors: async (id) => (id === "a" ? [n("z", "Zed")] : []),
    }));
    expect(w.ids).toEqual(["a", "z"]);
  });

  it("falls back to a name lookup, and stops with no moves when a guess can't be followed", async () => {
    expect((await walkGame("a", ["Ee"], sources({ byName: (name) => (name === "Ee" ? n("e", "Ee").node : null) }))).ids).toEqual(["a", "e"]);
    const lost = await walkGame("a", ["Nobody", "Bee"], sources());
    expect(lost.ids).toEqual(["a"]);
    expect(lost.neighbors).toEqual([]);
  });
});
