import { EXACT_CHIPS, VIBE_GROUP_ORDER, chipForWord, attributesForChips } from './artist-vibe-chips.js?v=1.6.81';
import { STYLE_FACETS, queryHasStyleTerms } from './artist-catalog.js?v=1.6.81';
import { createArtistResultViewer } from './artist-result.js?v=1.6.81';
import { observeFittedChips } from './artist-chip-layout.js?v=1.6.81';
import { buildNaxV5ArtistSearchUrl } from './artist-index-v5.js?v=1.6.81';
import { modelDisplayName } from './model-utils.js?v=1.6.81';
import { normalizeProviderId } from './provider-route.js?v=1.6.81';
import { confirmAction } from './confirm-sheet.js?v=1.6.81';
import { STYLE_ATTRIBUTES, STYLE_SCHEMA_VERSION, validateStyleAttributes, attributesFromLegacy, legacyFromAttributes, summarizeStyleEvidence } from './artist-style-schema.js?v=1.6.81';

const PAGE_SIZE = 40;
const MAX_COMPARE = 3;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const MODEL_OPTIONS = [
  ['', '全部模型'],
  ['v5', 'V5'],
  ['v4.5', 'V4.5'],
  ['v4', 'V4'],
  ['v3', 'V3'],
  ['original', '原作'],
  ['unknown', '未知']
];
const SOURCE_LABELS = { nax: 'NAX V5', generated: '生成图', original: '原作参考' };
// Byte sizes are read by the user when deciding whether a batch will fit, so they are shown
// in the unit a person can act on rather than as raw bytes.
function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}
const ATTRIBUTE_GROUP_LABELS = { ...Object.fromEntries(STYLE_FACETS.map(facet => [facet.key, facet.label])), composition: '构图', work: '作品类型' };

function cleanText(value, limit = 500) {
  return String(value ?? '').trim().slice(0, limit);
}

function emptyFacets() {
  return Object.fromEntries(STYLE_FACETS.map(facet => [facet.key, []]));
}

export const ARTIST_SORT_OPTIONS = Object.freeze([
  { value: 'default', label: '默认（收藏优先）' },
  { value: 'relevance', label: '画风相关性' },
  { value: 'posts', label: 'D站帖子数' },
  { value: 'danbooru_created', label: 'D站登记时间' },
  { value: 'examples', label: '已存例图数' }
]);

export function normalizeArtistSort(value) {
  const sort = String(value ?? '').trim();
  return ARTIST_SORT_OPTIONS.some(item => item.value === sort) ? sort : 'default';
}

const compactNumber = value => {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return '';
  if (number < 1000) return String(number);
  if (number < 10000) return `${(number / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(number / 1000)}k`;
};

const shortDate = value => {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) return '';
  const date = new Date(number);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

// Facts only: a missing upstream parameter reads as an em dash, never as zero.
export function danbooruStatLine(danbooru) {
  if (!danbooru) return '';
  const parts = [];
  const posts = compactNumber(danbooru.postCount);
  if (posts) parts.push(`D站 ${posts} 帖`);
  const registered = shortDate(danbooru.createdAt);
  if (registered) parts.push(`登记 ${registered}`);
  return parts.join(' · ');
}

export function danbooruStatsDetail(danbooru) {
  const homepages = Array.isArray(danbooru?.homepages) ? danbooru.homepages.filter(value => typeof value === 'string') : [];
  return {
    posts: compactNumber(danbooru?.postCount) || '未同步',
    registered: shortDate(danbooru?.createdAt) || '未同步',
    updated: shortDate(danbooru?.updatedAt) || '未同步',
    homepages,
    synced: Number(danbooru?.syncedAt) > 0
  };
}

// A verified upstream verdict is stated plainly, so an empty artist reads as a
// confirmed fact rather than an unfinished job. Unverified states stay silent.
const DANBOORU_STATUS_LABELS = {
  banned: 'D 站已封禁 · 无法获取例图',
  deleted: 'D 站记录已删除',
  absent: 'D 站查无此画师',
  unqueryable: '名称无法用于 D 站查询',
  'no-eligible-work': '暂无符合条件的单画师静图',
  'multi-artist-only': '作品均为多画师合作',
  'no-posts': 'D 站暂无有效作品'
};

export function danbooruStatusLabel(status) {
  if (!status || typeof status !== 'object') return '';
  // The reader gets a plain sentence; the raw reason counter stays in the data
  // for diagnosis and is deliberately not surfaced as an English code.
  return DANBOORU_STATUS_LABELS[status.status] || '';
}

// Pending work on the coverage line is "can still be collected". Confirmed takedowns
// and artists with a stored unfillable verdict are stated separately, so they cannot
// keep looking like a backlog.

export function coverageProgress(summary = {}) {
  const count = value => Math.max(0, Number(value) || 0);
  const availability = summary.availability || {};
  const gone = count(availability.confirmedGone);
  const blocked = count(availability.noEligibleWork);
  return {
    remaining: Math.max(0, count(summary.artistsWithoutExamples) - gone - blocked),
    gone,
    blocked,
    total: count(summary.totalArtists)
  };
}

export function danbooruSyncMessage(stats = {}) {  const parts = [];
  const synced = Number(stats.synced) || 0;
  const missing = Number(stats.missing) || 0;
  const skipped = Number(stats.skipped) || 0;
  if (synced) parts.push(`已更新 ${synced} 位画师参数`);
  if (missing) parts.push(`${missing} 位在 D 站已无可用记录`);
  if (skipped) parts.push(`${skipped} 位缺少上游编号，未改动`);
  if (!parts.length) parts.push('没有需要更新的画师参数');
  return `${parts.join('，')}。`;
}

export function createLibraryState() {
  return {
    view: 'list',
    selectedArtist: '',
    // vibe: chip ids from the style index, "-id" = avoid. like: an artist whose style to match.
    filters: { query: '', facets: emptyFacets(), attributes: {}, model: '', favorite: false, annotated: false, includeAutomatic: true, confirmedOnly: false, sort: 'default', vibe: [], like: '', exact: false },
    vibePanelOpen: false,
    // The sort control is switched to 画风相关性 automatically while the user has not
    // chosen a sort themselves, and stops doing so the moment they do — an automatic
    // choice must never override an explicit one.
    sortTouched: false,
    // mean = average of the seven blocks (original); worst = the furthest single block.
    // Both read the same stored vectors, so switching is free and reversible.
    similarRule: 'mean',
    page: 1,
    compareArtists: [],
    list: [],
    total: 0,
    // How the query was understood travels as one object so nothing has to re-list its fields in
    // transit. `queryReportFrom` below is the only place that names them on the reading side.
    report: queryReportFrom(null),
    facetPanelOpen: null,
    refinedPanelOpen: false,
    auxiliaryPanelOpen: false
  };
}

// How a query was understood, normalised once. This is the projection boundary: the wire format is
// one nested object and this is the only function that names its keys, so a new term type cannot be
// half-adopted — it is either here or nowhere, rather than "read in three places and forgotten in a
// fourth". The lookups are defensive because the payload crosses a network boundary.
export function queryReportFrom(payload) {
  const text = value => (Array.isArray(value) ? value.map(term => cleanText(term, 160)).filter(Boolean) : []);
  const report = payload && typeof payload === 'object' && payload.report && typeof payload.report === 'object' ? payload.report : {};
  return {
    unmatchedTerms: text(report.unmatchedTerms),
    nameTerms: text(report.nameTerms),
    ambiguousTerms: text(report.ambiguousTerms),
    textTerms: text(report.textTerms),
    styleTerms: Array.isArray(report.styleTerms)
      ? report.styleTerms.filter(item => item && typeof item.label === 'string' && item.label).slice(0, 12)
        .map(item => ({ key: cleanText(item.key, 60), value: cleanText(item.value, 60), label: cleanText(item.label, 60) }))
      : []
  };
}

// Whether anything narrows the list (sort only orders it); 清除筛选 shows only then.
export function libraryFiltersActive(filters = {}) {
  return Boolean(filters.query || filters.model || filters.favorite || filters.annotated || filters.confirmedOnly || filters.vibe?.length || filters.like
    || countSelectedFacets(filters.facets) || Object.values(filters.attributes || {}).some(values => Array.isArray(values) && values.length));
}

const filterGroupLabel = (label, count) => (count ? `${label} · ${count}` : label);
// What the 筛选 panel holds (the search line and the model / sort / 收藏 row show their own state).
// The 画风 toggle counts every choice inside its panel: vibe chips, "像…", annotation values (label chips
// and the old grids share them, so each is counted once) and the two annotation scopes.
const filterPanelLabel = filters => filterGroupLabel('✦ 画风', (filters.vibe?.length || 0) + (filters.like ? 1 : 0)
  + Object.values(filters.attributes || {}).reduce((sum, values) => sum + (Array.isArray(values) ? values.length : 0), 0)
  + (filters.annotated ? 1 : 0) + (filters.confirmedOnly ? 1 : 0));

export function countSelectedFacets(facets = {}) {
  return Object.values(facets).reduce((total, values) => total + (Array.isArray(values) ? values.length : 0), 0);
}

export function shouldApplyProfileUpdate(state, expectedArtist) {
  return state?.view === 'detail' && state.selectedArtist === expectedArtist;
}

export function setLibraryView(state, view, artist = '') {
  state.view = view;
  state.selectedArtist = view === 'detail' ? cleanText(artist, 160) : '';
  return state;
}

export function toggleComparison(state, artist) {
  const name = cleanText(artist, 160);
  if (!name) return false;
  const index = state.compareArtists.indexOf(name);
  if (index >= 0) {
    state.compareArtists.splice(index, 1);
    return true;
  }
  if (state.compareArtists.length >= MAX_COMPARE) return false;
  state.compareArtists.push(name);
  return true;
}

export function parseArtistPage(value, pages) {
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value).trim())) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 && page <= pages ? page : null;
}

export function buildArtistListUrl(filters = {}, page = 1, limit = PAGE_SIZE) {
  const params = new URLSearchParams();
  const query = cleanText(filters.query, 300);
  const facets = Object.fromEntries(Object.entries(filters.facets || {}).filter(([, values]) => Array.isArray(values) && values.length));
  const exactExtra = attributesForChips(Array.isArray(filters.vibe) ? filters.vibe : [], [], filters.exact === true);
  const merged = { ...(filters.attributes || {}) };
  for (const [key, values] of Object.entries(exactExtra)) merged[key] = [...new Set([...(merged[key] || []), ...values])];
  const attributes = validateStyleAttributes(merged);
  if (query) params.set('query', query);
  if (Object.keys(facets).length) params.set('facets', JSON.stringify(facets));
  if (Object.keys(attributes).length) params.set('attributes', JSON.stringify(attributes));
  if (filters.model) params.set('model', cleanText(filters.model, 20));
  if (filters.favorite) params.set('favorite', '1');
  if (filters.annotated) params.set('annotated', '1');
  params.set('includeAutomatic', filters.includeAutomatic === false ? '0' : '1');
  if (filters.confirmedOnly) params.set('confirmedOnly', '1');
  const vibe = (Array.isArray(filters.vibe) ? filters.vibe : []).filter(token => /^-?[a-z0-9]{1,24}$/.test(token)).slice(0, 12);
  if (vibe.length) params.set('vibe', vibe.join(','));
  if (filters.like) params.set('like', cleanText(filters.like, 160));
  const sort = normalizeArtistSort(filters.sort);
  if (sort !== 'default') params.set('sort', sort);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || PAGE_SIZE));
  const safePage = parseArtistPage(page, Number.MAX_SAFE_INTEGER) || 1;
  params.set('offset', String((safePage - 1) * safeLimit));
  params.set('limit', String(safeLimit));
  return `/api/artists?${params.toString()}`;
}

export function createLatestRequestGate() {
  let revision = 0;
  return {
    begin() { revision += 1; return revision; },
    isCurrent(token) { return token === revision; },
    cancel() { revision += 1; }
  };
}

export function createSingleFlight(operation) {
  let current = null;
  return (...args) => {
    if (current) return current;
    try {
      current = Promise.resolve(operation(...args));
    } catch (error) {
      current = Promise.reject(error);
    }
    const request = current.finally(() => {
      if (current === request) current = null;
    });
    current = request;
    return request;
  };
}

export function createKeyedSingleFlight() {
  let activeKey = '';
  let current = null;
  return {
    run(key, operation) {
      const normalizedKey = cleanText(key, 300);
      if (current) {
        if (normalizedKey === activeKey) return current;
        return Promise.reject(Object.assign(new Error('另一项资料保存正在进行，请稍候。'), { code: 'ARTIST_LIBRARY_BUSY' }));
      }
      activeKey = normalizedKey;
      try {
        current = Promise.resolve(operation());
      } catch (error) {
        current = Promise.reject(error);
      }
      const request = current.finally(() => {
        if (current === request) {
          current = null;
          activeKey = '';
        }
      });
      current = request;
      return request;
    },
    isBusy() { return Boolean(current); }
  };
}

export function normalizeGalleryResponse(data) {
  if (!Array.isArray(data?.images)) return [];
  return data.images.filter(image => image && cleanText(image.id, 160));
}

export function groupExamplesBySource(examples) {
  const groups = { nax: [], generated: [], original: [] };
  for (const example of Array.isArray(examples) ? examples : []) {
    const source = example?.sourceType === 'nax' || example?.sourceType === 'original' ? example.sourceType : 'generated';
    groups[source].push(example);
  }
  return groups;
}

export function comparisonExamples(profile, limit = 3) {
  const examples = Array.isArray(profile?.examples) ? profile.examples : [];
  const groups = groupExamplesBySource(examples);
  const selected = ['nax', 'generated', 'original'].map(source => groups[source][0]).filter(Boolean);
  for (const example of examples) {
    if (selected.length >= limit) break;
    if (!selected.includes(example)) selected.push(example);
  }
  return selected.slice(0, Math.max(0, limit));
}

export function safeSourceLink(value) {
  try {
    const url = new URL(cleanText(value, 2000));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

export function parseAliases(value) {
  const aliases = [...new Set(String(value || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean))];
  if (aliases.length > 12) throw new Error('最多设置 12 个别名。');
  if (aliases.some(alias => alias.length > 100)) throw new Error('每个别名不能超过 100 个字符。');
  return aliases;
}

export function syncComparisonControls(root, state) {
  for (const control of root?.querySelectorAll?.('[data-artist-compare]') || []) {
    const selected = state.compareArtists.includes(control.dataset.artistCompare);
    control.textContent = selected ? '取消对比' : '加入对比';
    control.setAttribute('aria-pressed', selected ? 'true' : 'false');
  }
}

export function diffProfileExamples(previousProfile, nextProfile) {
  const previous = Array.isArray(previousProfile?.examples) ? previousProfile.examples : [];
  const next = Array.isArray(nextProfile?.examples) ? nextProfile.examples : [];
  const previousIds = new Set(previous.map(example => example?.id).filter(Boolean));
  const nextIds = new Set(next.map(example => example?.id).filter(Boolean));
  return {
    added: next.filter(example => example?.id && !previousIds.has(example.id)),
    removedIds: previous.filter(example => example?.id && !nextIds.has(example.id)).map(example => example.id)
  };
}

export function summarizeExampleMetadata(example) {
  const metadata = example?.metadata && typeof example.metadata === 'object' ? example.metadata : {};
  const lines = [];
  const actualModel = cleanText(metadata.actualModel || metadata.model, 160);
  const editorModel = cleanText(metadata.editorModel, 160);
  if (actualModel) lines.push(`实际生成模型：${actualModel}`);
  if (editorModel && editorModel !== actualModel) lines.push(`编辑器模型：${editorModel}`);
  if (metadata.seed !== undefined && metadata.seed !== null && String(metadata.seed) !== '') lines.push(`Seed ${metadata.seed}`);
  const artists = Array.isArray(metadata.artists) ? metadata.artists.map(item => {
    const name = cleanText(item?.artist || item?.name, 160);
    if (!name) return '';
    const rawWeight = item?.weight;
    const weight = rawWeight !== undefined && rawWeight !== null && rawWeight !== '' && Number.isFinite(Number(rawWeight))
      ? ` ×${Number(rawWeight).toFixed(2).replace(/\.?0+$/, '')}` : '';
    return `${name}${weight}`;
  }).filter(Boolean) : [];
  if (artists.length) lines.push(`识别到的画师：${artists.join(' · ')}`);
  if (metadata.artistAttributionComplete === false && artists.length) lines.push('混合样本：可能还有未识别画师');
  if (metadata.parametersKnown === false || (example?.sourceType === 'nax' && !lines.length)) lines.push('参数：未知（NAX 未提供）');
  return lines;
}

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.type) node.type = options.type;
  if (options.name) node.name = options.name;
  if (options.value !== undefined) node.value = String(options.value);
  if (options.title) node.title = options.title;
  if (options.hidden) node.hidden = true;
  if (options.disabled) node.disabled = true;
  if (options.checked !== undefined) node.checked = Boolean(options.checked);
  if (options.attrs) for (const [key, value] of Object.entries(options.attrs)) node.setAttribute(key, String(value));
  for (const child of Array.isArray(children) ? children : [children]) if (child) node.append(child);
  return node;
}

// 以图找 was retired by the owner (1.6.62): its 40-dim colour/tone signature cannot see drawing
// style, so its matches were not useful. The panel and the server index stay dormant until a real
// style backend exists; with this off, no entry point (search box, example menu) is shown.

const SIMILAR_SEARCH_ENABLED = false;
// 加入对比 was retired by the owner (1.6.66): most artists hold one or two examples, so a
// side-by-side view had nothing to compare. With this off no 加入对比 control is built
// (cards, detail toolbar), so the tray and the comparison view are unreachable; their code
// stays dormant rather than being cut out of the detail navigation it is woven into.
const COMPARE_ENABLED = false;

function button(text, className = 'ghost', attrs = {}) {
  return el('button', { text, type: 'button', className, attrs });
}

// External reference link styled like a toolbar button.
function linkButton(text, href, className = 'ghost', attrs = {}) {
  return el('a', { className, text, attrs: { href, target: '_blank', rel: 'noopener noreferrer', ...attrs } });
}

function safeApiImageUrl(value) {
  const url = cleanText(value, 1000);
  return /^\/api\/(?:artists\/examples|images)\//.test(url) || /^\/api\/artists\/resources\/image\?/.test(url) ? url : '';
}

function imageNode(url, alt, className = '') {
  const safeUrl = safeApiImageUrl(url);
  if (!safeUrl) return el('div', { className: `${className} artist-library-image-placeholder`, text: '暂无例图' });
  // The local app answers /api/ in-process, which an <img> request cannot reach; it supplies a
  // loader that fetches visible images through its API instead.
  const load = globalThis.NAI_RUNTIME?.loadImage;
  if (typeof load === 'function') {
    const image = el('img', { className, attrs: { alt: cleanText(alt, 220), decoding: 'async' } });
    load(image, safeUrl);
    return image;
  }
  return el('img', {
    className,
    attrs: { src: safeUrl, alt: cleanText(alt, 220), loading: 'lazy', decoding: 'async', referrerpolicy: 'same-origin' }
  });
}

// A picture that exists only in this browser: the object URL made from a File the owner just
// picked. `imageNode` cannot render it — `safeApiImageUrl` deliberately allows only
// server-relative /api/... paths, so that a value coming back from the API can never be
// turned into an arbitrary URL. That guard is right and must NOT be loosened for this case;
// the blob's provenance is known here instead, and CSP already permits `img-src blob:`.
function localImageNode(url, alt, className = '') {
  return el('img', {
    className,
    attrs: { src: url, alt: cleanText(alt, 220), decoding: 'async', referrerpolicy: 'same-origin' }
  });
}

function checkboxLabel(text, checked = false) {
  const input = el('input', { type: 'checkbox', checked });
  return { label: el('label', { className: 'artist-library-check' }, [input, el('span', { text })]), input };
}

function facetLabels(facets = {}) {
  const result = [];
  for (const facet of STYLE_FACETS) {
    const options = new Map(facet.options.map(option => [option.value, option.label]));
    for (const value of facets[facet.key] || []) {
      if (options.has(value)) result.push(`${facet.label} · ${options.get(value)}`);
    }
  }
  return result;
}

function attributesForObservation(observation = {}) {
  return validateStyleAttributes({ ...attributesFromLegacy(observation.facets), ...(observation.attributes || {}) });
}

function attributeLabels(attributes = {}) {
  return STYLE_ATTRIBUTES.flatMap(definition => definition.options
    .filter(option => attributes[definition.key]?.includes(option.value))
    .map(option => `${definition.label} · ${option.label}`));
}

function evidenceSourceLabel(source) {
  return ({ manual: '人工确认', 'assistant-visual': '视觉初标', 'deepseek-visual': 'DeepSeek 初标', 'danbooru-tags': 'D 站标签' })[source] || cleanText(source, 60);
}

function readAttributeForm(form, prefix) {
  const data = new FormData(form);
  return validateStyleAttributes(Object.fromEntries(STYLE_ATTRIBUTES.map(definition => [definition.key, data.getAll(`${prefix}${definition.key}`).filter(Boolean)])));
}

function attributeFieldset(definition, selected, prefix, { disabled = false, onSelectionChange } = {}) {
  const fieldset = el('div', { className: 'artist-library-attribute-field', attrs: { role: 'group', 'aria-label': definition.label, 'data-style-attribute': definition.key } });
  fieldset.append(el('span', { className: 'artist-library-attribute-name', text: definition.label }));
  const help = el('details', { className: 'artist-library-attribute-help' });
  help.append(el('summary', { text: '?', attrs: { 'aria-label': `${definition.label}的判定依据` } }), el('p', { text: `${definition.definition} 再点已选项可取消；全部取消表示${prefix === 'attribute-' ? '不限' : '未判断'}。` }));
  const options = el('div', { className: 'artist-library-attribute-options' });
  for (const option of definition.options) {
    const item = checkboxLabel(option.label, selected.includes(option.value));
    item.label.className += ' artist-library-option'; item.label.dataset.styleValue = option.value;
    item.input.name = `${prefix}${definition.key}`;
    item.input.value = option.value;
    item.input.disabled = disabled;
    item.input.addEventListener('change', () => onSelectionChange?.());
    options.append(item.label);
  }
  fieldset.append(options, help);
  return fieldset;
}

export function facetLabelsForExample(profile, exampleId = '') {
  const labels = new Set();
  for (const observation of profile?.observations || []) {
    if (observation?.reviewed !== true) continue;
    if (exampleId && observation.exampleId !== exampleId) continue;
    facetLabels(observation.facets).forEach(label => labels.add(label));
  }
  return [...labels];
}

function facetEvidenceForExample(profile, exampleId = '', confirmedOnly = false) {
  const evidence = new Map();
  const observations = Array.isArray(profile?.observations) ? profile.observations : [];
  const reviewedExamples = new Set(observations.filter(item => item?.reviewed === true).map(item => item.exampleId));
  for (const observation of observations) {
    if (exampleId && observation?.exampleId !== exampleId) continue;
    const automatic = observation?.reviewed !== true && observation?.automatic === true;
    if (observation?.reviewed !== true && (!automatic || confirmedOnly || reviewedExamples.has(observation.exampleId))) continue;
    for (const label of attributeLabels(attributesForObservation(observation))) {
      if (!evidence.has(label) || !automatic) evidence.set(label, { label, automatic, visual: ['assistant-visual', 'deepseek-visual'].includes(observation.source) });
    }
  }
  return [...evidence.values()];
}

function errorMessage(error, fallback = '操作失败，请稍后重试。') {
  if (error?.code === 'ARTIST_LIBRARY_RESET') return '';
  return cleanText(error?.message || error, 300) || fallback;
}

function friendlyModel(value) {
  return MODEL_OPTIONS.find(([model]) => model === value)?.[1] || cleanText(value, 30) || '未知';
}

