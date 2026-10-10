import { createQueueControl } from '../../service/queue-control.js';
import { createQueueWorker } from '../../service/queue-worker.js';
import { createQueueWorkerStore } from '../../service/storage/queue-worker.js';
import { createGenerationStore } from '../../service/storage/generation.js';
import { createGenerationArchive, createBatchEnqueuer } from '../../service/generation-archive.js';
import { createJobsService } from '../../service/jobs.js';
import { createJobsStore } from '../../service/storage/jobs.js';
import { sanitizeGenerationState } from '../../public/generation-payload.js';
import { isV5GenerationModel } from '../../public/model-utils.js';
import * as cursors from '../../public/gallery-utils.js';
import { nativeFiles, nativeImages, localPath } from './files.js';
import { PocketNative } from './providers.js';
import { createQueueRunner } from './queue-runner.js';

export function openQueue(database, settings, providers, client, media, assets) {
  const { db, serial, transaction } = database, activeJobControllers = new Map();
  const rawState = {
    async get(key, fallback = '') { return (await db.prepare('SELECT value FROM app_state WHERE key=?').get(key))?.value ?? fallback; },
    set: (key, value) => db.prepare('INSERT INTO app_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value))
  };
  const state = { get: (...args) => serial(() => rawState.get(...args)), set: (...args) => serial(() => rawState.set(...args)) };
  const rawControl = createQueueControl({ db, transaction, settings, getAppState: rawState.get, setAppState: rawState.set,
    generationProvider: providers.generationProvider, activeJobControllers, isV5GenerationModel,
    randomSeed: () => crypto.getRandomValues(new Uint32Array(1))[0] });
  const control = database.store(rawControl);
  async function resources() {
    const disk = await PocketNative.diskStatus();
    const row = await serial(() => db.prepare('SELECT COALESCE(SUM(bytes+thumb_bytes+preview_bytes),0) AS total FROM images').get());
    return { ...disk, galleryBytes: Number(row.total), minFreeDiskBytes: settings.minFreeDiskBytes };
  }
  async function ensureResources() {
    const disk = await PocketNative.diskStatus();
    if (disk.freeBytes < settings.minFreeDiskBytes) throw new Error('本机剩余空间低于 256 MB，请先清理空间。');
  }
  const generationStore = database.store(createGenerationStore(db, transaction));
  const ids = { next: () => crypto.randomUUID() };
  const saveImage = createGenerationArchive({ store: generationStore, ids,
    currentJobStatus: control.currentJobStatus, cancelledError: rawControl.cancelledError, appendJobLog: control.appendJobLog,
    files: { ...nativeFiles, async allocate(id, mime, now) {
      const date = new Date(now), rel = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      const originalName = `${rel}/${id}.${mime === 'image/webp' ? 'webp' : 'png'}`, thumbName = `${rel}/${id}.webp`, previewName = thumbName;
      return { originalName, thumbName, previewName, original: localPath('originals', originalName), thumbnail: localPath('thumbnails', thumbName), preview: localPath('previews', previewName) };
    } }, images: { ...nativeImages, thumbnail: (source, target) => nativeImages.preview(source, target, 520) },
    async afterSave(job) {
      const row = await serial(() => db.prepare('SELECT * FROM images WHERE job_id=?').get(job.id));
      if (row) await media.registerRows([row]);
    }
  });
  const worker = createQueueWorker({ store: database.store(createQueueWorkerStore(db)), settings, activeJobControllers,
    appendJobLog: control.appendJobLog, providerLabel: rawControl.providerLabel, ensureResources, currentJobStatus: control.currentJobStatus,
    cancelledError: rawControl.cancelledError, isV5State: rawControl.isV5State,
    async safeSubscriptionSnapshot(jobId, label, generationState) {
      try { return await client.getSubscriptionStatus({ signal: AbortSignal.timeout(5000), officialAccountId: generationState.officialAccountId }); }
      catch (error) { await control.appendJobLog(jobId, 'warn', 'billing-status', `${label}账户额度读取失败；不影响本次生成。`, { status: Number(error.status || 0) }); return null; }
    }, generateImage: client.generateImage, calculateUsageDelta: client.calculateUsageDelta, billingMessage: rawControl.billingMessage,
    saveImage, rateLimitDelayMs: rawControl.rateLimitDelayMs, setAppState: state.set, retryable: rawControl.retryable, pauseForAccountError: control.pauseForAccountError
  });
  const enqueueBatch = createBatchEnqueuer({ store: generationStore, settings, ids, ensureResources, sanitizeGenerationState,
    generationProvider: providers.generationProvider, chooseSeed: rawControl.chooseSeed, appendJobLog: rawControl.appendJobLog });
  const jobs = createJobsService({ store: database.store(createJobsStore(db)), cursors: { ...cursors, completionLimit: 100 }, state,
    queue: { isPaused: control.isQueuePaused, pauseReason: control.queuePauseReason } });
  const runner = createQueueRunner({ control,
    nextJob: () => serial(() => db.prepare("SELECT * FROM jobs WHERE status='pending' ORDER BY created_at,position LIMIT 1").get()),
    processOne: worker.processOne,
    clearCooldown: () => state.set('queue_rate_limit_until', '0'),
    setActive: active => PocketNative.queueActive({ active }),
    async onError(error) {
      // Pause before releasing the runner; never automatically resubmit an
      // uncertain request after an unexpected adapter failure.
      try { await control.setQueuePaused(true); }
      finally { window.dispatchEvent(new CustomEvent('nai-runtime-error', { detail: error.message })); }
    }
  });
  function kick() { runner.kick().catch(() => {}); }
  return { control, jobs, resources, state, kick,
    async enqueue(raw, count) {
      const state = sanitizeGenerationState(raw);
      await assets.prepareVibeGeneration(state);
      const result = await enqueueBatch(state, count); kick(); return result;
    },
    async start() { await control.recoverOrphanedRunningJobs(); kick(); }
  };
}
