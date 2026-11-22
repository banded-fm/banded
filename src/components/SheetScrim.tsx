/**
 * On phones, the dim layer behind a bottom sheet (the design's Play share sheet: deep at 60%), over everything but
 * the sheet; tapping it closes the sheet. Not shown on wider screens (index.css), where the panels are sidebars.
 */
export function SheetScrim({ onClose, everywhere = false, closing = false }: { onClose: () => void; everywhere?: boolean; closing?: boolean }) {
  // everywhere: for a sheet that is one on wide screens too (Play's custom game). closing: fading out with its sheet.
  return <div className={`sheet-scrim${everywhere ? " sheet-scrim-all" : ""}${closing ? " sheet-scrim-closing" : ""}`} aria-hidden="true" onClick={closing ? undefined : onClose} />;
}
