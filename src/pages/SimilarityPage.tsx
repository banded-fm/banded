import { SwissLine } from "../components/SwissLine";
import { PHONE, useMediaQuery } from "../components/useMediaQuery";
import { useLingering } from "../components/useLingering";
import { SheetScrim } from "../components/SheetScrim";
import { Fragment, useEffect, useRef, useState } from "react";
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
  // Once a run's scores are in, the page scrolls down to them (the form is above, often filling a phone's screen)
  const resultsRef = useRef<HTMLDivElement>(null);
  const hasResult = result !== null;
  useEffect(() => {
    if (hasResult) resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hasResult]);
  // Phones: the pair opens in a bottom sheet (kept a moment after closing, to slide away). Wide screens: its row
  // opens in place, its details growing open beneath it (and shrinking away).
  const isPhone = useMediaQuery(PHONE);
  const [sheetPair, sheetClosing] = useLingering(isPhone ? openPair : null);
  const [rowPair, rowClosing] = useLingering(isPhone ? null : openPair, { phoneOnly: false });
  const pairKey = (p: PairScore) => p.node?.id ?? p.name;
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
      <div className="page-container split" style={styles.container}>
        {/* The title on the left (the line under it); the fields and results in a ruled column on the right */}
        <div className="split-left" style={styles.header}>
          <h1 className="page-title split-title" style={styles.title}>Proximity score</h1>
          <p className="split-sub" style={styles.subtitle}>
            See how closely an artist fits a group of artists you like, based on
            shared members and connections in the music graph.
          </p>
          <SwissLine className="split-line" height={150} phoneSegmentWidth={65} bleed="phone" style={{ marginTop: "72px", marginLeft: "-48px", width: "calc(100% + 48px)" }} />
        </div>

        <div className="split-right" style={styles.column}>
        <div style={styles.form}>
          <div style={styles.field}>
            <label className="eyebrow" style={styles.label}>Artists you like</label>
            <div style={styles.inputRow}>
              <ArtistAutocomplete
                value={artistInput}
                onChange={setArtistInput}
                onSelect={(a) => addArtist(fromSuggestion(a))}
                onEnter={handleAddArtist}
                placeholder="Add an artist"
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
                + Add
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
            <label className="eyebrow" style={styles.label}>Artist to compare</label>
            <ArtistAutocomplete
              value={target}
              onChange={setTarget}
              onSelect={(a) => {
                setTarget(a.name);
                setTargetPick(fromSuggestion(a));
              }}
              onEnter={handleCompare}
              placeholder="Add an artist"
              inputStyle={styles.input}
              ariaLabel="Artist to compare"
            />
          </div>

          <button
            onClick={handleCompare}
            disabled={loading || !target.trim() || artists.length === 0}
            style={styles.searchBtn}
          >
            {loading ? <><span>Scoring…</span><span className="spinner spinner-light" aria-hidden="true" /></> : "See score"}
          </button>
        </div>

        {error && <p style={styles.error}>{error}</p>}

        {loading && (
          <p className="searching-line" style={styles.searchingLine} role="status">
            <span className="spinner" aria-hidden="true" /> Looking for connections…
          </p>
        )}

        {result && !result.targetFound && (
          <p style={styles.noResults}>
            "{result.targetName}" wasn't found in the graph. Try a different spelling
            or a more well-known project name.
          </p>
        )}

        {result && result.targetFound && (
          <div ref={resultsRef} className="scroll-target" style={styles.results}>
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

            <h2 style={styles.resultsTitle}>
              Breakdown
              {searching.size > 0 && <span className="spinner" style={styles.titleSpinner} aria-label="Still looking for some connections" />}
            </h2>
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
              const isOpen = !!openPair && pairKey(openPair) === pairKey(p);
              return p.found ? (
                <Fragment key={`${p.name}-${i}`}>
                  <button
                    type="button"
                    className="pair-card"
                    style={{
                      ...styles.pairCard,
                      ...styles.pairButton,
                      ...(i === 0 ? styles.firstRow : {}),
                    }}
                    onClick={() => setOpenPair(isOpen ? null : p)}
                    aria-expanded={isOpen}
                    aria-controls="connection-panel"
                  >
                    {card}
                  </button>
                  {rowPair && pairKey(rowPair) === pairKey(p) && (
                    <div className={`row-expand${rowClosing ? " row-collapsing" : ""}`}>
                      <div className="row-expand-inner">
                        <ConnectionPanel inline pair={rowPair} result={result} searching={isSearching(rowPair)} onClose={() => setOpenPair(null)} />
                      </div>
                    </div>
                  )}
                </Fragment>
              ) : (
                <div key={`${p.name}-${i}`} style={{ ...styles.pairCard, ...(i === 0 ? styles.firstRow : {}) }}>{card}</div>
              );
            })}
          </div>
        )}
        </div>

      </div>
      {result && sheetPair && <SheetScrim closing={sheetClosing} onClose={() => setOpenPair(null)} />}
      {result && sheetPair && (
        <ConnectionPanel pair={sheetPair} result={result} searching={isSearching(sheetPair)} closing={sheetClosing} onClose={() => setOpenPair(null)} />
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
  closing = false,
  inline = false,
}: {
  closing?: boolean;
  /** Wide screens: in its row, beneath it (no close button or title: the row is both) */
  inline?: boolean;
  pair: PairScore;
  result: SimilarityResult;
  searching: boolean;
  onClose: () => void;
}) {
  const path = pair.path;
  const Box = inline ? "div" : "aside";
  return (
    <Box id="connection-panel" className={inline ? undefined : `info-panel${closing ? " sheet-closing" : ""}`} style={inline ? panelStyles.inline : panelStyles.panel} aria-label="How they connect">
      {!inline && <div style={panelStyles.header}>
        <span style={{ ...panelStyles.badge, background: scoreColor(pair.score) }}>{pair.score}/100</span>
        <button onClick={onClose} className="info-close" style={panelStyles.close} aria-label="Close panel">
          ×
        </button>
      </div>}
      {!inline && <h2 style={panelStyles.title}>{pair.name} → {result.targetName}</h2>}
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
    </Box>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { flex: 1, display: "flex", overflow: "hidden", position: "relative" },
  container: { flex: 1, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "48px", padding: "38px 48px 48px", overflowY: "auto" },
  header: { flex: "0 1 640px", minWidth: 0 },
  title: { fontSize: "clamp(56px, 8.8vw, 120px)", lineHeight: 0.86, letterSpacing: "-0.065em", color: "#7A1631" },
  subtitle: { color: "#2E0A14", fontSize: "18px", fontWeight: 400, lineHeight: 1.45, marginTop: "28px", maxWidth: "440px" },
  column: { flex: "0 1 512px", minWidth: 0, display: "flex", flexDirection: "column", gap: "28px" },
  form: { display: "flex", flexDirection: "column", gap: "36px", width: "100%", borderTop: "2px solid #2E0A14", paddingTop: "14px" },
  field: { display: "flex", flexDirection: "column", gap: "6px" },
  label: {},
  input: { width: "100%", height: "56px", padding: 0, fontSize: "26px", letterSpacing: "-0.03em" },
  inputRow: { display: "flex", alignItems: "flex-end", gap: "12px" },
  autocomplete: { flex: 1, minWidth: 0 },
  addBtn: { flex: "none", height: "56px", padding: "0 28px", border: "none", background: "#7A1631", color: "#F3ECE1", fontWeight: 500, fontSize: "16px", cursor: "pointer", whiteSpace: "nowrap" },
  chipList: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "10px" },
  chip: { display: "flex", alignItems: "center", gap: "6px", height: "36px", padding: "0 6px 0 14px", border: "2px solid #2E0A14", color: "#2E0A14", fontSize: "15px", letterSpacing: "-0.01em" },
  chipRemove: { background: "none", border: "none", color: "#2E0A14", cursor: "pointer", fontSize: "18px", lineHeight: 1, padding: "0 4px" },
  // Its label centred (with the spinner beside it while scoring)
  searchBtn: { height: "60px", display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", padding: "0 24px", border: "none", background: "#7A1631", color: "#F3ECE1", fontWeight: 500, fontSize: "18px", letterSpacing: "-0.01em", cursor: "pointer", textAlign: "center" },
  error: { color: "#7A1631", fontSize: "15px" },
  noResults: { color: "#2E0A14", fontSize: "15px", fontWeight: 400 },
  results: { width: "100%" },
  // The score: large, in its colour, over a 2px rule
  scoreCard: { display: "flex", alignItems: "flex-end", gap: "20px", borderTop: "2px solid #2E0A14", paddingTop: "14px", marginBottom: "28px" },
  scoreNumber: { fontSize: "88px", fontWeight: 500, lineHeight: 0.85, letterSpacing: "-0.06em" },
  scoreOutOf: { fontSize: "20px", fontWeight: 500, color: "#6B4A50", marginLeft: "4px", letterSpacing: 0 },
  scoreMeta: { display: "flex", flexDirection: "column", gap: "4px", paddingBottom: "4px" },
  scoreTarget: { fontSize: "28px", lineHeight: 1, letterSpacing: "-0.04em", color: "#2E0A14" },
  scoreLabel: { fontSize: "14px", fontWeight: 400, color: "#6B4A50" },
  resultsTitle: { fontSize: "12px", fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "#2E0A14", marginBottom: "8px" },
  // A row per liked artist: 1px tint rules, a maroon edge; the open one is marked deep
  // A plain ruled row: no edge colour, nothing marking a row already opened
  // (border: none first: a button's default border showed as a grey line down the left)
  pairCard: { border: "none", borderTop: "1px solid #D8CBBB", padding: "10px 0", background: "transparent" },
  // Rules only between rows: none above the first
  firstRow: { borderTop: "none" },
  searchingLine: { display: "flex", alignItems: "center", gap: "10px", color: "#2E0A14", fontSize: "15px", fontWeight: 400 },
  titleSpinner: { marginLeft: "10px", verticalAlign: "middle", width: "14px", height: "14px" },
  pairButton: { display: "block", width: "100%", textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer", minHeight: "44px", borderRight: "none", borderBottom: "none" },
  pairHeader: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "2px" },
  pairName: { fontWeight: 500, color: "#2E0A14", fontSize: "20px", letterSpacing: "-0.02em" },
  pairScore: { fontSize: "20px", fontWeight: 500 },
  pairMissing: { fontSize: "12px", letterSpacing: "0.1em", textTransform: "uppercase", color: "#6B4A50" },
  pairDetail: { fontSize: "13px", fontWeight: 400, color: "#6B4A50", display: "flex", flexDirection: "column", gap: "4px" },
  pairDistance: { color: "#6B4A50" },
};
