import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SETLISTFM_BASE = "https://api.setlist.fm/rest/1.0";
const SETLISTFM_API_KEY = Deno.env.get("SETLISTFM_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Stale after 14 days — return cache but refresh in background
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    const artistMbid = url.searchParams.get("artistMbid");
    const artistName = url.searchParams.get("artist");
    const city = url.searchParams.get("city");

    if (!city) {
      return jsonResponse({ error: "Missing 'city' parameter" }, 400);
    }

    // Resolve artist MBID
    let mbid = artistMbid;
    if (!mbid && artistName) {
      // First try our database
      const { data: artist } = await supabase
        .from("artists")
        .select("mbid")
        .ilike("name", artistName)
        .limit(1)
        .single();

      if (artist) {
        mbid = artist.mbid;
      } else {
        // Fallback: resolve via MusicBrainz API
        const mbResponse = await fetch(
          `https://musicbrainz.org/ws/2/artist?query=artist:"${encodeURIComponent(artistName)}"&limit=5&fmt=json`,
          { headers: { "User-Agent": "Banded/0.1 (https://github.com/banded-fm/banded)" } }
        );

        if (mbResponse.ok) {
          const mbData = await mbResponse.json();
          const mbArtists = mbData.artists || [];
          // Prefer exact name match
          const exactMatch = mbArtists.find(
            (a: any) => a.name.toLowerCase() === artistName.toLowerCase()
          );
          const resolved = exactMatch || mbArtists[0];
          if (resolved) {
            mbid = resolved.id;

            // Add the artist to our database (missing from our dataset)
            const artistType = resolved.type === "Group" ? "group" : "person";
            await supabase.from("artists").upsert({
              mbid: resolved.id,
              name: resolved.name,
              type: artistType,
              disambiguation: resolved.disambiguation || null,
              country: resolved.country || null,
            }, { onConflict: "mbid" });

            // Log as a missing artist (needs to be added to SQLite later)
            await supabase.from("search_misses").insert({
              query: artistName,
              source: "venue-search-missing-artist",
            });
          }
        }

        if (!mbid) {
          // Likely a mistype — log it but don't add to artists
          await supabase.from("search_misses").insert({
            query: artistName,
            source: "venue-search-not-found",
          });
          return jsonResponse({ error: `Artist "${artistName}" not found` }, 404);
        }
      }
    }

    if (!mbid) {
      return jsonResponse({ error: "Provide 'artistMbid' or 'artist' parameter" }, 400);
    }

    // Check crawl_log for freshness
    const { data: crawlEntry } = await supabase
      .from("crawl_log")
      .select("last_fetched")
      .eq("artist_mbid", mbid)
      .eq("city", city)
      .single();

    const hasCachedData = !!crawlEntry;
    const isStale = hasCachedData &&
      (Date.now() - new Date(crawlEntry.last_fetched).getTime()) > STALE_AFTER_MS;

    // If we have cached data, return it immediately
    if (hasCachedData) {
      const venues = await getCachedVenues(mbid, city);

      // If stale, trigger background refresh (non-blocking)
      if (isStale) {
        // EdgeRuntime.waitUntil not available in all envs, so use fire-and-forget
        fetchAndStore(mbid, city).catch(() => {});
      }

      return jsonResponse({
        source: "cache",
        stale: isStale,
        artist: mbid,
        city,
        venues,
      });
    }

    // No cache — fetch from API, store, and return
    const venues = await fetchAndStore(mbid, city);
    return jsonResponse({ source: "api", stale: false, artist: mbid, city, venues });

  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});

// --- Helpers ---

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function getCachedVenues(mbid: string, city: string) {
  // Get played_at relationships for this artist, join with venues in the city
  const { data } = await supabase
    .from("relationships")
    .select("target_id, count")
    .eq("source_id", mbid)
    .eq("rel_type", "played_at");

  if (!data || data.length === 0) return [];

  const venueIds = data.map((r: any) => r.target_id);
  const { data: venues } = await supabase
    .from("venues")
    .select("id, name, city, country")
    .in("id", venueIds)
    .ilike("city", city);

  if (!venues) return [];

  // Merge counts
  const countMap = new Map(data.map((r: any) => [r.target_id, r.count]));
  return venues
    .map((v: any) => ({
      venue: v.name,
      city: v.city,
      country: v.country,
      showCount: countMap.get(v.id) || 0,
    }))
    .sort((a: any, b: any) => b.showCount - a.showCount);
}

/**
 * Keep every setlist fetched, as setlist.fm returned it, as user-requested data
 * (user_requested_data, source "setlistfm", migration 009): concert-database
 * stores them like its own crawl. Never fails the search.
 */
