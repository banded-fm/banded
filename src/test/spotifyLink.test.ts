import { describe, expect, it } from "vitest";
import { pickSpotifyArtistUrl, type MBRelation } from "../api/musicbrainz";

const url = (resource: string, extra: Partial<MBRelation> = {}): MBRelation =>
  ({ type: "free streaming", "target-type": "url", direction: "forward", url: { resource }, ...extra });

describe("pickSpotifyArtistUrl", () => {
  it("finds the artist's Spotify page among its links", () => {
    expect(pickSpotifyArtistUrl([
      url("https://www.deezer.com/artist/123"),
      url("https://open.spotify.com/artist/2ye2Wgw4gimLv2eAKyk1NB"),
    ])).toBe("https://open.spotify.com/artist/2ye2Wgw4gimLv2eAKyk1NB");
  });

  it("prefers a current link to an ended one, and ignores albums, tracks and other kinds", () => {
    expect(pickSpotifyArtistUrl([
      url("https://open.spotify.com/artist/old", { ended: true }),
      url("https://open.spotify.com/album/1A2B"),
      url("https://open.spotify.com/artist/new"),
    ])).toBe("https://open.spotify.com/artist/new");
    expect(pickSpotifyArtistUrl([url("https://open.spotify.com/album/1A2B")])).toBeNull();
    expect(pickSpotifyArtistUrl(undefined)).toBeNull();
  });
});
