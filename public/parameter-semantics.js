/*
 * Shared interpretation of NovelAI request metadata.
 *
 * PNG/JSON metadata is a description of a request, not an arbitrary object
 * that can safely be pasted into the advanced-parameter textarea.  Keep the
 * classification in this small, browser-safe module so the server inspector
 * and the browser importer cannot drift apart.
 */
import { DEFAULT_ENHANCE_UPSCALE_FACTOR } from './generation-state.js?v=1.8.8';

export const IMAGE_WORKFLOW_PARAMETER_KEYS = Object.freeze(new Set([
  'image', 'mask', 'input_image', 'inputimage', 'base_image', 'baseimage', 'source_image', 'sourceimage', 'original_image', 'originalimage', 'mask_image', 'maskimage', 'strength', 'noise',
  'color_correct', 'colorcorrect', 'add_original_image', 'addoriginalimage', 'img2img', 'i2i', 'image2image', 'upscaled_enhance', 'upscaledenhance',
  'enhance', 'enhance_upscale_factor', 'enhanceupscalefactor'
]));

// Ordinary editor controls already have a dedicated destination in the
// restored state.  Keep them out of the free-form advanced bucket as well,
// otherwise a stale Raw Parameters object can override the visible controls
// while making the source of truth unclear.
export const NORMAL_PARAMETER_KEYS = Object.freeze(new Set([
  'prompt', 'negative_prompt', 'negativeprompt', 'uc', 'v4_prompt', 'v4prompt',
  'v4_negative_prompt', 'v4negativeprompt', 'width', 'height', 'steps', 'scale',
  'sampler', 'noise_schedule', 'noiseschedule', 'seed', 'extra_noise_seed',
  'extranoiseseed', 'n_samples', 'nsamples', 'ucpreset', 'uc_preset',
  'qualitytoggle', 'quality_toggle', 'cfg_rescale', 'cfgrescale', 'sm',
  'sm_dyn', 'smdyn', 'prefer_brownian', 'preferbrownian',
  'deliberate_euler_ancestral_bug', 'deliberateeulerancestralbug',
  'image_format', 'imageformat', 'native_alpha', 'nativealpha',
  'variety_boost', 'varietyboost', 'imported_extras', 'importedextras',
  // Text exports often use a single `size` field which the importer expands
  // into width/height; it is still an ordinary control, never an override.
  'size',
  'use_coords', 'usecoords', 'use_order', 'useorder', 'legacy_uc', 'legacyuc'
]));

// These keys belong to Pocket's editor/persistence envelope, not to the
// NovelAI RequestParameters object.  Blocking them prevents a copied whole
// generation state from masquerading as an advanced override.
export const STATE_ONLY_PARAMETER_KEYS = Object.freeze(new Set([
  'seed_mode', 'seedmode', 'provider', 'official_account_id', 'officialaccountid',
  'image_workflow', 'imageworkflow', 'image_tool', 'imagetool',
  'reference_control', 'referencecontrol', 'workflow_metadata', 'workflowmetadata',
  'direct_mode', 'directmode', 'preview_prompt', 'previewprompt', 'prompt_order_mode', 'promptordermode',
  'negative_use_order', 'negativeuseorder', 'experiment', 'image_recovery', 'imagerecovery',
  'embedded_input_image', 'embeddedinputimage', 'embedded_mask_image', 'embeddedmaskimage',
  'source_format', 'sourceformat', 'model_detected', 'modeldetected', 'model_evidence', 'modelevidence',
  'model_source', 'modelsource', 'warnings', 'syntax_repairs', 'syntaxrepairs', 'raw_object', 'rawobject',
  'raw_text', 'rawtext', 'mode', 'type', 'status', 'precise', 'vibes',
  'advanced_overrides', 'advancedoverrides', 'imported_extras', 'importedextras',
  'groups', 'characters', 'v4_options', 'v4options'
]));

