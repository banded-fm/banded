/**
 * After a deploy, a tab opened earlier still asks for the old build's files (their names carry a hash of their
 * contents), which are gone: loading the Map's code then fails. The fix is to load the new version, so reload,
 * but only once in a while, so a file that really can't be fetched (no network) shows the error page instead of
 * reloading over and over.
 */

const KEY = "banded.staleReload";
/** At most one automatic reload in this long (ms). */
const MIN_GAP = 10_000;

/** Reloads the page to pick up the new version, unless it just did. Returns whether it's reloading. */
export function reloadForNewVersion(now: number = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (now - last < MIN_GAP) return false;
    sessionStorage.setItem(KEY, String(now));
  } catch {
    return false; // no storage: no guard against a loop, so don't reload
  }
  window.location.reload();
  return true;
}

/** Whether an error is a script of the app failing to load (each browser words it its own way). */
export function isStaleFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to load module script|Unable to preload CSS/i.test(message);
}
