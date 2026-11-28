import { useEffect, useState } from "react";
import type { GraphNode } from "../graph/types";
import { getArtistDetails, getDb, isDbLoaded, type ArtistDetails } from "../db/graphDb";

interface Props {
  node: GraphNode;
  onClose: () => void;
  /** Whether the node's connections are in the graph: the button then removes them. */
  expanded?: boolean;
  /** An expansion is loading (from this button or a search). */
  busy?: boolean;
  onExpand?: () => void;
  onUnexpand?: () => void;
  /** Sliding away (phones): see useLingering. */
  closing?: boolean;
}

/** Names the graph's legend uses for the two artist node types. */
const TYPE_LABELS: Partial<Record<GraphNode["type"], string>> = { artist: "group", musician: "person" };

/** Groups and people come from MusicBrainz: their id is a MusicBrainz artist ID. */
function isMusicBrainzArtist(node: GraphNode): boolean {
  return node.type === "artist" || node.type === "musician";
}

/**
 * An artist's details from the local graph. While the graph is still
 * downloading this is "loading", then fills in; null if the graph has no
 * details for the artist (or failed to load).
 */
function useArtistDetails(node: GraphNode): ArtistDetails | null | "loading" {
  const read = () => (isMusicBrainzArtist(node) && isDbLoaded() ? getArtistDetails(node.id) : null);
  const [details, setDetails] = useState<ArtistDetails | null | "loading">(() =>
    !isMusicBrainzArtist(node) ? null : isDbLoaded() ? read() : "loading");
  useEffect(() => {
    if (!isMusicBrainzArtist(node)) { setDetails(null); return; }
    if (isDbLoaded()) { setDetails(read()); return; }
    let cancelled = false;
    setDetails("loading");
    getDb().then(() => { if (!cancelled) setDetails(read()); }).catch(() => { if (!cancelled) setDetails(null); });
    return () => { cancelled = true; };
  }, [node.id, node.type]); // eslint-disable-line react-hooks/exhaustive-deps
  return details;
}

/** A bin, for removing an artist's connections. */
function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </svg>
  );
}

