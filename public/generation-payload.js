// Generation state sanitizing and NovelAI request payload building — pure, shared by the
// Node server and the browser / Android app (no node:*, config, db or filesystem here).
// Environment-specific values (API model names and tool endpoints) are set once by the
// host through configureGenerationPayload(); the defaults are NovelAI's public ones.

import { formatTag } from './prompt-utils.js?v=1.8.7';
import { normalizeProviderId } from './provider-route.js?v=1.8.7';
import { extractQuotedText, prepareV5Prompt } from './v5-utils.js?v=1.8.7';
import { DIRECTOR_TOOL_TYPES, filterAdvancedOverrides } from './parameter-semantics.js?v=1.8.7';
import { DEFAULT_GENERATION_MODEL, DEFAULT_GENERATION_PARAMS, DEFAULT_ENHANCE_UPSCALE_FACTOR } from './generation-state.js?v=1.8.7';
import { characterLimitForModel, isV5GenerationModel, supportsPreciseReference, supportsVibeTransfer, supportsCharacterPrompt, V5_CHARACTER_LIMIT } from './model-utils.js?v=1.8.7';

const settings = {
  v5FullModel: 'nai-diffusion-5-full',
  v5CuratedModel: 'nai-diffusion-5-curated',
  v5FullInpaintModel: 'nai-diffusion-5-full-inpainting',
  v5CuratedInpaintModel: 'nai-diffusion-4-5-curated-inpainting',
  upscaleApi: 'https://image.novelai.net/ai/upscale',
  augmentApi: 'https://image.novelai.net/ai/augment-image'
};

export function configureGenerationPayload(next = {}) {
  for (const key of Object.keys(settings)) if (typeof next[key] === 'string' && next[key]) settings[key] = next[key];
}

const ID_RE = /^[0-9a-f-]{16,80}$/i;
export function sanitizeImageRef(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const source = String(ref.source || '');
  const id = String(ref.id || '');
  if (source !== 'asset' || !ID_RE.test(id)) return null;
  return { source: 'asset', id };
}

function isV5Model(model) {
  return isV5GenerationModel(model);
}

function characterLimitFor(model) {
  return characterLimitForModel(model);
}

export function apiModelFor(model) {
  const normalized = String(model || '');
  if (normalized === 'nai-diffusion-5-full') return settings.v5FullModel;
  if (normalized === 'nai-diffusion-5-curated') return settings.v5CuratedModel;
  return normalized;
}

const INPAINT_MODEL_BY_GENERATION_MODEL = new Map([
  ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-full-inpainting'],
  ['nai-diffusion-4-5-curated', 'nai-diffusion-4-5-curated-inpainting'],
  ['nai-diffusion-4-full', 'nai-diffusion-4-full-inpainting'],
  ['nai-diffusion-4-curated-preview', 'nai-diffusion-4-curated-inpainting'],
  ['nai-diffusion-3', 'nai-diffusion-3-inpainting'],
  ['nai-diffusion-furry-3', 'nai-diffusion-furry-3-inpainting']
]);

function inpaintModelFor(model) {
  const normalized = String(model || '');
  if (normalized.endsWith('-inpainting')) return normalized;
  if (normalized === 'nai-diffusion-5-full') return settings.v5FullInpaintModel;
  if (normalized === 'nai-diffusion-5-curated') return settings.v5CuratedInpaintModel;
  return INPAINT_MODEL_BY_GENERATION_MODEL.get(normalized) || `${normalized}-inpainting`;
}

