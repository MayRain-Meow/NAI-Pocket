import { repairJsonSyntax } from './import-repair.js?v=1.9.3';
import { inferNovelAiModel } from './model-utils.js?v=1.9.3';
import {
  classifyNaiParameters,
  canonicalAdvancedParameterKey,
  filterAdvancedOverrides,
  KNOWN_ADVANCED_PARAMETER_KEYS,
  isNonAdvancedParameterKey,
  isReferenceMetadataKey
} from './parameter-semantics.js?v=1.9.3';
import { DEFAULT_GENERATION_MODEL, DEFAULT_GENERATION_PARAMS } from './generation-state.js?v=1.9.3';
import { recordedMediumEffort, separateAutoText, ucPresetFromHint } from './nai-presets.js?v=1.9.3';

const SAMPLER_ALIASES = new Map([
  ['euler a', 'k_euler_ancestral'], ['euler ancestral', 'k_euler_ancestral'], ['k_euler_ancestral', 'k_euler_ancestral'],
  ['euler', 'k_euler'], ['k_euler', 'k_euler'],
  ['dpm++ 2s ancestral', 'k_dpmpp_2s_ancestral'], ['dpmpp 2s ancestral', 'k_dpmpp_2s_ancestral'], ['k_dpmpp_2s_ancestral', 'k_dpmpp_2s_ancestral'],
  ['dpm++ 2m sde', 'k_dpmpp_2m_sde'], ['dpmpp 2m sde', 'k_dpmpp_2m_sde'], ['k_dpmpp_2m_sde', 'k_dpmpp_2m_sde'],
  ['dpm++ 2m', 'k_dpmpp_2m'], ['dpmpp 2m', 'k_dpmpp_2m'], ['k_dpmpp_2m', 'k_dpmpp_2m'],
  ['dpm++ sde', 'k_dpmpp_sde'], ['dpmpp sde', 'k_dpmpp_sde'], ['k_dpmpp_sde', 'k_dpmpp_sde'],
  ['ddim', 'ddim_v3'], ['ddim v3', 'ddim_v3'], ['ddim_v3', 'ddim_v3']
]);

const MANAGED_KEYS = new Set([
  'prompt', 'negative_prompt', 'uc', 'v4_prompt', 'v4_negative_prompt', 'width', 'height', 'steps', 'scale',
  'sampler', 'noise_schedule', 'seed', 'extra_noise_seed', 'n_samples', 'ucPreset', 'uc_preset', 'qualityToggle',
  'quality_toggle', 'cfg_rescale', 'sm', 'sm_dyn', 'prefer_brownian', 'deliberate_euler_ancestral_bug',
  'request_type', 'signed_hash', 'version', 'params_version', 'stream', 'image_format', 'legacy', 'legacy_v3_extend',
  'straight_alpha', 'tag_hint_transparent_background', 'size', 'model', 'model_name', 'model_hash', 'action', 'operation', 'input'
]);

// Current public Image API RequestParameters fields that are safe scalar/array pass-throughs.
const ADVANCED_ALLOWLIST = KNOWN_ADVANCED_PARAMETER_KEYS;

const META_ONLY_KEYS = new Set([
  'request_type', 'signed_hash', 'version', 'stream', 'uncond_scale', 'dynamic_thresholding_percentile',
  'dynamic_thresholding_mimic_scale', 'skip_cfg_below_sigma', 'cfg_sched_eligibility', 'explike_fine_detail',
  'minimize_sigma_inf', 'uncond_per_vibe', 'wonky_vibe_correlation'
]);

const SECTION_HEADERS = [
  [/^(?:提示词|正面提示词|正向提示词|prompt)\s*[:：]\s*(.*)$/i, 'prompt'],
  [/^(?:负面提示词|负向提示词|undesired\s*content|negative(?:\s*prompts?)?|uc)\s*[:：]\s*(.*)$/i, 'negative'],
  [/^(?:角色提示词|人物提示词|character\s*prompts?)\s*[:：]\s*(.*)$/i, 'characters'],
  [/^(?:模型与资源|模型|model(?:s)?(?:\s*&\s*resources)?)\s*[:：]\s*(.*)$/i, 'model'],
  [/^(?:生成参数|generation\s*parameters?|parameters?)\s*[:：]\s*(.*)$/i, 'params'],
  [/^(?:其他信息|其它信息|other\s*info(?:rmation)?)\s*[:：]\s*(.*)$/i, 'other']
];

