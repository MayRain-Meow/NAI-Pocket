import zlib from 'node:zlib';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length);
  header.write(type, 4, 'ascii');
  const body = Buffer.concat([header.subarray(4), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, data, tail]);
}

export function makePngFixture({ width = 64, height = 64, entries = [], rgba, filter = 0, splitIdat = false, interlace = 0, colorType = 6 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  header[12] = interlace;
  const textChunks = entries.map(({ type = 'tEXt', key, value, bytes }) => {
    const payload = bytes ?? Buffer.from(value, 'utf8');
    const prefix = Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0])]);
    if (type === 'zTXt') return chunk(type, Buffer.concat([prefix, Buffer.from([0]), zlib.deflateSync(payload)]));
    if (type === 'iTXt' || type === 'iTXt-plain') {
      const compressed = type === 'iTXt';
      return chunk('iTXt', Buffer.concat([prefix, Buffer.from([compressed ? 1 : 0, 0, 0, 0]), compressed ? zlib.deflateSync(payload) : payload]));
    }
    return chunk('tEXt', Buffer.concat([prefix, payload]));
  });
  const chunks = [chunk('IHDR', header), ...textChunks];
  if (rgba) {
    const scanlines = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
      const row = y * (width * 4 + 1);
      scanlines[row] = filter;
      for (let x = 0; x < width * 4; x++) {
        const index = y * width * 4 + x;
        const left = x >= 4 ? rgba[index - 4] : 0;
        const up = y ? rgba[index - width * 4] : 0;
        const diagonal = y && x >= 4 ? rgba[index - width * 4 - 4] : 0;
        let predictor = 0;
        if (filter === 1) predictor = left;
        if (filter === 2) predictor = up;
        if (filter === 3) predictor = Math.floor((left + up) / 2);
        if (filter === 4) {
          const estimate = left + up - diagonal;
          const candidates = [left, up, diagonal];
          predictor = candidates.reduce((best, item) => Math.abs(estimate - item) < Math.abs(estimate - best) ? item : best);
        }
        scanlines[row + 1 + x] = (rgba[index] - predictor) & 255;
      }
    }
    const compressed = zlib.deflateSync(scanlines);
    const middle = splitIdat ? Math.floor(compressed.length / 2) : compressed.length;
    chunks.push(chunk('IDAT', compressed.subarray(0, middle)));
    if (splitIdat) chunks.push(chunk('IDAT', compressed.subarray(middle)));
  }
  return Buffer.concat([signature, ...chunks, chunk('IEND', Buffer.alloc(0))]);
}

export function makeStealthFixture(metadata, width = 64, height = 64) {
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(metadata)));
  const header = Buffer.alloc(19);
  header.write('stealth_pngcomp');
  header.writeUInt32BE(compressed.length * 8, 15);
  const payload = Buffer.concat([header, compressed]);
  if (payload.length * 8 > width * height) throw new Error('Fixture carrier is too small.');
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let bit = 0; bit < payload.length * 8; bit++) {
    const x = Math.floor(bit / height), y = bit % height;
    rgba[(y * width + x) * 4 + 3] = 254 | ((payload[bit >>> 3] >>> (7 - (bit & 7))) & 1);
  }
  return { rgba, width, height };
}
