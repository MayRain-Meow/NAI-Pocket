export const DEFAULT_NAI_MODEL = 'nai-diffusion-4-5-full';


export const V5_CHARACTER_LIMIT = 22;
export const DEFAULT_CHARACTER_LIMIT = 6;

export function isV5GenerationModel(model) {
  return String(model || '').startsWith('nai-diffusion-5');
}

export function supportsPreciseReference(model) {
  return String(model || '').startsWith('nai-diffusion-4-5');
}

export function supportsVibeTransfer(model) {
  return !isV5GenerationModel(model);
}

export function supportsCharacterPrompt(model) {
  const value = String(model || '');
  return value.startsWith('nai-diffusion-4') || value.startsWith('nai-diffusion-5');
}

export function characterLimitForModel(model) {
  return isV5GenerationModel(model) ? V5_CHARACTER_LIMIT : DEFAULT_CHARACTER_LIMIT;
}

const MODEL_IDS = [
  'nai-diffusion-5-curated',
  'nai-diffusion-5-full',
  'nai-diffusion-4-5-curated',
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-curated-preview',
  'nai-diffusion-4-full',
  'nai-diffusion-3'
];

function flattenValues(value, output = []) {
  if (value == null) return output;
  if (Array.isArray(value)) {
    value.forEach(item => flattenValues(item, output));
    return output;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:model|model_id|modelId|source|Source|params_version|paramsVersion|comment|parameters|rawParameters)$/i.test(key)) {
        flattenValues(item, output);
      }
    }
    return output;
  }
  output.push(String(value));
  return output;
}

function canonicalModelId(value) {
  const text = String(value || '').toLowerCase();
  const exact = text.match(/nai-diffusion-(?:5-(?:full|curated)|4-5-(?:full|curated)|4-(?:full|curated-preview)|3)\b/);
  if (exact) return exact[0];
  return '';
}

function modelFromText(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const exact = canonicalModelId(raw);
  if (exact) return exact;

  const hasCurated = /\bcurated\b/.test(raw);
  if (/\bv5(?:\.0)?\b|\bna[i1]\s*5\b|diffusion\s*v?5\b|diffusion\s*5\b/.test(raw)) {
    return hasCurated ? 'nai-diffusion-5-curated' : 'nai-diffusion-5-full';
  }
  if (/\bv4[.]?5\b|\bv45\b|\bna[i1]\s*4[.]?5\b|diffusion\s*v?4[.]?5\b|diffusion\s*4-5\b/.test(raw)) {
    return hasCurated ? 'nai-diffusion-4-5-curated' : 'nai-diffusion-4-5-full';
  }
  if (/\bv4\b|\bna[i1]\s*4\b|diffusion\s*v?4\b|diffusion\s*4\b/.test(raw)) {
    return hasCurated ? 'nai-diffusion-4-curated-preview' : 'nai-diffusion-4-full';
  }
  if (/\bv3\b|\bna[i1]\s*3\b|diffusion\s*v?3\b|diffusion\s*3\b/.test(raw)) return 'nai-diffusion-3';
  return '';
}

export function inferNovelAiModel(...values) {
  const candidates = flattenValues(values);
  let fallback = '';
  for (const value of candidates) {
    const exact = canonicalModelId(value);
    if (exact) return { model: exact, detected: true, evidence: value, source: 'model-id' };
    const parsed = modelFromText(value);
    if (parsed) return { model: parsed, detected: true, evidence: value, source: 'model-text' };
    const version = Number(value);
    if (Number.isFinite(version) && version >= 4) fallback = 'nai-diffusion-5-full';
  }
  if (fallback) return { model: fallback, detected: true, evidence: 'params_version >= 4', source: 'params-version' };
  return { model: DEFAULT_NAI_MODEL, detected: false, evidence: '', source: 'default' };
}

export function modelDisplayName(model) {
  const value = String(model || '');
  if (value === 'nai-diffusion-5-full') return 'V5 Full';
  if (value === 'nai-diffusion-5-curated') return 'V5 Curated';
  if (value === 'nai-diffusion-4-5-full') return 'V4.5 Full';
  if (value === 'nai-diffusion-4-5-curated') return 'V4.5 Curated';
  if (value === 'nai-diffusion-4-full') return 'V4 Full';
  if (value === 'nai-diffusion-4-curated-preview') return 'V4 Curated';
  if (value === 'nai-diffusion-3') return 'Anime V3';
  return value || '未识别';
}

export const NAI_MODEL_IDS = MODEL_IDS;
