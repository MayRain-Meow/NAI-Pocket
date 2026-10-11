import { isOfficialProvider } from '../../public/provider-route.js';
import { confirmAction } from '../../public/confirm-sheet.js';
import { Buffer } from 'buffer';
import { createAssetsService } from '../../service/assets.js';
import { createAssetsStore } from '../../service/storage/assets.js';
import { nativeFiles, nativeImages, localPath } from './files.js';
import { hashBytes } from './codecs.js';


export function openAssets(database, settings, http, providers) {
  const assets = createAssetsService({ store: database.store(createAssetsStore(database.db)), files: {
    write: (name, bytes) => nativeFiles.write(localPath('input-assets', name), bytes),
    locate: row => localPath('input-assets', row.stored_name), read: nativeFiles.read,
    readGallery: row => nativeFiles.read(localPath('originals', row.original_name))
  }, images: nativeImages, hash: hashBytes, ids: { next: () => crypto.randomUUID() }, clock: { now: () => Date.now() } });
  async function vibeInput(ref, model, informationExtracted, { signal } = {}) {
    const resolved = await assets.resolve(ref, { signal });
    const info = Math.min(1, Math.max(0, Number(informationExtracted ?? 1)));
    const key = await hashBytes(new TextEncoder().encode(`${resolved.sha256}|${String(model)}|${info.toFixed(6)}`));
    const cache = localPath('vibe-cache', `${key}.bin`);
    let cached;
    try { cached = await nativeFiles.read(cache, { signal }); } catch { signal?.throwIfAborted(); }
    return { resolved, info, cache, cached };
  }
  async function vibeAccount(id) {
    if (!id) throw Object.assign(new Error('中转的 Vibe 参考图首次编码需要官网 Token。请在设置中添加并选择 Vibe 编码账号。'), { status: 400 });
    return providers.generationProvider('official', id);
  }
  return { ...assets, resolveImageRef: assets.resolve,
    async prepareVibeGeneration(state) {
      if (isOfficialProvider(state.provider) || state.referenceControl?.mode !== 'vibe') return;
      let missing = 0;
      for (const item of state.referenceControl.vibes) {
        if (!(await vibeInput(item.image, state.model, item.informationExtracted)).cached?.length) missing++;
      }
      if (!missing) return;
      const account = await vibeAccount(state.officialAccountId);
      if (!(await confirmAction(`有 ${missing} 张 Vibe 参考图需要由官网账号「${account.accountName}」编码，参考图会发送给 NovelAI，并可能消耗该账号的额度。图片生成仍使用所选中转。`, { title: '需要编码 Vibe 参考图', confirmLabel: '编码并生成' }))) {
        throw Object.assign(new Error('已取消 Vibe 编码，未加入队列。'), { status: 409 });
      }
    },
    async base64ForRef(ref, options) { return (await assets.resolve(ref, options)).buffer.toString('base64'); },
    async preciseReferenceBase64(ref, { signal } = {}) {
      const resolved = await assets.resolve(ref, { signal });
      const ratio = resolved.row.width / resolved.row.height || 1;
      const target = ratio < 0.84 ? [1024, 1536] : ratio > 1.19 ? [1536, 1024] : [1472, 1472];
      const bytes = await nativeImages.precise(resolved.filePath, target); signal?.throwIfAborted(); return bytes.toString('base64');
    },
    async encodeVibeReference(ref, model, informationExtracted, token, { signal, officialAccountId } = {}) {
      const { resolved, info, cache, cached } = await vibeInput(ref, model, informationExtracted, { signal });
      if (cached?.length) return cached.toString('base64');
      const encodingToken = token || (await vibeAccount(officialAccountId)).token;
      const timeout = AbortSignal.timeout(settings.naiTimeoutMs);
      const response = await http.fetch(settings.naiVibeApi, { method: 'POST',
        headers: { Authorization: `Bearer ${encodingToken}`, 'Content-Type': 'application/json', Accept: 'application/octet-stream', 'x-correlation-id': crypto.randomUUID().slice(0, 6) },
        body: JSON.stringify({ image: resolved.buffer.toString('base64'), information_extracted: info, model: String(model) }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
      if (!response.ok) throw Object.assign(new Error(`NovelAI Vibe Encode ${response.status}: ${(await response.text()).slice(0, 1500)}`), { status: response.status });
      const bytes = Buffer.from(await response.arrayBuffer()); if (!bytes.length) throw new Error('NovelAI Vibe Encode 返回为空。');
      await nativeFiles.write(cache, bytes).catch(() => {}); return bytes.toString('base64');
    }
  };
}
