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
import { createPhoneGallery } from './phone-gallery.js';
import { createArtistStorm, summarizeStorm } from '../../service/artist-storm.js';
import { identifyArtistTag } from '../../public/artist-index-v5.js';

// Storm (0.7.3): the website's batch building on the phone's queue; the last batch is remembered for 上一轮.
const LAST_STORM_KEY = 'artist_storm_last_batch';
const artistStorm = createArtistStorm({ isArtistTag: text => identifyArtistTag(text).recognized });

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
  // Album copy is a side effect of the native host only; service/ stays unchanged for the server.
  const phoneGallery = createPhoneGallery({ state, save: options => PocketNative.saveToGallery(options),
    locate: row => localPath('originals', row.original_name), log: control.appendJobLog,
    notify: message => window.dispatchEvent(new CustomEvent('nai-runtime-error', { detail: message })) });
  const saveImage = createGenerationArchive({ store: generationStore, ids,
    currentJobStatus: control.currentJobStatus, cancelledError: rawControl.cancelledError, appendJobLog: control.appendJobLog,
    files: { ...nativeFiles, async allocate(id, mime, now) {
      const date = new Date(now), rel = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      const originalName = `${rel}/${id}.${mime === 'image/webp' ? 'webp' : 'png'}`, thumbName = `${rel}/${id}.webp`, previewName = thumbName;
      return { originalName, thumbName, previewName, original: localPath('originals', originalName), thumbnail: localPath('thumbnails', thumbName), preview: localPath('previews', previewName) };
    } }, images: { ...nativeImages, thumbnail: (source, target) => nativeImages.preview(source, target, 520) },
    async afterSave(job) {
      const row = await serial(() => db.prepare('SELECT * FROM images WHERE job_id=?').get(job.id));
      if (!row) return;
      phoneGallery.schedule(job.id, row);
      await media.registerRows([row]);
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
  return { control, jobs, resources, state, kick, phoneGallery,
    async enqueue(raw, count) {
      const state = sanitizeGenerationState(raw);
      await assets.prepareVibeGeneration(state);
      const result = await enqueueBatch(state, count); kick(); return result;
    },
    async start() { await control.recoverOrphanedRunningJobs(); kick(); },
    // One fixed seed; only the editor's artist weights change (and one candidate artist in the 加画师 modes).
    // The phone's queue limit (settings.maxQueueSize) also bounds a Storm.
    async enqueueStorm(raw, options = {}) {
      await ensureResources();
      const generationState = sanitizeGenerationState(raw);
      await assets.prepareVibeGeneration(generationState);
      await providers.generationProvider(generationState.provider, generationState.officialAccountId);
      const numeric = Number(options.seed);
      const seed = Number.isInteger(numeric) && numeric >= 0 && numeric <= 4294967295 ? numeric : crypto.getRandomValues(new Uint32Array(1))[0];
      const { plan, count, jobs } = artistStorm.stormJobs(generationState, options, { maxSize: settings.maxQueueSize, seed });
      const batchId = ids.next(), now = Date.now();
      const rows = jobs.map((job, index) => ({ id: ids.next(), batchId, position: index + 1, json: JSON.stringify(job.state), seed, now }));
      await generationStore.enqueue(rows, settings.maxQueueSize, rawControl.appendJobLog);
      await state.set(LAST_STORM_KEY, batchId);
      kick();
      return { batchId, count: plan.count, requestedCount: count, seed, externalArtists: plan.externalArtists.length };
    },
    async recentStorm() {
      const batchId = await state.get(LAST_STORM_KEY, '');
      if (!batchId) return null;
      const rows = await serial(() => db.prepare('SELECT position,status,image_id,seed,created_at,request_json FROM jobs WHERE batch_id=? ORDER BY position').all(batchId));
      return summarizeStorm(batchId, rows.map(row => {
        let experiment = {}; try { experiment = JSON.parse(row.request_json).experiment || {}; } catch { /* unreadable row: no labels */ }
        return { position: row.position, status: row.status, image_id: row.image_id, seed: row.seed, created_at: row.created_at, experiment };
      }));
    }
  };
}
