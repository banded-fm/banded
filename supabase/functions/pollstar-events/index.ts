/**
 * pollstar-events: Discover's Pollstar data, fetched by our server and shared
 * by every visitor through a 24-hour cache. Replaces the browser calling
 * Pollstar through corsproxy.io.
 *
 *   GET ?search=<venue name>              Pollstar's venue autocomplete
 *   GET ?venue=<Pollstar venue id>&search=<the search that found it>
 *                                          the venue's upcoming events
 *   → { source: "cache" | "pollstar" | "stale", fetchedAt, data: <Pollstar's JSON> }
 *   → 503 { unavailable: true } when Pollstar refuses and nothing is cached
 *     (the app then falls back to the browser path for that request)
 *
 * The cache is the user_requested_data table (migration 009): a venue search
 * is a `pollstar_search` row (key: the lowercased search), a venue's events a
 * `pollstar` row (key: the venue id; data: { venue, ...Pollstar's events
 * response }), which banded-data stores like its own Pollstar crawl. A row
 * under CACHE_TTL_MS old is served without asking Pollstar; when Pollstar
 * refuses, an older row is served as "stale". Everything stored was fetched
 * here, so nothing a browser sends ends up in the table: the venue's name and
 * city come from the cached search that found it.
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const YEARS_AHEAD = 4;
const PAGE_SIZE = 25;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const VENUE_ID = /^\d{1,12}$/;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mmddyyyy(d: Date): string {
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${d.getUTCFullYear()}`;
}

/** Pollstar's JSON, or null when it refuses (HTTP error, a challenge page, a network error). */
async function fromPollstar(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA } });
    if (!r.ok) {
      console.error(`pollstar-events: HTTP ${r.status} for ${url}`);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error(`pollstar-events: ${e instanceof Error ? e.message : e} for ${url}`);
    return null;
  }
}

async function cached(source: string, key: string) {
  const { data } = await supabase.from("user_requested_data").select("data, fetched_at")
    .eq("source", source).eq("key", key).maybeSingle();
  return data as { data: any; fetched_at: string } | null;
}

async function store(source: string, key: string, data: unknown) {
  const { error } = await supabase.from("user_requested_data").upsert({
    source, key, data, version: await sha256(JSON.stringify(data)), fetched_at: new Date().toISOString(),
  }, { onConflict: "source,key" });
  if (error) console.error("pollstar-events: caching failed:", error.message);
}

/** Serve from the cache when fresh, else Pollstar (and cache it), else the stale cache, else 503. */
async function serveCached(source: string, key: string, fetchFresh: () => Promise<any | null>, view = (d: any) => d) {
  const hit = await cached(source, key);
  if (hit && Date.now() - new Date(hit.fetched_at).getTime() < CACHE_TTL_MS) {
    return reply(200, { source: "cache", fetchedAt: hit.fetched_at, data: view(hit.data) });
  }
  const fresh = await fetchFresh();
  if (fresh) {
    await store(source, key, fresh);
    return reply(200, { source: "pollstar", fetchedAt: new Date().toISOString(), data: view(fresh) });
  }
  if (hit) return reply(200, { source: "stale", fetchedAt: hit.fetched_at, data: view(hit.data) });
  return reply(503, { unavailable: true });
}

function searchKey(search: string): string {
  return search.trim().toLowerCase();
}

function fetchSearch(search: string) {
  return fromPollstar(`https://autocomplete.pollstar.com/global/All/100/${encodeURIComponent(search.trim())}`);
}

/** The venue as Pollstar's search described it (from our cache), else what its events say. */
async function venueInfo(venueId: string, search: string | null, events: any) {
  if (search) {
    const hit = await cached("pollstar_search", searchKey(search));
    const doc = (hit?.data?.response?.docs ?? []).find((d: any) => String(d.EntityId) === venueId && d.EntityType === "Venue");
    if (doc) {
      return { id: venueId, name: doc.ListName ?? null, city: doc.City ?? null, state: doc.State ?? null, location: doc.Location ?? null };
    }
  }
  const named = (events?.events ?? []).find((e: any) => e?.venue?.name);
  return { id: venueId, name: named?.venue?.name ?? null, city: null, state: null, location: null };
}

/** Drops events that have already happened (a cached list can be up to a day old). */
function upcoming(data: any) {
  const today = new Date().toISOString().slice(0, 10);
  const { venue: _venue, ...response } = data ?? {};
  return { ...response, events: (response.events ?? []).filter((e: any) => String(e?.playDate ?? "").slice(0, 10) >= today) };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "GET") return reply(405, { error: "GET only" });
  try {
    const url = new URL(req.url);
    const search = url.searchParams.get("search");
    const venueId = url.searchParams.get("venue");
    if (search !== null && (search.trim() === "" || search.length > 100)) return reply(400, { error: "bad search" });

    if (venueId !== null) {
      if (!VENUE_ID.test(venueId)) return reply(400, { error: "bad venue" });
      return await serveCached("pollstar", venueId, async () => {
        const today = new Date();
        const to = new Date(today);
        to.setUTCFullYear(to.getUTCFullYear() + YEARS_AHEAD);
        const qs = new URLSearchParams({
          page: "0", pageSize: String(PAGE_SIZE), fromDate: mmddyyyy(today), toDate: mmddyyyy(to),
          sortAscending: "true", sortColumn: "playdate", newOnly: "false",
        });
        const events = await fromPollstar(`https://www.pollstar.com/api/companies/${venueId}/events?${qs}`);
        if (!events || !Array.isArray(events.events)) return null;
        return { venue: await venueInfo(venueId, search, events), ...events };
      }, upcoming);
    }
    if (search !== null) {
      return await serveCached("pollstar_search", searchKey(search), async () => {
        const result = await fetchSearch(search);
        return result && result.response ? result : null;
      });
    }
    return reply(400, { error: "give search or venue" });
  } catch (e) {
    console.error("pollstar-events:", e instanceof Error ? e.message : e);
    return reply(503, { unavailable: true });
  }
});
