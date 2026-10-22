import { normalizeArtistIdentity } from '../public/artist-index-v5.js';
import { observationAttributes, matchesStyleAttributes, validateStyleAttributes } from '../public/artist-style-schema.js';
import { detectImageMime, imageDimensionsFromBytes } from '../public/image-bytes.js';
import { validateRemoteImageUrl } from './artist-pack.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const missing = error => error.code === 'ENOENT' || error.code === 'OS-PLUG-FILE-0008';
const json = (value, fallback) => value ? JSON.parse(value) : fallback;
const link = value => {
  try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
};
const automatic = row => !row.reviewed && ['assistant-visual','danbooru-tags'].includes(row.source);
const observation = row => ({
  id: row.id, exampleId: row.example_id, model: row.model, facets: json(row.facets_json, {}),
  attributes: validateStyleAttributes(json(row.attributes_json, {})), note: row.note,
  schemaVersion: row.schema_version, source: row.source, reviewed: Boolean(row.reviewed),
  automatic: automatic(row), provenance: json(row.provenance_json, {}), updatedAt: row.updated_at
});
const IMAGE_BYTES = 4 * 1024 * 1024;
const validImage = (buffer, mime) => {
  const size = buffer && buffer.length <= IMAGE_BYTES && (!mime || detectImageMime(buffer) === mime) ? imageDimensionsFromBytes(buffer) : null;
  return Boolean(size && size.width * size.height <= 32000000 && Math.max(size.width, size.height) <= 10000);
};
const mimeOf = extension => `image/${extension === 'jpg' ? 'jpeg' : extension}`;
export const REMOTE_IMAGE_USER_AGENT = 'NAI-Pocket/0.3 (artist annotation preview)';
export const REMOTE_IMAGE_CONCURRENCY = 4;
const remoteFailure = () => fail(502, '无法从 Danbooru 读取这张例图，请检查网络。');

// FIFO slots; a released slot is handed directly to the next waiter so the
// limit holds even when new callers arrive between release and resume.
function createLimiter(max) {
  let active = 0; const waiting = [];
  return {
    async acquire(signal) {
      signal?.throwIfAborted();
      if (active < max) { active++; return; }
      await new Promise((resolve, reject) => {
        const entry = { grant() { signal?.removeEventListener('abort', cancel); resolve(); } };
        function cancel() { const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1); reject(signal.reason); }
        waiting.push(entry); signal?.addEventListener('abort', cancel, { once: true });
      });
    },
    release() { const next = waiting.shift(); if (next) next.grant(); else active--; }
  };
}
export const artistResourceImageUrl = (id, tier = 'thumb', revision = '') => `/api/artists/resources/image?id=${encodeURIComponent(id)}&tier=${tier}&revision=${encodeURIComponent(revision)}`;


