-- MusicBrainz's special purpose artists ([unknown], [anonymous], [traditional]...)
-- are placeholders, not artists. They are credited on thousands of records, so
-- they linked artists who have nothing in common (Mick Jagger -> [unknown] ->
-- Jack White). scripts/process_mb_dump.py leaves them out from now on
-- (SPECIAL_PURPOSE_ARTISTS); this removes the ones already seeded, with every
-- relationship to or from them. Safe to run more than once.
WITH special(mbid) AS (VALUES
    ('89ad4ac3-39f7-470e-963a-56509c546377'),  -- Various Artists
    ('f731ccc4-e22a-43af-a747-64213329e088'),  -- [anonymous]
    ('33cf029c-63b0-41a0-9855-be2a3665fb3b'),  -- [data]
    ('314e1c25-dde7-4e4d-b2f4-0a7b9f7c56dc'),  -- [dialogue]
    ('eec63d3c-3b81-4ad4-b1e4-7c147d4d2b61'),  -- [no artist]
    ('9be7f096-97ec-4615-8957-8d40b5dcbc41'),  -- [traditional]
    ('125ec42a-7229-4250-afc5-e057484327fe'),  -- [unknown]
    ('66ea0139-149f-4a0c-8fbf-5ea9ec4a6e49'),  -- [Disney]
    ('a0ef7e1d-44ff-4039-9435-7d5fefdeecc9'),  -- [theatre]
    ('90068d37-bae7-4292-be4a-704c145bd616'),  -- [church chimes]
    ('80a8851f-444c-4539-892b-ad2a49292aa9'),  -- [language instruction]
    ('459a4aa6-b6b7-4c89-a42b-03acddbe1f80'),  -- [unknown animal]
    ('7e84f845-ac16-41fe-9ff8-df12eb32af55')   -- MusicBrainz Test Artist
), gone AS (
    DELETE FROM relationships WHERE source_id IN (SELECT mbid FROM special) OR target_id IN (SELECT mbid FROM special)
)
DELETE FROM artists WHERE mbid IN (SELECT mbid FROM special);
