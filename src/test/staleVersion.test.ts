import { afterEach, describe, expect, it, vi } from "vitest";
import { isStaleFileError, reloadForNewVersion } from "../staleVersion";

describe("a file missing after a deploy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("recognises each browser's failed-import message", () => {
    expect(isStaleFileError(new TypeError("Failed to fetch dynamically imported module: https://banded.fm/assets/ScenesPage-01EI8MEN.js"))).toBe(true);
    expect(isStaleFileError(new TypeError("error loading dynamically imported module: https://banded.fm/assets/x.js"))).toBe(true); // Firefox
    expect(isStaleFileError(new TypeError("Importing a module script failed."))).toBe(true); // Safari
    expect(isStaleFileError(new Error("Unable to preload CSS for /assets/index.css"))).toBe(true);
    expect(isStaleFileError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isStaleFileError(undefined)).toBe(false);
  });

  it("reloads once, then not again for a while", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    expect(reloadForNewVersion(100_000)).toBe(true);
    expect(reloadForNewVersion(105_000)).toBe(false);   // 5 s later: the reload didn't help, so the error shows
    expect(reloadForNewVersion(120_000)).toBe(true);    // a later deploy
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("doesn't reload without storage to guard against a loop", () => {
    vi.stubGlobal("sessionStorage", undefined);
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    expect(reloadForNewVersion()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
