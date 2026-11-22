import { useState, useEffect, useId, type CSSProperties, type KeyboardEvent } from "react";
import { searchCities, type PollstarCity } from "../api/pollstar";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** A city was picked from the dropdown. */
  onSelect: (city: PollstarCity) => void;
  /** Enter pressed with no suggestion highlighted. */
  onEnter?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  inputStyle?: CSSProperties;
}

const MIN_CHARS = 2;
const LIMIT = 8;
/** Each new text is a Pollstar search (through our server's 24-hour cache), so wait for a pause in typing. */
const DEBOUNCE_MS = 350;

/**
 * Text input with a dropdown of Pollstar cities ("Berlin, Germany", "Berlin, MD"),
 * most prominent first. Same look and keys as ArtistAutocomplete (and its
 * class hooks, for phone sizes). Typing stays free-form: Enter without a
 * highlighted city calls onEnter with the typed text.
 */
export function CityAutocomplete({ value, onChange, onSelect, onEnter, placeholder, ariaLabel, inputStyle }: Props) {
  const [suggestions, setSuggestions] = useState<PollstarCity[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Only look things up for text the user typed, not for a pick.
  const [typed, setTyped] = useState(false);
  const [status, setStatus] = useState<"idle" | "searching" | "done" | "error">("idle");
  const listId = useId();

  useEffect(() => {
    const q = value.trim();
    if (!typed || q.length < MIN_CHARS) {
      setSuggestions([]);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setActive(-1);
    setStatus("searching");
    const timer = setTimeout(() => {
      searchCities(q)
        .then((cities) => {
          if (cancelled) return;
          setSuggestions(cities.slice(0, LIMIT));
          setStatus("done");
        })
        .catch(() => {
          if (!cancelled) setStatus("error");
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, typed]);

  const pick = (city: PollstarCity) => {
    setTyped(false);
    setOpen(false);
    setSuggestions([]);
    onSelect(city);
  };

  const showList = open && suggestions.length > 0;
  const statusText =
    !open || suggestions.length > 0 || status === "idle"
      ? null
      : status === "searching"
        ? "Searching…"
        : status === "error"
          ? "Couldn't load cities"
          : "No matching cities";

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
    <div className="artist-autocomplete" style={styles.wrapper}>
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
          {suggestions.map((c, i) => (
            <li
              key={c.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className="artist-option"
              onClick={() => pick(c)}
              onMouseEnter={() => setActive(i)}
              style={{ ...styles.option, ...(i === active ? styles.optionActive : {}) }}
            >
              {c.name}
            </li>
          ))}
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
    padding: 0,
    listStyle: "none",
    background: "#F3ECE1",
    border: "2px solid #2E0A14",
    boxShadow: "6px 6px 0 #2E0A14",
    maxHeight: "320px",
    overflowY: "auto",
    textAlign: "left",
  },
  option: { display: "flex", alignItems: "center", padding: "10px 14px", borderTop: "1px solid #D8CBBB", cursor: "pointer", fontSize: "16px", letterSpacing: "-0.01em", color: "#2E0A14" },
  optionActive: { background: "#2E0A14", color: "#F3ECE1" },
  status: { padding: "10px 14px", color: "#6B4A50", fontSize: "14px", fontWeight: 400 },
};
