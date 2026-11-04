/**
 * An artist and its 1-hop band relationships, live from MusicBrainz: the last
 * resort for an artist neither the browser graph nor Postgres has (Explore,
 * Similarity, Discover). One request (plus a search when only a name is known),
 * paced by the MusicBrainz client at about one a second and cached for 24 hours.
 */

export interface MBSubgraphNode {
  id: string;
  name: string;
  type: string; // "person" | "group"
}

export interface MBSubgraph {
  node: MBSubgraphNode;
  /** `outgoing`: the looked-up artist is the edge's source (the member / the supporting musician). */
  neighbors: Array<{ node: MBSubgraphNode; relType: string; outgoing: boolean }>;
}

/** The artist (by MBID, else the best name match) and its members, bands and support relationships; null when MusicBrainz has no such artist. */
export async function musicBrainzSubgraph({ name, id }: { name?: string; id?: string }): Promise<MBSubgraph | null> {
  const mb = await import("./musicbrainz");
  let mbid = id;
  if (!mbid && name) {
    const results = await mb.searchArtists(name, 5);
    mbid = mb.pickBestMatch(name, results)?.id;
  }
  if (!mbid) return null;
  const full = await mb.getArtistWithRelations(mbid);

  const kind = (type?: string) => (type === "Group" ? "group" : "person");
  const neighbors: MBSubgraph["neighbors"] = [];
  const push = (a: { id: string; name: string; type?: string }, relType: string, outgoing: boolean) =>
    neighbors.push({ node: { id: a.id, name: a.name, type: kind(a.type) }, relType, outgoing });

  for (const m of mb.extractBands(full)) push(m.artist, m.current ? "member_of" : "former_member_of", true);
  for (const m of mb.extractMembers(full)) push(m.artist, m.current ? "member_of" : "former_member_of", false);
  for (const s of mb.extractSupportedBands(full)) push(s.artist, "support_musician", true);
  for (const s of mb.extractSupportMusicians(full)) push(s.artist, "support_musician", false);

  return { node: { id: full.id, name: full.name, type: kind(full.type) }, neighbors };
}
