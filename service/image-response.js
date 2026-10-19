
// Third-party relays answer the same request with a raw image, a ZIP, NovelAI JSON, OpenAI-style
// JSON, a JSON link or an event stream, and often label it wrongly. Sniffing the bytes lets any
// NovelAI-compatible relay work without per-relay code. Portable: Uint8Array in, a byte-buffer
// codec (`binary`, Buffer-compatible) only for base64 and ZIP output.
import { Inflate } from '../public/vendor/pako-inflate.js';

const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 5000;
const MIN_BASE64_IMAGE = 64;
const IMAGE_URL_KEYS = new Set(['url', 'image_url', 'imageurl', 'image', 'images', 'output', 'result', 'src', 'href', 'download_url', 'downloadurl', 'file', 'file_url', 'fileurl']);
export const MAX_IMAGE_RESPONSE_BYTES = 96 * 1024 * 1024;

function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function gzipError(message) {
  return Object.assign(new Error(message), { status: 502 });
}

// Some relays send gzip without a usable Content-Encoding. Decode one byte-identified layer
// with the same bounded, CRC-checking codec on Node and Android; never probe/retry an endpoint.

export function decodeGzipImageResponse(bytes, { maxOutputLength = MAX_IMAGE_RESPONSE_BYTES } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('图片响应必须是字节数组。');
  if (!Number.isSafeInteger(maxOutputLength) || maxOutputLength < 1 || maxOutputLength > MAX_IMAGE_RESPONSE_BYTES) {
    throw new RangeError('图片响应解压上限无效。');
  }
  if (bytes.length > MAX_IMAGE_RESPONSE_BYTES) throw gzipError('中转返回的数据超过 96 MiB 上限。');
  if (!isGzip(bytes)) return bytes;
  const decoder = new Inflate({ windowBits: 31, chunkSize: 65_536 });
  const chunks = [];
  let length = 0;
  decoder.onData = chunk => {
    length += chunk.length;
    if (length > maxOutputLength) throw gzipError('中转 gzip 响应解压超过大小上限。');
    chunks.push(chunk);
  };
  // Do not trust gzip's ISIZE trailer for the limit: it can wrap or be forged. The running
  // output count is authoritative, and pako validates both the actual size and CRC trailer.
  decoder.push(bytes, true);
  if (decoder.err || !decoder.ended) throw gzipError('中转 gzip 响应损坏或不完整，无法解压。');
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  if (isGzip(output)) throw gzipError('中转返回了多层 gzip 响应，已停止解压。');
  return output;
}

export function imageMimeFromMagic(bytes) {
  if (!bytes || bytes.length < 3) return '';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return '';
}

function firstTextByte(bytes) {
  let index = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) index = 3;
  while (index < bytes.length && (bytes[index] === 0x20 || bytes[index] === 0x09 || bytes[index] === 0x0a || bytes[index] === 0x0d)) index += 1;
  return index;
}

// 'gzip' | 'png' | 'jpeg' | 'webp' | 'zip' | 'json' | 'sse' | 'unknown'
export function sniffImageResponse(bytes) {
  if (isGzip(bytes)) return 'gzip';
  const mime = imageMimeFromMagic(bytes);
  if (mime) return mime.slice(6);
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip';
  const start = firstTextByte(bytes);
  const head = bytes[start];
  if (head === 0x7b || head === 0x5b) return 'json';
  const prefix = new TextDecoder().decode(bytes.subarray(start, start + 8));
  if (/^(?:data:|event:|id:|:)/.test(prefix)) return 'sse';
  return 'unknown';
}

function looksBase64(text) {
  return text.length >= MIN_BASE64_IMAGE && /^[A-Za-z0-9+/_-]+={0,2}$/.test(text.slice(0, 4096)) && /^[A-Za-z0-9+/_\-=\s]+$/.test(text);
}

function imageUrl(text, key) {
  if (!/^https?:\/\//i.test(text) || text.length > 4096) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  const imageish = IMAGE_URL_KEYS.has(String(key || '').toLowerCase()) || /\.(?:png|jpe?g|webp)(?:$|\?)/i.test(url.pathname + url.search);
  if (!imageish) return null;
  return { url: url.href, secure: url.protocol === 'https:' };
}

function errorText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return errorText(value[0]);
  if (typeof value === 'object') return errorText(value.message ?? value.msg ?? value.detail ?? value.error ?? value.reason);
  return '';
}

export function upstreamErrorMessage(json) {
  if (!json || typeof json !== 'object') return '';
  for (const key of ['error', 'message', 'detail', 'msg', 'errors', 'reason']) {
    const text = errorText(json[key]).trim();
    if (text) return text.slice(0, 500);
  }
  return '';
}

