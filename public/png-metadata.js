
import { Inflate } from './vendor/pako-inflate.js?v=1.6.81';
import { inferNovelAiModel } from './model-utils.js?v=1.6.81';
import { DEFAULT_GENERATION_PARAMS } from './generation-state.js?v=1.6.81'; 
import { repairJsonSyntax } from './import-repair.js?v=1.6.81';
import { normalizeSampler, normalizeSchedule } from './nai-import.js?v=1.6.81';
import {
  classifyNaiParameters,
  canonicalAdvancedParameterKey,
  filterAdvancedOverrides,
  KNOWN_ADVANCED_PARAMETER_KEYS,
  isNonAdvancedParameterKey
} from './parameter-semantics.js?v=1.6.81';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const STEALTH_MAGIC = new TextEncoder().encode('stealth_pngcomp');
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

function readUint32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function equalBytes(a, b) {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function concatBytes(parts) {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function decompress(bytes, { maxOutputLength }, windowBits) {
  const decoder = new Inflate({ windowBits, chunkSize: Math.min(65536, maxOutputLength + 1) });
  const chunks = [];
  let length = 0;
  decoder.onData = chunk => {
    length += chunk.length;
    if (length > maxOutputLength) throw new RangeError('Decompressed PNG data exceeds its output limit.');
    chunks.push(chunk);
  };
  if (!decoder.push(bytes, true) || decoder.err) throw new Error(decoder.msg || 'Invalid compressed PNG data.');
  return concatBytes(chunks);
}

const inflateBytes = (bytes, options) => decompress(bytes, options, 15);
const gunzipBytes = (bytes, options) => decompress(bytes, options, 31);

function decodeText(bytes, encoding = 'utf8') {
  if (encoding === 'latin1' || encoding === 'ascii') {
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      const part = bytes.subarray(offset, offset + 8192);
      parts.push(String.fromCharCode(...(encoding === 'ascii' ? part.map(byte => byte & 0x7f) : part)));
    }
    return parts.join('').replace(/\0+$/g, '');
  }
  return decodeUtf8(bytes).replace(/\0+$/g, '');
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

function stripJsonLabelPrefix(value) {
  const text = String(value ?? '').replace(/^\uFEFF/, '').trim();
  return text.replace(/^(?:raw[\s_-]*parameters?|parameters?|json|metadata)\s*[:：]?\s*(?=[\[{`])/i, '').trim();
}

function parseMaybeJson(value) {
  if (value == null || typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return value;

  // PNG writers normally store Comment as a JSON object, but third-party
  // tools sometimes preserve the clipboard heading (`Raw Parameters`) or the
  // same harmless shell damage seen in pasted exports.  Try the strict form
  // first, then the explicitly labelled/repaired form.  Never apply repairs
  // to ordinary Description/Prompt prose.
  const candidates = [...new Set([text, stripJsonLabelPrefix(text)])];
  for (const candidate of candidates) {
    if (!/^[\[{`]/.test(candidate)) continue;
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      try { parsed = JSON.parse(repairJsonSyntax(candidate).repairedText); }
      catch { continue; }
    }
    if (typeof parsed === 'string') {
      const nested = parseMaybeJson(parsed);
      return nested === parsed ? parsed : nested;
    }
    return parsed;
  }
  return value;
}

// The host may keep native synchronous codecs; the parser and limits stay shared.
export function createPngMetadataParser({ inflate = inflateBytes, gunzip = gunzipBytes } = {}) {
  function parseTextChunk(type, data) {
    if (type === 'tEXt') {
      const split = data.indexOf(0);
      if (split < 1) return null;
      const key = decodeText(data.subarray(0, split), 'latin1');
      // NovelAI JSON is generally UTF-8 even though tEXt is nominally Latin-1.
      const valueBuffer = data.subarray(split + 1);
      const utf8 = decodeText(valueBuffer, 'utf8');
      const latin1 = decodeText(valueBuffer, 'latin1');
      const value = utf8.includes('\ufffd') ? latin1 : utf8;
      return [key, value];
    }

    if (type === 'zTXt') {
      const split = data.indexOf(0);
      if (split < 1 || split + 2 > data.length) return null;
      const key = decodeText(data.subarray(0, split), 'latin1');
      const method = data[split + 1];
      if (method !== 0) return null;
      const value = decodeUtf8(inflate(data.subarray(split + 2), { maxOutputLength: MAX_METADATA_BYTES }));
      return [key, value];
    }

    if (type === 'iTXt') {
      let offset = data.indexOf(0);
      if (offset < 1 || offset + 3 > data.length) return null;
      const key = decodeText(data.subarray(0, offset), 'latin1');
      const compressed = data[offset + 1] === 1;
      const method = data[offset + 2];
      offset += 3;
      const languageEnd = data.indexOf(0, offset);
      if (languageEnd < 0) return null;
      offset = languageEnd + 1;
      const translatedEnd = data.indexOf(0, offset);
      if (translatedEnd < 0) return null;
      offset = translatedEnd + 1;
      let payload = data.subarray(offset);
      if (compressed) {
        if (method !== 0) return null;
        payload = inflate(payload, { maxOutputLength: MAX_METADATA_BYTES });
      }
      return [key, decodeUtf8(payload)];
    }

    return null;
  }

  function readPngChunks(buffer) {
    if (!(buffer instanceof Uint8Array) || buffer.length < 33 || !equalBytes(buffer.subarray(0, 8), PNG_SIGNATURE)) {
      const error = new Error('只支持带元数据的 PNG 原图。');
      error.status = 400;
      throw error;
    }

    const chunks = [];
    let offset = 8;
    while (offset + 12 <= buffer.length) {
      const length = readUint32(buffer, offset);
      const type = decodeText(buffer.subarray(offset + 4, offset + 8), 'ascii');
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > buffer.length) break;
      chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
      offset = dataEnd + 4;
      if (type === 'IEND') break;
    }
    return chunks;
  }

  function extractStandardPngMetadata(buffer) {
    const chunks = readPngChunks(buffer);
    const metadata = {};
    let width = null;
    let height = null;
    let hasAlpha = null;

    for (const chunk of chunks) {
      if (chunk.type === 'IHDR' && chunk.data.length >= 8) {
        width = readUint32(chunk.data, 0);
        height = readUint32(chunk.data, 4);
        // PNG color type 4/6 carries an alpha channel; RGB/indexed images
        // cannot contain NovelAI's alpha-LSB stealth payload.
        if (chunk.data.length >= 10) hasAlpha = chunk.data[9] === 4 || chunk.data[9] === 6;
        continue;
      }
      if (!['tEXt', 'zTXt', 'iTXt'].includes(chunk.type)) continue;
      try {
        const entry = parseTextChunk(chunk.type, chunk.data);
        if (!entry) continue;
        const [key, value] = entry;
        metadata[key] = value;
      } catch {
        // Ignore one malformed ancillary metadata chunk and continue.
      }
    }

    if (typeof metadata.Comment === 'string') metadata.Comment = parseMaybeJson(metadata.Comment);
    return { metadata, width, height, hasAlpha };
  }

  function paethPredictor(left, up, upLeft) {
    const estimate = left + up - upLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const upLeftDistance = Math.abs(estimate - upLeft);
    if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
    if (upDistance <= upLeftDistance) return up;
    return upLeft;
  }

  /**
   * Decode the common 8-bit RGBA PNG layout without spawning ImageMagick.
   * NovelAI's stealth carrier is stored in the alpha LSBs, and most exported
   * images use exactly this non-interlaced layout. Unsupported color types or
   * interlacing return null so the established ImageMagick fallback can handle
   * them.
   */
  function decodeRgbaPng(buffer, width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 20_000_000) return null;
    const chunks = readPngChunks(buffer);
    const ihdr = chunks.find(chunk => chunk.type === 'IHDR')?.data;
    if (!ihdr || ihdr.length < 13 || ihdr[8] !== 8 || ihdr[9] !== 6 || ihdr[12] !== 0) return null;
    const rowBytes = width * 4;
    const expected = height * (rowBytes + 1);
    if (!Number.isSafeInteger(expected) || expected > 100 * 1024 * 1024) return null;
    const idat = chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data);
    if (!idat.length) return null;
    let inflated;
    try {
      inflated = inflate(concatBytes(idat), { maxOutputLength: expected });
    } catch {
      return null;
    }
    if (inflated.length < expected) return null;

    const rgba = new Uint8Array(rowBytes * height);
    let sourceOffset = 0;
    for (let row = 0; row < height; row += 1) {
      const filter = inflated[sourceOffset++];
      const rowStart = row * rowBytes;
      const previousStart = (row - 1) * rowBytes;
      for (let index = 0; index < rowBytes; index += 1) {
        const encoded = inflated[sourceOffset++];
        const left = index >= 4 ? rgba[rowStart + index - 4] : 0;
        const up = row > 0 ? rgba[previousStart + index] : 0;
        const upLeft = row > 0 && index >= 4 ? rgba[previousStart + index - 4] : 0;
        let value;
        if (filter === 0) value = encoded;
        else if (filter === 1) value = encoded + left;
        else if (filter === 2) value = encoded + up;
        else if (filter === 3) value = encoded + Math.floor((left + up) / 2);
        else if (filter === 4) value = encoded + paethPredictor(left, up, upLeft);
        else return null;
        rgba[rowStart + index] = value & 0xff;
      }
    }
    return rgba;
  }

  function decodeStealthBytes(rgba, width, height, byteCount) {
    const result = new Uint8Array(byteCount);
    let byte = 0;
    let bitCount = 0;
    let out = 0;

    // Matches NovelAI's official alpha.T.reshape((-1,)) order: x-major, then y.
    for (let x = 0; x < width && out < byteCount; x += 1) {
      for (let y = 0; y < height && out < byteCount; y += 1) {
        const alpha = rgba[(y * width + x) * 4 + 3];
        byte = (byte << 1) | (alpha & 1);
        bitCount += 1;
        if (bitCount === 8) {
          result[out] = byte;
          out += 1;
          byte = 0;
          bitCount = 0;
        }
      }
    }
    return out === byteCount ? result : result.subarray(0, out);
  }

  function extractStealthMetadataFromRgba(rgba, width, height) {
    if (!(rgba instanceof Uint8Array) || rgba.length < width * height * 4) return null;
    const headerLength = STEALTH_MAGIC.length + 4;
    const header = decodeStealthBytes(rgba, width, height, headerLength);
    if (header.length !== headerLength || !equalBytes(header.subarray(0, STEALTH_MAGIC.length), STEALTH_MAGIC)) return null;
    const bitLength = readUint32(header, STEALTH_MAGIC.length);
    if (!bitLength || bitLength % 8 !== 0) return null;
    const payloadLength = bitLength / 8;
    if (payloadLength > MAX_METADATA_BYTES) throw new Error('PNG 隐写元数据过大，已拒绝解析。');
    const all = decodeStealthBytes(rgba, width, height, headerLength + payloadLength);
    if (all.length < headerLength + payloadLength) return null;
    const compressed = all.subarray(headerLength);
    const jsonText = decodeUtf8(gunzip(compressed, { maxOutputLength: MAX_METADATA_BYTES }));
    const metadata = JSON.parse(jsonText);
    if (typeof metadata.Comment === 'string') metadata.Comment = parseMaybeJson(metadata.Comment);
    return metadata;
  }


  return { readPngChunks, extractStandardPngMetadata, decodeRgbaPng, extractStealthMetadataFromRgba };
}

