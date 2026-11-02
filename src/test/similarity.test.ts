import { describe, it, expect } from "vitest";
import {
  computeSimilarity,
  aggregateScore,
  strongestPaths,
  connect,
  PathSearch,
  scoreArtistsAgainstList,
  pathStrength,
  pathLength,
  HOP_DISTANCE,
  HUB_DAMPED,
  REPEATS,
  repeatWeight,
  reversePath,
  relWeight,
  REL_WEIGHTS,
  DEFAULT_REL_WEIGHT,
  REL_DISTANCES,
  relDistance,
  HOP_DAMPING,
  MAX_HOPS,
  MIN_STRENGTH,
  strengthScore,
  pendingPairs,
  mergePairs,
  type GraphAccess,
  type SimNode,
  type SimNeighbor,
  type PairScore,
  type PathStep,
} from "../pages/similarity";

/**
 * In-memory fake graph for testing the scorer without sql.js.
 *
 * Model a small garage-psych slice with band ties AND album credits:
 *   Ty Segall  --member_of--> Fuzz <--member_of-- Charles Moothart
 *   Ty Segall  --member_of--> GOGGS
 *   Charles Moothart --former_member_of--> CFM
 *   Ty Segall  --producer--> AlbumA <--instrument-- Mikal Cronin
 *   Charles Moothart --recording--> AlbumA   (so Ty & Charles share AlbumA)
 *   Osees (isolated)
 */
function makeGraph(): GraphAccess {
  const nodes: Record<string, SimNode> = {
    ty: { id: "ty", name: "Ty Segall", type: "person" },
    charles: { id: "charles", name: "Charles Moothart", type: "person" },
    mikal: { id: "mikal", name: "Mikal Cronin", type: "person" },
    fuzz: { id: "fuzz", name: "Fuzz", type: "group" },
    goggs: { id: "goggs", name: "GOGGS", type: "group" },
    cfm: { id: "cfm", name: "CFM", type: "group" },
    osees: { id: "osees", name: "Osees", type: "group" },
    albumA: { id: "albumA", name: "Album A", type: "album" },
  };

  // Directed edges (source -> target, relType). neighbors() returns both dirs.
  const edges: Array<[string, string, string]> = [
    ["ty", "fuzz", "member_of"],
    ["charles", "fuzz", "member_of"],
    ["ty", "goggs", "member_of"],
    ["charles", "cfm", "former_member_of"],
    ["ty", "albumA", "producer"],
    ["mikal", "albumA", "instrument"],
    ["charles", "albumA", "recording"],
  ];

  return {
    findNodeByName(name: string): SimNode | null {
      return Object.values(nodes).find((n) => n.name.toLowerCase() === name.toLowerCase()) ?? null;
    },
    neighbors(nodeId: string): SimNeighbor[] {
      const out: SimNeighbor[] = [];
      for (const [s, t, rel] of edges) {
        if (s === nodeId) out.push({ node: nodes[t]!, relType: rel, outgoing: true });
        if (t === nodeId) out.push({ node: nodes[s]!, relType: rel, outgoing: false });
      }
      return out;
    },
  };
}

describe("relWeight", () => {
  it("ranks member_of > former_member_of > support_musician", () => {
    expect(REL_WEIGHTS.member_of).toBeGreaterThan(REL_WEIGHTS.former_member_of!);
    expect(REL_WEIGHTS.former_member_of).toBeGreaterThan(REL_WEIGHTS.support_musician!);
  });

  it("ranks band ties above album-credit ties", () => {
    expect(relWeight("support_musician")).toBeGreaterThan(relWeight("producer"));
  });

  it("falls back to the default weight for unknown types", () => {
    expect(relWeight("totally_unknown")).toBe(DEFAULT_REL_WEIGHT);
  });

  it("stores each weight as an edge length, -ln(weight)", () => {
    expect(REL_DISTANCES.member_of).toBe(0);
    expect(REL_DISTANCES.produced_for).toBeCloseTo(-Math.log(0.3));
    expect(relDistance("totally_unknown")).toBeCloseTo(-Math.log(DEFAULT_REL_WEIGHT));
  });
});

