import { describe, expect, it } from "vitest";
import { debugFlagInUrl } from "../debug/DebugLog";

const at = (search: string, hash = "") => debugFlagInUrl({ search, hash });

describe("debugFlagInUrl", () => {
  it("is off without a debug flag", () => {
    expect(debugFlagInUrl(undefined)).toBe(false);
    expect(at("", "#/graph")).toBe(false);
    expect(at("?other=1", "#/graph?x=true")).toBe(false);
  });

  it("turns on for debug=1 or debug=true in the query string", () => {
    expect(at("?debug=1", "#/graph")).toBe(true);
    expect(at("?a=b&debug=true")).toBe(true);
    expect(at("?debug=TRUE")).toBe(true);
  });

  it("turns on for the flag in the hash route's query", () => {
    expect(at("", "#/graph?debug=1")).toBe(true);
    expect(at("", "#/upcoming?city=London&debug=true")).toBe(true);
  });

  it("stays off for other values", () => {
    expect(at("?debug=0")).toBe(false);
    expect(at("?debug=false", "#/?debug=no")).toBe(false);
    expect(at("?debug")).toBe(false);
  });
});
