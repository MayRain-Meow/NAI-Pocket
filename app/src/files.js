import { Filesystem, Directory } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import { Buffer } from 'buffer';

const directory = Directory.Data;
export function localPath(tier, name) {
  const value = String(name || '').replaceAll('\\', '/');
  if (!value || value.startsWith('/') || value.split('/').some(part => part === '..' || part === '.') || value.includes(':')) throw new Error('Invalid file path');
  return `${tier}/${value}`;
}
export const nativeFiles = {
  async read(path, { signal } = {}) {
    signal?.throwIfAborted();
    const result = await Filesystem.readFile({ path, directory });
    signal?.throwIfAborted();
    return typeof result.data === 'string' ? Buffer.from(result.data, 'base64') : Buffer.from(await result.data.arrayBuffer());
  },
  async write(path, bytes) {
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (parent) await Filesystem.mkdir({ path: parent, directory, recursive: true }).catch(() => {});
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await Filesystem.writeFile({ path: temporary, directory, data: Buffer.from(bytes).toString('base64') });
      await Filesystem.rename({ from: temporary, to: path, directory, toDirectory: directory });
    } catch (error) { await Filesystem.deleteFile({ path: temporary, directory }).catch(() => {}); throw error; }
    return path;
  },
  async stat(path) { const result = await Filesystem.stat({ path, directory }); return { isFile: result.type === 'file', size: result.size }; },
  async remove(path) {
    try { await Filesystem.stat({ path, directory }); } catch (error) {
      // Only absent files are idempotent; other native I/O errors must propagate.
      if (error.code === 'OS-PLUG-FILE-0008' || /does not exist|not found/i.test(error.message)) return;
      throw error;
    }
    await Filesystem.deleteFile({ path, directory });
  },
  async url(path) { return Capacitor.convertFileSrc((await Filesystem.getUri({ path, directory })).uri); }
};

async function canvasImage(path, { edge, opaque = false, target } = {}) {
  const bitmap = await createImageBitmap(new Blob([await nativeFiles.read(path)]));
  try {
    const scale = edge ? Math.min(1, edge / Math.max(bitmap.width, bitmap.height)) : 1;
    const canvas = document.createElement('canvas');
    canvas.width = target?.[0] || Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = target?.[1] || Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: opaque });
    if (target) {
      context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height);
      const ratio = Math.min(1, canvas.width / bitmap.width, canvas.height / bitmap.height);
      const width = bitmap.width * ratio, height = bitmap.height * ratio;
      context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    } else context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (opaque) {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let offset = 3; offset < pixels.data.length; offset += 4) pixels.data[offset] = 255;
      context.putImageData(pixels, 0, 0);
    }
    return canvas;
  } finally { bitmap.close(); }
}
async function encode(canvas, mime, quality) {
  const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片编码失败。')), mime, quality));
  if (blob.type !== mime) throw new Error('设备不支持此图片格式。');
  return Buffer.from(await blob.arrayBuffer());
}
export const nativeImages = {
  async dimensions(path) {
    const bitmap = await createImageBitmap(new Blob([await nativeFiles.read(path)]));
    const result = { width: bitmap.width, height: bitmap.height }; bitmap.close(); return result;
  },
  async preview(source, target, edge = 1280) {
    const bytes = await encode(await canvasImage(source, { edge }), 'image/webp', 0.84);
    await nativeFiles.write(target, bytes); return { size: bytes.length };
  },
  async clean(source, format) { return encode(await canvasImage(source, { opaque: format === 'png' }), `image/${format}`, 0.9); },
  async precise(source, target) { return encode(await canvasImage(source, { target }), 'image/png'); }
};