// Annotation-only packs store 'remote' tiers: the image is fetched from the
// validated Danbooru CDN URL on demand (no credentials) and cached locally.
export function createArtistResourceService({ store, files, http = { fetch: (...args) => globalThis.fetch(...args) }, remoteTimeoutMs = 20_000 }) {
  const limiter = createLimiter(REMOTE_IMAGE_CONCURRENCY);
  async function readCache(path, mime, signal) {
    if (!files?.stat || !files?.read) return null;
    try {
      const stat = await files.stat(path);
      if (!stat.isFile || stat.size > IMAGE_BYTES) return null;
      const buffer = await files.read(path, { signal });
      signal?.throwIfAborted();
      return validImage(buffer, mime) ? buffer : null;
    } catch { signal?.throwIfAborted(); return null; } // Any unreadable cache entry is a miss.
  }
  async function fetchRemote(url, mime, signal) {
    await limiter.acquire(signal);
    const controller = new AbortController(), cancel = () => controller.abort(signal.reason);
    const timer = setTimeout(() => controller.abort(), remoteTimeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      let response;
      try {
        response = await http.fetch(url, { method: 'GET', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
          headers: { Accept: 'image/webp,image/jpeg,image/png;q=0.9', 'User-Agent': REMOTE_IMAGE_USER_AGENT } });
      } catch { signal?.throwIfAborted(); throw remoteFailure(); }
      if ([404, 410].includes(response.status)) throw fail(404, 'Danbooru 上已找不到这张例图。');
      if (!response.ok || Number(response.headers?.get?.('content-length') || 0) > IMAGE_BYTES) throw remoteFailure();
      let buffer;
      try { buffer = new Uint8Array(await response.arrayBuffer()); }
      catch { signal?.throwIfAborted(); throw remoteFailure(); }
      signal?.throwIfAborted();
      if (!validImage(buffer, mime)) throw fail(502, '从 Danbooru 读取的例图格式无效或过大。');
      return buffer;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); limiter.release(); }
  }
  async function remoteImage(row, id, tier, signal) {
    let url;
    try { url = validateRemoteImageUrl(json(row.metadata_json, {}).remoteImages?.[tier]); }
    catch { throw fail(422, '例图资料格式无效。'); }
    const extension = url.split('.').at(-1), contentType = mimeOf(extension);
    const path = `artist-cache/${id}-${tier}.${extension}`;
    const cached = await readCache(path, contentType, signal);
    if (cached) return { buffer: cached, contentType };
    const buffer = await fetchRemote(url, contentType, signal);
    // A failed cache write (e.g. full storage) still shows the image this time.
    if (files?.write) await files.write(path, buffer).catch(() => {});
    return { buffer, contentType };
  }
  return {
    async catalog() {
      const { sets, profiles } = await store.catalog();
      return { sets: sets.map(row => ({ ...row, synthetic: Boolean(row.synthetic) })), profiles: profiles.map(row => ({
        artist: row.artist, displayName: row.display_name, aliases: json(row.aliases_json, []),
        exampleCount: row.example_count, annotatedCount: row.annotated_count, reviewedCount: row.reviewed_count,
        coverUrl: row.cover_id ? artistResourceImageUrl(row.cover_id,'thumb',row.storage_id) : null
      })) };
    },
    // Pictures attached by examples packs (V5 例图), for the settings summary.
    async generatedCount() { return store.generatedCount ? store.generatedCount() : { artists: 0, examples: 0 }; },
    async get(value) {
      const result = await store.profile(normalizeArtistIdentity(value));
      if (!result) return null;
      const { profile, examples, observations } = result;
      return { artist: profile.display_name, aliases: json(profile.aliases_json, []),
        resourceSet: { id: profile.set_id, version: profile.version, revision:profile.storage_id, title: profile.title, synthetic: Boolean(profile.synthetic) },
        examples: examples.map(row => ({ id: row.id, artist: profile.display_name, sourceType: 'original',
          sourceUrl: link(row.source_url), width: row.width, height: row.height, note: row.note,
          metadata: json(row.metadata_json, {}), thumbUrl: artistResourceImageUrl(row.id,'thumb',profile.storage_id), previewUrl: artistResourceImageUrl(row.id,'preview',profile.storage_id) })),
        observations: observations.map(observation)
      };
    },
    async matching({ attributes = {}, confirmedOnly = false, signal }) {
      signal?.throwIfAborted();
      let constraints;
      try { constraints = validateStyleAttributes(attributes); }
      catch { throw fail(400, '画风筛选条件无效。'); }
      const matches = new Set();
      await store.scanEvidence(rows=>{
        for (const row of rows) {
          const item = { facets: json(row.facets_json, {}), attributes: json(row.attributes_json, {}) };
          if (!Object.values(observationAttributes(item)).some(values => values.length)) continue;
          // Every requested dimension must match ONE observation, never a union of images.
          if (matchesStyleAttributes(item, constraints)) matches.add(row.artist);
        }
      },{confirmedOnly,signal});
      return matches;
    },
    async image(id, tier = 'thumb', { signal, revision } = {}) {
      if (!identity(id) || !['thumb','preview'].includes(tier)) throw fail(400, '例图请求无效。');
      signal?.throwIfAborted();
      const row = await store.image(id);
      if (!row) throw fail(404, '资料包中没有这张例图。');
      if (revision && revision !== row.storage_id) throw fail(409, '资料版本已更新，请重新打开画师资料。');
      const extension = row[`${tier}_ext`];
      if (extension === 'remote') return remoteImage(row, id, tier, signal);
      if (!identity(row.storage_id) || !['webp','png','jpg'].includes(extension)) throw fail(422, '例图资料格式无效。');
      const path = `artist-resources/${row.storage_id}/${id}-${tier}.${extension}`;
      try {
        const stat = await files.stat(path);
        if (!stat.isFile || stat.size > 4 * 1024 * 1024) throw fail(422, '例图文件过大或格式无效。');
        const buffer = await files.read(path, { signal });
        signal?.throwIfAborted();
        const size = imageDimensionsFromBytes(buffer);
        if (buffer.length > 4 * 1024 * 1024 || !size || size.width * size.height > 32000000 || Math.max(size.width,size.height) > 10000) throw fail(422, '例图文件损坏或尺寸过大。');
        return { buffer, contentType: `image/${extension === 'jpg' ? 'jpeg' : extension}` };
      } catch (error) { if (missing(error)) throw fail(404, '这张例图尚未下载到本机。'); throw error; }
    }
  };
}
