import { useEffect, useState } from "react";

/** How long a bottom sheet takes to slide away (index.css: sheet-down). */
export const SHEET_CLOSE_MS = 240;

/**
 * Keeps showing a bottom sheet's last value for a moment after it's closed (set to null), so the sheet can slide
 * away instead of vanishing: returns that value and whether it's closing. Phones only by default (on wide screens the
 * panels are sidebars, which just go); not with reduced motion.
 */
export function useLingering<T>(value: T | null | undefined, { phoneOnly = true }: { phoneOnly?: boolean } = {}): [T | null, boolean] {
  const [last, setLast] = useState<T | null>(value ?? null);
  useEffect(() => {
    if (value != null) { setLast(value); return; }
    const animate = (!phoneOnly || window.matchMedia("(max-width: 640px)").matches)
      && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate) { setLast(null); return; }
    const t = setTimeout(() => setLast(null), SHEET_CLOSE_MS);
    return () => clearTimeout(t);
  }, [value, phoneOnly]);
  // Closed but still showing: closing
  return value != null ? [value, false] : [last, last != null];
}
