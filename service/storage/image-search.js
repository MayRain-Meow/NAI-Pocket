// Narrow copy of the searchable image fields, kept in sync by triggers.
// Gallery text search used to scan `images` itself: 12,004 rows carrying 450 M characters of
// params_json (118k pages) just to read `prompt` and `note` — 0.2–0.3 s warm and ~6 s on a cold
// page cache (2026-10-14, live library). This table holds only what the gallery filter reads
// (same column names, so the shared filter applies unchanged) and is ~9 MB. Triggers keep it
// exact for every writer, including older releases after a rollback; the first open backfills it.

const COLUMNS = 'id,kind,favorite,created_at,seed,prompt,note';
const FROM_NEW = "new.id,new.kind,new.favorite,new.created_at,CAST(new.seed AS TEXT),new.prompt,new.note";

export const IMAGE_SEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS image_search (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'gallery',
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  seed TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_image_search_kind ON image_search(kind, created_at DESC, id DESC);
CREATE TRIGGER IF NOT EXISTS image_search_insert AFTER INSERT ON images BEGIN
  INSERT OR REPLACE INTO image_search(${COLUMNS}) VALUES (${FROM_NEW});
END;
CREATE TRIGGER IF NOT EXISTS image_search_update AFTER UPDATE OF kind,favorite,created_at,seed,prompt,note ON images BEGIN
  DELETE FROM image_search WHERE id=old.id;
  INSERT OR REPLACE INTO image_search(${COLUMNS}) VALUES (${FROM_NEW});
END;
CREATE TRIGGER IF NOT EXISTS image_search_delete AFTER DELETE ON images BEGIN
  DELETE FROM image_search WHERE id=old.id;
END;
INSERT INTO image_search(${COLUMNS})
  SELECT id,kind,favorite,created_at,CAST(seed AS TEXT),prompt,note FROM images WHERE NOT EXISTS (SELECT 1 FROM image_search);
`;

// Rebuild statement for a table that drifted (counts differ), e.g. rows written before the
// triggers existed in some unusual restore. Normal operation never needs it.
export const IMAGE_SEARCH_REBUILD = `
DELETE FROM image_search;
INSERT INTO image_search(${COLUMNS}) SELECT id,kind,favorite,created_at,CAST(seed AS TEXT),prompt,note FROM images;
`;
