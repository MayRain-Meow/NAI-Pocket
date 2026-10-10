import { redactPersistedApiPayload } from '../public/persistence-utils.js';


export function createGenerationArchive({ store, files, images, ids, clock = { now: () => Date.now() }, currentJobStatus, cancelledError, appendJobLog, shrink = async () => {}, afterSave = async () => {} }) {
  return async function saveImage(job, state, result) {
    if (await currentJobStatus(job.id) === 'cancelled') throw cancelledError();
    const id = ids.next();
    const allocated = await files.allocate(id, result.mime, clock.now());
    const { original, thumbnail, preview, originalName, thumbName, previewName } = allocated;
    const clean = () => Promise.all([original, thumbnail, preview].map(file => files.remove(file)));
    await appendJobLog(job.id, 'info', 'saving', `已收到图片，正在保存原图 · ${Math.round(result.buffer.length / 1024)} KB`);
    await files.write(original, result.buffer);
    let metadata = { width: state.params.width, height: state.params.height };
    try {
      const dimensions = await images.dimensions(original);
      if (Number.isFinite(dimensions.width) && Number.isFinite(dimensions.height)) metadata = dimensions;
      await shrink(job, state, original, result.mime);
      await appendJobLog(job.id, 'info', 'thumbnail', '正在生成图库缩略图。');
      await images.thumbnail(original, thumbnail);
      await appendJobLog(job.id, 'info', 'preview', '正在生成流畅预览图。');
      await images.preview(original, preview);
    } catch (error) {
      await clean(); throw new Error(`图片预览处理失败: ${error.message}`);
    }
    if (await currentJobStatus(job.id) === 'cancelled') { await clean(); throw cancelledError(); }
    let saved = false;
    try {
      const [originalStat, thumbStat, previewStat] = await Promise.all([original, thumbnail, preview].map(file => files.stat(file)));
      const now = clock.now();
      saved = await store.saveImage({ id, jobId: job.id, now, values: [
        id, job.id, job.batch_id, originalName, thumbName, previewName, result.mime,
        metadata.width || state.params.width, metadata.height || state.params.height,
        originalStat.size, thumbStat.size, previewStat.size, state.previewPrompt || state.prompt, state.negativePrompt,
        JSON.stringify({ ...state, apiPayload: redactPersistedApiPayload(result.payload, state) }), result.seed, now,
        state.experiment?.type === 'artist-rotation' ? 'rotation' : 'gallery'
      ] });
    } finally { if (!saved) await clean(); }
    if (saved) {
      await appendJobLog(job.id, 'info', 'completed', `图片已保存到图库 · ${metadata.width || state.params.width}×${metadata.height || state.params.height}`);
      await afterSave(job, state);
    }
    return saved;
  };
}

export function createBatchEnqueuer({ store, settings, ids, clock = { now: () => Date.now() }, ensureResources, sanitizeGenerationState, generationProvider, chooseSeed, appendJobLog }) {
  return async function enqueueBatch(rawState, count) {
    if (!Number.isInteger(count) || count < 1 || count > settings.maxBatchSize) throw new Error(`每批数量必须在 1–${settings.maxBatchSize} 之间。`);
    await ensureResources();
    const state = sanitizeGenerationState(rawState);
    await generationProvider(state.provider, state.officialAccountId);
    if (state.imageTool?.type && state.imageTool.type !== 'none' && state.provider !== 'official') throw new Error('NovelAI 官方图片工具不支持 RBQ 中转，请切换到官网 Token。');
    const batchId = ids.next(), now = clock.now(), json = JSON.stringify(state);
    const rows = Array.from({ length: count }, (_, index) => ({ id: ids.next(), batchId, position: index + 1, json, seed: chooseSeed(state, index), now }));
    await store.enqueue(rows, settings.maxQueueSize, appendJobLog);
    return { batchId, count };
  };
}
