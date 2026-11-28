import { SwissLine } from "../components/SwissLine";
import { PHONE, useMediaQuery } from "../components/useMediaQuery";
import { useLingering } from "../components/useLingering";
import { SheetScrim } from "../components/SheetScrim";
import { Fragment, useEffect, useRef, useState } from "react";
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
  // Phones: the concert opens in a bottom sheet (kept a moment after closing, to slide away). Wide screens: its row
  // opens in place, its details growing open beneath it (and shrinking away).
  const isPhone = useMediaQuery(PHONE);
  const [sheetConcert, sheetClosing] = useLingering(isPhone ? openConcert : null);
  const [rowConcert, rowClosing] = useLingering(isPhone ? null : openConcert, { phoneOnly: false });

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

  // Once a search's first concerts are in, scroll down to them, with the progress button (Stop · n%) at the top of
  // the screen above them. Once per search.
  const stopRef = useRef<HTMLButtonElement>(null);
  const scrolledFor = useRef<unknown>(null);
  const found = concerts?.length ?? 0;
  useEffect(() => {
    if (!running || found === 0 || scrolledFor.current === progress?.city) return;
    scrolledFor.current = progress?.city;
    stopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [running, found]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!running) scrolledFor.current = null; }, [running]);

  return (
    <div style={styles.page}>
      <div className="page-container split" style={styles.container}>
        {/* The title on the left (the line under it); the fields and concerts in a ruled column on the right */}
        <div className="split-left" style={styles.header}>
          <h1 className="page-title split-title" style={styles.title}>Upcoming concerts</h1>
          <p className="split-sub" style={styles.subtitle}>
            Find upcoming concerts in a city, ranked by how well the artist fits your taste.
          </p>
          <SwissLine className="split-line split-line-short" height={150} phoneSegmentWidth={65} bleed="phone" style={{ marginTop: "72px", marginLeft: "-48px", width: "calc(100% + 48px)" }} />
        </div>

        <div className="split-right" style={styles.column}>
        <div style={styles.form}>
          <div style={styles.field}>
            <label className="eyebrow" style={styles.label}>City</label>
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
              <span className="eyebrow" style={styles.label}>From</span>
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
              <span className="eyebrow" style={styles.label}>To</span>
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
              <button type="button" onClick={handleAddArtist} disabled={!artistInput.trim()} style={styles.addBtn}>
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

          {running ? (
            // The button is the progress bar while the search runs
            <button
              type="button"
              ref={stopRef}
              onClick={handleStop}
              className="discover-stop scroll-target"
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
              Find concerts
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
            {concerts.map((c, i) => (
              <Fragment key={c.id}>
              <button
                type="button"
                className="pair-card"
                style={{ ...styles.card, ...styles.cardButton, ...(i === 0 ? styles.firstCard : {}) }}
                onClick={() => setOpenId(openId === c.id ? null : c.id)}
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
              {rowConcert?.id === c.id && (
                <div className={`row-expand${rowClosing ? " row-collapsing" : ""}`}>
                  <div className="row-expand-inner">
                    <ConcertPanel inline concert={rowConcert} running={running} onClose={() => setOpenId(null)} />
                  </div>
                </div>
              )}
              </Fragment>
            ))}
          </div>
        )}
        </div>
      </div>
      {sheetConcert && <SheetScrim closing={sheetClosing} onClose={() => setOpenId(null)} />}
      {sheetConcert && <ConcertPanel concert={sheetConcert} running={running} closing={sheetClosing} onClose={() => setOpenId(null)} />}
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
function ConcertPanel({ concert: c, running, onClose, closing = false, inline = false }: {
  concert: RankedConcert; running: boolean; onClose: () => void; closing?: boolean;
  /** Wide screens: in its row, beneath it (no close button, title or date: the row has them) */
  inline?: boolean;
}) {
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
  const Box = inline ? "div" : "aside";
  return (
    <Box id="concert-panel" className={inline ? undefined : `info-panel${closing ? " sheet-closing" : ""}`} style={inline ? panelStyles.inline : panelStyles.panel} aria-label="How this concert fits">
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
        {!inline && <button onClick={onClose} className="info-close" style={panelStyles.close} aria-label="Close panel">
          ×
        </button>}
      </div>
      {!inline && <h2 style={panelStyles.title}>{c.artistName}</h2>}
      {!inline && <section style={panelStyles.section}>
        {c.supportingArtists.length > 0 && <p style={panelStyles.muted}>Support from: {c.supportingArtists.join(", ")}</p>}
        <p style={panelStyles.muted}>
          {formatDate(c.playDate)} · {c.venueName}
          {c.isFestival ? " · Festival" : ""}
        </p>
      </section>}
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
    </Box>
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
  container: { flex: 1, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "48px", padding: "38px 48px 48px", overflowY: "auto" },
  header: { flex: "0 1 660px", minWidth: 0 },
  title: { fontSize: "clamp(56px, 8.8vw, 120px)", lineHeight: 0.86, letterSpacing: "-0.065em", color: "#7A1631" },
  subtitle: { color: "#2E0A14", fontSize: "18px", fontWeight: 400, lineHeight: 1.45, marginTop: "28px", maxWidth: "440px" },
  column: { flex: "0 1 512px", minWidth: 0, display: "flex", flexDirection: "column", gap: "24px" },
  form: { display: "flex", flexDirection: "column", gap: "28px", width: "100%", borderTop: "2px solid #2E0A14", paddingTop: "14px" },
  field: { display: "flex", flexDirection: "column", gap: "6px" },
  label: {},
  input: { width: "100%", height: "56px", padding: 0, fontSize: "26px", letterSpacing: "-0.03em" },
  inputRow: { display: "flex", alignItems: "flex-end", gap: "12px" },
  dates: { display: "flex", flexWrap: "wrap", gap: "24px" },
  dateField: { flex: "1 1 140px", minWidth: 0 },
  dateInput: { fontSize: "22px" },
  resultsDates: { display: "block", fontSize: "14px", fontWeight: 400, letterSpacing: 0, textTransform: "none", color: "#6B4A50", marginTop: "4px" },
  autocomplete: { flex: 1, minWidth: 0 },
  addBtn: { flex: "none", height: "56px", padding: "0 28px", border: "none", background: "#7A1631", color: "#F3ECE1", fontWeight: 500, fontSize: "16px", cursor: "pointer", whiteSpace: "nowrap" },
  chipList: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "10px" },
  chip: { display: "flex", alignItems: "center", gap: "6px", height: "36px", padding: "0 6px 0 14px", border: "2px solid #2E0A14", color: "#2E0A14", fontSize: "15px", letterSpacing: "-0.01em" },
  chipRemove: { background: "none", border: "none", color: "#2E0A14", cursor: "pointer", fontSize: "18px", lineHeight: 1, padding: "0 4px" },
  searchBtn: { height: "60px", display: "flex", alignItems: "center", justifyContent: "center", padding: "0 24px", border: "none", background: "#7A1631", color: "#F3ECE1", fontWeight: 500, fontSize: "18px", letterSpacing: "-0.01em", cursor: "pointer", textAlign: "center" },
  // While it runs: the button fills with rose as the search goes
  stopBtn: { position: "relative", overflow: "hidden", height: "60px", padding: "0 24px", border: "2px solid #7A1631", background: "transparent", color: "#2E0A14", fontWeight: 500, fontSize: "18px", cursor: "pointer", textAlign: "center" },
  progressFill: { position: "absolute", inset: "0 auto 0 0", background: "#E8C9C3", transition: "width 0.3s ease-out" },
  progressLabel: { position: "relative" },
  error: { color: "#7A1631", fontSize: "15px" },
  status: { display: "flex", alignItems: "center", gap: "10px", color: "#2E0A14", fontSize: "14px", fontWeight: 400, width: "100%" },
  results: { width: "100%" },
  resultsTitle: { fontSize: "12px", fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "#2E0A14", borderTop: "2px solid #2E0A14", paddingTop: "12px", marginBottom: "8px" },
  // A row per concert: 1px tint rules, a maroon edge; the open one is marked deep
  // A plain ruled row, as on Proximity: no edge colour, nothing marking a concert already opened (border: none first,
  // or a button's default border shows as a grey line down the left)
  card: { border: "none", borderTop: "1px solid #D8CBBB", padding: "10px 0", background: "transparent" },
  // Rules only between rows: none above the first
  firstCard: { borderTop: "none" },
  cardButton: { display: "flex", flexDirection: "column", gap: "4px", width: "100%", textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer", minHeight: "44px", borderRight: "none", borderBottom: "none" },
  support: { fontSize: "13px", fontWeight: 400, color: "#2E0A14" },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "10px" },
  cardName: { fontWeight: 500, color: "#2E0A14", fontSize: "20px", letterSpacing: "-0.02em", minWidth: 0, overflowWrap: "anywhere" },
  match: { fontSize: "15px", fontWeight: 500, whiteSpace: "nowrap" },
  notFound: { fontSize: "12px", letterSpacing: "0.1em", textTransform: "uppercase", color: "#6B4A50", whiteSpace: "nowrap" },
  concertMeta: { fontSize: "13px", fontWeight: 400, color: "#6B4A50" },
};
