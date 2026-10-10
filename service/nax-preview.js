import { isNaxV5Artist, normalizeArtistIdentity } from '../public/artist-index-v5.js';

export const NAX_IMAGE_BASE = 'https://cdn.zele.st/data/NAX/Images/danbooru-artist-tags-2-v5';
export const MAX_PREVIEW_BYTES = 12 * 1024 * 1024;


const strictEncode = value => encodeURIComponent(value)
  .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

export function buildNaxPreviewUrls(value) {
  const artist = normalizeArtistIdentity(value);
  if (!artist || artist.length > 160 || !isNaxV5Artist(artist)) return [];
  // The source decodes once; the stored filename itself contains percent escapes.
  // Exactly one candidate prevents a guaranteed miss for spaces and punctuation.
  return [`${NAX_IMAGE_BASE}/${strictEncode(strictEncode(artist))}.webp`];
}

// Only the public image protocol is portable. Private archives/mirroring stay in Node.

export function createNaxPreviewClient({ binary, http = { fetch: (...args) => globalThis.fetch(...args) } }) {
  async function responseBuffer(response, controller) {
    if (Number(response.headers.get('content-length') || 0) > MAX_PREVIEW_BYTES) {
      controller.abort();
      throw Object.assign(new Error('NAX 预览图过大。'), { status: 502 });
    }
    const chunks = [], reader = response.body?.getReader(); let total = 0;
    try {
      while (reader) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.length;
        if (total > MAX_PREVIEW_BYTES) {
          controller.abort();
          throw Object.assign(new Error('NAX 预览图过大。'), { status: 502 });
        }
        chunks.push(value);
      }
      return binary.concat(chunks);
    } finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
  }

  return async function fetchNaxArtistPreview(value, options = {}) {
    options.signal?.throwIfAborted();
    const urls = buildNaxPreviewUrls(value);
    if (!urls.length) throw Object.assign(new Error('这个 Tag 不在 NAX V5 画师索引中。'), { status: 404 });
    const fetchImpl = options.fetchImpl || http.fetch;
    const timeoutMs = Math.max(1000, Math.min(30_000, Number(options.timeoutMs) || 12_000));
    let sawRemoteFailure = false;
    for (const url of urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const cancel = () => controller.abort(options.signal.reason);
      options.signal?.addEventListener('abort', cancel, { once: true });
      try {
        const response = await fetchImpl(url, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'image/webp,image/*;q=0.8', 'User-Agent': 'NAI-Pocket/1.0.2' }
        });
        if (response.status === 404) continue;
        if (!response.ok) { sawRemoteFailure = true; continue; }
        const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!contentType.startsWith('image/')) { sawRemoteFailure = true; continue; }
        const buffer = await responseBuffer(response, controller);
        options.signal?.throwIfAborted();
        if (!buffer.length) { sawRemoteFailure = true; continue; }
        return { buffer, contentType, etag: response.headers.get('etag') || '',
          lastModified: response.headers.get('last-modified') || '', sourceUrl: url };
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error?.status) throw error;
        sawRemoteFailure = true;
      } finally {
        clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
        controller.abort();
      }
    }
    throw Object.assign(new Error(sawRemoteFailure ? 'NAX 预览服务暂时不可用。' : 'NAX 暂无这个画师的 V5 对照图。'), { status: sawRemoteFailure ? 502 : 404 });
  };
}
