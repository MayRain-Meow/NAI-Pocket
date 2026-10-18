
export class GalleryServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GalleryServiceError';
    this.status = status;
  }
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export const TRASH_KEEP_MS = 24 * 60 * 60 * 1000;

export function createGalleryService({ store, cursors, effects = {}, clock = { now: () => Date.now() } }) {
  if (!store || !cursors) throw new TypeError('gallery store and cursor helpers are required');
  const trashSupported = typeof store.trashGalleryImages === 'function';
  // The permanent delete (files, thumbnails, derived artist examples), then the rows leave the bin.
  async function purgeRows(rows) {
    if (!rows.length) return { purged: 0, deletedExamples: 0 };
    const extra = effects.deleteGalleryRows ? await effects.deleteGalleryRows(rows) : {};
    await store.forgetTrash(rows.map(row => String(row.id)));
    return { purged: rows.length, deletedExamples: Number(extra.deletedExamples) || 0, affectedArtists: extra.affectedArtists || [] };
  }

  async function deleteResult(requestedIds, rows, extra = {}) {
    const deletedIds = rows.map(row => String(row.id));
    const deletedSet = new Set(deletedIds);
    const deletedBytes = rows.reduce((total, row) => total + Number(row.bytes || 0) + Number(row.thumb_bytes || 0) + Number(row.preview_bytes || 0), 0);
    const resources = effects.resourceStatus ? await effects.resourceStatus() : null;
    const latest = await store.getLatestGalleryImage();
    return {
      ok: true,
      deleted: deletedIds.length,
      deletedIds,
      missingIds: requestedIds.filter(id => !deletedSet.has(id)),
      deletedBytes,
      deletedExamples: Number(extra.deletedExamples) || 0,
      affectedArtists: extra.affectedArtists || [],
      galleryTotal: await store.countAllGalleryImages(),
      latestImage: cursors.galleryImageSummary(latest),
      resources
    };
  }

  return {
    async list(searchParams) {
      const page = clampInt(searchParams.get('page'), 1, 1, 1_000_000);
      const limit = clampInt(searchParams.get('limit'), 30, 1, 60);
      const pickerMode = searchParams.get('picker') === '1';
      const favorite = searchParams.get('favorite') === '1';
      const query = String(searchParams.get('q') || '').trim().slice(0, 120);
      const since = Number(searchParams.get('since') || 0);
      const until = Number(searchParams.get('until') || 0);
      const kind = cursors.normalizeGalleryKind(searchParams.get('kind'));
      const cursorMode = searchParams.has('cursor');
      const rawCursor = String(searchParams.get('cursor') || '');
      const cursor = cursors.decodeGalleryCursor(rawCursor);
      if (rawCursor && !cursor) throw new GalleryServiceError(400, '图库游标无效，请重新载入图库。');
      const rawSnapshot = String(searchParams.get('snapshot') || '');
      const snapshot = cursors.decodeGalleryCursor(rawSnapshot);
      if (rawSnapshot && !snapshot) throw new GalleryServiceError(400, '图库快照无效，请重新载入图库。');

      const filters = { favorite, query, since, until, snapshot, kind };
      // The workflow image picker skips the full-gallery count because it only
      // needs a short recent window.
      const total = pickerMode ? null : await store.countGalleryImages(filters);
      const fallbackOffset = (page - 1) * limit;
      const offset = !pickerMode && !cursorMode
        ? clampInt(searchParams.get('offset'), fallbackOffset, 0, 10_000_000)
        : 0;
      const boundedPage = pickerMode || cursorMode;
      let rows = await store.listGalleryImages({
        filters,
        cursor: cursorMode && !pickerMode ? cursor : null,
        includeCursor: cursorMode && !pickerMode,
        limit: limit + (boundedPage ? 1 : 0),
        offset,
        rotation: kind === 'rotation'
      });

      let hasMore;
      let nextCursor = '';
      if (boundedPage) {
        hasMore = rows.length > limit;
        if (hasMore) rows = rows.slice(0, limit);
        if (rows.length && (pickerMode || hasMore)) nextCursor = cursors.encodeGalleryCursor(rows.at(-1));
      } else {
        hasMore = offset + rows.length < total;
        if (hasMore && rows.length) nextCursor = cursors.encodeGalleryCursor(rows.at(-1));
      }
      const snapshotCursor = rawSnapshot || (rows.length ? cursors.encodeGalleryCursor(rows[0]) : '');
      return {
        page, offset, limit, total, hasMore, nextCursor, snapshotCursor, trash: trashSupported, trashCount: trashSupported ? await store.countTrash() : 0,
        images: rows.map(cursors.galleryImageSummary)
      };
    },

    async getImage(id) {
      const row = await store.getGalleryImage(id);
      if (!row) throw new GalleryServiceError(404, '图片不存在。');
      let params = {};
      try { params = JSON.parse(row.params_json); } catch {}
      return {
        ...row,
        favorite: Boolean(row.favorite),
        params,
        thumbUrl: `/api/images/${row.id}/thumbnail`,
        previewUrl: `/api/images/${row.id}/preview`,
        originalUrl: `/api/images/${row.id}/original`
      };
    },

    // 回收站 (1.8.4): by default a delete moves pictures to the bin (instant, no file I/O); they can be
    // restored for TRASH_KEEP_MS. `permanent` keeps the old immediate delete.
    async deleteImages(values, { permanent = false } = {}) {
      const ids = [...new Set(Array.isArray(values) ? values.map(value => String(value)).filter(Boolean) : [])].slice(0, 200);
      if (!ids.length) throw new GalleryServiceError(400, '请选择要删除的图片。');
      if (trashSupported && !permanent) {
        const rows = await store.trashGalleryImages(ids, clock.now());
        const result = await deleteResult(ids, rows);
        return { ...result, trashed: true, deletedBytes: 0, trashCount: await store.countTrash(), expiresAt: clock.now() + TRASH_KEEP_MS };
      }
      const rows = await store.getGalleryImagesByIds(ids);
      const extra = rows.length && effects.deleteGalleryRows ? await effects.deleteGalleryRows(rows) : {};
      return deleteResult(ids, rows, extra);
    },

    async deleteImage(id) {
      if (trashSupported) return this.deleteImages([id]);
      const row = await store.getGalleryImage(id);
      if (!row) throw new GalleryServiceError(404, '图片不存在。');
      const extra = effects.deleteGalleryRows ? await effects.deleteGalleryRows([row]) : {};
      return deleteResult([row.id], [row], extra);
    },

    trashSupported,
    async listTrash() {
      if (!trashSupported) return { supported: false, images: [], keepMs: TRASH_KEEP_MS };
      const rows = await store.listTrash();
      return { supported: true, keepMs: TRASH_KEEP_MS, images: rows.map(row => ({ id: row.id, bytes: Number(row.bytes) || 0, createdAt: row.created_at, deletedAt: row.deleted_at,
        expiresAt: row.deleted_at + TRASH_KEEP_MS, thumbUrl: `/api/images/trash/${encodeURIComponent(row.id)}/thumbnail` })) };
    },
    async restoreTrash(values) {
      const ids = [...new Set(Array.isArray(values) ? values.map(String).filter(Boolean) : [])].slice(0, 200);
      if (!ids.length) throw new GalleryServiceError(400, '请选择要恢复的图片。');
      const restored = await store.restoreTrash(await store.trashRows({ ids }));
      const latest = await store.getLatestGalleryImage();
      return { restored, galleryTotal: await store.countAllGalleryImages(), latestImage: cursors.galleryImageSummary(latest), trashCount: await store.countTrash() };
    },
    // Permanent delete from the bin: chosen ids, or everything with `all`.
    async purgeTrash({ ids = null, all = false } = {}) {
      let total = { purged: 0, deletedExamples: 0 };
      if (all) {
        for (let rows = await store.trashRows(); rows.length; rows = await store.trashRows()) {
          const part = await purgeRows(rows); total = { purged: total.purged + part.purged, deletedExamples: total.deletedExamples + part.deletedExamples };
        }
      } else {
        const list = [...new Set(Array.isArray(ids) ? ids.map(String).filter(Boolean) : [])].slice(0, 200);
        if (!list.length) throw new GalleryServiceError(400, '请选择要彻底删除的图片。');
        total = await purgeRows(await store.trashRows({ ids: list }));
      }
      return { ...total, trashCount: await store.countTrash() };
    },
    // Called on a timer: pictures in the bin longer than TRASH_KEEP_MS are deleted for good.
    async purgeExpiredTrash() {
      if (!trashSupported) return { purged: 0 };
      let purged = 0;
      for (let rows = await store.trashRows({ olderThan: clock.now() - TRASH_KEEP_MS }); rows.length; rows = await store.trashRows({ olderThan: clock.now() - TRASH_KEEP_MS })) {
        purged += (await purgeRows(rows)).purged;
      }
      return { purged };
    },
    async trashThumbnailName(id) {
      const row = trashSupported ? await store.getTrashRow(String(id || '')) : null;
      if (!row?.thumb_name) throw new GalleryServiceError(404, '回收站里没有这张图片。');
      return row.thumb_name;
    },

    async setFavorite(id, value) {
      const favorite = value ? 1 : 0;
      const changed = await store.setGalleryFavorite(id, favorite);
      if (!changed) throw new GalleryServiceError(404, '图片不存在。');
      const favoriteArtists = favorite && effects.favoriteArtistsForGalleryImage
        ? await effects.favoriteArtistsForGalleryImage(id)
        : [];
      return { favorite: Boolean(favorite), favoriteArtists };
    },

    async setNote(id, value) {
      const note = String(value || '').slice(0, 1000);
      const changed = await store.setGalleryNote(id, note);
      if (!changed) throw new GalleryServiceError(404, '图片不存在。');
      return { ok: true };
    }
  };
}