export const { readPngChunks, extractStandardPngMetadata, decodeRgbaPng, extractStealthMetadataFromRgba } = createPngMetadataParser();

function asString(value) {
  return typeof value === 'string' ? value : '';
}

export function metadataValue(metadata, ...keys) {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const compact = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = new Set(keys.map(compact));
  const entries = Object.entries(metadata);
  const found = entries.find(([name]) => wanted.has(compact(name)));
  if (found) return found[1];
  return undefined;
}

function metadataObject(metadata, ...keys) {
  if (!metadata || typeof metadata !== 'object') return {};
  const compact = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = new Set(keys.map(compact));
  const candidates = Object.entries(metadata)
    .filter(([key]) => wanted.has(compact(key)))
    .map(([, value]) => parseMaybeJson(value))
    .filter(value => value && typeof value === 'object' && !Array.isArray(value));
  candidates.sort((a, b) => Object.keys(b).length - Object.keys(a).length);
  return candidates[0] || {};
}

function normalizeCenters(value) {
  if (!Array.isArray(value) || !value.length) return [{ x: 0.5, y: 0.5 }];
  return value.slice(0, 4).map(item => ({
    x: Math.min(1, Math.max(0, Number(item?.x) || 0.5)),
    y: Math.min(1, Math.max(0, Number(item?.y) || 0.5))
  }));
}

