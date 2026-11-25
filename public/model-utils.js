export const DEFAULT_NAI_MODEL = 'nai-diffusion-4-5-full';


export const V5_CHARACTER_LIMIT = 22;
export const DEFAULT_CHARACTER_LIMIT = 6;

export function isV5GenerationModel(model) {
  return String(model || '').startsWith('nai-diffusion-5');
}

// Precise Reference: V4.5 since launch; V5 Full and Curated since 2026-11-24 (not V5 Full · Medium,
// whose distilled checkpoint has no reference support). Capabilities follow NovelAI's own client.

export function supportsPreciseReference(model, effort = '') {
  const value = String(model || '');
  if (value.startsWith('nai-diffusion-4-5')) return true;
  if (value === 'nai-diffusion-5-curated') return true;
  return value === 'nai-diffusion-5-full' && effort !== 'medium';
}
// V5 reads strength up to 5 and has no Fidelity; V4.5 caps strength at 1 and has Fidelity.
export const preciseStrengthMax = model => isV5GenerationModel(model) ? 5 : 1;
export const supportsReferenceFidelity = model => !isV5GenerationModel(model);
// V5 adds the 服装 (costume) type and the 「偏好同款服装」 switch on the character types.
export const supportsOutfitReference = model => isV5GenerationModel(model);
// V4.5 keeps references while inpainting; NovelAI's client sends none to V5 inpainting.
export const preciseReferenceWhileInpainting = model => !isV5GenerationModel(model);

// Precise Reference types, stored as NovelAI's own descriptions. The two outfit variants are the
// 「偏好同款服装」 switch: on = character_mainoutfit / character&style, off = character / character&style_anyoutfit.
export const PRECISE_REFERENCE_TYPES = ['character', 'character_mainoutfit', 'style', 'character&style', 'character&style_anyoutfit', 'costume'];
export function preciseReferenceKind(type) {
  if (type === 'character' || type === 'character_mainoutfit') return 'character';
  if (type === 'character&style' || type === 'character&style_anyoutfit') return 'character&style';
  return type === 'style' || type === 'costume' ? type : 'character&style';
}
export const preciseReferenceSameOutfit = type => type === 'character_mainoutfit' || type === 'character&style';
export function preciseReferenceType(kind, sameOutfit) {
  if (kind === 'character') return sameOutfit ? 'character_mainoutfit' : 'character';
  if (kind === 'character&style') return sameOutfit ? 'character&style' : 'character&style_anyoutfit';
  return kind === 'style' || kind === 'costume' ? kind : 'character&style';
}
// What the model is actually sent (NovelAI client): without outfit support costume references are
// dropped and the outfit variants fall back to the plain types.
export function preciseReferenceTypeFor(model, type) {
  if (supportsOutfitReference(model)) return type;
  if (type === 'costume') return null;
  if (type === 'character_mainoutfit') return 'character';
  if (type === 'character&style_anyoutfit') return 'character&style';
  return type;
}

// V5 reference images are cut to the nearest of NovelAI's 64-step buckets: scaled to cover the bucket
// and centre-cropped (NovelAI client, module 589161). Returns null when the image already fits.
const V5_REFERENCE_BUCKETS = (() => {
  const short = [[256, 3328], [320, 2752], [384, 2368], [448, 2112], [512, 1856], [576, 1664], [640, 1536], [704, 1408], [768, 1280], [832, 1216], [896, 1152], [960, 1088]];
  const tall = [];
  for (const [w, minH] of short) {
    const top = tall.length ? tall[tall.length - 1][1] - 64 : 4096;
    for (let h = top; h >= minH; h -= 64) tall.push([w, h]);
  }
  return [...tall, [1024, 1024], ...tall.slice().reverse().map(([w, h]) => [h, w])];
})();
export function v5ReferenceCrop(width, height) {
  const w = Number(width), h = Number(height);
  if (!(w > 0 && h > 0)) return null;
  const aspect = Math.log(w / h);
  let best = V5_REFERENCE_BUCKETS[0], bestDistance = Infinity;
  for (const bucket of V5_REFERENCE_BUCKETS) {
    const distance = Math.abs(aspect - Math.log(bucket[0] / bucket[1]));
    if (distance < bestDistance) { best = bucket; bestDistance = distance; }
  }
  const [bw, bh] = best;
  if (w === bw && h === bh) return null;
  const scale = Math.max(bw / w, bh / h);
  const resizeWidth = Math.max(Math.floor(w * scale + 0.5), bw), resizeHeight = Math.max(Math.floor(h * scale + 0.5), bh);
  return { width: bw, height: bh, resizeWidth, resizeHeight, left: Math.floor((resizeWidth - bw) / 2), top: Math.floor((resizeHeight - bh) / 2) };
}
export const __v5ReferenceBuckets = V5_REFERENCE_BUCKETS;

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