describe("computeSimilarity", () => {
  it("returns targetFound=false for an unknown artist", () => {
    const g = makeGraph();
    const res = computeSimilarity(g, "Nonexistent Band", ["Ty Segall"]);
    expect(res.targetFound).toBe(false);
    expect(res.overallScore).toBe(0);
  });

  it("scores an identical target as 100", () => {
    const g = makeGraph();
    const res = computeSimilarity(g, "Ty Segall", ["Ty Segall"]);
    expect(res.pairs[0]!.score).toBe(100);
  });

  it("scores bandmates through their band at 100: two hops are free", () => {
    const res = computeSimilarity(makeGraph(), "Charles Moothart", ["Ty Segall"]);
    const ty = res.pairs[0]!;
    expect(ty.score).toBe(100);
    expect(ty.path!.map((s) => s.to.name)).toEqual(["Fuzz", "Charles Moothart"]);
  });

  it("follows album credits too, but they're weak (Mikal only shares Album A with Ty)", () => {
    const ty = computeSimilarity(makeGraph(), "Mikal Cronin", ["Ty Segall"]).pairs[0]!;
    // instrument 0.35 x producer 0.4 (two hops: no damping)
    expect(ty.strength).toBeCloseTo(0.35 * 0.4);
    expect(ty.score).toBe(14);
  });

  it("scores an unconnected artist (Osees) at zero", () => {
    const res = computeSimilarity(makeGraph(), "Osees", ["Ty Segall", "Charles Moothart"]);
    expect(res.overallScore).toBe(0);
    for (const p of res.pairs) {
      expect(p.distance).toBe(null);
      expect(p.path).toBe(null);
    }
  });

  it("ranks a band-tied target above an album-only-tied one", () => {
    const list = ["Ty Segall"];
    expect(computeSimilarity(makeGraph(), "Charles Moothart", list).overallScore).toBeGreaterThan(
      computeSimilarity(makeGraph(), "Mikal Cronin", list).overallScore
    );
  });

  it("marks list artists that aren't in the graph as not found", () => {
    const g = makeGraph();
    const res = computeSimilarity(g, "Ty Segall", ["Charles Moothart", "Unknown Artist"]);
    const unknown = res.pairs.find((p) => p.name === "Unknown Artist")!;
    expect(unknown.found).toBe(false);
    expect(unknown.score).toBe(0);
  });

  it("sorts the breakdown strongest-first", () => {
    const g = makeGraph();
    const res = computeSimilarity(g, "Charles Moothart", ["Osees", "Ty Segall"]);
    expect(res.pairs[0]!.name).toBe("Ty Segall");
    expect(res.pairs[res.pairs.length - 1]!.name).toBe("Osees");
  });
});

describe("aggregateScore", () => {
  const mk = (name: string, score: number, found = true): PairScore => ({
    name,
    found,
    distance: found ? 1 : null,
    score,
  });

  it("returns 0 when no pairs were found", () => {
    expect(aggregateScore([mk("a", 0, false), mk("b", 0, false)])).toBe(0);
  });

  it("is the best match when the others match weakly: they don't pull it down", () => {
    // Iguana Death Cult: Tim Hellman 77, Fuzz 18 -> 77 (was 65 with best/average)
    expect(aggregateScore([mk("a", 77), mk("b", 18)])).toBe(77);
    expect(aggregateScore([mk("a", 80), mk("b", 59)])).toBe(80);
  });

  it("adds a diminishing bonus for each other good match", () => {
    expect(aggregateScore([mk("a", 77), mk("b", 60)])).toBe(92); // 77 + 0.25*60
    expect(aggregateScore([mk("a", 70), mk("b", 60), mk("c", 60)])).toBe(93); // 70 + 15 + 7.5
    expect(aggregateScore([mk("c", 60), mk("a", 70), mk("b", 10), mk("d", 60)])).toBe(93); // order doesn't matter
    expect(aggregateScore([mk("a", 50), mk("b", 40), mk("c", 40)])).toBe(50); // under 60: no bonus
  });

  it("caps at 100", () => {
    expect(aggregateScore([mk("a", 95), mk("b", 90), mk("c", 90)])).toBe(100);
  });

  it("never drops when an artist is added to the list", () => {
    const base = [mk("a", 70), mk("b", 65)];
    for (const extra of [0, 20, 59, 60, 80]) {
      expect(aggregateScore([...base, mk("x", extra)])).toBeGreaterThanOrEqual(aggregateScore(base));
    }
  });

  it("ignores not-found pairs in the aggregate", () => {
    expect(aggregateScore([mk("a", 60), mk("b", 0, false)])).toBe(60);
  });
});

/**
 * Concert ties from banded-data ("opened_for", opener -> headliner):
 *   Flat Worms --opened_for--> Iguana Death Cult
 *   Flat Worms --opened_for--> Osees <--member_of-- John Dwyer
 *   Earth Tongue --opened_for--> Osees
 */
function makeConcertGraph(): GraphAccess {
  const nodes: Record<string, SimNode> = {
    fw: { id: "fw", name: "Flat Worms", type: "group" },
    idc: { id: "idc", name: "Iguana Death Cult", type: "group" },
    osees: { id: "osees", name: "Osees", type: "group" },
    dwyer: { id: "dwyer", name: "John Dwyer", type: "person" },
    et: { id: "et", name: "Earth Tongue", type: "group" },
  };
  const edges: Array<[string, string, string]> = [
    ["fw", "idc", "opened_for"],
    ["fw", "osees", "opened_for"],
    ["dwyer", "osees", "member_of"],
    ["et", "osees", "opened_for"],
  ];
  return {
    findNodeByName: (name) => Object.values(nodes).find((n) => n.name === name) ?? null,
    neighbors(nodeId) {
      const out: SimNeighbor[] = [];
      for (const [s, t, rel] of edges) {
        if (s === nodeId) out.push({ node: nodes[t]!, relType: rel, outgoing: true });
        if (t === nodeId) out.push({ node: nodes[s]!, relType: rel, outgoing: false });
      }
      return out;
    },
  };
}

