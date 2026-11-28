import { useEffect, useRef, useState } from "react";
import { SHEET_CLOSE_MS } from "./useLingering";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  /** A line under the title (the result), if any. */
  summary?: string;
  /** What Share / Copy sends. */
  text: string;
}

/** Copies text: the clipboard API, else the older select-and-copy (the API refuses in some browsers and frames). */
async function copyText(text: string, within: HTMLElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Inside the dialog: a modal dialog makes the rest of the page inert, so a text box outside it can't be selected.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    Object.assign(area.style, { position: "fixed", top: "0", left: "0", opacity: "0", pointerEvents: "none" });
    (within ?? document.body).appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

/**
 * A share sheet like Wordle's: what will be shared, then Share (the system share sheet, on phones and tablets)
 * and Copy. It says whether copying worked, and the text can be selected by hand if it didn't.
 */
export function ShareDialog({ open, onClose, title, summary, text }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const canShare = typeof navigator !== "undefined" && !!navigator.share
    && !!window.matchMedia?.("(pointer: coarse)").matches;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setCopied(null); d.classList.remove("sheet-closing"); d.showModal?.(); }
    if (!open && d.open) {
      // Phones: it's a bottom sheet (index.css), which slides away before it closes
      const slide = window.matchMedia("(max-width: 640px)").matches && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!slide) { d.close(); return; }
      d.classList.add("sheet-closing");
      const t = setTimeout(() => { d.close(); d.classList.remove("sheet-closing"); }, SHEET_CLOSE_MS);
      return () => clearTimeout(t);
    }
  }, [open]);

  // "Copied!" goes back to "Copy" after a few seconds, so it can be copied again.
  useEffect(() => {
    if (copied !== "yes") return;
    const t = setTimeout(() => setCopied(null), 3000);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => setCopied((await copyText(text, ref.current)) ? "yes" : "no");
  const share = () => { navigator.share({ text }).catch(() => { /* dismissed */ }); };

  return (
    <dialog
      ref={ref}
      className="share-dialog"
      aria-labelledby="share-dialog-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={styles.dialog}
    >
      <div style={styles.body}>
        <button type="button" onClick={onClose} style={styles.close} aria-label="Close" title="Close">×</button>
        <h2 id="share-dialog-title" style={styles.title}>{title}</h2>
        {summary && <p style={styles.summary}>{summary}</p>}
        {/* The text in full (wrapped, the link too), and selectable by hand if copying fails */}
        <div style={styles.text} aria-label="Text to share">{text}</div>
        <div style={styles.buttons}>
          {canShare && <button type="button" onClick={share} style={styles.primary}>Share</button>}
          <button type="button" onClick={copy} style={canShare ? styles.secondary : styles.primary}>
            <span>{copied === "yes" ? "Copied!" : "Copy"}</span>
            <CopyIcon />
          </button>
        </div>
        <p role="status" style={copied === "no" ? styles.error : styles.status} hidden={!copied}>
          {copied === "yes" ? "Copied to your clipboard." : copied === "no" ? "Couldn't copy here: select the text above and copy it." : ""}
        </p>
      </div>
    </dialog>
  );
}

/** Two overlapping squares (the design's copy icon), in the button's colour. */
function CopyIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" style={{ flex: "none" }}>
      <rect x="7" y="7" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M13 7V2H2v11h5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // A paper card on a 2px deep border with a hard shadow; the title large in maroon, flush left
  dialog: { margin: "auto", padding: 0, border: "2px solid #2E0A14", boxShadow: "8px 8px 0 #2E0A14", background: "#F3ECE1", color: "#2E0A14", width: "min(600px, calc(100vw - 2rem))", maxWidth: "none", overflow: "visible" },
  body: { position: "relative", display: "flex", flexDirection: "column", gap: "14px", padding: "28px 32px 32px", textAlign: "left" },
  close: { position: "absolute", top: "12px", right: "12px", width: "44px", height: "44px", border: "none", background: "transparent", color: "#2E0A14", fontSize: "30px", cursor: "pointer" },
  title: { fontSize: "clamp(36px, 7vw, 56px)", fontWeight: 500, lineHeight: 0.95, letterSpacing: "-0.06em", color: "#7A1631", margin: "0 48px 0 0" },
  summary: { color: "#2E0A14", fontSize: "18px", fontWeight: 400 },
  text: { marginTop: "8px", padding: "18px 20px", border: "2px solid #2E0A14", color: "#2E0A14", fontSize: "17px", fontWeight: 400, lineHeight: 1.55, textAlign: "left", whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text" },
  buttons: { display: "flex", gap: "12px", marginTop: "8px" },
  primary: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", height: "60px", border: "none", background: "#7A1631", color: "#F3ECE1", fontWeight: 500, fontSize: "18px", cursor: "pointer", textAlign: "center", padding: "0 24px" },
  secondary: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", height: "60px", border: "2px solid #2E0A14", background: "transparent", color: "#2E0A14", fontWeight: 500, fontSize: "18px", cursor: "pointer", textAlign: "center", padding: "0 24px" },
  status: { color: "#6B4A50", fontSize: "14px", fontWeight: 400 },
  error: { color: "#7A1631", fontSize: "14px" },
};
