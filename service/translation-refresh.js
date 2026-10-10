export function createTranslationRefresh({ semanticSearch, translateText }) {



// "重新翻译" for selected Tags: public search names first (one search per eight
// Tags, which also replaces machine translations in the cache), then a forced
// remote translation for whatever is still machine-translated or missing.
// Manual and builtin entries are kept.

const KEEP = new Set(['manual', 'builtin', 'glossary', 'identity']);

async function refreshTagTranslations(rawItems, { signal } = {}) {
  const items = [...new Set((Array.isArray(rawItems) ? rawItems : []).map(item => String(item ?? '').trim()).filter(Boolean))].slice(0, 40);
  let searchError = '';
  for (let index = 0; index < items.length && !searchError; index += 8) {
    try {
      await semanticSearch({ query: items.slice(index, index + 8).join(', '), mode: 'concept_explore', limit: 80 }, { signal });
    } catch (error) {
      searchError = error.message;
    }
  }
  const results = [];
  for (const item of items) {
    const current = await translateText(item, 'en', 'zh-CN', { allowRemote: false });
    if (KEEP.has(current.status)) { results.push(current); continue; }
    try {
      results.push(await translateText(item, 'en', 'zh-CN', { force: true }));
    } catch (error) {
      results.push({ ...current, sourceText: item, status: current.text ? current.status : 'error', error: error.message });
    }
  }
  return { results, searchError };
}

return { refreshTagTranslations };
}