function getCaptionList(value) {
  return Array.isArray(value?.caption?.char_captions) ? value.caption.char_captions : [];
}

function buildCharacters(comment) {
  const positives = getCaptionList(comment?.v4_prompt);
  const negatives = getCaptionList(comment?.v4_negative_prompt);
  const count = Math.max(positives.length, negatives.length);
  const characters = [];
  for (let index = 0; index < count; index += 1) {
    const positive = positives[index] || {};
    const negative = negatives[index] || {};
    const prompt = asString(positive.char_caption || positive.caption || positive.prompt);
    const uc = asString(negative.char_caption || negative.caption || negative.prompt);
    if (!prompt && !uc) continue;
    characters.push({
      name: asString(positive.name || negative.name || `角色 ${index + 1}`),
      prompt,
      uc,
      centers: normalizeCenters(positive.centers || negative.centers),
      enabled: true
    });
  }
  return characters;
}

const MANAGED_PARAMETER_KEYS = new Set([
  'prompt', 'negative_prompt', 'uc', 'v4_prompt', 'v4_negative_prompt', 'width', 'height', 'steps', 'scale',
  'sampler', 'noise_schedule', 'seed', 'extra_noise_seed', 'n_samples', 'ucPreset', 'uc_preset', 'qualityToggle',
  'quality_toggle', 'cfg_rescale', 'sm', 'sm_dyn', 'prefer_brownian', 'deliberate_euler_ancestral_bug',
  'request_type', 'signed_hash', 'version', 'params_version', 'stream', 'image_format', 'legacy', 'legacy_v3_extend',
  'straight_alpha', 'tag_hint_transparent_background', 'model', 'model_name', 'model_hash', 'action', 'operation'
]);

