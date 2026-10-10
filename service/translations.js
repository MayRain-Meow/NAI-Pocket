import {
  BUILTIN_EN_ZH, PUBLIC_GLOSSARY_PROVIDER, statusFor, cleanText, cacheKey, hasCjk,
  normalizeLang, getBuiltin, normalizePublicGlossaryEntry
} from '../public/translation-core.js';


export { PUBLIC_GLOSSARY_PROVIDER };
// Preserve synchronous Node APIs while allowing asynchronous native storage.
const mapResult = (value, map) => value && typeof value.then === 'function' ? value.then(map) : map(value);


export function createTranslationService({ store, settings, http = { fetch: (...args) => globalThis.fetch(...args) }, clock = { now: () => Date.now() } }) {
const inflight = new Map();
// Public tag names learned from DanbooruSearch results share the cache table.
// They replace machine translations (MyMemory/LibreTranslate often mistranslate
// tags, e.g. "hair intakes" → "头发摄入量") but never manual or builtin entries.



function remoteConfigured() {
  return settings.translationEnabled && settings.translationProvider !== 'off';
}

function readCache(text, source, target) {
  return mapResult(store.read(cleanText(text), source, target), row => row ? {
    text: row.translated_text, provider: row.provider, manual: Boolean(row.is_manual), cached: true, updatedAt: row.updated_at
  } : null);
}

function writeCache(sourceText, source, target, translatedText, provider, manual = false, replaceManual = false) {
  const sourceValue = cleanText(sourceText);
  const translatedValue = cleanText(translatedText);
  if (!sourceValue || !translatedValue) return;
  return store.write({ text: sourceValue, source, target, translated: translatedValue, provider, manual, replaceManual, now: clock.now() });
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.translationTimeoutMs);
  try {
    const response = await http.fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    if (!response.ok) throw new Error(data?.error || data?.message || `翻译服务 HTTP ${response.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function remoteMyMemory(text, source, target) {
  const endpoint = settings.translationApiUrl || 'https://api.mymemory.translated.net/get';
  const url = new URL(endpoint);
  url.searchParams.set('q', text);
  url.searchParams.set('langpair', `${source}|${target}`);
  url.searchParams.set('mt', '1');
  if (settings.translationEmail) url.searchParams.set('de', settings.translationEmail);
  const data = await fetchJson(url);
  const result = cleanText(data?.responseData?.translatedText || '');
  if (!result || /MYMEMORY WARNING|AVAILABLE FREE TRANSLATION/i.test(result)) throw new Error('免费翻译额度暂时用尽。');
  return result;
}

async function remoteLibreTranslate(text, source, target) {
  const base = (settings.translationApiUrl || 'https://libretranslate.com').replace(/\/$/, '');
  const data = await fetchJson(`${base}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: text,
      source: source === 'zh-CN' ? 'zh' : source,
      target: target === 'zh-CN' ? 'zh' : target,
      format: 'text',
      ...(settings.translationApiKey ? { api_key: settings.translationApiKey } : {})
    })
  });
  const result = cleanText(data?.translatedText || '');
  if (!result) throw new Error('翻译服务返回空结果。');
  return result;
}

async function remoteTranslate(text, source, target) {
  if (!settings.translationEnabled || settings.translationProvider === 'off') throw new Error('翻译功能已关闭。');
  if (settings.translationProvider === 'libretranslate') return remoteLibreTranslate(text, source, target);
  return remoteMyMemory(text, source, target);
}

