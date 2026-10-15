import { flow } from '../port-flow.js';
import { buildGalleryFilter } from '../../public/gallery-utils.js';

const SUMMARY_COLUMNS = 'id,batch_id,mime,width,height,bytes,thumb_bytes,preview_bytes,prompt,negative_prompt,seed,favorite,note,created_at';
const ROTATION_ARTIST_COLUMN = `(SELECT CASE WHEN json_valid(j.request_json) THEN json_extract(j.request_json, '$.experiment.artist') END FROM jobs j WHERE j.id = images.job_id) AS rotation_artist`;

export function createGalleryStore(db) {
  // null = not yet known, false = this database has no image_search (fall back to images).
  let searchTable = null;
  return {
    countGalleryImages: flow(function* (filters) {
      const filter = buildGalleryFilter(filters, { includeCursor: false });
      // A text search counts in the narrow image_search copy (same columns); see image-search.js.
      if (filter.query && searchTable !== false) {
        try {
          const count = Number((yield db.prepare(`SELECT COUNT(*) AS count FROM image_search ${filter.where}`).get(...filter.values)).count);
          searchTable = true;
          return count;
        } catch (error) { if (!/no such table/i.test(String(error?.message))) throw error; searchTable = false; }
      }
      return Number((yield db.prepare(`SELECT COUNT(*) AS count FROM images ${filter.where}`).get(...filter.values)).count);
    }),

    listGalleryImages: flow(function* ({ filters, cursor, includeCursor, limit, offset, rotation }) {
      const filter = buildGalleryFilter({ ...filters, cursor }, { includeCursor });
      const columns = rotation ? `${SUMMARY_COLUMNS},${ROTATION_ARTIST_COLUMN}` : SUMMARY_COLUMNS;
      if (filter.query && searchTable !== false) {
        try {
          const page = `SELECT id FROM image_search ${filter.where} ORDER BY created_at DESC,id DESC LIMIT ?${offset ? ' OFFSET ?' : ''}`;
          const rows = (yield db.prepare(`SELECT ${columns} FROM images WHERE id IN (${page}) ORDER BY created_at DESC,id DESC`).all(...filter.values, limit, ...(offset ? [offset] : [])));
          searchTable = true;
          return rows;
        } catch (error) { if (!/no such table/i.test(String(error?.message))) throw error; searchTable = false; }
      }
      const query = `SELECT ${columns} FROM images ${filter.where} ORDER BY created_at DESC,id DESC LIMIT ?`;
      return offset
        ? (yield db.prepare(`${query} OFFSET ?`).all(...filter.values, limit, offset))
        : (yield db.prepare(query).all(...filter.values, limit));
    }),

    getGalleryImage: flow(function* (id) {
      return (yield db.prepare('SELECT * FROM images WHERE id=?').get(id));
    }),

    getGalleryImagesByIds: flow(function* (ids) {
      return (yield db.prepare(`SELECT * FROM images WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids));
    }),

    getLatestGalleryImage: flow(function* () {
      return (yield db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM images ORDER BY created_at DESC,id DESC LIMIT 1`).get());
    }),

    countAllGalleryImages: flow(function* () {
      return Number((yield db.prepare('SELECT COUNT(*) AS count FROM images').get()).count);
    }),

    setGalleryFavorite: flow(function* (id, favorite) {
      return Number((yield db.prepare('UPDATE images SET favorite=? WHERE id=?').run(favorite, id)).changes);
    }),

    setGalleryNote: flow(function* (id, note) {
      return Number((yield db.prepare('UPDATE images SET note=? WHERE id=?').run(note, id)).changes);
    })
  };
}
