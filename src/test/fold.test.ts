import { describe, expect, it } from "vitest";
import { foldName } from "../db/fold";

describe("foldName", () => {
  it("drops case, accents and other marks", () => {
    expect(foldName("Nané")).toBe("nane");
    expect(foldName("Björk")).toBe("bjork");
    expect(foldName("Sigur Rós")).toBe("sigur ros");
    expect(foldName("Mötley Crüe")).toBe("motley crue");
    expect(foldName("Beyoncé")).toBe(foldName("Beyonce"));
    // the same letter typed as a base letter plus a combining accent
    expect(foldName("Nane\u0301")).toBe("nane");
  });

  it("spells out letters that aren't a letter plus a mark", () => {
    expect(foldName("Røyksopp")).toBe("royksopp");
    expect(foldName("Æ")).toBe("ae");
    expect(foldName("Straßenjungs")).toBe("strassenjungs");
    expect(foldName("Łona")).toBe("lona");
  });

  it("folds other scripts the same way on both sides, and leaves ones without marks alone", () => {
    expect(foldName("妖精帝國")).toBe("妖精帝國");
    expect(foldName("Мумий Тролль")).toBe(foldName("МУМИЙ ТРОЛЛЬ"));
  });
});
