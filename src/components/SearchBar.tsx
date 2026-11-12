import { useState, useEffect, type FormEvent } from "react";
import { ArtistAutocomplete } from "./ArtistAutocomplete";

interface Props {
  /** `id` is set when the artist was picked from the dropdown. */
  onSearch: (query: string, id?: string) => void;
  loading: boolean;
  prefill: string | null;
  onPrefillConsumed: () => void;
  onReset: () => void;
}

export function SearchBar({ onSearch, loading, prefill, onPrefillConsumed, onReset }: Props) {
  const [query, setQuery] = useState("");
  const [highlightKey, setHighlightKey] = useState(0);

  useEffect(() => {
    if (prefill) {
      setQuery(prefill);
      onPrefillConsumed();
      setHighlightKey((k) => k + 1);
    }
  }, [prefill, onPrefillConsumed]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (trimmed) {
      onSearch(trimmed);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="search-bar" style={styles.form}>
      {/* Remounted (key) to replay the highlight when a clicked node fills the box: on the box and its + together. */}
      <div key={highlightKey} className={`search-group${highlightKey > 0 ? " search-group-highlight" : ""}`} style={styles.searchGroup}>
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
        {/* Joined to the box: adds the artist's connections, like the panel's "+ Add connections". */}
        <button
          type="submit"
          className="search-add"
          disabled={loading || !query.trim()}
          style={styles.button}
          aria-label={loading ? "Adding connections" : "Add connections"}
          title="Add this artist's connections to the graph"
        >
          {loading ? "…" : "+"}
        </button>
      </div>
      <button type="button" onClick={onReset} className="search-reset" style={styles.resetBtn} title="Clear graph">
        Reset
      </button>
    </form>
  );
}

const styles: Record<string, React.CSSProperties> = {
  form: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.5rem 0.75rem",
    borderBottom: "1px solid #2a2a2a",
    background: "#1a1a1a",
    flexWrap: "wrap",
  },
  // The box and its + button are one control: no gap, shared height.
  searchGroup: {
    display: "flex",
    alignItems: "stretch",
    gap: 0,
    flex: "1 1 250px",
    minWidth: "0",
  },
  inputWrapper: {
    flex: "1 1 0",
  },
  input: {
    padding: "0.5rem 0.75rem",
    borderRadius: "4px 0 0 4px",
    border: "1px solid #444",
    borderRight: "none",
    background: "#2a2a2a",
    color: "#e0e0e0",
    fontSize: "16px",
    height: "100%",
    boxSizing: "border-box",
  },
  button: {
    minWidth: "44px",
    padding: "0 0.75rem",
    borderRadius: "0 4px 4px 0",
    border: "none",
    background: "#ff6b6b",
    color: "#fff",
    fontWeight: 700,
    cursor: "pointer",
    fontSize: "1.3rem",
    lineHeight: 1,
  },
  resetBtn: {
    padding: "0.5rem 0.75rem",
    borderRadius: "4px",
    border: "1px solid #444",
    background: "transparent",
    color: "#888",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: "0.8rem",
  },
};
