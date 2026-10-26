// Shared vocabulary and evidence-based filtering; no browser or database state.
import { normalizeArtistIdentity, identifyArtistTag } from './artist-index-v5.js?v=1.9.29';
import { tokenizePrompt, parseTagToken } from './prompt-utils.js?v=1.9.29';
import { attributesFromLegacy, legacyFromAttributes, validateStyleAttributes, parseAttributeQuery, matchesStyleAttributes, matchesAnyStyleAttribute, scoreStyleMatch, describeStyleAttributes, observationAttributes } from './artist-style-schema.js?v=1.9.29';

const option = (value, label, ...aliases) => ({ value, label, aliases });
export const STYLE_FACETS = Object.freeze([
  { key: 'line', label: '线条', options: [option('fine', '纤细', '细线', '细腻线条'), option('bold', '粗重', '粗线'), option('soft', '弱轮廓', '无线稿', '弱线条'), option('sketch', '草稿感', '草稿线')] },
  { key: 'coloring', label: '上色', options: [option('flat', '平涂'), option('cel', '赛璐璐', 'cel shading'), option('painterly', '厚涂', 'painterly'), option('watercolor', '水彩感', '水彩', 'watercolor'), option('ink', '水墨/墨线', '水墨', '水墨画', '墨', '墨线', 'ink', 'ink wash')] },
  { key: 'palette', label: '色彩', options: [option('muted', '低饱和', '低饱和度', 'muted'), option('vivid', '高饱和', '高饱和度', '鲜艳'), option('cool', '冷色调', '冷色'), option('warm', '暖色调', '暖色'), option('limited', '有限色板', '少量配色'), option('monochrome', '无彩黑白', '黑白', '单色', '黑白线稿'), option('greyscale', '灰度', '灰阶', 'grayscale')] },
  { key: 'lighting', label: '光影', options: [option('soft', '柔光', '柔和光影'), option('hard', '硬边阴影', '硬阴影'), option('lowContrast', '低反差', '低对比'), option('highContrast', '高反差', '高对比'), option('backlit', '逆光')] },
  { key: 'texture', label: '质感', options: [option('smooth', '平滑'), option('grain', '颗粒', '颗粒感'), option('paper', '纸感', '纸张质感'), option('brush', '可见笔触', '笔触'), option('wash', '晕染/渗化', '晕染', '渗化', 'ink bleed')] },
  { key: 'shape', label: '造型', options: [option('flat', '平面概括', '平面化'), option('stylized', '夸张比例'), option('realistic', '偏写实', '写实', 'realistic'), option('detailed', '细节密集', '丰富细节')] }
]);

export function validateStyleFacets(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('画风特征格式无效。');
  const result = {};
  for (const [key, values] of Object.entries(value)) {
    const facet = STYLE_FACETS.find(item => item.key === key);
    if (!facet || !Array.isArray(values) || values.length > facet.options.length
      || values.some(item => !facet.options.some(option => option.value === item))) throw new Error('包含未知的画风特征。');
    if (values.length) result[key] = [...new Set(values)];
  }
  return result;
}

// Explicit medium/style tags only. A subject's hair/clothes, artist identity or
// broad "traditional_media" tag cannot establish a visual style. These are
// suggestions about one original artwork, never confirmed or model evidence.
// Danbooru already stores up to 512 tags per saved original, but only the handful
// named here reached the searchable vocabulary; the rest used to be discarded.

