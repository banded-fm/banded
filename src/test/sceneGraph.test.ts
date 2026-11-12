import { describe, it, expect } from "vitest";
import { SceneGraph } from "../graph/SceneGraph";
import { DEFAULT_EXPLORE_RELS, EXPLORE_RELATIONSHIPS } from "../graph/relationships";
import { EDGE_COLORS, type EdgeType } from "../graph/types";

function graph() {
  const g = new SceneGraph();
  g.addNode({ id: "ty", type: "musician", name: "Ty Segall" });
  g.addNode({ id: "fuzz", type: "artist", name: "Fuzz" });
  g.addNode({ id: "wf", type: "artist", name: "White Fence" });
  g.addNode({ id: "osees", type: "artist", name: "Osees" });
  g.markExpanded("ty");
  g.addEdge({ id: "ty-member_of-fuzz", source: "ty", target: "fuzz", type: "member_of" });
  g.addEdge({ id: "ty-produced_for-wf", source: "ty", target: "wf", type: "produced_for" });
  g.addEdge({ id: "ty-opened_for-osees", source: "ty", target: "osees", type: "opened_for" });
  return g;
}

describe("SceneGraph visible relationship types", () => {
  it("draws everything without a filter", () => {
    const d = graph().toForceGraphData();
    expect(d.links).toHaveLength(3);
    expect(d.nodes).toHaveLength(4);
  });

  it("hides edges of unticked types and the artists only they reach", () => {
    const d = graph().toForceGraphData(new Set<EdgeType>(DEFAULT_EXPLORE_RELS));
    expect(d.links.map((l) => l.type)).toEqual(["member_of"]);
    expect(d.nodes.map((n) => n.id).sort()).toEqual(["fuzz", "ty"]);
  });

  it("keeps an expanded artist even with nothing ticked", () => {
    const d = graph().toForceGraphData(new Set<EdgeType>());
    expect(d.links).toHaveLength(0);
    expect(d.nodes.map((n) => n.id)).toEqual(["ty"]);
  });
});

describe("SceneGraph unexpand", () => {
  // Ty expanded: Fuzz (member), White Fence (produced, hidden by default), Osees, Charles (played on records).
  // Charles expanded too: Fuzz (member) and Chad, who only Charles brings in.
  function two() {
    const g = graph();
    g.addNode({ id: "cm", type: "musician", name: "Charles Moothart" });
    g.addNode({ id: "cu", type: "musician", name: "Chad Ubovich" });
    g.addEdge({ id: "ty-collaborated_with-cm", source: "cm", target: "ty", type: "collaborated_with" });
    g.markExpanded("cm");
    g.addEdge({ id: "cm-member_of-fuzz", source: "cm", target: "fuzz", type: "member_of" });
    g.addEdge({ id: "cu-collaborated_with-cm", source: "cu", target: "cm", type: "collaborated_with" });
    return g;
  }

  it("puts the graph back as it was before the expansion", () => {
    const g = two();
    expect(g.collapse("cm")).toEqual(["cu"]);           // only Charles brought Chad in
    expect(g.isExpanded("cm")).toBe(false);
    expect(g.hasNode("cm")).toBe(true);                  // still Ty's neighbour (a hidden relationship)...
    expect(g.toForceGraphData(new Set<EdgeType>(DEFAULT_EXPLORE_RELS)).nodes.map((n) => n.id).sort())
      .toEqual(["fuzz", "ty"]);                          // ...so with the default legend he isn't drawn
    const links = g.toForceGraphData().links.map((l) => `${l.source}>${l.target}`).sort();
    expect(links).toEqual(["cm>ty", "ty>fuzz", "ty>osees", "ty>wf"]);   // Charles's own edges are gone
  });

  it("removes the artist too when no expanded artist is left next to it", () => {
    const g = two();
    g.collapse("cm");
    expect(g.collapse("ty").sort()).toEqual(["cm", "fuzz", "osees", "ty", "wf"]);
    expect(g.nodeCount).toBe(0);
    expect(g.edgeCount).toBe(0);
  });

  it("keeps neighbours another expanded artist still reaches", () => {
    const g = two();
    expect(g.collapse("ty").sort()).toEqual(["osees", "wf"]);   // Fuzz and Ty stay: Charles reaches them
    expect(g.hasNode("ty") && g.hasNode("fuzz") && g.hasNode("cm")).toBe(true);
  });
});

describe("legend", () => {
  it("defaults to the band relationships", () => {
    expect(DEFAULT_EXPLORE_RELS).toEqual(["member_of", "former_member_of", "support_musician"]);
  });

  it("gives every relationship type its own colour", () => {
    const colors = EXPLORE_RELATIONSHIPS.map((r) => EDGE_COLORS[r.type]);
    expect(new Set(colors).size).toBe(colors.length);
  });
});