describe("opened_for (concert ties)", () => {
  it("weighs below band membership and above producing", () => {
    expect(relWeight("opened_for")).toBeLessThan(relWeight("former_member_of"));
    expect(relWeight("opened_for")).toBeGreaterThan(relWeight("produced_for"));
  });

  it("connects an opener to the headliner it opened for", () => {
    const pair = computeSimilarity(makeConcertGraph(), "Iguana Death Cult", ["Flat Worms"]).pairs[0]!;
    expect(pair.path!.map((s) => s.relType)).toEqual(["opened_for"]);
    expect(pair.score).toBe(80);
  });

  it("connects two openers of the same headliner, two weak hops", () => {
    const pair = computeSimilarity(makeConcertGraph(), "Earth Tongue", ["Flat Worms"]).pairs[0]!;
    expect(pair.path!.map((s) => s.to.name)).toEqual(["Osees", "Earth Tongue"]);
    expect(pair.strength).toBeCloseTo(0.8 * 0.8);
  });

  it("is only as strong as every hop together: member x opened_for", () => {
    const pair = computeSimilarity(makeConcertGraph(), "John Dwyer", ["Flat Worms"]).pairs[0]!;
    expect(pair.strength).toBeCloseTo(1.0 * 0.8);
  });
});

describe("collaborations (credits on another artist's records)", () => {
  it("weigh below membership; producing weighs least", () => {
    expect(relWeight("collaborated_with")).toBeLessThan(relWeight("former_member_of"));
    expect(relWeight("produced_for")).toBeLessThan(relWeight("collaborated_with"));
  });
});

describe("the path behind a pair (shown in its bottom sheet)", () => {
  it("runs from the liked artist to the compared one, with each edge's direction", () => {
    // Liked: Charles Moothart; compared: GOGGS. Charles is in Fuzz, Ty is in Fuzz and GOGGS.
    const res = computeSimilarity(makeGraph(), "GOGGS", ["Charles Moothart"]);
    const pair = res.pairs[0]!;
    expect(pair.node?.name).toBe("Charles Moothart");
    expect(res.target?.name).toBe("GOGGS");
    expect(pair.distance).toBe(pair.path!.length);
    const steps = pair.path!.map((s) => [s.from.name, s.relType, s.to.name, s.fromIsSource]);
    expect(steps[0]![0]).toBe("Charles Moothart");
    // Every hop continues where the last one ended.
    pair.path!.forEach((s, i) => {
      if (i > 0) expect(s.from.id).toBe(pair.path![i - 1]!.to.id);
    });
    // The last hop is Ty Segall -> GOGGS, read the way the edge points.
    expect(steps[steps.length - 1]).toEqual(["Ty Segall", "member_of", "GOGGS", true]);
  });

  it("scores 100 x the path's strength", () => {
    const pair = computeSimilarity(makeGraph(), "GOGGS", ["Charles Moothart"]).pairs[0]!;
    expect(pair.strength).toBeCloseTo(pathStrength(pair.path!));
    expect(pair.score).toBe(Math.round(pair.strength! * 100));
    expect(pair.score).toBe(90); // member x3: one hop past the two free ones
  });

  it("is empty for the same artist and null when unreachable", () => {
    expect(computeSimilarity(makeGraph(), "Ty Segall", ["Ty Segall"]).pairs[0]!.path).toEqual([]);
    expect(computeSimilarity(makeGraph(), "Osees", ["Ty Segall"]).pairs[0]!.path).toBeNull();
  });

  it("reverses a path hop by hop, flipping each direction", () => {
    const g = makeGraph();
    const ty = g.findNodeByName("Ty Segall")!;
    const path = strongestPaths(g, ty, new Set(["cfm"])).get("cfm")!;
    expect(path.map((s) => s.to.name)).toEqual(["Fuzz", "Charles Moothart", "CFM"]);
    const back = reversePath(path);
    expect(back.map((s) => [s.from.name, s.to.name, s.fromIsSource])).toEqual([
      ["CFM", "Charles Moothart", false],
      ["Charles Moothart", "Fuzz", true],
      ["Fuzz", "Ty Segall", false],
    ]);
  });
});

