import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { SearchBar } from "../components/SearchBar";
import { GraphView } from "../components/GraphView";
import { InfoPanel } from "../components/InfoPanel";
import { GraphLegend } from "../components/GraphLegend";
import { loadVisibleRels, saveVisibleRels } from "../graph/relationships";
import { DebugConsole } from "../components/DebugConsole";
import { SceneGraph } from "../graph/SceneGraph";
import { getDb, isDbLoaded } from "../db/graphDb";
import { findArtist, findArtistById, getArtistNeighbors, inLocalGraph } from "../db/graphSource";
import { debugLog } from "../debug/DebugLog";
import { resolveSearchTarget, type SearchResolution } from "./searchResolution";
import type { GraphNode, NodeType, EdgeType } from "../graph/types";

/** Map SQLite node types to our graph node types */
function mapNodeType(dbType: string): NodeType {
  switch (dbType) {
    case "person": return "musician";
    case "group": return "artist";
    case "album": return "label"; // reuse label color for albums for now
    default: return "artist";
  }
}

/** Map SQLite edge types to our graph edge types */
function mapEdgeType(dbRelType: string): EdgeType {
  switch (dbRelType) {
    case "member_of": return "member_of";
    case "former_member_of": return "former_member_of";
    case "support_musician": return "support_musician";
    case "opened_for": return "opened_for";
    case "collaborated_with": return "collaborated_with";
    case "produced_for": return "produced_for";
    case "producer": return "collaborated_with";
    case "vocal": return "collaborated_with";
    case "instrument": return "collaborated_with";
    case "mix": return "collaborated_with";
    case "engineer": return "collaborated_with";
    case "recording": return "collaborated_with";
    case "album_by": return "signed_to";
    default: return "collaborated_with";
  }
}

/**
 * Expand an artist into the SceneGraph. Resolves by exact MBID when the user
 * clicked a node (avoids name ambiguity, e.g. two artists both named "Fuzz"),
 * else by name. Only person/group nodes — albums are skipped. Works before the
 * graph DB has downloaded (graphSource falls back to the server).
 */
async function expandArtist(target: SearchResolution, graph: SceneGraph): Promise<string | null> {
  const node = target.by === "id"
    ? await findArtistById(target.id)
    : await findArtist(target.name, { partial: true });
  if (!node) return null;
  const { id, name, type } = node;
  const nodeType = mapNodeType(type);

  // Add the central node
  graph.addNode({
    id,
    type: nodeType,
    name,
  } as GraphNode);
  graph.markExpanded(id);

  // Get all neighbors (skip album nodes — only show artists/bands)
  const neighbors = await getArtistNeighbors(id);
  const filtered = neighbors.filter((n) => n.node.type !== "album");
  debugLog.log(`Expanding "${name}": found ${filtered.length} connections (${neighbors.length - filtered.length} albums hidden)`);

  for (const { node: neighbor, relType, outgoing } of filtered) {
    const neighborNodeType = mapNodeType(neighbor.type);
    graph.addNode({
      id: neighbor.id,
      type: neighborNodeType,
      name: neighbor.name,
    } as GraphNode);

    const edgeType = mapEdgeType(relType);
    // Every edge keeps the direction it is stored in (member -> band, opener ->
    // headliner, credited artist -> the record's artist; see the legend), so
    // expanding either end gives the same edge. Without a direction (old server
    // responses), it is drawn from the expanded artist.
    const [source, target] = outgoing === false ? [neighbor.id, id] : [id, neighbor.id];
    graph.addEdge({
      id: `${source}-${edgeType}-${target}`,
      source,
      target,
      type: edgeType,
    });
  }

  return id;
}