export function createImageResponseParser({ binary, extractZipImage }) {
  const decodeBase64 = text => binary.from(String(text).replace(/\s+/g, ''), 'base64');

  // An embedded image (data: URI or bare base64 that decodes to image magic), or null.
  function embeddedImage(text) {
    const dataUri = /^data:image\/[^;,]+;base64,/i.exec(text);
    if (dataUri) {
      const buffer = decodeBase64(text.slice(dataUri[0].length));
      return imageMimeFromMagic(buffer) ? buffer : null;
    }
    if (!looksBase64(text)) return null;
    if (!imageMimeFromMagic(decodeBase64(text.slice(0, 24)))) return null;
    const buffer = decodeBase64(text);
    return imageMimeFromMagic(buffer) ? buffer : null;
  }

  // Depth-first in key order. An embedded image wins over a link anywhere in the document.
  function findInJson(root) {
    let nodes = 0, link = null;
    const visit = (value, key, owner, depth) => {
      if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return null;
      if (typeof value === 'string') {
        const buffer = embeddedImage(value);
        if (buffer) return { buffer, seed: Number.isInteger(owner?.seed) ? owner.seed : undefined };
        if (!link) link = imageUrl(value, key);
        return null;
      }
      if (!value || typeof value !== 'object') return null;
      // An array item is judged by the key that holds the array (images: ['https://…']).
      const entries = Array.isArray(value) ? value.map(item => [key, item]) : Object.entries(value);
      for (const [childKey, child] of entries) {
        const found = visit(child, childKey, Array.isArray(value) ? owner : value, depth + 1);
        if (found) return found;
      }
      return null;
    };
    const found = visit(root, '', null, 0);
    return found || (link ? { link } : null);
  }

  function imageResult(buffer, source, seed, extra = {}) {
    const mime = imageMimeFromMagic(buffer);
    if (!mime) throw Object.assign(new Error('中转返回的内容不是图片。'), { status: 502 });
    return { kind: 'image', source, buffer, mime, seed, ...extra };
  }

  function fromJson(json, { defaultSeed, noImageMessage, allowUrl, allowInsecureHttp }) {
    // NovelAI's own shape first, exactly as before.
    const item = json?.images?.[0];
    if (item?.image && !/^https?:\/\//i.test(String(item.image))) {
      const buffer = decodeBase64(String(item.image).replace(/^data:image\/[^;]+;base64,/, ''));
      return imageResult(buffer, 'json', Number.isInteger(item.seed) ? item.seed : defaultSeed);
    }
    const found = findInJson(json);
    if (found?.buffer) return imageResult(found.buffer, 'json', found.seed ?? (Number.isInteger(json?.seed) ? json.seed : defaultSeed));
    if (found?.link) {
      if (!found.link.secure && allowInsecureHttp !== true) throw Object.assign(new Error('中转返回的图片链接不是 HTTPS，已拒绝下载。'), { status: 502 });
      if (!allowUrl) throw Object.assign(new Error('中转返回的图片链接又指向了另一个链接，已停止。'), { status: 502 });
      return { kind: 'url', url: found.link.url, seed: Number.isInteger(json?.seed) ? json.seed : defaultSeed };
    }
    const upstream = upstreamErrorMessage(json);
    if (upstream) throw Object.assign(new Error(upstream), { status: 502 });
    throw new Error(noImageMessage);
  }

  function parseJsonText(text) {
    try { return JSON.parse(text); }
    catch { throw Object.assign(new Error('中转返回的 JSON 无法解析。'), { status: 502 }); }
  }

  function fromEventStream(text, options) {
    const payloads = [];
    for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) payloads.push(line.slice(5).trim());
    let lastJson = null;
    for (let index = payloads.length - 1; index >= 0; index -= 1) {
      const payload = payloads[index];
      if (!payload || payload === '[DONE]') continue;
      if (payload[0] === '{' || payload[0] === '[') {
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        lastJson ??= json;
        try { return { ...fromJson(json, options), source: 'sse' }; } catch {}
        continue;
      }
      const buffer = embeddedImage(payload);
      if (buffer) return imageResult(buffer, 'sse', options.defaultSeed);
    }
    if (lastJson) return { ...fromJson(lastJson, options), source: 'sse' };
    throw new Error(options.noImageMessage);
  }

  // bytes: Uint8Array/Buffer of the whole body. Returns { kind: 'image', source, buffer, mime, seed, filename? }
  // or { kind: 'url', url, seed } (HTTPS by default, at most when allowUrl). Throws with the upstream text when it has one.
  function parse({ bytes, defaultSeed, noImageMessage = '中转返回中没有图片。', allowUrl = true, allowInsecureHttp = false }) {
    const decoded = decodeGzipImageResponse(bytes instanceof Uint8Array ? bytes : binary.from(bytes));
    const buffer = binary.isBuffer?.(decoded) ? decoded : binary.from(decoded);
    const kind = sniffImageResponse(buffer);
    if (kind === 'png' || kind === 'jpeg' || kind === 'webp') return imageResult(buffer, 'raw', defaultSeed);
    if (kind === 'zip') {
      const image = extractZipImage(buffer);
      return imageResult(image.buffer, 'zip', defaultSeed, { filename: image.filename });
    }
    const options = { defaultSeed, noImageMessage, allowUrl, allowInsecureHttp };
    const text = new TextDecoder().decode(buffer);
    if (kind === 'json') return fromJson(parseJsonText(text.replace(/^\uFEFF/, '')), options);
    if (kind === 'sse') return fromEventStream(text, options);
    const bare = text.trim();
    const embedded = bare.length <= MAX_IMAGE_RESPONSE_BYTES ? embeddedImage(bare) : null;
    if (embedded) return imageResult(embedded, 'base64', defaultSeed);
    throw Object.assign(new Error('中转返回的内容不是图片。'), { status: 502 });
  }

  return { parse, sniff: sniffImageResponse };
}
