import { describe, expect, it } from "vitest";
import { parVerdict } from "../game/result";

describe("parVerdict", () => {
  it("says on, under or over par, and by how much", () => {
    expect(parVerdict(4, 4)).toBe("On par");
    expect(parVerdict(3, 4)).toBe("1 under par");
    expect(parVerdict(9, 4)).toBe("5 over par");
  });
});