export function InfoPanel({ node, onClose, expanded = false, busy = false, onExpand, onUnexpand, closing = false }: Props) {
  const details = useArtistDetails(node);
  const loaded = details !== "loading" ? details : null;
  // A node made before details existed may carry its own disambiguation.
  const disambiguation = loaded?.disambiguation ?? (node.type === "artist" ? node.disambiguation : undefined);

  return (
    <aside className={`info-panel${closing ? " sheet-closing" : ""}`} style={styles.panel} aria-label="Node details">
      <div style={styles.header}>
        <span className="eyebrow" style={styles.badge}>
          {TYPE_LABELS[node.type] ?? node.type}
        </span>
        <button onClick={onClose} className="info-close" style={styles.closeBtn} aria-label="Close panel">
          ×
        </button>
      </div>
      {/* The name (and subtitle, when there is one) with the add/remove button beside them: centred against the
          block, so it lines up with the name alone or sits between name and subtitle. */}
      <div style={styles.titleRow}>
        <div style={styles.titleText}>
          <h2 style={styles.name}>{node.name}</h2>
          {disambiguation && <p style={styles.disambiguation}>{disambiguation}</p>}
        </div>
        {isMusicBrainzArtist(node) && onExpand && onUnexpand && (
          <button
            type="button"
            className="info-expand"
            style={{ ...styles.iconBtn, ...(expanded ? styles.iconBtnRemove : {}) }}
            onClick={expanded ? onUnexpand : onExpand}
            disabled={busy && !expanded}
            aria-label={expanded ? "Remove connections" : busy ? "Adding connections" : "Add connections"}
            title={expanded
              ? "Remove connections: what adding this artist's connections brought in"
              : "Add connections: this artist's connections to the graph"}
          >
            {expanded ? <TrashIcon /> : busy ? "…" : "+"}
          </button>
        )}
      </div>

      {isMusicBrainzArtist(node) && (
        <>
          {details === "loading" ? (
            <p style={styles.muted}>Loading details…</p>
          ) : loaded && loaded.genres.length > 0 ? (
            <ul className="genre-chips" style={styles.genres} aria-label="Genres">
              {loaded.genres.map((g) => <li key={g} style={styles.genre}>{g}</li>)}
            </ul>
          ) : null}
          <a
            className="info-link"
            href={`https://musicbrainz.org/artist/${encodeURIComponent(node.id)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.link}
          >
            View on MusicBrainz ↗
          </a>
        </>
      )}

      {node.type === "artist" && node.country && (
        <p style={styles.meta}>Country: {node.country}</p>
      )}
      {node.type === "venue" && (
        <>
          {node.city && <p style={styles.meta}>City: {node.city}</p>}
          {node.country && <p style={styles.meta}>Country: {node.country}</p>}
          {node.metadata?.playCount && (
            <p style={styles.meta}>Shows played here: {node.metadata.playCount as number}</p>
          )}
        </>
      )}
      {node.type === "city" && node.country && (
        <p style={styles.meta}>Country: {node.country}</p>
      )}
      {node.metadata && Object.keys(node.metadata).length > 0 && (
        <details style={{ marginTop: "0.75rem" }}>
          <summary style={{ cursor: "pointer", color: "#6B4A50" }}>Raw metadata</summary>
          <pre style={styles.pre}>{JSON.stringify(node.metadata, null, 2)}</pre>
        </details>
      )}
    </aside>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // A 2px deep rule on top (inset from the edges on wide screens: index.css); the type as an eyebrow, the name large in maroon
  panel: {
    width: "320px",
    maxWidth: "100%",
    padding: "16px 24px 20px",
    background: "#F3ECE1",
    borderTop: "2px solid #2E0A14", // a rule on top only, no divider down the side
    overflowY: "auto",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "0.5rem",
  },
  badge: {},
  closeBtn: {
    background: "none",
    border: "none",
    color: "#2E0A14",
    fontSize: "1.75rem",
    cursor: "pointer",
    lineHeight: 1,
  },
  name: {
    fontSize: "40px",
    fontWeight: 500,
    lineHeight: 0.95,
    letterSpacing: "-0.055em",
    color: "#7A1631",
    marginBottom: 0,
    overflowWrap: "anywhere",
  },
  disambiguation: {
    color: "#2E0A14",
    fontSize: "15px",
    fontWeight: 400,
    lineHeight: 1.45,
    marginTop: "8px",
  },
  // The bin: the + inverted (outline), so removing reads as the opposite of adding.
  iconBtnRemove: {
    background: "transparent",
    color: "#7A1631",
    boxShadow: "inset 0 0 0 2px #7A1631",
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    marginBottom: "0.75rem",
  },
  titleText: {
    flex: 1,
    minWidth: 0,
  },
  // Small and square, in the search bar +'s colours.
  iconBtn: {
    flex: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "44px",
    height: "44px",
    padding: 0,
    border: "none",
    background: "#7A1631",
    color: "#F3ECE1",
    fontWeight: 500,
    fontSize: "1.2rem",
    lineHeight: 1,
    cursor: "pointer",
  },
  genres: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.35rem",
    listStyle: "none",
    padding: 0,
    margin: "0 0 0.75rem",
  },
  genre: {
    padding: "3px 8px",
    border: "2px solid #2E0A14",
    color: "#2E0A14",
    fontSize: "13px",
  },
  link: {
    display: "inline-flex",
    alignItems: "center",
    color: "#7A1631",
    fontSize: "15px",
    textDecoration: "underline",
    textUnderlineOffset: "3px",
  },
  muted: {
    color: "#6B4A50",
    fontSize: "0.8rem",
    marginBottom: "0.6rem",
  },
  meta: {
    color: "#6B4A50",
    fontSize: "0.85rem",
    marginBottom: "0.25rem",
  },
  pre: {
    fontSize: "0.7rem",
    color: "#6B4A50",
    background: "#F3ECE1",
    padding: "0.5rem",
    borderRadius: "4px",
    overflow: "auto",
    marginTop: "0.5rem",
  },
};
