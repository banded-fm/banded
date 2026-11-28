import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { SiteFooter } from "./SiteFooter";
import logo from "../assets/banded-logo.svg";

// Names and order of the pages.
const NAV_ITEMS = [
  { to: "/graph", label: "Graph" },
  { to: "/map", label: "Map" },
  { to: "/proximity", label: "Proximity" },
  { to: "/upcoming", label: "Upcoming" },
  { to: "/play", label: "Play" },
  { to: "/about", label: "About" },
];

export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const current = NAV_ITEMS.find((item) => item.to === location.pathname);

  // Close the mobile menu after navigating
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  // Close on Escape
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // The home page is its own menu: no nav bar there.
  // It puts the footer after its content itself.
  // Each page sits in the document's one <main> landmark (display: contents, so the layout is unchanged).
  if (location.pathname === "/") return <main style={styles.main}><Outlet /></main>;

  return (
    <>
      <nav className="app-nav" style={styles.nav}>
        <Link to="/" viewTransition className="nav-brand" style={styles.brand} aria-label="Banded home">
          <img src={logo} alt="" className="nav-logo" style={styles.logo} />
        </Link>
        {/* Mobile only (see index.css): current page + the Menu button */}
        {current && <span className="nav-current eyebrow" style={styles.current}>{current.label}</span>}
        <button
          type="button"
          className="nav-toggle"
          style={styles.toggle}
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          aria-controls="nav-links"
        >
          <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
            {menuOpen
              ? <path d="M2 0L14 12M14 0L2 12" stroke="currentColor" strokeWidth="2" />
              : <path d="M0 1h16M0 6h16M0 11h16" stroke="currentColor" strokeWidth="2" />}
          </svg>
          {menuOpen ? "Close" : "Menu"}
        </button>
        <div id="nav-links" className={`nav-links${menuOpen ? " open" : ""}`} style={styles.links}>
          {NAV_ITEMS.map((item, i) => (
            <NavLink
              key={item.to}
              className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
              to={item.to}
              style={({ isActive }) => ({ ...styles.link, ...(isActive ? styles.activeLink : {}) })}
            >
              {/* The number and the arrow (or dot, for this page) show in the phone menu only */}
              <span className="nav-num" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
              <span className="nav-label">{item.label}</span>
              <span className="nav-arrow" aria-hidden="true">{location.pathname === item.to ? "●" : "→"}</span>
            </NavLink>
          ))}
        </div>
      </nav>
      {menuOpen && <div className="nav-backdrop" style={styles.backdrop} onClick={() => setMenuOpen(false)} />}
      <main style={styles.main}><Outlet /></main>
      {/* Not on About, which has the full credits */}
      {location.pathname !== "/about" && <SiteFooter />}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { display: "contents" },
  // The bar: the brand on the left, the pages on the right, a 2px deep rule under it
  nav: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    height: "64px",
    padding: "0 34px 0 48px",
    background: "#F3ECE1",
    borderBottom: "2px solid #2E0A14",
    position: "relative",
    zIndex: 200,
    flex: "none",
  },
  brand: {
    display: "flex",
    alignItems: "center",
    marginRight: "auto",
    textDecoration: "none",
  },
  // The "banded" wordmark (src/assets/banded-logo.svg): as tall as the old 24px text's letters (phones: index.css)
  logo: { display: "block", height: "22px", width: "auto" },
  current: {
    display: "none",
    color: "#7A1631",
  },
  toggle: {
    display: "none",
    gap: "8px",
    height: "40px",
    padding: "0 12px",
    background: "#F3ECE1",
    border: "2px solid #2E0A14",
    color: "#2E0A14",
    fontSize: "14px",
    fontWeight: 500,
    cursor: "pointer",
  },
  links: {
    display: "flex",
    gap: "2px",
    alignSelf: "stretch",
  },
  link: {
    display: "inline-flex",
    alignItems: "center",
    color: "#2E0A14",
    textDecoration: "none",
    fontSize: "15px",
    fontWeight: 500,
    padding: "0 14px",
  },
  activeLink: {
    boxShadow: "inset 0 -4px 0 #7A1631",
  },
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(46, 10, 20, 0.6)",
    zIndex: 150,
  },
};
