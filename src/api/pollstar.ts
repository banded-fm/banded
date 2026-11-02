/**
 * Pollstar client.
 *
 * Pollstar has a paid API, but its website backs onto public JSON endpoints we
 * can read for upcoming events. We only ever ask them from our own server: the
 * pollstar-city function asks Pollstar itself and shares a 24-hour cache
 * between every visitor (a city's page is fetched from Pollstar at most once a
 * day, whoever asks), and keeps the events for banded-data. The browser
 * never calls Pollstar (it sends no CORS headers, and the public CORS proxy we
 * used to go through now wants an API key). When the function can't get the
 * data (Pollstar refusing with nothing cached), the request fails.
 *
 * Endpoints (observed, as the function calls them):
 *   Autocomplete: https://autocomplete.pollstar.com/global/All/100/{query}
 *     → { response: { docs: [{ EntityId, ListName, City, State, Location,
 *                              EntityType, Rank, ... }] } }
 *   City events:  https://www.pollstar.com/api/cities/{cityId}/events
 *                   ?page=&pageSize=&fromDate=MM-DD-YYYY&toDate=MM-DD-YYYY
 *                   &sortAscending=true&sortColumn=playdate&newOnly=false
 *     → { totalPages, totalEvents, events: [{ id, name, playDate, url,
 *          isFestival, venue{...}, artists:[{ name, isHeadline, genres,
 *          artistType }], tickets, ... }] }  (tickets aren't read: see parseEvents)
 *     NOTE: fromDate MUST be today-or-later; past dates are subscription-gated.
 */

import { cachedFetch } from "./cache";
import { pollstarViaServer } from "./supabase";
import { debugLog } from "../debug/DebugLog";

/** 24h cache TTL (the browser's own copy) — results stay fresh within a day. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Pollstar's JSON through our server, or an error when it can't get it. */
async function viaServer<T>(params: { search?: string; city?: string; page?: string; from?: string; to?: string }): Promise<T> {
  const data = await pollstarViaServer<T>(params);
  if (data === null) throw new Error("Pollstar is unavailable right now. Try again in a little while.");
  return data;
}

// --- Types ------------------------------------------------------------------

export interface PollstarVenue {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  location: string | null;
  /** Pollstar prominence rank (higher = more prominent). */
  rank: number;
}

export interface PollstarCity {
  id: string;
  /** "Berlin, Germany", "Los Angeles, CA". */
  name: string;
  /** "Berlin". */
  city: string | null;
  state: string | null;
  /** Pollstar prominence rank (higher = more prominent). */
  rank: number;
}

export interface PollstarEventArtist {
  name: string;
  isHeadline: boolean;
  genres: string[];
  artistType: string | null;
}

export interface PollstarEvent {
  id: string;
  name: string;
  /** ISO date (playDate). */
  playDate: string;
  url: string | null;
  isFestival: boolean;
  venueId: string;
  venueName: string;
  artists: PollstarEventArtist[];
}

// --- Raw response shapes (partial) ---

interface RawAutocomplete {
  response?: { docs?: RawAcDoc[] };
}
interface RawAcDoc {
  EntityId: string;
  ListName: string;
  EntityType: string;
  City?: string;
  State?: string;
  Location?: string;
  Rank?: number;
}
interface RawEventsResponse {
  totalPages?: number;
  totalEvents?: number;
  events?: RawEvent[];
}
interface RawEvent {
  id: number | string;
  name: string;
  playDate: string;
  url?: string | null;
  isFestival?: boolean;
  venue?: { id?: number | string; name?: string };
  artists?: Array<{ name: string; isHeadline?: boolean; genres?: string[]; artistType?: string | null }>;
}

// --- Parsing (pure, exported for tests) -------------------------------------

/** Parse the autocomplete response into venues only (drops artists/cities). */
export function parseVenues(raw: RawAutocomplete): PollstarVenue[] {
  const docs = raw.response?.docs ?? [];
  return docs
    .filter((d) => d.EntityType === "Venue")
    .map((d) => ({
      id: String(d.EntityId),
      name: d.ListName,
      city: d.City ?? null,
      state: d.State ?? null,
      location: d.Location ?? null,
      rank: d.Rank ?? 0,
    }));
}

/** Autocomplete names come HTML-escaped ("Mumford &amp; Sons"). */
function unescapeHtml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Parse the autocomplete response into cities only. */
export function parseCities(raw: RawAutocomplete): PollstarCity[] {
  return (raw.response?.docs ?? [])
    .filter((d) => d.EntityType === "City")
    .map((d) => ({
      id: String(d.EntityId),
      name: unescapeHtml(d.ListName),
      city: d.City ? unescapeHtml(d.City) : null,
      state: d.State || null,
      rank: d.Rank ?? 0,
    }));
}

/** Parse the events response into a flat list of events. Ticket links are left out on purpose. */
export function parseEvents(raw: RawEventsResponse): PollstarEvent[] {
  const events = raw.events ?? [];
  return events.map((e) => ({
    id: String(e.id),
    name: e.name,
    playDate: e.playDate,
    url: e.url ?? null,
    isFestival: Boolean(e.isFestival),
    venueId: e.venue?.id != null ? String(e.venue.id) : "",
    venueName: e.venue?.name ?? "",
    artists: (e.artists ?? []).map((a) => ({
      name: a.name,
      isHeadline: Boolean(a.isHeadline),
      genres: a.genres ?? [],
      artistType: a.artistType ?? null,
    })),
  }));
}

/** Format a Date as MM-DD-YYYY (Pollstar's expected format). */
export function formatPollstarDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}-${dd}-${yyyy}`;
}

// --- Public API -------------------------------------------------------------

/** Pollstar's autocomplete for a query (venues, cities, artists...), via our server. */
function autocomplete(query: string): Promise<RawAutocomplete> {
  return cachedFetch(
    `pollstar_ac_${query.toLowerCase()}`,
    async () => {
      debugLog.log(`Pollstar autocomplete: "${query}"`);
      return viaServer<RawAutocomplete>({ search: query });
    },
    CACHE_TTL_MS
  );
}

/** Pollstar cities matching a name ("Berlin": Berlin, Germany; Berlin, MD; ...), most prominent first. */
export async function searchCities(query: string): Promise<PollstarCity[]> {
  return parseCities(await autocomplete(query.trim())).sort((a, b) => b.rank - a.rank);
}

/**
 * One page (100, the function's page size) of a city's concerts between two
 * dates (YYYY-MM-DD, from today on), soonest first, via our pollstar-city function.
 */
export async function getCityEvents(
  cityId: string,
  page: number,
  range: { from: string; to: string }
): Promise<{ events: PollstarEvent[]; totalPages: number; totalEvents: number }> {
  return cachedFetch(
    `pollstar_city_${cityId}_${range.from}_${range.to}_${page}`,
    async () => {
      debugLog.log(`Pollstar city events: city ${cityId} ${range.from}..${range.to} page ${page}`);
      const raw = await viaServer<RawEventsResponse>({ city: cityId, page: String(page), from: range.from, to: range.to });
      const events = parseEvents(raw);
      debugLog.log(`Pollstar: ${events.length} events (page ${page}) for city ${cityId}`);
      return { events, totalPages: raw.totalPages ?? 1, totalEvents: raw.totalEvents ?? events.length };
    },
    CACHE_TTL_MS
  );
}
