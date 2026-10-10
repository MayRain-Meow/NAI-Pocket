
import { TAGGER_MAX_BYTES, parseEventStream, callTaggerSpace } from '../public/tagger-client.js';
export { TAGGER_SPACE, TAGGER_MODEL, TAGGER_MAX_BYTES, normalizeTaggerResult } from '../public/tagger-client.js';

// 反推 (image → Danbooru Tags) through the public WD Tagger Space on HuggingFace
// (SmilingWolf/wd-tagger, model wd-eva02-large-tagger-v3). The owner chose the online service
// over self-hosting: this host (0.75 CPU, 3 GB) has no room for the model. The image is
// uploaded to that public Space, and the panel says so. Only this fixed host is contacted.

export function createTaggerService({ hash, http = { fetch: (...args) => globalThis.fetch(...args) } }) {
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const CACHE_SLOTS = 40;

const cache = new Map(); // sha256 → result (least recently used first)
let active = 0;

const failure = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

async function interrogateImage(buffer, mime, { signal, fetchImpl = http.fetch } = {}) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!MIME_TYPES.has(type)) throw failure(415, '只支持 PNG、JPEG 或 WebP 图片。');
  if (!buffer?.length) throw failure(400, '没有收到图片。');
  if (buffer.length > TAGGER_MAX_BYTES) throw failure(413, '图片过大，最大 10 MB。');
  const key = await hash(buffer);
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return { ...hit, cached: true }; }
  // A public Space serves one caller at a time well; a second image waits for the first.
  if (active) throw failure(429, '上一张图还在反推，请稍候。', { retryAfterMs: 3000 });
  active += 1;
  try {
    let result;
    for (let attempt = 1; ; attempt += 1) {
      try { result = await callTaggerSpace(buffer, type, { signal, fetchImpl }); break; }
      catch (error) { if (attempt >= 2 || !error.retryable || signal?.aborted) throw error; }
    }
    cache.set(key, result);
    while (cache.size > CACHE_SLOTS) cache.delete(cache.keys().next().value);
    return { ...result, cached: false };
  } finally {
    active -= 1;
  }
}

const __test = { parseEventStream, reset() { cache.clear(); active = 0; } };

return { interrogateImage, __test };
}
