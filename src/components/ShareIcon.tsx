/**
 * The share symbol people know on their device: there's no single standard. Apple's (iOS, iPadOS, macOS) is a box
 * with an arrow out of the top; Android's (Material Design), also used on Windows, Linux and most of the web, is
 * three connected dots.
 */
const isApple = () => typeof navigator !== "undefined" && /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(navigator.userAgent);

export function ShareIcon({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {isApple() ? (
        <><path d="M12 3v12" /><path d="M8 7l4-4 4 4" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" /></>
      ) : (
        <><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.59 13.51l6.83 3.98" /><path d="M15.41 6.51l-6.82 3.98" /></>
      )}
    </svg>
  );
}
