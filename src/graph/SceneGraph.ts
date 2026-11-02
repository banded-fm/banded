import type {
  EdgeType,
  GraphNode,
  GraphEdge,
  ForceGraphData,
  ForceGraphNodeData,
  ForceGraphLinkData,
} from "./types";
import { NODE_COLORS, EDGE_COLORS } from "./types";

/**
 * In-memory graph that accumulates nodes and edges as data is fetched.
 * Provides deduplication and serialization to force-graph format.
 */
export class SceneGraph {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private expandedNodes = new Set<string>();

  addNode(node: GraphNode): void {
    if (this.nodes.has(node.id)) {
      // Merge metadata
      const existing = this.nodes.get(node.id)!;
      this.nodes.set(node.id, {
        ...existing,
        ...node,
        metadata: { ...existing.metadata, ...node.metadata },
      });
    } else {
      this.nodes.set(node.id, node);
    }
  }

  addEdge(edge: GraphEdge): void {
    // Deduplicate by composite key
    if (!this.edges.has(edge.id)) {
      this.edges.set(edge.id, edge);
    }
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  getNeighbors(nodeId: string): GraphNode[] {
    const neighborIds = new Set<string>();
    for (const edge of this.edges.values()) {
      if (edge.source === nodeId) neighborIds.add(edge.target);
      if (edge.target === nodeId) neighborIds.add(edge.source);
    }
    return [...neighborIds]
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  }

  markExpanded(nodeId: string): void {
    this.expandedNodes.add(nodeId);
  }

  isExpanded(nodeId: string): boolean {
    return this.expandedNodes.has(nodeId);
  }

  /**
   * Force-graph data. With `visibleTypes`, only edges of those types are drawn,
   * and a node is shown only if it was expanded or one of those edges reaches it.
   */
  toForceGraphData(visibleTypes?: ReadonlySet<EdgeType>): ForceGraphData {
    const nodes: ForceGraphNodeData[] = [];
    const links: ForceGraphLinkData[] = [];
    const reached = new Set<string>();

    for (const edge of this.edges.values()) {
      if (visibleTypes && !visibleTypes.has(edge.type)) continue;
      // Only include edges where both nodes exist
      if (this.nodes.has(edge.source) && this.nodes.has(edge.target)) {
        links.push({
          source: edge.source,
          target: edge.target,
          type: edge.type,
          color: EDGE_COLORS[edge.type],
        });
        reached.add(edge.source);
        reached.add(edge.target);
      }
    }

    for (const node of this.nodes.values()) {
      if (visibleTypes && !reached.has(node.id) && !this.expandedNodes.has(node.id)) continue;
      nodes.push({
        id: node.id,
        name: node.name,
        type: node.type,
        color: NODE_COLORS[node.type],
        val: node.type === "artist" ? 3 : node.type === "venue" ? 2 : 1,
        expanded: this.expandedNodes.has(node.id),
      });
    }

    return { nodes, links };
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.size;
  }

  // --- Persistence ---

  private static STORAGE_KEY = "banded_graph";

  save(): void {
    const data = {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      expanded: [...this.expandedNodes],
    };
    localStorage.setItem(SceneGraph.STORAGE_KEY, JSON.stringify(data));
  }

  load(): boolean {
    const raw = localStorage.getItem(SceneGraph.STORAGE_KEY);
    if (!raw) return false;
    try {
      const data = JSON.parse(raw) as { nodes: GraphNode[]; edges: GraphEdge[]; expanded?: string[] };
      for (const node of data.nodes) this.nodes.set(node.id, node);
      for (const edge of data.edges) this.edges.set(edge.id, edge);
      if (data.expanded) {
        for (const id of data.expanded) this.expandedNodes.add(id);
      }
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.expandedNodes.clear();
    localStorage.removeItem(SceneGraph.STORAGE_KEY);
  }
}
