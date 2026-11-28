import { useEffect, useId, useRef, useState } from "react";

export interface MenuOption {
  value: string;
  label: string;
}

/** Touch screens keep the native picker (a phone's wheel or sheet suits them); mice get the styled list. */
const coarsePointer = () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

/**
 * A "pick one to go there" menu: a button showing `placeholder`, which opens a list styled like the artist dropdowns
 * (2px border, hard shadow, the active row inverted). Picking calls `onPick` and the button goes back to
 * `placeholder` (it's an action, not a value). Keyboard: ↑/↓, Home/End, typing jumps to a match, Enter or Space
 * picks, Escape closes. On touch screens it's a native select instead.
 */
export function SelectMenu({ options, placeholder, onPick, disabled, ariaLabel, style }: {
  options: MenuOption[];
  placeholder: string;
  onPick: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });

  // A click anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Focus moves into the list when it opens; the active row stays in view.
  useEffect(() => { if (open) listRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  if (coarsePointer()) {
    return (
      <select value="" onChange={(e) => { if (e.target.value) onPick(e.target.value); }} aria-label={ariaLabel}
        disabled={disabled} style={{ ...style, cursor: "pointer" }}>
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }

  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  const pick = (i: number) => { const o = options[i]; close(); if (o) onPick(o.value); };
  const openAt = (i: number) => { if (options.length === 0) return; setActive(Math.max(0, Math.min(i, options.length - 1))); setOpen(true); };

  const onListKey = (e: React.KeyboardEvent) => {
    const last = options.length - 1;
    switch (e.key) {
      case "ArrowDown": setActive((a) => Math.min(a + 1, last)); break;
      case "ArrowUp": setActive((a) => Math.max(a - 1, 0)); break;
      case "Home": setActive(0); break;
      case "End": setActive(last); break;
      case "PageDown": setActive((a) => Math.min(a + 8, last)); break;
      case "PageUp": setActive((a) => Math.max(a - 8, 0)); break;
      case "Enter": case " ": pick(active); break;
      case "Escape": close(); break;
      case "Tab": setOpen(false); return;   // let focus move on
      default: {
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
        // Type-ahead: the first row starting with what's been typed in the last moment
        const now = Date.now();
        const text = (now - typed.current.at < 700 ? typed.current.text : "") + e.key.toLowerCase();
        typed.current = { text, at: now };
        const i = options.findIndex((o) => o.label.toLowerCase().startsWith(text));
        if (i >= 0) setActive(i);
        else return;
      }
    }
    e.preventDefault();
  };

  return (
    <div ref={wrapRef} style={{ ...styles.wrap, ...style }}>
      <button ref={buttonRef} type="button" className="select-menu-button" style={styles.button} disabled={disabled}
        aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined}
        onClick={() => (open ? setOpen(false) : openAt(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openAt(e.key === "ArrowUp" ? options.length - 1 : 0); }
        }}>
        <span style={styles.label}>{placeholder}</span>
        <svg width="14" height="9" viewBox="0 0 14 9" aria-hidden="true" style={{ flex: "none", transform: open ? "rotate(180deg)" : undefined }}>
          <path d="M1 1l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </button>
      {open && (
        <ul ref={listRef} id={`${id}-list`} role="listbox" aria-label={ariaLabel} tabIndex={-1}
          aria-activedescendant={`${id}-${active}`} onKeyDown={onListKey} style={styles.list} className="select-menu-list">
          {options.map((o, i) => (
            <li key={o.value} id={`${id}-${i}`} data-i={i} role="option" aria-selected={i === active}
              onPointerMove={() => setActive(i)} onClick={() => pick(i)}
              style={{ ...styles.option, ...(i === 0 ? { borderTop: "none" } : {}), ...(i === active ? styles.optionActive : {}) }}>
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { position: "relative" },
  // Looks like the text fields beside it: no box, a 2px deep rule underneath
  button: {
    display: "flex", alignItems: "center", gap: "12px", width: "100%", height: "48px", padding: 0,
    background: "transparent", border: "none", borderBottom: "2px solid #2E0A14", color: "#2E0A14",
    fontSize: "18px", fontWeight: 500, letterSpacing: "-0.01em", cursor: "pointer", textAlign: "left",
  },
  label: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  list: {
    position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: "100%", width: "max-content", maxWidth: "min(360px, 90vw)",
    zIndex: 50, margin: 0, padding: 0, listStyle: "none", background: "#F3ECE1",
    border: "2px solid #2E0A14", boxShadow: "6px 6px 0 #2E0A14", maxHeight: "320px", overflowY: "auto", outline: "none",
  },
  option: { padding: "10px 14px", borderTop: "1px solid #D8CBBB", cursor: "pointer", fontSize: "16px", letterSpacing: "-0.01em", color: "#2E0A14" },
  optionActive: { background: "#2E0A14", color: "#F3ECE1" },
};
