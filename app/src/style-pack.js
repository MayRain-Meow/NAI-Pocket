import { Buffer } from 'buffer';
import { registerPlugin } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { createLocalStyleIndex, validateStyleManifest } from '../../service/style-index-local.js';
import { validateArtistResourceUrl } from '../../service/artist-pack.js';
import { nativeFiles } from './files.js';

// 画风数据 (0.5.0): the CLIP style index for 按感觉找 / 找相似, one verified file from a GitHub Release.
// It covers the g/s originals of the public annotation packs only. The manifest is read through the
// same native JSON reader as the pack catalog; the file is saved natively, then decoded here before
// the app switches to it, so a bad download never replaces working data.

export const DEFAULT_STYLE_MANIFEST_URL = 'https://github.com/MayRain-Meow/NAI-Pocket/releases/download/artist-style-2026-10-15/style-index.json';
const native = registerPlugin('ArtistResources');
const STATE = 'style-index/installed.json';
const busyError = () => Object.assign(new Error('画风数据正在下载。'), { status: 409 });

export function openStylePack() {
  let busy = false, operationId = '';
  async function installed() {
    try { const value = JSON.parse((await nativeFiles.read(STATE)).toString('utf8')); return value?.path ? value : null; }
    catch { return null; }
  }
  // The WebView serves app files from its own origin, so the 24 MB file is read with fetch rather
  // than as base64 over the bridge.
  async function bytesOf(path) {
    const response = await fetch(await nativeFiles.url(path));
    if (!response.ok) throw new Error(`画风数据读取失败（${response.status}）。`);
    return new Uint8Array(await response.arrayBuffer());
  }
  const index = createLocalStyleIndex({ async read() { const state = await installed(); return state ? bytesOf(state.path) : null; } });
  return {
    index,
    async state() { return { installed: await installed(), busy }; },
    async readManifest(input = {}) {
      const url = validateArtistResourceUrl(input.url || DEFAULT_STYLE_MANIFEST_URL, 'json');
      if (busy) throw busyError();
      busy = true; operationId = crypto.randomUUID();
      try { const result = await native.readCatalog({ url, operationId }); return { manifest: validateStyleManifest(result.catalog, url) }; }
      finally { busy = false; }
    },
    async download(input = {}) {
      const manifestUrl = validateArtistResourceUrl(input.manifestUrl || DEFAULT_STYLE_MANIFEST_URL, 'json');
      const manifest = validateStyleManifest(input.manifest, manifestUrl);
      if (busy) throw busyError();
      busy = true; operationId = crypto.randomUUID();
      let saved = null;
      try {
        const result = await native.downloadStyleIndex({ url: manifest.file.url, sha256: manifest.file.sha256, operationId });
        if (result.cancelled) return { cancelled: true };
        saved = result.path;
        const ix = index.decode(await bytesOf(saved));
        const previous = await installed();
        const state = { version: manifest.version, sha256: manifest.file.sha256, path: saved, bytes: result.bytes, images: ix.rows.length, artists: ix.names.length, installedAt: Date.now() };
        await nativeFiles.write(STATE, Buffer.from(JSON.stringify(state)));
        saved = null;
        if (previous?.path && previous.path !== state.path) await nativeFiles.remove(previous.path).catch(() => {});
        index.reset();
        return { installed: state };
      } finally {
        if (saved) await nativeFiles.remove(saved).catch(() => {});
        busy = false;
      }
    },
    async remove() {
      if (busy) throw busyError();
      const state = await installed();
      await nativeFiles.remove(STATE);
      if (state?.path) await nativeFiles.remove(state.path).catch(() => {});
      // Leftovers from an interrupted download.
      try { for (const file of (await Filesystem.readdir({ path: 'style-index', directory: Directory.Data })).files) await nativeFiles.remove(`style-index/${file.name}`).catch(() => {}); } catch {}
      index.reset();
      return { installed: null };
    },
    async status() { return busy ? { busy: true, ...(await native.status()) } : { busy: false }; },
    async cancel() { if (!busy) return { accepted: false }; await native.cancelPack({ operationId }); return { accepted: true }; }
  };
}
