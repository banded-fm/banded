// --- Node Types ---

export type NodeType =
  | "artist"
  | "musician"
  | "venue"
  | "city"
  | "scene"
  | "label"
  | "festival";

export interface BaseNode {
  id: string; // typically MBID or composite key
  type: NodeType;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface ArtistNode extends BaseNode {
  type: "artist";
  mbid?: string;
  disambiguation?: string;
  country?: string;
}

export interface MusicianNode extends BaseNode {
  type: "musician";
  mbid?: string;
}

export interface VenueNode extends BaseNode {
  type: "venue";
  city?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
}

export interface CityNode extends BaseNode {
  type: "city";
  country?: string;
}

export interface SceneNode extends BaseNode {
  type: "scene";
}

export interface LabelNode extends BaseNode {
  type: "label";
  mbid?: string;
}

export interface FestivalNode extends BaseNode {
  type: "festival";
}

export type GraphNode =
  | ArtistNode
  | MusicianNode
  | VenueNode
  | CityNode
  | SceneNode
  | LabelNode
  | FestivalNode;

// --- Edge Types ---

export type EdgeType =
  | "member_of"
  | "former_member_of"
  | "support_musician"
  | "played_at"
  | "located_in"
  | "part_of_scene"
  | "signed_to"
  | "collaborated_with"
  | "produced_for"
  | "opened_for"
  | "toured_with"
  | "performed_at_festival";

export interface GraphEdge {
  id: string;
  source: string; // node id
  target: string; // node id
  type: EdgeType;
  metadata?: Record<string, unknown>;
}

// --- Force Graph rendering data ---

export interface ForceGraphNodeData {
  id: string;
  name: string;
  type: NodeType;
  color: string;
  val: number; // node size
  expanded: boolean;
}

export interface ForceGraphLinkData {
  source: string;
  target: string;
  type: EdgeType;
  color: string;
}

export interface ForceGraphData {
  nodes: ForceGraphNodeData[];
  links: ForceGraphLinkData[];
}

// --- Color map for node types ---

export const NODE_COLORS: Record<NodeType, string> = {
  artist: "#7A1631",
  musician: "#7A1631",
  venue: "#2E0A14",
  city: "#1F7A74",
  scene: "#5B3E9A",
  label: "#B87A0A",
  festival: "#D4561A",
};

// The relationship hues (graph/marks.ts has their stroke patterns)
export const EDGE_COLORS: Record<EdgeType, string> = {
  member_of: "#7A1631",
  former_member_of: "#6B4A50",
  support_musician: "#7A1631",
  played_at: "#2E0A14",
  located_in: "#1F7A74",
  part_of_scene: "#5B3E9A",
  signed_to: "#B87A0A",
  collaborated_with: "#1F7A74",
  produced_for: "#5B3E9A",
  opened_for: "#D4561A",
  toured_with: "#D4561A",
  performed_at_festival: "#D4561A",
};
