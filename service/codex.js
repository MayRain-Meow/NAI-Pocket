import { CODEX_SITE, MEDIA_FALLBACK, normalizeCodexIndex, metaView, imageUrl, slimEntry, parseCodexParams, normalizeCodexData, queryCodexData } from '../public/codex-core.js';
export { CODEX_SITE, parseCodexParams } from '../public/codex-core.js';

// Read-only access to the QuickTagCloud 法典 (community prompt codexes), used as
// an in-app reference. Only fixed data paths on known hosts are fetched — never
// a caller-supplied URL. Codexes are cached on disk by id@version and served to
// the app as small pages; image URLs follow the site's own media.js rules.

export function createCodexService({ cache, http = { fetch: (...args) => globalThis.fetch(...args) }, clock = { now: () => Date.now() } }) {
const DATA_HOSTS = new Set(['novelai.quicktagcloud.com', 'prompt-vault-gallery.pages.dev']);
const INDEX_TTL_MS = 30 * 60 * 1000;
const MAX_BYTES = 24 * 1024 * 1024;
const MEMORY_SLOTS = 3;

let indexCache = null;   // { at, codexes, media }
const memory = new Map(); // codexId -> { version, data }
const inflight = new Map();

const text = value => typeof value === 'string' ? value : '';
const safeName = value => String(value).replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 160);

function allowedUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || !DATA_HOSTS.has(url.hostname) || url.username || url.password) return null;
  return url.href;
}

async function fetchJson(url, { timeoutMs = 30_000 } = {}) {
  const safe = allowedUrl(url);
  if (!safe) throw Object.assign(new Error('法典数据地址不在允许范围内。'), { status: 502 });
  const response = await http.fetch(safe, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw Object.assign(new Error(`法典数据源返回 HTTP ${response.status}。`), { status: 502 });
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_BYTES) throw Object.assign(new Error('法典数据过大。'), { status: 502 });
  const body = await response.text();
  if (new TextEncoder().encode(body).length > MAX_BYTES) throw Object.assign(new Error('法典数据过大。'), { status: 502 });
  return JSON.parse(body);
}

async function codexIndex() {
  if (indexCache && clock.now() - indexCache.at < INDEX_TTL_MS) return indexCache;
  const file = 'index.json';
  try {
    const [list, media] = await Promise.all([
      fetchJson(`${CODEX_SITE}/data/codexes.json`),
      fetchJson(`${CODEX_SITE}/data/media.json`).catch(() => MEDIA_FALLBACK)
    ]);
    const { raw, media: normalizedMedia } = normalizeCodexIndex(list, media);
    indexCache = { at: clock.now(), raw, media: normalizedMedia };
    await cache.write(file, { raw, media: indexCache.media });
  } catch (error) {
    // Offline or upstream trouble: fall back to the last good index.
    const saved = !indexCache ? await cache.read(file) : null;
    if (saved) {
      indexCache = { at: clock.now() - INDEX_TTL_MS + 60_000, raw: saved.raw, media: saved.media };
    }
    if (!indexCache) throw error;
  }
  return indexCache;
}

async function listCodexes() {
  const index = await codexIndex();
  return { site: CODEX_SITE, codexes: index.raw.map(metaView) };
}

async function loadCodex(id) {
  const index = await codexIndex();
  const meta = index.raw.find(item => item.id === id);
  if (!meta) throw Object.assign(new Error('没有这部法典。'), { status: 404 });
  const version = text(meta.version) || 'unversioned';
  const hit = memory.get(id);
  if (hit && hit.version === version) { memory.delete(id); memory.set(id, hit); return hit.data; }
  if (inflight.has(id)) return inflight.get(id);
  const task = (async () => {
    const file = `${safeName(id)}@${safeName(version)}.json`;
    let raw = await cache.read(file);
    if (!raw) {
      const primary = meta.dataUrl ? String(meta.dataUrl) : `${CODEX_SITE}/data/${encodeURIComponent(id)}.json`;
      try { raw = await fetchJson(primary, { timeoutMs: 60_000 }); }
      catch (error) {
        if (!meta.fallbackDataUrl) throw error;
        raw = await fetchJson(new URL(String(meta.fallbackDataUrl), `${CODEX_SITE}/`).href, { timeoutMs: 60_000 });
      }
      await cache.replace(`${safeName(id)}@`, file, raw);
    }
    const data = normalizeCodexData(meta, raw, index.media);
    memory.set(id, { version, data });
    while (memory.size > MEMORY_SLOTS) memory.delete(memory.keys().next().value);
    return data;
  })().finally(() => inflight.delete(id));
  inflight.set(id, task);
  return task;
}

async function queryCodex(id, { path: rawPath = '', q = '', offset = 0, limit = 40 } = {}) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(id))) throw Object.assign(new Error('法典编号无效。'), { status: 400 });
  const data = await loadCodex(id);
  return queryCodexData(data, { path: rawPath, q, offset, limit });
}

const __test = { imageUrl, slimEntry, allowedUrl, parseCodexParams, reset() { indexCache = null; memory.clear(); } };

return { codexIndex, listCodexes, queryCodex, __test };
}
