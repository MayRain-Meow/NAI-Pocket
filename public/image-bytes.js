const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const ascii = bytes => String.fromCharCode(...bytes);
const isPng = bytes => [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);

function validDimensions(width, height) {
  return Number.isInteger(width) && Number.isInteger(height)
    && width > 0 && height > 0 && width <= 100_000 && height <= 100_000
    ? { width, height }
    : null;
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    // Stand-alone markers do not carry a segment length.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = view(buffer).getUint16(offset, false);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    // SOF markers (excluding DHT/DAC and the JPEG differential variants that
    // still carry dimensions) all put height/width at the same offsets.
    const isSof = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
    if (isSof && segmentLength >= 7) {
      const height = view(buffer).getUint16(offset + 3, false);
      const width = view(buffer).getUint16(offset + 5, false);
      return validDimensions(width, height);
    }
    // SOS begins compressed scan data; no later marker is reliable without
    // decoding entropy-coded bytes, so stop and use the external fallback.
    if (marker === 0xda) break;
    offset += segmentLength;
  }
  return null;
}

function readWebpChunk(buffer, offset) {
  if (offset + 8 > buffer.length) return null;
  const size = view(buffer).getUint32(offset + 4, true);
  const dataStart = offset + 8;
  const dataEnd = dataStart + size;
  if (dataEnd > buffer.length) return null;
  return { type: ascii(buffer.subarray(offset, offset + 4)), size, dataStart, dataEnd };
}

function webpDimensions(buffer) {
  if (buffer.length < 16 || ascii(buffer.subarray(0, 4)) !== 'RIFF' || ascii(buffer.subarray(8, 12)) !== 'WEBP') return null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunk = readWebpChunk(buffer, offset);
    if (!chunk) break;
    const data = buffer.subarray(chunk.dataStart, chunk.dataEnd);
    if (chunk.type === 'VP8X' && data.length >= 10) {
      const width = 1 + data[4] + (data[5] << 8) + (data[6] << 16);
      const height = 1 + data[7] + (data[8] << 8) + (data[9] << 16);
      return validDimensions(width, height);
    }
    if (chunk.type === 'VP8L' && data.length >= 5 && data[0] === 0x2f) {
      const width = 1 + ((data[1] | (data[2] << 8)) & 0x3fff);
      const height = 1 + (((data[2] >> 6) | (data[3] << 2) | (data[4] << 10)) & 0x3fff);
      return validDimensions(width, height);
    }
    if (chunk.type === 'VP8 ' && data.length >= 10
      && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
      const width = view(buffer).getUint16(chunk.dataStart + 6, true) & 0x3fff;
      const height = view(buffer).getUint16(chunk.dataStart + 8, true) & 0x3fff;
      return validDimensions(width, height);
    }
    offset = chunk.dataEnd + (chunk.size & 1);
  }
  return null;
}

/**
 * Read dimensions from common image headers without starting ImageMagick.
 * Upload/clone confirmation can therefore finish immediately even when the
 * host has a slow or unavailable `identify` binary; the external command is
 * retained only as a fallback for unusual formats/headers.
 */
export function imageDimensionsFromBytes(buffer) {
  if (!(buffer instanceof Uint8Array)) return null;
  if (buffer.length >= 24 && isPng(buffer)) {
    return validDimensions(view(buffer).getUint32(16, false), view(buffer).getUint32(20, false));
  }
  const jpeg = jpegDimensions(buffer);
  if (jpeg) return jpeg;
  return webpDimensions(buffer);
}

export function imageExtension(mime) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}

export function detectImageMime(buffer, fallback = 'application/octet-stream') {
  if (buffer?.length >= 12 && ascii(buffer.subarray(0, 4)) === 'RIFF' && ascii(buffer.subarray(8, 12)) === 'WEBP') return 'image/webp';
  if (buffer?.length >= 8 && isPng(buffer)) return 'image/png';
  if (buffer?.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  return fallback;
}

