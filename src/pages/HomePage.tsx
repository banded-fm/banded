import { Link } from "react-router-dom";
import { SiteFooter } from "../components/SiteFooter";

/** The pages the home screen links to, in nav order. */
export const HOME_LINKS = [
  { to: "/graph", label: "Graph", description: "Search artists and walk through their network: band members, side projects and collaborators." },
  { to: "/map", label: "Map", description: "Explore the world’s music scenes based on the artist clusters in the graph." },
  { to: "/proximity", label: "Proximity", description: "Find out how close any artist is to a list of artists you already know, and see their connections." },
  { to: "/upcoming", label: "Upcoming", description: "Find upcoming concerts in a city, ranked by how well they fit the artists you like." },
  { to: "/play", label: "Play", description: "Six degrees of music: a daily puzzle. Connect two artists through the people and bands between them. Also create your own puzzles and share them with friends." },
  { to: "/about", label: "About", description: "How it works and FAQs" },
];

export function HomePage() {
  return (
    <div className="page-container home-page" style={styles.container}>
      <nav className="home-links" style={styles.links} aria-label="Pages">
        {HOME_LINKS.map((link, i) => (
          <Link key={link.to} to={link.to} viewTransition className="home-card" style={{ ...styles.row, ...(i === HOME_LINKS.length - 1 ? styles.lastRow : {}) }}>
            <span style={styles.num} aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
            <span className="home-card-title" style={styles.cardTitle}>{link.label}</span>
            <span className="home-card-text" style={styles.cardText}>{link.description}</span>
          </Link>
        ))}
      </nav>
      {/* The wordmark, with what banded does beside it */}
      <div className="home-foot" style={styles.foot}>
        <h1 className="home-title" style={styles.title}>banded</h1>
        <p className="home-summary" style={styles.summary}>
          banded maps the connections between artists: shared band members, side projects,
          collaborations and tour support.
        </p>
      </div>
      <SiteFooter inline />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    overflowY: "auto",
    padding: "38px 48px 0",
    display: "flex",
    flexDirection: "column",
  },
  links: {
    display: "flex",
    flexDirection: "column",
    maxWidth: "600px",
  },
  // A page per row: its number, its name, what it does; 1px tint rules between
  row: {
    display: "flex",
    alignItems: "baseline",
    gap: "20px",
    padding: "14px 0",
    borderTop: "1px solid #D8CBBB",
    textDecoration: "none",
    color: "#2E0A14",
  },
  lastRow: { borderBottom: "1px solid #D8CBBB" },
  num: { width: "28px", flex: "none", fontSize: "12px", letterSpacing: "0.1em", color: "#7A1631" },
  cardTitle: {
    width: "170px",
    flex: "none",
    fontSize: "30px",
    lineHeight: 1,
    letterSpacing: "-0.04em",
    color: "#2E0A14",
    transition: "color 0.15s",
  },
  cardText: {
    fontSize: "14px",
    fontWeight: 400,
    lineHeight: 1.45,
    color: "#2E0A14",
  },
  foot: {
    marginTop: "auto",
    paddingTop: "40px",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: "32px",
    flexWrap: "wrap",
  },
  title: {
    fontSize: "clamp(96px, 14vw, 190px)",
    fontWeight: 500,
    lineHeight: 0.8,
    letterSpacing: "-0.065em",
    color: "#2E0A14",
    marginLeft: "-8px",
    whiteSpace: "nowrap",
  },
  summary: {
    maxWidth: "552px",
    paddingBottom: "6px",
    fontSize: "clamp(20px, 2.1vw, 28px)",
    lineHeight: 1.15,
    letterSpacing: "-0.035em",
    color: "#7A1631",
  },
};
