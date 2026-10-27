import { decodeRgbaPng, readPngChunks } from './png-metadata.js?v=1.9.40';
import { imageDimensionsFromBytes, detectImageMime } from './image-bytes.js?v=1.9.40';
import { Inflate } from './vendor/pako-inflate.js?v=1.9.40';
import { FOCUSED_IMAGE_MAX_BYTES, assertFocusedDimensions, assertFocusedRgba, checkFocusedAbort } from './focused-inpaint.js?v=1.9.40';


const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const text = bytes => String.fromCharCode(...bytes);
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const unsupportedPng = () => new Error('此 PNG 的位深或交错编码暂不支持框选重绘；请先另存为普通 8 位 PNG。');
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function join(parts) {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function chunk(type, data) {
  const result = new Uint8Array(data.length + 12);
  view(result).setUint32(0, data.length);
  result.set(new TextEncoder().encode(type), 4); result.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < result.length - 4; i++) crc = crcTable[(crc ^ result[i]) & 255] ^ (crc >>> 8);
  view(result).setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0);
  return result;
}
function checkBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > FOCUSED_IMAGE_MAX_BYTES) throw new Error('图片文件无效或超过 64 MiB。');
}

function assertUprightExif(bytes) {
  if (text(bytes.subarray(0, 6)) === 'Exif\0\0') bytes = bytes.subarray(6);
  const endian = text(bytes.subarray(0, 2)), little = endian === 'II';
  const invalid = () => new Error('图片方向信息无效；请先另存为正向 PNG 再框选重绘。');
  if (bytes.length < 8 || !['II', 'MM'].includes(endian)) throw invalid();
  const data = view(bytes);
  if (data.getUint16(2, little) !== 42) throw invalid();
  const offset = data.getUint32(4, little);
  if (offset < 8 || offset + 2 > bytes.length) throw invalid();
  const count = data.getUint16(offset, little);
  if (offset + 2 + count * 12 > bytes.length) throw invalid();
  for (let i = 0; i < count; i++) {
    const at = offset + 2 + i * 12;
    if (data.getUint16(at, little) !== 0x112) continue;
    if (data.getUint16(at + 2, little) !== 3 || data.getUint32(at + 4, little) !== 1) throw invalid();
    if (data.getUint16(at + 8, little) !== 1) throw new Error('图片带有旋转方向信息；请先另存为正向 PNG 再框选重绘。');
  }
}

function inspectOrientation(bytes, mime) {
  if (mime === 'image/png') {
    const chunks = readPngChunks(bytes);
    if (chunks[0]?.type !== 'IHDR' || chunks[0].data.length !== 13 || chunks.at(-1)?.type !== 'IEND') throw new Error('PNG 文件不完整。');
    if (chunks[0].data[10] || chunks[0].data[11]) throw unsupportedPng();
    for (const item of chunks) {
      if (item.type === 'eXIf') assertUprightExif(item.data);
      if (item.type === 'acTL') throw new Error('动画 PNG 不支持框选重绘；请先另存单帧 PNG。');
    }
    return chunks;
  }
  if (mime === 'image/webp') {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const type = text(bytes.subarray(offset, offset + 4)), length = view(bytes).getUint32(offset + 4, true);
      const end = offset + 8 + length;
      if (end > bytes.length) throw new Error('WebP 文件不完整。');
      const data = bytes.subarray(offset + 8, end);
      if (type === 'EXIF') assertUprightExif(data);
      if (['ANIM', 'ANMF'].includes(type) || (type === 'VP8X' && (data[0] & 2))) throw new Error('动画 WebP 不支持框选重绘；请先另存单帧 PNG。');
      if (type === 'ALPH' || (type === 'VP8X' && (data[0] & 16)) || (type === 'VP8L' && (data[4] & 16))) {
        throw new Error('透明 WebP 请先另存为 PNG，再使用框选重绘，以保留蒙版外透明像素。');
      }
      offset = end + (length & 1);
    }
    return null;
  }
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 255) throw new Error('JPEG 图片头无效。');
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = view(bytes).getUint16(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error('JPEG 文件不完整。');
    if (marker === 0xe1 && text(bytes.subarray(offset + 2, offset + 8)) === 'Exif\0\0') assertUprightExif(bytes.subarray(offset + 2, offset + length));
    offset += length;
  }
  return null;
}

