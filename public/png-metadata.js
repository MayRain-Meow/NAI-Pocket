
import { Inflate } from './vendor/pako-inflate.js?v=1.8.10';
import { inferNovelAiModel } from './model-utils.js?v=1.8.10';
import { DEFAULT_GENERATION_PARAMS } from './generation-state.js?v=1.8.10'; 
import { repairJsonSyntax } from './import-repair.js?v=1.8.10';
import { normalizeSampler, normalizeSchedule } from './nai-import.js?v=1.8.10';
import {
  classifyNaiParameters,
  canonicalAdvancedParameterKey,
  filterAdvancedOverrides,
  KNOWN_ADVANCED_PARAMETER_KEYS,
  isNonAdvancedParameterKey
} from './parameter-semantics.js?v=1.8.10';

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

// WebP and JPEG: the same NovelAI record can travel in EXIF (UserComment / ImageDescription),
// XMP or a JPEG comment, and a WebP keeps the alpha-LSB stealth payload when its alpha survives.

export function imageContainer(buffer) {
  if (!(buffer instanceof Uint8Array) || buffer.length < 12) return '';
  if (buffer.length >= 8 && equalBytes(buffer.subarray(0, 8), PNG_SIGNATURE)) return 'png';
  if (decodeText(buffer.subarray(0, 4), 'ascii') === 'RIFF' && decodeText(buffer.subarray(8, 12), 'ascii') === 'WEBP') return 'webp';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
  return '';
}

const startsWith = (bytes, text) => bytes.length >= text.length && [...text].every((char, index) => bytes[index] === char.charCodeAt(0));

function decodeUtf16(bytes, littleEndian) {
  const even = bytes.subarray(0, bytes.length - (bytes.length % 2));
  return new TextDecoder(littleEndian ? 'utf-16le' : 'utf-16be').decode(even).replace(/\0+$/g, '');
}

// EXIF UserComment starts with an 8-byte character code; writers disagree on UTF-16 byte order.
function decodeUserComment(bytes, littleEndian) {
  if (bytes.length < 8) return decodeText(bytes, 'utf8').trim();
  const code = decodeText(bytes.subarray(0, 8), 'ascii').replace(/\0+$/g, '');
  const body = bytes.subarray(8);
  if (code === 'UNICODE') {
    const le = body.length > 1 && body[0] !== 0 && body[1] === 0, be = body.length > 1 && body[0] === 0 && body[1] !== 0;
    return decodeUtf16(body, le ? true : be ? false : littleEndian).trim();
  }
  return decodeText(code === 'ASCII' || code === '' || code === 'JIS' ? body : bytes, 'utf8').trim();
}

// Plain TIFF/EXIF walker for the few text tags a NovelAI record can live in.
function readExifText(tiff) {
  const out = {};
  if (!(tiff instanceof Uint8Array) || tiff.length < 8) return out;
  const order = decodeText(tiff.subarray(0, 2), 'ascii');
  if (order !== 'II' && order !== 'MM') return out;
  const le = order === 'II';
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = offset => view.getUint16(offset, le), u32 = offset => view.getUint32(offset, le);
  const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 7: 1 };
  const seen = new Set();
  const walk = (offset, depth) => {
    if (depth > 2 || seen.has(offset) || offset + 2 > tiff.length) return;
    seen.add(offset);
    const count = u16(offset);
    for (let index = 0; index < count && index < 512; index += 1) {
      const entry = offset + 2 + index * 12;
      if (entry + 12 > tiff.length) return;
      const tag = u16(entry), type = u16(entry + 2), n = u32(entry + 4);
      if (tag === 0x8769 && type === 4) { walk(u32(entry + 8), depth + 1); continue; }
      if (!sizes[type]) continue;
      const length = n * sizes[type];
      const start = length <= 4 ? entry + 8 : u32(entry + 8);
      if (length > MAX_METADATA_BYTES || start + length > tiff.length) continue;
      const bytes = tiff.subarray(start, start + length);
      if (tag === 0x010e) out.ImageDescription = decodeText(bytes, 'utf8').trim();
      else if (tag === 0x0131) out.Software = decodeText(bytes, 'utf8').trim();
      else if (tag === 0x9286) out.UserComment = decodeUserComment(bytes, le);
      else if (tag === 0x9c9c) out.XPComment = decodeUtf16(bytes, true).trim();
    }
  };
  walk(u32(4), 0);
  return out;
}

function xmlText(value) {
  return value.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16))).replace(/&amp;/g, '&').trim();
}

function readXmpText(bytes) {
  const xml = decodeText(bytes, 'utf8'), out = {};
  for (const [key, name] of [['UserComment', 'exif:UserComment'], ['ImageDescription', 'dc:description'], ['Software', 'xmp:CreatorTool']]) {
    const element = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
    const attribute = xml.match(new RegExp(`${name}="([^"]*)"`));
    const text = element ? xmlText(element[1]) : attribute ? xmlText(attribute[1]) : '';
    if (text) out[key] = text;
  }
  return out;
}