describe("artists picked from the dropdown (by MusicBrainz ID)", () => {
  /** Two artists named Fuzz: the band Ty Segall is in, and an unrelated bassist listed first. */
  function twoFuzzes(): GraphAccess {
    const nodes: SimNode[] = [
      { id: "fuzz-bassist", name: "Fuzz", type: "person" },
      { id: "fuzz-band", name: "Fuzz", type: "group" },
      { id: "ty", name: "Ty Segall", type: "person" },
      { id: "disturbed", name: "Disturbed", type: "group" },
    ];
    const edges: Array<[string, string, string]> = [
      ["ty", "fuzz-band", "member_of"],
      ["fuzz-bassist", "disturbed", "former_member_of"],
    ];
    const byId = (id: string) => nodes.find((n) => n.id === id) ?? null;
    return {
      findNodeByName: (name) => nodes.find((n) => n.name.toLowerCase() === name.toLowerCase()) ?? null,
      findNodeById: byId,
      neighbors(id) {
        const out: SimNeighbor[] = [];
        for (const [s, t, rel] of edges) {
          if (s === id) out.push({ node: byId(t)!, relType: rel, outgoing: true });
          if (t === id) out.push({ node: byId(s)!, relType: rel, outgoing: false });
        }
        return out;
      },
    };
  }

  it("scores the picked artist, not the first one with its name", () => {
    const byName = computeSimilarity(twoFuzzes(), "Ty Segall", ["Fuzz"]).pairs[0]!;
    expect(byName.node?.id).toBe("fuzz-bassist");
    expect(byName.path).toBeNull();

    const picked = computeSimilarity(twoFuzzes(), "Ty Segall", [{ name: "Fuzz", id: "fuzz-band" }]).pairs[0]!;
    expect(picked.node?.id).toBe("fuzz-band");
    expect(picked.distance).toBe(1);
    expect(picked.score).toBe(100);
  });

  it("resolves a picked target by ID too", () => {
    const res = computeSimilarity(twoFuzzes(), { name: "Fuzz", id: "fuzz-band" }, ["Ty Segall"]);
    expect(res.target?.id).toBe("fuzz-band");
  });

  it("doesn't fall back to the name when the picked ID isn't in the graph", () => {
    const res = computeSimilarity(twoFuzzes(), "Ty Segall", [{ name: "Fuzz", id: "not-in-graph" }]);
    expect(res.pairs[0]).toMatchObject({ name: "Fuzz", found: false });
  });
});

describe("strongest paths", () => {
  /** A short weak route (A -produced_for- B) and a longer strong one (A -member- X -member- Y -member- B). */
  function routes(): GraphAccess {
    const n = (id: string): SimNode => ({ id, name: id.toUpperCase(), type: "group" });
    const edges: Array<[string, string, string]> = [
      ["a", "b", "produced_for"],
      ["a", "x", "member_of"],
      ["x", "y", "member_of"],
      ["y", "b", "member_of"],
    ];
    return {
      findNodeByName: (name) => (["a", "b", "x", "y"].includes(name.toLowerCase()) ? n(name.toLowerCase()) : null),
      neighbors(id) {
        const out: SimNeighbor[] = [];
        for (const [s, t, rel] of edges) {
          if (s === id) out.push({ node: n(t), relType: rel, outgoing: true });
          if (t === id) out.push({ node: n(s), relType: rel, outgoing: false });
        }
        return out;
      },
    };
  }

  it("prefers a longer path of strong ties over a short weak one", () => {
    const pair = computeSimilarity(routes(), "A", ["B"]).pairs[0]!;
    expect(pair.distance).toBe(3);
    expect(pair.score).toBe(90); // 1 x 1 x 1 x 0.9, beats produced_for's 30
  });

  it("damps every hop after the first two by HOP_DAMPING", () => {
    const blank = { id: "", name: "", type: "" };
    const step = (relType: string) => ({ from: blank, to: blank, relType, weight: relWeight(relType) });
    expect(pathStrength([])).toBe(1);
    expect(pathStrength([step("produced_for")])).toBeCloseTo(0.3);
    expect(pathStrength([step("member_of"), step("produced_for")])).toBeCloseTo(0.3);
    expect(pathStrength([step("member_of"), step("member_of"), step("produced_for")])).toBeCloseTo(0.3 * HOP_DAMPING);
    expect(pathStrength([step("member_of"), step("member_of"), step("member_of"), step("produced_for")])).toBeCloseTo(0.3 * HOP_DAMPING ** 2);
    expect(pathLength([step("member_of"), step("member_of"), step("produced_for")])).toBeCloseTo(-Math.log(0.3) + HOP_DISTANCE);
  });

  it("doesn't follow paths past MAX_HOPS", () => {
    const chain = Array.from({ length: MAX_HOPS + 2 }, (_, i) => `n${i}`);
    const node = (id: string): SimNode => ({ id, name: id, type: "group" });
    const g: GraphAccess = {
      findNodeByName: (name) => (chain.includes(name) ? node(name) : null),
      neighbors(id) {
        const i = chain.indexOf(id);
        return [chain[i - 1], chain[i + 1]].filter((x): x is string => !!x).map((x) => ({ node: node(x), relType: "member_of" }));
      },
    };
    const res = computeSimilarity(g, "n0", [chain[MAX_HOPS]!, chain[MAX_HOPS + 1]!]);
    expect(res.pairs.find((p) => p.name === chain[MAX_HOPS])!.distance).toBe(MAX_HOPS);
    expect(res.pairs.find((p) => p.name === chain[MAX_HOPS + 1])!.path).toBeNull();
  });

  it("carries each hop's weight", () => {
    const path = computeSimilarity(makeConcertGraph(), "John Dwyer", ["Flat Worms"]).pairs[0]!.path!;
    expect(path.map((s) => s.weight)).toEqual([REL_WEIGHTS.opened_for, REL_WEIGHTS.member_of]);
    expect(reversePath(reversePath(path))).toEqual(path);
  });

});

