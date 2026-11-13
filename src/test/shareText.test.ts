import { describe, expect, it } from "vitest";
import { shareText } from "../game/shareText";

const base = { start: "Drake", end: "Jimmy Page", url: "https://banded.fm/#/play?start=a&end=b", par: 3 };

describe("shareText", () => {
  it("a win: a square per step by how far it was from the end, the steps against par, and the link", () => {
    expect(shareText({ ...base, dateLabel: "12 Nov 2026", steps: [2, 1, 0], won: true }))
      .toBe("Six Degrees of Music · 12 Nov 2026\nDrake → Jimmy Page\n🟧🟨🟩\n3 steps · on par\nhttps://banded.fm/#/play?start=a&end=b");
    expect(shareText({ ...base, steps: [4, 3, 2, 1, 0], won: true }).split("\n").slice(2, 4))
      .toEqual(["🟥🟥🟧🟨🟩", "5 steps · 2 over par"]);
    expect(shareText({ ...base, steps: [undefined, 0], won: true }).split("\n")[2]).toBe("⬜🟩");
  });

  it("not won (playing, or given up): an invitation to the same puzzle, with nothing about the steps", () => {
    expect(shareText({ ...base, steps: [2], won: false }))
      .toBe("Six Degrees of Music\nCan you connect Drake to Jimmy Page? Par 3.\nhttps://banded.fm/#/play?start=a&end=b");
  });
});