export const REQUEST_METADATA_KEYS = Object.freeze(new Set([
  'action', 'operation', 'request_type', 'requesttype', 'req_type', 'reqtype', 'input', 'model', 'model_name',
  'model_id', 'modelid', 'model_hash', 'signed_hash', 'version', 'params_version',
  'stream', 'image_format', 'legacy', 'legacy_v3_extend', 'extra_passthrough_testing', 'modelname', 'modelhash',
  'uncond_scale', 'dynamic_thresholding_percentile', 'dynamic_thresholding_mimic_scale',
  'skip_cfg_below_sigma', 'cfg_sched_eligibility', 'explike_fine_detail',
  'minimize_sigma_inf', 'uncond_per_vibe', 'wonky_vibe_correlation', 'quality_boost',
  'tag_hint_uc_preset', 'tag_hint_qt', 'straight_alpha', 'tag_hint_transparent_background', 'defry', 'qualityboost',
  'skip_cfg_above_sigma', 'upscale', 'pd_grid', 'hide_debug_overlay', 'negative_momentum', 'crash_hydra',
  'r', 'eta', 'original_width', 'original_height', 'crop_top', 'crop_left', 'quality_boost', 'upscaled_enhance', 'declared_blur_sigma',
  'upscaled_width', 'upscaled_height', 'target_width', 'target_height',
  'lora_unet_weights', 'lora_clip_weights',
  // Exporter/UI aliases that describe output dimensions or the selected
  // Director tool; they are metadata/workflow routing, never free-form API
  // overrides.
  'size', 'director_tool', 'director_tool_type', 'tool',
  // Common exporter-only aliases.  These are record/signature/debug data,
  // not NovelAI RequestParameters, even when a PNG writer uses a short key.
  'hash', 'signature', 'signature_hash', 'signed', 'debug', 'debug_overlay',
  'metadata', 'comment', 'raw_parameters', 'parameters', 'software', 'source',
  'title', 'description', 'request_id', 'job_id', 'timestamp', 'created_at', 'updated_at'
]));

// This is intentionally a small allowlist for fields that can be forwarded as
// genuine extra RequestParameters when they arrive through an importer.  A
// user may still type other scalar keys manually (filterAdvancedOverrides keeps
// them for forward compatibility), but exported PNG/JSON records must not
// promote arbitrary metadata into the upstream request.
export const KNOWN_ADVANCED_PARAMETER_KEYS = Object.freeze(new Set([
  'controlnet_condition', 'controlnet_model', 'controlnet_strength',
  'dynamic_thresholding'
]));

const ADVANCED_KEY_ALIASES = new Map([...KNOWN_ADVANCED_PARAMETER_KEYS].map(key => [compactKey(key), key]));

/** Return the canonical API spelling for a known advanced field alias. */
export function canonicalAdvancedParameterKey(key) {
  return ADVANCED_KEY_ALIASES.get(compactKey(key)) || String(key || '');
}

export const DIRECTOR_TOOL_TYPES = Object.freeze(new Set([
  'lineart', 'sketch', 'bg-removal', 'declutter', 'colorize', 'emotion'
]));

function normalizeDirectorRequestType(value) {
  const compact = operationText(value);
  if (!compact) return '';
  if (compact.includes('lineart')) return 'lineart';
  if (compact.includes('sketch')) return 'sketch';
  if (compact.includes('bgremoval') || compact.includes('removebackground') || compact.includes('backgroundremoval')) return 'bg-removal';
  if (compact.includes('declutter')) return 'declutter';
  if (compact.includes('colorize') || compact.includes('colourize')) return 'colorize';
  if (compact.includes('emotion')) return 'emotion';
  return '';
}

export const REFERENCE_METADATA_PREFIXES = Object.freeze(['reference_', 'director_reference_']);

const IMAGE_MIME_RE = /^image\/(?:png|jpeg|jpg|webp)$/i;
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=\s]+)$/i;
const BARE_BASE64_RE = /^[a-z0-9+/]+={0,2}$/i;
export const MAX_EMBEDDED_IMAGE_BYTES = 16 * 1024 * 1024;

function keyName(key) { return String(key || '').trim().toLowerCase(); }
function compactKey(key) { return keyName(key).replace(/[^a-z0-9]/g, ''); }

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, fallback, min, max) {
  const n = finite(value, fallback);
  return Math.min(max, Math.max(min, n));
}

function boolish(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(text)) return true;
  if (['false', 'no', 'off', '0'].includes(text)) return false;
  return fallback;
}

