import { describe, expect, it } from "vitest";
import { LABEL_FONT, LINE_HEIGHT, boxCollide, edgeOffset, layoutBubble, wrapName } from "../graph/bubbles";

// A fixed-width "font": every character is 0.5 em wide
const measure = (t: string) => t.length * LABEL_FONT * 0.5;

describe("bubble labels", () => {
  it("keeps names that fit on one line", () => {
    expect(wrapName("Osees", measure)).toEqual(["Osees"]);
    expect(wrapName("Ty Segall Band", measure)).toEqual(["Ty Segall Band"]);
  });

  it("wraps a long name onto balanced lines", () => {
    expect(wrapName("King Gizzard & the Lizard Wizard", measure)).toEqual(["King Gizzard &", "the Lizard Wizard"]);
  });

  it("sizes the box to hold the text, never narrower than the type's minimum", () => {
    expect(layoutBubble("Fuzz", "artist", measure).width).toBe(16);
    const b = layoutBubble("King Gizzard & the Lizard Wizard", "artist", measure);
    expect(b.width).toBeGreaterThan(Math.max(...b.lines.map(measure)));
    expect(b.height).toBeGreaterThan(b.lines.length * LINE_HEIGHT);
    expect(b.corner).toBeLessThanOrEqual(b.height / 2);
  });

  it("copes with an empty name", () => {
    expect(layoutBubble("", undefined, measure).lines).toEqual(["?"]);
  });
});

describe("bubble geometry", () => {
  it("finds where a line leaves the box", () => {
    const box = { width: 20, height: 10 };
    expect(edgeOffset(box, 1, 0)).toEqual([10, 0]);
    expect(edgeOffset(box, 0, -1)).toEqual([0, -5]);
    expect(edgeOffset(box, 10, 10)).toEqual([5, 5]);
  });

  it("pushes overlapping boxes apart", () => {
    const nodes = [{ x: 0, y: 0, vx: 0, vy: 0 }, { x: 5, y: 1, vx: 0, vy: 0 }];
    const force = boxCollide(() => ({ width: 20, height: 10 }), 2);
    force.initialize(nodes);
    force();
    expect(nodes[0]!.vy).toBeLessThan(0);
    expect(nodes[1]!.vy).toBeGreaterThan(0);
    const apart = [{ x: 0, y: 0, vx: 0, vy: 0 }, { x: 50, y: 0, vx: 0, vy: 0 }];
    force.initialize(apart);
    force();
    expect(apart[0]!.vx).toBe(0);
  });
});
