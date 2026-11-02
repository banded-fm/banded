-- Banded Schema
-- Migration 001: Initial schema
--
-- Entity tables for typed data, one relationships table for all edges.
-- Sources: MusicBrainz (artists, albums, relationships), Setlist.fm (venues, played_at)

-- ============================================================
-- ENTITIES
-- ============================================================

CREATE TABLE IF NOT EXISTS artists (
    mbid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('person', 'group')),
    disambiguation TEXT,
    country TEXT
);

CREATE TABLE IF NOT EXISTS albums (
    mbid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    primary_artist_mbid TEXT,
    release_year INTEGER,
    type TEXT CHECK (type IN ('album', 'single', 'ep', 'compilation'))
);

CREATE TABLE IF NOT EXISTS venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    city TEXT,
    state TEXT,
    country TEXT
);

-- ============================================================
-- RELATIONSHIPS
-- ============================================================

-- All edges in one table. source_id and target_id reference entities
-- across any of the above tables (no FK constraint for flexibility).
--
-- count: frequency/weight of the relationship. Defaults to 1.
--   - played_at: number of times artist played at venue
--   - instrument/vocal/producer: number of tracks credited on the album
--   - toured_with: number of co-occurring shows
--   - member_of: always 1

CREATE TABLE IF NOT EXISTS relationships (
    id SERIAL PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    rel_type TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1
);

-- rel_type values:
--   Artist → Artist:  member_of, former_member_of, support_musician, toured_with
--   Artist → Album:   producer, vocal, instrument, mix, engineer, recording
--   Artist → Venue:   played_at

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name);
CREATE INDEX IF NOT EXISTS idx_artists_type ON artists(type);

CREATE INDEX IF NOT EXISTS idx_albums_name ON albums(name);
CREATE INDEX IF NOT EXISTS idx_albums_primary_artist ON albums(primary_artist_mbid);

CREATE INDEX IF NOT EXISTS idx_venues_city ON venues(city);
CREATE INDEX IF NOT EXISTS idx_venues_country ON venues(country);

CREATE INDEX IF NOT EXISTS idx_rels_source ON relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_rels_target ON relationships(target_id);
CREATE INDEX IF NOT EXISTS idx_rels_type ON relationships(rel_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rels_unique ON relationships(source_id, target_id, rel_type);

-- ============================================================
-- EXAMPLE QUERIES
-- ============================================================

-- Members of Arctic Monkeys:
-- SELECT a.name, r.rel_type
-- FROM relationships r
-- JOIN artists a ON a.mbid = r.source_id
-- WHERE r.target_id = '<arctic_monkeys_mbid>'
--   AND r.rel_type IN ('member_of', 'former_member_of');

-- Venues in LA where my favorite artists play (ranked by frequency):
-- SELECT v.name, SUM(r.count) as total_shows
-- FROM relationships r
-- JOIN venues v ON v.id = r.target_id
-- WHERE r.source_id IN ('<artist1>', '<artist2>', '<artist3>')
--   AND r.rel_type = 'played_at'
--   AND v.city = 'Los Angeles'
-- GROUP BY v.name
-- ORDER BY total_shows DESC;

-- Artists who toured together:
-- SELECT a.name, r.count as shared_shows
-- FROM relationships r
-- JOIN artists a ON a.mbid = r.target_id
-- WHERE r.source_id = '<artist_mbid>'
--   AND r.rel_type = 'toured_with'
-- ORDER BY r.count DESC;

-- Top collaborators on an album (by number of track credits):
-- SELECT a.name, r.rel_type, r.count as tracks
-- FROM relationships r
-- JOIN artists a ON a.mbid = r.source_id
-- WHERE r.target_id = '<album_mbid>'
-- ORDER BY r.count DESC;