function clean(value) { return String(value ?? '').replace(/\r/g, '').trim(); }
function finite(value, fallback = undefined) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function boolish(value, fallback = undefined) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(text)) return true;
  if (['false', 'no', 'off', '0'].includes(text)) return false;
  return fallback;
}
function coerce(value) {
  const text = clean(value);
  if (/^(?:true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return Number(text);
  if (/^(?:none|null)$/i.test(text)) return null;
  return text;
}
export function normalizeSampler(value) {
  const raw = clean(value);
  return SAMPLER_ALIASES.get(raw.toLowerCase()) || raw || DEFAULT_GENERATION_PARAMS.sampler;
}
export function normalizeSchedule(value) {
  const raw = clean(value).toLowerCase();
  if (!raw) return DEFAULT_GENERATION_PARAMS.noiseSchedule;
  if (raw === 'poly exponential') return 'polyexponential';
  return raw;
}
function normalizeCenters(value) {
  if (!Array.isArray(value) || !value.length) return [{ x: 0.5, y: 0.5 }];
  return value.slice(0, 4).map(item => ({
    x: Math.min(1, Math.max(0, finite(item?.x, 0.5))),
    y: Math.min(1, Math.max(0, finite(item?.y, 0.5)))
  }));
}
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    // Nested Comment/Raw Parameters wrappers are sometimes copied with the
    // same harmless shell damage as the top-level textarea (missing comma,
    // escaped underscore, or a `Raw Parameters` label).  Reuse the reviewed
    // repair path, but only for strings that actually look like JSON.
    const candidate = stripJsonLabelPrefix(text);
    if (!/^[\[{`]/.test(candidate)) return value;
    try { parsed = JSON.parse(repairJsonSyntax(candidate).repairedText); } catch { return value; }
  }
  if (typeof parsed === 'string') {
    try { return JSON.parse(parsed); } catch {
      const candidate = stripJsonLabelPrefix(parsed);
      try { return JSON.parse(repairJsonSyntax(candidate).repairedText); } catch { return parsed; }
    }
  }
  return parsed;
}

// Clipboard exports sometimes include a human-readable heading before the
// object (for example `Raw Parameters{...}` or `JSON: {...}`).  That heading
// is useful to a person but is not JSON syntax.  Strip only a small, explicit
// vocabulary so ordinary prose containing a brace still follows the text
// importer and remains untouched.
function stripJsonLabelPrefix(value) {
  const text = String(value ?? '').replace(/^\uFEFF/, '').trim();
  return text.replace(/^(?:raw[\s_-]*parameters?|parameters?|json|metadata)\s*[:：]?\s*(?=[\[{`])/i, '').trim();
}

function looksLikeJsonMetadata(value) {
  const text = String(value ?? '').trim();
  if (!/^[\[{`]/.test(text)) return false;
  if (text.startsWith('`')) return true;
  if (text.startsWith('[{') || text.startsWith('["') || text.startsWith("['")) return true;
  // A truncated metadata object still has recognizable request keys. Keys
  // may be quoted, escaped, or left bare by a third-party exporter; ordinary
  // Prompt syntax such as `{artist:foo}` does not contain this vocabulary.
  return /(?:^|[,{\s])["']?\s*(?:prompt|parameters|request(?:\\?[_-]?type)?|operation|action|width|height|steps|model(?:\\?[_-]?name)?|seed)\s*["']?\s*:/i.test(text);
}

function parameterEnvelope(object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  const aliases = new Set(['parameters', 'rawParameters', 'raw_parameters', 'Raw Parameters', 'RawParameters'].map(key => String(key).toLowerCase().replace(/[^a-z0-9]/g, '')));
  for (const [key, rawValue] of Object.entries(object)) {
    if (!aliases.has(String(key).toLowerCase().replace(/[^a-z0-9]/g, ''))) continue;
    const value = parseMaybeJson(rawValue);
    if (value && typeof value === 'object' && !Array.isArray(value)) return { parameters: value };
  }
  return null;
}

function aliasValue(object, aliases) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return undefined;
  const wanted = new Set(aliases.map(compactParameterKey));
  const entry = Object.entries(object).find(([key]) => wanted.has(compactParameterKey(key)));
  return entry ? parseMaybeJson(entry[1]) : undefined;
}

function compactParameterKey(key) {
  return String(key || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Headed NAI text / JSON still fill missing canvas fields from DEFAULT_GENERATION_PARAMS.
// A prompt dump with only Positive + Negative must not invent 832×1216 / 28 / Euler a.
const TEXT_GENERATION_PARAM_KEYS = new Set([
  'width', 'height', 'steps', 'scale', 'sampler', 'size', 'seed',
  'cfgrescale', 'noiseschedule', 'ucpreset', 'qualitytoggle', 'preferbrownian',
  'sm', 'smdyn', 'deliberateeulerancestralbug', 'skipcfgabovesigma',
  'straightalpha', 'nativealpha', 'taghinttransparentbackground'
]);

function textHasGenerationParams(meta) {
  return Object.keys(meta || {}).some(key => TEXT_GENERATION_PARAM_KEYS.has(compactParameterKey(key)));
}

function parameterKeyIn(set, key) {
  const compact = compactParameterKey(key);
  for (const item of set) if (compactParameterKey(item) === compact) return true;
  return false;
}

function collectAdvanced(parameters, warnings) {
  const result = {};
  for (const [key, value] of Object.entries(parameters || {})) {
    if (parameterKeyIn(MANAGED_KEYS, key) || isNonAdvancedParameterKey(key)) continue;
    if (parameterKeyIn(ADVANCED_ALLOWLIST, key)) {
      // Nulls in exported request records mean "unset"; carrying dozens of
      // them into the editor makes the advanced JSON noisy and can trigger
      // provider validation errors.
      if (value != null && (['string', 'number', 'boolean'].includes(typeof value) || Array.isArray(value))) {
        result[canonicalAdvancedParameterKey(key)] = value;
      }
      continue;
    }
    if (parameterKeyIn(META_ONLY_KEYS, key)) continue;
    if (!isReferenceMetadataKey(key)) warnings.push(`未自动导入未知参数 ${key}；原文仍保留在导入框中。`);
  }
  return filterAdvancedOverrides(result);
}

function collectImportedExtras(parameters) {
  const result = {};
  for (const [key, value] of Object.entries(parameters || {})) {
    if (parameterKeyIn(MANAGED_KEYS, key) || parameterKeyIn(ADVANCED_ALLOWLIST, key) || parameterKeyIn(META_ONLY_KEYS, key) || isNonAdvancedParameterKey(key)) continue;
    try {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) continue;
      result[String(key).slice(0, 120)] = encoded.length <= 24_000
        ? JSON.parse(encoded)
        : { omitted: true, type: Array.isArray(value) ? 'array' : typeof value, bytes: encoded.length };
    } catch {
      result[String(key).slice(0, 120)] = { omitted: true, type: typeof value };
    }
    if (Object.keys(result).length >= 64) break;
  }
  return result;
}
function charactersFromV4(parameters) {
  const positive = Array.isArray(parameters?.v4_prompt?.caption?.char_captions) ? parameters.v4_prompt.caption.char_captions : [];
  const negative = Array.isArray(parameters?.v4_negative_prompt?.caption?.char_captions) ? parameters.v4_negative_prompt.caption.char_captions : [];
  const count = Math.max(positive.length, negative.length);
  return Array.from({ length: count }, (_, index) => {
    const p = positive[index] || {};
    const n = negative[index] || {};
    return {
      number: index + 1,
      name: clean(p.name || n.name || ''),
      promptRaw: clean(p.char_caption || p.prompt || p.caption || ''),
      ucRaw: clean(n.char_caption || n.prompt || n.caption || ''),
      centers: normalizeCenters(p.centers || n.centers),
      positionExplicit: Array.isArray(p.centers || n.centers) && (p.centers || n.centers).length > 0
    };
  }).filter(item => item.promptRaw || item.ucRaw || item.name);
}
function canonicalFromJson(rawObject) {
  const warnings = [];
  let object = rawObject;
  const commentValue = aliasValue(object, ['Comment']);
  if (commentValue !== undefined) object = { ...object, Comment: commentValue };
  const comment = object?.Comment && typeof object.Comment === 'object' && !Array.isArray(object.Comment) ? object.Comment : null;
  const envelope = parameterEnvelope(object);
  const request = envelope ? { ...object, parameters: envelope.parameters } : null;
  const rawParameters = aliasValue(object, ['rawParameters', 'raw_parameters', 'Raw Parameters', 'RawParameters']);
  const parameters = request?.parameters || comment || (rawParameters && typeof rawParameters === 'object' ? rawParameters : null) || object || {};
  const prompt = clean(parameters?.v4_prompt?.caption?.base_caption ?? parameters?.prompt ?? request?.input ?? object?.Description ?? object?.prompt ?? '');
  const negativePrompt = clean(parameters?.v4_negative_prompt?.caption?.base_caption ?? parameters?.negative_prompt ?? parameters?.uc ?? object?.negativePrompt ?? object?.negative_prompt ?? '');
  const characters = charactersFromV4(parameters);
  const width = finite(parameters.width);
  const height = finite(parameters.height);
  const size = typeof parameters.size === 'string' ? parameters.size.match(/(\d+)\s*[x×]\s*(\d+)/i) : null;
  const quality = parameters.qualityToggle ?? parameters.quality_toggle;
  const modelInfo = inferNovelAiModel(
    request?.model,
    request?.model_name,
    parameters.model,
    parameters.model_name,
    parameters.model_hash,
    parameters.model_id,
    parameters.modelId,
    object?.Source,
    object?.source,
    object?.model,
    parameters.params_version,
    parameters.paramsVersion,
    object?.params_version,
    object?.paramsVersion
  );
  const model = modelInfo.model;
  if (!modelInfo.detected) warnings.push('没有从导入内容识别模型；导入时将保持当前编辑器模型。');
  const seed = finite(parameters.seed, finite(object?.seed));
  const advancedOverrides = collectAdvanced(parameters, warnings);
  const importedExtras = collectImportedExtras(parameters);
  const semantics = classifyNaiParameters(parameters, request || object);
  if (semantics.imageRecovery.status !== 'none' && semantics.imageRecovery.status !== 'ready') {
    warnings.push(semantics.imageRecovery.reason);
  }
  const tagHintUcPreset = finite(parameters.tag_hint_uc_preset);
  const tagHintQuality = parameters.tag_hint_qt == null ? undefined : boolish(parameters.tag_hint_qt, undefined);
  // What really took effect (see separateAutoText); the editor gets the user's own words.
  const auto = separateAutoText({
    model, prompt, negative: negativePrompt,
    qualityToggle: boolish(quality, tagHintQuality ?? false),
    ucPreset: finite(parameters.ucPreset ?? parameters.uc_preset, ucPresetFromHint(tagHintUcPreset) ?? null)
  });
  if (auto.notes.includes('quality')) warnings.push('图片记录 Quality 开，但发送的 Prompt 里没有质量词（Pocket 1.9.0 之前或其他只发开关的客户端，当时实际没生效）；恢复为关，重新生成才一致。');
  if (auto.notes.includes('ucPreset')) warnings.push('图片记录了 UC 预设，但发送的 UC 里没有预设文字（当时实际没生效）；恢复为 None，重新生成才一致。');
  return {
    sourceFormat: 'json', rawObject,
    prompt: auto.prompt, negativePrompt: auto.negative, characters, model,
    modelDetected: modelInfo.detected,
    modelEvidence: modelInfo.evidence,
    modelSource: modelInfo.source,
    seed,
    params: {
      width: width ?? finite(size?.[1], DEFAULT_GENERATION_PARAMS.width), height: height ?? finite(size?.[2], DEFAULT_GENERATION_PARAMS.height),
      steps: finite(parameters.steps, DEFAULT_GENERATION_PARAMS.steps), scale: finite(parameters.scale, DEFAULT_GENERATION_PARAMS.scale),
      sampler: normalizeSampler(parameters.sampler), noiseSchedule: normalizeSchedule(parameters.noise_schedule ?? parameters.noiseSchedule),
      cfgRescale: finite(parameters.cfg_rescale ?? parameters.cfgRescale, 0),
      // NovelAI's image metadata does not record the UC preset; null means unknown, and
      // overlayImportOntoEditor then keeps the editor's own value instead of forcing 0.
      ucPreset: auto.ucPreset,
      furryMode: auto.furryMode,
      effort: recordedMediumEffort(request?.model, object?.model, parameters.model) ? 'medium' : 'high',
      qualityToggle: auto.qualityToggle, preferBrownian: boolish(parameters.prefer_brownian, DEFAULT_GENERATION_PARAMS.preferBrownian),
      sm: boolish(parameters.sm, DEFAULT_GENERATION_PARAMS.sm), smDyn: boolish(parameters.sm_dyn, DEFAULT_GENERATION_PARAMS.smDyn),
      deliberateEulerAncestralBug: boolish(parameters.deliberate_euler_ancestral_bug, DEFAULT_GENERATION_PARAMS.deliberateEulerAncestralBug),
      varietyBoost: finite(parameters.skip_cfg_above_sigma, DEFAULT_GENERATION_PARAMS.varietyBoost),
      nativeAlpha: boolish(parameters.straight_alpha ?? parameters.tag_hint_transparent_background, DEFAULT_GENERATION_PARAMS.nativeAlpha),
      advancedOverrides,
      importedExtras
    },
    imageWorkflow: semantics.imageWorkflow,
    imageTool: semantics.imageTool,
    embeddedInputImage: semantics.embeddedInputImage,
    embeddedMaskImage: semantics.embeddedMaskImage,
    imageRecovery: semantics.imageRecovery,
    workflowMetadata: semantics.workflowMetadata,
    v4Options: {
      useCoords: parameters?.v4_prompt?.use_coords === true,
      useOrder: parameters?.v4_prompt?.use_order !== false,
      negativeUseOrder: parameters?.v4_negative_prompt?.use_order === true,
      legacyUc: parameters?.v4_negative_prompt?.legacy_uc === true
    },
    hasGenerationParams: true,
    warnings
  };
}

function parseKeyValueLine(line) {
  const match = line.match(/^\s*(?:[-*•]\s*)?([\w.-]+)\s*[:：]\s*(.*?)\s*$/);
  return match ? [match[1], coerce(match[2])] : null;
}
function parseCharacterLine(line, warnings) {
  const match = line.match(/^\s*(?:[-*•]\s*)?(?:角色|character)\s*(\d+)\s*[:：]\s*([\s\S]*?)\s*$/i);
  if (!match) return null;
  let body = match[2];
  let x = 0.5; let y = 0.5; let positionExplicit = false;
  const position = body.match(/(?:\||[;；])?\s*(?:位置|position)\s*[:：]\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*[,，]\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*$/i);
  if (position) {
    x = Math.min(1, Math.max(0, Number(position[1])));
    y = Math.min(1, Math.max(0, Number(position[2])));
    positionExplicit = true;
    body = body.slice(0, position.index).replace(/[|;；\s]+$/g, '');
  }
  if (!body.trim()) warnings.push(`角色 ${match[1]} 没有正向 Prompt。`);
  return { number: Number(match[1]), name: '', promptRaw: clean(body), ucRaw: '', centers: [{ x, y }], positionExplicit };
}
function canonicalFromText(raw) {
  const warnings = [];
  const buckets = { prompt: [], negative: [], characters: [], model: [], params: [], other: [] };
  let section = null;
  const leading = [];
  for (const originalLine of String(raw).replace(/\r/g, '').split('\n')) {
    const line = originalLine.trim();
    if (!line) continue;
    let headerMatched = false;
    for (const [pattern, key] of SECTION_HEADERS) {
      const match = line.match(pattern);
      if (!match) continue;
      // 提示词: 之前的「格式: nai」横幅丢掉。Negative:/UC: 之前的无头行才是正向 Prompt。
      
      if (key === 'prompt') leading.length = 0;
      else if (!section && leading.length) {
        buckets.prompt.push(...leading);
        leading.length = 0;
      }
      section = key;
      if (match[1]?.trim()) buckets[key].push(match[1].trim());
      headerMatched = true;
      break;
    }
    if (headerMatched) continue;
    if (section) buckets[section].push(originalLine.trim());
    else leading.push(originalLine.trim());
  }
  if (leading.length) buckets.prompt.push(...leading);

  const meta = {};
  for (const line of [...buckets.model, ...buckets.params, ...buckets.other]) {
    const kv = parseKeyValueLine(line);
    if (kv) meta[kv[0]] = kv[1];
  }
  const characters = [];
  for (const line of buckets.characters) {
    const parsed = parseCharacterLine(line, warnings);
    if (parsed) characters.push(parsed);
    else if (line && !/^[-*•]?\s*$/.test(line)) warnings.push(`未识别角色行：${line.slice(0, 100)}`);
  }
  characters.sort((a, b) => a.number - b.number);
  const prompt = clean(buckets.prompt.join('\n'));
  const negativePrompt = clean(buckets.negative.join('\n'));
  const sizeText = String(meta.size ?? '');
  const size = sizeText.match(/(\d+)\s*[x×]\s*(\d+)/i);
  const modelText = [...buckets.model, String(meta.model || ''), String(raw).split('\n').slice(0, 3).join(' ')].join(' ');
  const modelInfo = inferNovelAiModel(modelText, meta.params_version, meta.paramsVersion);
  if (!modelInfo.detected) warnings.push('没有从导入内容识别模型；导入时将保持当前编辑器模型。');
  const seed = finite(meta.seed);
  const advancedOverrides = collectAdvanced(meta, warnings);
  const importedExtras = collectImportedExtras(meta);
  const semantics = classifyNaiParameters(meta, meta);
  if (semantics.imageRecovery.status !== 'none' && semantics.imageRecovery.status !== 'ready') warnings.push(semantics.imageRecovery.reason);
  const anyExplicitPosition = characters.some(item => item.positionExplicit);
  const hasGenerationParams = textHasGenerationParams(meta);
  const params = hasGenerationParams
    ? {
      width: finite(meta.width, finite(size?.[1], DEFAULT_GENERATION_PARAMS.width)), height: finite(meta.height, finite(size?.[2], DEFAULT_GENERATION_PARAMS.height)),
      steps: finite(meta.steps, DEFAULT_GENERATION_PARAMS.steps), scale: finite(meta.scale, DEFAULT_GENERATION_PARAMS.scale), sampler: normalizeSampler(meta.sampler),
      noiseSchedule: normalizeSchedule(meta.noise_schedule ?? meta.noiseSchedule), cfgRescale: finite(meta.cfg_rescale, 0),
      ucPreset: finite(meta.ucPreset ?? meta.uc_preset, null), qualityToggle: boolish(meta.qualityToggle ?? meta.quality_toggle, DEFAULT_GENERATION_PARAMS.qualityToggle),
      preferBrownian: boolish(meta.prefer_brownian, DEFAULT_GENERATION_PARAMS.preferBrownian), sm: boolish(meta.sm, DEFAULT_GENERATION_PARAMS.sm), smDyn: boolish(meta.sm_dyn, DEFAULT_GENERATION_PARAMS.smDyn),
      deliberateEulerAncestralBug: boolish(meta.deliberate_euler_ancestral_bug, DEFAULT_GENERATION_PARAMS.deliberateEulerAncestralBug),
      varietyBoost: finite(meta.skip_cfg_above_sigma, DEFAULT_GENERATION_PARAMS.varietyBoost), advancedOverrides, importedExtras
    }
    : { advancedOverrides, importedExtras };
  return {
    sourceFormat: 'nai-text', rawText: raw,
    prompt, negativePrompt, characters,
    model: modelInfo.model, modelDetected: modelInfo.detected, modelEvidence: modelInfo.evidence, modelSource: modelInfo.source, seed,
    params,
    hasGenerationParams,
    imageWorkflow: semantics.imageWorkflow,
    imageTool: semantics.imageTool,
    embeddedInputImage: semantics.embeddedInputImage,
    embeddedMaskImage: semantics.embeddedMaskImage,
    imageRecovery: semantics.imageRecovery,
    workflowMetadata: semantics.workflowMetadata,
    v4Options: { useCoords: anyExplicitPosition && characters.length >= 2, useOrder: true, negativeUseOrder: false, legacyUc: false },
    warnings
  };
}

export function parseNaiImport(raw) {
  const text = clean(raw);
  if (!text) throw new Error('请先粘贴 NAI 元数据文本或 JSON。');
  const jsonCandidate = stripJsonLabelPrefix(text);
  let jsonReview = { repairedText: jsonCandidate, issues: [] };
  try {
    let parsed;
    try { parsed = JSON.parse(jsonCandidate); }
    catch {
      jsonReview = repairJsonSyntax(jsonCandidate);
      parsed = JSON.parse(jsonReview.repairedText);
    }
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    const result = canonicalFromJson(parsed);
    result.syntaxRepairs = jsonReview.issues;
    if (jsonReview.issues.length) {
      const grouped = new Map();
      for (const issue of jsonReview.issues) {
        const key = `${issue.type || ''}|${issue.message || ''}`;
        const entry = grouped.get(key) || { message: issue.message || 'JSON 外壳已修复', count: 0 };
        entry.count += 1;
        grouped.set(key, entry);
      }
      result.warnings.push(...[...grouped.values()].map(entry => `${entry.message}${entry.count > 1 ? `（${entry.count} 处）` : ''}；原始粘贴内容仍保留。`));
    }
    const sourceDrivenTool = ['upscale', 'director'].includes(String(result.imageTool?.type || '').toLowerCase());
    const needsPromptReview = result.operation !== 'unknown' && !sourceDrivenTool;
    if (!result.prompt && !result.characters.length && needsPromptReview) result.warnings.push('JSON 中没有找到可生成的 Prompt。');
    return result;
  } catch (error) {
    // Only treat actual JSON-looking input as malformed JSON; otherwise parse NAI text.
    if (looksLikeJsonMetadata(jsonCandidate)) throw new Error(`JSON 解析失败：${error.message}`);
  }
  const result = canonicalFromText(text);
  const sourceDrivenTool = ['upscale', 'director'].includes(String(result.imageTool?.type || '').toLowerCase());
  const needsPromptReview = result.operation !== 'unknown' && !sourceDrivenTool;
  if (!result.prompt && !result.characters.length && needsPromptReview) result.warnings.push('没有找到可生成的正向 Prompt。');
  return result;
}

// JSON / 带生成参数的 NAI 文本仍用导入值（缺的补 DEFAULT）。无参数 prompt dump 叠在当前编辑器上。

export function overlayImportOntoEditor(data, current = {}) {
  const keepSampling = data?.sourceFormat === 'nai-text' && data?.hasGenerationParams === false;
  const liveModel = current.model || DEFAULT_GENERATION_MODEL;
  const liveParams = current.params || { ...DEFAULT_GENERATION_PARAMS, advancedOverrides: {}, importedExtras: {} };
  if (keepSampling) {
    return {
      keepSampling: true,
      model: liveModel,
      params: {
        ...liveParams,
        advancedOverrides: filterAdvancedOverrides({
          ...(liveParams.advancedOverrides || {}),
          ...(data.params?.advancedOverrides || {})
        }),
        importedExtras: Object.keys(data.params?.importedExtras || {}).length
          ? data.params.importedExtras
          : (liveParams.importedExtras || {})
      },
      seedMode: current.seedMode || 'random',
      seed: Number.isFinite(Number(current.seed)) ? Number(current.seed) : 0,
      imageWorkflow: current.imageWorkflow,
      imageTool: current.imageTool,
      referenceControl: current.referenceControl
    };
  }
  return {
    keepSampling: false,
    model: data.modelDetected === false ? liveModel : (data.model || liveModel),
    params: {
      ...DEFAULT_GENERATION_PARAMS,
      ...(data.params || {}),
      // Unknown in the source (see the parsers): keep the editor's UC preset.
      ucPreset: data.params?.ucPreset ?? liveParams.ucPreset ?? DEFAULT_GENERATION_PARAMS.ucPreset,
      advancedOverrides: filterAdvancedOverrides(data.params?.advancedOverrides || {}),
      importedExtras: data.params?.importedExtras || {}
    },
    seedMode: Number.isFinite(Number(data.seed)) ? 'fixed' : 'random',
    seed: Number.isFinite(Number(data.seed)) ? Number(data.seed) : 0
  };
}

// NovelAI has no escape character: a backslash is an ordinary character in the prompt it
// receives. Treating `\:` as an escaped colon closed weight blocks in the wrong place
// (`0.4::name_\(x)\::` became a Tag ending in `\::`), so import reads it literally and
// restores exactly the text the image was generated with.
function isEscaped() {
  return false;
}
function punctuationOnly(value) { return /^[\s,:;，：；|]+$/.test(String(value || '')); }
function stripBalancedWeightWrappers(value) {
  let text = clean(value);
  let factor = 1;
  let changed = false;
  while (text.length >= 2) {
    if (text.startsWith('{') && text.endsWith('}') && !isEscaped(text, 0) && !isEscaped(text, text.length - 1)) {
      text = clean(text.slice(1, -1)); factor *= 1.05; changed = true; continue;
    }
    if (text.startsWith('[') && text.endsWith(']') && !isEscaped(text, 0) && !isEscaped(text, text.length - 1)) {
      text = clean(text.slice(1, -1)); factor /= 1.05; changed = true; continue;
    }
    break;
  }
  return { text, factor, changed };
}
function splitUnescapedComma(text) {
  const out = []; let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if ((text[i] === ',' || text[i] === '，' || text[i] === '\n') && !isEscaped(text, i)) {
      const token = clean(text.slice(start, i)); if (token) out.push(token); start = i + 1;
    }
  }
  const tail = clean(text.slice(start)); if (tail) out.push(tail);
  return out;
}
function splitBracketAdjacency(text) {
  const out = [];
  let start = 0;
  let curly = 0; let square = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (isEscaped(text, i)) continue;
    const char = text[i];
    if (char === '{') curly += 1;
    else if (char === '}') curly = Math.max(0, curly - 1);
    else if (char === '[') square += 1;
    else if (char === ']') square = Math.max(0, square - 1);
    if (!/\s/.test(char) || curly || square) continue;
    let j = i; while (j < text.length && /\s/.test(text[j])) j += 1;
    const left = clean(text.slice(start, i));
    const leftLast = left.at(-1);
    const rightFirst = text[j];
    if (left && (leftLast === '}' || leftLast === ']' || rightFirst === '{' || rightFirst === '[')) {
      out.push(left); start = j; i = j - 1;
    }
  }
  const tail = clean(text.slice(start)); if (tail) out.push(tail);
  return out;
}
function nextColonRun(text, from, minimumLength = 1) {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] !== ':' || isEscaped(text, i)) continue;
    let j = i;
    while (j < text.length && text[j] === ':' && !isEscaped(text, j)) j += 1;
    const length = j - i;
    if (length >= minimumLength) return { index: i, length };
    i = j - 1;
  }
  return null;
}

// Nested `1.2::a, 1.45::b, c::` is a missing closer, not one block closed at `1.45::`.
// Require a comma/semicolon (or the start of the block) so `year 2024::` stays one tag.

function implicitNestedWeightStart(text, contentStart, closeIndex) {
  const before = text.slice(contentStart, closeIndex);
  const match = before.match(/([+-]?(?:\d{1,2}(?:\.\d+)?|\.\d+))\s*$/);
  if (!match) return -1;
  const numStart = closeIndex - match[0].length;
  let boundary = numStart - 1;
  while (boundary >= contentStart && /\s/.test(text[boundary])) boundary -= 1;
  if (boundary >= contentStart && !/[,;，；|]/.test(text[boundary])) return -1;
  return numStart;
}
function pushWeightedToken(output, rawToken, baseWeight, warnings, context = '') {
  const trimmed = clean(rawToken).replace(/^,+|,+$/g, '').trim();
  if (!trimmed || punctuationOnly(trimmed)) return;
  const wrapped = stripBalancedWeightWrappers(trimmed);
  const weight = Number((baseWeight * wrapped.factor).toFixed(6));
  // Brackets as the only weight source: keep the original token so the image
  // is reproduced exactly; editing the weight switches to the numeric form.
  const keepBrackets = wrapped.changed && baseWeight === 1 && Boolean(wrapped.text);
  output.push({ text: wrapped.text || trimmed, exactText: wrapped.text || trimmed, weight, enabled: true, bundle: false, preserveRaw: keepBrackets, raw: keepBrackets ? trimmed : '', originalText: wrapped.text || trimmed, originalExactText: wrapped.text || trimmed, originalWeight: weight, importContext: context });
}

// Import-only parser: prioritizes :: blocks, survives duplicate separators and obvious missing delimiters,
// then applies current NovelAI bracket semantics ({ } ×1.05 per layer, [ ] ÷1.05 per layer).
export function parsePromptTagsRobust(raw) {
  const text = String(raw ?? '').replace(/\r/g, '').replace(/，/g, ',');
  const tags = [];
  const warnings = [];
  let corrections = 0;
  let i = 0;
  let plain = '';

  const flushPlain = () => {
    for (const commaToken of splitUnescapedComma(plain)) {
      const repaired = splitBracketAdjacency(commaToken);
      if (repaired.length > 1) { warnings.push('发现括号权重块之间漏逗号，已按结构边界拆分。'); corrections += repaired.length - 1; }
      for (const token of repaired) pushWeightedToken(tags, token, 1, warnings, 'plain');
    }
    plain = '';
  };

  while (i < text.length) {
    const rest = text.slice(i);
    const boundary = i === 0 || /[\s,;，；|]/.test(text[i - 1]) || (i >= 2 && text.slice(i - 2, i) === '::');
    let start = boundary ? rest.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(:{1,})/) : null;
    let bare = null;
    if (!start && boundary && rest.startsWith('::')) bare = ['::', '', '::'];
    if (!start && !bare) {
      plain += text[i]; i += 1; continue;
    }

    flushPlain();
    const weight = start ? Number(start[1]) : 1;
    const openingLen = start ? start[0].length : 2;
    const colonCount = start ? start[2].length : 2;
    if (!start) { warnings.push('发现 ::tag:: 缺少显式权重，按 1.0 解析。'); corrections += 1; }
    if (colonCount !== 2) { warnings.push(`发现 ${colonCount} 个连续冒号的起始符，按 :: 修复。`); corrections += 1; }
    if (colonCount === 1) { warnings.push('发现单冒号权重起始符，依据后续闭合 :: 自动修复。'); corrections += 1; }
    const contentStart = i + openingLen;
    // A literal single colon is common inside valid tags such as artist:kim_eb.
    // Prefer a real 2+ colon closing delimiter; only repair a single trailing colon if none exists.
    let close = nextColonRun(text, contentStart, 2);
    if (close) {
      const nestedAt = implicitNestedWeightStart(text, contentStart, close.index);
      if (nestedAt >= 0) {
        warnings.push('发现嵌套权重块缺少闭合符，已按后一段权重起始处闭合前一块。');
        corrections += 1;
        const content = text.slice(contentStart, nestedAt);
        const parts = splitUnescapedComma(content);
        if (!parts.length && content.trim()) parts.push(content.trim());
        for (const token of parts) pushWeightedToken(tags, token, weight, warnings, 'numeric');
        i = nestedAt;
        continue;
      }
    }
    if (!close) {
      // Repair one trailing colon when the block clearly reaches a separator/end.
      let single = -1;
      for (let p = contentStart; p < text.length; p += 1) if (text[p] === ':' && !isEscaped(text, p)) single = p;
      if (single >= contentStart) close = { index: single, length: 1 };
    }
    if (!close) {
      warnings.push(`权重块 ${String(weight)}:: 未找到闭合符，已保留为普通文本。`);
      plain += text.slice(i, contentStart); i = contentStart; continue;
    }
    if (close.length !== 2) { warnings.push(`权重块闭合处有 ${close.length} 个连续冒号，按 :: 修复。`); corrections += 1; }
    const content = text.slice(contentStart, close.index);
    const parts = splitUnescapedComma(content);
    if (!parts.length && content.trim()) parts.push(content.trim());
    for (const token of parts) pushWeightedToken(tags, token, weight, warnings, 'numeric');
    i = close.index + close.length;
    // Structural closure itself is a strong boundary, so missing commas before the next weighted/bracketed token are recoverable.
    if (i < text.length && /\s/.test(text[i])) {
      let j = i; while (j < text.length && /\s/.test(text[j])) j += 1;
      if (j > i && j < text.length && !/[,:;，：；]/.test(text[j])) {
        const next = text.slice(j).match(/^(?:[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*:{1,}|::|\{+|\[+)/);
        if (next) { warnings.push('发现权重块之间漏逗号，已按结构边界拆分。'); corrections += 1; }
      }
    }
  }
  flushPlain();

  return { tags: tags.filter(item => item.text && !punctuationOnly(item.text)), warnings: [...new Set(warnings)], corrections };
}