function anyBoolish(objects, keys) {
  const wanted = new Set(keys.map(compactKey));
  return objects.some(object => object && typeof object === 'object'
    && Object.entries(object).some(([key, value]) => wanted.has(compactKey(key)) && value != null && boolish(value, false)));
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstValue(objects, keys) {
  const wanted = keys.map(compactKey);
  for (const object of objects) {
    if (!object || typeof object !== 'object') continue;
    for (const key of wanted) {
      const found = Object.entries(object).find(([name, value]) => compactKey(name) === key && value != null);
      if (found) return found[1];
    }
  }
  return undefined;
}

// `null` is the exporter’s usual “not configured” marker, but empty strings,
// false booleans, and zero-valued defaults occur in copied request envelopes as
// well.  They must not by themselves turn a text request into Img2Img/Inpaint.
function meaningfulWorkflowValue(value, kind = '') {
  if (value == null) return false;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (!text || ['false', 'no', 'off', '0', '0.0', 'null', 'none'].includes(text)) return false;
    if (kind === 'strength' || kind === 'noise') {
      const numeric = Number(text);
      return Number.isFinite(numeric) ? numeric > 0 : true;
    }
    return true;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && (kind === 'strength' || kind === 'noise' ? value > 0 : value !== 0);
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'object' && Object.keys(value).length > 0;
}

function operationText(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function operationFromText(value) {
  const text = operationText(value);
  if (!text) return '';
  // Explicit text-generation names must win over stale image fields left by
  // exporters that copied a previous request into the same metadata object.
  if (/^(?:promptgenerate|promptgeneration|text2image|texttoimage|texttoimg|text2img|txt2img|txt2image|txttoimg|t2i|nativegenerate|generate|generateimage|imagegenerate|imagegeneration|textgeneration|texttoimagegeneration)(?:request|operation)?$/.test(text)) return 'text';
  if (/(?:infill|inpaint|nativeinfilling|maskgeneration)/.test(text)) return 'inpaint';
  // Enhance is an Img2Img diffusion pass even when an exporter calls it an
  // “EnhanceUpscale” request.  Check it before the dedicated Upscale names.
  if (/(?:img2img|i2i|image2image|imagetoimage|enhance(?:upscale|image)?|upscaleenhance|upscaledenhance)/.test(text)) return 'img2img';
  if (/(?:director|augment|lineart|sketch|bgremoval|removebackground|backgroundremoval|declutter|colorize|emotion)/.test(text)) return 'director';
  // Dedicated Upscale is intentionally narrow: a generic substring match
  // would turn EnhanceUpscaleRequest into the fixed 4× endpoint.
  if (/^(?:upscale|upscaling|upscalingrequest|imageupscale|imageupscaling|upscaleimage|superresolution|superresolutionimage|imagesuperresolution|upscalerequest|imageupscalerequest|upscaleimagerequest|imageupscalingrequest|superresolutionimagerequest|imagesuperresolutionrequest|nativeupscale|nativeupscaling|nativeupscalerequest|nativeupscalingrequest|superresolutionrequest|upscaleoperation)$/.test(text)) return 'upscale';
  return '';
}

function looksLikeImageRequestDescriptor(value) {
  const text = operationText(value);
  // Reference/Vibe requests carry images too, but they are not base-image
  // Img2Img jobs.  If an exporter uses a name we do not understand, keep the
  // whole request unresolved instead of silently routing it to generation.
  return Boolean(text && /(?:image|img2img|inpaint|infill|upscale|director|augment|controlnet|mask|vibe|reference|precise)/.test(text));
}

function upscaleValueEnabled(value) {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    return Boolean(text) && !['false', '0', '0.0', 'null', 'none', 'off'].includes(text);
  }
  // NovelAI exports may encode Upscale options as an object (for example an
  // object containing declared_blur_sigma). Presence of that object is meaningful.
  return typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

/** Infer the request's operation without relying on the presence of media. */
export function inferImageOperation(parameters = {}, envelope = {}) {
  const params = objectValue(parameters);
  const outer = objectValue(envelope);
  const outerParameters = objectValue(firstValue([outer], ['parameters']));
  const passthrough = objectValue(firstValue([params, outerParameters], ['extra_passthrough_testing']));
  // Explicit request descriptors outrank a generic `upscale` option.  The
  // latter is also used as an output/enhance flag on ordinary Img2Img
  // records; treating it as a dedicated Upscale endpoint would lose the
  // original workflow and force an unnecessary second upscale.
  const explicitCandidates = [
    ['request_type', firstValue([outer], ['request_type'])], ['req_type', firstValue([outer], ['req_type'])],
    ['request_type', firstValue([params], ['request_type'])], ['req_type', firstValue([params], ['req_type'])],
    ['request_type', firstValue([outerParameters], ['request_type'])], ['req_type', firstValue([outerParameters], ['req_type'])],
    ['request_type', firstValue([passthrough], ['request_type'])],
    ['operation', firstValue([outer], ['operation'])], ['operation', firstValue([params], ['operation'])],
    ['operation', firstValue([outerParameters], ['operation'])],
    ['operation', firstValue([passthrough], ['operation'])],
    ['action', firstValue([outer], ['action'])], ['action', firstValue([params], ['action'])],
    ['action', firstValue([outerParameters], ['action'])],
    ['action', firstValue([passthrough], ['action'])]
  ];
  const neutralGenerate = new Set(['generate', 'generateimage', 'imagegeneration']);
  // The public API also wraps requests in generic envelope names.  These are
  // not operation descriptors: let a real action or embedded media decide
  // whether the inner request is text, Img2Img, or Inpaint.
  const neutralRequestEnvelope = new Set(['imagegenerationrequest', 'generateimagerequest']);
  const explicitEntries = explicitCandidates
    .filter(([label, value]) => value != null
      && !(['action', 'operation'].includes(label) && neutralGenerate.has(operationText(value)))
      && !(['request_type', 'req_type'].includes(label) && neutralRequestEnvelope.has(operationText(value))))
    .map(([label, value]) => ({ label, value, operation: operationFromText(value) }));
  const recognizedOperations = [...new Set(explicitEntries.map(item => item.operation).filter(Boolean))];
  const unknownImageDescriptor = explicitEntries.some(item => !item.operation && looksLikeImageRequestDescriptor(item.value));
  // A copied metadata request_type and an API action can disagree (for
  // example Img2ImgRequest + action=infill).  Treat that as unresolved rather
  // than choosing whichever field happened to be listed first.
  if (recognizedOperations.length > 1 || (recognizedOperations.length && unknownImageDescriptor)) return 'unknown';
  if (recognizedOperations.length === 1) return recognizedOperations[0];
  // Do not silently downgrade an unknown image-like request to text-to-image.
  // The caller can show an unresolved workflow and ask the user to choose the
  // operation instead of spending a request on the wrong endpoint.
  if (unknownImageDescriptor) return 'unknown';

  // The dedicated /ai/upscale endpoint accepts a small top-level object in
  // some exporters: image + declared_blur_sigma, with no action/request_type.
  // Recognize that shape only when ordinary generation fields are absent;
  // otherwise leave the media-driven workflow inference in charge.  The
  // `upscale` parameter is also legal on ordinary generate-image requests,
  // so it is not a dedicated-endpoint marker when Prompt/size/steps/etc. are
  // present.
  const explicitUpscale = [firstValue([params], ['upscale']), firstValue([outer], ['upscale']), firstValue([outerParameters], ['upscale']), firstValue([passthrough], ['upscale'])].some(upscaleValueEnabled);
  const declaredBlur = firstValue([params, outer, outerParameters], ['declared_blur_sigma', 'declaredBlurSigma']);
  const upscaleSource = firstValue([params, outer, outerParameters], ['image', 'input_image', 'base_image', 'source_image', 'original_image']);
  const generationMarker = firstValue([params, outer, outerParameters], ['prompt', 'input', 'text', 'steps', 'width', 'height', 'scale', 'seed']);
  const contentGenerationMarker = firstValue([params, outer, outerParameters], ['prompt', 'input', 'text', 'steps', 'seed']);
  const hasGenerateAction = [outer, params, outerParameters, passthrough]
    .some(source => ['action', 'operation']
      .some(key => neutralGenerate.has(operationText(firstValue([source], [key])))));
  // Older clients used the `/ai/upscale` shape `{image, width, height,
  // scale: 2|4}` and omitted both `request_type` and `declared_blur_sigma`.
  // Width/height are output dimensions here, not ordinary generation markers;
  // require the characteristic scale and no prompt/steps/seed to avoid
  // stealing a normal Img2Img request.
  const legacyScale = Number(firstValue([params, outer, outerParameters], ['scale']));
  const legacyWidth = Number(firstValue([params, outer, outerParameters], ['width']));
  const legacyHeight = Number(firstValue([params, outer, outerParameters], ['height']));
  if (!hasGenerateAction && meaningfulWorkflowValue(upscaleSource, 'image')
    && [2, 4].includes(legacyScale) && Number.isFinite(legacyWidth) && legacyWidth > 0
    && Number.isFinite(legacyHeight) && legacyHeight > 0 && contentGenerationMarker == null) return 'upscale';
  if (explicitUpscale && generationMarker == null && !hasGenerateAction) return 'upscale';
  // `declared_blur_sigma: 0` is a valid official UpscaleRequest value, so do
  // not use the generic non-zero guard for this particular numeric option.
  const hasDeclaredBlur = declaredBlur != null
    && Number.isFinite(Number(declaredBlur)) && Number(declaredBlur) >= 0;
  if (hasDeclaredBlur
    && meaningfulWorkflowValue(upscaleSource, 'image') && generationMarker == null) return 'upscale';

  const nested = objectValue(firstValue([params, outerParameters, outer], ['img2img']));
  const nestedI2i = objectValue(firstValue([params, outerParameters, outer], ['i2i', 'image2image']));
  const nestedI2iHasMask = meaningfulWorkflowValue(firstValue([params, outer, outerParameters, nestedI2i], ['mask', 'mask_image']), 'mask');
  // Some third-party wrappers use `i2i`/`image2image` instead of NovelAI's
  // nested `img2img`. Those names describe an Img2Img operation, not the
  // Native Inpainting-shaped `img2img` envelope used by the official export.
  if (Object.keys(nestedI2i).length) return nestedI2iHasMask ? 'inpaint' : 'img2img';
  // Native infill requests commonly keep Strength/Noise in a nested img2img
  // object while the outer image/mask fields may be omitted from metadata.
  if (Object.keys(nested).length && firstValue([params, outer, outerParameters, nested], ['mask', 'mask_image']) != null) return 'inpaint';
  // Without an explicit Img2Img request descriptor, a nested `img2img`
  // envelope is the shape NovelAI uses for Native Inpainting.  Keep the
  // conservative inpaint intent even when an image is present; an explicit
  // `Img2ImgRequest` above still wins for ordinary Img2Img exports.
  if (Object.keys(nested).length && firstValue([params, outer, outerParameters], ['image', 'input_image', 'base_image']) == null) return 'inpaint';
  if (Object.keys(nested).length) return 'inpaint';
  if (meaningfulWorkflowValue(firstValue([params, outer, outerParameters], ['mask', 'mask_image']), 'mask')) return 'inpaint';
  if (meaningfulWorkflowValue(firstValue([params, outer, outerParameters], ['image', 'input_image', 'base_image', 'source_image', 'original_image']), 'image')) return 'img2img';
  const strength = firstValue([params, outer, outerParameters], ['strength']);
  const noise = firstValue([params, outer, outerParameters], ['noise']);
  const colorCorrect = firstValue([params, outer, outerParameters], ['color_correct']);
  const enhance = firstValue([params, outer, outerParameters], ['upscaled_enhance']);
  const genericEnhance = firstValue([params, outer, outerParameters], ['enhance']);
  if (meaningfulWorkflowValue(strength, 'strength') || meaningfulWorkflowValue(noise, 'noise')
    || meaningfulWorkflowValue(colorCorrect, 'color_correct') || meaningfulWorkflowValue(enhance, 'upscaled_enhance')
    || meaningfulWorkflowValue(genericEnhance, 'enhance')) return 'img2img';
  return 'text';
}

function mimeFromBase64(base64) {
  const value = String(base64 || '').replace(/\s+/g, '');
  if (value.startsWith('iVBORw0KGgo')) return 'image/png';
  if (value.startsWith('/9j/')) return 'image/jpeg';
  if (value.startsWith('UklGR')) return 'image/webp';
  // A bare Base64 field has no MIME declaration.  Do not guess PNG for an
  // arbitrary long ASCII value (for example a copied ID or Prompt); only
  // recognized image magic prefixes are eligible for automatic recovery.
  return '';
}

function estimatedBytes(base64) {
  const value = String(base64 || '').replace(/\s+/g, '');
  if (!value) return 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0));
}

