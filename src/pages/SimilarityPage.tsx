import { useEffect, useRef, useState } from "react";
import { computeSimilarity, mergePairs, MIN_STRENGTH, pendingPairs, type PairScore, type SimilarityResult } from "./similarity";
import { panelStyles, PathSteps, scoreColor, scoreFormula } from "../components/ConnectionPath";
import { buildTieredGraphAccess } from "./tieredGraphAccess";
import { ArtistAutocomplete } from "../components/ArtistAutocomplete";
import { addPicked, chipLabel, fromSuggestion, inputArtist, loadLikedArtists, pickedKey, saveLikedArtists, type PickedArtist } from "./pickedArtists";

/**
 * Resolves after the browser has painted what was just rendered. A hidden tab
 * doesn't run animation frames, so it also goes ahead after 100 ms.
 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      setTimeout(resolve, 0);
    };
    requestAnimationFrame(go);
    setTimeout(go, 100);
  });
}

function scoreLabel(score: number): string {
  if (score >= 70) return "Strong match — same musical world";
  if (score >= 40) return "Related — shares members or close connections";
  if (score >= 15) return "Loosely connected";
  return "Little to no connection found";
}

export function SimilarityPage() {
  const [artistInput, setArtistInput] = useState("");
  // Shared with Discover and remembered in this browser
  const [artists, setArtists] = useState<PickedArtist[]>(loadLikedArtists);
  useEffect(() => saveLikedArtists(artists), [artists]);
  const [target, setTarget] = useState("");
  // The artist picked from the compare dropdown, while its name is still in the input.
  const [targetPick, setTargetPick] = useState<PickedArtist | null>(null);
  const [result, setResult] = useState<SimilarityResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openPair, setOpenPair] = useState<PairScore | null>(null);
  // Liked artists (node ids) still being searched for their closest connection
  const [searching, setSearching] = useState<Set<string>>(new Set());
  // Each Compute starts a new run; a slower earlier run's second pass is dropped
  const runRef = useRef(0);
  const isSearching = (p: PairScore) => p.node !== undefined && searching.has(p.node.id);

  // Escape closes the connection panel.
  useEffect(() => {
    if (!openPair) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenPair(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openPair]);

  const addArtist = (artist: PickedArtist) => {
    if (!artist.name.trim()) return;
    setArtists(addPicked(artists, artist));
    setArtistInput("");
  };

  const handleAddArtist = () => addArtist({ name: artistInput });

  const handleRemoveArtist = (artist: PickedArtist) => {
    setArtists(artists.filter((a) => pickedKey(a) !== pickedKey(artist)));
  };

  const handleCompare = async () => {
    if (!target.trim() || artists.length === 0) return;
    const run = ++runRef.current;
    setLoading(true);
    setError(null);
    setResult(null);
    setOpenPair(null);
    setSearching(new Set());

    try {
      const tiered = await buildTieredGraphAccess();
      // Resolve any artists missing from the core graph via Tier 2/3 first.
      const targetArtist = inputArtist(target, targetPick);
      await tiered.prepareArtists([targetArtist, ...artists]);
      const graph = tiered.build();
      // First pass: every pair scoring 5 or more, at once; the rest show 0 for now.
      const quick = computeSimilarity(graph, targetArtist, artists, { quick: true });
      if (run !== runRef.current) return;
      setResult(quick);
      setLoading(false);
      const pending = pendingPairs(quick);
      if (!quick.target || pending.length === 0) return;

      // Second pass, once the first is on screen: their closest connections (and any score of 2-4).
      setSearching(new Set(pending.map((p) => p.node!.id)));
      await nextPaint();
      if (run !== runRef.current) return;
      const deeper = computeSimilarity(
        graph,
        { name: quick.target.name, id: quick.target.id },
        pending.map((p) => ({ name: p.node!.name, id: p.node!.id })),
        { closest: true }
      );
      if (run !== runRef.current) return;
      setResult((prev) => (prev ? mergePairs(prev, deeper.pairs) : prev));
      // Keep an open panel on the same artist, now with its path
      setOpenPair((prev) => (prev?.node && deeper.pairs.find((p) => p.node?.id === prev.node!.id)) || prev);
      setSearching(new Set());
    } catch (e) {
      if (run === runRef.current) setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      if (run === runRef.current) setLoading(false);
    }
  };

  return (
    <div style={styles.page}>
      <div className="page-container" style={styles.container}>
        <div style={styles.header}>
          <h1 className="page-title" style={styles.title}>Proximity Score</h1>
          <p style={styles.subtitle}>
            See how closely an artist fits a group of artists you like, based on
            shared members and connections in the music graph.
          </p>
        </div>

        <div style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label}>Artists you like</label>
            <div style={styles.inputRow}>
              <ArtistAutocomplete
                value={artistInput}
                onChange={setArtistInput}
                onSelect={(a) => addArtist(fromSuggestion(a))}
                onEnter={handleAddArtist}
                placeholder="Add an artist..."
                inputStyle={styles.input}
                wrapperStyle={styles.autocomplete}
                ariaLabel="Add an artist"
              />
              <button
                type="button"
                onClick={handleAddArtist}
                disabled={!artistInput.trim()}
                style={styles.addBtn}
              >
                Add
              </button>
            </div>
            {artists.length > 0 && (
              <div style={styles.chipList}>
                {artists.map((a) => (
                  <span key={pickedKey(a)} style={styles.chip} title={a.disambiguation}>
                    {chipLabel(a, artists)}
                    <button
                      type="button"
                      onClick={() => handleRemoveArtist(a)}
                      className="chip-remove"
                      style={styles.chipRemove}
                      aria-label={`Remove ${chipLabel(a, artists)}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Artist to compare</label>
            <ArtistAutocomplete
              value={target}
              onChange={setTarget}
              onSelect={(a) => {
                setTarget(a.name);
                setTargetPick(fromSuggestion(a));
              }}
              onEnter={handleCompare}
              placeholder="e.g. Fuzz"
              inputStyle={styles.input}
              ariaLabel="Artist to compare"
            />
          </div>

          <button
            onClick={handleCompare}
            disabled={loading || !target.trim() || artists.length === 0}
            style={styles.searchBtn}
          >
            {loading ? "Scoring…" : "Compute Proximity"}
          </button>
        </div>

        {error && <p style={styles.error}>{error}</p>}

        {result && !result.targetFound && (
          <p style={styles.noResults}>
            "{result.targetName}" wasn't found in the graph. Try a different spelling
            or a more well-known project name.
          </p>
        )}

        {result && result.targetFound && (
          <div style={styles.results}>
            <div style={styles.scoreCard}>
              <div style={{ ...styles.scoreNumber, color: scoreColor(result.overallScore) }}>
                {result.overallScore}
                <span style={styles.scoreOutOf}>/100</span>
              </div>
              <div style={styles.scoreMeta}>
                <div style={styles.scoreTarget}>{result.targetName}</div>
                <div style={styles.scoreLabel}>{scoreLabel(result.overallScore)}</div>
              </div>
            </div>

            <h2 style={styles.resultsTitle}>Breakdown</h2>
            {result.pairs.map((p, i) => {
              const card = (
                <>
                  <div style={styles.pairHeader}>
                    <span style={styles.pairName}>{p.name}</span>
                    {p.found ? (
                      <span style={{ ...styles.pairScore, color: scoreColor(p.score) }}>
                        {p.score}
                      </span>
                    ) : (
                      <span style={styles.pairMissing}>not found</span>
                    )}
                  </div>
                  {p.found && (
                    <div style={styles.pairDetail}>
                      <div style={styles.pairDistance}>
                        {p.distance === null
                          ? isSearching(p)
                            ? "Looking for a connection…"
                            : "No path found"
                          : p.distance === 0
                            ? "Same artist"
                            : `${p.distance} hop${p.distance === 1 ? "" : "s"} away`}
                      </div>
                    </div>
                  )}
                </>
              );
              return p.found ? (
                <button
                  key={`${p.name}-${i}`}
                  type="button"
                  className="pair-card"
                  style={{
                    ...styles.pairCard,
                    ...styles.pairButton,
                    ...(openPair === p ? styles.pairSelected : {}),
                  }}
                  onClick={() => setOpenPair(p)}
                  aria-expanded={openPair === p}
                  aria-controls="connection-panel"
                >
                  {card}
                </button>
              ) : (
                <div key={`${p.name}-${i}`} style={styles.pairCard}>{card}</div>
              );
            })}
          </div>
        )}

      </div>
      {result && openPair && (
        <ConnectionPanel pair={openPair} result={result} searching={isSearching(openPair)} onClose={() => setOpenPair(null)} />
      )}
    </div>
  );
}

/**
 * How one liked artist relates to the compared artist. Uses Explore's node
 * panel (.info-panel): a sidebar on desktop, a bottom sheet on phones.
 */