export function ExplorePage() {
  const [graph] = useState(() => {
    const g = new SceneGraph();
    g.load();
    return g;
  });
  // Bumped whenever the SceneGraph changes; the drawn data is derived from it
  // and from the relationship types ticked in the legend.
  const [version, setVersion] = useState(0);
  const [visibleRels, setVisibleRels] = useState<EdgeType[]>(loadVisibleRels);
  const graphData = useMemo(
    () => graph.toForceGraphData(new Set(visibleRels)),
    [graph, version, visibleRels]
  );
  const toggleRel = useCallback((type: EdgeType) => {
    setVisibleRels((prev) => {
      const next = prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type];
      saveVisibleRels(next);
      return next;
    });
  }, []);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [dbReady, setDbReady] = useState(isDbLoaded());
  const [error, setError] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<string | null>(null);
  // The MBID behind the search box's text: the last clicked node, or the artist the last search added (picked
  // from the dropdown or found by name). A search for that exact text resolves by ID instead of by an ambiguous
  // name (e.g. two artists named "Fuzz"); other text searches by name.
  const pendingNode = useRef<{ name: string; id: string } | null>(null);

  // The graph downloads in the background (main.tsx); search works meanwhile.
  useEffect(() => {
    if (!dbReady) {
      getDb().then(() => setDbReady(true)).catch(() => {
        /* searches keep using the server */
      });
    }
  }, [dbReady]);

  const handleSearch = useCallback(
    async (artistName: string, pickedId?: string) => {
      setLoading(true);
      setError(null);
      try {
        // Resolve by exact MBID if the query matches the last-clicked node, else by name
        // (a dropdown pick carries its MBID, which is exact too)
        const resolution = resolveSearchTarget(artistName, pickedId ? { name: artistName, id: pickedId } : pendingNode.current);
        // Captured before the lookup: a miss while the graph is still downloading
        // went to the server, which says nothing about the graph's coverage.
        const lookedUpLocally = isDbLoaded();
        const found = await expandArtist(resolution, graph);
        if (!found) {
          setError(`No artist found for "${artistName}"`);
          if (lookedUpLocally) {
            const { reportMiss } = await import("../api/supabase");
            reportMiss(resolution.by === "id" ? resolution.id : artistName, "explore-not-found");
          }
        } else {
          // Found on the server but missing from the local graph: still worth
          // logging, so banded-data crawls the artist into the next build.
          if (lookedUpLocally && !inLocalGraph(found)) {
            const { reportMiss } = await import("../api/supabase");
            reportMiss(found, "explore-not-in-graph");
          }
          // The box still shows this text: + again (after Reset, say) means this same artist, not a namesake.
          pendingNode.current = { name: artistName, id: found };
          graph.save();
          setVersion((v) => v + 1);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    },
    [graph]
  );

  // The panel's buttons: expand the selected artist (by its exact ID, as a search would), or unexpand it.
  const expandNode = useCallback((node: GraphNode) => handleSearch(node.name, node.id), [handleSearch]);
  const unexpandNode = useCallback((node: GraphNode) => {
    const removed = graph.collapse(node.id);
    debugLog.log(`Removing "${node.name}"'s connections: ${removed.length} artists left the graph`);
    graph.save();
    setVersion((v) => v + 1);
    // The artist itself may be gone, or only connected by a relationship the legend hides: close its panel.
    if (!graph.toForceGraphData(new Set(visibleRels)).nodes.some((n) => n.id === node.id)) setSelectedNode(null);
  }, [graph, visibleRels]);

  // A click or tap outside the panel closes it. On the graph, empty space and links close it (GraphView's
  // onBackgroundClick: not a drag to pan) and a node switches to that node; anywhere else on the page closes it.
  const closePanel = useCallback(() => setSelectedNode(null), []);
  useEffect(() => {
    if (!selectedNode) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || t.closest(".info-panel") || t.closest("canvas")) return;
      setSelectedNode(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [selectedNode]);

  const handleReset = useCallback(() => {
    graph.clear();
    setVersion((v) => v + 1);
    setSelectedNode(null);
    // pendingNode is kept: the search box keeps its text, and that text still means the artist that was clicked
    // (it's only used while the box holds exactly that name), so + after Reset adds the same artist, not a namesake.
    setError(null);
  }, [graph]);

  const handleNodeClick = useCallback(
    (node: { id?: string | number }) => {
      if (node.id) {
        const graphNode = graph.getNode(String(node.id));
        setSelectedNode(graphNode ?? null);
        if (graphNode) {
          setPrefill(graphNode.name);
          // Remember this exact node so search resolves by MBID, not name
          pendingNode.current = { name: graphNode.name, id: graphNode.id };
        }
      }
    },
    [graph]
  );

  return (
    <>
      <SearchBar onSearch={handleSearch} loading={loading} prefill={prefill} onPrefillConsumed={() => setPrefill(null)} onReset={handleReset} />
      <DebugConsole />
      {!dbReady && <div style={{ color: "#888", padding: "0.5rem 1rem", fontSize: "0.85rem" }}>Loading the full graph in the background. Searches use the server until it's ready.</div>}
      {error && <div style={{ color: "#ff6b6b", padding: "0.5rem 1rem" }}>{error}</div>}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
        <GraphView data={graphData} onNodeClick={handleNodeClick} onBackgroundClick={closePanel} />
        <GraphLegend visible={visibleRels} onToggle={toggleRel} />
        {selectedNode && (
          <InfoPanel
            node={selectedNode}
            onClose={() => setSelectedNode(null)}
            expanded={graph.isExpanded(selectedNode.id)}
            busy={loading}
            onExpand={() => expandNode(selectedNode)}
            onUnexpand={() => unexpandNode(selectedNode)}
          />
        )}
      </div>
    </>
  );
}