/**
 * Normalize a media value from a request.  Asset references are deliberately
 * marked unresolved; they are not allowed to masquerade as advanced JSON.
 */
export function extractEmbeddedImage(value, { sourceKey = 'image', maxBytes = MAX_EMBEDDED_IMAGE_BYTES } = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // Exporters disagree on whether the encoded bytes live under `data`,
    // `base64`, or `url`; try each string candidate instead of letting a
    // non-string `data` value hide a valid fallback.
    for (const objectData of [value.data, value.base64, value.url]) {
      if (typeof objectData !== 'string') continue;
      const nested = extractEmbeddedImage(objectData, { sourceKey, maxBytes });
      if (nested && value.mime && nested.status === 'embedded' && IMAGE_MIME_RE.test(String(value.mime))) {
        nested.mime = String(value.mime).toLowerCase().replace('image/jpg', 'image/jpeg');
        nested.dataUrl = `data:${nested.mime};base64,${nested.base64}`;
      }
      if (nested) return nested;
    }
    const directId = value.source === 'asset' && value.id ? value.id
      : value.ref && typeof value.ref === 'object' && value.ref.id ? value.ref.id
        : typeof value.ref === 'string' && (/^[0-9a-f-]{16,80}$/i.test(value.ref) || /^asset:\/\/?[0-9a-f-]{16,80}$/i.test(value.ref))
          ? value.ref.replace(/^asset:\/\/?/i, '') : '';
    if (directId && /^[0-9a-f-]{16,80}$/i.test(String(directId))) {
      return { status: 'unresolved', sourceKey, ref: `[asset:${String(directId)}]` };
    }
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^\[asset:[^\]]+\]$/i.test(text)) return { status: 'unresolved', sourceKey, ref: text };
  const assetUrl = text.match(/^asset:\/\/?([0-9a-f-]{16,80})$/i);
  if (assetUrl) return { status: 'unresolved', sourceKey, ref: `[asset:${assetUrl[1]}]` };

  let mime = '';
  let base64 = '';
  const dataMatch = text.match(DATA_URL_RE);
  if (dataMatch) {
    mime = dataMatch[1].toLowerCase().replace('image/jpg', 'image/jpeg');
    base64 = dataMatch[2].replace(/\s+/g, '');
  } else {
    const compact = text.replace(/\s+/g, '');
    if (compact.length < 64 || !BARE_BASE64_RE.test(compact) || compact.length % 4 === 1) return null;
    base64 = compact;
    mime = mimeFromBase64(base64);
  }
  if (!IMAGE_MIME_RE.test(mime) || !base64 || !BARE_BASE64_RE.test(base64)) return null;
  const bytes = estimatedBytes(base64);
  if (!bytes || bytes > maxBytes) return { status: 'too-large', sourceKey, mime, bytes };
  return {
    status: 'embedded',
    sourceKey,
    mime,
    bytes,
    base64,
    dataUrl: `data:${mime};base64,${base64}`
  };
}