async function keepSetlists(setlists: any[]) {
  const rows = setlists
    .filter((s) => s?.id)
    .map((s) => ({
      source: "setlistfm",
      key: String(s.id),
      data: s,
      version: s.lastUpdated ?? null,
      fetched_at: new Date().toISOString(),
    }));
  if (rows.length === 0) return;
  const { error } = await supabase.from("user_requested_data").upsert(rows, { onConflict: "source,key" });
  if (error) console.error("keeping setlists failed:", error.message);
}

async function fetchAndStore(mbid: string, city: string) {
  // Fetch from Setlist.fm
  const response = await fetch(
    `${SETLISTFM_BASE}/search/setlists?artistMbid=${mbid}&cityName=${encodeURIComponent(city)}&p=1`,
    { headers: { Accept: "application/json", "x-api-key": SETLISTFM_API_KEY } }
  );

  if (!response.ok) {
    if (response.status === 404) return [];
    throw new Error(`Setlist.fm API error: ${response.status}`);
  }

  const data = await response.json();
  const setlists = data.setlist || [];
  await keepSetlists(setlists);

  // Aggregate venues and track venue+date for toured_with detection
  const venueMap = new Map<string, { venue: any; count: number }>();
  const showsByVenueDate = new Map<string, { venueId: string; date: string }>();

  for (const setlist of setlists) {
    const venue = setlist.venue;
    if (!venue) continue;

    const existing = venueMap.get(venue.id);
    if (existing) {
      existing.count++;
    } else {
      venueMap.set(venue.id, { venue, count: 1 });
    }

    // Track for toured_with detection
    const eventDate = setlist.eventDate;
    if (eventDate && venue.id) {
      showsByVenueDate.set(`${venue.id}_${eventDate}`, { venueId: venue.id, date: eventDate });
    }
  }

  // Store venues and played_at relationships
  for (const [venueId, { venue, count }] of venueMap) {
    const venueCity = venue.city || {};

    // Upsert venue
    await supabase.from("venues").upsert({
      id: venueId,
      name: venue.name,
      city: venueCity.name || null,
      state: venueCity.state || null,
      country: venueCity.country?.name || null,
    }, { onConflict: "id" });

    // Upsert played_at relationship
    const { data: existingRel } = await supabase
      .from("relationships")
      .select("id, count")
      .eq("source_id", mbid)
      .eq("target_id", venueId)
      .eq("rel_type", "played_at")
      .single();

    if (existingRel) {
      await supabase
        .from("relationships")
        .update({ count: Math.max(existingRel.count, count) })
        .eq("id", existingRel.id);
    } else {
      await supabase.from("relationships").insert({
        source_id: mbid,
        target_id: venueId,
        rel_type: "played_at",
        count,
      });
    }
  }

  // Detect toured_with: for each venue this artist played at,
  // check if other artists played there on the same date
  for (const { venueId, date } of showsByVenueDate.values()) {
    try {
      // Query venue setlists for that date (uses 1 API request per venue+date check)
      // To be conservative with API limits, only check the first 3 venues
      const venueResponse = await fetch(
        `${SETLISTFM_BASE}/venue/${venueId}/setlists?p=1`,
        { headers: { Accept: "application/json", "x-api-key": SETLISTFM_API_KEY } }
      );

      if (!venueResponse.ok) continue;

      const venueData = await venueResponse.json();
      const venueSetlists = venueData.setlist || [];
      await keepSetlists(venueSetlists);

      // Find other artists who played at this venue on the same date
      for (const vs of venueSetlists) {
        if (vs.eventDate !== date) continue;
        if (!vs.artist?.mbid || vs.artist.mbid === mbid) continue;

        const otherMbid = vs.artist.mbid;

        // Store toured_with (consistent ordering)
        const [a, b] = [mbid, otherMbid].sort();
        const { data: existingTour } = await supabase
          .from("relationships")
          .select("id, count")
          .eq("source_id", a)
          .eq("target_id", b)
          .eq("rel_type", "toured_with")
          .single();

        if (existingTour) {
          await supabase
            .from("relationships")
            .update({ count: existingTour.count + 1 })
            .eq("id", existingTour.id);
        } else {
          await supabase.from("relationships").insert({
            source_id: a,
            target_id: b,
            rel_type: "toured_with",
            count: 1,
          });
        }
      }
    } catch {
      // Skip venue if API fails — don't block the whole request
      continue;
    }

    // Limit venue lookups to avoid burning too many API requests
    // Only check up to 3 venues per request
    break;
  }

  // Update crawl_log
  await supabase.from("crawl_log").upsert({
    artist_mbid: mbid,
    city,
    last_fetched: new Date().toISOString(),
  }, { onConflict: "artist_mbid,city" });

  // Return results
  return [...venueMap.values()]
    .map(({ venue, count }) => ({
      venue: venue.name,
      city: venue.city?.name || city,
      country: venue.city?.country?.name || null,
      showCount: count,
    }))
    .sort((a, b) => b.showCount - a.showCount);
}
