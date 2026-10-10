import { flow } from '../port-flow.js';
// The row ports retain SQLite column names so a native SQLite adapter can use
// the same storage contract. Atomic commands keep SQL and transactions here.
export function createSchemesStore(db, transaction) {
  return {
    listSchemes: flow(function* () {
      return (yield db.prepare(`
        SELECT s.*, CASE WHEN i.id IS NULL THEN 0 ELSE 1 END AS cover_exists
        FROM schemes s
        LEFT JOIN images i ON i.id=s.cover_image_id
        ORDER BY s.is_default DESC, s.updated_at DESC
      `).all());
    }),

    getScheme: flow(function* (id) {
      return (yield db.prepare('SELECT * FROM schemes WHERE id=?').get(id));
    }),

    createScheme: flow(function* ({ name, data, requestedCover, makeDefault }, { now, nextId }) {
      if ((yield db.prepare('SELECT id FROM schemes WHERE name=?').get(name))) return null;
      requestedCover = String(requestedCover || '').trim();
      const coverImageId = requestedCover && (yield db.prepare('SELECT id FROM images WHERE id=?').get(requestedCover)) ? requestedCover : null;
      const timestamp = now();
      const id = nextId();
      (yield transaction(function* () {
        if (makeDefault) (yield db.prepare('UPDATE schemes SET is_default=0').run());
        (yield db.prepare(`
          INSERT INTO schemes(id,name,data_json,is_default,cover_image_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
        `).run(id, name, JSON.stringify(data), makeDefault ? 1 : 0, coverImageId, timestamp, timestamp));
      }));
      return { id, name, isDefault: makeDefault, coverImageId };
    }),

    updateScheme: flow(function* ({ id, name, data, row, replaceCover, requestedCover, makeDefault }, { now }) {
      let coverImageId = row.cover_image_id || null;
      if (replaceCover) {
        coverImageId = requestedCover && (yield db.prepare('SELECT id FROM images WHERE id=?').get(requestedCover)) ? requestedCover : null;
      }
      (yield transaction(function* () {
        if (makeDefault) (yield db.prepare('UPDATE schemes SET is_default=0').run());
        (yield db.prepare('UPDATE schemes SET name=?,data_json=?,is_default=?,cover_image_id=?,updated_at=? WHERE id=?')
          .run(name, JSON.stringify(data), makeDefault ? 1 : row.is_default, coverImageId, now(), id));
      }));
    }),

    deleteScheme: flow(function* (id) {
      return Number((yield db.prepare('DELETE FROM schemes WHERE id=?').run(id)).changes);
    }),

    listSnippets: flow(function* () {
      return (yield db.prepare('SELECT * FROM snippets ORDER BY category, updated_at DESC').all());
    }),

    saveSnippet: flow(function* ({ name, category, tags }, { now, nextId }) {
      const timestamp = now();
      const existing = (yield db.prepare('SELECT id FROM snippets WHERE name=?').get(name));
      const id = existing?.id || nextId();
      (yield db.prepare(`
        INSERT INTO snippets(id,name,category,tags_json,created_at,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,category=excluded.category,tags_json=excluded.tags_json,updated_at=excluded.updated_at
      `).run(id, name, category, JSON.stringify(tags), timestamp, timestamp));
      return { created: !existing, data: { id, name } };
    }),

    deleteSnippet: flow(function* (id) {
      return Number((yield db.prepare('DELETE FROM snippets WHERE id=?').run(id)).changes);
    }),

    exportBackup: flow(function* ({ includeArtistPreferences = false } = {}) {
      const schemes = (yield db.prepare('SELECT name,data_json,is_default,created_at,updated_at FROM schemes ORDER BY updated_at DESC').all());
      const snippets = (yield db.prepare('SELECT name,category,tags_json,created_at,updated_at FROM snippets ORDER BY updated_at DESC').all());
      const artistPreferences = includeArtistPreferences ? (yield db.prepare('SELECT artist,favorite,note FROM artist_preferences ORDER BY artist').all()) : undefined;
      return { schemes, snippets, ...(includeArtistPreferences ? { artistPreferences } : {}) };
    }),

    importBackup: flow(function* ({ schemes, snippets, now, artistPreferences }, { nextId }) {
      (yield transaction(function* () {
        for (const item of schemes) {
          const id = (yield db.prepare('SELECT id FROM schemes WHERE name=?').get(item.name))?.id || nextId();
          (yield db.prepare(`
            INSERT INTO schemes(id,name,data_json,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at
          `).run(id, item.name, JSON.stringify(item.data), 0, now, now));
        }
        for (const item of snippets) {
          const id = (yield db.prepare('SELECT id FROM snippets WHERE name=?').get(item.name))?.id || nextId();
          (yield db.prepare(`
            INSERT INTO snippets(id,name,category,tags_json,created_at,updated_at) VALUES (?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET category=excluded.category,tags_json=excluded.tags_json,updated_at=excluded.updated_at
          `).run(id, item.name, item.category, JSON.stringify(item.tags), now, now));
        }
        for (const item of artistPreferences || []) {
          (yield db.prepare(`INSERT INTO artist_preferences(artist,favorite,note,updated_at) VALUES (?,?,?,?)
            ON CONFLICT(artist) DO UPDATE SET favorite=excluded.favorite,note=excluded.note,updated_at=excluded.updated_at`)
            .run(item.artist, item.favorite ? 1 : 0, item.note, now));
        }
      }));
    })
  };
}
