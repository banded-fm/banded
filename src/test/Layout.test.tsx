import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Layout } from "../components/Layout";
import { HomePage } from "../pages/HomePage";

const FOOTER = "Data from MusicBrainz, setlist.fm and Pollstar. Connections and shows may be missing due to incomplete data.";

function render(path: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/graph" element={<p>explore</p>} />
          <Route path="/about" element={<p>about</p>} />
          <Route path="/map" element={<p>scenes</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

const footers = (html: string) => html.match(/<footer/g)?.length ?? 0;

describe("site footer", () => {
  it("is under the pages that have the nav bar", () => {
    const html = render("/graph");
    expect(footers(html)).toBe(1);
    expect(html).toContain(FOOTER);
  });

  it("comes after the home page's content, once", () => {
    const html = render("/");
    expect(footers(html)).toBe(1);
    expect(html.indexOf("<footer")).toBeGreaterThan(html.indexOf('href="/about"'));
  });

  it("isn't on About, which has the full credits", () => {
    expect(footers(render("/about"))).toBe(0);
  });
});

describe("nav bar", () => {
  it("lists the pages by their names, in order: Graph, Map, Proximity, Upcoming, Play, About", () => {
    const html = render("/map");
    const at = (to: string) => html.indexOf(`href="${to}"`);
    const order = ["/graph", "/map", "/proximity", "/upcoming", "/play", "/about"];
    for (let i = 1; i < order.length; i++) expect(at(order[i]!)).toBeGreaterThan(at(order[i - 1]!));
    for (const name of ["Graph", "Map", "Proximity", "Upcoming", "Play", "About"]) expect(html).toContain(`>${name}</a>`);
    expect(html).toMatch(/class="nav-current"[^>]*>Map<\/span>/);
  });

  it("names a menu page only for the phone menu, without a badge", () => {
    const html = render("/graph");
    expect(html).toMatch(/class="nav-current"[^>]*>Graph<\/span>/);
    expect(html).not.toContain("nav-badge");
  });
});
