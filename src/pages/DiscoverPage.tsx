import { useEffect, useRef, useState } from "react";
// Spotify's own icon, unaltered (developer.spotify.com/documentation/design: "Icon", green RGB)
import spotifyIcon from "../assets/spotify-icon-green.svg";
import { searchCities, getCityEvents, type PollstarCity } from "../api/pollstar";
import { CityAutocomplete } from "../components/CityAutocomplete";
import { buildTieredGraphAccess } from "./tieredGraphAccess";
import { MIN_STRENGTH, scoreArtistsAgainstList } from "./similarity";
import { panelStyles, PathSteps, scoreColor, scoreFormula } from "../components/ConnectionPath";
import { CITY_PAGE_SIZE, MAX_CITY_PAGES, pickCity, searchProgress, streamConcerts, type ConcertSearchProgress } from "./concertSearch";
import { clampRange, defaultRange, formatRange, isoDate, maxDate, type DateRange } from "./dateRange";
import type { RankedConcert } from "./concerts";
import { ArtistAutocomplete } from "../components/ArtistAutocomplete";
import { addPicked, chipLabel, fromSuggestion, loadLikedArtists, pickedKey, saveLikedArtists, type PickedArtist } from "./pickedArtists";
import { loadCity, saveCity } from "./savedCity";
import { getSpotifyArtistUrl } from "../api/musicbrainz";

