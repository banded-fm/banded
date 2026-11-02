import { useState, useEffect, useId, type CSSProperties, type KeyboardEvent } from "react";
import { getDb, hasDetailColumns, isDbLoaded, searchArtists } from "../db/graphDb";
import { defaultSources, findSuggestions, suggestionDetail, type ArtistSuggestion } from "../db/artistSuggest";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** A suggestion was picked from the dropdown. */
  onSelect: (suggestion: ArtistSuggestion) => void;
  /** Enter pressed with no suggestion highlighted (e.g. add the typed name). */
  onEnter?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  inputClassName?: string;
  inputStyle?: CSSProperties;
  wrapperStyle?: CSSProperties;
}

const MIN_CHARS = 2;
const LIMIT = 8;
const DEBOUNCE_MS = 300;

/**
 * Text input with an artist dropdown. Suggestions show MusicBrainz-style
 * disambiguation comment in parentheses (none when MusicBrainz has none) so
 * same-name artists can be told apart. Typing stays free-form: Enter without a highlighted
 * suggestion calls onEnter with the typed text.
 */
export function ArtistAutocomplete({
  value, onChange, onSelect, onEnter, placeholder, ariaLabel, disabled, inputClassName, inputStyle, wrapperStyle,
}: Props) {
  const [suggestions, setSuggestions] = useState<ArtistSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Only look things up for text the user typed, not for prefills or picks.
  const [typed, setTyped] = useState(false);
  // "searching" until the database (or the MusicBrainz fallback) answers; drives the status row.
  const [status, setStatus] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [dbReady, setDbReady] = useState(isDbLoaded());
  const listId = useId();

  // The graph downloads in the background; switch to graph suggestions once it's in.
  useEffect(() => {
    if (!dbReady) getDb().then(() => setDbReady(true)).catch(() => {});
  }, [dbReady]);

  useEffect(() => {
    const q = value.trim();
    if (!typed || q.length < MIN_CHARS) {
      setSuggestions([]);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    // Graph matches show right away; labels (or database results) follow.
    const local = dbReady ? searchArtists(q, LIMIT) : null;
    const localHasLabels = dbReady && hasDetailColumns();
    setSuggestions(local ?? []);
    setActive(-1);
    setStatus("searching");

    // A graph with label columns needs no request, so no debounce either.
    const needsRequest = !(local && local.length > 0 && localHasLabels);
    const timer = setTimeout(() => {
      findSuggestions(q, local, localHasLabels, LIMIT, defaultSources).then((found) => {
        if (cancelled) return;
        if (found) setSuggestions(found);
        setStatus(found ? "done" : "error");
      });
    }, needsRequest ? DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, typed, dbReady]);

  const pick = (s: ArtistSuggestion) => {
    // Picked an artist only MusicBrainz knows: log its MBID as a search miss, so
    // banded-data crawls it and it joins the graph (concertdb misses).
    if (s.fromMusicBrainz) {
      import("../api/supabase").then(({ reportMiss }) => reportMiss(s.id, "dropdown-musicbrainz-pick")).catch(() => {});
    }
    setTyped(false);
    setOpen(false);
    setSuggestions([]);
    onSelect(s);
  };

  const showList = open && suggestions.length > 0;
  const statusText = !open || suggestions.length > 0 || status === "idle" ? null
    : status === "searching" ? "Searching…"
    : status === "error" ? "Couldn't load suggestions"
    : "No matching artists";

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (showList && e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (showList && e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Enter") {
      if (showList && active >= 0) {
        e.preventDefault();
        pick(suggestions[active]!);
      } else if (onEnter) {
        e.preventDefault();
        setOpen(false);
        onEnter();
      }
    }
  };

  return (
    <div className="artist-autocomplete" style={{ ...styles.wrapper, ...wrapperStyle }}>
      <input
        type="text"
        value={value}
        onChange={(e) => {
          setTyped(true);
          setOpen(true);
          onChange(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        placeholder={placeholder}
        disabled={disabled}
        className={inputClassName}
        style={{ ...styles.input, ...inputStyle }}
        aria-label={ariaLabel}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="artist-suggestions"
          style={styles.list}
          // Keep focus in the input so the click lands before blur closes the list.
          onMouseDown={(e) => e.preventDefault()}
        >
          {suggestions.map((s, i) => {
            const detail = suggestionDetail(s);
            return (
              <li
                key={s.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className="artist-option"
                onClick={() => pick(s)}
                onMouseEnter={() => setActive(i)}
                style={{ ...styles.option, ...(i === active ? styles.optionActive : {}) }}
              >
                <span style={styles.text}>
                  <span style={styles.name}>{s.name}</span>
                  {detail && <span style={styles.detail}> ({detail})</span>}
                </span>
                <span style={styles.type}>{s.type === "group" ? "Group" : "Artist"}</span>
              </li>
            );
          })}
        </ul>
      )}
      {statusText && (
        <div className="artist-suggestions" role="status" style={{ ...styles.list, ...styles.status }}>
          {statusText}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrapper: { position: "relative", minWidth: 0 },
  input: { width: "100%", boxSizing: "border-box" },
  list: {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    right: 0,
    zIndex: 50,
    margin: 0,
    padding: "0.25rem 0",
    listStyle: "none",
    background: "#1f1f1f",
    border: "1px solid #444",
    borderRadius: "4px",
    boxShadow: "0 6px 16px rgba(0,0,0,0.5)",
    maxHeight: "320px",
    overflowY: "auto",
    textAlign: "left",
  },
  option: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
    padding: "0.45rem 0.75rem",
    cursor: "pointer",
    fontSize: "0.9rem",
  },
  optionActive: { background: "#2e2e2e" },
  status: { padding: "0.6rem 0.75rem", color: "#888", fontSize: "0.85rem" },
  text: { minWidth: 0, overflowWrap: "break-word" },
  name: { color: "#e0e0e0" },
  detail: { color: "#888" },
  type: { color: "#666", fontSize: "0.75rem", flexShrink: 0 },
};
