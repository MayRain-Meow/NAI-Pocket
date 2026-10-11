import { flow } from '../port-flow.js';

// Read-only queries for the artist-library view over installed resource packs. Writes stay
// in the resource installer (packs) and the preference store (favourite/note).
export function createArtistLibraryViewStore(db) {
  return {
    // Cheap change marker: a new pack version or a preference edit invalidates the cached catalog.
    revision: flow(function* () {
      const sets = yield db.prepare("SELECT COALESCE(group_concat(id||':'||version,','),'') AS value FROM (SELECT id,version FROM artist_resource_sets ORDER BY id)").get();
      const prefs = yield db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(updated_at),0) AS updated FROM artist_preferences').get();
      return `${sets?.value || ''}|${prefs?.count || 0}:${prefs?.updated || 0}`;
    }),
    // Everything the list needs, without wide metadata or provenance columns.
    snapshot: flow(function* () {
      const profiles = yield db.prepare(`SELECT p.artist,p.display_name,p.aliases_json,p.set_id,COALESCE(s.directory,p.set_id) AS storage_id
        FROM artist_resource_profiles p LEFT JOIN artist_resource_storage s ON s.set_id=p.set_id`).all();
      const examples = yield db.prepare('SELECT id,artist,position FROM artist_resource_examples ORDER BY artist,position,id').all();
      const observations = yield db.prepare(`SELECT o.id,o.example_id,e.artist,o.model,o.facets_json,o.attributes_json,o.note,o.schema_version,o.source,o.reviewed,o.updated_at
        FROM artist_resource_observations o JOIN artist_resource_examples e ON e.id=o.example_id ORDER BY e.artist,e.position,o.id`).all();
      const preferences = yield db.prepare('SELECT artist,favorite,note,updated_at FROM artist_preferences').all();
      return { profiles, examples, observations, preferences };
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