export function createArtistLibrary({ api, toast, addArtist, previewArtist, isReadOnly, canManage, mount, onNavigate, mountAutomation, onAnnotateExample, captureRotationState, rotationRoute: resolveRotationRoute } = {}) {
  if (typeof api !== 'function') throw new TypeError('createArtistLibrary requires api(url, options).');
  const parentToast = typeof toast === 'function' ? toast : () => {};
  const addToPrompt = typeof addArtist === 'function' ? addArtist : () => {};
  const preview = typeof previewArtist === 'function' ? previewArtist : () => {};
  const readOnly = typeof isReadOnly === 'function' ? isReadOnly : () => false;
  // Personal actions (favourite, note, 加入画风) follow readOnly. Library management (collection,
  // annotation, rotation, covers, uploads, stats) also needs canManage; omitted, it equals !readOnly,
  // so the server site is unchanged. The local app passes canManage: () => false.
  const manageable = typeof canManage === 'function' ? canManage : () => true;
  const manageLocked = () => Boolean(readOnly()) || !manageable();
  const navigate = typeof onNavigate === 'function' ? onNavigate : () => {};
  const embedded = Boolean(mount);
  const externalAutomation = typeof mountAutomation === 'function';
  let sessionRevision = 0;
  const requestApi = api;
  api = async (...args) => {
    const revision = sessionRevision;
    try {
      const result = await requestApi(...args);
      if (revision === sessionRevision) return result;
    } catch (error) {
      if (revision === sessionRevision) throw error;
    }
    throw Object.assign(new Error(''), { name: 'AbortError', code: 'ARTIST_LIBRARY_RESET' });
  };
  const state = createLibraryState();
  const gates = { list: createLatestRequestGate(), detail: createLatestRequestGate(), compare: createLatestRequestGate(), gallery: createLatestRequestGate() };
  const controllers = new Map();
  let dialog = null;
  let body = null;
  let title = null;
  let roleBadge = null;
  let localStatus = null;
  let localStatusTimer = 0;
  let compareTray = null;
  let activeProfile = null;
  let comparisonDetail = null;
  // 打开画师详情时，列表那一整棵树被留在这里，而不是被丢掉重建：返回时原位放回，
  // 所以滚动、筛选表单的取值与草稿、页码和焦点都不经过第二次请求就能完全恢复。
  // 机制与 comparisonDetail 保存详情节点的做法相同，只是方向相反。
  let listDetailReturn = null;
  // 详情是从「找相似画师」面板里点进去的：返回时那一批结果要跟着回来，所以这个标记记着
  // 「现在这一层详情是面板给的」。面板本体在关闭期间一直留在 DOM 里（makePanel 只建一次，
  // 结果块只在首次构建或「清除参考图」时重写），实测重新弹出它不会重新比对：参考图与结果
  // 列表原样还在。所以「放回面板」就是重新弹出它，不需要恢复任何东西。
  let similarReturnPending = false;
  // Note: 这个标记只由面板结果点击设置、由 returnToList() 一次性消费，切标签页与「关闭」按钮都要清它，
  
  let active = false;
  let navigating = false;
  let entryRevision = 0, entryPending = null;
  let listScroll = 0;
  let scrollRevision = 0;
  let ingestionHost = null;
  let ingestionStatus = null;
  let ingestionError = '';
  let ingestionTimer = 0;
  let ingestionController = null;
  let ingestionBusy = false;
  let coverageHost, overviewBar, overviewActionsBar, manageToggle, taskPanel, rotationPanelInstance, naxMirrorPanelInstance, similarPanelInstance, similarActionButton = null, taskSummary, summaryRevision = 0, summaryController;
  let filterTimer = 0, listPending = false, renderedListSignature = '', coverageSignature = '';
  const chipLayouts = new Map();
  function pruneChipLayouts() {
    for (const [container, dispose] of chipLayouts) if (!container.isConnected) { dispose(); chipLayouts.delete(container); }
  }
  const ingestionGate = createLatestRequestGate();
  const runMutation = createKeyedSingleFlight();
  const resultViewer = createArtistResultViewer({ api, onProfile: acceptUpdatedProfile, canEdit: () => !manageLocked(), onEdit: async (artist, id) => {
    if (manageLocked()) return;
    await open(artist); await refresh();
    const panel = [...body.querySelectorAll('[data-annotation-panel]')].find(node => node.dataset.annotationPanel === id);
    if (panel) openPanel(panel); else notify('这张例图已移除。', 'error');
  }, onLocate: async (artist, id) => {
    await open(artist); await refresh();
    const card = [...body.querySelectorAll('[data-example-id]')].find(node => node.dataset.exampleId === id);
    if (!card) { notify('这张例图已移除。', 'error'); return; }
    card.setAttribute('tabindex', '-1'); card.focus?.({ preventScroll: true }); card.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  } });

  // 面板是模态的：一打开，顶层 ::backdrop 就吃掉整页的指针事件；而面板挂在画师 Tab 里面，
  // 祖先一旦 display:none，它自己就成了 0×0（实测 rect 0×0、checkVisibility 假、
  // elementFromPoint 落到 <html>）。屏幕上空无一物，整页却点不动 —— owner 报的「卡死」正是
  // 这一种：点击之后才姗姗来迟的续作把面板弹进了一个已经切走的 Tab，而没有任何可见的关闭入口。
  // 所以「宿主此刻在不在屏幕上」是弹出面板的硬前提，并且有两条入口要各守一次：迟到的续作不许
  // 弹出（openPanel），已经在顶层里的面板只要宿主被隐藏就立刻收回（retireHiddenPanels）。
  function hostOnScreen() {
    if (!dialog?.isConnected) return false;
    const tab = dialog.closest('.tab-panel');
    return !dialog.closest('[hidden], .hidden') && (!tab || tab.matches('.active'));
  }
  function retireHiddenPanels() {
    if (hostOnScreen()) return;
    // 宿主被隐藏（切标签页）同样是一次离开：留着标记，返回时那一下就会在别的标签页上弹面板，
    // 比原来的缺陷更糟。收回面板的同时把标记也作废。
    similarReturnPending = false;
    for (const panel of dialog.querySelectorAll('dialog.artist-library-panel')) if (panel.open) panel.close();
  }
  function openPanel(panel) {
    // 库的 dialog 由 ensureDialog 建出来，而它只在 open()/show() 里跑；openPanel 现在有多个
    // 调用者，谁抢在库之前调用，以前是在 null 上 querySelectorAll 抛 TypeError（库没建好就
    // 弹出面板），现在和下面「宿主不在屏幕上」一样安静地拒绝。
    if (!dialog) return;
    for (const other of dialog.querySelectorAll('dialog.artist-library-panel')) if (other !== panel && other.open) other.close();
    if (!panel?.isConnected || !hostOnScreen()) return;
    // A panel that mirrors live data (progress, coverage) rebuilds itself before it is
    // shown, so it cannot present numbers captured when the library was first opened.
    panel.onBeforeOpen?.();
    if (!panel.open) panel.showModal();
  }
  function makePanel(name, content, key) {
    const panel = el('dialog', { className: 'artist-library-panel', attrs: { 'aria-label': name, 'data-artist-panel': key } });
    const dismiss = button('关闭', 'ghost'); dismiss.addEventListener('click', () => panel.close());
    const header = el('header', { className: 'artist-library-panel-header' }, [el('strong', { text: name }), dismiss]);
    // Content may be a factory: a panel that mirrors live data is rebuilt on each
    // open instead of being frozen at render time.
    const host = el('div', { className: 'artist-library-panel-body' });
    const fill = () => {
      host.replaceChildren();
      const value = typeof content === 'function' ? content() : content;
      if (value) host.append(value);
    };
    if (typeof content !== 'function') host.append(content);
    panel.refresh = fill;
    panel.append(header, el('div', { className: 'artist-library-panel-status', hidden: true, attrs: { role: 'status' } }), host);
    panel.addEventListener('cancel', event => { event.preventDefault(); panel.close(); });
    return panel;
  }
  function closeDetailPanels() {
    for (const panel of body?.querySelectorAll('dialog.artist-library-panel') || []) if (panel.open) panel.close();
  }
  function openResult(selection) {
    if (taskPanel?.open) taskPanel.close();
    closeDetailPanels();
    return resultViewer.open(selection);
  }
  async function refreshSummary() {
    if (!isOpen()) return;
    const token = ++summaryRevision; summaryController?.abort(); summaryController = new AbortController();
    try {
      const data = await api('/api/artists/summary', { signal: summaryController.signal });
      if (token !== summaryRevision || !isOpen()) return;
      const summary = data.summary;
      if (!summary) return;
      const signature = JSON.stringify(summary); if (signature === coverageSignature) return; coverageSignature = signature;
      const count = value => Math.max(0, Number(value) || 0);
      const { remaining, gone, blocked, total } = coverageProgress(summary);
      // The explanation is wrapped in ONE panel element. The shared
      // `.artist-library-attribute-help > p` rule absolutely positions every direct <p> at the
      // same top/right, which is right for a control with a single paragraph but stacked all
      // three of these on top of each other — measured as identical geometry (l/t/b equal)
      // with 11440px² of pairwise overlap, so the text rendered as garbled overlapping lines
      // and looked like it was spilling out of the box. Wrapping them means the panel is the
      // positioned element and the paragraphs flow normally inside it; the `<p>`s are no
      // longer direct children, so the shared rule no longer reaches them either.
      const help = el('details', { className: 'artist-library-coverage-help artist-library-attribute-help' }, [
        el('summary', { text: '?', attrs: { 'aria-label': '全库统计说明' } }),
        el('div', { className: 'artist-library-coverage-help-panel', attrs: { 'data-coverage-help-panel': 'true' } }, [
          el('p', { text: `统计全库，不随当前筛选变化。未标注 ${count(summary.unannotatedExamples)} 张，已处理但未判断 ${count(summary.unjudgedExamples)} 张；后者不会自动重试。` }),
          Number(summary.sampleExamples) > 0
            ? el('p', { text: `例图样本 ${count(summary.sampleExamples)} 张不计入标注统计：它们由同一基准 Prompt 批量生成，只有画师 Tag 不同，标签彼此近乎重复。` })
            : null,
          el('p', { text: (() => {
            const parts = [];
            if (gone) parts.push(`${gone} 位经 D 站核查已确认无法获取（封禁、记录删除或查无此名）`);
            if (blocked) parts.push(`${blocked} 位暂无合格静图（合作、无缩略图或名称无法查询）`);
            return parts.length ? `${parts.join('；')}，不计入待补。` : '尚无画师通过 D 站核查；核查后会标注确认无法获取的条目。';
          })() })
        ].filter(Boolean))
      ]);
      // Nulls are filtered before replaceChildren: the DOM would otherwise render
      // a literal "null" text node for each one.
      // Each fact is label + number + unit in separate spans, so a layout can set the number
      // apart; the text (what screen readers and tests read) is unchanged: 「待补例图 8 / 4072 位」.
      const fact = (label, number, unit, options = {}) => el('span', options, [
        el('span', { className: 'coverage-label', text: `${label} ` }), el('b', { text: String(number) }), el('span', { className: 'coverage-unit', text: unit })
      ]);
      const facts = [
        fact('待补例图', remaining, ` / ${total} 位`, { className: 'artist-library-coverage-pending', attrs: { 'data-coverage-artists': 'true' } }),
        gone ? fact('已确认无法获取', gone, ' 位', { className: 'artist-library-coverage-gone', attrs: { 'data-coverage-gone': 'true', title: 'D 站已封禁、已删除或查无此名；已核实并保留记录' } }) : null,
        blocked ? fact('暂无合格静图', blocked, ' 位', { className: 'artist-library-coverage-blocked', attrs: { 'data-coverage-blocked': 'true', title: '已核查：合作图、匿名无 720 缩略图、无可见帖或名称无法作为 D 站标签查询' } }) : null,
        fact('待补标签', count(summary.examplesWithoutTags), ` / ${count(summary.totalExamples)} 张`, { attrs: {
          title: `只统计正式例图（不含例图样本）：未标注 ${count(summary.unannotatedExamples)} 张 · 已处理但未判断 ${count(summary.unjudgedExamples)} 张；后者不会自动重试` } }),
        // Samples are stated rather than silently dropped, so the smaller backlog is not
        // mistaken for lost examples.
        Number(summary.sampleExamples) > 0
          ? fact('例图样本', count(summary.sampleExamples), ' 张另计', { attrs: { 'data-coverage-samples': 'true', title: '批量生成的例图样本不参与标注统计：它们共用同一基准 Prompt，标签彼此近乎重复' } })
          : null
      ].filter(Boolean);
      // The "?" CLOSES the line, and is bound to the last fact so it can never sit alone.
      //
      // It was briefly placed first, to make orphaning impossible. That was worse for two
      // reasons: a lone "?" at the start reads as a bullet marker rather than a control, and
      // — functionally — its popover is anchored `right: 0`, so a leading control opened the
      // panel leftward past the viewport edge and it was clipped. Trailing, `right: 0` grows
      // the panel leftward across the facts, which is the behaviour it was written for.
      //
      // Orphaning is instead prevented by grouping: the tail is an inline-flex with the
      // default `flex-wrap: nowrap`, so the last fact and the control wrap as one unit.
      const ratio = (done, all) => `${Math.round(Math.max(0, Math.min(1, all ? done / all : 0)) * 100)}%`;
      facts[0]?.style.setProperty('--done', ratio(total - remaining, total));
      facts.find(node => node.textContent.startsWith('待补标签'))?.style.setProperty('--done', ratio(count(summary.totalExamples) - count(summary.examplesWithoutTags), count(summary.totalExamples)));
      const last = facts.pop();
      const tail = last ? el('span', { className: 'artist-library-coverage-tail' }, [last, help]) : help;
      coverageHost.replaceChildren(...facts, tail);
    } catch (error) { if (token === summaryRevision && error.name !== 'AbortError') { coverageSignature = ''; coverageHost.textContent = '统计暂不可用'; } }
  }

  function notify(message, type = '') {
    const text = cleanText(message, 500);
    if (!text) return;
    parentToast(text, type);
    if (!localStatus) return;
    clearTimeout(localStatusTimer);
    localStatus.textContent = text;
    localStatus.className = `artist-library-local-status${type === 'error' ? ' is-error' : ' is-success'}`;
    localStatus.setAttribute('role', type === 'error' ? 'alert' : 'status');
    localStatus.hidden = false;
    const panelStatus = [...dialog.querySelectorAll('.artist-library-panel')].find(panel => panel.open)?.querySelector('.artist-library-panel-status');
    if (panelStatus) {
      panelStatus.textContent = text; panelStatus.hidden = false;
      panelStatus.className = `artist-library-panel-status${type === 'error' ? ' is-error' : ''}`;
      panelStatus.setAttribute('role', type === 'error' ? 'alert' : 'status');
    }
    localStatusTimer = setTimeout(() => {
      if (localStatus) localStatus.hidden = true;
      if (panelStatus) panelStatus.hidden = true;
    }, type === 'error' ? 6500 : 4000);
  }

  function startRequest(key) {
    controllers.get(key)?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) controllers.set(key, controller);
    return { token: gates[key].begin(), signal: controller?.signal };
  }

  function finishRequest(key, controllerSignal) {
    if (controllers.get(key)?.signal === controllerSignal) controllers.delete(key);
  }

  function cancelRequestsExcept(activeKey = '') {
    for (const key of Object.keys(gates)) {
      if (key === activeKey) continue;
      gates[key].cancel();
      controllers.get(key)?.abort();
      controllers.delete(key);
    }
  }

  function invalidateRequests() {
    Object.values(gates).forEach(gate => gate.cancel());
    controllers.forEach(controller => controller.abort());
    controllers.clear();
  }

  function ensureDialog() {
    if (dialog?.isConnected) return;
    const target = typeof mount === 'string' ? document.querySelector(mount) : mount;
    if (embedded && typeof target?.append !== 'function') throw new TypeError('Artist library mount was not found.');
    dialog = el(embedded ? 'section' : 'dialog', {
      className: embedded ? 'artist-library-page' : 'artist-library-modal', attrs: { 'aria-labelledby': 'artistLibraryTitle' }
    });
    const header = el('header', { className: 'artist-library-header' });
    const heading = el('div', { className: 'artist-library-heading' });
    title = el(embedded ? 'h1' : 'strong', { text: '画师资料库', attrs: { id: 'artistLibraryTitle', tabindex: '-1' } });
    roleBadge = el('span', { className: 'artist-library-role-badge' });
    heading.append(title);
    header.append(heading, roleBadge);
    if (!embedded) {
      const closeButton = button('×', 'artist-library-close', { 'aria-label': '关闭画师资料库' });
      closeButton.addEventListener('click', close);
      header.append(closeButton);
    }
    localStatus = el('div', {
      className: 'artist-library-local-status', hidden: true,
      attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }
    });
    body = el('div', { className: 'artist-library-body' });
    ingestionHost = el('section', { className: 'artist-library-ingestion', hidden: true, attrs: { 'aria-label': '原作采集进度' } });
    compareTray = el('footer', { className: 'artist-library-compare-tray' });
    coverageHost = el('div', { className: 'artist-library-coverage', attrs: { 'data-library-coverage': 'true', 'aria-label': '全库补齐进度' } });
    taskSummary = el('span', { className: 'artist-library-task-summary' });
    const tasks = button('画师任务', 'ghost', { 'data-open-artist-tasks': 'true' });
    tasks.hidden = manageLocked(); tasks.append(taskSummary);
    taskPanel = makePanel('画师任务', ingestionHost, 'tasks');
    tasks.addEventListener('click', () => openPanel(taskPanel));
    // Artist sample generation is a whole-library batch as well as a per-artist
    // action, so the panel lives at page level beside the task panel rather than
    // inside one artist's detail page. One instance, opened from here and from the
    // artist detail action.
    rotationPanelInstance = makePanel('画师例图生成', rotationPanel(), 'rotation');
    const rotationBody = rotationPanelInstance.querySelector('.artist-library-rotation');
    if (rotationBody?.reload) rotationPanelInstance.onBeforeOpen = () => rotationBody.reload();
    const rotation = button('例图生成', 'ghost', { 'data-open-artist-rotation': 'true' });
    rotation.hidden = manageLocked();
    rotation.addEventListener('click', () => openPanel(rotationPanelInstance));
    // The NAX preview mirror is a one-off whole-library fetch, so it gets its own small action
    // rather than living inside another batch panel. Reloaded through onBeforeOpen, the same
    // hook the rotation panel uses, so the panel shows live progress each time it is opened.
    // (makePanel also assigns `panel.refresh`, but nothing in this file ever calls it — that
    // factory path is unwired, so relying on it would silently render an empty panel.)
    
    naxMirrorPanelInstance = makePanel('NAX 预览镜像', naxMirrorPanel(), 'nax');
    const naxMirrorBody = naxMirrorPanelInstance.querySelector('.artist-library-nax-mirror');
    if (naxMirrorBody?.reload) naxMirrorPanelInstance.onBeforeOpen = () => naxMirrorBody.reload();
    const naxMirrorAction = button('NAX 镜像', 'ghost', { 'data-open-nax-mirror': 'true' });
    naxMirrorAction.hidden = manageLocked();
    naxMirrorAction.addEventListener('click', () => openPanel(naxMirrorPanelInstance));
    // "Find artists that look like this image" is a SEARCH MODE, not a library-wide job, so
    // it belongs on the search box rather than in the batch-action cluster beside the title.
    // It was put there first and squeezed 「画师资料库」 into a crushed column: the heading is
    // `flex: 1; min-width: 0` and the h1 wraps anywhere, so a fourth button took the room the
    // title was using. The three job buttons stay where 1.5.50 put them.
    similarPanelInstance = makePanel('以图找相似画师', similarPanel(), 'similar');
    const similarBody = similarPanelInstance.querySelector('.artist-library-similar');
    if (similarBody?.reload) similarPanelInstance.onBeforeOpen = () => similarBody.reload();
    // 所有者按下面板自己的「关闭」，就是结束了这次查找：这时若还留着「返回要把面板弹回来」的
    // 标记，它会在后面某次无关的返回上炸开。绑在按钮上而不是听面板的 `close` 事件 —— 结果
    // 点击里的 close() 也会派发 close（异步），那会把刚设上的标记反过来清掉。
    similarPanelInstance.querySelector('.artist-library-panel-header button')?.addEventListener('click', () => { similarReturnPending = false; });
    similarActionButton = button('以图找', 'ghost', { 'data-open-similar': 'true', 'aria-label': '用一张图找相似画师' });
    similarActionButton.hidden = manageLocked();
    similarActionButton.addEventListener('click', () => openPanel(similarPanelInstance));
    const overviewActions = el('div', { className: 'artist-library-overview-actions' }, [tasks, rotation, naxMirrorAction]);
    // Note: 库级动作放在标题行，不要放回统计行 —— 放回去会让两行都两端对齐并各留一个大洞。
    
    // The two library-level actions live in the HEADER, beside the title, not on the stats
    // line below it. Both rows previously put their content at the two far edges — the role
    // badge was pushed right by the heading's `flex: 1` and the actions were pushed right by
    // `margin-left: auto` — which left a 970px void in the header and a 618px void on the
    // stats line. The heading already absorbs slack, so the actions fill the header's empty
    // right side instead of creating a hole, and the stats line becomes one dense run.
    header.append(overviewActions);
    // New layout (phone first): the three library jobs are occasional, so they sit in one 管理
    // menu at the end of the coverage line instead of three buttons. Legacy keeps the row.
    const manage = button('管理', 'artist-library-manage-toggle', { 'data-new-layout-only': '', 'aria-expanded': 'false', 'aria-label': '画师库管理' });
    const setManageOpen = open => { header.classList.toggle('jobs-open', open); manage.setAttribute('aria-expanded', String(open)); };
    manage.addEventListener('click', () => setManageOpen(!header.classList.contains('jobs-open')));
    overviewActions.addEventListener('click', event => { if (event.target.closest('button')) setManageOpen(false); });
    document.addEventListener('pointerdown', event => { if (!header.contains(event.target)) setManageOpen(false); });
    if (!manageable()) manage.hidden = true;
    manageToggle = manage;
    header.append(manage);
    // Kept so the view chrome can hide it: the coverage line counts the whole library
    // and the two buttons act on the whole library, so none of it belongs on a single
    // artist's page.
    const overview = el('div', { className: 'artist-library-overview' }, [coverageHost]);
    overviewBar = overview;
    overviewActionsBar = overviewActions;
    dialog.append(header, overview, localStatus, taskPanel, rotationPanelInstance, similarPanelInstance, naxMirrorPanelInstance, body, compareTray);
    // Example menus close on an outside press or Escape, so they never require a
    // second click on their own trigger.
    document.addEventListener('pointerdown', event => {
      for (const open of document.querySelectorAll('.artist-library-example-menu[open]')) {
        if (!open.contains(event.target)) open.open = false;
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      for (const open of document.querySelectorAll('.artist-library-example-menu[open]')) open.open = false;
    });
    if (!embedded) {
      dialog.addEventListener('cancel', event => {
        event.preventDefault();
        close();
      });
      dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
    }
    (target || document.body).append(dialog);
    // 兜底：这些面板不止本文件会打开 —— artist-automation 直接对同一个「画师任务」<dialog> 调
    // showModal()，而且是在 await 之后。观察器让两件事各自复核一次可见性：宿主自己被隐藏
    // （切 Tab 改的是祖先的 class），以及某个面板刚被打开（showModal 会把 open 属性写到
    // <dialog> 上，可被 attributeFilter 观察到）。于是没有任何一条路径能把 0×0 的模态对话框
    // 留在顶层吃掉整页的点按。
    // 单元测试的 DOM 桩没有 MutationObserver，所以和 requestAnimationFrame 一样按能力退化：
    // 少了这层兜底，openPanel 自己的可见性前提仍然成立，只是别人直接 showModal 时不被收回。
    if (typeof globalThis.MutationObserver === 'function') {
      new globalThis.MutationObserver(retireHiddenPanels).observe(dialog.closest('.tab-panel') || dialog.parentElement, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
      new globalThis.MutationObserver(retireHiddenPanels).observe(dialog, { subtree: true, attributes: true, attributeFilter: ['open'] });
    }
    if (externalAutomation) {
      ingestionHost.hidden = Boolean(manageLocked());
      mountAutomation(ingestionHost, taskSummary);
    }
  }

  // How the route in use is described. The account id is only shown when it is a real
  // account key rather than the plain env token.
  function routeLabel(route = {}) {
    if (route.provider === 'rbq') return 'RBQ 中转';
    if (String(route.provider || '').startsWith('relay:')) return '第三方中转';
    const account = String(route.officialAccountId || '');
    return account && account !== 'env' ? `NovelAI 官方 · ${account}` : 'NovelAI 官方';
  }

  function isOpen() {
    return active && Boolean(dialog?.isConnected) && (embedded || dialog.open);
  }

  // The generation route in use right now, sent with a start request so a run uses the
  // current 通道 instead of whichever one the baseline happened to be captured on. It is
  // resolved at start because the route and its token are settings, not content.
  function rotationRoute() {
    if (typeof resolveRotationRoute !== 'function') return { provider: 'official', officialAccountId: '' };
    try {
      const route = resolveRotationRoute() || {};
      return { provider: normalizeProviderId(route.provider), officialAccountId: String(route.officialAccountId || '') };
    } catch { return { provider: 'official', officialAccountId: '' }; }
  }

  function canPollIngestion() {
    return !externalAutomation && isOpen() && !manageLocked() && !document.hidden && hostOnScreen();
  }

  function scheduleIngestion() {
    clearTimeout(ingestionTimer);
    if (externalAutomation || !isOpen() || manageLocked() || ingestionStatus?.state !== 'running') return;
    ingestionTimer = setTimeout(() => {
      if (canPollIngestion()) refreshIngestion();
      else scheduleIngestion();
    }, 5000);
  }

  function renderIngestion() {
    if (externalAutomation || !ingestionHost) return;
    ingestionHost.hidden = Boolean(manageLocked());
    if (ingestionHost.hidden) return;
    ingestionHost.replaceChildren();
    const copy = el('div', { className: 'artist-library-ingestion-copy', attrs: { role: 'status', 'aria-live': 'polite' } });
    const actions = el('div', { className: 'artist-library-ingestion-actions' });
    const status = ingestionStatus;
    if (!status) {
      copy.append(el('strong', { text: ingestionError ? '采集状态暂不可用' : '正在读取原作采集进度…' }));
    } else {
      const labels = { idle: '原作库', running: '正在采集', paused: '采集已暂停', completed: '本轮采集完成' };
      const total = Math.max(0, Number(status.totalArtists) || 0);
      const processed = Math.max(0, Number(status.processedArtists) || 0);
      copy.append(el('strong', { text: labels[status.state] || '原作采集', title: status.currentArtist ? `当前画师：${cleanText(status.currentArtist, 160)}` : '' }));
      const active = ['running', 'paused'].includes(status.state);
      copy.append(el('span', { text: active
        ? `${processed} / ${total} 位 · 新增 ${Math.max(0, Number(status.importedExamples) || 0)} 张`
        : `${Number(status.libraryArtists) || 0} 位有图 · ${Number(status.libraryOriginalExamples) || 0} 张原作${total ? ` · 本轮 +${Number(status.importedExamples) || 0}` : ''}` }));
      if (active && total) copy.append(el('progress', { value: processed, attrs: { max: String(Math.max(total, processed, 1)), 'aria-label': '已处理画师数' } }));
      const action = status.state === 'running' ? 'pause' : status.state === 'paused' && status.canResume ? 'resume' : 'start';
      const actionButton = button({ start: '补新画师', pause: '暂停', resume: '恢复采集' }[action], 'ghost');
      actionButton.disabled = ingestionBusy || (action === 'start' && status.canStart === false) || (status.state === 'paused' && !status.canResume);
      if (action === 'start') actionButton.title = `未采集候选 ${Number(status.remainingArtists) || 0} 位；每批最多 50 位`;
      actionButton.addEventListener('click', () => mutateIngestion(action, action === 'start' ? { mode: 'expand' } : {}));
      actions.append(actionButton);
      const menu = el('details', { className: 'artist-library-ingestion-menu' });
      menu.append(el('summary', { text: '管理' }));
      const menuBody = el('div', { className: 'artist-library-ingestion-menu-body' });
      for (const [mode, label, available] of [['enrich', '补已有例图', status.canEnrich], ['retry', '重试未获取', status.canRetry]]) {
        const item = button(label, 'ghost');
        item.disabled = ingestionBusy || active || available === false;
        item.addEventListener('click', () => { menu.open = false; mutateIngestion('start', { mode }); });
        menuBody.append(item);
      }
      // Roster maintenance rather than a collection run: it widens the name list to every Danbooru
      // artist above the post-count floor and collects nothing. It lives in 管理 because it is an
      // occasional action, and it is the only way a name the NAX gallery never covered can enter
      // the library at all — without it, those artists are unreachable by any sweep.
      const discover = button('补齐知名画师名单', 'ghost');
      discover.disabled = ingestionBusy || active;
      discover.title = '把 D 站上 200 帖以上的画师补进名单；只新增缺少的，不动已有资料，也不采集';
      discover.addEventListener('click', () => { menu.open = false; mutateIngestion('discover', {}); });
      menuBody.append(discover);
      const refresh = button('刷新', 'ghost', { 'aria-label': '刷新原作采集进度与列表例图' });
      refresh.disabled = ingestionBusy;
      refresh.addEventListener('click', () => { menu.open = false; refreshIngestion({ refreshList: true }); });
      menuBody.append(refresh);
      // Abandoning a roster-wide run has to be possible: while a campaign is paused every later
      // start is refused, so without this a long run is a commitment the owner cannot back out of.
      // The ledger is kept, so artists already collected are not attempted again.
      const cancelRun = button('取消本轮采集', 'ghost');
      cancelRun.disabled = ingestionBusy || !active;
      cancelRun.title = '放弃本轮计划；已采集的例图与进度记录都会保留';
      cancelRun.addEventListener('click', async () => {
        menu.open = false;
        if (await confirmAction('取消本轮采集？已采集的例图会保留，进度记录也会保留。', { confirmLabel: '取消采集', cancelLabel: '继续采集', danger: true })) mutateIngestion('cancel', {});
      });
      menuBody.append(cancelRun);
      menu.append(menuBody);
      actions.append(menu);
    }
    if (ingestionError || status?.lastError) copy.append(el('small', { className: 'artist-library-ingestion-error', text: ingestionError || cleanText(status.lastError, 300) }));
    if (!status) {
      const retry = button('重试', 'ghost');
      retry.addEventListener('click', () => refreshIngestion({ refreshList: true }));
      actions.append(retry);
    }
    ingestionHost.append(copy, actions);
  }

  async function refreshIngestion({ refreshList = false } = {}) {
    if (externalAutomation || !isOpen() || manageLocked() || ingestionBusy) return;
    ingestionController?.abort();
    ingestionController = typeof AbortController === 'function' ? new AbortController() : null;
    const controller = ingestionController;
    const token = ingestionGate.begin();
    try {
      const data = await api('/api/artists/ingestion', controller ? { signal: controller.signal } : {});
      if (!ingestionGate.isCurrent(token) || !isOpen() || manageLocked()) return;
      ingestionStatus = data?.ingestion || null;
      ingestionError = ingestionStatus ? '' : '请稍后刷新。';
      renderIngestion();
      if (refreshList && state.view === 'list') await loadList({ scroll: readScroll() });
    } catch (error) {
      if (!ingestionGate.isCurrent(token) || error?.name === 'AbortError') return;
      ingestionError = errorMessage(error);
      renderIngestion();
    } finally {
      if (ingestionController === controller) ingestionController = null;
      if (ingestionGate.isCurrent(token)) scheduleIngestion();
    }
  }

  async function mutateIngestion(action, options = {}) {
    if (externalAutomation || !isOpen() || manageLocked() || ingestionBusy) return;
    clearTimeout(ingestionTimer);
    ingestionController?.abort();
    const token = ingestionGate.begin();
    ingestionBusy = true;
    renderIngestion();
    try {
      const data = await api('/api/artists/ingestion', { method: 'POST', body: { action, ...options } });
      if (!ingestionGate.isCurrent(token) || !isOpen() || manageLocked()) return;
      ingestionStatus = data?.ingestion || null;
      ingestionError = '';
    } catch (error) {
      if (!ingestionGate.isCurrent(token)) return;
      ingestionError = errorMessage(error);
      notify(ingestionError, 'error');
    } finally {
      if (ingestionGate.isCurrent(token)) {
        ingestionBusy = false;
        renderIngestion();
        scheduleIngestion();
      }
    }
  }

  function updateRole() {
    const locked = Boolean(readOnly());
    roleBadge.textContent = locked ? '访客 · 只读' : manageable() ? '所有者' : '本机';
    roleBadge.dataset.readOnly = locked ? 'true' : 'false';
    if (externalAutomation && ingestionHost) ingestionHost.hidden = manageLocked();
    syncViewChrome();
    return locked;
  }

  // Whole-library chrome (the coverage line and the two library-wide buttons) is shown
  // only in the list view. Every view change already calls updateRole, so the rule lives
  // here rather than being repeated at each call site. The two pieces are separate elements
  // now — the buttons sit in the header, the stats on their own line — so both are toggled.
  function syncViewChrome() {
    const listView = state.view === 'list';
    // The detail page has its own toolbar; the library header (title, role, library menu) is list chrome.
    if (dialog) dialog.dataset.view = state.view;
    // The coverage line and library-wide jobs describe collection work, which only a managing host does.
    if (overviewBar) overviewBar.hidden = !listView || !manageable();
    if (overviewActionsBar) overviewActionsBar.hidden = !listView || !manageable();
    // The library-wide 管理 menu belongs to the list; a detail page has its own ⋯ menu.
    if (manageToggle) manageToggle.hidden = !listView || !manageable();
  }

  function readScroll() {
    return Math.max(0, Number(embedded ? globalThis.window?.scrollY : body?.scrollTop) || 0);
  }

  function rememberListScroll() {
    if (state.view === 'list' && body?.querySelector('.artist-library-filters')) listScroll = readScroll();
  }

  function restoreScroll(position) {
    const revision = ++scrollRevision;
    const frame = globalThis.requestAnimationFrame || (callback => callback());
    frame(() => frame(() => {
      if (revision !== scrollRevision || !isOpen() || document.hidden || !hostOnScreen()) return;
      if (embedded) globalThis.window?.scrollTo?.({ top: position, left: 0, behavior: 'auto' });
      else body.scrollTop = position;
    }));
  }

  function returnToList() {
    // 标记是一次性的：先取走再决定，之后任何一次返回都不会再弹出面板。
    const fromSimilarPanel = similarReturnPending;
    similarReturnPending = false;
    // 两条归途都要放回面板：有暂存列表的是压层返回，没有的是重新拉一页列表（例如库是直接
    // 打开到某位画师详情的，那时列表这一层还不存在）。
    if (listDetailReturn) {
      const comparison = restoreListFromDetail();
      if (fromSimilarPanel) restoreSimilarPanel();
      return comparison;
    }
    const reload = loadList({ scroll: listScroll });
    if (fromSimilarPanel) restoreSimilarPanel();
    return reload;
  }

  // 把「找相似画师」面板放回来。顺序和画廊入口的 openSimilarImage 完全一样：宿主先上屏，
  // 面板后弹 —— openPanel 拒绝屏幕外的宿主（1.5.74），先弹后切会被静默拒绝，而静默拒绝在这里
  // 就等于「返回没把面板带回来」，正是要修的那个缺陷本身。
  function restoreSimilarPanel() {
    if (!hostOnScreen()) navigate();
    openPanel(similarPanelInstance);
  }

  // 画师详情是盖在列表上的一层：打开时先把列表整棵树、它的滚动位置和当前焦点留在内存里，
  // 而不是像换页那样把它丢掉。留下的这棵树在详情期间不被触碰，所以「返回」不是重新渲染
  // 一页列表，而是关掉这一层——筛选草稿、页码和滚动因此与点进详情之前逐字一致。
  function rememberListForDetail() {
    if (listDetailReturn) return;                                  // 已经在详情里，不覆盖最初那份列表
    if (!body?.querySelector('.artist-library-filters')) return;   // 列表还没渲染出来，没有可保留的东西
    const focused = document.activeElement;
    listDetailReturn = {
      nodes: [...body.childNodes],
      // 节点离开文档时浏览器会把焦点移走，所以要记住是哪一个，返回时还给同一个节点。
      // 只有焦点本来就在画师库里时才记：从别的面板跳进来时不该在返回后抢走焦点。
      focus: focused && dialog?.contains?.(focused) ? focused : null
    };
  }

  // 关闭这层浮层：把原来的列表节点原位放回。列表内容不重建，只在后台比对一次，
  // 真的变了才显示「有新结果 · 更新」，绝不打断用户回到的位置。
  function restoreListFromDetail() {
    const saved = listDetailReturn;
    listDetailReturn = null;
    cancelRequestsExcept('list');
    closeDetailPanels();
    setLibraryView(state, 'list');
    activeProfile = null;
    title.textContent = '画师资料库';
    body.replaceChildren(...saved.nodes);
    // 详情里的「加入对比 / 取消对比」会改变列表卡片上的按钮文案，所以并存的控件要重新同步。
    for (const container of body.querySelectorAll('[data-chip-fit]')) if (!chipLayouts.has(container)) chipLayouts.set(container, observeFittedChips(container));
    updateRole();
    syncComparisonControls(dialog, state);
    renderCompareTray();
    // 后台比对必须在 restoreScroll 之前发起：loadList 会推进 scrollRevision，把还没执行的
    // 还原滚动位置的回调作废掉。
    const comparison = refreshList({ background: true });
    restoreScroll(listScroll);
    if (saved.focus?.isConnected) saved.focus.focus?.({ preventScroll: true });
    return comparison;
  }

  function refreshList({ background = false } = {}) {
    if (filterTimer || (background && listPending)) return Promise.resolve();
    return isOpen() && state.view === 'list' ? loadList({ scroll: null, background }) : Promise.resolve();
  }

  async function refresh() {
    if (!isOpen()) return;
    refreshSummary();
    if (state.view === 'list') return refreshList({ background: true });
    if (state.view !== 'detail' || !activeProfile || !body.querySelector('.artist-library-profile-form')) return;
    const artist = activeProfile.artist, request = startRequest('detail');
    try {
      const result = await api(`/api/artists/profile?artist=${encodeURIComponent(artist)}`, { signal: request.signal });
      if (gates.detail.isCurrent(request.token) && isOpen() && shouldApplyProfileUpdate(state, artist)) acceptUpdatedProfile(result, artist);
    } catch (error) { if (error.name !== 'AbortError') notify(errorMessage(error), 'error'); }
    finally { finishRequest('detail', request.signal); }
  }

  function renderMessage(message, kind = '') {
    clearTimeout(filterTimer); filterTimer = 0;
    closeDetailPanels();
    body.replaceChildren(el('div', {
      className: `artist-library-state${kind ? ` is-${kind}` : ''}`,
      text: message,
      attrs: { role: kind === 'error' ? 'alert' : 'status' }
    }));
    pruneChipLayouts();
  }

  function runAddArtist(artist) {
    if (readOnly()) {
      notify('访客模式不能修改 Prompt。', 'error');
      return;
    }
    try {
      Promise.resolve(addToPrompt(artist)).then(added => {
        notify(added === false ? `artist:${artist} 已在画风中，没有重复添加。` : `已将 artist:${artist} 加入画风。`);
      }).catch(error => notify(errorMessage(error), 'error'));
    } catch (error) {
      notify(errorMessage(error), 'error');
    }
  }

  function runPreviewArtist(artist) {
    try {
      Promise.resolve(preview(artist)).catch(error => notify(errorMessage(error), 'error'));
    } catch (error) {
      notify(errorMessage(error), 'error');
    }
  }

  function acceptUpdatedProfile(result, expectedArtist) {
    const profile = result?.artist;
    if (!profile) return;
    refreshSummary();
    resultViewer.updateProfile(profile);
    if (!shouldApplyProfileUpdate(state, expectedArtist)) {
      if (comparisonDetail?.profile?.artist === expectedArtist) comparisonDetail.updatedProfile = profile;
      if (isOpen() && state.view === 'list') refreshList();
      return;
    }
    const previousProfile = activeProfile?.artist === expectedArtist ? activeProfile : null;
    activeProfile = profile;
    if (isOpen()) updateDetailInPlace(previousProfile, profile);
  }

  function updateDetailInPlace(previousProfile, profile) {
    if (JSON.stringify(previousProfile) === JSON.stringify(profile)) return;
    const coverEvidence = body.querySelector('[data-artist-cover-evidence]');
    if (coverEvidence) renderCoverEvidence(coverEvidence, profile);
    const sampleEvidence = body.querySelector('[data-artist-evidence-summary]');
    if (sampleEvidence) renderSampleEvidence(sampleEvidence, profile);
    const oldCover = body.querySelector('[data-artist-detail-cover]');
    if (oldCover) {
      const newCover = imageNode(profile.coverUrl, `${profile.artist} 的收藏例图`, 'artist-library-detail-cover');
      newCover.dataset.artistDetailCover = 'true';
      oldCover.replaceWith(newCover);
    }

    const examplesRoot = body.querySelector('[data-artist-examples]');
    const previewHost = body.querySelector('[data-artist-preview-host]');
    if (!examplesRoot || !previewHost) return;
    for (const evidence of examplesRoot.querySelectorAll('[data-example-evidence]')) {
      const observations = value => (value?.observations || []).filter(item => item.exampleId === evidence.dataset.exampleEvidence);
      if (JSON.stringify(observations(previousProfile)) === JSON.stringify(observations(profile))) continue;
      evidence.replaceChildren();
      renderEvidenceChips(evidence, profile, evidence.dataset.exampleEvidence);
    }
    for (const card of examplesRoot.querySelectorAll('[data-example-id]')) {
      const confirmed = profile.observations?.some(item => item.exampleId === card.dataset.exampleId && item.reviewed === true);
      const summary = card.querySelector('.artist-library-annotation')?.querySelector('summary');
      if (confirmed && summary) summary.textContent = '编辑特征标注';
      const editor = card.querySelector('.artist-library-annotation');
      const observations = (profile.observations || []).filter(item => item.exampleId === card.dataset.exampleId);
      const previous = (previousProfile?.observations || []).filter(item => item.exampleId === card.dataset.exampleId);
      const example = profile.examples?.find(item => item.id === card.dataset.exampleId);
      if (editor && example && editor.querySelector('form')?.dataset.dirty !== 'true' && JSON.stringify(previous) !== JSON.stringify(observations)) {
        const observation = observations.find(item => item.reviewed === true) || observations.find(item => item.automatic !== true) || observations[0];
        const replacement = annotationEditor(profile, example, observation); replacement.open = editor.open;
        editor.replaceWith(replacement);
      }
    }
    const changes = diffProfileExamples(previousProfile, profile);    for (const id of changes.removedIds) {
      for (const card of examplesRoot.querySelectorAll('[data-example-id]')) {
        if (card.dataset.exampleId === id) card.remove();
      }
    }
    for (const example of changes.added) {
      const source = example?.sourceType === 'nax' || example?.sourceType === 'original' ? example.sourceType : 'generated';
      const group = [...examplesRoot.querySelectorAll('[data-example-source]')].find(node => node.dataset.exampleSource === source);
      if (!group) continue;
      group.querySelector('[data-source-empty]')?.remove();
      let grid = group.querySelector('[data-example-grid]');
      if (!grid) {
        grid = el('div', { className: 'artist-library-example-grid', attrs: { 'data-example-grid': 'true' } });
        group.append(grid);
      }
      grid.prepend(exampleCard(profile, example, previewHost));
    }
    const groups = groupExamplesBySource(profile.examples);
    for (const source of ['nax', 'generated', 'original']) {
      const group = [...examplesRoot.querySelectorAll('[data-example-source]')].find(node => node.dataset.exampleSource === source);
      if (!group) continue;
      group.hidden = !groups[source].length;
      const heading = group.querySelector('[data-source-count]');
      if (heading) heading.textContent = `${SOURCE_LABELS[source]} · ${groups[source].length}`;
      const grid = group.querySelector('[data-example-grid]');
      if (!groups[source].length) {
        grid?.remove();
        if (!group.querySelector('[data-source-empty]')) group.append(el('p', {
          className: 'artist-library-muted', text: '尚未保存此来源的例图。', attrs: { 'data-source-empty': 'true' }
        }));
      }
    }
    const total = examplesRoot.querySelector('[data-example-total]');
    if (total) total.textContent = `例图 · ${profile.examples?.length || 0}`;
    // A cover change adds and removes nothing, so it is synced explicitly here.
    for (const card of examplesRoot.querySelectorAll('[data-example-id]')) syncCoverControls(card, profile);
    pruneChipLayouts();
  }

  function renderCompareTray() {
    compareTray.replaceChildren();
    if (!state.compareArtists.length) {
      compareTray.hidden = true;
      return;
    }
    compareTray.hidden = false;
    const copy = el('div', { className: 'artist-library-compare-copy' }, [
      el('strong', { text: `已选 ${state.compareArtists.length}/${MAX_COMPARE}` }),
      el('span', { text: state.compareArtists.join(' · ') })
    ]);
    const clear = button('清空', 'ghost');
    clear.addEventListener('click', () => {
      state.compareArtists.length = 0;
      if (state.view === 'compare') returnFromComparison();
      else {
        syncComparisonControls(dialog, state);
        renderCompareTray();
      }
    });
    const show = button('对比', 'primary', { 'aria-label': `对比已选 ${state.compareArtists.length} 位画师` });
    show.disabled = state.compareArtists.length < 2;
    show.addEventListener('click', () => loadComparison());
    compareTray.append(copy, el('div', { className: 'artist-library-compare-actions' }, [clear, show]));
  }

  function syncFiltersFromForm(form, primary = false) {
    const data = new FormData(form);
    state.filters.query = cleanText(data.get('query'), 300);
    state.filters.model = cleanText(data.get('model'), 20);
    state.filters.favorite = data.get('favorite') === 'on';
    state.filters.annotated = data.get('annotated') === 'on';
    state.filters.confirmedOnly = data.get('confirmedOnly') === 'on';
    state.filters.sort = normalizeArtistSort(data.get('sort'));
    state.filters.facets = emptyFacets();
    for (const facet of STYLE_FACETS) {
      state.filters.facets[facet.key] = data.getAll(`facet-${facet.key}`).map(value => cleanText(value, 40));
    }
    const detailed = readAttributeForm(form, 'attribute-');
    const mapped = attributesFromLegacy(state.filters.facets);
    const attributes = {};
    for (const definition of STYLE_ATTRIBUTES) {
      const values = primary
        ? [...(detailed[definition.key] || []).filter(value => !Object.keys(legacyFromAttributes({ [definition.key]: [value] })).length), ...(mapped[definition.key] || [])]
        : detailed[definition.key] || [];
      if (values.length) attributes[definition.key] = values;
    }
    state.filters.attributes = validateStyleAttributes(attributes);
    state.filters.facets = { ...emptyFacets(), ...legacyFromAttributes(attributes) };
    // A typed query whose words are recognized as controlled style properties is a
    // style question, and a style question wants a ranked answer. This switches the
    // sort only (a) while the control still sits on its untouched default, so an
    // explicit choice is never overridden, and (b) for TYPED words only — ticking a
    // facet checkbox stays the precise all-in-one-example filter it has always been.
    if (!state.sortTouched && state.filters.sort === 'default' && queryHasStyleTerms(state.filters.query)) {
      state.filters.sort = 'relevance';
      const control = form.querySelector('[name="sort"]');
      if (control) control.value = 'relevance';
    }
  }

  // 画风 panel: one place for every style word.
  //   · vibe chips (from the style index) rank artists by image style — want / avoid / off;
  //   · label chips (artist-vibe-chips.js) filter exactly by stored annotations — on / off;
  //   · 精确 makes the wanted vibe chips that have an annotation counterpart filter as well.
  // Whether an index exists rides on the list response (`styleIndex`); the chip list is read only when
  // the panel opens, a vibe is active, or a word is typed, so first entry costs no extra request.
  // The old 画风特征 / 细化特征 / 构图 grids stay intact under 更多标注筛选.
  
  let vibeInfo = null, vibeLoading = null;
  // A tapped chip must stay under the finger. The owner saw the page snap back to the chip bar when
  // tapping with half a screen of results below; whatever moves the layout (panel redraw, a new list,
  // late images), the element that was tapped is put back at the same screen position after each redraw.
  let pinned = null, pinObserver = null;
  function pinUnderFinger(node, selector) {
    if (!node?.isConnected) return;
    pinned = { selector, top: node.getBoundingClientRect().top, until: Date.now() + 2500 };
    // Any layout change while pinned (redraws, late images) is corrected in the same frame.
    if (!pinObserver && globalThis.ResizeObserver) { pinObserver = new ResizeObserver(() => settlePinned()); pinObserver.observe(dialog); pinObserver.observe(body); }
  }
  function settlePinned() {
    if (!pinned) { pinObserver?.disconnect(); pinObserver = null; return; }
    if (Date.now() > pinned.until) { pinned = null; pinObserver?.disconnect(); pinObserver = null; return; }
    const node = body.querySelector(pinned.selector);
    if (!node) return;
    const delta = node.getBoundingClientRect().top - pinned.top;
    if (Math.abs(delta) < 1) return;
    if (embedded) globalThis.window?.scrollBy?.({ top: delta, left: 0, behavior: 'auto' }); else body.scrollTop += delta;
  }
  function loadVibeInfo() {
    if (vibeInfo) return Promise.resolve();
    if (vibeLoading) return vibeLoading;
    vibeLoading = Promise.resolve().then(() => api('/api/artists/style-index'))
      .then(data => { vibeInfo = data?.available ? data : { available: false, chips: [] }; })
      .catch(() => { vibeInfo = { available: false, chips: [] }; })
      .finally(() => { vibeLoading = null; renderVibePanel(); renderQuickRow(); });
    return vibeLoading;
  }
  const exactChipOn = chip => Boolean(state.filters.attributes?.[chip.attribute[0]]?.includes(chip.attribute[1]));
  const vibeLabel = id => vibeInfo?.chips?.find(chip => chip.id === id)?.label || EXACT_CHIPS.find(chip => chip.id === id)?.label || id;
  function setVibe(tokens, like = state.filters.like) {
    state.filters.vibe = tokens; state.filters.like = like; state.page = 1;
    scheduleFilterSearch();
  }
  function setAttributeValue(key, value, on) {
    const list = state.filters.attributes?.[key] || [];
    const next = on ? [...new Set([...list, value])] : list.filter(item => item !== value);
    const attributes = { ...(state.filters.attributes || {}) };
    if (next.length) attributes[key] = next; else delete attributes[key];
    state.filters.attributes = validateStyleAttributes(attributes);
    state.filters.facets = { ...emptyFacets(), ...legacyFromAttributes(state.filters.attributes) };
  }
  function toggleExactChip(chip) {
    setAttributeValue(chip.attribute[0], chip.attribute[1], !exactChipOn(chip));
    state.page = 1; scheduleFilterSearch();
  }
  function chipButton(id, label, mode, hue, tagged) {
    const node = button(mode === 'avoid' ? label : label, `artist-vibe-chip vibe-fx${tagged ? ' is-tagged' : ''}`, { 'data-vibe-chip': id, 'data-mode': mode, 'aria-pressed': String(mode !== 'off') });
    node.style.setProperty('--hue', hue);
    return node;
  }
  const GROUP_HUES = { 氛围: '#86aee0', 场景: '#9b9fe8', 画法: '#d6b38a', 色彩: '#e2a6bb', 质感: '#7fc4b8', 造型: '#b0a4d6', 年代: '#e09a6a', 题材: '#c6c27a', 画面: '#8fbf9f' };
  function renderVibePanel(panel = body.querySelector('[data-artist-vibe]')) {
    if (!panel) return;
    const open = Boolean(panel.closest('.filters-open'));
    if (!vibeInfo && state.styleIndex && (open || state.filters.vibe?.length || state.filters.like)) loadVibeInfo();
    const tokens = state.filters.vibe || [];
    const wanted = tokens.filter(token => !token.startsWith('-')), avoided = tokens.filter(token => token.startsWith('-')).map(token => token.slice(1));
    const exactSwitch = panel.querySelector('[name="vibeExact"]');
    if (exactSwitch) exactSwitch.checked = state.filters.exact === true;
    const groups = new Map(VIBE_GROUP_ORDER.map(name => [name, []]));
    for (const chip of vibeInfo?.available ? vibeInfo.chips : []) {
      const mode = wanted.includes(chip.id) ? 'want' : avoided.includes(chip.id) ? 'avoid' : 'off';
      const node = chipButton(chip.id, chip.label, mode, GROUP_HUES[chip.group] || '#d6b38a', false);
      // One tap = want, second = avoid, third = off.
      node.addEventListener('click', () => {
        pinUnderFinger(node, `[data-vibe-chip="${chip.id}"]`);
        const rest = tokens.filter(token => token !== chip.id && token !== `-${chip.id}`);
        setVibe(mode === 'off' ? [...rest, chip.id] : mode === 'want' ? [...rest, `-${chip.id}`] : rest);
      });
      (groups.get(chip.group) || groups.set(chip.group, []).get(chip.group)).push(node);
    }
    for (const chip of EXACT_CHIPS) {
      const node = chipButton(chip.id, chip.label, exactChipOn(chip) ? 'want' : 'off', GROUP_HUES[chip.group] || '#8fbf9f', true);
      node.title = '按标注逐张精确过滤';
      node.addEventListener('click', () => { pinUnderFinger(node, `[data-vibe-chip="${chip.id}"]`); toggleExactChip(chip); });
      (groups.get(chip.group) || groups.set(chip.group, []).get(chip.group)).push(node);
    }
    const rows = [...groups].filter(([, chips]) => chips.length).map(([group, chips]) => {
      const row = el('div', { className: 'artist-vibe-group' }, [el('span', { className: 'artist-vibe-group-label', text: group }), el('div', { className: 'artist-vibe-chips' }, chips)]);
      row.style.setProperty('--hue', GROUP_HUES[group] || '#d6b38a');
      return row;
    });
    const loading = state.styleIndex && !vibeInfo ? [el('p', { className: 'artist-vibe-loading', text: '正在读取感觉词…' })] : [];
    const hint = wanted.length >= 4 ? '词越多越像混合氛围，个别项可能变弱' : vibeInfo?.available ? '点一下想要，再点一下不要 · 带角标的按标注精确过滤' : '带角标的词按标注逐张精确过滤';
    panel.querySelector('.artist-vibe-body').replaceChildren(...loading, ...rows,
      el('p', { className: `artist-vibe-hint${wanted.length >= 4 ? ' is-warning' : ''}`, attrs: { 'data-vibe-hint': 'true' }, text: hint }));
    settlePinned();
  }
  function vibePanel() {
    const exactInput = el('input', { name: 'vibeExact', attrs: { type: 'checkbox', 'aria-label': '精确：同时要求有标注证据' } });
    exactInput.checked = state.filters.exact === true;
    exactInput.addEventListener('change', () => { state.filters.exact = exactInput.checked; state.page = 1; scheduleFilterSearch(); });
    const reset = button('清空', 'ghost artist-vibe-clear', { 'data-vibe-clear': 'true' });
    reset.addEventListener('click', () => {
      state.filters.vibe = []; state.filters.like = '';
      for (const chip of EXACT_CHIPS) if (exactChipOn(chip)) setAttributeValue(chip.attribute[0], chip.attribute[1], false);
      state.page = 1; scheduleFilterSearch();
    });
    const head = el('div', { className: 'artist-vibe-head' }, [
      el('label', { className: 'artist-vibe-exact', attrs: { title: '打开后，想要的感觉词还必须有对应标注' } }, [exactInput, el('span', { className: 'artist-vibe-track' }), el('span', { text: '精确' })]),
      reset
    ]);
    const panel = el('div', { className: 'artist-vibe-panel', attrs: { 'data-artist-vibe': 'true' } }, [head, el('div', { className: 'artist-vibe-body' })]);
    renderVibePanel(panel);
    return panel;
  }
  // The quick row: model, sort, 收藏, then one removable pill per active choice, on one scrolling line.
  function renderQuickRow(form = body.querySelector('.artist-library-filters')) {
    const host = form?.querySelector('[data-artist-active-pills]'); if (!host) return;
    const tokens = state.filters.vibe || [];
    const pill = (label, mode, remove, key) => {
      const node = button(label, `artist-active-pill${mode === 'avoid' ? ' is-avoid' : ''}`, { 'data-active-pill': key, 'aria-label': `取消 ${label}` });
      node.addEventListener('click', () => { pinUnderFinger(node.closest('.artist-library-quickrow'), '.artist-library-quickrow'); remove(); }); return node;
    };
    const pills = [];
    if (state.filters.like) pills.push(pill(`像 ${state.filters.like}`, 'want', () => setVibe(tokens, ''), 'like'));
    for (const token of tokens) {
      const id = token.replace(/^-/, '');
      pills.push(pill(vibeLabel(id), token.startsWith('-') ? 'avoid' : 'want', () => setVibe(tokens.filter(item => item !== token)), token));
    }
    for (const chip of EXACT_CHIPS) if (exactChipOn(chip)) pills.push(pill(chip.label, 'want', () => toggleExactChip(chip), chip.id));
    host.replaceChildren(...pills);
    form.toggleAttribute('data-style-ranked', Boolean(tokens.length || state.filters.like));
  }
  // A typed word that names a chip lights the chip instead of searching text: 「水彩 梦幻」.
  async function absorbChipWords(input) {
    const words = input.value.split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    if (state.styleIndex && !vibeInfo) await loadVibeInfo();
    const chips = vibeInfo?.available ? vibeInfo.chips : [];
    const matched = words.map(word => [word, chipForWord(word, chips)]).filter(([, hit]) => hit);
    if (!matched.length) return false;
    const tokens = [...(state.filters.vibe || [])];
    for (const [, hit] of matched) {
      if (hit.kind === 'vibe') { if (!tokens.includes(hit.id)) tokens.push(hit.id); }
      else { const chip = EXACT_CHIPS.find(item => item.id === hit.id); setAttributeValue(chip.attribute[0], chip.attribute[1], true); }
    }
    state.filters.vibe = tokens;
    input.value = words.filter(word => !matched.some(([hit]) => hit === word)).join(' ');
    return true;
  }
  function findSimilarStyle(artist) {
    // Starting from an artist page means "like this artist", so earlier chips do not leak into it.
    state.filters.like = cleanText(artist, 160); state.filters.vibe = []; state.page = 1;
    loadList({ scroll: 0 });
  }

  function buildFilters() {
    const form = el('form', { className: 'artist-library-filters', attrs: { 'aria-label': '筛选画师' } });
    const queryLabel = el('label', { className: 'artist-library-search' }, [el('span', { className: 'artist-library-control-label', text: '画师或画风' })]);
    const query = el('input', {
      name: 'query', value: state.filters.query,
      attrs: { type: 'search', placeholder: '搜索画师名，或「水彩 梦幻」', autocomplete: 'off' }
    });
    // The image-search mode sits ON the search box, the way "search by image" is understood
    // everywhere, so the filter grid keeps its four columns and nothing is re-flowed.
    // New layout: the filter groups live in a panel under the search line, opened by 筛选.
    const filterToggle = button('✦ 画风', 'artist-library-filter-toggle', { 'data-new-layout-only': '', 'aria-expanded': 'false' });
    const queryRow = el('div', { className: 'artist-library-search-row' }, [query, ...(SIMILAR_SEARCH_ENABLED ? [similarActionButton] : []), filterToggle]);
    // Results follow the typing, so 查找 is optional; an IME composition is committed first.
    let typingTimer = 0;
    const typed = () => {
      clearTimeout(typingTimer);
      typingTimer = setTimeout(async () => {
        if (await absorbChipWords(query)) { syncFiltersFromForm(form); state.page = 1; scheduleFilterSearch(); return; }
        if (query.value.trim() === state.filters.query) return;
        syncFiltersFromForm(form);
        state.page = 1;
        scheduleFilterSearch();
      }, 350);
    };
    query.addEventListener('input', event => { if (!event.isComposing) typed(); });
    query.addEventListener('compositionend', typed);
    queryLabel.append(queryRow);
    const modelLabel = el('label', {}, [el('span', { className: 'artist-library-control-label', text: '模型' })]);
    const model = el('select', { name: 'model' });
    for (const [value, label] of MODEL_OPTIONS) model.append(el('option', { value, text: label }));
    model.value = state.filters.model;
    modelLabel.append(model);
    const sortLabel = el('label', {}, [el('span', { className: 'artist-library-control-label', text: '排序' })]);
    const sort = el('select', { name: 'sort', attrs: { 'aria-label': '画师排序方式' } });
    for (const option of ARTIST_SORT_OPTIONS) sort.append(el('option', { value: option.value, text: option.label }));
    sort.value = normalizeArtistSort(state.filters.sort);
    sortLabel.append(sort);
    const favorite = checkboxLabel('收藏', state.filters.favorite);
    favorite.input.name = 'favorite';
    const annotated = checkboxLabel('有标注', state.filters.annotated);
    annotated.input.name = 'annotated';
    const confirmed = checkboxLabel('已确认', state.filters.confirmedOnly);
    confirmed.input.name = 'confirmedOnly';
    const controls = el('div', { className: 'artist-library-filter-main' }, [
      queryLabel, modelLabel, sortLabel,
      button('查找', 'primary artist-library-search-button')
    ]);
    controls.lastElementChild.type = 'submit';
    const facetGrid = el('div', { className: 'artist-library-facet-grid' });
    for (const facet of STYLE_FACETS) {
      const fieldset = el('fieldset');
      fieldset.append(el('legend', { text: facet.label }));
      for (const option of facet.options) {
        const item = checkboxLabel(option.label, state.filters.facets[facet.key]?.includes(option.value));
        item.label.className += ' artist-library-option'; item.label.dataset.styleValue = option.value;
        item.input.name = `facet-${facet.key}`;
        item.input.value = option.value;
        fieldset.append(item.label);
      }
      facetGrid.append(fieldset);
    }
    const facetDisclosure = el('details', { className: 'artist-library-facet-disclosure' });
    const defaultOpen = false;
    facetDisclosure.open = state.facetPanelOpen === null ? defaultOpen : state.facetPanelOpen;
    const facetSummary = el('summary', { text: filterGroupLabel('画风特征', countSelectedFacets(state.filters.facets)) });
    facetDisclosure.append(
      facetSummary,
      facetGrid
    );
    facetDisclosure.addEventListener('toggle', () => { state.facetPanelOpen = facetDisclosure.open; });
    facetGrid.addEventListener('change', () => {
      state.facetPanelOpen = facetDisclosure.open;
      syncFiltersFromForm(form, true);
      state.page = 1;
      scheduleFilterSearch();
    });
    const clear = button('清除筛选', 'ghost artist-library-clear');
    clear.addEventListener('click', () => {
      state.filters = createLibraryState().filters;
      state.page = 1;
      scheduleFilterSearch();
    });
    const scopes = el('div', { className: 'artist-library-filter-scopes' }, [favorite.label, annotated.label, confirmed.label, clear]);
    const detailedFilters = (auxiliary = false) => {
      const stateKey = auxiliary ? 'auxiliaryPanelOpen' : 'refinedPanelOpen';
      const disclosure = el('details', { className: auxiliary ? 'artist-library-auxiliary-filters' : 'artist-library-refined-filters' });
      disclosure.open = state[stateKey];
      const definitions = STYLE_ATTRIBUTES.filter(definition => ['composition', 'work'].includes(definition.group) === auxiliary);
      const selected = definitions.reduce((total, definition) => total + (state.filters.attributes[definition.key]?.length || 0), 0);
      disclosure.append(el('summary', { text: filterGroupLabel(auxiliary ? '构图与作品类型' : '细化特征', selected) }));
      const grid = el('div', { className: 'artist-library-attribute-grid' });
      const changed = () => {
        state[stateKey] = disclosure.open;
        syncFiltersFromForm(form);
        state.page = 1;
        scheduleFilterSearch();
      };
      for (const definition of definitions) grid.append(attributeFieldset(definition, state.filters.attributes[definition.key] || [], 'attribute-'));
      disclosure.append(grid);
      disclosure.addEventListener('toggle', () => { state[stateKey] = disclosure.open; });
      disclosure.addEventListener('change', changed);
      return disclosure;
    };
    const collapse = button('收起', 'artist-library-filter-collapse', { 'data-new-layout-only': '' });
    // Quick row: model, sort and 收藏 move into one scrolling line with the active-choice pills; while a
    // style ranking is active the sort select gives way to a 画风相近 label (the server orders by style).
    const styleSort = el('span', { className: 'artist-library-style-sort', text: '画风相近' });
    const quickRow = el('div', { className: 'artist-library-quickrow' }, [modelLabel, sortLabel, styleSort, favorite.label, el('div', { className: 'artist-active-pills', attrs: { 'data-artist-active-pills': 'true' } })]);
    const more = el('details', { className: 'artist-library-more-filters' }, [el('summary', { text: '更多标注筛选' }), scopes, facetDisclosure, detailedFilters(), detailedFilters(true)]);
    more.open = Boolean(state.moreFiltersOpen);
    more.addEventListener('toggle', () => { state.moreFiltersOpen = more.open; });
    form.append(controls, quickRow, vibePanel(), more, collapse);
    renderQuickRow(form);
    form.toggleAttribute('data-filtered', libraryFiltersActive(state.filters));
    const setPanelOpen = open => {
      form.classList.toggle('filters-open', open);
      filterToggle.setAttribute('aria-expanded', String(open));
      if (open) renderVibePanel(form.querySelector('[data-artist-vibe]'));
      // The first group opens with the panel; the long ones stay folded until asked.
      if (open && !form.querySelector('details[open]')) facetDisclosure.open = true;
    };
    filterToggle.addEventListener('click', () => setPanelOpen(!form.classList.contains('filters-open')));
    collapse.addEventListener('click', () => { setPanelOpen(false); filterToggle.scrollIntoView({ block: 'nearest' }); });
    filterToggle.textContent = filterPanelLabel(state.filters);
    form.addEventListener('submit', event => {
      event.preventDefault();
      syncFiltersFromForm(form);
      state.page = 1;
      scheduleFilterSearch();
    });
    model.addEventListener('change', () => {
      syncFiltersFromForm(form);
      state.page = 1;
      scheduleFilterSearch();
    });
    sort.addEventListener('change', () => {
      state.sortTouched = true;
      syncFiltersFromForm(form);
      state.page = 1;
      scheduleFilterSearch();
    });
    favorite.input.addEventListener('change', () => {
      syncFiltersFromForm(form);
      state.page = 1;
      scheduleFilterSearch();
    });
    annotated.input.addEventListener('change', () => {
      syncFiltersFromForm(form);
      state.page = 1;
      scheduleFilterSearch();
    });
    confirmed.input.addEventListener('change', () => {
      syncFiltersFromForm(form);
      state.page = 1;
      scheduleFilterSearch();
    });
    return form;
  }

  function syncFilterControls() {
    const form = body.querySelector('.artist-library-filters'); if (!form) return;
    for (const input of form.querySelectorAll('input, select')) {
      if (input.name.startsWith('attribute-')) input.checked = Boolean(state.filters.attributes[input.name.slice(10)]?.includes(input.value));
      else if (input.name.startsWith('facet-')) input.checked = Boolean(state.filters.facets[input.name.slice(6)]?.includes(input.value));
      else if (['favorite', 'annotated', 'confirmedOnly'].includes(input.name)) input.checked = state.filters[input.name];
      else if (['query', 'model', 'sort'].includes(input.name)) input.value = input.name === 'sort' ? normalizeArtistSort(state.filters.sort) : state.filters[input.name];
    }
    form.querySelector('.artist-library-facet-disclosure').querySelector('summary').textContent = filterGroupLabel('画风特征', countSelectedFacets(state.filters.facets));
    for (const [selector, auxiliary, label] of [['.artist-library-refined-filters', false, '细化特征'], ['.artist-library-auxiliary-filters', true, '构图与作品类型']]) {
      const count = STYLE_ATTRIBUTES.filter(item => ['composition', 'work'].includes(item.group) === auxiliary).reduce((sum, item) => sum + (state.filters.attributes[item.key]?.length || 0), 0);
      form.querySelector(selector).querySelector('summary').textContent = filterGroupLabel(label, count);
    }
    form.toggleAttribute('data-filtered', libraryFiltersActive(state.filters));
    renderVibePanel(form.querySelector('[data-artist-vibe]'));
    renderQuickRow(form);
    const toggle = form.querySelector('.artist-library-filter-toggle');
    if (toggle) toggle.textContent = filterPanelLabel(state.filters);
  }

  function scheduleFilterSearch() {
    scrollRevision += 1;
    syncFilterControls();
    gates.list.cancel(); controllers.get('list')?.abort();
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { filterTimer = 0; if (isOpen() && state.view === 'list') loadList({ scroll: null }); }, 100);
  }

  function renderEvidenceChips(container, profile, exampleId = '', limit = 3, confirmedOnly = false) {
    const dynamic = Boolean(container.dataset.exampleEvidence);
    chipLayouts.get(container)?.(); chipLayouts.delete(container);
    const evidence = facetEvidenceForExample(profile, exampleId, confirmedOnly);
    if (!evidence.length) {
      // A designed pending state rather than a bare grey string: an image with no
      // confirmed tags yet is a normal state, so it reads as a label that invites the
      // annotation instead of looking like a failure to load.
      container.append(el('span', {
        className: 'artist-library-chip is-pending',
        text: '待标注',
        attrs: { 'data-evidence-pending': 'true', title: '这张例图还没有画风特征标注' }
      }));
      return;
    }
    if (dynamic) { limit = evidence.length; container.className = 'artist-library-chips artist-library-chip-fit'; container.dataset.chipFit = 'true'; }
    const groupFor = label => STYLE_ATTRIBUTES.find(definition => label.startsWith(`${definition.label} · `))?.group || label;
    const groups = new Set(), selected = evidence.filter(item => { const group = groupFor(item.label); if (groups.has(group)) return false; groups.add(group); return true; }).slice(0, limit);
    for (const item of evidence) { if (selected.length >= limit) break; if (!selected.includes(item)) selected.push(item); }
    selected.forEach(({ label, automatic, visual }) => container.append(el('span', {
      className: `artist-library-chip${automatic ? ' is-automatic' : ''}`,
      text: label.split(' · ').slice(1).join(' · ') || label,
      attrs: { ...(dynamic ? { 'data-fit-chip': 'true' } : {}), 'data-automatic': automatic ? 'true' : 'false', title: automatic ? visual ? 'AI 逐图观察，尚未经人工确认' : '来自 D 站作品标签，尚未经人工确认' : '已人工确认的例图特征' }
    })));
    if (dynamic) {
      container.append(el('span', { className: 'artist-library-chip', text: `+${evidence.length}`, hidden: true, attrs: { 'data-fit-more': 'true' } }));
      chipLayouts.set(container, observeFittedChips(container));
    } else if (evidence.length > limit) container.append(el('span', { className: 'artist-library-chip', text: `+${evidence.length - limit}` }));
  }

  // One compact, readable line instead of three short ones with wide gaps. Facts are
  // grouped so the meaning survives wrapping: the example breakdown is parenthesised
  // and the cover is labelled, because "原作参考 原作" (a source followed by a model)
  // read as one run-on phrase before.
  function renderCoverEvidence(container, profile) {
    container.replaceChildren();
    const examples = profile?.examples || [];
    // Describe the example that is actually the cover, not whichever was saved last:
    // the two differ once a cover is chosen or a sample is filed, and the chips must
    // describe the same picture the heading names.
    const cover = examples.find(item => item.id === profile?.coverExampleId) || examples[0];
    const counts = examples.reduce((totals, item) => {
      const key = item.sourceType === 'nax' || item.sourceType === 'original' ? item.sourceType : 'generated';
      totals[key] += 1;
      return totals;
    }, { nax: 0, generated: 0, original: 0 });
    const parts = [];
    if (examples.length) {
      const breakdown = [['original', '原作'], ['generated', '生成'], ['nax', 'NAX']]
        .filter(([key]) => counts[key]).map(([key, label]) => `${label} ${counts[key]}`).join(' / ');
      parts.push(`${examples.length} 张例图${breakdown ? `（${breakdown}）` : ''}`);
    } else {
      parts.push('尚无例图');
    }
    const posts = Number(profile.danbooru?.postCount);
    if (Number.isSafeInteger(posts) && posts > 0) parts.push(`D站 ${posts} 帖`);
    // One calm typographic line plus chips. The kind and the model were separate pills
    // here, which stacked four different shapes (pill, text, pill, chips) in one narrow
    // column and read as a jumble.
    const facts = el('span', { className: 'artist-library-cover-facts', attrs: { 'data-cover-facts': 'true' } });
    for (const part of parts) facts.append(el('span', { text: part }));
    const meta = el('div', { className: 'artist-library-cover-meta' }, [
      el('span', { className: 'artist-library-cover-kind', text: profile?.indexed ? 'NAX V5 索引' : '自定义画师' }),
      facts
    ]);
    container.append(meta);
    if (cover) {
      const chips = el('div', { className: 'artist-library-chips' });
      renderEvidenceChips(chips, profile, cover.id);
      container.append(chips);
    }
  }

  function renderSampleEvidence(container, profile) {
    container.replaceChildren();
    const examples = Array.isArray(profile.examples) ? profile.examples : [];
    const model = state.filters.model || profile.evidenceSummary?.model || examples.find(example => example.sourceType === 'original')?.model || examples[0]?.model || '';
    const observations = Array.isArray(profile.observations) ? profile.observations : [];
    const reviewed = new Set(observations.filter(item => item.reviewed === true).map(item => item.exampleId));
    const visible = observations.filter(item => item.reviewed === true || (state.filters.includeAutomatic !== false && !state.filters.confirmedOnly && item.automatic === true && !reviewed.has(item.exampleId)));
    const summary = profile.evidenceSummary?.model === model && !state.filters.confirmedOnly && state.filters.includeAutomatic !== false
      ? profile.evidenceSummary : summarizeStyleEvidence(examples, visible, model);
    container.append(el('h3', { text: `${friendlyModel(model)} · ${summary.total || 0} 张` }));
    const features = Array.isArray(summary.features) ? summary.features : [];
    if (!features.length) {
      container.append(el('p', { className: 'artist-library-muted', text: '此模型暂无可判断的特征。' }));
      return;
    }
    const grid = el('div', { className: 'artist-library-evidence-grid' });
    for (const feature of features) {
      const definition = STYLE_ATTRIBUTES.find(item => item.key === feature.key);
      const option = definition?.options.find(item => item.value === feature.value);
      if (!option) continue;
      const evidence = el('details', { className: 'artist-library-evidence-feature' });
      const count = value => Math.max(0, Number(value) || 0);
      evidence.append(el('summary', {}, [
        el('strong', { text: `${definition.label} · ${option.label}` }),
        el('span', { text: `支持 ${count(feature.supporting)} / 可判断 ${count(feature.evaluable)} · 共 ${count(feature.total)} 张` })
      ]));
      evidence.append(el('small', { text: `${(feature.sources || []).map(evidenceSourceLabel).filter(Boolean).join(' · ')}${feature.confirmed ? ` · 人工确认 ${count(feature.confirmed)}` : ' · 尚未人工确认'}` }));
      const links = el('div', { className: 'artist-library-supporting-examples' });
      for (const id of [...new Set(feature.exampleIds || [])]) {
        const index = examples.findIndex(example => example.id === id && (!model || example.model === model));
        if (index < 0) continue;
        const jump = button(`例图 ${index + 1}`, 'ghost', { 'data-supporting-example': id, 'aria-label': `查看支持${option.label}的例图 ${index + 1}` });
        jump.addEventListener('click', () => {
          const card = [...body.querySelectorAll('[data-example-id]')].find(node => node.dataset.exampleId === id);
          if (!card) return;
          closeDetailPanels();
          card.setAttribute('tabindex', '-1');
          card.focus?.({ preventScroll: true });
          card.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
        });
        links.append(jump);
      }
      evidence.append(links);
      grid.append(evidence);
    }
    container.append(grid);
  }

  // Why this artist is on the list. Without it a ranked result is unfalsifiable: the
  // user cannot tell a real match from an artist nobody has annotated yet, which is
  // exactly why "未标注" is stated per property instead of being folded into a score.
  // Deliberately NOT a percentage — the project forbids presenting sample counts as an
  // artist score, and `命中 N/M 项` is a count of properties, not a quality claim.
  function styleMatchNote(profile) {
    const match = profile?.styleMatch;
    if (!match || !Array.isArray(match.perAxis) || !match.perAxis.length || !match.matched) return null;
    const labels = new Map(state.report.styleTerms.map(item => [item.key, item.label]));
    const parts = match.perAxis.slice(0, 4).map(axis => {
      const label = labels.get(axis.key) || axis.key;
      return axis.evaluated ? `${label} ${axis.hit}/${axis.evaluated}` : `${label} 未标注`;
    });
    // Reuses `.artist-library-card-meta` (a 2px grid of single-line ellipsised spans)
    // so the match line needs no new CSS and therefore no shell-cache bump.
    const note = el('small', { className: 'artist-library-card-meta artist-library-card-match', attrs: { 'data-artist-match': 'true' } });
    note.append(el('span', { text: `命中 ${match.matched}/${match.axes} 项` }));
    note.append(el('span', { text: parts.join(' · ') }));
    return note;
  }

  function renderArtistCard(profile) {
    const artist = cleanText(profile?.artist || profile?.name, 160);
    const card = el('article', { className: 'artist-library-card', attrs: { 'data-artist-card': artist } });
    const artwork = button('', 'artist-library-artwork', { 'aria-label': `查看 ${artist} 的资料与例图` });
    artwork.append(imageNode(profile?.coverUrl, `${artist} 的收藏例图`, 'artist-library-cover'));
    artwork.addEventListener('click', () => loadDetail(artist));
    const favorite = button(profile.favorite ? '★' : '☆', 'artist-library-card-favorite', {
      'aria-label': `${profile.favorite ? '取消收藏' : '收藏'} ${artist}`, 'aria-pressed': profile.favorite ? 'true' : 'false'
    });
    favorite.disabled = readOnly();
    favorite.addEventListener('click', () => {
      if (readOnly()) return;
      runMutation.run(`favorite:${artist}`, async () => {
        favorite.disabled = true;
        try {
          const result = await api('/api/artists/profile', { method: 'PUT', body: { artist, favorite: !profile.favorite } });
          if (!isOpen() || !favorite.isConnected) return;
          profile.favorite = Boolean(result?.artist?.favorite);
          favorite.textContent = profile.favorite ? '★' : '☆';
          favorite.setAttribute('aria-pressed', profile.favorite ? 'true' : 'false');
          favorite.setAttribute('aria-label', `${profile.favorite ? '取消收藏' : '收藏'} ${artist}`);
          notify(profile.favorite ? '已收藏画师。' : '已取消收藏。');
          if (state.view === 'list' && state.filters.favorite) await loadList();
        } finally {
          if (favorite.isConnected) favorite.disabled = readOnly();
        }
      }).catch(error => notify(errorMessage(error), 'error'));
    });
    card.append(artwork, favorite);
    const copy = el('div', { className: 'artist-library-card-copy' });
    const nameRow = el('div', { className: 'artist-library-card-name' }, [el('strong', { text: artist || '未命名画师' })]);
    copy.append(nameRow);
    if (profile?.aliases?.length) copy.append(el('small', { text: `别名：${profile.aliases.join(' · ')}` }));
    const statLine = danbooruStatLine(profile?.danbooru);
    copy.append(el('small', { className: 'artist-library-card-meta', attrs: { 'data-artist-stat-line': 'true' } }, [
      el('span', { text: `${Number(profile?.exampleCount) || 0} 张已保存例图${profile?.indexed ? ' · NAX 索引' : ' · 自定义资料'}` }),
      statLine ? el('span', { text: statLine }) : null
    ]));
    const statusLabel = danbooruStatusLabel(profile?.danbooruStatus);
    if (statusLabel) copy.append(el('small', { className: 'artist-library-card-status', attrs: { 'data-artist-status': profile.danbooruStatus.status }, text: statusLabel }));
    const matchNote = styleMatchNote(profile);
    if (matchNote) copy.append(matchNote);
    if (profile?.coverUrl) {
      copy.append(el('span', {
        className: 'artist-library-cover-badge',
        text: `${SOURCE_LABELS[profile.coverSourceType] || '收藏例图'} · ${friendlyModel(profile.coverModel)}`
      }));
    }
    const chips = el('div', { className: 'artist-library-chips' });
    const wantedChips = (state.filters.vibe || []).filter(token => !token.startsWith('-'));
    if (wantedChips.length && Array.isArray(profile?.styleHits)) {
      // Which chosen words this artist stands out on (top 10% for that word alone).
      chips.className = 'artist-vibe-hits';
      for (const id of wantedChips) chips.append(el('span', { className: `artist-vibe-hit${profile.styleHits.includes(id) ? ' is-hit' : ''}`, text: vibeLabel(id), attrs: { 'data-vibe-hit': id } }));
    } else {
      renderEvidenceChips(chips, profile, '', 3, state.filters.confirmedOnly);
      const pending = chips.querySelector('[data-evidence-pending]');
      if (pending && Array.isArray(profile?.vibeTags) && profile.vibeTags.length) {
        pending.replaceWith(el('span', { className: 'artist-library-chip is-vibe-tag', text: profile.vibeTags.join(' · '), attrs: { 'data-vibe-tags': 'true', title: '由图像风格自动得出，未经标注' } }));
      }
    }
    copy.append(chips);
    const actions = el('div', { className: 'artist-library-card-actions' });
    if (COMPARE_ENABLED) {
      const compare = button(state.compareArtists.includes(artist) ? '取消对比' : '加入对比', 'ghost', { 'data-artist-compare': artist });
      compare.setAttribute('aria-pressed', state.compareArtists.includes(artist) ? 'true' : 'false');
      compare.addEventListener('click', () => {
        if (!toggleComparison(state, artist)) {
          notify('最多同时对比 3 位画师。', 'error');
          return;
        }
        syncComparisonControls(dialog, state);
        renderCompareTray();
      });
      actions.append(compare);
    }
    const add = button('加入画风', 'primary');
    add.disabled = updateRole();
    add.addEventListener('click', () => runAddArtist(artist));
    actions.append(add);
    // New layout: a small ＋ on the picture (beside ☆) replaces the button row.
    const quickAdd = button('＋', 'artist-library-card-add', { 'data-new-layout-only': '', 'aria-label': `把 ${artist} 加入画风` });
    quickAdd.disabled = add.disabled;
    quickAdd.addEventListener('click', () => runAddArtist(artist));
    card.append(quickAdd, copy, actions);
    return card;
  }

  function renderPagination() {
    const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    const pagination = el('nav', { className: 'artist-library-pagination', attrs: { 'aria-label': '画师列表分页' } });
    const previous = button('上一页', 'ghost');
    previous.disabled = state.page <= 1;
    previous.addEventListener('click', () => { state.page -= 1; loadList(); });
    const next = button('下一页', 'ghost');
    next.disabled = state.page >= pages;
    next.addEventListener('click', () => { state.page += 1; loadList(); });
    const jump = el('form', { className: 'artist-library-page-jump', attrs: { 'aria-label': '直接跳至画师页码' } });
    const pageInput = el('input', { value: state.page, name: 'page', type: 'number', attrs: { min: '1', max: pages, step: '1', inputmode: 'numeric', 'aria-label': '画师页码' } });
    const go = button('跳转', 'ghost');
    go.type = 'submit';
    jump.append(el('span', { text: '第' }), pageInput, el('span', { text: `/ ${pages} 页` }), go);
    jump.addEventListener('submit', event => {
      event.preventDefault();
      const page = parseArtistPage(pageInput.value, pages);
      if (page === null || page === state.page) return;
      state.page = page;
      loadList();
    });
    pagination.append(previous, jump, next);
    return pagination;
  }

  function renderList() {
    cancelRequestsExcept('list');
    // 一份全新的列表被渲染出来时，之前暂存的那份已经过期：返回时不该再拿它盖住新结果。
    listDetailReturn = null;
    // 同理，「返回要弹回面板」也跟着那批结果一起过期：列表都是新的了，面板不该再冒出来。
    similarReturnPending = false;
    setLibraryView(state, 'list');
    activeProfile = null;
    title.textContent = '画师资料库';
    updateRole();
    const fragment = document.createDocumentFragment();
    const filters = body.querySelector('.artist-library-filters');
    let results = body.querySelector('[data-artist-results]');
    if (!filters || !results) {
      results = el('div', { attrs: { 'data-artist-results': 'true' } });
      body.replaceChildren(buildFilters(), results);
    }
    const summary = el('div', { className: 'artist-library-list-summary' }, [
      el('strong', { text: `找到 ${state.total} 位画师` }),
      // One note string rather than several siblings on purpose: this row is
      // `justify-content: space-between`, so extra children get spread across the full
      // width and reopen the "hole through the middle" defect this header already had
      // once (1.5.50). Keeping one child preserves the existing geometry.
      //
      // A typed word used to be reinterpreted silently: an unrecognized style word
      // became an artist-name substring search with no indication that it had. Every
      // word is now accounted for under the heading that explains how it was used.
      (() => {
        const queryNotes = [];
        if (state.filters.vibe?.length || state.filters.like) queryNotes.push(state.filters.like ? `按风格相近排序：像 ${state.filters.like}` : '按感觉排序');
        if (state.report.styleTerms.length) queryNotes.push(`画风特征：${state.report.styleTerms.map(item => item.label).join(' · ')}`);
        if (normalizeArtistSort(state.filters.sort) === 'relevance' && state.report.styleTerms.length) queryNotes.push('按相关性排序，卡片显示依据');
        if (state.report.nameTerms.length) queryNotes.push(`按画师名搜索：${state.report.nameTerms.join(' · ')}`);
        // Said plainly, and not folded into 画风特征: these words matched a sentence a machine wrote
        // about a picture. Calling that a property of the artist would be exactly the unsupported
        // style verdict this project forbids elsewhere.
        if (state.report.textTerms.length) queryNotes.push(`描述提及：${state.report.textTerms.join(' · ')}（来自机器标注的画面描述，未经人工确认）`);
        if (state.report.ambiguousTerms.length) queryNotes.push(`需指定：${state.report.ambiguousTerms.join(' · ')}（同时属于多个特征，请在下方“细化特征”勾选）`);
        if (state.report.unmatchedTerms.length) queryNotes.push(`未匹配：${state.report.unmatchedTerms.join('、')}`);
        return queryNotes.length
          ? el('span', { className: 'artist-library-query-note', attrs: { 'data-artist-query-notes': 'true' }, text: queryNotes.join(' · ') })
          : null;
      })()
    ]);
    const update = button('有新结果 · 更新', 'ghost', { 'data-artist-updates': 'true' }); update.hidden = true;
    update.addEventListener('click', () => loadList({ scroll: null })); summary.append(update);
    fragment.append(summary, renderPagination());
    if (!state.list.length) {
      fragment.append(el('div', { className: 'artist-library-state', text: '没有符合当前条件的画师。可以清除筛选或搜索其他名称。' }));
    } else {
      const grid = el('div', { className: 'artist-library-grid' });
      state.list.forEach(profile => grid.append(renderArtistCard(profile)));
      fragment.append(grid);
    }
    fragment.append(renderPagination());
    results.replaceChildren(fragment);
    pruneChipLayouts();
    renderedListSignature = JSON.stringify([state.list, state.total, state.report.unmatchedTerms]);
    if (pinned) {
      settlePinned();
      const frame = globalThis.requestAnimationFrame || (callback => callback());
      frame(() => settlePinned());
      setTimeout(() => { settlePinned(); pinned = null; pinObserver?.disconnect(); pinObserver = null; }, 400);
    }
    renderCompareTray();
  }

  async function loadList({ scroll = 0, clamped = false, background = false } = {}) {
    ensureDialog();
    clearTimeout(filterTimer); filterTimer = 0;
    scrollRevision += 1;
    cancelRequestsExcept('list');
    setLibraryView(state, 'list');
    title.textContent = '画师资料库';
    updateRole();
    const results = body.querySelector('[data-artist-results]');
    const partial = Boolean(results && body.querySelector('.artist-library-filters'));
    if (!partial) renderMessage('正在读取画师资料…');
    else if (!background) results.setAttribute('aria-busy', 'true');
    renderCompareTray();
    const request = startRequest('list');
    listPending = true;
    try {
      const data = await api(buildArtistListUrl(state.filters, state.page), request.signal ? { signal: request.signal } : {});
      if (!gates.list.isCurrent(request.token)) return;
      const list = Array.isArray(data?.artists) ? data.artists : [];
      const total = Math.max(0, Number(data?.total) || 0);
      // One assignment for the whole classification. It used to be five separate reads, five state
      // fields and eight fallbacks, which is how a new term type gets dropped in transit without any
      // error. The keys are named once, in `queryReportFrom`, and the render reads `state.report.*`
      // with no fallbacks of its own.
      const report = queryReportFrom(data);
      state.styleIndex = data?.styleIndex === true;
      // The app can gain its style data mid-session (画风数据 downloaded in 设置): forget the "unavailable" answer.
      if (state.styleIndex && vibeInfo && !vibeInfo.available) vibeInfo = null;
      if (background && partial) {
        const update = results.querySelector('[data-artist-updates]');
        if (update) update.hidden = JSON.stringify([list, total, report.unmatchedTerms]) === renderedListSignature;
        return;
      }
      state.list = list;
      state.total = total;
      const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
      if (state.page > pages) {
        state.page = pages;
        if (!clamped) return loadList({ scroll, clamped: true, background });
      }
      state.report = report;
      renderList();
      if (scroll !== null) restoreScroll(scroll);
    } catch (error) {
      if (!gates.list.isCurrent(request.token) || error?.name === 'AbortError') return;
      if (partial) {
        const update = results.querySelector('[data-artist-updates]'); if (update) { update.textContent = '更新失败 · 重试'; update.hidden = false; }
        if (!background) notify(`读取失败：${errorMessage(error)}`, 'error'); return;
      }
      renderMessage(`读取失败：${errorMessage(error)}`, 'error');
      const retry = button('重试', 'primary');
      retry.addEventListener('click', loadList);
      body.append(retry);
    } finally {
      if (gates.list.isCurrent(request.token)) { listPending = false; body.querySelector('[data-artist-results]')?.setAttribute('aria-busy', 'false'); }
      finishRequest('list', request.signal);
    }
  }

  function detailToolbar(profile, panels = [], { withAdd = true, extra = [] } = {}) {
    const bar = el('div', { className: 'artist-library-detail-toolbar' });
    const back = button('← 返回列表', 'ghost');
    back.addEventListener('click', returnToList);
    const compare = COMPARE_ENABLED ? button(state.compareArtists.includes(profile.artist) ? '取消对比' : '加入对比', 'ghost', { 'data-artist-compare': profile.artist }) : el('span', { attrs: { hidden: '' } });    if (COMPARE_ENABLED) compare.setAttribute('aria-pressed', state.compareArtists.includes(profile.artist) ? 'true' : 'false');
    compare.addEventListener('click', () => {
      if (!toggleComparison(state, profile.artist)) notify('最多同时对比 3 位画师。', 'error');
      syncComparisonControls(dialog, state);
      renderCompareTray();
    });
    const add = button('加入画风', 'primary');
    add.disabled = readOnly();
    add.addEventListener('click', () => runAddArtist(profile.artist));
    // 同步 D 站参数 was removed here: the 资料 panel already offers 刷新这位画师 and
    // 同步整个资料库 right beside the D站 numbers they update, so the toolbar copy was a
    // third way to do one job. Navigation and the decisions about this artist remain, and
    // the favourite toggle now sits here rather than buried in the 资料 form, because
    // whether an artist is a favourite is a judgement about the artist, not a profile
    // field.
    const favorite = favoriteToggle(profile);
    bar.append(back, ...(COMPARE_ENABLED ? [compare] : []), favorite, ...(withAdd ? [add] : []), ...extra);
    return bar;
  }

  // Immediate favourite toggle, shared by the detail toolbar. It updates the profile in
  // place so the list, the comparison tray and this page cannot disagree.
  function favoriteToggle(profile) {
    const artist = profile.artist;
    const label = () => (profile.favorite ? '★ 已收藏' : '☆ 收藏');
    const control = button(label(), 'ghost', {
      'data-artist-favorite': artist,
      'aria-pressed': profile.favorite ? 'true' : 'false',
      title: profile.favorite ? '取消收藏这位画师' : '收藏这位画师'
    });
    control.disabled = readOnly();
    control.addEventListener('click', () => {
      if (readOnly()) return;
      runMutation.run(`favorite:${artist}`, async () => {
        control.disabled = true;
        try {
          const result = await api('/api/artists/profile', { method: 'PUT', body: { artist, favorite: !profile.favorite } });
          profile.favorite = Boolean(result?.artist?.favorite);
          control.textContent = label();
          control.setAttribute('aria-pressed', profile.favorite ? 'true' : 'false');
          control.title = profile.favorite ? '取消收藏这位画师' : '收藏这位画师';
          notify(profile.favorite ? '已收藏画师。' : '已取消收藏。');
          acceptUpdatedProfile(result, artist);
          // 只看收藏 is a live view of this flag, so it is refreshed when it is in effect.
          if (isOpen() && state.view === 'list' && state.filters.favorite) await loadList();
        } finally {
          if (control.isConnected) control.disabled = readOnly();
        }
      }).catch(error => notify(errorMessage(error), 'error'));
    });
    return control;
  }

  // The detail toolbar used to carry a NAX button that either opened a redundant
  // dialog for a saved sample or fetched one over the network. A saved NAX sample
  // already renders inline in the examples list (its own NAX V5 group) and opens in
  // the normal example preview, so the button and its dialog were removed rather than
  // kept as a second way to see the same picture.

  // Parameters come from Danbooru by artist id, so one small round trip is
  // enough and a failure leaves the stored facts untouched.
  // Generates a sample batch for one artist on demand. The saved baseline still
  // decides the prompt, so this never reads the live editor and cannot disturb a
  // frozen baseline; it only decides who gets sampled. A missing baseline is reported
  // honestly instead of a baseline being invented.
  //
  // 只入队，不再顺带打开库级的「画师例图生成」面板：那次打开会把整份库级的例图生成状态
  // （GET /api/artists/rotation）重新读一遍并渲染，而用户要的只是一次单画师入队，
  // 面板本身既不是确认也不是必需。这里仍然是 1.5.41 的那一条路径、同一个请求，
  // 每位张数与预算都由服务端的 rotationPlan 从已保存基准推导（单画师上限 =
  // 每位张数 × 1），客户端不会、也不能替它放宽成整库预算。
  async function generateArtistSamples(profile) {
    if (manageLocked()) return;
    try {
      const result = await api('/api/artists/rotation', { method: 'POST', body: { action: 'start', artists: [profile.artist], route: rotationRoute() } });
      const count = result?.started?.count || 0;
      notify(`已为 ${profile.artist} 加入 ${count} 张例图任务；完成后可在图库的「例图样本」查看。`);
    } catch (error) {
      // A missing baseline is the one expected refusal, and it is actionable: point at the
      // settings that create one instead of inventing a baseline silently. The panel no
      // longer opens by itself, so the guidance also says where that baseline is saved.
      if (/尚未保存例图基准/.test(String(error?.message || ''))) {
        notify('还没有保存例图基准；请先打开「例图生成」，以当前工作台为基准保存。', 'error');
        return;
      }
      throw error;
    }
  }

  async function syncArtistStats(artist, { silent = false } = {}) {
    const result = await api('/api/artists/stats', { method: 'POST', body: { artist } });
    const stats = result?.stats || {};
    if (!silent && stats.requested) notify(danbooruSyncMessage(stats));
    if (stats.synced) {
      const refreshed = await api(`/api/artists/profile?artist=${encodeURIComponent(artist)}`);
      if (refreshed?.artist) acceptUpdatedProfile(refreshed, artist);
      if (state.view === 'list') refreshList();
    }
    return stats;
  }

  function syncAllArtistStats(syncButton, onProgress) {
    return (async () => {
      let synced = 0; let missing = 0; let skipped = 0; let failed = 0; let round = 0;
      while (round < 100) {
        round += 1;
        let stats;
        try { stats = (await api('/api/artists/stats', { method: 'POST', body: {} }))?.stats; }
        catch (error) { notify(errorMessage(error), 'error'); break; }
        if (!stats) break;
        synced += Number(stats.synced) || 0;
        missing += Number(stats.missing) || 0;
        skipped += Number(stats.skipped) || 0;
        failed += Number(stats.failed) || 0;
        onProgress?.(stats);
        if (syncButton.isConnected) syncButton.textContent = `同步中 · 已更新 ${synced}`;
        if (!stats.requested || (!stats.synced && !stats.missing && !stats.failed && !stats.skipped)) break;
      }
      return { synced, missing, skipped, failed };
    })();
  }

  function danbooruStatsPanel(profile) {
    const stats = danbooruStatsDetail(profile.danbooru);
    const list = el('dl', { className: 'artist-library-danbooru-list', attrs: { 'data-artist-danbooru': 'true' } });
    for (const [label, value] of [['D站帖子数', stats.posts], ['登记时间', stats.registered], ['资料更新', stats.updated]]) {
      list.append(el('dt', { text: label }), el('dd', { text: value }));
    }
    const links = el('dd', { className: 'artist-library-danbooru-links' });
    if (stats.homepages.length) {
      for (const url of stats.homepages.slice(0, 4)) {
        const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } })();
        links.append(el('a', { text: host, href: url, attrs: { target: '_blank', rel: 'noreferrer noopener' } }));
      }
    } else links.append(el('span', { text: '未同步' }));
    list.append(el('dt', { text: '外部主页' }), links);
    const refresh = button('刷新这位画师', 'ghost', { 'data-artist-stats-sync': 'true' });
    refresh.disabled = readOnly();
    const syncAll = button('同步整个资料库', 'ghost', { 'data-artist-stats-sync-all': 'true' });
    syncAll.disabled = readOnly();
    const progress = el('small', { className: 'artist-library-danbooru-progress', attrs: { 'data-artist-stats-progress': 'true', role: 'status' } });
    refresh.addEventListener('click', async () => {
      if (readOnly()) return;
      refresh.disabled = true;
      try { await syncArtistStats(profile.artist); }
      catch (error) { notify(errorMessage(error), 'error'); }
      finally { if (refresh.isConnected) refresh.disabled = readOnly(); }
    });
    syncAll.addEventListener('click', async () => {
      if (readOnly()) return;
      syncAll.disabled = true;
      progress.textContent = '正在同步…';
      let parsed = 0; let remaining = 0;
      try {
        const total = await syncAllArtistStats(syncAll, statsStep => {
          parsed += (Number(statsStep.synced) || 0) + (Number(statsStep.missing) || 0) + (Number(statsStep.failed) || 0) + (Number(statsStep.skipped) || 0);
          remaining = Number(statsStep.remaining) || 0;
          progress.textContent = `已处理 ${parsed} 位，剩余 ${remaining} 位。`;
        });
        progress.textContent = `本轮已更新 ${total.synced} 位，${total.missing} 位在 D 站已无可用记录，剩余 ${remaining} 位。`;
      } catch (error) { progress.textContent = ''; notify(errorMessage(error), 'error'); }
      finally { syncAll.disabled = readOnly(); syncAll.textContent = '同步整个资料库'; }
    });
    return el('section', { className: 'artist-library-danbooru' }, [
      el('h3', { text: 'D 站数据' }), list,
      el('div', { className: 'artist-library-danbooru-actions' }, [refresh, syncAll]),
      progress,
      el('small', { text: '参数来自 Danbooru，缺失时保持空白，不作为画风或质量判断。' })
    ]);
  }

  // Artist rotation has its own panel and its own server-side settings. The frozen
  // prompt is captured on demand and stored with the rotation, so the tag editor
  // can never reach it: editing tags cannot alter an already-saved rotation.
  function rotationPanel() {
    const section = el('section', { className: 'artist-library-rotation', attrs: { 'data-artist-rotation': 'true' } });
    const status = el('div', { className: 'artist-library-rotation-status', attrs: { 'data-rotation-status': 'true', role: 'status' } });
    const body = el('div', { className: 'artist-library-rotation-body' });
    let current = null;
    // The chosen artist names live at panel scope so a filtered result list and a
    // re-render cannot lose them.
    let pickedArtists = new Map();

    const captureButton = () => {
      const capture = button('以当前工作台为基准保存', 'primary', { 'data-rotation-capture': 'true' });
      capture.disabled = manageLocked();
      capture.addEventListener('click', () => save(capture));
      return capture;
    };

    const render = payload => {
      current = payload || null;
      body.replaceChildren();
      const config = current?.config;
      const progress = current?.progress;
      status.textContent = config
        ? `已保存基准 · 固定 ${config.total} 个 Tag${config.characterTags ? `（含角色 ${config.characterTags}）` : ''} · ${modelDisplayName(config.model) || config.model || '未知模型'}${config.steps ? ` · ${config.steps} 步` : ''}`
        : '尚未保存基准。它决定除画师以外固定哪些 Tag。';
      status.classList.toggle('is-ready', Boolean(config));

      if (!config) {
        body.append(
          el('p', { className: 'artist-library-muted', text: '先在工作台把要固定的 Prompt 与设置准备好，再回到这里点“以当前工作台为基准保存”。保存后修改工作台不会影响这里。' }),
          el('div', { className: 'artist-library-rotation-actions' }, [captureButton()]),
          settingsForm(null)
        );
        return;
      }

      // Details nobody needs every time: folded under 详细信息 at the end.
      const facts = el('dl', { className: 'artist-library-rotation-facts' });
      for (const [label, value] of [
        // The route is not part of the baseline, so it is stated as what it is: whatever is
        // selected now. It used to be frozen in, which is why changing 生成通道 had no
        // effect on example generation.
        ['生成通道', routeLabel(rotationRoute())],
        // The sample budget decides whether a generated sample can be filed at all: while it
        // was full the batch kept generating and paying while every sample was rejected.
        ['例图样本容量', current.capacity
          ? `${formatBytes(current.capacity.rotationBytes)} / ${formatBytes(current.capacity.rotationCap)}${current.capacity.rotationHeadroom < current.capacity.rotationAverageBytes ? ' · 剩余不足' : ` · 可用 ${formatBytes(current.capacity.rotationHeadroom)}`}`
          : '未知'],
        ['保存时间', new Date(config.capturedAt).toLocaleString('zh-CN')]
      ]) facts.append(el('dt', { text: label }), el('dd', { text: value }));
      const details = el('details', { className: 'artist-library-rotation-details' }, [el('summary', { text: '详细信息' }), facts]);
      const lowCapacity = current.capacity && current.capacity.rotationHeadroom < current.capacity.rotationAverageBytes;
      if (lowCapacity) details.open = true;
      // One-tap repair for samples that reached the gallery but were never filed. Idempotent,
      // so pressing it again is safe and simply reports what is left.
      if ((current.capacity?.rotationBytes ?? 0) > 0) {
        const repair = button('补归档未归档的例图样本', 'ghost', { 'data-rotation-backfill': 'true' });
        repair.addEventListener('click', async () => {
          repair.disabled = true;
          try {
            const result = (await api('/api/artists/rotation', { method: 'POST', body: { action: 'backfill', limit: 200 } }))?.backfill;
            const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
            notify(result
              ? `已补归档 ${result.archived} 张；本次尝试 ${result.attempted} 张，仍缺 ${result.remaining} 张${skipped.length ? `，跳过 ${skipped.length} 张（${skipped[0].reason}）` : ''}。`
              : '补归档未返回结果。');
            await load(true);
          } catch (error) { notify(error?.message || '补归档失败。'); } finally { repair.disabled = false; }
        });
        details.append(el('div', { className: 'artist-library-rotation-repair' }, [repair]));
      }

      const baseline = el('div', { className: 'artist-library-rotation-baseline' });
      if (config.promptPreview) baseline.append(el('p', { className: 'artist-library-rotation-prompt', attrs: { 'data-rotation-prompt': 'true' }, text: config.promptPreview }));
      // Character prompts are part of the fixed baseline, so they are shown rather
      // than left implicit.
      for (const character of config.characterPreviews || []) {
        const row = el('div', { className: 'artist-library-rotation-character', attrs: { 'data-rotation-character': 'true' } }, [
          el('strong', { text: `角色 ${character.name || '未命名'}` }),
          el('span', { text: character.prompt })
        ]);
        baseline.append(row);
      }
      body.append(baseline);

      // The order shown here is the order a run will use — the server computes both
      // from one function. It previously listed the top candidates by favourites/post
      // count while a run actually started with the artists that had no sample yet,
      // so the preview named artists that were never reached.
      const next = (current.nextArtists || []).map(item => item.artist);
      if (next.length) {
        body.append(el('small', { className: 'artist-library-rotation-hint', attrs: { 'data-rotation-next': 'true' },
          text: `本批将按此顺序开始：${next.join(' → ')}${(Number(current.poolTotal) || 0) > next.length ? ' …' : ''}` }));
      }
      // Already-generated versus not-yet, plus the true pool size. `候选` used to report
      // only one batch's worth, which made the library look far smaller than it is and hid
      // that later artists were out of reach.
      if (current.coverage) {
        const { covered = 0, pending = 0, totalImages = 0 } = current.coverage;
        const pool = Number(current.poolTotal) || current.coverage.candidates || 0;
        const batch = Number(config.maxArtists) || 0;
        body.append(el('small', { className: 'artist-library-rotation-hint', attrs: { 'data-rotation-coverage': 'true' },
          text: `库内候选 ${pool} 位：已生成 ${covered} 位 · 待生成 ${pending} 位 · 共 ${totalImages} 张；每批最多 ${batch} 位，再次生成会从未生成过的画师继续` }));
      }
      if (progress?.total) {
        const counts = progress.counts || {};
        body.append(el('small', { className: 'artist-library-rotation-hint', attrs: { 'data-rotation-progress': 'true' },
          text: `本批 ${progress.total} 张：完成 ${counts.done || 0} · 等待 ${counts.pending || 0} · 生成中 ${counts.running || 0} · 失败 ${counts.failed || 0}` }));
      }
      // Everything still queued, including earlier batches, so a second batch is
      // visibly accounted for instead of silently overlapping the first. The batch
      // total above only covers the most recent batch.
      if (current.queue?.images) {
        body.append(el('small', { className: 'artist-library-rotation-hint is-queued', attrs: { 'data-rotation-queue': 'true' },
          text: `队列中还有 ${current.queue.images} 张（${current.queue.artists} 位画师）未完成；再次生成会自动跳过这些画师，不会重复。` }));
      }

      const start = button('开始生成', 'primary', { 'data-rotation-start': 'true' });
      start.disabled = manageLocked();
      start.addEventListener('click', async () => {
        if (manageLocked()) return;
        start.disabled = true;
        try {
          const result = await api('/api/artists/rotation', { method: 'POST', body: { action: 'start', route: rotationRoute() } });
          const skipped = Number(result?.started?.skippedInFlight) || 0;
          notify(`已加入 ${result?.started?.count || 0} 张例图任务${skipped ? `；已跳过队列中的 ${skipped} 位画师` : ''}。结果进入图库的「例图样本」，不会写入画风标注。`);
          await load(true);
        } catch (error) { notify(errorMessage(error), 'error'); }
        finally { if (start.isConnected) start.disabled = manageLocked(); }
      });
      const cancel = button('取消本批', 'ghost', { 'data-rotation-cancel': 'true' });
      cancel.disabled = manageLocked() || !progress?.batchId;
      cancel.hidden = !progress?.batchId;
      cancel.addEventListener('click', async () => {
        if (manageLocked()) return;
        try { await api('/api/artists/rotation', { method: 'POST', body: { action: 'cancel' } }); notify('已请求取消本批例图生成。'); await load(true); }
        catch (error) { notify(errorMessage(error), 'error'); }
      });
      const clear = button('清除基准', 'ghost', { 'data-rotation-clear': 'true' });
      clear.disabled = manageLocked();
      // Clearing throws the frozen Tags away, so it takes a second tap within 3 s.
      let clearArmed = 0;
      clear.addEventListener('click', async () => {
        if (manageLocked()) return;
        if (!clearArmed) {
          clear.textContent = '再点一次清除';
          clear.classList.add('is-armed');
          clearArmed = setTimeout(() => { clearArmed = 0; clear.textContent = '清除基准'; clear.classList.remove('is-armed'); }, 3000);
          return;
        }
        clearTimeout(clearArmed); clearArmed = 0;
        try { await api('/api/artists/rotation', { method: 'PUT', body: { action: 'clear' } }); notify('已清除例图基准。'); await load(true); }
        catch (error) { notify(errorMessage(error), 'error'); }
      });
      const recapture = button('重新保存基准', 'ghost', { 'data-rotation-recapture': 'true' });
      recapture.disabled = manageLocked();
      recapture.addEventListener('click', () => save(recapture));
      baseline.append(el('div', { className: 'artist-library-rotation-baseline-actions' }, [recapture, clear]));
      body.append(el('div', { className: 'artist-library-rotation-actions' }, [start, cancel]), settingsForm(config), details);
    };

    async function load(silent = false) {
      try { render((await api('/api/artists/rotation'))?.rotation); }
      catch (error) { if (!silent) status.textContent = errorMessage(error); }
    }

    function readSettings() {
      const fields = body.querySelector('.artist-library-rotation-settings');
      if (!fields) return {};
      return {
        maxImages: Number(fields.querySelector('[name="rotation-max-images"]')?.value),
        perArtist: Number(fields.querySelector('[name="rotation-per-artist"]')?.value),
        maxArtists: Number(fields.querySelector('[name="rotation-max-artists"]')?.value),
        artistScope: fields.querySelector('[name="rotation-scope"]')?.value,
        // Read from the selection itself, not from the checkboxes on screen: the result
        // list is capped and filtered by the search box, so reading checked inputs
        // silently dropped every chosen artist that was not currently visible.
        artists: [...pickedArtists.values()],
        ...(fields.querySelector('[name="rotation-steps"]') ? { steps: Number(fields.querySelector('[name="rotation-steps"]').value) } : {})
      };
    }

    async function save(trigger) {
      if (manageLocked()) return;
      if (typeof captureRotationState !== 'function') { notify('当前页面无法读取工作台设置。', 'error'); return; }
      if (trigger) trigger.disabled = true;
      try {
        const state = await captureRotationState();
        if (!state) throw new Error('未能读取工作台设置。');
        render((await api('/api/artists/rotation', { method: 'PUT', body: { action: 'capture', state, ...readSettings() } }))?.rotation);
        notify('已保存例图基准；之后修改工作台不会影响它。');
      } catch (error) { notify(errorMessage(error), 'error'); }
      finally { if (trigger?.isConnected) trigger.disabled = manageLocked(); }
    }

    // Settings are saved on their own, without touching the frozen baseline: the
    // artist scope is a separate decision from what the prompt fixes.
    async function saveSettings(trigger) {
      if (manageLocked()) return;
      if (trigger) trigger.disabled = true;
      try {
        render((await api('/api/artists/rotation', { method: 'PUT', body: { action: 'settings', ...readSettings() } }))?.rotation);
        notify('已保存生成设置；基准 Prompt 未改变。');
      } catch (error) { notify(errorMessage(error), 'error'); }
      finally { if (trigger?.isConnected) trigger.disabled = manageLocked(); }
    }

    function settingsForm(config) {
      const form = el('div', { className: 'artist-library-rotation-settings' });
      const number = (name, label, value, min, max) => el('label', {}, [
        el('span', { text: label }),
        el('input', { name, type: 'number', value: value ?? '', attrs: { min: String(min), max: String(max), step: '1' } })
      ]);
      const scope = el('select', { name: 'rotation-scope' }, [
        el('option', { value: 'favorites-first', text: '收藏优先 → D站帖子数' }),
        el('option', { value: 'posts-first', text: '只看 D站帖子数' }),
        el('option', { value: 'selected', text: '仅指定的画师' })
      ]);
      scope.value = ['posts-first', 'selected'].includes(config?.artistScope) ? config.artistScope : 'favorites-first';
      form.append(
        number('rotation-max-images', '总张数上限', config?.maxImages ?? 40, 1, 2000),
        number('rotation-per-artist', '每位画师张数', config?.perArtist ?? 1, 1, 20),
        number('rotation-max-artists', '参与画师数', config?.maxArtists ?? 40, 1, 1000),
        el('label', {}, [el('span', { text: '画师顺序' }), scope])
      );
      // Only a saved baseline has steps; changing them keeps its frozen Tags.
      if (config?.steps) form.append(number('rotation-steps', '基准步数', config.steps, 1, 50));

      // The artist picker only matters for "仅指定的画师". It searches the whole
      // library rather than a fixed pool: the earlier version offered the current plan
      // pool, which for a saved selection contained only the already-chosen artists, so
      // a selection could never be extended — which is why picking artists appeared to
      // do nothing.
      const picker = el('div', { className: 'artist-library-rotation-picker', hidden: scope.value !== 'selected', attrs: { 'data-rotation-picker': 'true' } });
      // Held at panel scope so the chosen names survive a filtered result list and are
      // what gets saved.
      pickedArtists = new Map((config?.artists || []).map(name => [name.toLowerCase(), name]));
      const chosen = pickedArtists;
      const search = el('input', { name: 'rotation-artist-search', attrs: { placeholder: '搜索画师名后添加…', autocomplete: 'off' } });
      const count = el('small', { className: 'artist-library-rotation-hint', attrs: { 'data-rotation-picked': 'true' } });
      const chosenList = el('div', { className: 'artist-library-rotation-chosen', attrs: { 'data-rotation-chosen': 'true' } });
      const results = el('div', { className: 'artist-library-rotation-picker-list', attrs: { 'data-rotation-picker-list': 'true' } });
      const updateCount = () => {
        count.textContent = chosen.size ? `已选 ${chosen.size} 位` : '尚未选择画师';
        chosenList.replaceChildren(...[...chosen.entries()].map(([key, name]) => {
          const chip = el('button', { className: 'artist-library-rotation-chosen-chip', type: 'button',
            attrs: { 'data-rotation-remove': name, 'aria-label': `移除 ${name}`, title: '从名单中移除' } });
          chip.append(el('span', { text: name }), el('span', { className: 'artist-library-rotation-chosen-x', text: '×', attrs: { 'aria-hidden': 'true' } }));
          chip.addEventListener('click', () => { chosen.delete(key); updateCount(); paintRows(pickerRows); });
          return chip;
        }));
        chosenList.hidden = chosen.size === 0;
      };
      
      let pickerRows = [...(current?.pickerCandidates || [])];
      let pickerOffset = pickerRows.length;
      let pickerHasMore = Boolean(current?.pickerHasMore);
      let pickerLoading = false;
      let pickerGeneration = 0;
      const pickerPage = Math.max(1, Number(current?.pickerLimit) || 60);
      const rowFor = item => {
        const name = String(item.artist || '').trim();
        const key = name.toLowerCase();
        const label = el('label', { className: 'artist-library-rotation-candidate' });
        const box = el('input', { name: 'rotation-artist', type: 'checkbox', value: name, checked: chosen.has(key) });
        box.addEventListener('change', () => {
          if (box.checked) chosen.set(key, name); else chosen.delete(key);
          updateCount();
        });
        label.append(box, el('span', { text: name }));
        if (item.favorite) label.append(el('em', { text: '收藏' }));
        if (item.queued) label.append(el('em', { text: `队列 ${item.queued}` }));
        else if (item.rotationImages) label.append(el('em', { text: `已生成 ${item.rotationImages}` }));
        return label;
      };
      const paintRows = rows => {
        results.replaceChildren(...rows.map(rowFor));
        if (!rows.length) {
          // A name that is not in the pool can still be added: the picker must never be
          // a dead end just because an artist was never synced or scored.
          const trimmed = String(search.value || '').trim();
          if (trimmed) {
            const add = button(`添加「${trimmed}」`, 'ghost', { 'data-rotation-add-manual': trimmed });
            add.addEventListener('click', () => { chosen.set(trimmed.toLowerCase(), trimmed); updateCount(); search.value = ''; applyQuery(); });
            results.append(el('p', { className: 'artist-library-muted', text: '本地画师列表里没有匹配项，可仍按名称添加：' }), add);
          } else {
            results.append(el('p', { className: 'artist-library-muted', text: '输入关键词搜索画师。' }));
          }
        }
      };
      const loadPage = async ({ query = '', offset = 0, append = false } = {}) => {
        if (append && (pickerLoading || !pickerHasMore)) return;
        const token = pickerGeneration;
        pickerLoading = true;
        try {
          const params = new URLSearchParams({ offset: String(offset), limit: String(pickerPage) });
          if (query) params.set('q', query);
          const data = await api(`/api/artists/rotation/picker?${params}`);
          if (token !== pickerGeneration) return;
          const page = data?.picker || {};
          const artists = Array.isArray(page.artists) ? page.artists : [];
          if (append && !artists.length) { pickerHasMore = false; return; }
          pickerRows = append ? pickerRows.concat(artists) : artists;
          pickerOffset = (Number(page.offset) || offset) + artists.length;
          pickerHasMore = Boolean(page.hasMore);
          paintRows(pickerRows);
        } catch (error) {
          if (token !== pickerGeneration) return;
          if (!append) notify(errorMessage(error), 'error');
        } finally {
          if (token === pickerGeneration) pickerLoading = false;
        }
      };
      const applyQuery = () => {
        pickerGeneration += 1;
        pickerRows = [];
        pickerOffset = 0;
        pickerHasMore = true;
        loadPage({ query: String(search.value || '').trim(), offset: 0, append: false });
      };
      let searchTimer = 0;
      search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => applyQuery(), 120);
      });
      results.addEventListener('scroll', () => {
        if (!pickerHasMore || pickerLoading) return;
        if (results.scrollTop + results.clientHeight < results.scrollHeight - 48) return;
        loadPage({ query: String(search.value || '').trim(), offset: pickerOffset, append: true });
      });
      paintRows(pickerRows); updateCount();
      picker.append(
        el('small', { className: 'artist-library-muted', text: '搜索并勾选参与生成的画师；名单会保留。列表滚动加载，不必一次看完全库。' }),
        search, count, chosenList, results
      );
      scope.addEventListener('change', () => {
        picker.hidden = scope.value !== 'selected';
        if (scope.value === 'selected' && !results.childElementCount) paintRows(pickerRows);
      });
      form.append(picker);

      const saveButton = button('保存设置', 'ghost', { 'data-rotation-save-settings': 'true' });
      saveButton.disabled = manageLocked();
      saveButton.title = '只保存张数与画师范围，不改变基准 Prompt';
      saveButton.addEventListener('click', () => saveSettings(saveButton));
      // Before a baseline exists these values are saved together with it (保存基准 reads
      // them), and settings alone cannot be stored, so there is no separate button.
      if (config) form.append(el('div', { className: 'artist-library-rotation-settings-actions' }, [saveButton]));
      return form;
    }

    section.append(
      el('h3', { text: '画师例图生成' }),
      el('small', { className: 'artist-library-muted', text: '固定其他全部 Tag，只替换画师；产物是参考样本，不写入画风标注。' }),
      status, body
    );
    // Exposed so the panel can re-read progress and the next artists each time it is
    // opened. Building the library must not load this hidden whole-library panel.
    
    section.reload = () => load(Boolean(current));
    return section;
  }

  function profileEditor(profile) {
    const locked = readOnly();
    const form = el('form', { className: 'artist-library-profile-form' });
    // The favourite checkbox used to live here. It was moved to the detail toolbar, and
    // removed from this form entirely: the form sends its fields on save, so a stale
    // checkbox would silently undo a toggle made in the toolbar.
    const aliases = el('input', {
      name: 'aliases', value: (profile.aliases || []).join(', '), disabled: locked || !manageable(),
      attrs: { maxlength: '1211', placeholder: '最多 12 个，每个不超过 100 字符', autocomplete: 'off' }
    });
    const note = el('textarea', {
      name: 'note', value: profile.note || '', disabled: locked,
      attrs: { maxlength: '2000', rows: '3', placeholder: '记录适用题材、需要复核的观察等' }
    });
    note.textContent = profile.note || '';
    form.append(
      el('label', {}, [el('span', { text: '别名' }), aliases]),
      el('label', {}, [el('span', { text: '资料笔记' }), note]),
      danbooruStatsPanel(profile)
    );
    const save = button('保存资料', 'primary');
    save.type = 'submit';
    save.disabled = locked;
    form.append(save);
    const write = () => runMutation.run(`profile:${profile.artist}`, async () => {
      save.disabled = true;
      try {
        const result = await api('/api/artists/profile', {
          method: 'PUT',
          body: {
            artist: profile.artist,
            aliases: parseAliases(aliases.value),
            note: note.value
          }
        });
        notify('画师资料已保存。');
        acceptUpdatedProfile(result, profile.artist);
      } finally {
        if (save.isConnected) save.disabled = readOnly();
      }
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (readOnly()) return;
      write().catch(error => notify(errorMessage(error), 'error'));
    });
    return form;
  }

  function showExamplePreview(example, host) {
    host.replaceChildren();
    const panel = el('section', { className: 'artist-library-example-preview' });
    const closePreview = button('收起预览', 'ghost');
    closePreview.addEventListener('click', () => host.replaceChildren());
    panel.append(
      el('div', { className: 'artist-library-example-preview-head' }, [
        el('strong', { text: `${SOURCE_LABELS[example.sourceType] || '收藏例图'} · ${friendlyModel(example.model)}` }),
        closePreview
      ]),
      imageNode(example.previewUrl || example.thumbUrl, `${example.artist || activeProfile?.artist || ''} 例图`, 'artist-library-preview-image')
    );
    if (example.note) panel.append(el('p', { text: example.note }));
    host.append(panel);
    panel.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }

  function annotationEditor(profile, example, observation) {
    const locked = manageLocked();
    const details = el('details', { className: 'artist-library-annotation' });
    details.open = true;
    details.append(el('summary', { text: '编辑特征标注' }));
    const form = el('form');
    form.addEventListener('input', () => { form.dataset.dirty = 'true'; });
    form.addEventListener('change', () => { form.dataset.dirty = 'true'; });
    const facetGrid = el('div', { className: 'artist-library-annotation-facets' });
    const attributes = attributesForObservation(observation);
    for (const [group, label] of Object.entries(ATTRIBUTE_GROUP_LABELS)) {
      const section = el('details', { className: 'artist-library-annotation-group' });
      const definitions = STYLE_ATTRIBUTES.filter(definition => definition.group === group);
      const count = definitions.reduce((total, definition) => total + (attributes[definition.key]?.length || 0), 0);
      const heading = el('summary', { text: `${label}${count ? `（${count}）` : ''}` });
      section.append(heading);
      const grid = el('div', { className: 'artist-library-attribute-grid' });
      const updateCount = () => {
        form.dataset.dirty = 'true';
        const selected = [...grid.querySelectorAll('input')].filter(input => input.checked).length;
        heading.textContent = `${label}${selected ? `（${selected}）` : ''}`;
      };
      for (const definition of definitions) grid.append(attributeFieldset(definition, attributes[definition.key] || [], 'observation-', { disabled: locked, onSelectionChange: updateCount }));
      section.append(grid);
      facetGrid.append(section);
    }
    const note = el('textarea', {
      name: 'observation-note', disabled: locked,
      attrs: { rows: '2', maxlength: '2000', placeholder: '这项观察只对应当前例图' }
    });
    note.textContent = observation?.note || '';
    const save = button('保存已确认标注', 'primary');
    save.type = 'submit';
    save.disabled = locked;
    form.append(facetGrid, el('label', {}, [el('span', { text: '标注说明' }), note]), save);
    const write = () => runMutation.run(`observation:${example.id}`, async () => {
      form.dataset.dirty = 'true';
      const attributes = readAttributeForm(form, 'observation-');
      const facets = legacyFromAttributes(attributes);
      save.disabled = true;
      try {
        const result = await api('/api/artists/observations', {
          method: 'POST',
          body: { artist: profile.artist, exampleId: example.id, attributes, facets, schemaVersion: STYLE_SCHEMA_VERSION, note: note.value, reviewed: true }
        });
        notify('例图特征标注已保存。');
        acceptUpdatedProfile(result, profile.artist);
      } finally {
        if (save.isConnected) save.disabled = manageLocked();
      }
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (manageLocked()) return;
      write().catch(error => notify(errorMessage(error), 'error'));
    });
    details.append(form);
    return details;
  }

  // The cover marker and the cover action label both depend on which example is
  // the cover, so they are synced from one place — used when a card is built and
  // again when the profile changes in place (a cover change adds/removes no
  // example, so the structural diff alone would leave the card stale).
  function applyCoverMarker(card, isCover) {
    card.toggleAttribute('data-example-cover', Boolean(isCover));
    const host = card.querySelector('.artist-library-example-image-button');
    if (!host) return;
    const existing = host.querySelector('[data-example-cover-badge]');
    if (isCover && !existing) host.append(el('span', { className: 'artist-library-example-cover-badge', text: '封面', attrs: { 'data-example-cover-badge': 'true' } }));
    else if (!isCover && existing) existing.remove();
  }

  function syncCoverControls(card, profile) {
    const id = card.dataset.exampleId;
    const isCover = Boolean(id && profile.coverExampleId && profile.coverExampleId === id);
    const chosen = Boolean(isCover && profile.coverIsChosen);
    applyCoverMarker(card, isCover);
    const control = card.querySelector('[data-set-cover]');
    if (!control) return;
    control.textContent = chosen ? '恢复自动' : isCover ? '已是封面' : '设为封面';
    control.disabled = manageLocked() || (isCover && !chosen);
    control.title = chosen ? '取消手动指定，改回自动选择封面' : '把这张图设为该画师的封面';
    control.dataset.setCover = chosen ? '' : id;
  }

  function exampleCard(profile, example, previewHost) {
    const card = el('article', { className: 'artist-library-example-card', attrs: { 'data-example-id': example.id } });
    const imageButton = button('', 'artist-library-example-image-button', { 'aria-label': '查看大图' });
    // The thumbnail slot follows the image's own proportions inside a fixed card
    // height, so a landscape example gets a wide slot instead of floating small in
    // a portrait one. Cards stay uniform, so the grid never turns ragged.
    const ratio = Number(example.width) > 0 && Number(example.height) > 0 ? Number(example.width) / Number(example.height) : 0;
    if (ratio > 0) imageButton.style.setProperty('--example-ratio', String(Math.round(ratio * 1000) / 1000));
    else imageButton.dataset.exampleFluid = 'square';
    imageButton.append(imageNode(example.thumbUrl, `${profile.artist} 的例图`, 'artist-library-example-image'));
    const isStored = () => Boolean(example.id && profile.examples?.some(item => item.id === example.id));
    const openLarge = () => (isStored() ? openResult({ artist: profile.artist, exampleId: example.id }) : showExamplePreview(example, previewHost));
    imageButton.addEventListener('click', openLarge);
    const copy = el('div', { className: 'artist-library-example-copy' });
    if (example.model !== 'original') copy.append(el('strong', { text: friendlyModel(example.model) }));
    const sourceHref = safeSourceLink(example.sourceUrl);
    const actions = el('div', { className: 'artist-library-example-actions' });
    const show = button('预览', 'ghost');
    show.addEventListener('click', openLarge);
    const remove = button('删除', 'ghost danger');
    remove.disabled = manageLocked();
    const deleteWrite = () => runMutation.run(`delete:${example.id}`, async () => {
      if (!(await confirmAction('删除这张画师例图及其标注？此操作不会删除原图库图片。', { confirmLabel: '删除', danger: true }))) return;
      remove.disabled = true;
      try {
        await api(`/api/artists/examples/${encodeURIComponent(example.id)}`, { method: 'DELETE' });
        notify('例图已删除；原图库不受影响。');
        const refreshed = await api(`/api/artists/profile?artist=${encodeURIComponent(profile.artist)}`);
        acceptUpdatedProfile(refreshed, profile.artist);
      } finally {
        if (remove.isConnected) remove.disabled = manageLocked();
      }
    });
    remove.addEventListener('click', () => {
      if (manageLocked()) return;
      deleteWrite().catch(error => notify(errorMessage(error), 'error'));
    });
    // The other direction: this example was copied out of a gallery image, so that image
    // can be deleted with it in one step. Offered only when the link exists, so the
    // button never appears for an uploaded or NAX example with no gallery source.
    const galleryImageId = example.metadata?.galleryImageId ? String(example.metadata.galleryImageId) : '';
    const removeBoth = button('连原图一起删除', 'ghost danger', { 'data-delete-example-with-image': example.id });
    removeBoth.disabled = manageLocked();
    removeBoth.hidden = !galleryImageId;
    removeBoth.title = '删除这条例图及标注，并删除图库中的那张原图';
    removeBoth.addEventListener('click', () => {
      if (manageLocked()) return;
      runMutation.run(`delete-both:${example.id}`, async () => {
        if (!(await confirmAction('删除这条例图及其标注，并删除图库中的原图？此操作不可撤销。', { confirmLabel: '一起删除', danger: true }))) return;
        removeBoth.disabled = true;
        try {
          // The image goes first: it removes the derived example as part of the same
          // operation, so a failure here leaves nothing half-deleted.
          await api('/api/images/batch-delete', { method: 'POST', body: { ids: [galleryImageId] } });
          notify('例图与图库原图已一起删除。');
          const refreshed = await api(`/api/artists/profile?artist=${encodeURIComponent(profile.artist)}`);
          acceptUpdatedProfile(refreshed, profile.artist);
        } finally {
          if (removeBoth.isConnected) removeBoth.disabled = manageLocked();
        }
      }).catch(error => notify(errorMessage(error), 'error'));
    });
    const view = button('查看标注', 'ghost', { 'data-view-annotation': example.id });
    view.addEventListener('click', () => openResult({ artist: profile.artist, exampleId: example.id }));
    const menu = el('details', { className: 'artist-library-example-menu' });
    const menuSummary = el('summary', { attrs: { 'aria-label': '更多例图操作', title: '更多操作' } });
    menuSummary.append(el('span', { className: 'artist-library-example-menu-dots', text: '⋯', attrs: { 'aria-hidden': 'true' } }));
    menu.append(menuSummary);
    const menuBody = el('div', { className: 'artist-library-example-menu-body' });
    const meta = el('div', { className: 'artist-library-example-menu-meta' });
    if (example.width && example.height) meta.append(el('small', { text: `${example.width} × ${example.height}` }));
    if (example.note) meta.append(el('p', { text: example.note }));
    summarizeExampleMetadata(example).forEach(line => meta.append(el('small', { text: line })));
    if (meta.childElementCount) menuBody.append(meta);
    // One open menu at a time, closed by an outside click, Escape, or choosing an
    // action — re-clicking the same trigger is not required.
    menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      for (const other of document.querySelectorAll('.artist-library-example-menu[open]')) if (other !== menu) other.open = false;
      // The last card sits near the viewport bottom, so the menu flips above the
      // trigger when there is not enough room below; otherwise its lower half is
      // unreachable.
      const trigger = menuSummary.getBoundingClientRect();
      const available = window.innerHeight - trigger.bottom;
      menu.classList.toggle('is-above', available < Math.min(menuBody.scrollHeight || 260, 260) + 16 && trigger.top > available);
      // The popover hangs from the trigger's right edge; a trigger in the left column would
      // push it off the left of the screen, so it hangs from the left edge instead. (Phones
      // show it as a bottom sheet, see artist-library.css.)
      const width = menuBody.offsetWidth || 232;
      menu.classList.toggle('is-start', trigger.right - width < 8);
    });
    show.addEventListener('click', () => { menu.open = false; });
    remove.addEventListener('click', () => { menu.open = false; });
    const observations = (profile.observations || []).filter(item => item.exampleId === example.id);
    const observation = observations.find(item => item.reviewed === true) || observations.find(item => item.automatic !== true) || observations.find(item => item.automatic === true);
    const editor = makePanel('编辑标注', annotationEditor(profile, example, observation), 'annotation');
    editor.dataset.annotationPanel = example.id;
    const edit = button('编辑标注', 'primary');
    edit.disabled = manageLocked();
    edit.addEventListener('click', () => { menu.open = false; openPanel(editor); });
    // The menu reads as one primary row plus a compact grid of secondary actions,
    // instead of a stack of equally wide buttons competing for attention.
    // Editing, covers and deletion are management; a host without it keeps only the details.
    if (manageable()) menuBody.append(el('div', { className: 'artist-library-example-menu-primary' }, [edit]));
    const secondary = el('div', { className: 'artist-library-example-menu-actions' });
    // Three states, so cover control is complete: this image is the cover, this
    // image is the automatic cover (nothing to set), or it can become the cover.
    // The label is re-synced in place, so the handler reads it at click time
    // instead of trusting a value captured when the card was built.
    const cover = button('设为封面', 'ghost', { 'data-set-cover': example.id });
    cover.addEventListener('click', () => {
      if (manageLocked() || cover.disabled) return;
      menu.open = false;
      const nextId = cover.textContent.includes('恢复自动') ? '' : example.id;
      runMutation.run(`cover:${example.id}`, async () => {
        try {
          const refreshed = await api('/api/artists/cover', { method: 'POST', body: { artist: profile.artist, exampleId: nextId } });
          acceptUpdatedProfile({ artist: refreshed?.artist }, profile.artist);
          notify(nextId ? `已将这张图设为 ${profile.artist} 的封面。` : '已恢复自动选择封面。');
        } catch (error) { notify(errorMessage(error), 'error'); }
      }).catch(error => notify(errorMessage(error), 'error'));
    });
    secondary.append(cover, show, remove);
    // Kept next to 删除 so the two ways out of an example are side by side, and hidden
    // for an example with no gallery source.
    if (galleryImageId) {
      removeBoth.addEventListener('click', () => { menu.open = false; }, { once: true });
      secondary.append(removeBoth);
    }
    if (typeof onAnnotateExample === 'function' && example.sourceType === 'original' && example.model === 'original' && example.metadata?.provider === 'Danbooru' && ['g', 's', 'q', 'e'].includes(example.metadata?.rating)) {
      const trial = button('单张试标', 'ghost', { 'data-annotate-example': example.id });
      trial.disabled = manageLocked();
      trial.addEventListener('click', () => {
        if (manageLocked()) return;
        menu.open = false;
        Promise.resolve(onAnnotateExample(example)).catch(error => notify(errorMessage(error), 'error'));
      });
      secondary.append(trial);
    }
    // Every saved example can be the reference for "find artists that look like this",
    // which is the workflow the attribute filters could not serve: point at a picture
    // instead of naming a style.
    if (SIMILAR_SEARCH_ENABLED) {
      const similar = button('找相似画师', 'ghost', { 'data-similar-example': example.id });
      similar.addEventListener('click', () => {
        menu.open = false;
        openSimilarExample(example.id, example.artist || '这张例图');
      });
      secondary.append(similar);
    }
    if (manageable()) menuBody.append(secondary);
    const metadata = example.metadata && typeof example.metadata === 'object' ? example.metadata : {};
    if (metadata.prompt || metadata.negativePrompt || metadata.params) {
      const details = el('details', { className: 'artist-library-example-metadata' });
      details.append(el('summary', { text: '查看生成依据' }));
      if (metadata.prompt) details.append(el('p', { text: `Prompt：${cleanText(metadata.prompt, 8000)}` }));
      if (metadata.negativePrompt) details.append(el('p', { text: `UC：${cleanText(metadata.negativePrompt, 8000)}` }));
      if (metadata.params) {
        let paramsText = '';
        try { paramsText = JSON.stringify(metadata.params, null, 2); } catch { paramsText = '参数无法显示'; }
        details.append(el('pre', { text: paramsText.slice(0, 16000) }));
      }
      menuBody.append(details);
    }
    if (sourceHref) menuBody.append(el('a', { className: 'artist-library-example-menu-link', text: '打开来源链接 ↗', attrs: { href: sourceHref, target: '_blank', rel: 'noopener noreferrer' } }));
    menu.append(menuBody); actions.append(view, menu);
    const evidence = el('div', { className: 'artist-library-chips', attrs: { 'data-example-evidence': example.id } });
    renderEvidenceChips(evidence, profile, example.id);
    copy.append(evidence);
    // A quiet fact line under the chips: an example with few tags otherwise leaves most
    // of the card blank, and the stored dimensions are real information rather than
    // filler.
    const facts = [];
    if (Number(example.width) > 0 && Number(example.height) > 0) facts.push(`${example.width} × ${example.height}`);
    if (facts.length) copy.append(el('small', { className: 'artist-library-example-facts', attrs: { 'data-example-facts': 'true' }, text: facts.join(' · ') }));
    // The pending label is the obvious way to fix the emptiness, so it opens the
    // annotation editor directly. A visitor gets the label without the affordance.
    const pending = evidence.querySelector('[data-evidence-pending]');
    if (pending && !manageLocked()) {
      const action = el('button', { className: 'artist-library-chip is-pending is-action', type: 'button',
        attrs: { 'data-evidence-annotate': example.id, title: '为这张例图补充画风特征标注' } });
      action.append(el('span', { text: '待标注' }), el('span', { className: 'artist-library-chip-plus', text: '+' }));
      action.addEventListener('click', event => { event.stopPropagation(); openPanel(editor); });
      pending.replaceWith(action);
    }
    card.append(imageButton, copy, actions, editor);
    // One source of truth for the badge and the cover label, shared with the
    // in-place profile update.
    syncCoverControls(card, profile);
    return card;
  }

  // One-off mirror of the NAX previews onto this server. The panel is rebuilt on every open, so
  // the poller checks isConnected before rescheduling: an orphaned timer from a closed panel
  // must not keep requesting status.
  // A source handed in from an example card, so "找相似画师" on a specific image opens the
  // panel already pointed at it instead of asking the owner to pick again.
  let pendingSimilarSource = null;
  function openSimilarExample(id, label) {
    pendingSimilarSource = { kind: 'example', id, label };
    openPanel(similarPanelInstance);
  }

  // A source handed in from a gallery image — the image dialog's 「以此图搜索相似」 — so the panel
  // opens already pointed at that picture instead of asking for it to be uploaded again. The
  // server path (`kind=image`) is the same one the example entry uses, only the reference kind
  // differs.
  //
  // The panel is hosted by the artists tab and `openPanel` refuses a panel whose host is off
  // screen, so the tab switch has to happen FIRST and the open second: the order is the fix, not
  // a detail. `navigate()` is the hook `open()` already uses to bring the library on screen when
  // a detail is opened from another tab.
  function openSimilarImage(id, label) {
    if (!id) return;
    pendingSimilarSource = { kind: 'image', id, label };
    if (!hostOnScreen()) navigate();
    openPanel(similarPanelInstance);
  }

  // "Find artists that look like this image." The corpus is every saved artist example
  // reduced to a perceptual signature, and the query is an image the owner already owns —
  // so no vocabulary is involved and a style the schema cannot name is still reachable.
  // Low-level perception on purpose: it speaks about palette, tone, texture and negative
  // space, and claims nothing about subject matter.
  //
  // This panel is composed from the SAME vocabulary as 画师例图生成 / NAX 预览镜像, so it reads
  // as their sibling rather than as a new visual language: `artist-library-rotation-status`
  // for the one status line, `artist-library-rotation-facts` for the definition list,
  // `artist-library-rotation-actions` for action rows, `artist-library-rotation-hint` for
  // small print, `artist-library-source-group` for the reference-source block and
  // `.artist-library-similar-rule` for the two-choice rows.
  //
  // 这里只留操作这个控件所需的字：标签、当前参考图、比较方式、结果。只有两句不是装饰，
  // 谁清理文案都不要删掉它们 —— (1) 「像素接近不代表画风相同。」（本项目不摆没有依据的
  // 画风/质量结论）；(2) 上传控件的格式/体积提示与「只在本机读一次、不写进资料库」（隐私
  // 声明，不是说明文字）。面板以前把自己解释了一整段（模式理由、语料为什么是这样、长提
  // 示），那一段已按所有者要求删除。
  
  function similarPanel() {
    const section = el('section', { className: 'artist-library-similar', attrs: { 'data-similar': 'true' } });
    const status = el('div', { className: 'artist-library-rotation-status', attrs: { 'data-similar-status': 'true', role: 'status', text: '正在读取索引状态…' } });
    const indexHost = el('div', { className: 'artist-library-rotation-body', attrs: { 'data-similar-index': 'true' } });
    const settingsHost = el('div', { className: 'artist-library-similar-settings', attrs: { 'data-similar-settings': 'true' } });
    const sourceHost = el('div', { className: 'artist-library-similar-sources', attrs: { 'data-similar-sources': 'true' } });
    // `.artist-library-rotation-body` is the project's stacking container for a status block
    // (grid, 10px gap) and the NAX mirror panel already reuses it, so the facts list, the action
    // row and the small print keep the same rhythm here instead of being ad-hoc block flow.
    const resultsHost = el('div', { className: 'artist-library-rotation-body', attrs: { 'data-similar-results': 'true' } });
    // The reference is ALWAYS on screen — before, during and after a comparison. It used to
    // appear only inside the result block, so there was nothing saying which image was being
    // compared until a search had already come back.
    const currentHost = el('div', { className: 'artist-library-similar-current', attrs: { 'data-similar-current': 'true' } });
    section.append(
      el('h3', { text: '以图找相似画师' }),
      status, indexHost, settingsHost, sourceHost, resultsHost
    );
    let timer = 0;
    // Remembers the last reference so flipping the comparison rule re-queries the SAME image
    // instead of asking the owner to pick again.
    let lastSearch = null;
    let built = false;
    let fileName = null;
    let fileInput = null;
    let fileButton = null;
    let clearUpload = null;
    // Every comparison carries a token and only the newest one is allowed to render. The
    // reference and the combination rule can each re-query the same pipeline, so a slower
    // earlier response arriving last would otherwise overwrite the newer result. The same
    // class of defect the module's `createLatestRequestGate` exists for.
    let searchToken = 0;
    const stop = () => { if (timer) { clearTimeout(timer); timer = 0; } };
    const LABELS = { idle: '未开始', running: '进行中', paused: '已暂停' };

    function renderIndex(current) {
      indexHost.replaceChildren();
      const state = String(current?.state || 'idle');
      const total = Number(current?.total) || 0;
      const indexed = Number(current?.indexed) || 0;
      const facts = el('dl', { className: 'artist-library-rotation-facts' });
      for (const [label, value] of [
        ['索引状态', LABELS[state] || state],
        ['已索引', `${indexed} / ${total} 张`],
        ['待索引', `${Number(current?.pending) || 0} 张`],
        ['并发', `${Number(current?.concurrency) || 0}`]
      ]) facts.append(el('dt', { text: label }), el('dd', { text: value }));
      indexHost.append(facts);
      if (current?.lastError) indexHost.append(el('p', { className: 'artist-library-rotation-hint', text: `最近错误：${current.lastError}` }));
      const actions = el('div', { className: 'artist-library-rotation-actions' });
      // The server owns canStart/canPause; the panel only obeys, so a button can never be
      // disabled by a field name that stopped meaning what it used to (the 1.5.56 lesson).
      const start = button(state === 'paused' ? '继续索引' : '建立索引', 'primary', { 'data-similar-start': 'true' });
      start.disabled = current?.canStart !== true;
      start.addEventListener('click', async () => {
        start.disabled = true;
        try { await api('/api/artists/similarity', { method: 'POST', body: { action: 'start' } }); await load(); }
        catch (error) { status.textContent = error?.message || '无法开始索引。'; }
      });
      const pause = button('暂停', 'ghost', { 'data-similar-pause': 'true' });
      pause.disabled = current?.canPause !== true;
      pause.addEventListener('click', async () => {
        pause.disabled = true;
        try { await api('/api/artists/similarity', { method: 'POST', body: { action: 'pause' } }); await load(); }
        catch (error) { status.textContent = error?.message || '无法暂停索引。'; }
      });
      actions.append(start, pause);
      indexHost.append(actions);
      if (state === 'running' && section.isConnected) timer = setTimeout(load, 2500);
    }

    // ---------------------------------------------------------------------
    // 参考图来源：一个常驻的「当前参考图」+ 一个上传控件
    // ---------------------------------------------------------------------
    // There used to be a second, paged source here (「从你最近生成的图里选」, 24 thumbnails plus
    // 「看更多」). The owner cut it: it was ugly, and its cursor was broken — 「看更多」 repeated the
    // first images instead of continuing. A reference now comes from the upload control below or
    // from any example's 「更多」 → 「找相似画师」, and both paths land in the same reference block.
    function renderCurrentReference() {
      currentHost.replaceChildren();
      const source = lastSearch;
      if (!source) {
        currentHost.className = 'artist-library-similar-current is-empty';
        currentHost.append(el('div', { className: 'artist-library-similar-current-copy' }, [
          el('strong', { text: '当前参考图' }),
          el('small', { text: '还没有选。' })
        ]));
        return;
      }
      currentHost.className = 'artist-library-similar-current';
      // An uploaded reference exists only as this browser's object URL, so it MUST go through
      // `localImageNode`: `imageNode`'s safeApiImageUrl deliberately rejects `blob:` (so a URL
      // coming back from the API can never become an arbitrary one) and would render
      // 「暂无例图」 instead of the picture the owner just picked.
      const thumb = source.previewUrl
        ? localImageNode(source.previewUrl, '当前参考图（本次上传）', 'artist-library-similar-current-image')
        : source.thumbUrl
          ? imageNode(source.thumbUrl, '当前参考图', 'artist-library-similar-current-image')
          : el('div', { className: 'artist-library-similar-current-image artist-library-image-placeholder', text: '无' });
      currentHost.append(thumb, el('div', { className: 'artist-library-similar-current-copy' }, [
        el('strong', { text: '当前参考图' }),
        el('small', { attrs: { 'data-similar-current-label': 'true' }, text: source.label || '未命名图片' })
      ]));
    }

    function setPicked(file) {
      fileName.textContent = file ? `已选择 ${file.name}（${formatBytes(file.size)}）` : '尚未选择文件';
      fileButton.querySelector('.artist-library-file-button-text').textContent = file ? '重新选择' : '选择图片';
      clearUpload.hidden = !file;
    }

    async function uploadFile(file, { keepPreview = false } = {}) {
      if (!file) return;
      if (file.size > MAX_UPLOAD_BYTES) { status.textContent = '图片超过 12 MB。'; return; }
      // Release the previous upload's object URL before making another: an un-revoked blob URL
      // keeps its bytes alive for the life of the document, so comparing many candidates would
      // pile them up. `lastSearch` already holds it, so no extra state is needed. When the SAME
      // file is re-submitted (the owner flipped the comparison rule) the existing URL is
      // reused instead of revoked, or the preview would blink out and never come back.
      let previewUrl = keepPreview ? String(lastSearch?.previewUrl || '') : '';
      if (!previewUrl) {
        if (lastSearch?.previewUrl) URL.revokeObjectURL(lastSearch.previewUrl);
        previewUrl = URL.createObjectURL(file);
      }
      setPicked(file);
      // The File is kept so a rule change can re-POST the same bytes: an uploaded
      // reference has no id the server could be asked to re-read.
      lastSearch = { kind: 'upload', id: '', label: file.name, previewUrl, thumbUrl: '', file };
      renderCurrentReference();
      const token = ++searchToken;
      status.textContent = `正在读取并比对：${file.name}`;
      try {
        const data = await api(
          `/api/artists/similar?rule=${encodeURIComponent(state.similarRule)}&limit=24`,
          { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } }
        );
        if (token !== searchToken) return;
        status.textContent = '';
        renderResults(data);
      } catch (error) {
        if (token !== searchToken) return;
        status.textContent = error?.message || '这张图无法比对。';
      }
    }

    // Re-run the CURRENT reference after the combination rule changed. An upload
    // has to be re-posted (its bytes never reached the library), everything else is re-read by
    // kind + id — which is what keeps a rule flip from asking the owner to pick again.
    function reSearch() {
      if (!lastSearch) return;
      if (lastSearch.kind === 'upload' && lastSearch.file) { void uploadFile(lastSearch.file, { keepPreview: true }); return; }
      void searchWith(lastSearch.kind, lastSearch.id, lastSearch.label);
    }

    function buildSource() {
      // A real <button>-looking control instead of the native file input. The project only
      // ever styled `input[type="file"]` as `padding: 8px; font-size: 11px`, so it rendered as a
      // raw browser widget in the middle of a themed panel. The input stays in the document
      // (never `display:none`, which stops label-driven activation in some engines) and is moved
      // off-screen; the <label> is the visible, hoverable, focusable-from-the-input control.
      const uploadId = `artist-library-similar-upload-${Math.random().toString(36).slice(2, 8)}`;
      fileInput = el('input', {
        className: 'artist-library-file-input', type: 'file',
        attrs: { id: uploadId, accept: 'image/png,image/jpeg,image/webp', 'data-similar-upload': 'true', 'aria-describedby': `${uploadId}-hint` }
      });
      fileButton = el('label', { className: 'artist-library-file-button', attrs: { for: uploadId, 'data-similar-upload-label': 'true' } }, [
        el('span', { className: 'artist-library-file-button-plus', attrs: { 'aria-hidden': 'true' }, text: '＋' }),
        el('span', { className: 'artist-library-file-button-text', text: '选择图片' })
      ]);
      clearUpload = button('清除', 'ghost', { 'data-similar-upload-clear': 'true' });
      clearUpload.title = '清除当前参考图并重新开始';
      clearUpload.hidden = true;
      fileName = el('small', { className: 'artist-library-rotation-hint artist-library-similar-file', attrs: { 'data-similar-file': 'true' } });
      setPicked(null);
      fileInput.addEventListener('change', () => { void uploadFile(fileInput.files?.[0]); });
      clearUpload.addEventListener('click', () => {
        // Bumping the token also refuses a comparison that is still in flight: it belongs to the
        // reference that was just removed.
        searchToken += 1;
        fileInput.value = '';
        if (lastSearch?.previewUrl) URL.revokeObjectURL(lastSearch.previewUrl);
        lastSearch = null;
        setPicked(null);
        renderCurrentReference();
        renderResults(null);
        status.textContent = '已清除参考图。';
      });
      // No heading here: this is the only source left, and the reference block above already
      // says what a reference is. The block's top border is what separates the two.
      const uploadGroup = el('div', { className: 'artist-library-source-group', attrs: { 'data-similar-source-group': 'upload' } }, [
        el('div', { className: 'artist-library-similar-source-actions' }, [fileInput, fileButton, clearUpload]),
        fileName,
        el('small', { className: 'artist-library-rotation-hint', attrs: { id: `${uploadId}-hint` },
          text: '支持 PNG / JPEG / WebP，最大 12 MB。图片只在本机读一次用于比对，不会写进资料库。' })
      ]);
      sourceHost.replaceChildren(currentHost, uploadGroup);
      renderCurrentReference();
      renderResults(null);
    }

    function renderRuleToggle() {
      for (const choice of settingsHost.querySelectorAll('[data-similar-rule-value]')) {
        const active = choice.dataset.similarRuleValue === state.similarRule;
        choice.className = active ? 'primary' : 'ghost';
        choice.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }

    function buildSettings() {
      // The two combination rules read the SAME stored vectors, so flipping this re-queries
      // without re-indexing or re-decoding anything. It exists so the owner can compare both
      // orders on the SAME reference image — the one thing this agent cannot do here, and the
      // only test that decides whether 「最严」 is actually better rather than merely more
      // decisive (a bigger head spread is not the same as a more correct one).
      const rule = el('div', { className: 'artist-library-similar-rule', attrs: { 'data-similar-rule': 'true' } });
      rule.append(el('small', { className: 'artist-library-muted', text: '比较方式' }));
      for (const [value, label, hint] of [['mean', '平均', '七个方面平均来看接近'], ['worst', '最严', '每个方面都不能差太远']]) {
        const choice = button(label, state.similarRule === value ? 'primary' : 'ghost', { 'data-similar-rule-value': value });
        choice.title = hint;
        choice.setAttribute('aria-pressed', state.similarRule === value ? 'true' : 'false');
        choice.addEventListener('click', () => {
          if (state.similarRule === value) return;
          state.similarRule = value;
          renderRuleToggle();
          reSearch();
        });
        rule.append(choice);
      }
      settingsHost.replaceChildren(rule);
    }

    async function searchWith(kind, id, label) {
      // A new reference replaces the previous one, so its object URL is released here too (the
      // upload path owns the one it created).
      if (lastSearch?.previewUrl && lastSearch.kind === 'upload') URL.revokeObjectURL(lastSearch.previewUrl);
      lastSearch = {
        kind, id, label, previewUrl: '',
        // The reference thumbnail is known up front (an example's own is derived from its id, a
        // gallery image's from the same route the gallery itself uses), so the current-reference
        // block is complete before the response arrives — it must never be blank while a search
        // runs.
        thumbUrl: kind === 'example' ? `/api/artists/examples/${encodeURIComponent(id)}/thumb`
          : kind === 'image' ? `/api/images/${encodeURIComponent(id)}/thumbnail` : ''
      };
      renderCurrentReference();
      const token = ++searchToken;
      status.textContent = `正在比对：${label}`;
      try {
        const data = await api(`/api/artists/similar?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}&rule=${encodeURIComponent(state.similarRule)}&limit=24`);
        if (token !== searchToken) return;
        status.textContent = '';
        renderResults(data);
      } catch (error) {
        if (token !== searchToken) return;
        status.textContent = error?.message || '比对失败。';
      }
    }

    function renderResults(data) {
      resultsHost.replaceChildren();
      // No reference, no results and no copy: the reference block above already says 「还没有选。」
      // and the upload control says what to do about it.
      if (!data) return;
      const query = data?.query || {};
      const corpus = Number(data?.corpus) || 0;
      // The current-reference block is refreshed from the response's own thumbUrl (an upload has
      // none — it keeps its local object URL).
      if (!lastSearch?.previewUrl && query.thumbUrl) lastSearch = { ...(lastSearch || { kind: query.kind, id: query.id, label: '' }), thumbUrl: query.thumbUrl };
      renderCurrentReference();
      resultsHost.append(el('div', { className: 'artist-library-gallery-head' }, [el('strong', { text: '比较结果' })]));
      resultsHost.append(el('small', { className: 'artist-library-rotation-hint', attrs: { 'data-similar-summary': 'true' },
        // No score, no percentage, no 「最佳」: the figure is a count of artists inside this
        // query's own near-band, and the claim stays at the pixel level. The closing sentence is
        // NOT decoration to be trimmed later: a similarity ranking invites the reading "this is
        // the same style", and this project does not present a claim it cannot support.
        text: `全库已索引 ${corpus} 张例图，像素层面接近的有 ${Number(data?.close) || 0} 位画师。像素接近不代表画风相同。` }));
      const list = Array.isArray(data?.artists) ? data.artists : [];
      if (!list.length) {
        resultsHost.append(el('p', { className: 'artist-library-state', text: corpus ? '没有找到相近的画师。' : '还没有索引：请先点上面的“建立索引”。' }));
        return;
      }
      const grid = el('div', { className: 'artist-library-grid' });
      for (const item of list) {
        const card = el('article', { className: 'artist-library-card', attrs: { 'data-similar-artist': item.artist } });
        const artwork = button('', 'artist-library-artwork', { 'aria-label': `查看 ${item.artist} 的资料` });
        artwork.append(imageNode(item.exampleUrl, `${item.artist} 最接近的例图`, 'artist-library-cover'));
        // The panel MUST close before navigating. It is a modal <dialog>, so loading the artist
        // detail behind it left the owner looking at an unchanged panel — the click was working,
        // the result was simply invisible underneath it.
        // 另一半在这里：这一层详情是面板给的，所以「返回」要把它连同这批结果放回来（见
        // returnToList / restoreSimilarPanel）。面板在关闭期间没有被重建，参考图与结果列表
        // 都还在原处，重新弹出即可。
        artwork.addEventListener('click', () => { similarPanelInstance?.close(); loadDetail(item.artist, { fromSimilarPanel: true }); });
        card.append(artwork);
        const copy = el('div', { className: 'artist-library-card-copy' });
        copy.append(el('div', { className: 'artist-library-card-name' }, [
          el('strong', { text: item.artist }),
          item.isSource ? el('small', { text: '来源' }) : null
        ]));
        copy.append(el('small', { className: 'artist-library-card-meta' }, [
          el('span', { text: `${item.band} · 接近的例图 ${item.closeCount}/${item.examples}${item.model ? ` · ${friendlyModel(item.model)}` : ''}` }),
          // Which aspects matched is the part a user can argue with; a bare score is not.
          el('span', { text: item.blocks.filter(block => block.distance <= 0.12).map(block => block.label).join(' · ') || '无明显接近项' })
        ]));
        const add = button('加入画风', 'ghost');
        add.disabled = readOnly();
        add.addEventListener('click', () => runAddArtist(item.artist));
        copy.append(add);
        card.append(copy);
        grid.append(card);
      }
      resultsHost.append(grid);
    }

    async function load() {
      stop();
      try {
        const status_ = (await api('/api/artists/similarity'))?.similarity;
        renderIndex(status_);
        status.textContent = '';
      } catch (error) {
        status.textContent = error?.message || '索引状态暂不可用';
        return;
      }
      // Built once, then only the live numbers are re-rendered on each open — the panel is
      // opened through `onBeforeOpen`, never through makePanel's unwired `refresh` factory.
      if (!built) { built = true; buildSettings(); buildSource(); }
      const pending = pendingSimilarSource;
      if (pending) {
        pendingSimilarSource = null;
        await searchWith(pending.kind, pending.id, pending.label);
      }
    }

    // Not loaded at construction: the panel is opened through onBeforeOpen, so fetching here
    // would issue requests for a panel nobody opened (the lesson recorded for makePanel).
    section.reload = load;
    return section;
  }

  function naxMirrorPanel() {
    const section = el('section', { className: 'artist-library-nax-mirror', attrs: { 'data-nax-mirror': 'true' } });
    const status = el('div', { className: 'artist-library-rotation-status', attrs: { 'data-nax-mirror-status': 'true', role: 'status', text: '正在读取镜像状态…' } });
    const body = el('div', { className: 'artist-library-rotation-body' });
    section.append(status, body);
    let timer = 0;
    const stop = () => { if (timer) { clearTimeout(timer); timer = 0; } };
    const LABELS = { idle: '未开始', running: '进行中', paused: '已暂停', completed: '已完成' };
    function render(current) {
      stop();
      body.replaceChildren();
      const state = String(current?.state || 'idle');
      const store = current?.store || {};
      const facts = el('dl', { className: 'artist-library-rotation-facts' });
      for (const [label, value] of [
        ['状态', LABELS[state] || state],
        ['已归档', `${Number(current?.filed) || 0} 位`],
        ['本次待处理', `${Number(current?.pending) || 0} 位`],
        ['本轮归档', `${Number(current?.filedThisRun) || 0} 位`],
        ['无对照图', `${Number(current?.misses) || 0} 位`],
        ['失败', `${Number(current?.failures) || 0} 位`],
        ['本地占用', formatBytes(store.naxPreviewBytes || 0)]
      ]) facts.append(el('dt', { text: label }), el('dd', { text: value }));
      body.append(facts);
      if (current?.lastError) body.append(el('p', { className: 'artist-library-rotation-hint', text: `最近错误：${current.lastError}` }));
      const actions = el('div', { className: 'artist-library-rotation-actions' });
      // The server owns whether the job can start or stop; the panel only obeys. Deciding here
      // from a field name is how this button once ended up disabled by an undefined value.
      const start = button(state === 'paused' ? '继续镜像' : '开始镜像', 'primary', { 'data-nax-mirror-start': 'true' });
      start.disabled = current?.canStart === false || state === 'running';
      start.addEventListener('click', async () => {
        start.disabled = true;
        try { await api('/api/nax/mirror', { method: 'POST', body: { action: state === 'paused' ? 'resume' : 'start' } }); await load(); }
        catch (error) { status.textContent = error?.message || '无法开始镜像。'; }
      });
      const pause = button('暂停', 'ghost', { 'data-nax-mirror-pause': 'true' });
      pause.disabled = current?.canPause !== true;
      pause.addEventListener('click', async () => {
        pause.disabled = true;
        try { await api('/api/nax/mirror', { method: 'POST', body: { action: 'pause' } }); await load(); }
        catch (error) { status.textContent = error?.message || '无法暂停镜像。'; }
      });
      actions.append(start, pause);
      body.append(actions);
      body.append(el('small', { className: 'artist-library-rotation-hint', attrs: { 'data-nax-mirror-note': 'true' },
        text: '一次性作业：完成后浏览画师不再访问 NAX。已决定的画师（包括“没有对照图”）不会重复请求；可随时暂停，继续时只补未完成的部分。' }));
      if (state === 'running' && section.isConnected) timer = setTimeout(load, 2000);
    }
    async function load() {
      stop();
      try { render((await api('/api/nax/mirror'))?.mirror); status.textContent = ''; }
      catch (error) { status.textContent = error?.message || '镜像状态暂不可用'; }
    }
    // Not loaded here: the panel is opened through onBeforeOpen, so fetching at construction
    // would issue a request on every page load for a panel nobody opened.
    section.reload = load;
    return section;
  }

  // Mirrored NAX reference images, shown as their own block and never mixed into the example
  // groups. They are a separate class on the server too: excluded from every example count, from
  // the cover choice and from the annotation backlog.
  
  function naxPreviewSection(profile, previewHost) {
    const list = Array.isArray(profile?.naxPreviews) ? profile.naxPreviews : [];
    if (!list.length) return null;
    const wrap = el('section', { className: 'artist-library-examples', attrs: { 'data-artist-nax-previews': 'true' } });
    wrap.append(el('h3', { text: `NAX 参考图 · ${list.length}`, attrs: { 'data-nax-preview-total': 'true' } }));
    const grid = el('div', { className: 'artist-library-example-grid', attrs: { 'data-example-grid': 'true' } });
    for (const item of list) grid.append(exampleCard(profile, item, previewHost));
    wrap.append(grid);
    wrap.append(el('small', { className: 'artist-library-muted', attrs: { 'data-nax-preview-note': 'true' },
      text: '来自 NAX V5 画廊的第三方参考图；不计入例图统计，也不会成为封面。' }));
    return wrap;
  }

  function examplesSection(profile, previewHost) {
    const wrap = el('section', { className: 'artist-library-examples', attrs: { 'data-artist-examples': 'true' } });
    wrap.append(el('h3', { text: `例图 · ${profile.examples?.length || 0}`, attrs: { 'data-example-total': 'true' } }));
    const groups = groupExamplesBySource(profile.examples);
    for (const source of ['nax', 'generated', 'original']) {
      const section = el('section', { className: 'artist-library-source-group', attrs: { 'data-example-source': source } });
      section.hidden = !groups[source].length;
      section.append(el('h4', { text: `${SOURCE_LABELS[source]} · ${groups[source].length}`, attrs: { 'data-source-count': 'true' } }));
      if (!groups[source].length) {
        section.append(el('p', { className: 'artist-library-muted', text: '尚未保存此来源的例图。', attrs: { 'data-source-empty': 'true' } }));
      } else {
        const grid = el('div', { className: 'artist-library-example-grid', attrs: { 'data-example-grid': 'true' } });
        groups[source].forEach(example => grid.append(exampleCard(profile, example, previewHost)));
        section.append(grid);
      }
      wrap.append(section);
    }
    return wrap;
  }

  function uploadPanel(profile) {
    const locked = manageLocked();
    const section = el('section', { className: 'artist-library-add-examples' });
    section.append(el('h3', { text: '添加例图' }));
    const naxRow = el('div', { className: 'artist-library-nax-row' });
    const naxPreview = button('预览 NAX V5', 'ghost');
    naxPreview.disabled = !profile.indexed;
    naxPreview.addEventListener('click', () => runPreviewArtist(profile.artist));
    const saveNax = button('保存 NAX 例图', 'primary');
    saveNax.disabled = locked || !profile.indexed;
    const saveNaxWrite = () => runMutation.run(`nax:${profile.artist}`, async () => {
      saveNax.disabled = true;
      try {
        const result = await api('/api/artists/examples/nax', { method: 'POST', body: { artist: profile.artist } });
        notify('NAX V5 例图已保存。');
        acceptUpdatedProfile(result, profile.artist);
      } finally {
        if (saveNax.isConnected) saveNax.disabled = manageLocked() || !profile.indexed;
      }
    });
    saveNax.addEventListener('click', () => {
      if (manageLocked()) return;
      saveNaxWrite().catch(error => notify(errorMessage(error), 'error'));
    });
    naxRow.append(naxPreview, saveNax);

    const uploadForm = el('form', { className: 'artist-library-upload-form' });
    const file = el('input', { name: 'file', disabled: locked, attrs: { type: 'file', accept: 'image/png,image/jpeg,image/webp' } });
    const source = el('select', { name: 'sourceType', disabled: locked }, [
      el('option', { value: 'generated', text: '生成图' }), el('option', { value: 'original', text: '原作参考' })
    ]);
    const model = el('select', { name: 'model', disabled: locked });
    MODEL_OPTIONS.slice(1).forEach(([value, label]) => model.append(el('option', { value, text: label })));
    model.value = 'unknown';
    source.addEventListener('change', () => {
      if (source.value === 'original') model.value = 'original';
      else if (model.value === 'original') model.value = 'unknown';
    });
    const sourceUrl = el('input', { name: 'sourceUrl', disabled: locked, attrs: { type: 'url', maxlength: '2000', placeholder: '可选：来源链接（仅记录，不抓取）' } });
    const note = el('input', { name: 'note', disabled: locked, attrs: { maxlength: '2000', placeholder: '可选：例图说明' } });
    const upload = button('上传并保存', 'primary');
    upload.type = 'submit';
    upload.disabled = locked;
    uploadForm.append(
      el('label', {}, [el('span', { text: '本地图片（PNG/JPEG/WebP，≤12 MiB）' }), file]),
      el('label', {}, [el('span', { text: '来源类型' }), source]),
      el('label', {}, [el('span', { text: '对应模型' }), model]),
      el('label', {}, [el('span', { text: '来源链接' }), sourceUrl]),
      el('label', { className: 'artist-library-upload-note' }, [el('span', { text: '说明' }), note]),
      upload
    );
    const uploadWrite = () => runMutation.run(`upload:${profile.artist}`, async () => {
      const image = file.files?.[0];
      if (!image) throw new Error('请选择要保存的图片。');
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.type)) throw new Error('只支持 PNG、JPEG 或 WebP。');
      if (image.size > MAX_UPLOAD_BYTES) throw new Error('图片不能超过 12 MiB。');
      if (source.value === 'generated' && model.value === 'original') throw new Error('生成图请选择实际模型，无法判断时选“未知”。');
      const params = new URLSearchParams({ artist: profile.artist, sourceType: source.value, model: model.value });
      if (sourceUrl.value.trim()) params.set('sourceUrl', sourceUrl.value.trim());
      if (note.value.trim()) params.set('note', note.value.trim());
      upload.disabled = true;
      try {
        const result = await api(`/api/artists/examples/upload?${params}`, {
          method: 'POST', body: image, headers: { 'Content-Type': image.type }
        });
        notify('例图已上传并保存。');
        acceptUpdatedProfile(result, profile.artist);
      } finally {
        if (upload.isConnected) upload.disabled = manageLocked();
      }
    });
    uploadForm.addEventListener('submit', event => {
      event.preventDefault();
      if (manageLocked()) return;
      uploadWrite().catch(error => notify(errorMessage(error), 'error'));
    });
    const gallery = el('div', { className: 'artist-library-gallery-picker' });
    const openGallery = button('从最近图库选择', 'ghost');
    openGallery.disabled = locked;
    openGallery.addEventListener('click', () => loadGalleryPicker(profile, gallery));
    gallery.append(openGallery);
    section.append(naxRow, uploadForm, gallery);
    return section;
  }

  async function loadGalleryPicker(profile, host) {
    if (manageLocked()) return;
    host.replaceChildren(el('div', { className: 'artist-library-state', text: '正在读取最近图库…' }));
    const request = startRequest('gallery');
    try {
      const data = await api('/api/images?picker=1&page=1&limit=24', request.signal ? { signal: request.signal } : {});
      if (!gates.gallery.isCurrent(request.token)) return;
      const images = normalizeGalleryResponse(data);
      host.replaceChildren();
      const head = el('div', { className: 'artist-library-gallery-head' }, [el('strong', { text: '最近图库' })]);
      const closePicker = button('收起', 'ghost');
      closePicker.addEventListener('click', () => host.replaceChildren(buttonForGallery(profile, host)));
      head.append(closePicker);
      host.append(head);
      if (!images.length) {
        host.append(el('p', { className: 'artist-library-muted', text: '图库中暂无可选择的图片。' }));
        return;
      }
      const grid = el('div', { className: 'artist-library-gallery-grid' });
      images.forEach(image => {
        const choice = button('', 'artist-library-gallery-choice', { 'aria-label': `选择图库图片${image.seed ? `，Seed ${image.seed}` : ''}` });
        choice.append(imageNode(image.thumbUrl, '最近图库图片', 'artist-library-gallery-image'));
        if (image.seed !== undefined && image.seed !== null) choice.append(el('span', { text: `Seed ${image.seed}` }));
        const write = () => runMutation.run(`gallery:${profile.artist}:${image.id}`, async () => {
          choice.disabled = true;
          try {
            const result = await api('/api/artists/examples/gallery', { method: 'POST', body: { artist: profile.artist, imageId: image.id } });
            notify('图库图片已复制到画师资料。');
            acceptUpdatedProfile(result, profile.artist);
          } finally {
            if (choice.isConnected) choice.disabled = manageLocked();
          }
        });
        choice.addEventListener('click', () => {
          if (manageLocked()) return;
          write().catch(error => notify(errorMessage(error), 'error'));
        });
        grid.append(choice);
      });
      host.append(grid);
    } catch (error) {
      if (!gates.gallery.isCurrent(request.token) || error?.name === 'AbortError') return;
      host.replaceChildren(el('div', { className: 'artist-library-state is-error', text: `读取图库失败：${errorMessage(error)}`, attrs: { role: 'alert' } }), buttonForGallery(profile, host, '重试'));
    } finally {
      finishRequest('gallery', request.signal);
    }
  }

  function buttonForGallery(profile, host, label = '从最近图库选择') {
    const open = button(label, 'ghost');
    open.disabled = manageLocked();
    open.addEventListener('click', () => loadGalleryPicker(profile, host));
    return open;
  }

  // Detail page (2026-10-10): the pictures come first, then who the artist is and the one main
  // action, then every example with its annotation, the style overview and the profile, all on
  // one scrolling page. Library management (sample generation, annotation, rotation settings,
  // adding examples) is gathered in one ⋯ menu and only exists where canManage holds.
  function renderDetail(profile) {
    cancelRequestsExcept('detail');
    activeProfile = profile;
    setLibraryView(state, 'detail', profile.artist);
    title.textContent = profile.artist || '画师详情';
    updateRole();
    const fragment = document.createDocumentFragment();
    // 2026-10-11 (owner): v2's full-screen swiper pushed everything below the fold and buried
    // the actions at the bottom. Back to a compact head, with every action in one grid right
    // under it; 资料 and 画风概览 open as sheets again.
    const profilePanel = makePanel('资料', profileEditor(profile), 'profile');
    const upload = makePanel('添加例图', uploadPanel(profile), 'upload');
    const evidence = el('section', { className: 'artist-library-evidence-summary', attrs: { 'data-artist-evidence-summary': 'true' } });
    renderSampleEvidence(evidence, profile);
    const evidencePanel = makePanel('画风概览', evidence, 'evidence');
    fragment.append(detailToolbar(profile, [], { withAdd: false }));

    const hero = el('section', { className: 'artist-library-detail-hero' });
    const coverExample = (profile.examples || []).find(item => item.id === profile.coverExampleId);
    const cover = imageNode(profile.coverUrl, `${profile.artist} 的收藏例图`, 'artist-library-detail-cover');
    cover.dataset.artistDetailCover = 'true';
    if (coverExample) {
      cover.classList.add('is-openable');
      cover.addEventListener('click', () => openResult({ artist: profile.artist, exampleId: coverExample.id }));
    }
    const intro = el('div', { className: 'artist-library-detail-intro' }, [el('h2', { text: profile.artist })]);
    if (profile.aliases?.length) intro.append(el('p', { className: 'artist-library-detail-aliases', text: profile.aliases.join(' · ') }));
    const coverEvidence = el('div', { className: 'artist-library-cover-evidence', attrs: { 'data-artist-cover-evidence': 'true' } });
    renderCoverEvidence(coverEvidence, profile);
    const addArtist = button('加入画风', 'primary artist-library-detail-add');
    addArtist.disabled = readOnly();
    addArtist.addEventListener('click', () => runAddArtist(profile.artist));
    const vibeLine = el('div', { className: 'artist-library-detail-vibe', attrs: { 'data-artist-vibe-tags': 'true' } },
      (profile.vibeTags || []).map(label => el('span', { className: 'artist-library-detail-vibe-tag', text: label })));
    const overview = button('画风 ›', 'artist-library-detail-overview', { 'data-open-artist-panel': 'evidence', 'aria-label': '打开画风概览' });
    overview.addEventListener('click', () => openPanel(evidencePanel));
    vibeLine.append(overview);
    intro.append(coverEvidence, vibeLine, addArtist);
    hero.append(cover, intro);

    
    const actions = el('div', { className: 'artist-library-detail-actions artist-library-detail-iconbar', attrs: { role: 'group', 'aria-label': '画师操作' } });
    const action = (label, run, attrs = {}, icon = '') => {
      const control = button('', `artist-library-detail-icon-action${icon ? ` icon-${icon}` : ''}`, attrs);
      control.append(el('span', { className: 'artist-library-detail-icon', attrs: { 'aria-hidden': 'true' } }), el('span', { text: label }));
      control.addEventListener('click', run);
      actions.append(control);
      return control;
    };
    if (!manageLocked()) {
      const generate = action('生成例图', () => {
        if (manageLocked()) return;
        generate.disabled = true;
        Promise.resolve(generateArtistSamples(profile)).catch(error => notify(errorMessage(error), 'error'))
          .finally(() => { if (generate.isConnected) generate.disabled = manageLocked(); });
      }, { 'data-generate-artist-samples': profile.artist }, 'generate');
      generate.title = '只用这位画师跑一批例图；基准 Prompt 与其他设置沿用已保存的配置';
    }
    if (state.styleIndex || Array.isArray(profile.vibeTags)) action('找相似', () => findSimilarStyle(profile.artist), { 'data-artist-similar-style': profile.artist }, 'similar');
    action('笔记', () => openPanel(profilePanel), { 'data-open-artist-panel': 'profile' }, 'memo');
    if (!manageLocked()) action('添加例图', () => openPanel(upload), { 'data-open-artist-upload': 'true' }, 'add');
    actions.dataset.columns = String(actions.childElementCount);
    // The note's first line, when there is one; tapping it opens the same 资料 sheet.
    const noteText = cleanText(profile.note, 300).split('\n').find(Boolean) || '';
    const memo = noteText ? button('', 'artist-library-detail-memo', { 'data-artist-memo': 'true', 'aria-label': '打开笔记' }) : null;
    if (memo) { memo.append(el('b', { text: '笔记' }), el('span', { text: noteText })); memo.addEventListener('click', () => openPanel(profilePanel)); }

    const previewHost = el('div', { className: 'artist-library-preview-host', attrs: { 'data-artist-preview-host': 'true' } });
    fragment.append(...[hero, actions, memo, examplesSection(profile, previewHost), previewHost, naxPreviewSection(profile, previewHost),
      profilePanel, evidencePanel, upload].filter(Boolean));
    body.replaceChildren(fragment);
    pruneChipLayouts();
    renderCompareTray();
  }

  async function loadDetail(artist, { fromSimilarPanel = false } = {}) {
    ensureDialog();
    // 详情是从哪一层进来的，决定返回时要不要把「找相似画师」面板放回来。除了面板里那一次结果
    // 点击，其它每一次进入详情（列表卡片、open()、重试）都在这里把标记清掉，所以它不可能留到
    // 一次无关的返回上。
    similarReturnPending = Boolean(fromSimilarPanel);
    rememberListScroll();
    // 必须在 renderMessage 清空 body 之前留下列表这一层，返回时才不用重建它。
    rememberListForDetail();
    scrollRevision += 1;
    cancelRequestsExcept('detail');
    const name = cleanText(artist, 160);
    setLibraryView(state, 'detail', name);
    title.textContent = name || '画师详情';
    updateRole();
    renderMessage('正在读取画师资料…');
    renderCompareTray();
    const request = startRequest('detail');
    try {
      const data = await api(`/api/artists/profile?artist=${encodeURIComponent(name)}`, request.signal ? { signal: request.signal } : {});
      if (!gates.detail.isCurrent(request.token)) return;
      activeProfile = data.artist;
      renderDetail(activeProfile);
      restoreScroll(0);
    } catch (error) {
      if (!gates.detail.isCurrent(request.token) || error?.name === 'AbortError') return;
      renderMessage(`读取失败：${errorMessage(error)}`, 'error');
      const back = button('返回列表', 'ghost');
      back.addEventListener('click', returnToList);
      const retry = button('重试', 'primary');
      retry.addEventListener('click', () => loadDetail(name));
      body.append(el('div', { className: 'artist-library-state-actions' }, [back, retry]));
    } finally {
      finishRequest('detail', request.signal);
    }
  }

  function renderComparison(profiles) {
    cancelRequestsExcept('compare');
    state.view = 'compare';
    title.textContent = '画师对比';
    updateRole();
    const back = button(comparisonDetail ? '← 返回资料' : '← 返回列表', 'ghost');
    back.addEventListener('click', returnFromComparison);
    const section = el('section', { className: 'artist-library-comparison' });
    section.append(el('p', { className: 'artist-library-muted', text: '按例图查看特征；自动标签尚未确认，原作不代表 NAI 生成效果。' }));
    const grid = el('div', { className: 'artist-library-comparison-grid' });
    for (const profile of profiles) {
      const column = el('article', { className: 'artist-library-comparison-column' });
      column.append(el('h2', { text: profile.artist }));
      const examples = comparisonExamples(profile);
      if (!examples.length) {
        column.append(imageNode(profile.coverUrl, `${profile.artist} 的已保存例图`, 'artist-library-comparison-image'));
      } else {
        const examplesGrid = el('div', { className: 'artist-library-comparison-examples' });
        for (const example of examples) {
          const figure = el('figure');
          figure.append(
            imageNode(example.thumbUrl, `${profile.artist} 的已保存例图`, 'artist-library-comparison-image'),
            el('figcaption', { text: `${SOURCE_LABELS[example.sourceType] || '生成图'} · ${friendlyModel(example.model)}` })
          );
          summarizeExampleMetadata(example).forEach(line => figure.append(el('small', { text: line })));
          const evidence = el('div', { className: 'artist-library-chips' });
          renderEvidenceChips(evidence, profile, example.id);
          figure.append(evidence);
          examplesGrid.append(figure);
        }
        column.append(examplesGrid);
      }
      const actions = el('div', { className: 'artist-library-comparison-actions' });
      const detail = button('查看详情', 'ghost');
      detail.addEventListener('click', () => {
        if (comparisonDetail?.profile?.artist === profile.artist) returnFromComparison();
        else renderDetail(profile);
      });
      const remove = button('移出对比', 'ghost');
      remove.addEventListener('click', () => {
        toggleComparison(state, profile.artist);
        if (state.compareArtists.length < 2) returnFromComparison(); else loadComparison();
      });
      const add = button('加入画风', 'primary');
      add.disabled = readOnly();
      add.addEventListener('click', () => runAddArtist(profile.artist));
      actions.append(detail, remove, add);
      column.append(actions);
      grid.append(column);
    }
    section.append(grid);
    body.replaceChildren(back, section);
    renderCompareTray();
  }

  async function loadComparison() {
    if (state.compareArtists.length < 2) return;
    rememberListScroll();
    scrollRevision += 1;
    if (state.view === 'detail' && activeProfile) comparisonDetail = { profile: activeProfile, nodes: [...body.childNodes], scroll: readScroll() };
    else if (state.view !== 'compare') comparisonDetail = null;
    cancelRequestsExcept('compare');
    state.view = 'compare';
    title.textContent = '画师对比';
    renderMessage('正在读取对比资料…');
    const request = startRequest('compare');
    try {
      const profiles = await Promise.all(state.compareArtists.map(artist => api(
        `/api/artists/profile?artist=${encodeURIComponent(artist)}`,
        request.signal ? { signal: request.signal } : {}
      ).then(data => data.artist)));
      if (!gates.compare.isCurrent(request.token)) return;
      renderComparison(profiles);
      restoreScroll(0);
    } catch (error) {
      if (!gates.compare.isCurrent(request.token) || error?.name === 'AbortError') return;
      renderMessage(`读取对比失败：${errorMessage(error)}`, 'error');
      const back = button(comparisonDetail ? '返回资料' : '返回列表', 'ghost');
      back.addEventListener('click', returnFromComparison);
      body.append(back);
    } finally {
      finishRequest('compare', request.signal);
    }
  }

  function returnFromComparison() {
    if (!comparisonDetail) return returnToList();
    cancelRequestsExcept('detail');
    const saved = comparisonDetail;
    comparisonDetail = null;
    activeProfile = saved.updatedProfile || saved.profile;
    setLibraryView(state, 'detail', activeProfile.artist);
    title.textContent = activeProfile.artist;
    body.replaceChildren(...saved.nodes);
    for (const container of body.querySelectorAll('[data-chip-fit]')) if (!chipLayouts.has(container)) chipLayouts.set(container, observeFittedChips(container));
    if (saved.updatedProfile) updateDetailInPlace(saved.profile, saved.updatedProfile);
    updateRole();
    syncComparisonControls(dialog, state);
    renderCompareTray();
    restoreScroll(saved.scroll || 0);
  }

  
  function finishEntry(content) {
    const revision = ++entryRevision;
    const pending = Promise.resolve(content).finally(() => {
      if (revision !== entryRevision) return;
      entryPending = null;
      if (!isOpen()) return;
      // The visible list/profile owns the first request. Whole-library statistics
      // and background tasks are useful only after that content has settled.
      refreshSummary();
      refreshIngestion();
    });
    entryPending = pending;
    return pending;
  }

  function show() {
    ensureDialog();
    active = true;
    if (!embedded && !dialog.open) dialog.showModal();
    updateRole();
    renderIngestion();
    if (entryPending) return entryPending;
    return finishEntry(!body.childNodes.length ? loadList() : Promise.resolve());
  }

  function open(artist = '') {
    ensureDialog();
    active = true;
    if (!embedded && !dialog.open) dialog.showModal();
    renderIngestion();
    const name = cleanText(artist, 160);
    let content = entryPending || Promise.resolve();
    if (name) {
      if (taskPanel?.open) taskPanel.close();
      if (!(shouldApplyProfileUpdate(state, name) && activeProfile?.artist === name && body.querySelector('.artist-library-profile-form'))) content = loadDetail(name);
    } else if (!entryPending && (!embedded || !body.childNodes.length)) content = loadList();
    const pending = finishEntry(content);
    // Navigation calls show() synchronously in the app. Register the requested
    // view first so that callback waits for this content instead of loading a
    // default list and then aborting it to open the requested artist.
    if (!navigating) {
      navigating = true;
      try { navigate(); } finally { navigating = false; }
    }
    return pending;
  }

  function close() {
    if (embedded && active && state.view === 'compare') return returnFromComparison();
    if (embedded && active && state.view !== 'list') return returnToList();
    if (embedded) return;
    active = false;
    scrollRevision += 1;
    invalidateRequests();
    clearTimeout(localStatusTimer);
    clearTimeout(ingestionTimer);
    ingestionGate.cancel();
    ingestionController?.abort();
    if (localStatus) localStatus.hidden = true;
    if (dialog?.open) dialog.close();
  }

  // Host back navigation (the app's Android back button, via its cancelable
  // `nai-navigation-back` event). Returns true when the library consumed the step: an open
  // panel closes first, then a detail or comparison returns to the list. On the list it
  // returns false so the host can leave the tab. The website never calls it.
  function back() {
    if (!embedded || !active || !dialog?.isConnected) return false;
    const panel = [...dialog.querySelectorAll('dialog.artist-library-panel')].find(item => item.open);
    if (panel) { panel.close(); return true; }
    if (state.view === 'list') return false;
    close();
    return true;
  }

  function reset() {
    entryRevision += 1; entryPending = null;
    chipLayouts.forEach(dispose => dispose()); chipLayouts.clear();
    clearTimeout(filterTimer); filterTimer = 0; listPending = false; renderedListSignature = ''; coverageSignature = '';
    resultViewer.reset();
    closeDetailPanels(); if (taskPanel?.open) taskPanel.close();
    summaryRevision += 1; summaryController?.abort(); coverageHost?.replaceChildren();
    sessionRevision += 1;
    scrollRevision += 1;
    listScroll = 0;
    active = false;
    invalidateRequests();
    ingestionGate.cancel();
    ingestionController?.abort();
    ingestionController = null;
    ingestionStatus = null;
    ingestionError = '';
    ingestionBusy = false;
    clearTimeout(localStatusTimer);
    clearTimeout(ingestionTimer);
    Object.assign(state, createLibraryState());
    activeProfile = null;
    comparisonDetail = null;
    listDetailReturn = null;
    similarReturnPending = false;
    body?.replaceChildren();
    compareTray?.replaceChildren();
    if (compareTray) compareTray.hidden = true;
    if (!externalAutomation) ingestionHost?.replaceChildren();
    if (ingestionHost) ingestionHost.hidden = true;
    if (localStatus) { localStatus.hidden = true; localStatus.textContent = ''; }
    if (title) title.textContent = '画师资料库';
    if (!embedded && dialog?.open) dialog.close();
  }

  return { open, show, close, back, reset, refreshList, refresh, openResult, openSimilarImage };
}

export const __test = Object.freeze({
  createLibraryState,
  setLibraryView,
  toggleComparison,
  buildArtistListUrl,
  parseArtistPage,
  createLatestRequestGate,
  createSingleFlight,
  createKeyedSingleFlight,
  normalizeGalleryResponse,
  groupExamplesBySource,
  comparisonExamples,
  safeSourceLink,
  summarizeExampleMetadata,
  parseAliases,
  syncComparisonControls,
  facetLabelsForExample,
  diffProfileExamples,
  countSelectedFacets,
  shouldApplyProfileUpdate
});
