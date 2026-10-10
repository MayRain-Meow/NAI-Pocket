import { Buffer } from 'buffer';
import { Inflate } from '../../public/vendor/pako-inflate.js';
export const hashBytes = async bytes => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
export function inflateRaw(bytes, { maxOutputLength }) {
  const decoder = new Inflate({ raw: true, chunkSize: 65536 });
  const chunks = []; let length = 0;
  decoder.onData = chunk => {
    length += chunk.length;
    if (length > maxOutputLength) throw new Error('ZIP 图片解压超出上限。');
    chunks.push(Buffer.from(chunk));
  };
  decoder.push(bytes, true);
  if (decoder.err) throw new Error(decoder.msg || 'ZIP 图片解压失败。');
  return Buffer.concat(chunks, length);
}
