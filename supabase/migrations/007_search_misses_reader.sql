-- Migration 007: a read-only login for banded-data's `misses` step
--
-- banded-data (github.com/rahuljaisimha/banded-data, concertdb/misses.py)
-- reads new rows of search_misses every night and crawls those artists' concerts,
-- so they join the graph at the next rebuild. It connects as this role, which can
-- read search_misses and nothing else (no other table, no writes).
--
-- The role is created without a login. Give it one outside git (the password is
-- a secret), in the SQL editor:
--   ALTER ROLE concertdb_misses LOGIN PASSWORD '<a long random password>';
-- and set in banded-data's .env (Supavisor pooler: user is <role>.<project ref>):
--   BANDED_MISSES_DB_URL=postgresql://concertdb_misses.<project ref>:<password>@<pooler host>:5432/postgres?sslmode=require

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'concertdb_misses') THEN
    CREATE ROLE concertdb_misses NOLOGIN;
  END IF;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM concertdb_misses;
GRANT USAGE ON SCHEMA public TO concertdb_misses;
GRANT SELECT ON public.search_misses TO concertdb_misses;
