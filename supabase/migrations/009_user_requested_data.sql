-- Migration 009: keep the user-requested data the app fetches, for banded-data
--
-- The app fetches concert data from outside sources because a user asked for
-- something: venue-search calls setlist.fm (an artist's setlists in a city,
-- then each venue's setlists); Discover's Concerts fetches Pollstar venues'
-- upcoming events in the browser and hands them to the user-requested-data
-- function. Both are kept here, one row per (source, key), so banded-data
-- (github.com/rahuljaisimha/banded-data, concertdb/user_requested.py) can
-- store them like its own crawls without spending its own requests. Nothing
-- kept is about the user.
--
--   source     key              data
--   setlistfm  setlist id       the setlist as setlist.fm returned it
--   pollstar   Pollstar venue   { venue, events } (cut down: _shared/userRequestedData.ts)
--
-- version changes when the data does (setlist.fm's lastUpdated; a hash of what's
-- kept), and seq moves forward only then, so the reader asks for "seq past the
-- last one I handled" and re-fetching unchanged data doesn't resend it.

CREATE TABLE IF NOT EXISTS public.user_requested_data (
    source     TEXT NOT NULL,
    key        TEXT NOT NULL,
    data       JSONB NOT NULL,
    version    TEXT,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    seq        BIGSERIAL NOT NULL,
    PRIMARY KEY (source, key)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_requested_data_seq ON public.user_requested_data (seq);

CREATE OR REPLACE FUNCTION public.user_requested_data_bump_seq() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW.version IS DISTINCT FROM OLD.version THEN
        NEW.seq := nextval(pg_get_serial_sequence('public.user_requested_data', 'seq'));
    ELSE
        NEW.seq := OLD.seq;
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS user_requested_data_bump_seq ON public.user_requested_data;
CREATE TRIGGER user_requested_data_bump_seq BEFORE UPDATE ON public.user_requested_data
    FOR EACH ROW EXECUTE FUNCTION public.user_requested_data_bump_seq();

-- Same as every table (migration 008): RLS on, no policy for anon/authenticated.
ALTER TABLE public.user_requested_data ENABLE ROW LEVEL SECURITY;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.user_requested_data FROM anon, authenticated;

-- banded-data's read-only login (migration 007) reads it too.
GRANT SELECT ON public.user_requested_data TO concertdb_misses;
DROP POLICY IF EXISTS concertdb_misses_read ON public.user_requested_data;
CREATE POLICY concertdb_misses_read ON public.user_requested_data
    FOR SELECT TO concertdb_misses USING (true);
