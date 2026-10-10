import { createMediaService } from '../../service/media.js';
import { createGalleryService } from '../../service/gallery.js';
import { createGalleryStore } from '../../service/storage/gallery.js';
import * as cursors from '../../public/gallery-utils.js';
import { nativeFiles, nativeImages, localPath } from './files.js';
import { PocketNative } from './providers.js';

export function openMedia(database, resourceStatus) {
  const { db, serial, transaction } = database;
  const registered = new Map();
  const roots = { original: 'originals', thumbnail: 'thumbnails', preview: 'previews' };
  const locate = (tier, name) => localPath(roots[tier], name);
  const read = (sql, id) => serial(() => db.prepare(sql).get(id));
  const media = createMediaService({ files: { ...nativeFiles, locate, previewName: row => `${row.original_name.split('/').slice(0, -1).join('/')}/${row.id}.webp`.replace(/^\//, '') }, images: nativeImages,
    store: {
      getThumbnail: id => read('SELECT thumb_name FROM images WHERE id=?', id),
      getOriginal: id => read('SELECT original_name,mime,created_at FROM images WHERE id=?', id),
      getPreview: id => read('SELECT id,original_name,preview_name,preview_bytes,mime FROM images WHERE id=?', id),
      updatePreview: (id, name, bytes) => serial(async () => (await db.prepare('UPDATE images SET preview_name=?,preview_bytes=? WHERE id=?').run(name, bytes, id)).changes)
    }
  });
  async function registerRows(rows, remove = false) {
    const entries = rows.flatMap(row => ['original', 'thumbnail', 'preview'].map(tier => ({
      route: `/api/images/${row.id}/${tier}`, remove,
      path: locate(tier === 'preview' && !row.preview_name ? 'original' : tier, tier === 'original' ? row.original_name : tier === 'thumbnail' ? row.thumb_name : row.preview_name || row.original_name),
      mime: tier === 'original' || (tier === 'preview' && !row.preview_name) ? row.mime : 'image/webp'
    })));
    const changed = entries.filter(entry => remove || registered.get(entry.route) !== `${entry.path}|${entry.mime}`);
    for (let i = 0; i < changed.length; i += 1000) {
      const batch = changed.slice(i, i + 1000); await PocketNative.registerMedia({ entries: batch });
      for (const entry of batch) { if (remove) registered.delete(entry.route); else registered.set(entry.route, `${entry.path}|${entry.mime}`); }
    }
  }
  async function registerAsset(row) {
    if (row) await PocketNative.registerMedia({ entries: [{ route: `/api/assets/${row.id}/original`, path: localPath('input-assets', row.stored_name), mime: row.mime }] });
  }
  const gallery = createGalleryService({ store: database.store(createGalleryStore(db)), cursors, effects: { resourceStatus,
    async deleteGalleryRows(rows) {
      for (const row of rows) {
        await nativeFiles.remove(locate('original', row.original_name)); await nativeFiles.remove(locate('thumbnail', row.thumb_name));
        if (row.preview_name) await nativeFiles.remove(locate('preview', row.preview_name));
      }
      await serial(() => transaction(function* () {
        for (const row of rows) { yield db.prepare('DELETE FROM images WHERE id=?').run(row.id); yield db.prepare('UPDATE jobs SET image_id=NULL WHERE id=?').run(row.job_id); }
      }));
      await registerRows(rows, true); return {};
    }
  } });
  async function registerAll() {
    await registerRows(await serial(() => db.prepare('SELECT * FROM images').all()));
    const assets = await serial(() => db.prepare('SELECT * FROM input_assets').all());
    for (const row of assets) await registerAsset(row);
  }
  async function registerIds(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length) await registerRows(await serial(() => db.prepare(`SELECT * FROM images WHERE id IN (${unique.map(() => '?').join(',')})`).all(...unique)));
  }
  return { media, gallery, registerRows, registerIds, registerAsset, registerAll };
}