describe("hub damping", () => {
  /**
   * Fan played on a Star's records and on an Indie band's. Star has 140 collaborators
   * (10x the typical 14); Indie has 3. Opener opened for Star (never damped).
   */
  function hubGraph(withDegree = true): GraphAccess {
    const n = (id: string): SimNode => ({ id, name: id, type: "group" });
    const edges: Array<[string, string, string]> = [
      ["Fan", "Star", "collaborated_with"],
      ["Fan", "Indie", "collaborated_with"],
      ["Opener", "Star", "opened_for"],
      ["Member", "Star", "member_of"],
    ];
    const degrees: Record<string, number> = { "Star|collaborated_with": 140, "Fan|collaborated_with": 2, "Indie|collaborated_with": 3 };
    return {
      findNodeByName: (name) => n(name),
      neighbors(id) {
        const out: SimNeighbor[] = [];
        for (const [s, t, rel] of edges) {
          if (s === id) out.push({ node: n(t), relType: rel, outgoing: true });
          if (t === id) out.push({ node: n(s), relType: rel, outgoing: false });
        }
        return out;
      },
      ...(withDegree ? { degree: (id: string, rel: string) => degrees[`${id}|${rel}`] ?? 1 } : {}),
    };
  }

  it("weakens a collaboration with an artist who has many collaborators", () => {
    const g = hubGraph();
    const star = computeSimilarity(g, "Fan", ["Star"]).pairs[0]!;
    const indie = computeSimilarity(g, "Fan", ["Indie"]).pairs[0]!;
    expect(indie.score).toBe(80);
    expect(star.score).toBe(8); // 0.8 x 14/140
    const step = star.path![0]!;
    expect(step).toMatchObject({ baseWeight: 0.8, hubs: [{ node: { id: "Star" }, count: 140 }] });
    expect(step.weight).toBeCloseTo(0.08);
    expect(pathStrength(star.path!)).toBeCloseTo(0.08);
  });

  it("never damps memberships or opened_for", () => {
    expect(Object.keys(HUB_DAMPED)).not.toContain("member_of");
    expect(Object.keys(HUB_DAMPED)).not.toContain("former_member_of");
    expect(Object.keys(HUB_DAMPED)).not.toContain("opened_for");
    const g = hubGraph();
    expect(computeSimilarity(g, "Opener", ["Star"]).pairs[0]!.score).toBe(80);
    expect(computeSimilarity(g, "Member", ["Star"]).pairs[0]!.score).toBe(100);
  });

  it("doesn't damp when the graph can't count links", () => {
    expect(computeSimilarity(hubGraph(false), "Fan", ["Star"]).pairs[0]!.score).toBe(80);
  });
});