function ConnectionPanel({
  pair,
  result,
  searching,
  onClose,
}: {
  pair: PairScore;
  result: SimilarityResult;
  searching: boolean;
  onClose: () => void;
}) {
  const path = pair.path;
  return (
    <aside id="connection-panel" className="info-panel" style={panelStyles.panel} aria-label="How they connect">
      <div style={panelStyles.header}>
        <span style={{ ...panelStyles.badge, background: scoreColor(pair.score) }}>{pair.score}/100</span>
        <button onClick={onClose} className="info-close" style={panelStyles.close} aria-label="Close panel">
          ×
        </button>
      </div>
      <h2 style={panelStyles.title}>{pair.name} → {result.targetName}</h2>
      <section style={panelStyles.section}>
        {path == null ? (
          <p style={panelStyles.muted}>{searching ? "Looking for the closest connection…" : "No connection within 6 hops."}</p>
        ) : path.length === 0 ? (
          <p style={panelStyles.muted}>Same artist.</p>
        ) : (
          <PathSteps path={path} />
        )}
      </section>

      <section style={panelStyles.section}>
        <h3 style={panelStyles.heading}>Score</h3>
        <p style={panelStyles.muted}>{scoreFormula(pair, MIN_STRENGTH)}</p>
      </section>
    </aside>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { flex: 1, display: "flex", overflow: "hidden", position: "relative" },
  container: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "1.5rem", overflowY: "auto", gap: "1.25rem" },
  header: { textAlign: "center", maxWidth: "480px" },
  title: { fontSize: "1.6rem", fontWeight: 700, color: "#e0e0e0", marginBottom: "0.25rem" },
  subtitle: { color: "#888", fontSize: "0.9rem" },
  form: { display: "flex", flexDirection: "column", gap: "1rem", width: "100%", maxWidth: "450px" },
  field: { display: "flex", flexDirection: "column", gap: "0.4rem" },
  label: { fontSize: "0.8rem", fontWeight: 600, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.03em" },
  input: { padding: "0.5rem 0.75rem", borderRadius: "4px", border: "1px solid #444", background: "#2a2a2a", color: "#e0e0e0", fontSize: "16px" },
  inputRow: { display: "flex", gap: "0.5rem" },
  autocomplete: { flex: 1 },
  addBtn: { padding: "0.5rem 1rem", borderRadius: "4px", border: "none", background: "#48dbfb", color: "#000", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" },
  chipList: { display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.25rem" },
  chip: { display: "flex", alignItems: "center", gap: "0.3rem", padding: "0.2rem 0.6rem", borderRadius: "12px", background: "#2a2a2a", color: "#e0e0e0", fontSize: "0.8rem", border: "1px solid #444" },
  chipRemove: { background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: "1rem", lineHeight: 1, padding: 0 },
  searchBtn: { padding: "0.6rem 1.25rem", borderRadius: "4px", border: "none", background: "#ff6b6b", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: "0.9rem" },
  error: { color: "#ff6b6b", fontSize: "0.85rem" },
  noResults: { color: "#888", fontSize: "0.9rem", maxWidth: "450px", textAlign: "center" },
  results: { width: "100%", maxWidth: "450px" },
  scoreCard: { display: "flex", alignItems: "center", gap: "1rem", background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "1rem 1.25rem", marginBottom: "1rem" },
  scoreNumber: { fontSize: "2.6rem", fontWeight: 800, lineHeight: 1 },
  scoreOutOf: { fontSize: "1rem", fontWeight: 600, color: "#636e72", marginLeft: "0.15rem" },
  scoreMeta: { display: "flex", flexDirection: "column", gap: "0.2rem" },
  scoreTarget: { fontSize: "1.1rem", fontWeight: 700, color: "#e0e0e0" },
  scoreLabel: { fontSize: "0.8rem", color: "#888" },
  resultsTitle: { fontSize: "1.1rem", fontWeight: 600, color: "#e0e0e0", marginBottom: "0.75rem" },
  pairCard: { background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "6px", padding: "0.75rem", marginBottom: "0.5rem" },
  pairSelected: { border: "1px solid #48dbfb" },
  pairButton: { display: "block", width: "100%", textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer", minHeight: "44px" },
  pairHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.3rem" },
  pairName: { fontWeight: 600, color: "#e0e0e0", fontSize: "0.95rem" },
  pairScore: { fontSize: "1.1rem", fontWeight: 700 },
  pairMissing: { fontSize: "0.75rem", color: "#636e72", fontStyle: "italic" },
  pairDetail: { fontSize: "0.8rem", color: "#888", display: "flex", flexDirection: "column", gap: "0.35rem" },
  pairDistance: { color: "#888" },
};
