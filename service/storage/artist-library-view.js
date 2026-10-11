import { flow } from '../port-flow.js';

// Read-only queries for the artist-library view over installed resource packs. Writes stay
// in the resource installer (packs) and the preference store (favourite/note).
// Bulk reads are keyset pages: on the phone every result crosses the native bridge, and one
// query returning all ~29k annotations (≈43 MB with descriptions) crashed the WebView.

export function createArtistLibraryViewStore(db) {
  return {
    // Cheap change marker: a new pack version or a preference edit invalidates the cached catalog.
    revision: flow(function* () {
      const sets = yield db.prepare("SELECT COALESCE(group_concat(id||':'||version,','),'') AS value FROM (SELECT id,version FROM artist_resource_sets ORDER BY id)").get();
      const prefs = yield db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(updated_at),0) AS updated FROM artist_preferences').get();
      const facts = yield db.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='artist_danbooru_stats') THEN 1 ELSE 0 END AS present").get();
      const stamp = facts?.present ? yield db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(synced_at),0) AS synced FROM artist_danbooru_stats').get() : null;
      return `${sets?.value || ''}|${prefs?.count || 0}:${prefs?.updated || 0}|${stamp?.count || 0}:${stamp?.synced || 0}`;
    }),
    profiles: flow(function* () {
      return yield db.prepare(`SELECT p.artist,p.display_name,p.aliases_json,p.set_id,COALESCE(s.directory,p.set_id) AS storage_id
        FROM artist_resource_profiles p LEFT JOIN artist_resource_storage s ON s.set_id=p.set_id`).all();
    }),
    preferences: flow(function* () { return yield db.prepare('SELECT artist,favorite,note,updated_at FROM artist_preferences').all(); }),
    examplesPage: flow(function* (after, limit) {
      return yield db.prepare('SELECT id,artist,position FROM artist_resource_examples WHERE id>? ORDER BY id LIMIT ?').all(after, limit);
    }),
    // Attributes only: legacy facets are read only where no typed attributes exist, and the
    // description text is fetched separately, on demand (text search).
    observationsPage: flow(function* (after, limit) {
      return yield db.prepare(`SELECT o.id,o.example_id,e.artist,o.model,
        CASE WHEN o.attributes_json IN ('','{}') THEN o.facets_json ELSE '{}' END AS facets_json,
        o.attributes_json,o.schema_version,o.source,o.reviewed,o.updated_at
        FROM artist_resource_observations o JOIN artist_resource_examples e ON e.id=o.example_id
        WHERE o.id>? ORDER BY o.id LIMIT ?`).all(after, limit);
    }),
    // Danbooru facts (app-only table; absent on hosts that keep them elsewhere).
    danbooruPage: flow(function* (after, limit) {
      const present = yield db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='artist_danbooru_stats'").get();
      if (!present) return [];
      return yield db.prepare('SELECT artist,post_count,created_at,updated_at,homepages_json,synced_at FROM artist_danbooru_stats WHERE artist>? ORDER BY artist LIMIT ?').all(after, limit);
    }),
    notesPage: flow(function* (after, limit) {
      return yield db.prepare("SELECT id,note FROM artist_resource_observations WHERE id>? AND note<>'' ORDER BY id LIMIT ?").all(after, limit);
    }),
    artist: flow(function* (artist) {
      const profile = yield db.prepare(`SELECT p.*,COALESCE(d.directory,p.set_id) AS storage_id FROM artist_resource_profiles p
        LEFT JOIN artist_resource_storage d ON d.set_id=p.set_id WHERE p.artist=?`).get(artist);
      const examples = profile ? yield db.prepare('SELECT * FROM artist_resource_examples WHERE artist=? ORDER BY position,id').all(artist) : [];
      const observations = profile ? yield db.prepare(`SELECT o.* FROM artist_resource_observations o
        JOIN artist_resource_examples e ON e.id=o.example_id WHERE e.artist=? ORDER BY e.position,o.id`).all(artist) : [];
      const preference = yield db.prepare('SELECT artist,favorite,note,updated_at FROM artist_preferences WHERE artist=?').get(artist);
      return { profile: profile || null, examples, observations, preference: preference || null };
    })
  };
}