describe("repeats (song credits, shows)", () => {
  it("makes a frequent collaborator closer than a one-time one", () => {
    expect(repeatWeight("collaborated_with", 1)).toBe(0.8);
    expect(repeatWeight("collaborated_with")).toBe(0.8); // unknown count = once
    expect(repeatWeight("collaborated_with", 2)).toBeCloseTo(0.84);
    expect(repeatWeight("collaborated_with", 3)).toBeCloseTo(0.872);
    expect(repeatWeight("collaborated_with", 10)).toBeCloseTo(1 - 0.2 * 0.8 ** 9);
    expect(repeatWeight("produced_for", 1)).toBe(0.3);
    expect(repeatWeight("produced_for", 5)).toBeCloseTo(0.455, 2);
    expect(repeatWeight("produced_for", 12)).toBeCloseTo(0.609, 2); // an album
    expect(repeatWeight("produced_for", 24)).toBeCloseTo(0.71, 2);
  });

  it("never lets producing reach any other relationship's one-time weight", () => {
    const others = Object.entries(REL_WEIGHTS)
      .filter(([t]) => ["member_of", "former_member_of", "support_musician", "collaborated_with", "opened_for"].includes(t))
      .map(([, w]) => w);
    expect(repeatWeight("produced_for", 100000)).toBeLessThan(Math.min(...others));
    expect(repeatWeight("collaborated_with", 50)).toBeLessThanOrEqual(1);
  });

  it("treats opening twice like opening 400 times, and once as already close", () => {
    expect(repeatWeight("opened_for", 1)).toBe(0.8);
    expect(repeatWeight("opened_for", 2)).toBe(0.9);
    expect(repeatWeight("opened_for", 400)).toBe(0.9);
    expect("repeated" in REPEATS.opened_for!).toBe(true);
  });

  it("leaves memberships alone", () => {
    expect(repeatWeight("member_of", 5)).toBe(1);
    expect(repeatWeight("former_member_of", 5)).toBe(0.85);
  });

  it("scores a pair with the repeat-adjusted weight, before hub damping", () => {
    const n = (id: string): SimNode => ({ id, name: id, type: "group" });
    const edges: Array<[string, string, string, number]> = [
      ["Session", "Band", "collaborated_with", 10],
      ["Guest", "Band", "collaborated_with", 1],
      ["Opener", "Headliner", "opened_for", 3],
    ];
    const g: GraphAccess = {
      findNodeByName: (name) => n(name),
      neighbors(id) {
        const out: SimNeighbor[] = [];
        for (const [s, t, rel, count] of edges) {
          if (s === id) out.push({ node: n(t), relType: rel, outgoing: true, count });
          if (t === id) out.push({ node: n(s), relType: rel, outgoing: false, count });
        }
        return out;
      },
    };
    const session = computeSimilarity(g, "Session", ["Band"]).pairs[0]!;
    const guest = computeSimilarity(g, "Guest", ["Band"]).pairs[0]!;
    expect(session.score).toBe(97);
    expect(guest.score).toBe(80);
    expect(session.path![0]).toMatchObject({ count: 10 });
    expect(session.path![0]!.baseWeight).toBeCloseTo(repeatWeight("collaborated_with", 10));
    expect(computeSimilarity(g, "Opener", ["Headliner"]).pairs[0]!.score).toBe(90);
  });
});

describe("weak paths", () => {
  /** Fan played on Mid's records; Mid played on two big stars' records: Star (300 collaborators) and Mega (1,400). */
  function weakGraph(): GraphAccess {
    const n = (id: string): SimNode => ({ id, name: id, type: "person" });
    const edges: Array<[string, string]> = [["Fan", "Mid"], ["Mid", "Star"], ["Mid", "Mega"]];
    const degrees: Record<string, number> = { Star: 300, Mega: 1400 };
    return {
      findNodeByName: (name) => n(name),
      neighbors(id) {
        const out: SimNeighbor[] = [];
        for (const [s, t] of edges) {
          if (s === id) out.push({ node: n(t), relType: "collaborated_with", outgoing: true });
          if (t === id) out.push({ node: n(s), relType: "collaborated_with", outgoing: false });
        }
        return out;
      },
      degree: (id) => degrees[id] ?? 2,
    };
  }

  it("scores 0 under MIN_STRENGTH (a score of 2)", () => {
    expect(MIN_STRENGTH).toBe(0.02);
    expect(strengthScore(0.0199)).toBe(0);
    expect(strengthScore(0.02)).toBe(2);
    expect(strengthScore(0.026)).toBe(3);
  });

  it("scores a path between 2 and 5 instead of dropping it", () => {
    // 0.8 x 0.8 x 14/300 = 0.03
    const star = computeSimilarity(weakGraph(), "Star", ["Fan"]).pairs[0]!;
    expect(star.strength).toBeCloseTo(0.8 * 0.8 * (14 / 300));
    expect(star.score).toBe(3);
  });

  it("still finds the closest connection of a pair scoring 0 when asked to look further", () => {
    // 0.8 x 0.8 x 14/1400 = 0.0064: scores 0
    const deep = computeSimilarity(weakGraph(), "Mega", ["Fan"], { closest: true }).pairs[0]!;
    expect(deep.score).toBe(0);
    expect(deep.strength).toBeCloseTo(0.0064);
    expect(deep.path!.map((s) => s.to.name)).toEqual(["Mid", "Mega"]);
    // Ranking (the default) doesn't look that far
    const ranked = computeSimilarity(weakGraph(), "Mega", ["Fan"]).pairs[0]!;
    expect(ranked.score).toBe(0);
    expect(ranked.path).toBe(null);
  });

  it("finds a path that a search from the hub's end alone runs out of budget for, either way round", () => {
    // Hub's own search spends its whole budget on its 12,000 fans before it reaches Small
    const n = (id: string): SimNode => ({ id, name: id, type: "person" });
    const fans = Array.from({ length: 12000 }, (_, i) => `fan${i}`);
    const g: GraphAccess = {
      findNodeByName: (name) => n(name),
      neighbors(id) {
        const nb = (to: string, rel: string): SimNeighbor => ({ node: n(to), relType: rel });
        if (id === "Hub") return [...fans.map((f) => nb(f, "member_of")), nb("Mid", "collaborated_with")];
        if (id.startsWith("fan")) return [nb("Hub", "member_of")];
        if (id === "Mid") return [nb("Hub", "collaborated_with"), nb("Small", "collaborated_with")];
        if (id === "Small") return [nb("Mid", "collaborated_with")];
        return [];
      },
    };
    const stats = { capped: false };
    expect(strongestPaths(g, n("Hub"), new Set(["Small"]), undefined, stats).has("Small")).toBe(false);
    expect(stats.capped).toBe(true);
    const small = computeSimilarity(g, "Hub", ["Small"]).pairs[0]!;
    expect(small.path!.map((s) => `${s.from.name}->${s.to.name}`)).toEqual(["Small->Mid", "Mid->Hub"]);
    expect(small.score).toBe(64);
    const hub = computeSimilarity(g, "Small", ["Hub"]).pairs[0]!;
    expect(hub.path!.map((s) => `${s.from.name}->${s.to.name}`)).toEqual(["Hub->Mid", "Mid->Small"]);
    expect(hub.score).toBe(64);
  });
});

