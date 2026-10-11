import { flow } from '../port-flow.js';

// App-only table: Danbooru facts for artists (post count, dates, profile links). The server keeps
// these on artist_profiles; the app's prepared packs are replaceable, so the facts live apart and
// survive a pack update. Created by the app's SQLite setup, not by the shared server schema.
export const ARTIST_DANBOORU_STATS_SCHEMA = `CREATE TABLE IF NOT EXISTS artist_danbooru_stats (
      artist TEXT PRIMARY KEY,
      danbooru_id INTEGER,
      post_count INTEGER,
      created_at INTEGER,
      updated_at INTEGER,
      homepages_json TEXT NOT NULL DEFAULT '[]',
      synced_at INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT ''
    );
CREATE INDEX IF NOT EXISTS idx_artist_danbooru_stats_synced ON artist_danbooru_stats(synced_at, artist);`;

export function createArtistDanbooruStatsStore(db) {
  // The Danbooru artist id comes from the prepared examples (their metadata records it).
  const artistIdSql = `SELECT e.artist, MAX(CAST(json_extract(e.metadata_json,'$.artistId') AS INTEGER)) AS danbooru_id
    FROM artist_resource_examples e WHERE json_extract(e.metadata_json,'$.artistId') IS NOT NULL`;
  return {
    get: flow(function* (artist) { return yield db.prepare('SELECT * FROM artist_danbooru_stats WHERE artist=?').get(artist); }),
    page: flow(function* (after, limit) {
      return yield db.prepare('SELECT artist,post_count,created_at,updated_at,homepages_json,synced_at FROM artist_danbooru_stats WHERE artist>? ORDER BY artist LIMIT ?').all(after, limit);
    }),
    artistId: flow(function* (artist) {
      const row = yield db.prepare(`${artistIdSql} AND e.artist=? GROUP BY e.artist`).get(artist);
      return Number(row?.danbooru_id) || null;
    }),
    // Least recently synced artists that have a known Danbooru id, never-synced first.
    pending: flow(function* (limit) {
      return yield db.prepare(`SELECT ids.artist, ids.danbooru_id FROM (${artistIdSql} GROUP BY e.artist) ids
        LEFT JOIN artist_danbooru_stats s ON s.artist=ids.artist ORDER BY COALESCE(s.synced_at,0), ids.artist LIMIT ?`).all(limit);
    }),
    remaining: flow(function* () {
      const row = yield db.prepare(`SELECT COUNT(*) AS n FROM (${artistIdSql} GROUP BY e.artist) ids
        LEFT JOIN artist_danbooru_stats s ON s.artist=ids.artist WHERE COALESCE(s.synced_at,0)=0`).get();
      return Number(row?.n) || 0;
    }),
    save: flow(function* (row) {
      return yield db.prepare(`INSERT INTO artist_danbooru_stats(artist,danbooru_id,post_count,created_at,updated_at,homepages_json,synced_at,status)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(artist) DO UPDATE SET danbooru_id=excluded.danbooru_id,post_count=excluded.post_count,
        created_at=excluded.created_at,updated_at=excluded.updated_at,homepages_json=excluded.homepages_json,synced_at=excluded.synced_at,status=excluded.status`)
        .run(row.artist, row.danbooruId, row.postCount, row.createdAt, row.updatedAt, JSON.stringify(row.homepages || []), row.syncedAt, row.status || '');
    })
  };
}