function candidateValues(parameters, envelope, names) {
  const params = objectValue(parameters);
  const outer = objectValue(envelope);
  const outerParameters = objectValue(firstValue([outer], ['parameters']));
  const nested = objectValue(firstValue([params], ['img2img', 'i2i', 'image2image']));
  const outerNested = objectValue(firstValue([outerParameters], ['img2img', 'i2i', 'image2image']));
  const directOuterNested = objectValue(firstValue([outer], ['img2img', 'i2i', 'image2image']));
  const upscaleOptions = objectValue(firstValue([params, outerParameters, outer], ['upscale']));
  const passthrough = objectValue(firstValue([params], ['extra_passthrough_testing']));
  const values = [];
  for (const source of [outer, params, nested, outerNested, directOuterNested, upscaleOptions, passthrough, outerParameters]) {
    if (!source || typeof source !== 'object') continue;
    const wanted = new Set(names.map(compactKey));
    for (const [name, value] of Object.entries(source)) {
      if (wanted.has(compactKey(name))) values.push({ value, sourceKey: name });
    }
  }
  return values;
}

function chooseMedia(parameters, envelope, names) {
  const rank = { embedded: 3, unresolved: 2, 'too-large': 1 };
  let best = null;
  for (const candidate of candidateValues(parameters, envelope, names)) {
    const media = extractEmbeddedImage(candidate.value, { sourceKey: candidate.sourceKey });
    if (!media) continue;
    if (!best || (rank[media.status] || 0) > (rank[best.status] || 0)) best = media;
    if (best.status === 'embedded') break;
  }
  return best;
}

