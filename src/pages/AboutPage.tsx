const MUSICBRAINZ = "https://musicbrainz.org";
const SETLISTFM = "https://www.setlist.fm";
const SUPPORT = "support@banded.fm";
const KOFI = "https://ko-fi.com/banded";

/** A link in the page's text: other sites open in a new tab. */
function A({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith("http");
  return (
    <a href={href} style={styles.link} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
      {children}
    </a>
  );
}

export function AboutPage() {
  return (
    <div className="page-container" style={styles.container}>
      <div style={styles.content}>
        <h1 style={styles.title}>About Banded</h1>
        <p style={styles.paragraph}>
          Banded is a graph-powered music discovery tool that maps the relationships between musical
          artists. Instead of recommending music based on a user listening history, it reveals the
          real-world connections like shared group members, side projects, and collaborations that
          create music scenes.
        </p>
        <p style={styles.paragraph}>
          The goal of this project is to help music nerds explore the artists behind music scenes they
          already like or are curious about, and discover artists in those scenes. This project also
          hopes to help us find lesser-known artists, which is unlikely to happen in big-company music
          recommendation platforms which rely purely on listener counts.
        </p>

        <h2 style={styles.heading}>How it works</h2>
        <p style={styles.paragraph}>
          Banded is powered by a precomputed graph database built from <A href={MUSICBRAINZ}>MusicBrainz</A>{" "}
          data dumps (artist relationships, group members, recording credits) and concert data
          from <A href={SETLISTFM}>Setlist.fm</A> (venues, concert history). I also have
          an <A href="https://github.com/banded-fm/banded-data">offline data collection job</A> that scrapes
          the internet to find data through the internet that is missing from MusicBrainz and Setlist.fm.
          Upcoming concert listings come from <A href="https://www.pollstar.com">Pollstar</A>. Scenes in
          the Map view are found through clusters in the graph using the Louvain method.
        </p>

        <h2 style={styles.heading}>FAQ</h2>
        <h3 style={styles.question}>Why is a musician or connection I know missing?</h3>
        <p style={styles.paragraph}>
          MusicBrainz data is crowd-sourced and as such only has data that the public has added to it.
          This means artists may be missing (rare), artist relationships may be missing (more common),
          and supporting acts may be missing (especially common for smaller artists and older shows).
          Setlist.fm also has tight API rate limits so we can only add 1440 concerts per day to our data.
        </p>
        <p style={styles.paragraph}>
          If you find data that exists in MusicBrainz but is inexplicably missing from Banded, shoot me
          a message at <A href={`mailto:${SUPPORT}`}>{SUPPORT}</A>, or{" "}
          <A href="https://github.com/banded-fm/banded/issues/new">create a GitHub issue</A>.
        </p>

        <h3 style={styles.question}>Can I contribute the data that is missing?</h3>
        <p style={styles.paragraph}>
          Yes, please! Musicians that are missing or connections between musicians come
          from <A href={MUSICBRAINZ}>MusicBrainz</A> which is crowd-sourced. Create an account there and
          follow their process to quickly add artists, artist relationships, or song credits. Missing
          concerts and openers can be added to <A href={SETLISTFM}>Setlist.fm</A> which is also
          crowd-sourced and has a simple process. Banded knows a band is an opener if they have a show at
          the same venue on the same date.
        </p>
        <p style={styles.paragraph}>Changes should apply to Banded within 48 hours.</p>

        <h3 style={styles.question}>Can I import my top artists from Spotify?</h3>
        <p style={styles.paragraph}>
          Spotify no longer lets small apps like this one read listening data for the public. Since
          February 2026, an app in Spotify's Development Mode can be used by at most five people its
          developer approves by hand, and wider access is only granted to established businesses with a
          large user base.
        </p>

        <h3 style={styles.question}>How does the Proximity Score work?</h3>
        <p style={styles.paragraph}>
          The Proximity Score is determined by the closest connection path between two musical artists.
          Connections are weighted so that band members are the strongest connection, openers,
          supporting musicians and song credits come next, and producers are the weakest.
          Collaborations are worth more for more frequent collaborators. Hub damping applies so artists
          with many collaborators provide weaker collaboration connections than artists with fewer
          collaborators. The closest connection path is found using Dijkstra's algorithm to search the
          graph.
        </p>

        <h3 style={styles.question}>How does Banded make money?</h3>
        <p style={styles.paragraph}>
          It doesn't! It is only supported by donations to help with upkeep costs like domain fees,
          storage costs, and search credits for collecting data that is not readily available in
          MusicBrainz or Setlist.fm. I have no plans to have ads or paid
          features currently.
        </p>

        <h3 style={styles.question}>How can I support this project?</h3>
        <p style={styles.paragraph}>
          Contribute at <A href={KOFI}>ko-fi.com/banded</A>. All donations go directly back to maintaining and growing Banded. Any
          excess money will just be used for search credits to speed up the data collection process so
          we have stronger data. I won't be keeping any of the money, I don't really drink coffee anyway.
        </p>
        <p style={styles.paragraph}>
          <a href={KOFI} target="_blank" rel="noreferrer" style={styles.kofi}>Support Banded on Ko-fi</a>
        </p>

        <h2 style={styles.heading}>Source Code</h2>
        <p style={styles.paragraph}>
          Open-source contributions welcome at{" "}
          <A href="https://github.com/banded-fm/banded">github.com/banded-fm/banded</A>
        </p>

        <h2 style={styles.heading}>Contact</h2>
        <p style={styles.paragraph}>
          <A href={`mailto:${SUPPORT}`}>{SUPPORT}</A>
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
  // A plain link styled as a button in Ko-fi's blue: no Ko-fi script or embed on the page.
  kofi: {
    display: "inline-flex",
    alignItems: "center",
    minHeight: "44px",
    padding: "0 1.1rem",
    borderRadius: "999px",
    background: "#00b9fe",
    color: "#fff",
    fontWeight: 600,
    textDecoration: "none",
  },
  link: {
    color: "#48dbfb",
    textDecoration: "none",
  },
};
