import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { SiteFooter } from "./SiteFooter";

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
  if (location.pathname === "/") return <Outlet />;

  return (
    <>
      <nav className="app-nav" style={styles.nav}>
        <Link to="/" viewTransition className="nav-brand" style={styles.brand} aria-label="Banded home">Banded</Link>
        {/* Mobile only (see index.css): current tab + hamburger toggle */}
        {current && <span className="nav-current" style={styles.current}>{current.label}</span>}
        <button
          type="button"
          className="nav-toggle"
          style={styles.toggle}
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          aria-controls="nav-links"
        >
          {menuOpen ? "✕" : "☰"}
        </button>
        <div id="nav-links" className={`nav-links${menuOpen ? " open" : ""}`} style={styles.links}>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              className="nav-link"
              to={item.to}
              style={({ isActive }) => ({ ...styles.link, ...(isActive ? styles.activeLink : {}) })}
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>
      {menuOpen && <div className="nav-backdrop" style={styles.backdrop} onClick={() => setMenuOpen(false)} />}
      <Outlet />
      {/* Not on About, which has the full credits */}
      {location.pathname !== "/about" && <SiteFooter />}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  nav: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    padding: "0.5rem 0.75rem",
    background: "#1a1a1a",
    borderBottom: "1px solid #2a2a2a",
    position: "relative",
    zIndex: 200,
  },
  brand: {
    fontWeight: 700,
    fontSize: "1.1rem",
    color: "#ff6b6b",
    marginRight: "auto",
    textDecoration: "none",
  },
  current: {
    display: "none",
    color: "#e0e0e0",
    fontSize: "0.9rem",
    fontWeight: 500,
  },
  toggle: {
    display: "none",
    background: "none",
    border: "none",
    color: "#e0e0e0",
    fontSize: "1.3rem",
    lineHeight: 1,
    cursor: "pointer",
    minWidth: "44px",
    minHeight: "44px",
    margin: "-0.5rem -0.5rem -0.5rem 0",
  },
  links: {
    display: "flex",
    gap: "0.75rem",
  },
  link: {
    color: "#888",
    textDecoration: "none",
    fontSize: "0.9rem",
    fontWeight: 500,
    padding: "0.25rem 0.5rem",
    borderRadius: "4px",
    transition: "color 0.2s",
  },
  activeLink: {
    color: "#e0e0e0",
    background: "#2a2a2a",
  },
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0, 0, 0, 0.5)",
    zIndex: 150,
  },
};