const DANBOORU_STYLE_RULES = [
  ['sketch', 'line', 'sketch'],
  ['flat_color', 'coloring', 'flat'],
  ['anime_coloring', 'coloring', 'cel'],
  ['watercolor_(medium)', 'coloring', 'watercolor'],
  ['watercolor_effect', 'coloring', 'watercolor'],
  ['ink', 'coloring', 'ink'],
  // `monochrome` is the colorless representative, NOT a limited palette. Mapping it
  // to `limited` recorded a breadth property the schema forbids beside
  // saturation=monochrome, and left every monochrome original invisible to 黑白.
  ['monochrome', 'palette', 'monochrome'],
  ['greyscale', 'palette', 'greyscale'],
  ['limited_palette', 'palette', 'limited'],
  ['backlighting', 'lighting', 'backlit'],
  ['realistic', 'shape', 'realistic']
].map(([tag, facet, value]) => ({ tag, facet, value, sourceUrl: `https://safebooru.donmai.us/wiki_pages/${encodeURIComponent(tag)}` }));

export function deriveDanbooruStyleFacets(rawTags = []) {
  const tags = new Set((Array.isArray(rawTags) ? rawTags : String(rawTags).split(/\s+/)).filter(tag => typeof tag === 'string'));
  const rules = DANBOORU_STYLE_RULES.filter(rule => tags.has(rule.tag));
  const facets = {};
  for (const rule of rules) facets[rule.facet] = [...new Set([...(facets[rule.facet] || []), rule.value])];
  return { facets, provenance: { version: 1, matchedTags: rules.map(rule => rule.tag), rules: rules.map(rule => ({ ...rule })) } };
}

export { collectPositiveRecommendationTags } from './storm-utils.js?v=1.9.29';

// Candidate mentions, not proof of single-artist attribution. Keep the full prompt
// beside these summaries: free-form syntax and model interactions remain uncertain.
export function collectArtistEvidenceMentions(state = {}, prompt = '') {
  // Mentions follow identifyArtistTag: NAX snapshot, installed roster, unique aliases,
  // or an explicit artist: prefix. Ambiguous aliases stay out.
  
  const result = new Map();
  const visit = (text, weight = 1, depth = 0) => {
    if (depth > 4 || result.size >= 100) return;
    for (const token of tokenizePrompt(String(text || '').slice(0, 30000))) {
      if (result.size >= 100) break;
      const parsed = parseTagToken(token);
      const combined = weight * parsed.weight;
      if (parsed.text !== token || parsed.bundle) { visit(parsed.text, combined, depth + 1); continue; }
      const identity = identifyArtistTag(parsed.text);
      if (!identity.recognized) continue;
      const artist = normalizeArtistIdentity(identity.canonical || identity.normalized);
      if (artist && artist.length <= 160 && !result.has(artist)) result.set(artist, { artist, weight: Number.isFinite(combined) ? combined : null });
    }
  };
  const tags = ['scene', 'camera', 'style', 'misc'].flatMap(key => state.groups?.[key] || []);
  for (const character of state.characters || []) if (character.enabled !== false) tags.push(...(character.promptTags || []));
  for (const tag of tags) if (tag.enabled !== false) visit(tag.text, Number(tag.weight ?? 1));
  visit(prompt);
  return [...result.values()];
}

const searchTerms = STYLE_FACETS.flatMap(facet => facet.options.flatMap(opt =>
  [opt.label, ...opt.aliases].map(term => ({ term: term.toLowerCase(), key: facet.key, value: opt.value }))
)).sort((a, b) => b.term.length - a.term.length);
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseStyleQuery(value = '') {
  let rest = String(value).trim().toLowerCase().slice(0, 300);
  const facets = {};
  for (const { term, key, value } of searchTerms) {
    const pattern = new RegExp(/^[a-z]/.test(term) ? `\\b${escapeRegex(term)}\\b` : escapeRegex(term), 'g');
    if (!pattern.test(rest)) continue;
    facets[key] = [...new Set([...(facets[key] || []), value])];
    rest = rest.replace(pattern, ' ');
  }
  // Known connective phrases only; unknown descriptions remain visible search terms.
  rest = rest.replace(/(?:想要|寻找|找一个|风格|画风|画师|的|以及|并且)/g, ' ').replace(/[，、,；;。]+/g, ' ').trim();
  return { facets, terms: rest ? [normalizeArtistIdentity(rest)] : [] };
}