function operationLabel(operation) {
  return operation === 'inpaint' ? '局部重绘' : operation === 'img2img' ? '图生图' : operation === 'upscale' ? 'Upscale' : operation === 'director' ? 'Director 工具' : operation === 'unknown' ? '未知图片工作流' : '文生图';
}

function inferEnhanceUpscaleFactor(targetWidth, targetHeight, baseWidth, baseHeight, hasMaxFlag) {
  if (hasMaxFlag && targetWidth && targetHeight) return 'max';
  const ratios = [];
  if (targetWidth > 0 && baseWidth > 0) ratios.push(targetWidth / baseWidth);
  if (targetHeight > 0 && baseHeight > 0) ratios.push(targetHeight / baseHeight);
  if (!ratios.length) return 1.5;
  const ratio = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
  // NovelAI rounds Enhance targets to model-friendly dimensions and may cap
  // 2× requests at the pixel budget (for example 1024→1773), so use a
  // conservative threshold instead of exposing a misleading exact ratio.
  if (ratio >= 1.72) return 2;
  if (ratio >= 1.25) return 1.5;
  return 1;
}

/**
 * Split a request into editor workflow state and genuinely advanced fields.
 * `imageWorkflow.baseImage` remains null until the browser uploads an embedded
 * image; this keeps the result serializable and makes missing source images
 * explicit instead of silently changing the operation to text generation.
 */
