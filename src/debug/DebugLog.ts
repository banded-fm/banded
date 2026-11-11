type LogListener = () => void;

export interface LogEntry {
  timestamp: number;
  message: string;
}

/**
 * True when the URL has debug=1 or debug=true, either in the query string
 * (/?debug=1#/graph) or in the hash route's own query (#/graph?debug=true).
 */
export function debugFlagInUrl(loc?: Pick<Location, "search" | "hash">): boolean {
  if (!loc) return false;
  const hashQuery = loc.hash.includes("?") ? loc.hash.slice(loc.hash.indexOf("?")) : "";
  return [loc.search, hashQuery].some((q) => {
    const v = new URLSearchParams(q).get("debug");
    return v !== null && ["1", "true"].includes(v.toLowerCase());
  });
}

class DebugLog {
  private entries: LogEntry[] = [];
  private listeners = new Set<LogListener>();
  private _enabled = debugFlagInUrl(typeof window === "undefined" ? undefined : window.location);

  constructor() {
    // Editing the hash (#/graph?debug=1) doesn't reload the page, so pick the flag up
    // live. It stays on while navigating the app (links drop the flag); reload without
    // the flag to turn it off.
    if (typeof window !== "undefined") {
      window.addEventListener("hashchange", () => {
        if (!this._enabled && debugFlagInUrl(window.location)) {
          this._enabled = true;
          this.notify();
        }
      });
    }
  }

  /** On once the URL has had ?debug=1 or ?debug=true since the page loaded. */
  get enabled(): boolean {
    return this._enabled;
  }

  log(message: string): void {
    this.entries.push({ timestamp: Date.now(), message });
    // Keep last 100 entries
    if (this.entries.length > 100) {
      this.entries = this.entries.slice(-100);
    }
    if (this._enabled) {
      this.notify();
    }
  }

  getEntries(): LogEntry[] {
    return this.entries;
  }

  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const debugLog = new DebugLog();
