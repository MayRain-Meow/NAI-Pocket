// Portable QuickTagCloud data mapping. Fetching and cache ownership belong to the host.

export const CODEX_SITE = 'https://novelai.quicktagcloud.com';
export const MEDIA_FALLBACK = Object.freeze({ baseUrl: 'https://assets.quicktagcloud.com', imagePrefix: 'images', originalPrefix: 'originals' });
const text = value => typeof value === 'string' ? value : '';

export function normalizeCodexIndex(list, media) {
  if (!Array.isArray(list)) throw new Error('法典索引格式无效。');
  const raw = list.filter(item => item && typeof item === 'object' && /^[A-Za-z0-9_-]{1,80}$/.test(text(item.id)));
  return { raw, media: { ...MEDIA_FALLBACK, ...media } };
}

export function metaView(item) {
  return {
    id: text(item.id), type: text(item.type) || 'codex', title: text(item.title), selectorTitle: text(item.selectorTitle),
    version: text(item.version), author: text(item.author), source: text(item.source),
    entryCount: Number(item.entryCount) || 0, imagedCount: Number(item.imagedCount) || 0, nsfw: item.nsfw === true,
    contributors: Array.isArray(item.contributors) ? item.contributors.filter(c => c && typeof c === 'object').map(c => ({ name: text(c.name), role: text(c.role) })).filter(c => c.name).slice(0, 20) : [],
    links: Array.isArray(item.links) ? item.links.filter(l => l && typeof l === 'object' && /^https:\/\//.test(text(l.url))).map(l => ({ label: text(l.label) || text(l.title), url: text(l.url) })).slice(0, 10) : []
  };
}

// Image URL rules copied from the site's media.js (two modes).
const encodePart = value => encodeURIComponent(value).replace(/%2F/g, '/');
export function imageUrl(meta, entry, file, media) {
  if (!file) return '';
  const withRev = url => entry.assetRev ? `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(entry.assetRev)}` : url;
  if (/^https?:\/\//i.test(file)) return withRev(file);
  if (meta.assetPathMode === 'relative') {
    const relative = file.split('/').map(encodeURIComponent).join('/');
    return withRev(meta.assetBaseUrl ? `${String(meta.assetBaseUrl).replace(/\/+$/, '')}/${relative}` : relative);
  }
  const route = [media.imagePrefix, entry.assetCodexId || meta.id, file].map(encodePart).join('/');
  return withRev(`${String(media.baseUrl).replace(/\/+$/, '')}/${route}`);
}

// Parameters are free text in `note`, in either community or NovelAI wording.
const SAMPLERS = [
  [/^(k_)?euler[\s_-]*a(ncestral)?$/i, 'k_euler_ancestral'], [/^(k_)?euler$/i, 'k_euler'],
  [/^(k_)?dpm(\+\+|pp)?[\s_-]*2s[\s_-]*a(ncestral)?$/i, 'k_dpmpp_2s_ancestral'], [/^(k_)?dpm(\+\+|pp)?[\s_-]*2m[\s_-]*sde$/i, 'k_dpmpp_2m_sde'],
  [/^(k_)?dpm(\+\+|pp)?[\s_-]*2m$/i, 'k_dpmpp_2m'], [/^(k_)?dpm(\+\+|pp)?[\s_-]*sde$/i, 'k_dpmpp_sde']
];
export function parseCodexParams(note) {
  const text = String(note || '');
  const num = re => { const m = text.match(re); return m ? Number(m[1]) : null; };
  const params = {};
  const steps = num(/steps\s*[:：]\s*(\d+)/i); if (steps) params.steps = steps;
  const scale = num(/(?:cfg scale|prompt guidance)\s*[:：]\s*([\d.]+)/i); if (scale !== null) params.scale = scale;
  const rescale = num(/(?:cfg rescale|prompt guidance rescale)\s*[:：]\s*([\d.]+)/i); if (rescale !== null) params.cfgRescale = rescale;
  const seed = num(/seed\s*[:：]\s*(\d+)/i); if (seed !== null) params.seed = seed;
  const size = text.match(/size\s*[:：]\s*(\d{3,4})\s*[x×]\s*(\d{3,4})/i); if (size) { params.width = Number(size[1]); params.height = Number(size[2]); }
  const samplerRaw = text.match(/sampler\s*[:：]\s*([A-Za-z0-9_+\s-]+?)(?:\s*\(([a-z]+)\))?\s*(?:[,·]|$)/i);
  if (samplerRaw) {
    const name = samplerRaw[1].trim();
    const known = SAMPLERS.find(([re]) => re.test(name));
    if (known) params.sampler = known[1];
    if (samplerRaw[2]) params.noiseSchedule = samplerRaw[2].toLowerCase();
  }
  const schedule = text.match(/noise schedule\s*[:：]\s*([a-z]+)/i); if (schedule) params.noiseSchedule = schedule[1].toLowerCase();
  return Object.keys(params).length ? params : null;
}

export function slimEntry(meta, entry, media) {
  const characters = Array.isArray(entry.characterPrompts)
    ? entry.characterPrompts.filter(c => c && typeof c.prompt === 'string' && c.prompt.trim()).map(c => ({ label: text(c.label), prompt: c.prompt.trim(), negative: text(c.negative).trim() }))
    : [];
  const images = Array.isArray(entry.images) ? entry.images.filter(im => im && typeof im.path === 'string').map(im => imageUrl(meta, entry, im.path, media)) : [];
  return {
    id: text(entry.id), title: text(entry.title), path: Array.isArray(entry.path) ? entry.path.map(String) : [],
    prompt: text(entry.tags).trim(), characters, isNew: entry.isNew === true,
    negative: text(entry.negative).trim(), params: parseCodexParams(entry.note), note: text(entry.note).trim().slice(0, 600),
    image: imageUrl(meta, entry, text(entry.image), media), images,
    width: Number(entry.imageWidth) || 0, height: Number(entry.imageHeight) || 0
  };
}

export function normalizeCodexData(meta, raw, media) {
  const entries = (Array.isArray(raw?.entries) ? raw.entries : []).filter(e => e && typeof e === 'object').map(e => slimEntry(meta, e, media));
  return { meta: metaView(meta), tree: Array.isArray(raw?.tree) ? raw.tree : [], entries };
}

const slimTree = nodes => (Array.isArray(nodes) ? nodes : []).filter(n => n && typeof n.name === 'string')
  .map(n => ({ name: n.name, count: Number(n.count) || 0, children: slimTree(n.children) }));

export function queryCodexData(data, { path: rawPath = '', q = '', offset = 0, limit = 40 } = {}) {
  const segments = String(rawPath || '').split('/').map(s => s.trim()).filter(Boolean).slice(0, 6);
  const needle = String(q || '').trim().toLowerCase().slice(0, 100);
  const matches = data.entries.filter(entry => segments.every((segment, index) => entry.path[index] === segment)
    && (!needle || entry.title.toLowerCase().includes(needle) || entry.prompt.toLowerCase().includes(needle)
      || entry.characters.some(c => c.prompt.toLowerCase().includes(needle))));
  const start = Math.max(0, Math.min(Number(offset) || 0, matches.length));
  const size = Math.max(1, Math.min(Number(limit) || 40, 80));
  return { meta: data.meta, tree: slimTree(data.tree), total: matches.length, offset: start, entries: matches.slice(start, start + size) };
}