function pickAdvancedOverrides(comment) {
  if (!comment || typeof comment !== 'object' || Array.isArray(comment)) return {};
  const result = {};
  for (const [key, value] of Object.entries(comment)) {
    if (MANAGED_PARAMETER_KEYS.has(key) || isNonAdvancedParameterKey(key)) continue;
    if (! [...KNOWN_ADVANCED_PARAMETER_KEYS].some(item => item.replace(/[^a-z0-9]/gi, '').toLowerCase() === String(key).replace(/[^a-z0-9]/g, '').toLowerCase())) continue;
    if (value != null && (['string', 'number', 'boolean'].includes(typeof value) || Array.isArray(value))) {
      result[canonicalAdvancedParameterKey(key)] = value;
    }
  }
  return filterAdvancedOverrides(result);
}

function pickImportedExtras(comment) {
  if (!comment || typeof comment !== 'object' || Array.isArray(comment)) return {};
  const result = {};
  const compact = value => String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const advanced = new Set([...KNOWN_ADVANCED_PARAMETER_KEYS].map(compact));
  for (const [key, value] of Object.entries(comment)) {
    if (MANAGED_PARAMETER_KEYS.has(key) || isNonAdvancedParameterKey(key) || advanced.has(compact(key))) continue;
    try {
      const encoded = JSON.stringify(value);
      if (encoded === undefined || encoded.length > 24_000) continue;
      result[String(key).slice(0, 120)] = JSON.parse(encoded);
    } catch {
      // Ignore values that cannot be represented safely in the review bucket.
    }
    if (Object.keys(result).length >= 64) break;
  }
  return result;
}

