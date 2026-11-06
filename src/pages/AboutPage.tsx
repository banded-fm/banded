export function AboutPage() {
  return (
    <div className="page-container" style={styles.container}>
      <div style={styles.content}>
        <h1 style={styles.title}>About Banded</h1>
        <p style={styles.paragraph}>
          Banded is a graph-powered music discovery tool that maps the relationships
          between artists, musicians, and groups. Instead of recommending music based on genre
          tags or listening history, it reveals the real-world connections — shared group members,
          side projects, and collaborations — that create music scenes.
        </p>

        <h2 style={styles.heading}>Explore</h2>
        <p style={styles.paragraph}>
          Search for any artist or group and visualize their network — group members, former members,
          side projects, and supporting musicians rendered as an interactive force-directed graph.
          Click any node to see its connections, then expand further. Your graph persists between
          sessions so you can build up a rich map over time.
        </p>

        <h2 style={styles.heading}>Six Degrees of Music</h2>
        <p style={styles.paragraph}>
          A daily puzzle: two musicians (or two groups) to connect through any of the connections
          the rest of Banded uses: band memberships, supporting roles, playing or singing on each
          other's records, producing them, and opening for each other's shows. Par is the closest
          connection through well-known artists; find a shorter route and you beat it. Navigate by
          selecting from the list of connections at each step.
        </p>
        <p style={styles.paragraph}>
          Everyone gets the same puzzle each day. You can also play a random puzzle from the list,
          or create a custom game between any two connected artists or groups (par is then the
          shortest path). Every game has a shareable link: hit Share to copy a URL that drops a
          friend into the exact same puzzle.
        </p>

        <h2 style={styles.heading}>Discover</h2>
        <p style={styles.paragraph}>
          Find upcoming concerts in any city, ranked by how well each one fits your taste. Enter a
          city, the dates you're interested in (the coming week unless you pick others) and artists
          you like: the app finds the city on Pollstar and loads its shows in those dates a page
          at a time, soonest first (up to the first 1,000).
        </p>
        <p style={styles.paragraph}>
          Concerts appear as they're found and move into place as their headliners are scored with the
          same graph-based similarity as the Similarity page. While it searches, the button shows its
          progress, and Stop ends the search with what it has found so far. Tap a concert to see how
          its headliner connects to the artists you like. Artists not yet in the graph are
          shown but ranked lowest. The artists you like (shared with Similarity) and the
          last city you searched are remembered in your browser for next time.
        </p>

        <h2 style={styles.heading}>Similarity Score</h2>
        <p style={styles.paragraph}>
          Give the app a list of artists you like plus one artist to compare, and it scores how
          closely that artist fits the group — from 0 (no connection) to 100 (same musical world).
          The score uses every relationship in the graph: group memberships, former memberships,
          supporting roles, and album credits.
        </p>
        <p style={styles.paragraph}>
          Not all connections count equally. Current group members are the strongest signal, former
          members slightly less, and supporting musicians less again. Album collaborations are
          weighted by how many credits two artists share. The breakdown shows exactly how each
          connection was made — the shared members, side projects, and albums that link them —
          so a strong match is never a black box.
        </p>

        <h2 style={styles.heading}>Data</h2>
        <p style={styles.paragraph}>
          Powered by a precomputed graph database built from{" "}
          <a href="https://musicbrainz.org" target="_blank" rel="noreferrer" style={styles.link}>
            MusicBrainz
          </a>{" "}
          data dumps (artist relationships, group members, recording credits) and live data from{" "}
          <a href="https://www.setlist.fm" target="_blank" rel="noreferrer" style={styles.link}>
            Setlist.fm
          </a>{" "}
          (venues, concert history). Upcoming concert listings come from{" "}
          <a href="https://www.pollstar.com" target="_blank" rel="noreferrer" style={styles.link}>
            Pollstar
          </a>. MusicBrainz data is under{" "}
          <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noreferrer" style={styles.link}>
            CC0
          </a>{" "}
          (public domain).
        </p>
        <p style={styles.paragraph}>
          Explore, Play, and Similarity use a SQLite database loaded in your browser via WebAssembly
          (~60MB, cached after first visit). Discover queries a backend database that fetches and caches
          venue data on demand.
        </p>

        <h2 style={styles.heading}>FAQ</h2>
        <h3 style={styles.question}>Why can't I import my top artists from Spotify?</h3>
        <p style={styles.paragraph}>
          Spotify no longer lets small apps like this one read listening data for the public. Since
          February 2026, an app in Spotify's Development Mode can be used by at most five people its
          developer approves by hand, and wider access is only granted to established businesses with
          a large user base. A Spotify button that works for five people isn't much use, so we
          removed it. Type the artists you like instead: the dropdown finds them as you type.
        </p>

        <h2 style={styles.heading}>Source Code</h2>
        <p style={styles.paragraph}>
          <a href="https://github.com/rahuljaisimha/banded" target="_blank" rel="noreferrer" style={styles.link}>
            github.com/rahuljaisimha/banded
          </a>
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    overflowY: "auto",
    padding: "2rem",
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start", // the content grows past the screen, so the page scrolls to its end (and its bottom padding)
  },
  content: {
    maxWidth: "600px",
    width: "100%",
    paddingBottom: "3rem", // room after the last section (no footer here)
  },
  title: {
    fontSize: "1.6rem",
    fontWeight: 700,
    color: "#e0e0e0",
    marginBottom: "1rem",
  },
  heading: {
    fontSize: "1.1rem",
    fontWeight: 600,
    color: "#e0e0e0",
    marginTop: "1.5rem",
    marginBottom: "0.5rem",
  },
  question: {
    fontSize: "1rem",
    fontWeight: 600,
    color: "#e0e0e0",
    marginBottom: "0.5rem",
  },
  paragraph: {
    color: "#aaa",
    fontSize: "0.9rem",
    lineHeight: 1.6,
    marginBottom: "0.75rem",
  },
  link: {
    color: "#48dbfb",
    textDecoration: "none",
  },
};