export function classifyNaiParameters(parameters = {}, envelope = {}) {
  const params = objectValue(parameters);
  const outer = objectValue(envelope);
  const outerParameters = objectValue(firstValue([outer], ['parameters']));
  const nested = objectValue(firstValue([params, outerParameters, outer], ['img2img', 'i2i', 'image2image']));
  const passthrough = objectValue(firstValue([params, outerParameters], ['extra_passthrough_testing']));
  const operation = inferImageOperation(params, outer);
  const source = chooseMedia(params, outer, [
    'image', 'input_image', 'inputImage', 'base_image', 'baseImage',
    'source_image', 'sourceImage', 'original_image', 'originalImage'
  ]);
  const mask = chooseMedia(params, outer, ['mask', 'mask_image', 'maskImage']);
  const strength = clamp(firstValue([params, outerParameters, nested, outer], ['strength']), 0.65, 0, 1);
  const noise = clamp(firstValue([params, outerParameters, nested, outer], ['noise']), 0, 0, 1);
  const colorCorrect = anyBoolish([params, outerParameters, nested, outer], ['color_correct', 'colorCorrect']);
  const upscaledEnhanceFlag = anyBoolish([params, outerParameters, nested, outer], ['upscaled_enhance']);
  const enhanceFlag = upscaledEnhanceFlag || anyBoolish([params, outerParameters, nested, outer], ['enhance']);
  const targetWidth = finite(firstValue([params, outerParameters, nested, outer], ['upscaled_width', 'upscaledWidth', 'target_width', 'targetWidth']), null);
  const targetHeight = finite(firstValue([params, outerParameters, nested, outer], ['upscaled_height', 'upscaledHeight', 'target_height', 'targetHeight']), null);
  const baseWidth = finite(firstValue([params, outerParameters, nested, outer], ['width']), null);
  const baseHeight = finite(firstValue([params, outerParameters, nested, outer], ['height']), null);
  const descriptorKeys = new Set(['request_type', 'req_type', 'operation', 'action'].map(compactKey));
  const descriptorText = [outer, params, passthrough]
    .flatMap(source => Object.entries(source)
      .filter(([key, value]) => descriptorKeys.has(compactKey(key)) && value != null)
      .map(([, value]) => operationText(value)))
    .join(' ');
  const enhance = operation === 'img2img' && (
    enhanceFlag
    || /enhance/.test(descriptorText)
  );
  const rawMode = operation === 'inpaint' ? 'inpaint' : operation === 'img2img' ? 'img2img' : 'text';
  const imageWorkflow = {
    mode: rawMode,
    baseImage: null,
    maskImage: null,
    strength,
    noise,
    colorCorrect,
    enhance,
    enhanceUpscaleFactor: enhance ? inferEnhanceUpscaleFactor(targetWidth, targetHeight, baseWidth, baseHeight, upscaledEnhanceFlag) : DEFAULT_ENHANCE_UPSCALE_FACTOR,
    enhanceTargetWidth: Number.isFinite(targetWidth) && targetWidth > 0 ? Math.round(targetWidth) : null,
    enhanceTargetHeight: Number.isFinite(targetHeight) && targetHeight > 0 ? Math.round(targetHeight) : null
  };
  const directorCandidates = [
    firstValue([params, outer, passthrough], ['req_type', 'director_tool', 'director_tool_type', 'tool']),
    firstValue([params, outer, passthrough], ['operation']),
    firstValue([params, outer, passthrough], ['request_type'])
  ];
  const directorType = operation === 'director'
    ? directorCandidates.map(normalizeDirectorRequestType).find(Boolean) || ''
    : '';
  const imageTool = operation === 'upscale'
    ? { type: 'upscale', scale: 4, reqType: '', prompt: '', defry: 0 }
    : operation === 'director'
      ? { type: 'director', scale: 4, reqType: directorType || 'unknown', prompt: String(firstValue([params, outer], ['prompt']) || ''), defry: clamp(firstValue([params, outer], ['defry']), 0, 0, 5) }
      : { type: 'none', scale: 4, reqType: '', prompt: '', defry: 0 };
  // A dedicated Upscale result may carry the source PNG's old Text2Image
  // Comment.  The bytes are useful, but they cannot prove which endpoint was
  // used; preserve an explicit ambiguity marker so restore/queue paths can
  // require the user's choice instead of silently routing the request.
  // A Text2Image marker paired with any concrete media evidence is not safe to
  // route automatically.  The source may be embedded, oversized, or only an
  // asset reference; in all three cases the record could be a dedicated
  // Upscale/Img2Img export carrying stale text metadata.
  const ambiguousTextImage = operation === 'text'
    && ['embedded', 'too-large', 'unresolved'].includes(String(source?.status || '').toLowerCase());

  let imageRecovery = {
    status: 'none', operation, label: operationLabel(operation),
    ambiguous: ambiguousTextImage,
    reason: ambiguousTextImage
      ? '记录标为文生图但含输入图；可能是专用 Upscale 复制的旧 Comment。请手动选择工作流。'
      : ''
  };
  if (operation !== 'text') {
    const needsMask = operation === 'inpaint';
    if (operation === 'unknown') {
      imageRecovery = {
        status: 'unresolved', operation, label: operationLabel(operation), source, mask,
        reason: '记录包含未识别的图片请求类型；请手动选择文生图、图生图、局部重绘或官方图片工具后再生成。'
      };
    } else if (operation === 'director' && !DIRECTOR_TOOL_TYPES.has(directorType)) {
      imageRecovery = {
        status: 'unresolved', operation, label: operationLabel(operation), source, mask,
        reason: '检测到 Director 工具请求，但记录没有可识别的具体工具类型（req_type）；请重新选择工具后再生成。'
      };
    } else if (source?.status === 'embedded' && (!needsMask || mask?.status === 'embedded')) {
      imageRecovery = { status: 'ready', operation, label: operationLabel(operation), source, mask: needsMask ? mask : null };
    } else if (source?.status === 'too-large' || mask?.status === 'too-large') {
      imageRecovery = { status: 'too-large', operation, label: operationLabel(operation), source, mask, reason: '嵌入图片超过 16 MB 安全上限。' };
    } else if (source?.status === 'unresolved' || mask?.status === 'unresolved') {
      imageRecovery = { status: 'unresolved', operation, label: operationLabel(operation), source, mask, reason: '记录只保存了资产引用，当前设备没有对应本地图片。' };
    } else {
      imageRecovery = {
        status: 'missing', operation, label: operationLabel(operation), source, mask,
        reason: needsMask
          ? '这份记录没有随 PNG/JSON 保存原图或 Mask；请重新选择原图并绘制 Mask。'
          : '这份记录没有随 PNG/JSON 保存图生图原图；请重新选择输入图片。'
      };
    }
  }

  return {
    operation,
    requestType: String(firstValue([params, outer], ['request_type']) || ''),
    imageWorkflow,
    imageTool,
    embeddedInputImage: source?.status === 'embedded' ? source : null,
    embeddedMaskImage: mask?.status === 'embedded' ? mask : null,
    imageRecovery,
    workflowMetadata: {
      operation,
      requestType: String(firstValue([params, outer], ['request_type']) || ''),
      sourceStatus: source?.status || 'missing',
      maskStatus: mask?.status || 'missing',
      ambiguous: ambiguousTextImage,
      ambiguityReason: ambiguousTextImage
        ? '记录标为文生图但含输入图；可能是专用 Upscale 复制的旧 Comment。请手动选择工作流。'
        : '',
      enhanceTargetWidth: imageWorkflow.enhanceTargetWidth,
      enhanceTargetHeight: imageWorkflow.enhanceTargetHeight,
      enhanceUpscaleFactor: imageWorkflow.enhanceUpscaleFactor
    }
  };
}