describe("two passes (the Similarity page)", () => {
  /** Fan played on Mid's records; Mid on Star's (200 collaborators) and Indie's. */
  function g(): GraphAccess {
    const n = (id: string): SimNode => ({ id, name: id, type: "person" });
    const edges: Array<[string, string]> = [["Fan", "Mid"], ["Mid", "Star"], ["Mid", "Indie"]];
    const degrees: Record<string, number> = { Star: 200 };
    return {
      findNodeByName: (name) => n(name),
      findNodeById: (id) => n(id),
      neighbors(id) {
        const out: SimNeighbor[] = [];
        for (const [s, t] of edges) {
          if (s === id) out.push({ node: n(t), relType: "collaborated_with", outgoing: true });
          if (t === id) out.push({ node: n(s), relType: "collaborated_with", outgoing: false });
        }
        return out;
      },
      degree: (id) => degrees[id] ?? 2,
    };
  }

  it("shows pairs under 5 as 0 first, then fills in their path and score", () => {
    const quick = computeSimilarity(g(), "Star", ["Mid", "Fan", "Nobody"], { quick: true });
    const fan = quick.pairs.find((p) => p.name === "Fan")!;
    expect(fan.score).toBe(0);
    expect(fan.path).toBe(null);
    expect(pendingPairs(quick).map((p) => p.name)).toEqual(["Fan", "Nobody"]);

    const pending = pendingPairs(quick);
    const deeper = computeSimilarity(g(), { name: "Star", id: "Star" }, pending.map((p) => ({ name: p.name, id: p.node!.id })), {
      closest: true,
    });
    const merged = mergePairs(quick, deeper.pairs);
    // Mid: 0.8 x 14/200 = 0.056 (first pass); Fan: 0.8 x 0.056 = 0.045 (second)
    expect(merged.pairs.map((p) => [p.name, p.score])).toEqual([["Mid", 6], ["Fan", 4], ["Nobody", 0]]);
    expect(merged.pairs.find((p) => p.name === "Fan")!.path!.map((s) => s.to.name)).toEqual(["Mid", "Star"]);
    expect(merged.overallScore).toBe(6);
    expect(merged).toEqual(computeSimilarity(g(), "Star", ["Mid", "Fan", "Nobody"], { closest: true }));
  });
});



