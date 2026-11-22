import { useEffect, useRef, useState } from "react";

/**
 * Direction B's "line": one continuous zigzag, corner to corner of its frame, the path between two artists. The
 * frame's width sets how many segments it has (about one per `segmentWidth` pixels, an even number so it starts and
 * ends on the bottom edge). It draws itself in (and fades) on a loop; still with reduced motion. Decorative only.
 *
 * Drawn in the frame's own pixels (its viewBox is its measured size, whatever CSS sets), not stretched: the draw-in animation dashes the
 * line by `pathLength`, and a stretched line (preserveAspectRatio="none" + a non-scaling stroke) is dashed in screen
 * pixels instead, so it showed only part of the line, from the wrong place.
 */
/** The empty graph's three lines (Swiss-Graph): a rose and a thin deep line from the top, the maroon one from the
 * bottom, crossing it; each starts drawing a little after the one before. */
const LAYERS = [
  { color: "#E8C9C3", width: 10, fromTop: true, delay: "0s" },
  { color: "#2E0A14", width: 2, fromTop: true, delay: "0.7s" },
  { color: "#7A1631", width: 10, fromTop: false, delay: "0.35s" },
];

export function SwissLine({ height = 140, segmentWidth = 94, phoneSegmentWidth, color = "#7A1631", strokeWidth = 10, layered = false, bleed = false, className, style }: {
  height?: number;
  /** The single line's stroke (the layered lines keep their own). */
  strokeWidth?: number;
  segmentWidth?: number;
  /** Segment width on phones (the 640px breakpoint), for a tighter zigzag there. */
  phoneSegmentWidth?: number;
  color?: string;
  /** Three crossing lines (rose, deep, maroon) instead of one. */
  layered?: boolean;
  /** The frame runs edge to edge of the screen (true, or "phone" for phones only): the line carries on past both
   *  ends on its slope and is cut by the frame, so it runs off the screen instead of stopping with a square end. */
  bleed?: boolean | "phone";
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<SVGSVGElement>(null);
  // The frame's size as laid out: CSS can override the width and height given here (phone styles do).
  const [size, setSize] = useState({ width: 0, height });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const next = { width: Math.round(r.width), height: Math.round(r.height) || height };
      setSize((s) => (s.width === next.width && s.height === next.height ? s : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);
  const { width, height: h } = size;
  const isPhone = typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches;
  const segments = Math.max(2, Math.round(width / (isPhone && phoneSegmentWidth !== undefined ? phoneSegmentWidth : segmentWidth) / 2) * 2);
  const bleeds = bleed === true || (bleed === "phone" && isPhone);
  const segW = width / segments;
  // Room above and below for the sharp (mitred) tips of the 10px line, so the frame never cuts them flat: half the
  // stroke over the sine of half the tip's angle.
  const half = (layered ? 10 : strokeWidth) / 2;
  const pad = Math.min(h / 3, half / Math.sin(Math.atan(segW / 2 / Math.max(1, h))));
  const zigzag = (fromTop: boolean) => {
    const pts = Array.from({ length: segments + 1 }, (_, i) => [i * segW, (i % 2 === 0) !== fromTop ? h - pad : pad]);
    if (bleeds && pts.length > 1) {
      // 16px further on the same slope at each end (more than the stroke), cut off by the frame
      const run = 16 / segW;
      const [a, b] = [pts[0]!, pts[1]!];
      const [y, z] = [pts[pts.length - 1]!, pts[pts.length - 2]!];
      pts.unshift([a[0]! - 16, a[1]! + (a[1]! - b[1]!) * run]);
      pts.push([y[0]! + 16, y[1]! + (y[1]! - z[1]!) * run]);
    }
    return pts.map(([x, yy]) => `${x!.toFixed(1)},${yy!.toFixed(1)}`).join(" ");
  };
  const lines = layered ? LAYERS : [{ color, width: strokeWidth, fromTop: false, delay: "0s" }];
  return (
    <svg ref={ref} className={`swiss-line${className ? ` ${className}` : ""}`} viewBox={`0 0 ${width || 1} ${h}`}
      width="100%" height={height} style={{ display: "block", overflow: bleeds ? "hidden" : "visible", ...style }} aria-hidden="true">
      {width > 0 && lines.map((l) => (
        <polyline key={l.color} points={zigzag(l.fromTop)} fill="none" stroke={l.color} strokeWidth={l.width}
          strokeLinejoin="miter" strokeMiterlimit={10} pathLength={1} style={{ animationDelay: l.delay }} />
      ))}
    </svg>
  );
}
