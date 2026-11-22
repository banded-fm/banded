import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { debugLog } from "../debug/DebugLog";

export function DebugConsole() {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Subscribe to debug log changes
  const entries = useSyncExternalStore(
    (cb) => debugLog.subscribe(cb),
    () => debugLog.getEntries()
  );

  const enabled = useSyncExternalStore(
    (cb) => debugLog.subscribe(cb),
    () => debugLog.enabled
  );

  // Auto-scroll when new entries arrive
  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length, expanded]);

  if (!enabled || entries.length === 0) return null;

  const lastEntry = entries[entries.length - 1];

  return (
    <div style={styles.container}>
      <div style={styles.bar}>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={styles.toggleBtn}
          aria-label={expanded ? "Minimize console" : "Expand console"}
          title={expanded ? "Minimize" : "Expand"}
        >
          {expanded ? "▾" : "▸"}
        </button>
        {!expanded && lastEntry && (
          <span style={styles.singleLine}>
            <span style={styles.timestamp}>{formatTime(lastEntry.timestamp)}</span>
            {lastEntry.message}
          </span>
        )}
        <span style={styles.badge}>{entries.length}</span>
      </div>
      {expanded && (
        <div ref={scrollRef} style={styles.logArea}>
          {entries.slice(-10).map((entry, i) => (
            <div key={`${entry.timestamp}-${i}`} style={styles.logLine}>
              <span style={styles.timestamp}>{formatTime(entry.timestamp)}</span>
              {entry.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    borderBottom: "1px solid #D8CBBB",
    background: "#F3ECE1",
    fontFamily: "monospace",
    fontSize: "0.75rem",
  },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.25rem 0.75rem",
    minHeight: "1.5rem",
  },
  toggleBtn: {
    background: "none",
    border: "none",
    color: "#6B4A50",
    cursor: "pointer",
    fontSize: "0.8rem",
    padding: "0 0.25rem",
  },
  singleLine: {
    color: "#6B4A50",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
  },
  badge: {
    background: "#EBE2D5",
    color: "#6B4A50",
    borderRadius: "8px",
    padding: "0 6px",
    fontSize: "0.65rem",
    marginLeft: "auto",
  },
  logArea: {
    maxHeight: "10lh",
    overflowY: "auto",
    padding: "0 0.75rem 0.4rem",
  },
  logLine: {
    color: "#6B4A50",
    padding: "1px 0",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  timestamp: {
    color: "#6B4A50",
    marginRight: "0.5rem",
  },
};
