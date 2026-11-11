import { Link } from "react-router-dom";
import { SiteFooter } from "../components/SiteFooter";

/** The pages the home screen links to, in nav order. */
export const HOME_LINKS = [
  { to: "/explore", label: "Explore", description: "Explore the graph. Search artists and walk through their network." },
  { to: "/scenes", label: "Scenes", description: "A world map of music scenes: the artists in each city who play and record together, with their era, genres and best-known names." },
  { to: "/play", label: "Play", description: "Six Degrees of Music: a daily puzzle. Connect two artists through the people and bands between them, in as few moves as you can." },
  { to: "/discover", label: "Discover", description: "Find upcoming concerts in a city, ranked by how well they fit the artists you like." },
  { to: "/similarity", label: "Similarity", description: "Score how close any artist is to a list of artists you love, and see the connections behind the score." },
  { to: "/about", label: "About", description: "How it works and where the data comes from." },
];

export function HomePage() {
  return (
    <div className="page-container home-page" style={styles.container}>
      <div style={styles.content}>
        <h1 className="page-title home-title" style={styles.title}>Banded</h1>
        <p style={styles.summary}>
          Banded maps the connections between artists: shared band members, side projects,
          collaborations and tour support.
        </p>
        <nav className="home-links" style={styles.links} aria-label="Pages">
          {HOME_LINKS.map((link) => (
            <Link key={link.to} to={link.to} viewTransition className="home-card" style={styles.card}>
              <span style={styles.cardTitle}>{link.label}</span>
              <span style={styles.cardText}>{link.description}</span>
            </Link>
          ))}
        </nav>
      </div>
      <SiteFooter inline />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    overflowY: "auto",
    padding: "2.5rem 2rem 0",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  content: {
    maxWidth: "760px",
    width: "100%",
    marginBottom: "2rem",
  },
  title: {
    fontSize: "2rem",
    fontWeight: 700,
    color: "#ff6b6b",
    marginBottom: "0.75rem",
  },
  summary: {
    color: "#bbb",
    fontSize: "1rem",
    lineHeight: 1.6,
    marginBottom: "1.75rem",
  },
  links: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "1rem",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "0.4rem",
    minHeight: "120px",
    padding: "1.25rem",
    background: "#1a1a1a",
    border: "1px solid #2a2a2a",
    borderRadius: "10px",
    textDecoration: "none",
    transition: "border-color 0.2s, background 0.2s",
  },
  cardTitle: {
    fontSize: "1.25rem",
    fontWeight: 700,
    color: "#e0e0e0",
  },
  cardText: {
    fontSize: "0.9rem",
    lineHeight: 1.5,
    color: "#999",
  },
};
