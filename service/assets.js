import { detectImageMime, imageDimensionsFromBytes, imageExtension } from '../public/image-bytes.js';
import { sanitizeImageRef } from '../public/generation-payload.js';

export const validAssetId = id => /^[0-9a-f-]{16,80}$/i.test(String(id || ''));

export function inputAssetPublic(row) {
  if (!row) return null;
  return {
    id: row.id, ref: { source: 'asset', id: row.id }, originalName: row.original_name || '',
    mime: row.mime, width: row.width || null, height: row.height || null,
    bytes: Number(row.bytes || 0), createdAt: row.created_at, url: `/api/assets/${row.id}/original`
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('图片处理已取消。'); error.name = 'AbortError'; throw error;
  }
}


export function createAssetsService({ store, files, images, hash, ids, clock }) {
  async function save(buffer, { mime = '', originalName = '' } = {}) {
    const actualMime = detectImageMime(buffer, String(mime || '').split(';')[0].toLowerCase());
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(actualMime)) throw new Error('只支持 PNG / JPEG / WebP 图片。');
    const sha256 = await hash(buffer);
    const existing = await store.byHash(sha256);
    if (existing) return inputAssetPublic(existing);
    const id = ids.next();
    const storedName = `${id}.${imageExtension(actualMime)}`;
    const filePath = await files.write(storedName, buffer);
    const dimensions = imageDimensionsFromBytes(buffer) || await images.dimensions(filePath);
    await store.insert({ id, stored_name: storedName, original_name: String(originalName || '').slice(0, 300),
      mime: actualMime, width: dimensions.width, height: dimensions.height, bytes: buffer.length, sha256, created_at: clock.now() });
    return inputAssetPublic(await store.get(id));
  }
  async function get(id) { return validAssetId(id) ? store.get(String(id)) : null; }
  return {
    save, get,
    async cloneGallery(imageId) {
      const row = await store.gallery(String(imageId || ''));
      if (!row) throw new Error('图库图片不存在。');
      return save(await files.readGallery(row), { mime: row.mime, originalName: `gallery-${imageId}` });
    },
    async recent(value) {
      const parsed = Number.parseInt(value, 10);
      const limit = Number.isFinite(parsed) ? Math.min(60, Math.max(1, parsed)) : 24;
      return (await store.recent(limit)).map(inputAssetPublic);
    },
    async resolve(ref, { signal } = {}) {
      throwIfAborted(signal);
      const clean = sanitizeImageRef(ref);
      if (!clean) throw new Error('图片引用无效，请重新选择图片。');
      const row = await get(clean.id);
      if (!row) throw new Error('参考图片已不存在，请重新选择图片。');
      const filePath = files.locate(row);
      const buffer = await files.read(filePath, { signal });
      throwIfAborted(signal);
      return { row, filePath, buffer, mime: row.mime, sha256: row.sha256 };
    }
  };
}
