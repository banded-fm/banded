/**
 * Simple localStorage-based request cache with TTL.
 * Keys are prefixed to avoid collisions.
 */

const PREFIX = "banded_cache_";
const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export function getCached<T>(key: string, ttlMs = DEFAULT_TTL_MS): T | null {
  const raw = localStorage.getItem(PREFIX + key);
  if (!raw) return null;

  try {
    const entry = JSON.parse(raw) as CacheEntry<T>;
    const age = Date.now() - entry.timestamp;
    if (age > ttlMs) {
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    return entry.data;
  } catch {
    localStorage.removeItem(PREFIX + key);
    return null;
  }
}

export function setCache<T>(key: string, data: T): void {
  const entry: CacheEntry<T> = { data, timestamp: Date.now() };
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(entry));
  } catch {
    // localStorage full — silently fail
  }
}

/**
 * Wraps an async fetch function with caching.
 * Returns cached data if available and fresh, otherwise calls fetchFn and caches the result.
 */
export async function cachedFetch<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS
): Promise<T> {
  const cached = getCached<T>(key, ttlMs);
  if (cached !== null) return cached;

  const data = await fetchFn();
  setCache(key, data);
  return data;
}
