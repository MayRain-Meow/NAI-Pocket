// The app's 画风数据: the style index as one downloaded file (public/style-rank.js format), decoded
// lazily on first use and kept in memory. Hosts supply `read()` → bytes or null when not installed.

import { readStylePack, decodeStyleIndex, styleIndexSummary } from '../public/style-rank.js';
import { validateArtistResourceUrl } from './artist-pack.js';

export const STYLE_FILE_MAX_BYTES = 64 * 1024 * 1024;
const fail = message => Object.assign(new Error(message), { status: 400 });
const check = (condition, message) => { if (!condition) throw fail(message); };
const count = value => Number.isSafeInteger(value) && value >= 0;
const repoOf = url => new URL(url).pathname.split('/').slice(1, 3).join('/');

function validateStyleFile(file = {}, manifestUrl = '') {
  const url = validateArtistResourceUrl(file.url, 'bin');
  check(Number.isSafeInteger(file.bytes) && file.bytes > 12 && file.bytes <= STYLE_FILE_MAX_BYTES, '画风数据大小无效。');
  check(typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256), '画风数据校验值无效。');
  if (manifestUrl) check(repoOf(url) === repoOf(validateArtistResourceUrl(manifestUrl, 'json')), '画风数据必须与目录来自同一个仓库。');
  return { url, bytes: file.bytes, sha256: file.sha256 };
}
// The manifest the app reads before downloading (style-index.json in the same Release). `v5` (0.7.1,
// optional): the V5 samples' index, a second file in the same Release, behind 依据 V5 出图 / 混合.
export function validateStyleManifest(value, manifestUrl = '') {
  check(value && typeof value === 'object' && value.format === 'nai-pocket-style-manifest' && value.formatVersion === 1, '画风数据目录格式无效。');
  check(typeof value.version === 'string' && /^[0-9A-Za-z._-]{1,40}$/.test(value.version), '画风数据版本无效。');
  check(count(value.images) && count(value.artists) && count(value.chips) && value.images > 0, '画风数据目录内容无效。');
  const file = validateStyleFile(value.file, manifestUrl);
  let v5 = null;
  if (value.v5 != null) {
    check(typeof value.v5 === 'object' && typeof value.v5.version === 'string' && /^[0-9A-Za-z._-]{1,40}$/.test(value.v5.version)
      && count(value.v5.images) && count(value.v5.artists) && value.v5.images > 0, 'V5 画风数据目录内容无效。');
    v5 = { version: value.v5.version, images: value.v5.images, artists: value.v5.artists, file: validateStyleFile(value.v5.file, manifestUrl) };
  }
  return { format: value.format, formatVersion: 1, version: value.version, model: String(value.model || '').slice(0, 80), builtAt: Number(value.builtAt) || 0,
    images: value.images, artists: value.artists, chips: value.chips, file, ...(v5 ? { v5 } : {}) };
}

export const STYLE_MODEL_MAX_BYTES = 512 * 1024 * 1024;
// The 以图找画师 model manifest (style-model.json in its own Release): the CLIP vision model file.
export function validateStyleModelManifest(value, manifestUrl = '') {
  check(value && typeof value === 'object' && value.format === 'nai-pocket-style-model' && value.formatVersion === 1, '模型目录格式无效。');
  check(typeof value.model === 'string' && /^[0-9A-Za-z._-]{1,80}$/.test(value.model), '模型名称无效。');
  const file = value.file || {};
  const url = validateArtistResourceUrl(file.url, 'onnx');
  check(Number.isSafeInteger(file.bytes) && file.bytes > 1024 && file.bytes <= STYLE_MODEL_MAX_BYTES, '模型大小无效。');
  check(typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256), '模型校验值无效。');
  if (manifestUrl) check(repoOf(url) === repoOf(validateArtistResourceUrl(manifestUrl, 'json')), '模型必须与目录来自同一个仓库。');
  return { format: value.format, formatVersion: 1, model: value.model, file: { url, bytes: file.bytes, sha256: file.sha256 } };
}

function lazyStyleIndex(read) {
  let index = null, loading = null, generation = 0, lastError = '';
  async function get() {
    if (index) return index;
    if (!loading) {
      const current = generation;
      loading = (async () => {
        const bytes = await read();
        if (!bytes) return null;
        const decoded = decodeStyleIndex(readStylePack(bytes));
        if (current === generation) { index = decoded; lastError = ''; }
        return decoded;
      })().catch(error => { lastError = error.message; throw error; }).finally(() => { loading = null; });
    }
    return loading;
  }
  return { get, async ready() { try { return await get(); } catch { return null; } }, error: () => lastError, reset() { index = null; generation++; } };
}
// `readV5` (0.7.1): the V5 samples' index, when installed; `samples()` is null without it.
export function createLocalStyleIndex({ read, readV5 = async () => null }) {
  const main = lazyStyleIndex(read), v5 = lazyStyleIndex(readV5);
  return {
    get: main.get,
    // Missing or unreadable data both mean "no style features"; the reason is kept for info().
    ready: main.ready,
    samples: v5.ready,
    async info() {
      const ix = await main.ready();
      if (!ix) return { available: false, error: main.error(), chips: [] };
      const samples = await v5.ready();
      return { ...styleIndexSummary(ix), v5: samples ? { artists: samples.names.length } : null };
    },
    reset() { main.reset(); v5.reset(); },
    decode: bytes => decodeStyleIndex(readStylePack(bytes))
  };
}
