import { flow } from '../port-flow.js';
export function createAssetsStore(db) {
  return {
    byHash: flow(function* (sha) { return (yield db.prepare('SELECT * FROM input_assets WHERE sha256=? ORDER BY created_at DESC LIMIT 1').get(sha)); }),

    get: flow(function* (id) { return (yield db.prepare('SELECT * FROM input_assets WHERE id=?').get(id)); }),

    gallery: flow(function* (id) { return (yield db.prepare('SELECT original_name,mime,created_at FROM images WHERE id=?').get(id)); }),

    recent: flow(function* (limit) { return (yield db.prepare('SELECT * FROM input_assets ORDER BY created_at DESC LIMIT ?').all(limit)); }),

    insert: flow(function* (row) {
      (yield db.prepare(`INSERT INTO input_assets(id,stored_name,original_name,mime,width,height,bytes,sha256,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(row.id, row.stored_name, row.original_name, row.mime, row.width, row.height, row.bytes, row.sha256, row.created_at));
    })
  };
}
