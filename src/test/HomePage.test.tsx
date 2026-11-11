import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { HomePage, HOME_LINKS } from "../pages/HomePage";

describe("HomePage", () => {
  it("links to every page", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );
    for (const to of ["/explore", "/scenes", "/play", "/discover", "/similarity", "/about"]) {
      expect(html).toContain(`href="${to}"`);
    }
    expect(HOME_LINKS).toHaveLength(6);
  });
});
