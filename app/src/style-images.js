import { Buffer } from 'buffer';
import { registerPlugin } from '@capacitor/core';
import { validateStyleModelManifest } from '../../service/style-index-local.js';
import { validateArtistResourceUrl } from '../../service/artist-pack.js';

// 以图找画师 in the app (0.6.0): the website's CLIP vision model runs on the phone (StyleEmbedPlugin).
// The model (~293 MB) is an optional download from its own GitHub Release, read through the same
// native JSON reader as the other catalogs and saved only after its checksum matches. Embedded
// pictures are kept in memory for 30 minutes under a random id, as on the server, so the shared
// artist page can page and add feel words without embedding again.

export const DEFAULT_STYLE_MODEL_URL = 'https://github.com/MayRain-Meow/NAI-Pocket/releases/download/style-model-clip-vit-l14/style-model.json';
const native = registerPlugin('StyleEmbed');
const resources = registerPlugin('ArtistResources');
const QUERY_TTL_MS = 30 * 60 * 1000, MAX_QUERIES = 40;
const failure = (message, status) => Object.assign(new Error(message), { status });

export function openStyleImages() {
  let present = null, operationId = '', embedding = Promise.resolve(), waiting = 0;
  const queries = new Map();
  const available = async () => {
    if (present === null) { try { present = Boolean((await native.modelStatus()).present); } catch { present = false; } }
    return present;
  };
  return {
    available,
    async state() { const status = await native.modelStatus(); present = Boolean(status.present); return status; },
    async readManifest(input = {}) {
      const url = validateArtistResourceUrl(input.url || DEFAULT_STYLE_MODEL_URL, 'json');
      const result = await resources.readCatalog({ url, operationId: crypto.randomUUID() });
      return { manifest: validateStyleModelManifest(result.catalog, url) };
    },
    async download(input = {}) {
      const manifest = validateStyleModelManifest(input.manifest, validateArtistResourceUrl(input.manifestUrl || DEFAULT_STYLE_MODEL_URL, 'json'));
      operationId = crypto.randomUUID();
      const result = await native.downloadModel({ url: manifest.file.url, sha256: manifest.file.sha256, operationId });
      present = null;
      return result.cancelled ? { cancelled: true } : { bytes: result.bytes };
    },
    async remove() { await native.deleteModel(); present = false; queries.clear(); return { removed: true }; },
    status: () => native.status(),
    async cancel() { await native.cancel({ operationId }); return { accepted: true }; },
    // One picture at a time; two more may wait, a fourth is refused like on the server.
    async embed(bytes) {
      if (!await available()) throw failure('还没有下载以图找画师的模型：设置 → 画风数据。', 503);
      if (waiting >= 3) throw failure('正在处理其他图片，请稍后再试。', 429);
      waiting++;
      const run = embedding.then(() => native.embed({ data: Buffer.from(bytes).toString('base64') }));
      embedding = run.catch(() => {});
      try {
        const { vector } = await run;
        if (!Array.isArray(vector) || !vector.length) throw failure('以图找画师没有得到结果。', 500);
        const now = Date.now();
        for (const [key, entry] of queries) if (now - entry.at > QUERY_TTL_MS) queries.delete(key);
        while (queries.size >= MAX_QUERIES) queries.delete(queries.keys().next().value);
        const id = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
        queries.set(id, { vector: Float32Array.from(vector), at: now });
        return id;
      } catch (error) { throw error.status ? error : failure(error.message || '以图找画师出错。', 422); }
      finally { waiting--; }
    },
    vector(id) {
      const entry = queries.get(String(id || ''));
      if (!entry || Date.now() - entry.at > QUERY_TTL_MS) { queries.delete(String(id || '')); return null; }
      return entry.vector;
    }
  };
}