export function isReferenceMetadataKey(key) {
  const lower = keyName(key);
  if (REFERENCE_METADATA_PREFIXES.some(prefix => lower.startsWith(prefix))) return true;
  // A few exporters use camelCase (referenceImageMultiple /
  // directorReferenceImages) instead of the API's snake_case spelling.  Check
  // a separator-free form as well so those encoded media fields cannot fall
  // through into the free-form advanced JSON bucket.
  const compact = compactKey(lower);
  return compact === 'reference' || compact.startsWith('reference')
    || compact === 'directorreference' || compact.startsWith('directorreference');
}

export function isNonAdvancedParameterKey(key) {
  const lower = keyName(key);
  const compact = compactKey(lower);
  const normalKey = [...NORMAL_PARAMETER_KEYS].some(item => item === lower || compactKey(item) === compact);
  const stateOnlyKey = [...STATE_ONLY_PARAMETER_KEYS].some(item => item === lower || compactKey(item) === compact);
  const imageKey = [...IMAGE_WORKFLOW_PARAMETER_KEYS].some(item => item === lower || compactKey(item) === compact);
  const requestKey = [...REQUEST_METADATA_KEYS].some(item => item === lower || compactKey(item) === compact);
  return normalKey || stateOnlyKey || imageKey || requestKey || isReferenceMetadataKey(lower);
}

/** Keep user-authored advanced values while removing request transport fields. */
export function filterAdvancedOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 128)) {
    if (!key || isNonAdvancedParameterKey(key)) continue;
    // Exported request records use null to mean "not configured".  Treat it
    // as absent here too, matching the UI summary and preventing a pasted Raw
    // Parameters object from forwarding dozens of meaningless null fields.
    if (item != null && (['string', 'number', 'boolean'].includes(typeof item) || Array.isArray(item))) {
      result[canonicalAdvancedParameterKey(key)] = item;
    }
  }
  return result;
}

// Descriptive aliases keep the module easy to consume from future importers.
export const classifyImageRequest = classifyNaiParameters;
export const extractEmbeddedMedia = extractEmbeddedImage;