function decodeOtherPng(chunks, width, height, signal) {
  const header = chunks.find(item => item.type === 'IHDR')?.data;
  const depth = header?.[8], type = header?.[9], channels = { 0: 1, 2: 3, 3: 1, 4: 2 }[type];
  if (!header || header.length !== 13 || header[10] || header[11] || header[12] || !channels
    || !(depth === 8 || (type === 3 && [1, 2, 4].includes(depth)))) throw unsupportedPng();
  const rowBytes = Math.ceil(width * channels * depth / 8), pixelBytes = Math.max(1, Math.ceil(channels * depth / 8));
  const expected = height * (rowBytes + 1), parts = []; let total = 0;
  const decoder = new Inflate({ chunkSize: Math.min(65536, expected + 1) });
  decoder.onData = part => {
    total += part.length;
    if (total > expected) throw new Error('PNG 解压数据超过图片尺寸。');
    parts.push(part);
  };
  const compressed = chunks.filter(item => item.type === 'IDAT').map(item => item.data);
  if (!compressed.length || !decoder.push(join(compressed), true) || decoder.err || total !== expected) throw new Error('PNG 像素数据无效。');
  const packed = join(parts), decoded = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    if ((y & 31) === 0) checkFocusedAbort(signal);
    const row = y * rowBytes, source = y * (rowBytes + 1), filter = packed[source];
    if (filter > 4) throw new Error('PNG 行滤波无效。');
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= pixelBytes ? decoded[row + x - pixelBytes] : 0;
      const up = y ? decoded[row + x - rowBytes] : 0, diagonal = y && x >= pixelBytes ? decoded[row + x - rowBytes - pixelBytes] : 0;
      const p = left + up - diagonal, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - diagonal);
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : a <= b && a <= c ? left : b <= c ? up : diagonal;
      decoded[row + x] = (packed[source + 1 + x] + predictor) & 255;
    }
  }
  const palette = chunks.find(item => item.type === 'PLTE')?.data, transparency = chunks.find(item => item.type === 'tRNS')?.data;
  if (type === 3 && (!palette?.length || palette.length % 3)) throw new Error('PNG 调色板无效。');
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    if ((y & 31) === 0) checkFocusedAbort(signal);
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4, from = y * rowBytes + x * channels;
      if (type === 3) {
        const index = (decoded[y * rowBytes + Math.floor(x * depth / 8)] >>> (8 - depth - (x * depth) % 8)) & ((1 << depth) - 1);
        if (index * 3 + 2 >= palette.length) throw new Error('PNG 调色板索引无效。');
        rgba.set(palette.subarray(index * 3, index * 3 + 3), to); rgba[to + 3] = transparency?.[index] ?? 255;
      } else if (type === 2) {
        rgba.set(decoded.subarray(from, from + 3), to);
        rgba[to + 3] = transparency?.length === 6 && [0, 1, 2].every(c => view(transparency).getUint16(c * 2) === decoded[from + c]) ? 0 : 255;
      } else {
        rgba[to] = rgba[to + 1] = rgba[to + 2] = decoded[from];
        rgba[to + 3] = type === 4 ? decoded[from + 1] : transparency?.length === 2 && view(transparency).getUint16(0) === decoded[from] ? 0 : 255;
      }
    }
  }
  return rgba;
}

async function decodeOpaqueBrowser(bytes, mime, dimensions, signal) {
  if (typeof createImageBitmap !== 'function') throw new Error('当前 WebView 不支持图片解码，请更新 Android System WebView。');
  let bitmap, canvas;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: mime }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    checkFocusedAbort(signal);
    if (bitmap.width !== dimensions.width || bitmap.height !== dimensions.height) throw new Error('图片解码尺寸与框选坐标不一致，请先另存为正向 PNG。');
    canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(bitmap.width, bitmap.height) : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法读取图片像素。');
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) throw new Error('此透明图片请先另存为 PNG，以保留蒙版外透明像素。');
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } finally {
    bitmap?.close();
    if (canvas) { canvas.width = 1; canvas.height = 1; }
  }
}

async function deflate(bytes, signal) {
  if (typeof CompressionStream !== 'function') throw new Error('当前 WebView 不支持无损 PNG 编码，请更新 Android System WebView。');
  const reader = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate')).getReader();
  const parts = []; let size = 0;
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      checkFocusedAbort(signal);
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > FOCUSED_IMAGE_MAX_BYTES - 57) throw new Error('PNG 编码结果超过 64 MiB。');
      parts.push(value);
    }
    checkFocusedAbort(signal);
    return join(parts);
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

export function createBrowserFocusedInpaintCodec() {
  return {
    async decode(bytes, { signal } = {}) {
      checkFocusedAbort(signal); checkBytes(bytes);
      const dimensions = imageDimensionsFromBytes(bytes), mime = detectImageMime(bytes);
      if (!dimensions || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('框选重绘仅支持 PNG、JPEG 或 WebP 图片。');
      assertFocusedDimensions(dimensions.width, dimensions.height);
      const chunks = inspectOrientation(bytes, mime);
      const data = mime === 'image/png'
        ? decodeRgbaPng(bytes, dimensions.width, dimensions.height) || decodeOtherPng(chunks, dimensions.width, dimensions.height, signal)
        : await decodeOpaqueBrowser(bytes, mime, dimensions, signal);
      checkFocusedAbort(signal);
      return assertFocusedRgba({ ...dimensions, data });
    },
    async encode(image, { signal } = {}) {
      assertFocusedRgba(image); checkFocusedAbort(signal);
      const header = new Uint8Array(13);
      view(header).setUint32(0, image.width); view(header).setUint32(4, image.height); header[8] = 8; header[9] = 6;
      const rowBytes = image.width * 4, scanlines = new Uint8Array((rowBytes + 1) * image.height);
      for (let y = 0; y < image.height; y++) {
        if ((y & 31) === 0) checkFocusedAbort(signal);
        scanlines.set(image.data.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
      }
      const compressed = await deflate(scanlines, signal);
      const bytes = join([signature, chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', new Uint8Array())]);
      checkFocusedAbort(signal); checkBytes(bytes);
      return bytes;
    }
  };
}