// True when a typed query names at least one controlled style property. The UI uses
// this to offer ranked retrieval as soon as the words are actually understood, rather
// than hiding the whole ranked path behind a sort dropdown nobody would discover.
export function queryHasStyleTerms(value = '') {
  const typed = parseAttributeQuery(value);
  return Object.keys(typed.attributes).length > 0 || Object.keys(parseStyleQuery(typed.rest).facets).length > 0;
}

// The name-search haystack is built from the artist, its name, its aliases and its note —
// all invariant for a catalog entry between refreshes — yet it was rebuilt for all ~4,000
// artists on every request (normalise + join). Memoised by object identity; the catalog
// replaces the whole entry object when a row changes, so a stale string cannot survive.
const haystackMemo = new WeakMap();

function artistHaystack(artist) {
  const cached = haystackMemo.get(artist);
  if (cached !== undefined) return cached;
  const value = [artist.artist, artist.name, ...(artist.aliases || []), artist.note || ''].map(normalizeArtistIdentity).join('\n');
  haystackMemo.set(artist, value);
  return value;
}

// Per-keystroke search walked every artist's observations through observationAttributes again.
// The result depends only on the observation array (replaced, never mutated, when an entry is
// rebuilt) and the two flags, so it is memoised on that array. Same for the exact-name keys below.
const usableMemo = new WeakMap();
export function usableObservations(artist, options) {
  const includeAutomatic = options.includeAutomatic !== false && !options.confirmedOnly;
  const list = artist.observations || [];
  let memo = usableMemo.get(list);
  if (!memo) { memo = new Map(); usableMemo.set(list, memo); }
  const key = includeAutomatic ? 'auto' : 'reviewed';
  if (memo.has(key)) return memo.get(key);
  const usable = list.filter(item => (item.reviewed === true || (includeAutomatic && item.automatic === true && ['danbooru-tags', 'assistant-visual'].includes(item.source)))
    && item.exampleId && Object.values(observationAttributes(item)).some(values => values.length));
  memo.set(key, usable);
  return usable;
}

const nameKeyMemo = new WeakMap();
function artistNameKeys(artist) {
  let keys = nameKeyMemo.get(artist);
  if (!keys) { keys = [artist.artist, ...(artist.aliases || [])].map(normalizeArtistIdentity); nameKeyMemo.set(artist, keys); }
  return keys;
}