describe("bidirectional search (connect)", () => {
  /** A chain A - B - C - D - E - F - G - H of member_of links, plus a weak shortcut A - H. */
  function chain(): GraphAccess {
    const n = (id: string): SimNode => ({ id, name: id, type: "group" });
    const ids = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const edges: Array<[string, string, string]> = ids.slice(1).map((id, i) => [ids[i]!, id, "member_of"]);
    edges.push(["A", "H", "produced_for"]);
    return {
      findNodeByName: (name) => n(name),
      neighbors(id) {
        const out: SimNeighbor[] = [];
        for (const [s, t, rel] of edges) {
          if (s === id) out.push({ node: n(t), relType: rel, outgoing: true });
          if (t === id) out.push({ node: n(s), relType: rel, outgoing: false });
        }
        return out;
      },
    };
  }
  const continuous = (path: PathStep[], from: string, to: string) => {
    expect(path[0]!.from.id).toBe(from);
    expect(path[path.length - 1]!.to.id).toBe(to);
    path.slice(1).forEach((s, i) => expect(s.from.id).toBe(path[i]!.to.id));
  };

  it("reads from the first artist to the second, hop after hop", () => {
    const g = chain();
    const n = (id: string): SimNode => ({ id, name: id, type: "group" });
    const path = connect(g, n("B"), n("F"))!;
    continuous(path, "B", "F");
    expect(path.map((s) => s.to.id)).toEqual(["C", "D", "E", "F"]);
    // Every hop keeps its edge's direction: B is the member of C, so B -> C is from the source
    expect(path[0]!.fromIsSource).toBe(true);
    const back = connect(g, n("F"), n("B"))!;
    continuous(back, "F", "B");
    expect(back[0]!.fromIsSource).toBe(false);
  });

  it("costs the joined path exactly: two free hops, then 0.9 per hop", () => {
    const g = chain();
    const n = (id: string): SimNode => ({ id, name: id, type: "group" });
    expect(pathStrength(connect(g, n("A"), n("C"))!)).toBeCloseTo(1);
    expect(pathStrength(connect(g, n("A"), n("E"))!)).toBeCloseTo(HOP_DAMPING ** 2);
  });

  it("doesn't join halves into a path past MAX_HOPS", () => {
    const g = chain();
    const n = (id: string): SimNode => ({ id, name: id, type: "group" });
    // A -> H is 7 member_of hops (too many): the weak producer shortcut is the path
    const path = connect(g, n("A"), n("H"))!;
    expect(MAX_HOPS).toBe(6);
    expect(path.map((s) => s.relType)).toEqual(["produced_for"]);
  });

  it("returns the path it costed, even after the nodes it went through are re-pointed", () => {
    // Two routes S -> M: S - X - M (two strong hops) and S - Y - Z - M (three free member_of
    // hops, found later with more hops). The meeting must keep the route it was costed on.
    const n = (id: string): SimNode => ({ id, name: id, type: "group" });
    const edges: Array<[string, string, string]> = [
      ["S", "X", "member_of"], ["X", "M", "opened_for"], ["S", "Y", "member_of"], ["Y", "Z", "member_of"],
      ["Z", "M", "member_of"], ["M", "T1", "member_of"], ["T1", "T2", "member_of"], ["T2", "T", "member_of"],
    ];
    const g: GraphAccess = {
      findNodeByName: (name) => n(name),
      neighbors(id) {
        const out: SimNeighbor[] = [];
        for (const [s, t, rel] of edges) {
          if (s === id) out.push({ node: n(t), relType: rel, outgoing: true });
          if (t === id) out.push({ node: n(s), relType: rel, outgoing: false });
        }
        return out;
      },
    };
    const path = connect(g, n("S"), n("T"))!;
    continuous(path, "S", "T");
    expect(path.length).toBeLessThanOrEqual(MAX_HOPS);
    const one = strongestPaths(g, n("S"), new Set(["T"])).get("T")!;
    expect(pathStrength(path)).toBeCloseTo(pathStrength(one));
  });

  it("agrees with the one-ended search on the test graph", () => {
    const g = makeGraph();
    for (const [a, b] of [["Charles Moothart", "Ty Segall"], ["Mikal Cronin", "Ty Segall"], ["Ty Segall", "Mikal Cronin"]] as const) {
      const from = g.findNodeByName(a)!;
      const to = g.findNodeByName(b)!;
      const one = strongestPaths(g, from, new Set([to.id])).get(to.id)!;
      expect(pathStrength(connect(g, from, to)!)).toBeCloseTo(pathStrength(one));
    }
  });
});

describe("scoring many artists a step at a time", () => {
  it("finds the same paths in steps as in one go", () => {
    const g = makeGraph();
    const start = g.findNodeByName("Ty Segall")!;
    const targets = new Set(["Mikal Cronin", "Charles Moothart", "Fuzz"].map((n) => g.findNodeByName(n)!.id));
    const whole = strongestPaths(g, start, targets);
    const search = new PathSearch(g, start, targets);
    let steps = 0;
    while (!search.done && steps < 1000) {
      search.step(1);
      steps++;
    }
    expect(steps).toBeGreaterThan(1);
    expect([...search.found.keys()].sort()).toEqual([...whole.keys()].sort());
    for (const [id, path] of whole) expect(pathStrength(search.found.get(id)!)).toBeCloseTo(pathStrength(path));
  });

  it("reports each score as soon as it's known, closest first, matching a pair search", async () => {
    const g = makeGraph();
    const order: string[] = [];
    const scores = await scoreArtistsAgainstList(g, ["Mikal Cronin", "Charles Moothart", "Nobody At All"], ["Ty Segall"], undefined, (n) =>
      order.push(n)
    );
    // Not in the graph: right away; then the bandmate (100) before the album credit (14)
    expect(order).toEqual(["Nobody At All", "Charles Moothart", "Mikal Cronin"]);
    for (const name of ["Mikal Cronin", "Charles Moothart"]) {
      expect(scores.get(name)!.score).toBe(computeSimilarity(g, name, ["Ty Segall"]).overallScore);
    }
    expect(scores.get("Nobody At All")).toEqual({ score: 0, found: false });
    // Each score keeps how it connects, read from the liked artist (for the concert panel)
    const charles = scores.get("Charles Moothart")!.pairs!;
    expect(charles.map((p) => [p.name, p.score])).toEqual([["Ty Segall", 100]]);
    expect(charles[0]!.path![0]!.from.name).toBe("Ty Segall");
  });
});

