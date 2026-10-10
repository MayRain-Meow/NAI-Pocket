
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

export function createGalleryService({ store, cursors, effects = {} }) {
  if (!store || !cursors) throw new TypeError('gallery store and cursor helpers are required');

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
        page, offset, limit, total, hasMore, nextCursor, snapshotCursor,
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

    async deleteImages(values) {
      const ids = [...new Set(Array.isArray(values) ? values.map(value => String(value)).filter(Boolean) : [])].slice(0, 200);
      if (!ids.length) throw new GalleryServiceError(400, '请选择要删除的图片。');
      const rows = await store.getGalleryImagesByIds(ids);
      const extra = rows.length && effects.deleteGalleryRows ? await effects.deleteGalleryRows(rows) : {};
      return deleteResult(ids, rows, extra);
    },

    async deleteImage(id) {
      const row = await store.getGalleryImage(id);
      if (!row) throw new GalleryServiceError(404, '图片不存在。');
      const extra = effects.deleteGalleryRows ? await effects.deleteGalleryRows([row]) : {};
      return deleteResult([row.id], [row], extra);
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
