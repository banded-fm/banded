import { Link } from "react-router-dom";

/**
 * Shown in place of a page that failed (the router's errorElement), inside the usual nav bar and footer: a plain
 * "Something went wrong" and a way out. (A page's file gone after a deploy reloads by itself first: staleVersion.ts.)
 */
export function RouteError() {
  return (
    <div className="page-container" style={styles.page} role="alert">
      <h1 className="page-title" style={styles.title}>Something went wrong</h1>
      <p style={styles.text}>This page couldn't be shown. Reloading usually fixes it.</p>
      <div style={styles.buttons}>
        <button type="button" onClick={() => window.location.reload()} style={styles.reload}>Reload</button>
        <Link to="/" style={styles.home}>Go home</Link>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { flex: 1, padding: "38px 48px 48px", display: "flex", flexDirection: "column", gap: "20px" },
  title: { fontSize: "clamp(40px, 5.6vw, 76px)", lineHeight: 0.95, letterSpacing: "-0.055em", color: "#7A1631", maxWidth: "760px" },
  text: { fontSize: "18px", fontWeight: 400, lineHeight: 1.45, color: "#2E0A14", maxWidth: "480px" },
  buttons: { display: "flex", alignItems: "center", gap: "20px", marginTop: "8px" },
  reload: { height: "48px", padding: "0 28px", border: "none", background: "#7A1631", color: "#F3ECE1", fontWeight: 500, fontSize: "15px", cursor: "pointer" },
  home: { color: "#7A1631", fontSize: "15px", fontWeight: 500, textDecoration: "underline", textUnderlineOffset: "4px" },
};