async function translateText(rawText, rawSource = 'en', rawTarget = 'zh-CN', options = {}) {
  const text = cleanText(rawText);
  const source = normalizeLang(rawSource === 'auto' ? (hasCjk(text) ? 'zh-CN' : 'en') : rawSource);
  const target = normalizeLang(rawTarget);
  if (!text) return { text: '', source, target, provider: 'none', cached: true, status: 'missing' };
  if (source === target) return { text, source, target, provider: 'identity', cached: true, status: 'identity' };

  const force = options.force === true;
  const cached = force ? null : await readCache(text, source, target);
  if (cached) return { ...cached, source, target, sourceText: text, status: statusFor(cached) };

  const builtin = force ? '' : getBuiltin(text, source, target);
  if (builtin) {
    await writeCache(text, source, target, builtin, 'builtin', false);
    return { text: builtin, source, target, sourceText: text, provider: 'builtin', cached: true, status: 'builtin' };
  }

  if (options.allowRemote === false || !remoteConfigured()) return { text: '', source, target, sourceText: text, provider: 'none', cached: false, status: 'missing', remoteConfigured: remoteConfigured() };

  const key = `${cacheKey(text, source, target)}|${force ? 'refresh' : 'cached'}`;
  if (inflight.has(key)) return inflight.get(key);
  const task = (async () => {
    try {
      const translated = await remoteTranslate(text, source, target);
      await writeCache(text, source, target, translated, settings.translationProvider, false, force);
      return { text: translated, source, target, sourceText: text, provider: settings.translationProvider, cached: false, status: 'remote' };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

async function translateBatch(items, rawSource = 'en', rawTarget = 'zh-CN', options = {}) {
  const unique = [...new Set((Array.isArray(items) ? items : []).map(cleanText).filter(Boolean))].slice(0, 100);
  const results = new Map();
  const concurrency = Math.max(1, Math.min(10, Number(options.concurrency) || 3));
  let cursor = 0;
  async function worker() {
    while (cursor < unique.length) {
      const index = cursor++;
      const item = unique[index];
      try { results.set(item, await translateText(item, rawSource, rawTarget, options)); }
      catch (error) { results.set(item, { text: '', sourceText: item, error: error.message, provider: 'error', status: 'error' }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return unique.map(item => ({ sourceText: item, ...(results.get(item) || {}) }));
}

function saveManualTranslation(sourceText, translatedText, rawSource = 'en', rawTarget = 'zh-CN') {
  const source = normalizeLang(rawSource);
  const target = normalizeLang(rawTarget);
  const sourceValue = cleanText(sourceText);
  const translatedValue = cleanText(translatedText);
  if (!sourceValue || !translatedValue) throw new Error('英文 Tag 和中文释义都不能为空。');
  return mapResult(writeCache(sourceValue, source, target, translatedValue, 'manual', true), () => ({ sourceText: sourceValue, text: translatedValue, source, target, provider: 'manual', manual: true, cached: true, status: 'manual' }));
}

// Records public result tags only; the search query itself is never stored.
function recordPublicTagNames(results) {
  if (!Array.isArray(results)) return 0;
  const entries = results.slice(0, 500).map(normalizePublicGlossaryEntry).filter(Boolean);
  return store.recordPublic(entries, PUBLIC_GLOSSARY_PROVIDER, clock.now());
}

// Immediate candidates from data already on this server: the translation cache
// (manual first), builtin words and the bundled V5 artist index. No network.
function localTagSuggestions(rawQuery, artistNames = [], limit = 12) {
  const q = cleanText(rawQuery).toLocaleLowerCase('en-US').replace(/_/g, ' ');
  const max = Math.max(1, Math.min(20, Number(limit) || 12));
  if (!q) return [];
  const out = [], seen = new Set();
  const push = (tag, translation, source) => {
    const key = String(tag).toLocaleLowerCase('en-US').replace(/_/g, ' ');
    if (!key || seen.has(key) || out.length >= max) return;
    seen.add(key); out.push({ tag, translation: translation || '', source });
  };
  const artistQuery = q.replace(/^artist\s*:\s*/, '');
  if (!/^artist\s*:/.test(q)) {
    const like = value => value.replace(/[\\%_]/g, '\\$&');
    return mapResult(store.suggest(`${like(q)}%`, `%${like(q)}%`, max * 2), rows => {
    for (const row of rows) push(row.tag, row.translation, row.is_manual ? 'manual' : row.provider === PUBLIC_GLOSSARY_PROVIDER ? 'glossary' : 'cache');
    for (const [tag, translation] of BUILTIN_EN_ZH) if (tag.includes(q) || translation.includes(q)) push(tag, translation, 'builtin');
    return finish();
    });
  }
  return finish();
  function finish() {
  if (artistQuery && out.length < max) {
    for (const name of artistNames) {
      if (String(name).toLocaleLowerCase('en-US').replace(/_/g, ' ').includes(artistQuery)) push(`artist:${name}`, `画师：${name}`, 'local-v5-artist-index');
      if (out.length >= max) break;
    }
  }
  return out;
  }
}

function searchCachedEnglishByChinese(query, limit = 12) {
  const value = `%${cleanText(query).replace(/[\\%_]/g, '\\$&')}%`;
  return store.searchChinese(value, Math.max(1, Math.min(50, Number(limit) || 12)));
}

function translationStatus() {
  return mapResult(store.counts(PUBLIC_GLOSSARY_PROVIDER), ({ row, glossary }) => ({
    enabled: remoteConfigured(),
    provider: settings.translationProvider,
    cachedCount: Number(row?.count || 0),
    manualCount: Number(row?.manual || 0),
    glossaryCount: Number(glossary?.count || 0),
    suggestLimit: settings.translationSuggestLimit
  }));
}

return { translateText, translateBatch, saveManualTranslation, recordPublicTagNames, localTagSuggestions, searchCachedEnglishByChinese, translationStatus };
}