export function filterArtistCatalog(artists, options = {}) {
  // A complete artist/alias match wins over vocabulary parsing (e.g. "watercolor").
  const normalizedQuery = normalizeArtistIdentity(options.query || '');
  const exactName = normalizedQuery && artists.some(item => artistNameKeys(item).includes(normalizedQuery));
  const typed = exactName ? { attributes: {}, rest: options.query || '' } : parseAttributeQuery(options.query);
  const parsed = exactName ? { facets: {}, terms: [normalizedQuery] } : parseStyleQuery(typed.rest);
  parsed.facets = { ...parsed.facets, ...legacyFromAttributes(typed.attributes) };
  const explicit = validateStyleFacets(options.facets || {});
  const facets = { ...parsed.facets };
  for (const [key, values] of Object.entries(explicit)) facets[key] = [...new Set([...(facets[key] || []), ...values])];
  const attributes = attributesFromLegacy(facets);
  for (const [key, values] of Object.entries(typed.attributes)) attributes[key] = [...new Set([...(attributes[key] || []), ...values])];
  for (const [key, values] of Object.entries(validateStyleAttributes(options.attributes || {}))) attributes[key] = [...new Set([...(attributes[key] || []), ...values])];
  const needed = Object.entries(attributes);
  const model = String(options.model || '');
  // Admission that does not mention a style, a model, a description, or an
  // annotation flag can be decided without walking observations. That is the
  // default browse / favourite path — paging used to rescan the whole roster
  // for every page. Search and facet filters still use the same helper below.
  
  const needsObservations = Boolean(options.annotated || options.confirmedOnly || model || parsed.terms.length || needed.length);
  const matchedObservations = new Map();
  
  // Ranking is opt-in so the precise behaviour every existing caller and test relies
  // on stays the default: `rank` admits an artist whose examples evidence only PART
  // of the intent and scores them, while the default still demands one example that
  // satisfies everything at once. `strict` restores the exact admission under
  // ranking, so a ranked list can still be narrowed to confirmed matches.
  const ranked = Boolean(options.rank) && needed.length > 0;
  const styleMatches = new Map();
  // Terms that only the annotation *description* could satisfy. They are collected so the caller can
  // say 「描述提及」 instead of letting a machine-written sentence read as a fact about the artist —
  // the description is unreviewed prose, not an attribute, and the two must not be counted together.
  // Why a scan rather than an index, and why the layer stays separate, 见
  
  const textTerms = new Set();
  const result = artists.filter(artist => {
    if (options.favorite && !artist.favorite) return false;
    if (!needsObservations) return true;
    const haystack = artistHaystack(artist);
    const observations = usableObservations(artist, options).filter(item => !model || item.model === model);
    if ((options.annotated || options.confirmedOnly) && !observations.length) return false;
    // Every query term must be satisfied by the artist's own name/alias/note or by a description of
    // one of their usable examples. Descriptions are searched as plain substrings because that is
    // what was measured to be fast enough — 9–17 ms across the whole library — and because FTS5's
    // trigram tokenizer cannot index two-character Chinese words at all, which is most of what gets
    // typed. No join is built: `some` short-circuits per term.
    for (const term of parsed.terms) {
      if (haystack.includes(term)) continue;
      if (observations.some(item => String(item.note || '').toLowerCase().includes(term))) { textTerms.add(term); continue; }
      return false;
    }
    if (needed.length) {
      if (!ranked) {
        const matching = observations.filter(observation => matchesStyleAttributes(observation, attributes));
        matchedObservations.set(artist.artist, matching);
        return matching.length > 0;
      }
      const scored = scoreStyleMatch(observations, attributes);
      styleMatches.set(artist.artist, scored);
      // Admission is "this artist shows at least one requested property", not
      // "score is high": the score orders the list, it must not silently drop an
      // artist for a property nobody annotated yet.
      const hits = observations.filter(observation => matchesAnyStyleAttribute(observation, attributes));
      matchedObservations.set(artist.artist, options.strict ? hits.filter(observation => matchesStyleAttributes(observation, attributes)) : hits);
      return options.strict ? hits.some(observation => matchesStyleAttributes(observation, attributes)) : scored.matched > 0;
    }
    if (model && !observations.length && !(artist.exampleModels || artist.examples?.map(item => item.model) || []).includes(model)) return false;
    matchedObservations.set(artist.artist, observations);
    return true;
  });
  // The classification travels as ONE object. It used to be re-listed field by field at every layer
  // (filter → API → client state → render), which is how adding `textTerms` in 1.6.0 came to need
  // six or seven edits with no compiler to catch a missed one — a dropped field fails silently: no
  // error, no visible effect. A single object passes through unopened, so a new classification is
  // added where it is produced and where it is shown, and nowhere in between.
  // Each term type is reported because a typed word must never be silently reinterpreted:
  // `styleTerms` are the properties the query was understood as, `nameTerms` were searched against
  // artist names, `ambiguousTerms` name a controlled value the user must pick, and `textTerms` were
  // answered from an annotation *description* — unreviewed machine prose, which must be shown as
  // 「描述提及」 rather than as a property of the artist.
  
  const report = { unmatchedTerms: result.length ? [] : parsed.terms, styleTerms: describeStyleAttributes(attributes),
    nameTerms: parsed.terms, ambiguousTerms: typed.ambiguousTerms || [], textTerms: [...textTerms] };
  return { artists: result, matchedObservations, styleMatches, ranked, report };
}