function bool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function number(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function optionalImageDimension(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 64 && parsed <= 4096 ? Math.round(parsed) : null;
}

function finiteNumber(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeImportedExtras(value, depth = 0) {
  if (depth > 3 || value == null) return {};
  if (Array.isArray(value)) return value.slice(0, 64).map(item => sanitizeImportedExtras(item, depth + 1));
  if (typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 24_000) : value;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    const cleanKey = String(key).slice(0, 120);
    if (!cleanKey) continue;
    output[cleanKey] = sanitizeImportedExtras(item, depth + 1);
  }
  return output;
}

function integer(value, fallback, min, max) {
  return Math.round(number(value, fallback, min, max));
}

function sanitizeTag(item) {
  if (typeof item === 'string') return {
    text: item.slice(0, 1000), exactText: item.slice(0, 1000), weight: 1, enabled: true,
    translation: '', bundle: false, preserveRaw: false, raw: '', originalText: item.slice(0, 1000),
    originalExactText: item.slice(0, 1000), originalWeight: 1
  };
  const text = String(item?.text || '').slice(0, 1000);
  return {
    id: typeof item?.id === 'string' ? item.id.slice(0, 100) : undefined,
    text,
    exactText: String(item?.exactText ?? text).slice(0, 1200),
    weight: finiteNumber(item?.weight, 1),
    enabled: item?.enabled !== false,
    translation: String(item?.translation || '').slice(0, 1000),
    bundle: item?.bundle === true,
    preserveRaw: item?.preserveRaw === true,
    raw: String(item?.raw || '').slice(0, 3000),
    originalText: String(item?.originalText ?? text).slice(0, 1000),
    originalExactText: String(item?.originalExactText ?? item?.exactText ?? text).slice(0, 1200),
    originalWeight: finiteNumber(item?.originalWeight, finiteNumber(item?.weight, 1)),
    originalOrder: item?.originalOrder === null || item?.originalOrder === undefined || item?.originalOrder === ''
      ? null
      : (Number.isFinite(Number(item.originalOrder)) ? Number(item.originalOrder) : null)
  };
}

function compileTags(tags) {
  return (tags || []).filter(item => item.enabled !== false).map(formatTag).filter(Boolean).join(', ');
}

// The official Enhance flow biases the second diffusion pass away from the
// common "upscaled, blurry" failure mode. Max✨ uses the dedicated API flag
// instead, so it must keep the original prompt unchanged.
function officialEnhancePrompt(prompt) {
  const value = String(prompt || '').trim();
  if (!value || /upscaled\s*,\s*blurry/i.test(value)) return value;
  const addition = '-2::upscaled, blurry::';
  const textMarker = /(?:^|[\s,.:[\]{}、。])teXt:(?!:)/i.exec(value);
  if (textMarker) {
    const markerIndex = textMarker.index + textMarker[0].lastIndexOf('teXt:');
    const head = value.slice(0, markerIndex).replace(/[ ,\t\r\n]+$/, '');
    const tail = value.slice(markerIndex).replace(/^[ ,\t\r\n]+/, '');
    return `${head}, ${addition}, ${tail}`;
  }
  return `${value}, ${addition}`;
}

function sanitizeCenters(value) {
  if (!Array.isArray(value) || !value.length) return [{ x: 0.5, y: 0.5 }];
  return value.slice(0, 4).map(item => ({
    x: number(item?.x, 0.5, 0, 1),
    y: number(item?.y, 0.5, 0, 1)
  }));
}


function sanitizePreciseReference(item) {
  const image = sanitizeImageRef(item?.image);
  if (!image) return null;
  const type = ['character', 'style', 'character&style'].includes(item?.type) ? item.type : 'character';
  return {
    image,
    type,
    strength: number(item?.strength, 0.6, 0, 1),
    fidelity: number(item?.fidelity, 0.5, 0, 1)
  };
}

function sanitizeVibeReference(item) {
  const image = sanitizeImageRef(item?.image);
  if (!image) return null;
  return {
    image,
    strength: number(item?.strength, 0.6, 0, 1),
    informationExtracted: number(item?.informationExtracted, 1, 0, 1)
  };
}

function sanitizeImageWorkflow(raw, model = '') {
  const rawMode = ['text', 'img2img', 'inpaint'].includes(raw?.mode) ? raw.mode : 'text';
  // Older saved states sometimes recorded Enhance as a flag alongside the
  // default `text` mode.  Keep the provider-facing representation canonical:
  // Enhance is an Img2Img request and must carry the source image through the
  // media resolver instead of falling through to ordinary text generation.
  const enhance = raw?.enhance === true && rawMode !== 'inpaint';
  const mode = enhance && rawMode === 'text' ? 'img2img' : rawMode;
  const rawEnhanceFactor = String(raw?.enhanceUpscaleFactor || '').trim().toLowerCase();
  const enhanceUpscaleFactor = rawEnhanceFactor === 'max'
    ? (isV5Model(model) ? 'max' : DEFAULT_ENHANCE_UPSCALE_FACTOR)
    : number(raw?.enhanceUpscaleFactor, DEFAULT_ENHANCE_UPSCALE_FACTOR, 1, 2);
  return {
    mode,
    baseImage: sanitizeImageRef(raw?.baseImage),
    maskImage: sanitizeImageRef(raw?.maskImage),
    strength: number(raw?.strength, 0.65, 0, 1),
    noise: number(raw?.noise, 0, 0, 1),
    colorCorrect: raw?.colorCorrect === true,
    enhance,
    enhanceUpscaleFactor,
    enhanceTargetWidth: optionalImageDimension(raw?.enhanceTargetWidth),
    enhanceTargetHeight: optionalImageDimension(raw?.enhanceTargetHeight)
  };
}

function sanitizeImageTool(raw) {
  const type = String(raw?.type || 'none');
  if (type === 'none') return { type: 'none', scale: 4, reqType: '', prompt: '', defry: 0 };
  if (type === 'upscale') {
    // NovelAI's dedicated Upscale endpoint is a fixed four-times operation.
    return { type, scale: 4, reqType: '', prompt: '', defry: 0 };
  }
  const rawReqType = type === 'director' ? String(raw?.reqType || '') : type;
  const normalizedReqType = rawReqType.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const reqType = ['bgremoval', 'remove-background', 'background-removal'].includes(normalizedReqType)
    ? 'bg-removal' : normalizedReqType;
  // Preserve an imported Director intent when an exporter omitted req_type;
  // the generation boundary reports the unresolved subtype explicitly rather
  // than silently converting the request to text-to-image.
  if (type === 'director' && !DIRECTOR_TOOL_TYPES.has(reqType)) {
    return {
      type: 'director', scale: 4, reqType: 'unknown',
      prompt: String(raw?.prompt || '').slice(0, 4000), defry: integer(raw?.defry, 0, 0, 5)
    };
  }
  if (!DIRECTOR_TOOL_TYPES.has(reqType)) return { type: 'none', scale: 4, reqType: '', prompt: '', defry: 0 };
  return {
    type: 'director',
    scale: 4,
    reqType,
    prompt: String(raw?.prompt || '').slice(0, 4000),
    defry: integer(raw?.defry, 0, 0, 5)
  };
}

function compactWorkflowOperation(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function normalizeRecordedWorkflowOperation(value) {
  const text = compactWorkflowOperation(value);
  if (!text) return '';
  if (/^(?:text|text2image|texttoimage|texttoimg|text2img|txt2img|txt2image|txttoimg|t2i|promptgenerate|promptgeneration|nativegenerate|generate|generateimage|imagegenerate|imagegeneration|textgeneration|texttoimagegeneration)(?:request|operation)?$/.test(text)) return 'text';
  if (/(?:infill|inpaint|nativeinfilling|maskgeneration)/.test(text)) return 'inpaint';
  if (/(?:enhance(?:upscale|image)?|upscaleenhance|upscaledenhance)/.test(text)) return 'enhance';
  if (/(?:img2img|i2i|image2image|imagetoimage)/.test(text)) return 'img2img';
  if (/(?:director|augment|lineart|sketch|bgremoval|removebackground|backgroundremoval|declutter|colorize|emotion)/.test(text)) return 'director';
  if (/^(?:upscale|upscaling|upscalingrequest|imageupscale|imageupscaling|upscaleimage|superresolution|superresolutionimage|imagesuperresolution|upscalerequest|imageupscalerequest|upscaleimagerequest|imageupscalingrequest|superresolutionimagerequest|imagesuperresolutionrequest|nativeupscale|nativeupscaling|nativeupscalerequest|nativeupscalingrequest|superresolutionrequest|upscaleoperation)$/.test(text)) return 'upscale';
  return '';
}

function imageLikeWorkflowDescriptor(value) {
  const text = compactWorkflowOperation(value);
  return Boolean(text && /(?:image|img2img|i2i|inpaint|infill|upscale|director|augment|mask|vibe|reference|precise|controlnet)/.test(text));
}

function recordedWorkflowOperation(raw) {
  const metadata = raw?.workflowMetadata && typeof raw.workflowMetadata === 'object' ? raw.workflowMetadata : {};
  const recovery = raw?.imageRecovery && typeof raw.imageRecovery === 'object' ? raw.imageRecovery : {};
  const candidates = [
    metadata.operation, recovery.operation, raw?.operation,
    // Some older snapshots only retained requestType rather than operation.
    !metadata.operation ? metadata.requestType : undefined,
    !recovery.operation ? recovery.requestType : undefined
  ].filter(value => value != null && String(value).trim());
  const mapped = candidates.map(value => ({ value, operation: normalizeRecordedWorkflowOperation(value) }));
  if (mapped.some(item => !item.operation && imageLikeWorkflowDescriptor(item.value))) return 'unknown';
  const operations = [...new Set(mapped.map(item => item.operation).filter(Boolean))];
  // Older checkpoints sometimes recorded the provider's generic Img2Img
  // operation alongside the more specific Enhance label.  Those two names
  // describe the same endpoint; preserve the specific Enhance UI mode while
  // still rejecting every other conflicting pair.
  const enhanceImg2ImgAlias = operations.includes('enhance')
    && operations.includes('img2img') && operations.length === 2;
  if (operations.length > 1 && !enhanceImg2ImgAlias) return 'unknown';
  if (enhanceImg2ImgAlias) return 'enhance';
  return operations[0] || '';
}

function normalizeRecordedDirectorType(value) {
  const text = compactWorkflowOperation(value);
  if (!text) return 'unknown';
  if (text.includes('lineart')) return 'lineart';
  if (text.includes('sketch')) return 'sketch';
  if (text.includes('bgremoval') || text.includes('removebackground') || text.includes('backgroundremoval')) return 'bg-removal';
  if (text.includes('declutter')) return 'declutter';
  if (text.includes('colorize') || text.includes('colourize')) return 'colorize';
  if (text.includes('emotion')) return 'emotion';
  return 'unknown';
}

function sanitizeReferenceControl(raw) {
  const mode = ['none', 'precise', 'vibe'].includes(raw?.mode) ? raw.mode : 'none';
  const precise = Array.isArray(raw?.precise) ? raw.precise.slice(0, 16).map(sanitizePreciseReference).filter(Boolean) : [];
  const vibes = Array.isArray(raw?.vibes) ? raw.vibes.slice(0, 16).map(sanitizeVibeReference).filter(Boolean) : [];
  return { mode, precise, vibes };
}

function sanitizeExperiment(raw) {
  if (raw?.type === 'style-iteration') return { type: 'style-iteration', run: String(raw.run || '').slice(0, 120), candidate: String(raw.candidate || '').slice(0, 120) };
  if (raw?.type !== 'artist-storm') return null;
  const total = integer(raw?.total, 2, 2, 50);
  const weights = Array.isArray(raw?.weights) ? raw.weights.slice(0, 30).map(item => ({
    id: String(item?.id || '').slice(0, 120),
    text: String(item?.text || '').slice(0, 300),
    baseWeight: number(item?.baseWeight, 1, -10, 10),
    offset: number(item?.offset, 0, -10, 10),
    weight: number(item?.weight, 1, -10, 10)
  })).filter(item => item.text.trim()) : [];
  if (!weights.length) return null;
  let externalArtist = null;
  if (raw?.externalArtist && /^artist\s*:\s*\S+/i.test(String(raw.externalArtist.text || ''))) {
    externalArtist = { text: String(raw.externalArtist.text).slice(0, 300), weight: number(raw.externalArtist.weight, 1, -10, 10) };
  }
  return {
    type: 'artist-storm',
    mode: raw?.mode === 'linked' ? 'linked' : 'mix',
    index: integer(raw?.index, 1, 1, total),
    total,
    delta: number(raw?.delta, 0.3, 0.01, 10),
    weights,
    externalArtist
  };
}

// Dedicated Upscale PNGs can retain the input PNG's old Text2Image metadata.
// That combination is useful for inspection but is not enough evidence to
// choose an endpoint. Keep it as an explicit ambiguity marker until the user
// selects a workflow in the editor.
function hasAmbiguousTextImageState(state = {}) {
  const metadata = state?.workflowMetadata && typeof state.workflowMetadata === 'object' ? state.workflowMetadata : {};
  const recovery = state?.imageRecovery && typeof state.imageRecovery === 'object' ? state.imageRecovery : {};
  if (metadata.ambiguous === true || recovery.ambiguous === true) return true;
  const operations = [metadata.operation, recovery.operation, state?.operation]
    .map(value => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ''))
    .filter(Boolean);
  const sourceStatuses = [metadata.sourceStatus, recovery.sourceStatus, recovery.source?.status]
    .map(value => String(value ?? '').trim().toLowerCase());
  // An embedded source with no explicit operation is still ambiguous (the
  // exporter may have omitted the operation field), but any non-text
  // descriptor must be left to the normal operation resolver instead of
  // being treated as this particular conflict.
  const mediaEvidence = sourceStatuses.some(status => ['embedded', 'too-large', 'unresolved', 'upload-failed'].includes(status));
  return mediaEvidence
    && (operations.length === 0 || operations.every(operation => operation === 'text'));
}

/**
 * Normalize a generation state before it crosses a persistence or generation
 * boundary.  Persistence callers may opt into keeping an incomplete image
 * workflow so the user can supply its source/Mask later; all generation and
 * payload-preview callers retain the strict default and reject it.
 */
export function sanitizeGenerationState(raw, { allowMissingMedia = false } = {}) {
  // Imported metadata can contain an image-like request descriptor that this
  // release does not understand.  Do not let the later mode sanitization turn
  // that unresolved intent into an ordinary text generation (especially for
  // scheme saves, which deliberately pass allowMissingMedia=true).
  const recordedOperation = recordedWorkflowOperation(raw);
  const unresolvedUnknownOperation = recordedOperation === 'unknown' || (
    String(raw?.imageRecovery?.status || '').trim().toLowerCase() === 'unresolved'
    && compactWorkflowOperation(raw?.imageRecovery?.operation) === 'unknown'
  );
  const ambiguousTextImage = hasAmbiguousTextImageState(raw);
  if (unresolvedUnknownOperation && !allowMissingMedia) {
    throw new Error('导入记录包含未识别的图片请求类型；请先手动选择工作流后再生成。');
  }
  if (ambiguousTextImage && !allowMissingMedia) {
    throw new Error('导入记录同时带有文生图标记和输入图；请先在生成方式选择器确认文生图或图片工作流后再生成。');
  }
  const model = String(raw?.model || DEFAULT_GENERATION_MODEL).slice(0, 100);
  const prompt = String(raw?.prompt || '').trim().slice(0, 20_000);
  const previewPrompt = String(raw?.previewPrompt || '').trim().slice(0, 40_000);
  const negativePrompt = String(raw?.negativePrompt || '').trim().slice(0, 20_000);

  const params = raw?.params || {};
  const groups = {};
  if (raw?.groups && typeof raw.groups === 'object' && !Array.isArray(raw.groups)) {
    for (const [key, items] of Object.entries(raw.groups).slice(0, 30)) {
      if (!Array.isArray(items)) continue;
      groups[String(key).slice(0, 50)] = items.slice(0, 1000).map(sanitizeTag).filter(item => item.text.trim());
    }
  }

  const characters = Array.isArray(raw?.characters) ? raw.characters.slice(0, V5_CHARACTER_LIMIT).map(item => {
    const legacyPrompt = String(item?.prompt || '').slice(0, 10_000);
    const legacyUc = String(item?.uc || '').slice(0, 10_000);
    const promptTags = Array.isArray(item?.promptTags) ? item.promptTags.slice(0, 1000).map(sanitizeTag).filter(tag => tag.text.trim()) : (legacyPrompt ? [sanitizeTag(legacyPrompt)] : []);
    const ucTags = Array.isArray(item?.ucTags) ? item.ucTags.slice(0, 1000).map(sanitizeTag).filter(tag => tag.text.trim()) : (legacyUc ? [sanitizeTag(legacyUc)] : []);
    return {
      id: typeof item?.id === 'string' ? item.id.slice(0, 100) : undefined,
      name: String(item?.name || '').slice(0, 300),
      promptTags,
      ucTags,
      centers: sanitizeCenters(item?.centers),
      enabled: item?.enabled !== false
    };
  }).filter(item => item.name.trim() || item.promptTags.length || item.ucTags.length) : [];

  const usesCharacterPrompt = characters.some(item => item.enabled !== false && compileTags(item.promptTags).trim());
  if (usesCharacterPrompt && !supportsCharacterPrompt(model)) {
    throw new Error('Character Prompt 仅支持 NovelAI V4/V4.5/V5 模型。');
  }
  const v4Options = {
    useCoords: raw?.v4Options?.useCoords === true,
    useOrder: raw?.v4Options?.useOrder !== false,
    negativeUseOrder: raw?.v4Options?.negativeUseOrder === true,
    legacyUc: raw?.v4Options?.legacyUc === true
  };
  let imageWorkflow = sanitizeImageWorkflow(raw?.imageWorkflow, model);
  let imageTool = sanitizeImageTool(raw?.imageTool);
  // A few older checkpoints retained only workflowMetadata/imageRecovery after
  // import.  Materialize that descriptor into the canonical fields before any
  // validation or payload construction; otherwise the selector could display
  // Upscale/Enhance while the provider still received ordinary text generation.
  const canonicalWorkflowEmpty = imageWorkflow.mode === 'text'
    && imageWorkflow.enhance !== true
    && imageTool.type === 'none';
  const descriptor = raw?.workflowMetadata && typeof raw.workflowMetadata === 'object' ? raw.workflowMetadata : {};
  const recoveryDescriptor = raw?.imageRecovery && typeof raw.imageRecovery === 'object' ? raw.imageRecovery : {};
  if (canonicalWorkflowEmpty && !ambiguousTextImage && ['img2img', 'enhance', 'upscale', 'inpaint', 'director'].includes(recordedOperation)) {
    if (recordedOperation === 'img2img') {
      imageWorkflow = { ...imageWorkflow, mode: 'img2img', enhance: false };
    } else if (recordedOperation === 'enhance') {
      imageWorkflow = {
        ...imageWorkflow,
        mode: 'img2img',
        enhance: true,
        enhanceUpscaleFactor: descriptor.enhanceUpscaleFactor === 'max'
          ? (isV5Model(model) ? 'max' : DEFAULT_ENHANCE_UPSCALE_FACTOR)
          : number(descriptor.enhanceUpscaleFactor, imageWorkflow.enhanceUpscaleFactor, 1, 2),
        enhanceTargetWidth: optionalImageDimension(descriptor.enhanceTargetWidth) || imageWorkflow.enhanceTargetWidth,
        enhanceTargetHeight: optionalImageDimension(descriptor.enhanceTargetHeight) || imageWorkflow.enhanceTargetHeight
      };
    } else if (recordedOperation === 'inpaint') {
      imageWorkflow = { ...imageWorkflow, mode: 'inpaint', enhance: false };
    } else if (recordedOperation === 'upscale') {
      imageTool = { type: 'upscale', scale: 4, reqType: '', prompt: '', defry: 0 };
    } else if (recordedOperation === 'director') {
      const reqType = normalizeRecordedDirectorType(
        descriptor.requestType || descriptor.operation || recoveryDescriptor.requestType
          || recoveryDescriptor.operation || raw?.imageTool?.reqType
      );
      imageTool = {
        type: 'director', scale: 4, reqType,
        prompt: String(raw?.imageTool?.prompt || '').slice(0, 4000),
        defry: integer(raw?.imageTool?.defry, 0, 0, 5)
      };
    }
  }
  const referenceControl = sanitizeReferenceControl(raw?.referenceControl);
  const recoveryStatus = ['none', 'ready', 'missing', 'unresolved', 'too-large', 'upload-failed'].includes(String(raw?.imageRecovery?.status || '').trim().toLowerCase())
    ? String(raw.imageRecovery.status).trim().toLowerCase() : (unresolvedUnknownOperation ? 'unresolved' : 'none');
  const imageRecovery = raw?.imageRecovery && typeof raw.imageRecovery === 'object'
    ? {
        status: recoveryStatus,
        operation: compactWorkflowOperation(raw.imageRecovery.operation || raw?.workflowMetadata?.operation || raw?.operation).slice(0, 40),
        label: String(raw.imageRecovery.label || '').slice(0, 80),
        ambiguous: raw.imageRecovery.ambiguous === true || ambiguousTextImage,
        reason: String(raw.imageRecovery.reason || '').slice(0, 1000)
      }
    : (unresolvedUnknownOperation ? {
        status: 'unresolved', operation: 'unknown', label: '未知图片工作流',
        reason: '记录包含未识别的图片请求类型；请手动选择工作流后再生成。', ambiguous: false
      } : null);
  const workflowMetadata = raw?.workflowMetadata && typeof raw.workflowMetadata === 'object'
    ? {
        operation: compactWorkflowOperation(raw.workflowMetadata.operation || raw?.operation).slice(0, 40),
        requestType: String(raw.workflowMetadata.requestType || '').slice(0, 120),
        sourceStatus: String(raw.workflowMetadata.sourceStatus || '').slice(0, 20),
        maskStatus: String(raw.workflowMetadata.maskStatus || '').slice(0, 20),
        ambiguous: raw.workflowMetadata.ambiguous === true || ambiguousTextImage,
        ambiguityReason: String(raw.workflowMetadata.ambiguityReason || (ambiguousTextImage ? '记录标为文生图但含输入图；请手动选择工作流。' : '')).slice(0, 1000),
        enhanceTargetWidth: optionalImageDimension(raw.workflowMetadata.enhanceTargetWidth),
        enhanceTargetHeight: optionalImageDimension(raw.workflowMetadata.enhanceTargetHeight),
        enhanceUpscaleFactor: raw.workflowMetadata.enhanceUpscaleFactor === 'max'
          ? 'max' : number(raw.workflowMetadata.enhanceUpscaleFactor, DEFAULT_ENHANCE_UPSCALE_FACTOR, 1, 2)
      }
    : (unresolvedUnknownOperation ? { operation: 'unknown', requestType: '', sourceStatus: 'missing', maskStatus: 'missing', ambiguous: false, ambiguityReason: '', enhanceTargetWidth: null, enhanceTargetHeight: null, enhanceUpscaleFactor: DEFAULT_ENHANCE_UPSCALE_FACTOR }
      : ambiguousTextImage ? { operation: 'text', requestType: '', sourceStatus: 'embedded', maskStatus: 'missing', ambiguous: true, ambiguityReason: '记录标为文生图但含输入图；请手动选择工作流。', enhanceTargetWidth: null, enhanceTargetHeight: null, enhanceUpscaleFactor: DEFAULT_ENHANCE_UPSCALE_FACTOR }
      : null);
  if (!allowMissingMedia) {
    if (imageWorkflow.mode !== 'text' && !imageWorkflow.baseImage) throw new Error('导入记录识别为图生图 / 局部重绘，但原图未随记录保存；请重新选择输入图片。');
    if (imageWorkflow.enhance && !imageWorkflow.baseImage) throw new Error('官方 Enhance 需要先选择输入图片。');
    if (imageWorkflow.mode === 'inpaint' && !imageWorkflow.maskImage) throw new Error('局部重绘需要先绘制并保存 Mask。');
    if (imageTool.type !== 'none' && !imageWorkflow.baseImage) throw new Error('官方图片工具需要先选择输入图片。');
    if (imageTool.type === 'director' && !DIRECTOR_TOOL_TYPES.has(String(imageTool.reqType || ''))) {
      throw new Error('导入记录识别为 Director 工具，但没有可识别的具体工具类型（req_type）；请重新选择 Director 工具。');
    }
  }
  if (!prompt && !usesCharacterPrompt && imageTool.type === 'none') {
    throw new Error('Prompt 不能为空；至少填写全局 Prompt 或一个角色 Prompt。');
  }
  if (referenceControl.mode === 'precise') {
    if (!supportsPreciseReference(model)) throw new Error('Precise Reference 当前仅支持 NovelAI V4.5。');
    if (!referenceControl.precise.length) throw new Error('Precise Reference 已开启，但没有参考图。');
  }
  if (referenceControl.mode === 'vibe') {
    if (!supportsVibeTransfer(model)) throw new Error('NovelAI V5 首发暂不支持 Vibe Transfer；请切回 V4/V4.5 或关闭 Vibe。');
    if (!referenceControl.vibes.length) throw new Error('Vibe Transfer 已开启，但没有参考图。');
  }

  return {
    provider: normalizeProviderId(raw?.provider),
    officialAccountId: /^[0-9a-f-]{16,80}$/i.test(String(raw?.officialAccountId || '')) || raw?.officialAccountId === 'env'
      ? String(raw.officialAccountId)
      : '',
    groups,
    characters,
    v4Options,
    imageWorkflow,
    imageTool,
    imageRecovery,
    workflowMetadata,
    referenceControl,
    experiment: sanitizeExperiment(raw?.experiment),
    promptOrderMode: raw?.promptOrderMode === 'original' ? 'original' : 'grouped',
    prompt,
    previewPrompt,
    negativePrompt,
    model,
    params: {
      width: integer(params.width, DEFAULT_GENERATION_PARAMS.width, 64, 2048),
      height: integer(params.height, DEFAULT_GENERATION_PARAMS.height, 64, 2048),
      steps: integer(params.steps, DEFAULT_GENERATION_PARAMS.steps, 1, 50),
      scale: number(params.scale, DEFAULT_GENERATION_PARAMS.scale, 0, 20),
      sampler: String(params.sampler || DEFAULT_GENERATION_PARAMS.sampler).slice(0, 80),
      noiseSchedule: String(params.noiseSchedule || DEFAULT_GENERATION_PARAMS.noiseSchedule).slice(0, 80),
      qualityToggle: bool(params.qualityToggle, DEFAULT_GENERATION_PARAMS.qualityToggle),
      ucPreset: integer(params.ucPreset, DEFAULT_GENERATION_PARAMS.ucPreset, 0, 9),
      cfgRescale: number(params.cfgRescale, DEFAULT_GENERATION_PARAMS.cfgRescale, 0, 1),
      sm: bool(params.sm, DEFAULT_GENERATION_PARAMS.sm),
      smDyn: bool(params.smDyn, DEFAULT_GENERATION_PARAMS.smDyn),
      preferBrownian: bool(params.preferBrownian, DEFAULT_GENERATION_PARAMS.preferBrownian),
      deliberateEulerAncestralBug: bool(params.deliberateEulerAncestralBug, DEFAULT_GENERATION_PARAMS.deliberateEulerAncestralBug),
      varietyBoost: number(params.varietyBoost, DEFAULT_GENERATION_PARAMS.varietyBoost, 0, 20),
      imageFormat: params.imageFormat === 'webp' ? 'webp' : 'png',
      nativeAlpha: bool(params.nativeAlpha, DEFAULT_GENERATION_PARAMS.nativeAlpha),
      // Request transport fields (image, mask, action, request_type, etc.) are
      // controlled by the workflow and are never accepted from the textarea.
      advancedOverrides: filterAdvancedOverrides(params.advancedOverrides),
      importedExtras: sanitizeImportedExtras(params.importedExtras)
    },
    seedMode: ['random', 'fixed', 'increment'].includes(raw?.seedMode) ? raw.seedMode : 'random',
    seed: integer(raw?.seed, 0, 0, 4294967295)
  };
}

export function buildPayload(state, seed, media = {}) {
  const workflow = state.imageWorkflow || { mode: 'text' };
  const recordedOperation = String(state.workflowMetadata?.operation || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const recoveryOperation = String(state.imageRecovery?.operation || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (recordedOperation === 'unknown' || recoveryOperation === 'unknown') {
    throw new Error('导入记录包含未识别的图片请求类型；请先手动选择工作流后再生成。');
  }
  if (hasAmbiguousTextImageState(state)) {
    throw new Error('导入记录同时带有文生图标记和输入图；请先在生成方式选择器确认文生图或图片工作流后再生成。');
  }
  const hasMediaSource = Boolean(media.baseImage || workflow.baseImage);
  if ((workflow.mode !== 'text' || (state.imageTool?.type && state.imageTool.type !== 'none')) && !hasMediaSource) {
    throw new Error('导入记录识别为图片工作流，但原图未随记录保存；请重新选择输入图片。');
  }
  if (workflow.mode === 'inpaint' && !(media.maskImage || workflow.maskImage)) {
    throw new Error('局部重绘需要先绘制并保存 Mask。');
  }
  if (state.imageTool?.type && state.imageTool.type !== 'none') {
    const source = media.baseImage || `[asset:${state.imageWorkflow?.baseImage?.id || 'unknown'}]`;
    const width = Number(state.params?.width || 0);
    const height = Number(state.params?.height || 0);
    const tool = state.imageTool;
    if (tool.type === 'upscale') {
      return {
        operation: 'upscale',
        endpoint: settings.upscaleApi,
        request: { image: source, model: apiModelFor(state.model) }
      };
    }
    if (tool.type !== 'director' || !DIRECTOR_TOOL_TYPES.has(String(tool.reqType || ''))) {
      throw new Error('导入记录识别为 Director 工具，但没有可识别的具体工具类型（req_type）；请重新选择 Director 工具。');
    }
    return {
      operation: 'director',
      endpoint: settings.augmentApi,
      request: {
        req_type: tool.reqType,
        width,
        height,
        image: source,
        ...(tool.reqType === 'colorize' || tool.reqType === 'emotion' ? { prompt: tool.prompt || '', defry: tool.defry || 0 } : {})
      }
    };
  }
  const p = state.params;
  const enhanceTarget = workflow.enhance === true
    ? safeEnhanceTargetDimensions(workflow.enhanceTargetWidth, workflow.enhanceTargetHeight)
    : null;
  const effectiveWidth = enhanceTarget?.width || p.width;
  const effectiveHeight = enhanceTarget?.height || p.height;
  const characterPromptTexts = (state.characters || [])
    .filter(item => item.enabled !== false)
    .slice(0, characterLimitFor(state.model))
    .map(item => compileTags(item.promptTags));
  const characterQuotedText = characterPromptTexts.flatMap(extractQuotedText);
  const preparedPrompt = prepareV5Prompt(state.prompt, state.model, characterQuotedText);
  const enhanceIsMax = workflow.enhance === true && workflow.enhanceUpscaleFactor === 'max';
  if (enhanceIsMax && !isV5Model(state.model)) {
    throw new Error('NovelAI Enhance Max✨ 仅支持 V5 Full / V5 Curated。');
  }
  const effectivePrompt = workflow.enhance === true && !enhanceIsMax
    ? officialEnhancePrompt(preparedPrompt.prompt)
    : preparedPrompt.prompt;
  const parameters = {
    // NovelAI's V5 API uses the v4 prompt envelope with params_version 4;
    // older models remain on the long-established version 3 envelope.
    params_version: isV5Model(state.model) ? 4 : 3,
    width: effectiveWidth,
    height: effectiveHeight,
    scale: p.scale,
    sampler: p.sampler,
    steps: p.steps,
    n_samples: 1,
    ucPreset: p.ucPreset,
    qualityToggle: p.qualityToggle,
    noise_schedule: p.noiseSchedule,
    cfg_rescale: p.cfgRescale,
    seed,
    extra_noise_seed: seed,
    negative_prompt: state.negativePrompt,
    prompt: effectivePrompt,
    sm: p.sm,
    sm_dyn: p.smDyn,
    prefer_brownian: p.preferBrownian,
    deliberate_euler_ancestral_bug: p.deliberateEulerAncestralBug,
    image_format: p.imageFormat,
    dynamic_thresholding: false,
    legacy: false,
    legacy_v3_extend: false,
    ...filterAdvancedOverrides(p.advancedOverrides)
  };

  if (p.varietyBoost > 0) parameters.skip_cfg_above_sigma = p.varietyBoost;
  if (isV5Model(state.model) && p.nativeAlpha) {
    parameters.image_format = 'png';
    parameters.straight_alpha = true;
    parameters.tag_hint_transparent_background = true;
  }

  // SMEA is a text-to-image high-resolution sampler; preserve imported values
  // for normal generation but avoid sending them with Img2Img/Inpaint requests.
  if (workflow.mode !== 'text') {
    parameters.sm = false;
    parameters.sm_dyn = false;
  }
  let action = 'generate';
  let requestModel = apiModelFor(state.model);
  if (workflow.mode === 'img2img') {
    action = 'img2img';
    if (media.baseImage) parameters.image = media.baseImage;
    parameters.strength = workflow.strength;
    parameters.noise = workflow.noise;
    parameters.color_correct = workflow.colorCorrect === true;
    if (enhanceIsMax) parameters.upscaled_enhance = true;
  } else if (workflow.mode === 'inpaint') {
    action = 'infill';
    requestModel = inpaintModelFor(state.model);
    if (media.baseImage) parameters.image = media.baseImage;
    if (media.maskImage) parameters.mask = media.maskImage;
    parameters.add_original_image = false;
    parameters.img2img = {
      strength: workflow.strength,
      noise: workflow.noise,
      color_correct: workflow.colorCorrect === true,
      extra_noise_seed: seed
    };
  }

  const references = state.referenceControl || { mode: 'none' };
  if (references.mode === 'precise' && media.precise?.length) {
    parameters.director_reference_images = media.precise.map(item => item.image);
    parameters.director_reference_descriptions = media.precise.map(item => ({
      caption: { base_caption: item.type, char_captions: [] }, use_coords: false, use_order: true
    }));
    parameters.director_reference_information_extracted = media.precise.map(() => 1);
    parameters.director_reference_strength_values = media.precise.map(item => item.strength);
    parameters.director_reference_secondary_strength_values = media.precise.map(item => item.fidelity);
  } else if (references.mode === 'vibe' && media.vibes?.length) {
    parameters.reference_image_multiple = media.vibes.map(item => item.image);
    parameters.reference_strength_multiple = media.vibes.map(item => item.strength);
    parameters.reference_information_extracted_multiple = media.vibes.map(item => item.informationExtracted);
  }

  if (supportsCharacterPrompt(state.model)) {
    const enabledCharacters = (state.characters || []).filter(item => item.enabled !== false).slice(0, characterLimitFor(state.model));
    const charCaptions = enabledCharacters.map(item => ({
      char_caption: compileTags(item.promptTags),
      centers: sanitizeCenters(item.centers)
    }));
    const charNegativeCaptions = enabledCharacters.map(item => ({
      char_caption: compileTags(item.ucTags),
      centers: sanitizeCenters(item.centers)
    }));
    const v4 = state.v4Options || {};
    parameters.v4_prompt = {
      caption: { base_caption: effectivePrompt, char_captions: charCaptions },
      use_coords: v4.useCoords === true,
      use_order: v4.useOrder !== false
    };
    parameters.v4_negative_prompt = {
      caption: { base_caption: state.negativePrompt, char_captions: charNegativeCaptions },
      legacy_uc: v4.legacyUc === true,
      use_coords: v4.useCoords === true,
      use_order: v4.negativeUseOrder === true
    };
  }

  return {
    input: state.prompt,
    model: requestModel,
    action,
    parameters
  };
}

export function safeEnhanceTargetDimensions(width, height) {
  let nextWidth = optionalImageDimension(width);
  let nextHeight = optionalImageDimension(height);
  if (!nextWidth || !nextHeight) return null;
  const maxPixels = 3_145_728;
  if (nextWidth * nextHeight > maxPixels) {
    const ratio = Math.sqrt(maxPixels / (nextWidth * nextHeight));
    nextWidth = Math.max(64, Math.floor(nextWidth * ratio / 64) * 64);
    nextHeight = Math.max(64, Math.floor(nextHeight * ratio / 64) * 64);
  }
  return { width: nextWidth, height: nextHeight };
}


export function generationGalleryKind(state) {
  return state?.experiment?.type === 'style-iteration' ? 'iteration' : state?.experiment?.type === 'artist-rotation' ? 'rotation' : 'gallery';
}
