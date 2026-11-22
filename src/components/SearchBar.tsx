import { useState, type FormEvent } from "react";
import { ArtistAutocomplete } from "./ArtistAutocomplete";

interface Props {
  /** `id` is set when the artist was picked from the dropdown. */
  onSearch: (query: string, id?: string) => void;
  loading: boolean;
  onReset: () => void;
}

export function SearchBar({ onSearch, loading, onReset }: Props) {
  const [query, setQuery] = useState("");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (trimmed) {
      onSearch(trimmed);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="search-bar" style={styles.form}>
      <div className="search-group" style={styles.searchGroup}>
        <ArtistAutocomplete
          value={query}
          onChange={setQuery}
          onSelect={(s) => {
            setQuery(s.name);
            onSearch(s.name, s.id);
          }}
          placeholder="Search an artist"
          disabled={loading}
          inputStyle={styles.input}
          wrapperStyle={styles.inputWrapper}
          ariaLabel="Search artists"
        />
        {/* Clears the text, inside the box (its background and border), whenever there is text: on desktop and
            phones, focused or not (a clicked node fills the box without focusing it). */}
        {query && (
          <button
            type="button"
            className="search-clear"
            style={styles.clear}
            aria-label="Clear search"
            title="Clear search"
            onClick={(e) => {
              setQuery("");
              e.currentTarget.parentElement?.querySelector("input")?.focus();
            }}
          >
            ×
          </button>
        )}
        {/* Joined to the box: adds the artist's connections, like the panel's +. */}
        <button
          type="submit"
          className="search-add"
          disabled={loading || !query.trim()}
          style={styles.button}
          aria-label={loading ? "Adding connections" : "Add connections"}
          title="Add this artist's connections to the graph"
        >
          {loading ? "…" : <>+<span className="search-add-word"> Add</span></>}
        </button>
      </div>
      <button type="button" onClick={onReset} className="search-reset" style={styles.resetBtn} title="Clear graph">
        Reset
      </button>
    </form>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // The box (a large name on a 2px rule) with its × and + Add, and Reset as a text link
  form: {
    display: "flex",
    alignItems: "flex-end",
    gap: "0 16px",
    padding: "20px 48px 12px",
    background: "#F3ECE1",
    flexWrap: "wrap",
    flex: "none",
  },
  // The box and its buttons are one control: shared height.
  searchGroup: {
    display: "flex",
    alignItems: "stretch",
    gap: "16px",
    // basis 0 (not 780px) so a narrow window shrinks the box instead of wrapping Reset onto its own line
    flex: "1 1 0",
    maxWidth: "780px",
    minWidth: "0",
  },
  inputWrapper: {
    flex: "1 1 0",
    minWidth: 0,
  },
  input: {
    width: "100%",
    height: "56px",
    padding: 0,
    fontSize: "30px",
    letterSpacing: "-0.03em",
    boxSizing: "border-box",
  },
  // On the box's rule, at its right end
  clear: {
    minWidth: "36px",
    marginLeft: "-17px", // over the 16px gap and 1px more, so the two rules overlap (no seam at fractional widths)
    padding: "0 0.25rem",
    border: "none",
    borderBottom: "2px solid #2E0A14",
    background: "transparent",
    color: "#6B4A50",
    fontSize: "1.6rem",
    lineHeight: 1,
    cursor: "pointer",
  },
  button: {
    minWidth: "56px",
    height: "56px",
    padding: "0 28px",
    border: "none",
    background: "#7A1631",
    color: "#F3ECE1",
    fontWeight: 500,
    cursor: "pointer",
    fontSize: "16px",
    whiteSpace: "nowrap",
  },
  resetBtn: {
    height: "56px",
    padding: "0 4px",
    border: "none",
    background: "transparent",
    color: "#2E0A14",
    fontWeight: 500,
    cursor: "pointer",
    fontSize: "16px",
    textDecoration: "underline",
    textUnderlineOffset: "4px",
  },
};
