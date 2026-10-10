import { flow } from '../port-flow.js';

// Each partial update is one SQLite statement: simultaneous note/favorite edits
// cannot replace each other's fields across an asynchronous native bridge.
export function createArtistBrowserStore(db) {
  return {
    all: flow(function* () { return yield db.prepare('SELECT * FROM artist_preferences').all(); }),
    get: flow(function* (artist) { return yield db.prepare('SELECT * FROM artist_preferences WHERE artist=?').get(artist); }),
    save: flow(function* (value) {
      return yield db.prepare(`INSERT INTO artist_preferences(artist,favorite,note,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(artist) DO UPDATE SET
        favorite=CASE WHEN ? THEN excluded.favorite ELSE artist_preferences.favorite END,
        note=CASE WHEN ? THEN excluded.note ELSE artist_preferences.note END,
        updated_at=excluded.updated_at`).run(value.artist,value.favorite?1:0,value.note,value.updatedAt,value.hasFavorite?1:0,value.hasNote?1:0);
    })
  };
}
