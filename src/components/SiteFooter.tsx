/** Where the data comes from, and that it's incomplete. Pinned under each page by
 *  Layout; the home page puts it after its content instead (`inline`). */
export function SiteFooter({ inline = false }: { inline?: boolean }) {
  return (
    <footer className="site-footer" style={inline ? { ...styles.footer, ...styles.inline } : styles.footer}>
      <span>Data from MusicBrainz, setlist.fm and Pollstar.</span>
      <span>Connections and shows may be missing due to incomplete data.</span>
    </footer>
  );
}

const styles: Record<string, React.CSSProperties> = {
  footer: {
    flex: "none",
    display: "flex",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "0 1rem",
    padding: "8px 48px 10px",
    background: "#F3ECE1",
    color: "#6B4A50",
    fontSize: "12px",
    fontWeight: 400,
    lineHeight: 1.3,
  },
  // After the home page's content, at the bottom of the screen when it's short;
  // full width (out over the page's side padding, which index.css narrows on phones)
  inline: {
    marginTop: "auto",
    alignSelf: "stretch",
    marginLeft: "-48px",
    marginRight: "-48px",
  },
};
