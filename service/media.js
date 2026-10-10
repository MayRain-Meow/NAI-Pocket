
export class MediaServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'MediaServiceError';
    this.status = status;
  }
}

// Files are adapter-owned handles (paths in Node, native URIs in a future app).
// stat returns { isFile, size }; images.preview returns { size }. Ports may be async.
export function createMediaService({ store, files, images }) {
  const previewBuilds = new Map();
  const immutable = 'private, max-age=31536000, immutable';

  async function requireRow(read, id) {
    const row = await read(id);
    if (!row) throw new MediaServiceError(404, '图片不存在。');
    return row;
  }

  async function ensurePreview(row) {
    const previewName = row.preview_name || files.previewName(row);
    const previewPath = files.locate('preview', previewName);
    try {
      const stat = await files.stat(previewPath);
      if (stat.isFile) {
        if (!row.preview_name || Number(row.preview_bytes || 0) !== stat.size) {
          await store.updatePreview(row.id, previewName, stat.size);
        }
        return { previewPath, previewName };
      }
    } catch {}

    const active = previewBuilds.get(row.id);
    if (active) return active;
    const build = (async () => {
      const originalPath = files.locate('original', row.original_name);
      const stat = await images.preview(originalPath, previewPath);
      const changes = await store.updatePreview(row.id, previewName, stat.size);
      if (!Number(changes)) {
        await files.remove(previewPath);
        throw new Error('图片已被删除。');
      }
      return { previewPath, previewName };
    })();
    previewBuilds.set(row.id, build);
    try { return await build; }
    finally { previewBuilds.delete(row.id); }
  }

  return {
    ensurePreview,

    async thumbnail(id) {
      const row = await requireRow(store.getThumbnail, id);
      return { file: files.locate('thumbnail', row.thumb_name), mime: 'image/webp', options: { cache: immutable } };
    },

    async preview(id) {
      const row = await requireRow(store.getPreview, id);
      try {
        const preview = await ensurePreview(row);
        return { file: preview.previewPath, mime: 'image/webp', options: { cache: immutable } };
      } catch {
        // ImageMagick failure must not make an old gallery image unreadable.
        return { file: files.locate('original', row.original_name), mime: row.mime, options: { cache: 'private, max-age=300' } };
      }
    },

    async original(id, download = false) {
      const row = await requireRow(store.getOriginal, id);
      const headers = {};
      if (download) {
        const extension = row.mime === 'image/webp' ? 'webp' : 'png';
        headers['Content-Disposition'] = `attachment; filename="nai-${new Date(row.created_at).toISOString().replace(/[:.]/g, '-')}.${extension}"`;
      }
      return { file: files.locate('original', row.original_name), mime: row.mime, options: { headers, cache: immutable } };
    },

    async clean(id) {
      const row = await requireRow(store.getOriginal, id);
      const source = files.locate('original', row.original_name);
      const webp = row.mime === 'image/webp';
      const clean = await images.clean(source, webp ? 'webp' : 'png');
      const filename = `nai-clean-${new Date(row.created_at).toISOString().replace(/[:.]/g, '-')}.${webp ? 'webp' : 'png'}`;
      return {
        body: clean,
        headers: {
          'Content-Type': webp ? 'image/webp' : 'image/png',
          'Content-Length': clean.length,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store'
        }
      };
    },

    async readForTagger(id) {
      const row = await requireRow(store.getPreview, id);
      try {
        return { buffer: await files.read((await ensurePreview(row)).previewPath), mime: 'image/webp' };
      } catch {
        return { buffer: await files.read(files.locate('original', row.original_name)), mime: row.mime };
      }
    }
  };
}