export function normalizeNovelAiMetadata(metadata, dimensions = {}) {
  const comment = metadataObject(metadata, 'Comment', 'comment', 'parameters', 'rawParameters', 'raw_parameters', 'Raw Parameters', 'RawParameters');
  const description = asString(metadataValue(metadata, 'Description', 'prompt'));
  const basePrompt = asString(comment?.v4_prompt?.caption?.base_caption) || asString(comment?.prompt) || description;
  const negativePrompt = asString(comment?.v4_negative_prompt?.caption?.base_caption)
    || asString(comment?.uc)
    || asString(comment?.negative_prompt);
  const characters = buildCharacters(comment);
  const warnings = [];
  if (!Object.keys(comment).length) warnings.push('图片没有可用的 Raw Parameters；只能恢复 Description 中的 Prompt。');
  if (!basePrompt && !characters.some(item => item.prompt)) warnings.push('没有找到可恢复的正向 Prompt。');
  const software = asString(metadataValue(metadata, 'Software'));
  const source = asString(metadataValue(metadata, 'Source'));
  if (!software.toLowerCase().includes('novelai')) warnings.push('未检测到 NovelAI Software 标记；参数可能来自其他工具。');

  const width = Number(comment?.width || dimensions.width || DEFAULT_GENERATION_PARAMS.width);
  const height = Number(comment?.height || dimensions.height || DEFAULT_GENERATION_PARAMS.height);
  const modelInfo = inferNovelAiModel(
    comment?.model,
    comment?.model_name,
    comment?.model_hash,
    comment?.model_id,
    comment?.modelId,
    metadataValue(metadata, 'Model', 'model', 'model_id', 'modelId'),
    source,
    metadata,
    comment?.params_version,
    comment?.paramsVersion,
    metadataValue(metadata, 'params_version', 'paramsVersion')
  );
  if (!modelInfo.detected) warnings.push('没有从 PNG 元数据识别模型；恢复时将保持当前模型，V4.5 仅作为旧图兼容默认值。');
  const qualityValue = comment?.qualityToggle ?? comment?.quality_toggle;
  const tagHintUcPreset = Number.isFinite(Number(comment?.tag_hint_uc_preset)) ? Number(comment.tag_hint_uc_preset) : undefined;
  const tagHintQuality = comment?.tag_hint_qt == null ? undefined : comment.tag_hint_qt !== false && Number(comment.tag_hint_qt) !== 0;
  const semantics = classifyNaiParameters(comment, metadata);
  const importedExtras = pickImportedExtras(comment);
  if (semantics.imageRecovery.status !== 'none' && semantics.imageRecovery.status !== 'ready') {
    warnings.push(semantics.imageRecovery.reason);
  }

  return {
    title: asString(metadata?.Title),
    description,
    software,
    source,
    requestType: asString(metadataValue(metadata, 'Request Type') || comment?.request_type),
    signaturePresent: Boolean(comment?.signed_hash),
    signatureVerified: null,
    prompt: basePrompt,
    negativePrompt,
    characters,
    model: modelInfo.model,
    modelDetected: modelInfo.detected,
    modelEvidence: modelInfo.evidence,
    modelSource: modelInfo.source,
    seed: Number.isFinite(Number(comment?.seed)) ? Number(comment.seed) : 0,
    params: {
      width: Number.isFinite(width) ? width : DEFAULT_GENERATION_PARAMS.width,
      height: Number.isFinite(height) ? height : DEFAULT_GENERATION_PARAMS.height,
      steps: Number.isFinite(Number(comment?.steps)) ? Number(comment.steps) : DEFAULT_GENERATION_PARAMS.steps,
      scale: Number.isFinite(Number(comment?.scale)) ? Number(comment.scale) : DEFAULT_GENERATION_PARAMS.scale,
      sampler: normalizeSampler(comment?.sampler),
      noiseSchedule: normalizeSchedule(comment?.noise_schedule ?? comment?.noiseSchedule),
      ucPreset: Number.isFinite(Number(comment?.ucPreset ?? comment?.uc_preset))
        ? Number(comment.ucPreset ?? comment.uc_preset)
        : (tagHintUcPreset ?? 0),
      cfgRescale: Number.isFinite(Number(comment?.cfg_rescale)) ? Number(comment.cfg_rescale) : 0,
      qualityToggle: typeof qualityValue === 'boolean' ? qualityValue : (tagHintQuality ?? false),
      preferBrownian: typeof comment?.prefer_brownian === 'boolean' ? comment.prefer_brownian : true,
      sm: comment?.sm === true,
      smDyn: comment?.sm_dyn === true,
      deliberateEulerAncestralBug: comment?.deliberate_euler_ancestral_bug === true,
      varietyBoost: Number.isFinite(Number(comment?.skip_cfg_above_sigma)) ? Number(comment.skip_cfg_above_sigma) : 0,
      nativeAlpha: comment?.straight_alpha === true || comment?.tag_hint_transparent_background === true,
       advancedOverrides: pickAdvancedOverrides(comment),
       importedExtras
    },
    imageWorkflow: semantics.imageWorkflow,
    imageTool: semantics.imageTool,
    embeddedInputImage: semantics.embeddedInputImage,
    embeddedMaskImage: semantics.embeddedMaskImage,
    imageRecovery: semantics.imageRecovery,
    workflowMetadata: semantics.workflowMetadata,
    v4Options: {
      useCoords: comment?.v4_prompt?.use_coords === true,
      useOrder: comment?.v4_prompt?.use_order !== false,
      negativeUseOrder: comment?.v4_negative_prompt?.use_order === true,
      legacyUc: comment?.v4_negative_prompt?.legacy_uc === true
    },
    rawParameters: comment,
    warnings
  };
}
