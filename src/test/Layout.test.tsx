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
          <Route path="/explore" element={<p>explore</p>} />
          <Route path="/about" element={<p>about</p>} />
          <Route path="/scenes" element={<p>scenes</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

const footers = (html: string) => html.match(/<footer/g)?.length ?? 0;

describe("site footer", () => {
  it("is under the pages that have the nav bar", () => {
    const html = render("/explore");
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
  it("names a page that isn't in the menu yet, with its Preview badge, on every screen size", () => {
    const html = render("/scenes");
    expect(html).toMatch(/class="nav-current nav-current-shown"[^>]*>Scenes<span class="nav-badge"[^>]*>Preview<\/span>/);
  });

  it("names a menu page only for the phone menu, without a badge", () => {
    const html = render("/explore");
    expect(html).toMatch(/class="nav-current"[^>]*>Explore<\/span>/);
    expect(html).not.toContain("nav-badge");
  });
});
