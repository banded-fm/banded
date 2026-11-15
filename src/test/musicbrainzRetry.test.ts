import { afterEach, describe, expect, it, vi } from "vitest";
import { searchArtistsPrefix } from "../api/musicbrainz";

const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("MusicBrainz requests", () => {
  it("try again after a 503 (its rate limit)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(200, { artists: [{ id: "nane-tx", name: "Nané" }] }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await searchArtistsPrefix("nane")).map((a) => a.name)).toEqual(["Nané"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("give up after two retries", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => reply(503));
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchArtistsPrefix("nane")).rejects.toThrow("503");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("don't retry other errors", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => reply(400));
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchArtistsPrefix("nane")).rejects.toThrow("400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
