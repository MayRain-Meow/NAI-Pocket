import { flow } from '../port-flow.js';
import { buildGalleryFilter } from '../../public/gallery-utils.js';

const SUMMARY_COLUMNS = 'id,batch_id,mime,width,height,bytes,thumb_bytes,preview_bytes,prompt,negative_prompt,seed,favorite,note,created_at';
const ROTATION_ARTIST_COLUMN = `(SELECT CASE WHEN json_valid(j.request_json) THEN json_extract(j.request_json, '$.experiment.artist') END FROM jobs j WHERE j.id = images.job_id) AS rotation_artist`;

// `transaction` (optional): runs a storage program atomically; the 回收站 moves use it when given.
export function createGalleryStore(db, transaction = null) {
  const atomic = function* (program) { if (transaction) return (yield transaction(program)); return (yield* program()); };
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
    }),

    // 回收站: move rows out of images (search index triggers follow), keep the files; the job keeps
    // its row but loses the picture link until the picture comes back.
    trashGalleryImages: flow(function* (ids, now) {
      const rows = (yield db.prepare(`SELECT * FROM images WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids));
      if (!rows.length) return [];
      yield* atomic(function* () {
        for (const row of rows) {
          const bytes = Number(row.bytes || 0) + Number(row.thumb_bytes || 0) + Number(row.preview_bytes || 0);
          (yield db.prepare('INSERT OR REPLACE INTO image_trash(id,row_json,thumb_name,bytes,created_at,deleted_at) VALUES (?,?,?,?,?,?)')
            .run(row.id, JSON.stringify(row), row.thumb_name || '', bytes, row.created_at, now));
          (yield db.prepare('DELETE FROM images WHERE id=?').run(row.id));
          (yield db.prepare('UPDATE jobs SET image_id=NULL WHERE id=? AND image_id=?').run(row.job_id, row.id));
        }
      });
      return rows;
    }),
    listTrash: flow(function* () {
      return (yield db.prepare('SELECT id,thumb_name,bytes,created_at,deleted_at FROM image_trash ORDER BY deleted_at DESC,id DESC LIMIT 500').all());
    }),
    countTrash: flow(function* () {
      return Number((yield db.prepare('SELECT COUNT(*) AS count FROM image_trash').get()).count);
    }),
    getTrashRow: flow(function* (id) {
      return (yield db.prepare('SELECT id,thumb_name FROM image_trash WHERE id=?').get(id));
    }),
    // Full image rows, for restoring or for the permanent delete. `olderThan` picks expired ones.
    trashRows: flow(function* ({ ids = null, olderThan = null } = {}) {
      const found = ids ? (yield db.prepare(`SELECT row_json FROM image_trash WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids))
        : olderThan !== null ? (yield db.prepare('SELECT row_json FROM image_trash WHERE deleted_at<? LIMIT 200').all(olderThan))
          : (yield db.prepare('SELECT row_json FROM image_trash LIMIT 200').all());
      return found.map(item => { try { return JSON.parse(item.row_json); } catch { return null; } }).filter(Boolean);
    }),
    // Put rows back exactly (same id and date, so the picture returns to its place) and relink the job.
    restoreTrash: flow(function* (rows) {
      const columns = (yield db.prepare('PRAGMA table_info(images)').all()).map(column => column.name);
      const restored = [];
      yield* atomic(function* () {
        for (const row of rows) {
          const names = columns.filter(name => Object.hasOwn(row, name));
          (yield db.prepare(`INSERT OR IGNORE INTO images(${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map(name => row[name])));
          (yield db.prepare('UPDATE jobs SET image_id=? WHERE id=? AND image_id IS NULL').run(row.id, row.job_id));
          (yield db.prepare('DELETE FROM image_trash WHERE id=?').run(row.id));
          restored.push(row.id);
        }
      });
      return restored;
    }),
    forgetTrash: flow(function* (ids) {
      if (!ids.length) return 0;
      return Number((yield db.prepare(`DELETE FROM image_trash WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)).changes);
    })
  };
}
