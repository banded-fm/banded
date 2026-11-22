import { SwissLine } from "../components/SwissLine";

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
    <div className="page-container about-page" style={styles.container}>
      {/* The title on the left; the text on the right, in sections under 2px deep rules */}
      <div className="about-side" style={styles.side}>
        <h1 className="page-title about-title" style={styles.title}>About</h1>
        <div className="eyebrow" style={{ marginTop: "24px" }}>banded.fm</div>
      </div>
      <article className="about-content" style={styles.content}>
        <section style={styles.section}>
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

        </section>
        <SwissLine height={60} />
        <section style={styles.section}>
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

        </section>
        <section style={styles.section}>
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

        <h3 style={styles.question}>How does the proximity score work?</h3>
        <p style={styles.paragraph}>
          The proximity score is determined by the closest connection path between two musical artists.
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

        </section>
        <section style={styles.section}>
        <h2 style={styles.heading}>Source Code</h2>
        <p style={styles.paragraph}>
          Open-source contributions welcome at{" "}
          <A href="https://github.com/banded-fm/banded">github.com/banded-fm/banded</A>
        </p>

        </section>
        <section style={styles.section}>
        <h2 style={styles.heading}>Contact</h2>
        <p style={styles.paragraph}>
          <A href={`mailto:${SUPPORT}`}>{SUPPORT}</A>
        </p>
        </section>
      </article>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    overflowY: "auto",
    padding: "38px 48px 64px",
    display: "flex",
    gap: "52px",
    alignItems: "flex-start", // the content grows past the screen, so the page scrolls to its end (and its bottom padding)
  },
  side: { width: "400px", flex: "none", position: "sticky", top: 0 },
  content: {
    flex: "0 1 812px",
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "40px",
  },
  section: { borderTop: "2px solid #2E0A14", paddingTop: "14px", display: "flex", flexDirection: "column", gap: "16px" },
  title: {
    fontSize: "140px",
    lineHeight: 0.86,
    letterSpacing: "-0.07em",
    color: "#7A1631",
  },
  heading: {
    fontSize: "48px",
    fontWeight: 500,
    lineHeight: 1,
    letterSpacing: "-0.05em",
    color: "#2E0A14",
  },
  question: {
    marginTop: "12px",
    fontSize: "22px",
    fontWeight: 500,
    lineHeight: 1.25,
    letterSpacing: "-0.025em",
    color: "#2E0A14",
  },
  paragraph: {
    color: "#2E0A14",
    fontSize: "18px",
    fontWeight: 400,
    lineHeight: 1.5,
  },
  // A plain link styled as the primary button: no Ko-fi script or embed on the page.
  kofi: {
    display: "inline-flex",
    alignItems: "center",
    minHeight: "48px",
    padding: "0 28px",
    background: "#7A1631",
    color: "#F3ECE1",
    fontWeight: 500,
    fontSize: "15px",
    textDecoration: "none",
  },
  link: {
    color: "#7A1631",
    textDecoration: "underline",
    textUnderlineOffset: "3px",
  },
};