const isNovelAiComment = value => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && (value.prompt != null || value.v4_prompt || value.steps != null || value.uc != null));

// Map EXIF/XMP/comment text onto the PNG key names the normalizer already reads.
function metadataFromTexts(texts) {
  const metadata = {};
  if (texts.Software) metadata.Software = texts.Software;
  for (const text of [texts.UserComment, texts.XPComment, texts.Comment, texts.ImageDescription]) {
    if (!text) continue;
    const parsed = parseMaybeJson(text);
    if (isNovelAiComment(parsed)) { metadata.Comment ??= parsed; continue; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed.Comment || parsed.Description)) {
      // A whole NovelAI metadata dictionary (Software / Source / Description / Comment).
      for (const [key, value] of Object.entries(parsed)) if (metadata[key] == null) metadata[key] = key === 'Comment' ? parseMaybeJson(value) : value;
      continue;
    }
    if (/(^|\n)\s*Steps:\s*\d+/.test(text)) { metadata.parameters ??= text; continue; }
    if (text === texts.ImageDescription && metadata.Description == null) metadata.Description = text;
  }
  return metadata;
}

function extractWebpMetadata(buffer) {
  const texts = {};
  let width = null, height = null, hasAlpha = false;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const type = decodeText(buffer.subarray(offset, offset + 4), 'ascii');
    const size = view.getUint32(offset + 4, true);
    const data = buffer.subarray(offset + 8, Math.min(buffer.length, offset + 8 + size));
    if (type === 'VP8X' && data.length >= 10) {
      hasAlpha = (data[0] & 0x10) !== 0;
      width = 1 + (data[4] | (data[5] << 8) | (data[6] << 16));
      height = 1 + (data[7] | (data[8] << 8) | (data[9] << 16));
    } else if (type === 'VP8L' && data.length >= 5 && data[0] === 0x2f) {
      const bits = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
      width ??= 1 + (bits & 0x3fff);
      height ??= 1 + ((bits >>> 14) & 0x3fff);
      hasAlpha = hasAlpha || ((bits >>> 28) & 1) === 1;
    } else if (type === 'VP8 ' && data.length >= 10 && width == null) {
      width = view.getUint16(offset + 8 + 6, true) & 0x3fff;
      height = view.getUint16(offset + 8 + 8, true) & 0x3fff;
    } else if (type === 'ALPH') {
      hasAlpha = true;
    } else if (type === 'EXIF') {
      Object.assign(texts, readExifText(startsWith(data, 'Exif\0\0') ? data.subarray(6) : data));
    } else if (type === 'XMP ') {
      for (const [key, value] of Object.entries(readXmpText(data))) texts[key] ??= value;
    }
    offset += 8 + size + (size % 2);
  }
  return { metadata: metadataFromTexts(texts), width, height, hasAlpha };
}

function extractJpegMetadata(buffer) {
  const texts = {};
  let width = null, height = null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let offset = 2; offset + 4 <= buffer.length;) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { offset += marker === 0xff ? 1 : 2; continue; }
    if (marker === 0xda || marker === 0xd9) break;
    const length = view.getUint16(offset + 2, false);
    const data = buffer.subarray(offset + 4, Math.min(buffer.length, offset + 2 + length));
    if (marker === 0xe1 && startsWith(data, 'Exif\0\0')) Object.assign(texts, readExifText(data.subarray(6)));
    else if (marker === 0xe1 && startsWith(data, 'http://ns.adobe.com/xap/1.0/\0')) {
      for (const [key, value] of Object.entries(readXmpText(data.subarray(29)))) texts[key] ??= value;
    } else if (marker === 0xfe) texts.Comment = decodeText(data, 'utf8').trim();
    else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && data.length >= 5) {
      height = view.getUint16(offset + 5, false);
      width = view.getUint16(offset + 7, false);
    }
    offset += 2 + length;
  }
  // JPEG has no alpha channel, so it can never carry the stealth payload.
  return { metadata: metadataFromTexts(texts), width, height, hasAlpha: false };
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

  function extractStandardImageMetadata(buffer) {
    const format = imageContainer(buffer);
    if (format === 'png') return { ...extractStandardPngMetadata(buffer), format };
    if (format === 'webp') return { ...extractWebpMetadata(buffer), format };
    if (format === 'jpeg') return { ...extractJpegMetadata(buffer), format };
    const error = new Error('只支持 PNG / WebP / JPEG 图片。');
    error.status = 400;
    throw error;
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


  return { readPngChunks, extractStandardPngMetadata, extractStandardImageMetadata, decodeRgbaPng, extractStealthMetadataFromRgba };
}

export const { readPngChunks, extractStandardPngMetadata, extractStandardImageMetadata, decodeRgbaPng, extractStealthMetadataFromRgba } = createPngMetadataParser();

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
    x: Math.min(1, Math.max(0, item?.x != null && item.x !== '' && Number.isFinite(Number(item.x)) ? Number(item.x) : 0.5)),
    y: Math.min(1, Math.max(0, item?.y != null && item.y !== '' && Number.isFinite(Number(item.y)) ? Number(item.y) : 0.5))
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
