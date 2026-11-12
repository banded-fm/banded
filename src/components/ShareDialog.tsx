import { useEffect, useRef, useState } from "react";

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
    if (open && !d.open) { setCopied(null); d.showModal?.(); }
    if (!open && d.open) d.close();
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
            {copied === "yes" ? "Copied!" : "Copy"}
          </button>
        </div>
        <p role="status" style={copied === "no" ? styles.error : styles.status} hidden={!copied}>
          {copied === "yes" ? "Copied to your clipboard." : copied === "no" ? "Couldn't copy here: select the text above and copy it." : ""}
        </p>
      </div>
    </dialog>
  );
}

const styles: Record<string, React.CSSProperties> = {
  dialog: { margin: "auto", padding: 0, border: "1px solid #333", borderRadius: "12px", background: "#1a1a1a", color: "#e0e0e0", width: "min(360px, calc(100vw - 2rem))", maxWidth: "none" },
  body: { position: "relative", display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1.25rem", textAlign: "center" },
  close: { position: "absolute", top: "0.25rem", right: "0.25rem", width: "44px", height: "44px", border: "none", background: "transparent", color: "#888", fontSize: "1.5rem", cursor: "pointer" },
  title: { fontSize: "1.2rem", fontWeight: 700, color: "#fff", margin: "0 2rem" },
  summary: { color: "#888", fontSize: "0.9rem" },
  text: { padding: "0.75rem", borderRadius: "8px", border: "1px solid #333", background: "#111", color: "#e0e0e0", fontSize: "0.9rem", lineHeight: 1.5, textAlign: "left", whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text" },
  buttons: { display: "flex", gap: "0.5rem" },
  primary: { flex: 1, minHeight: "44px", borderRadius: "6px", border: "none", background: "#ff6b6b", color: "#fff", fontWeight: 600, fontSize: "1rem", cursor: "pointer" },
  secondary: { flex: 1, minHeight: "44px", borderRadius: "6px", border: "1px solid #48dbfb", background: "transparent", color: "#48dbfb", fontWeight: 600, fontSize: "1rem", cursor: "pointer" },
  status: { color: "#888", fontSize: "0.85rem" },
  error: { color: "#ff6b6b", fontSize: "0.85rem" },
};