/** Lets the browser draw (and handle Stop) between scores: each one runs on the main thread. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function DiscoverPage() {
  // The last city searched (this browser), already picked: no lookup to search it again
  const [savedCity] = useState(loadCity);
  const [city, setCity] = useState(savedCity?.name ?? "");
  // The city picked from the dropdown, while its name is still in the input
  const [cityPick, setCityPick] = useState<PollstarCity | null>(savedCity);
  const [searchedCity, setSearchedCity] = useState("");
  // Today through a week from today, until the user picks other dates
  const [range, setRange] = useState<DateRange>(() => defaultRange());
  const [searchedRange, setSearchedRange] = useState<DateRange | null>(null);
  const [artistInput, setArtistInput] = useState("");
  // Shared with Similarity and remembered in this browser
  const [artists, setArtists] = useState<PickedArtist[]>(loadLikedArtists);
  useEffect(() => saveLikedArtists(artists), [artists]);
  const [concerts, setConcerts] = useState<RankedConcert[] | null>(null);
  const [progress, setProgress] = useState<ConcertSearchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The concert whose panel is open (by id, so it follows the concert as it's scored and re-sorted)
  const [openId, setOpenId] = useState<string | null>(null);
  const openConcert = openId ? (concerts?.find((c) => c.id === openId) ?? null) : null;

  // Escape closes the panel.
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openId]);
  // Each search is a run; Stop (or a new search, or leaving the page) ends the current one.
  const runRef = useRef(0);
  // Headliner scores by liked-artist list, kept across searches on this page
  const scoreCache = useRef(new Map<string, { score: number; found: boolean }>());
  useEffect(() => () => void runRef.current++, []);

  const running = progress !== null && (progress.stage === "city" || progress.stage === "concerts");
  const today = isoDate(new Date());
  const lastDay = maxDate(today);
  const rangeLabel = searchedRange ? formatRange(searchedRange) : "";
  const done = progress && concerts ? Math.round(searchProgress(progress, concerts) * 100) : 0;

  const addArtist = (artist: PickedArtist) => {
    if (!artist.name.trim()) return;
    setArtists(addPicked(artists, artist));
    setArtistInput("");
  };

  const handleAddArtist = () => addArtist({ name: artistInput });

  const handleRemoveArtist = (artist: PickedArtist) => {
    setArtists(artists.filter((a) => pickedKey(a) !== pickedKey(artist)));
  };

  /**
   * The city on Pollstar → its upcoming concerts a page at a time (requests are
   * paced) → each page listed as soon as it arrives, then moved into place once
   * its headliners are scored.
   */
  const handleFindConcerts = async () => {
    if (!city.trim() || artists.length === 0 || running) return;
    const run = ++runRef.current;
    const stopped = () => run !== runRef.current;
    const cityName = city.trim();
    const dates = clampRange(range);
    setRange(dates);
    setSearchedCity(cityName);
    setSearchedRange(dates);
    setError(null);
    setConcerts([]);
    setOpenId(null);
    setProgress({ stage: "city", city: null, pagesLoaded: 0, pagesTotal: 0, concertsTotal: 0, scoring: 0, lookingUp: 0 });

    const liked = artists.map(pickedKey).sort().join(",");
    try {
      const tiered = await buildTieredGraphAccess();
      await tiered.prepareArtists(artists);
      await streamConcerts(
        cityName,
        {
          // A picked city as it is; typed text, the best match for it
          // The city found is remembered for next time.
          findCity: async (query) => {
            const found = cityPick && cityPick.name === query ? cityPick : pickCity(await searchCities(query), query);
            if (found) saveCity(found);
            return found;
          },
          cityEvents: (cityId, page) => getCityEvents(cityId, page, dates),
          // A page's headliners together: those missing from the browser graph are
          // fetched at once, then one search from each liked artist scores them all.
          // Each score is reported as soon as it's known, closest matches first.
          scoreMany: async (headliners, onScore) => {
            const scores = new Map<string, { score: number; found: boolean }>();
            const todo = headliners.filter((h) => {
              const cached = scoreCache.current.get(`${liked}|${h.toLowerCase()}`);
              if (cached) {
                scores.set(h, cached);
                onScore(h, cached);
              }
              return !cached;
            });
            if (todo.length === 0) return scores;
            // The browser graph and Postgres only: MusicBrainz (about one request a
            // second) is left for scoreLater, after every page is in
            await tiered.prepareArtists(todo, { musicBrainz: false });
            await yieldToBrowser();
            const graph = tiered.build();
            const known = todo.filter((h) => graph.findNodeByName(h));
            await scoreArtistsAgainstList(graph, known, artists, yieldToBrowser, (h, s) => {
              scores.set(h, s);
              scoreCache.current.set(`${liked}|${h.toLowerCase()}`, s);
              onScore(h, s);
            });
            return scores;
          },
          // Headliners neither graph has, last and one at a time: MusicBrainz is paced
          scoreLater: async (headliners, onScore, isStopped) => {
            for (const h of headliners) {
              if (isStopped()) return;
              await tiered.prepareArtists([h]);
              const graph = tiered.build();
              const done = (s: { score: number; found: boolean }) => {
                scoreCache.current.set(`${liked}|${h.toLowerCase()}`, s);
                onScore(h, s);
              };
              if (!graph.findNodeByName(h)) done({ score: 0, found: false });
              else await scoreArtistsAgainstList(graph, [h], artists, yieldToBrowser, (_, s) => done(s));
            }
          },
        },
        (update) => {
          setConcerts(update.concerts);
          setProgress(update.progress);
        },
        stopped
      );
    } catch (e) {
      if (stopped()) return;
      setError(e instanceof Error ? e.message : "Unknown error");
      setProgress((p) => (p ? { ...p, stage: "done" } : p));
    }
  };

  const handleStop = () => {
    runRef.current++;
    setProgress((p) => (p ? { ...p, stage: "stopped" } : p));
  };

  return (
    <div style={styles.page}>
      <div className="page-container" style={styles.container}>
        <div style={styles.header}>
          <h1 className="page-title" style={styles.title}>Upcoming Concerts</h1>
          <p style={styles.subtitle}>
            Find upcoming concerts in a city, ranked by how well the artist fits your taste.
          </p>
        </div>

        <div style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label}>City</label>
            <CityAutocomplete
              value={city}
              onChange={(v) => {
                setCity(v);
                if (cityPick && v !== cityPick.name) setCityPick(null);
              }}
              onSelect={(c) => {
                setCity(c.name);
                setCityPick(c);
              }}
              onEnter={handleFindConcerts}
              placeholder="e.g. Los Angeles, London, Melbourne"
              inputStyle={styles.input}
              ariaLabel="City"
            />
          </div>

          <div style={styles.dates}>
            <label style={{ ...styles.field, ...styles.dateField }}>
              <span style={styles.label}>From</span>
              <input
                type="date"
                value={range.from}
                min={today}
                max={lastDay}
                onChange={(e) => {
                  const from = e.target.value;
                  // Keep the end on or after the start
                  setRange((r) => ({ from, to: from && r.to < from ? from : r.to }));
                }}
                className="date-input"
                style={{ ...styles.input, ...styles.dateInput }}
                aria-label="From date"
              />
            </label>
            <label style={{ ...styles.field, ...styles.dateField }}>
              <span style={styles.label}>To</span>
              <input
                type="date"
                value={range.to}
                min={range.from || today}
                max={lastDay}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
                className="date-input"
                style={{ ...styles.input, ...styles.dateInput }}
                aria-label="To date"
              />
            </label>
          </div>

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
              <button type="button" onClick={handleAddArtist} disabled={!artistInput.trim()} style={styles.addBtn}>
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

          {running ? (
            // The button is the progress bar while the search runs
            <button
              type="button"
              onClick={handleStop}
              className="discover-stop"
              style={styles.stopBtn}
              aria-label={`Stop (${done}% done)`}
            >
              <span className="progress-fill" style={{ ...styles.progressFill, width: `${done}%` }} aria-hidden="true" />
              <span style={styles.progressLabel}>Stop · {done}%</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleFindConcerts}
              disabled={!city.trim() || artists.length === 0}
              style={styles.searchBtn}
            >
              Find Concerts
            </button>
          )}
        </div>

        {error && <p style={styles.error}>{error}</p>}

        {progress && (
          <StatusLine progress={progress} found={concerts?.length ?? 0} query={searchedCity} dates={rangeLabel} />
        )}

        {concerts && concerts.length > 0 && (
          <div style={styles.results} aria-live="polite">
            <h2 style={styles.resultsTitle}>
              Concerts in {progress?.city ?? searchedCity} ({concerts.length})
              <span style={styles.resultsDates}>{rangeLabel}</span>
            </h2>
            {concerts.map((c) => (
              <button
                key={c.id}
                type="button"
                className="pair-card"
                style={{ ...styles.card, ...styles.cardButton, ...(openId === c.id ? styles.cardSelected : {}) }}
                onClick={() => setOpenId(c.id)}
                aria-expanded={openId === c.id}
                aria-controls="concert-panel"
              >
                <span style={styles.cardHeader}>
                  <span style={styles.cardName}>{c.artistName}</span>
                  <ScoreLabel concert={c} running={running} />
                </span>
                {c.supportingArtists.length > 0 && (
                  <span style={styles.support}>Support from: {c.supportingArtists.join(", ")}</span>
                )}
                <span style={styles.concertMeta}>
                  {formatDate(c.playDate)} · {c.venueName}
                  {c.isFestival ? " · Festival" : ""}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {openConcert && <ConcertPanel concert={openConcert} running={running} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/** A concert's score, or where its scoring is. */
function ScoreLabel({ concert: c, running }: { concert: RankedConcert; running: boolean }) {
  if (!c.scored) return <span style={styles.notFound}>{running ? "scoring…" : "not scored"}</span>;
  if (!c.artistFound) return <span style={styles.notFound}>not in graph</span>;
  return <span style={{ ...styles.match, color: scoreColor(c.score) }}>{c.score}% match</span>;
}

/**
 * How a concert's headliner connects to each liked artist: the strongest path
 * from each, best first. Explore's node panel (.info-panel): a sidebar on
 * desktop, a bottom sheet on phones, like the Similarity page's.
 */
function ConcertPanel({ concert: c, running, onClose }: { concert: RankedConcert; running: boolean; onClose: () => void }) {
  const pairs = [...(c.pairs ?? [])].sort((a, b) => b.score - a.score);
  // The headliner as the graph matched it (each path ends there; an empty path is the liked artist itself)
  const viaPath = pairs.find((p) => p.path && p.path.length > 0)?.path;
  const headlinerId = (viaPath ? viaPath[viaPath.length - 1]!.to.id : undefined)
    ?? pairs.find((p) => p.path && p.path.length === 0)?.node?.id;
  // Spotify: the artist's own page when MusicBrainz links it, else Spotify's search for the name
  const [spotifyPage, setSpotifyPage] = useState<{ id: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!headlinerId || spotifyPage?.id === headlinerId) return;
    let live = true;
    getSpotifyArtistUrl(headlinerId)
      .then((url) => { if (live) setSpotifyPage({ id: headlinerId, url }); })
      .catch(() => { /* the search link stays */ });
    return () => { live = false; };
  }, [headlinerId]); // eslint-disable-line react-hooks/exhaustive-deps
  const spotifyUrl = (spotifyPage?.id === headlinerId ? spotifyPage?.url : null)
    ?? `https://open.spotify.com/search/${encodeURIComponent(c.artistName)}`;
  return (
    <aside id="concert-panel" className="info-panel" style={panelStyles.panel} aria-label="How this concert fits">
      <div style={panelStyles.header}>
        <div style={styles.headerStart}>
          {c.scored && c.artistFound ? (
            <span style={{ ...panelStyles.badge, background: scoreColor(c.score) }}>{c.score}/100</span>
          ) : (
            <span style={panelStyles.muted}>{!c.scored ? (running ? "scoring…" : "not scored") : "not in graph"}</span>
          )}
          {/* open.spotify.com links open the app where it's installed, as Spotify's guidelines ask */}
          <a
            href={spotifyUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.spotify}
            aria-label={`Listen to ${c.artistName} on Spotify`}
            title="Listen on Spotify"
          >
            {/* 22 px (Spotify's minimum is 21), with half its height clear around it inside the 44 px tap target */}
            <img src={spotifyIcon} alt="" width={22} height={22} />
          </a>
        </div>
        <button onClick={onClose} className="info-close" style={panelStyles.close} aria-label="Close panel">
          ×
        </button>
      </div>
      <h2 style={panelStyles.title}>{c.artistName}</h2>
      <section style={panelStyles.section}>
        {c.supportingArtists.length > 0 && <p style={panelStyles.muted}>Support from: {c.supportingArtists.join(", ")}</p>}
        <p style={panelStyles.muted}>
          {formatDate(c.playDate)} · {c.venueName}
          {c.isFestival ? " · Festival" : ""}
        </p>
      </section>
      {!c.scored ? null : !c.artistFound ? (
        <p style={panelStyles.muted}>{c.artistName} isn't in the music graph, so it can't be compared yet.</p>
      ) : (
        <>
          {pairs.map((pair) => (
            <section key={pair.name} style={panelStyles.section}>
              <h3 style={panelStyles.heading}>
                {pair.name} → {c.artistName}: {pair.score}
              </h3>
              {pair.path == null ? (
                <p style={panelStyles.muted}>No connection close enough to count.</p>
              ) : pair.path.length === 0 ? (
                <p style={panelStyles.muted}>Same artist.</p>
              ) : (
                <>
                  <PathSteps path={pair.path} />
                  <p style={panelStyles.muted}>{scoreFormula(pair, MIN_STRENGTH)}</p>
                </>
              )}
            </section>
          ))}
          {pairs.length > 1 && (
            <section style={panelStyles.section}>
              <h3 style={panelStyles.heading}>Score</h3>
              <p style={panelStyles.muted}>
                The best connection ({pairs[0]!.score}), plus a share of each other one scoring 60 or more: {c.score}.
              </p>
            </section>
          )}
        </>
      )}
    </aside>
  );
}

/** Where the search is, then a summary of what it found. */
function StatusLine({
  progress,
  found,
  query,
  dates,
}: {
  progress: ConcertSearchProgress;
  found: number;
  query: string;
  dates: string;
}) {
  const { stage, city, pagesLoaded, pagesTotal, concertsTotal, scoring, lookingUp } = progress;
  const running = stage === "city" || stage === "concerts";
  const of = Math.min(concertsTotal, pagesTotal * CITY_PAGE_SIZE);
  let text: string;
  if (stage === "city") text = `Looking up ${query}…`;
  else if (stage === "concerts") {
    const parts = [pagesLoaded === 0 ? `${city}: loading concerts` : `${city}: ${found} of ${of} concerts`];
    const now = scoring - lookingUp;
    if (now > 0) parts.push(`scoring ${now} artist${now === 1 ? "" : "s"}`);
    else if (lookingUp > 0) parts.push(`looking up ${lookingUp} more artist${lookingUp === 1 ? "" : "s"} on MusicBrainz`);
    text = `${parts.join(" · ")}…`;
  } else if (stage === "stopped") text = `Stopped: ${found} of ${of} concerts in ${city ?? query}.`;
  else if (!city) text = `Couldn't find a city called "${query}" on Pollstar.`;
  else if (found === 0) text = `No concerts in ${city}, ${dates}.`;
  // Only "the first" when there were more pages than it loads (a few events have no headliner)
  else if (concertsTotal > MAX_CITY_PAGES * CITY_PAGE_SIZE) text = `The first ${found} of ${concertsTotal} concerts in ${city}, ${dates}.`;
  else text = `All ${found} concerts in ${city}, ${dates}.`;
  return (
    <div style={styles.status} role="status">
      {running && <span className="spinner" aria-hidden="true" />}
      <span>{text}</span>
    </div>
  );
}

/** Format an ISO play date as a readable local date. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

const styles: Record<string, React.CSSProperties> = {
  headerStart: { display: "flex", alignItems: "center", gap: "0.25rem" },
  spotify: { display: "flex", alignItems: "center", justifyContent: "center", width: "44px", height: "44px", margin: "-11px 0" },
  page: { flex: 1, display: "flex", overflow: "hidden", position: "relative" },
  container: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "1.5rem", overflowY: "auto", gap: "1.25rem" },
  header: { textAlign: "center" },
  title: { fontSize: "1.6rem", fontWeight: 700, color: "#e0e0e0", marginBottom: "0.25rem" },
  subtitle: { color: "#888", fontSize: "0.9rem" },
  form: { display: "flex", flexDirection: "column", gap: "1rem", width: "100%", maxWidth: "450px" },
  field: { display: "flex", flexDirection: "column", gap: "0.4rem" },
  label: { fontSize: "0.8rem", fontWeight: 600, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.03em" },
  input: { padding: "0.5rem 0.75rem", borderRadius: "4px", border: "1px solid #444", background: "#2a2a2a", color: "#e0e0e0", fontSize: "16px" },
  inputRow: { display: "flex", gap: "0.5rem" },
  dates: { display: "flex", flexWrap: "wrap", gap: "0.75rem" },
  dateField: { flex: "1 1 140px", minWidth: 0 },
  // The page's font, and a light calendar icon on the dark field
  dateInput: { fontFamily: "inherit", colorScheme: "dark" },
  resultsDates: { display: "block", fontSize: "0.8rem", fontWeight: 400, color: "#888", marginTop: "0.15rem" },
  autocomplete: { flex: 1 },
  addBtn: { padding: "0.5rem 1rem", borderRadius: "4px", border: "none", background: "#48dbfb", color: "#000", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" },
  chipList: { display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.25rem" },
  chip: { display: "flex", alignItems: "center", gap: "0.3rem", padding: "0.2rem 0.6rem", borderRadius: "12px", background: "#2a2a2a", color: "#e0e0e0", fontSize: "0.8rem", border: "1px solid #444" },
  chipRemove: { background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: "1rem", lineHeight: 1, padding: 0 },
  searchBtn: { padding: "0.6rem 1.25rem", minHeight: "44px", borderRadius: "4px", border: "none", background: "#ff6b6b", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: "0.9rem" },
  stopBtn: { position: "relative", overflow: "hidden", padding: "0.6rem 1.25rem", minHeight: "44px", borderRadius: "4px", border: "1px solid #ff6b6b", background: "transparent", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: "0.9rem" },
  progressFill: { position: "absolute", inset: "0 auto 0 0", background: "rgba(255, 107, 107, 0.55)", transition: "width 0.3s ease-out" },
  progressLabel: { position: "relative" },
  error: { color: "#ff6b6b", fontSize: "0.85rem" },
  status: { display: "flex", alignItems: "center", gap: "0.6rem", color: "#aaa", fontSize: "0.85rem", width: "100%", maxWidth: "450px" },
  results: { width: "100%", maxWidth: "450px" },
  resultsTitle: { fontSize: "1.1rem", fontWeight: 600, color: "#e0e0e0", marginBottom: "0.75rem" },
  card: { background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "6px", padding: "0.75rem", marginBottom: "0.5rem" },
  cardButton: { display: "flex", flexDirection: "column", gap: "0.3rem", width: "100%", textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer", minHeight: "44px" },
  cardSelected: { border: "1px solid #48dbfb" },
  support: { fontSize: "0.8rem", color: "#ccc" },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" },
  cardName: { fontWeight: 600, color: "#e0e0e0", fontSize: "0.95rem", minWidth: 0, overflowWrap: "anywhere" },
  match: { fontSize: "0.8rem", fontWeight: 600, whiteSpace: "nowrap" },
  notFound: { fontSize: "0.72rem", color: "#636e72", fontStyle: "italic", whiteSpace: "nowrap" },
  concertMeta: { fontSize: "0.8rem", color: "#888" },
};
