import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneGallery, phoneGalleryName, PHONE_GALLERY_KEY } from '../src/phone-gallery.js';
import { createGenerationArchive } from '../../service/generation-archive.js';
import { createQueueWorker } from '../../service/queue-worker.js';

const created = Date.UTC(2026, 9, 10, 8, 30, 15, 123);
const row = (mime = 'image/png') => ({ id: 'img-1', job_id: 'job-1', original_name: `2026/10/img-1.${mime === 'image/webp' ? 'webp' : 'png'}`, mime, created_at: created });

function memoryState(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, async get(key, fallback = '') { return values.has(key) ? values.get(key) : fallback; }, async set(key, value) { values.set(key, String(value)); } };
}

function gallery({ state = memoryState(), save } = {}) {
  const calls = [], logs = [], toasts = [];
  const phone = createPhoneGallery({ state, locate: item => `originals/${item.original_name}`,
    save: save || (async options => { calls.push(options); return { saved: true }; }),
    async log(jobId, level, phase, message) { logs.push({ jobId, level, phase, message }); },
    notify: message => toasts.push(message) });
  return { phone, state, calls, logs, toasts };
}

test('album copy is on by default and copies the original path with the download name', async () => {
  const h = gallery();
  assert.equal(await h.phone.enabled(), true);
  assert.equal(h.state.values.has(PHONE_GALLERY_KEY), false, 'default needs no stored value');
  const result = await h.phone.copy('job-1', row());
  assert.equal(result.saved, true);
  assert.deepEqual(h.calls, [{ path: 'originals/2026/10/img-1.png', mime: 'image/png', name: 'nai-2026-10-10T08-30-15-123Z.png' }]);
  assert.equal(phoneGalleryName(row('image/webp')), 'nai-2026-10-10T08-30-15-123Z.webp', 'WebP keeps its own extension (no re-encode)');
  assert.ok(h.logs.some(entry => entry.level === 'info' && entry.phase === 'phone-gallery'));
  assert.deepEqual(h.toasts, []);
});

test('turning the switch off skips the copy and persists in the native state store', async () => {
  const h = gallery();
  assert.equal(await h.phone.setEnabled(false), false);
  assert.equal(h.state.values.get(PHONE_GALLERY_KEY), '0');
  assert.deepEqual(await h.phone.copy('job-1', row()), { saved: false, skipped: true });
  assert.equal(h.calls.length, 0);
  // A new session reading the same store stays off; turning it on again copies.
  const reopened = gallery({ state: h.state });
  assert.equal(await reopened.phone.enabled(), false);
  await reopened.phone.setEnabled(true);
  assert.equal((await reopened.phone.copy('job-1', row())).saved, true);
});

test('native failures and permission refusals are reported, never thrown, with one toast per kind', async () => {
  let mode = 'throw';
  const h = gallery({ save: async () => {
    if (mode === 'throw') throw new Error('Synthetic MediaStore failure');
    return { saved: false, reason: 'permission-denied' };
  } });
  assert.deepEqual(await h.phone.copy('job-1', row()), { saved: false, reason: 'error' });
  assert.deepEqual(await h.phone.copy('job-2', row()), { saved: false, reason: 'error' });
  mode = 'denied';
  assert.deepEqual(await h.phone.copy('job-3', row()), { saved: false, reason: 'permission-denied' });
  assert.equal(h.logs.filter(entry => entry.level === 'warn').length, 3, 'every affected job gets a log line');
  assert.equal(h.toasts.length, 2, 'one toast for the failure kind, one for the permission kind');
  assert.match(h.toasts[0], /Synthetic MediaStore failure/);
  // Even a broken state store or logger cannot escape.
  const broken = createPhoneGallery({ state: { async get() { throw new Error('db gone'); } }, locate: () => 'x', save: async () => ({ saved: true }),
    async log() { throw new Error('log gone'); }, notify() { throw new Error('toast gone'); } });
  assert.deepEqual(await broken.copy('job-4', row()), { saved: false, reason: 'error' });
});

// Mirrors the native wiring in app/src/queue.js: the archive's afterSave schedules the copy.
function workerHarness(save) {
  const job = { id: 'job-1', batch_id: 'batch-1', attempts: 0, seed: 7, status: 'pending', request_json: JSON.stringify({ provider: 'rbq', model: 'nai-diffusion-4-5-full', params: { width: 64, height: 64 } }) };
  const rows = new Map(), logs = [], files = new Map(), outcome = { failed: 0, pending: 0 }, scheduled = [];
  const h = gallery({ save });
  const saveImage = createGenerationArchive({
    store: { async saveImage(record) { if (job.status !== 'running') return false; rows.set(record.jobId, { id: record.id, original_name: '2026/10/a.png', mime: 'image/png', created_at: record.now }); job.status = 'completed'; return true; } },
    files: {
      async allocate(id) { return { originalName: `2026/10/${id}.png`, thumbName: `2026/10/${id}.webp`, previewName: `2026/10/${id}.webp`, original: `originals/${id}`, thumbnail: `thumbnails/${id}`, preview: `previews/${id}` }; },
      async write(file, bytes) { files.set(file, bytes); }, async remove(file) { files.delete(file); }, async stat() { return { isFile: true, size: 1 }; }
    },
    images: { async dimensions() { return { width: 64, height: 64 }; }, async thumbnail() {}, async preview() {} },
    ids: { next: () => 'image-1' },
    currentJobStatus: async () => job.status,
    cancelledError: () => Object.assign(new Error('Cancelled'), { code: 'JOB_CANCELLED' }),
    async appendJobLog(id, level, phase, message) { logs.push({ id, level, phase, message }); },
    async afterSave(saved) { const item = rows.get(saved.id); if (item) scheduled.push(h.phone.schedule(saved.id, item)); }
  });
  const worker = createQueueWorker({
    store: { async claim() { job.status = 'running'; return 1; }, async pending() { outcome.pending++; job.status = 'pending'; }, async fail() { outcome.failed++; job.status = 'failed'; } },
    settings: { naiTimeoutMs: 1000, rateLimitRetries: 2, maxRetries: 2 },
    async appendJobLog(id, level, phase, message) { logs.push({ id, level, phase, message }); },
    providerLabel: () => 'Synthetic RBQ', async ensureResources() {}, currentJobStatus: async () => job.status,
    cancelledError: () => Object.assign(new Error('Cancelled'), { code: 'JOB_CANCELLED' }), isV5State: () => false,
    async safeSubscriptionSnapshot() { return null; }, async generateImage() { return { buffer: Buffer.from([1, 2, 3]), mime: 'image/png', seed: 7, payload: {} }; },
    calculateUsageDelta: () => null, billingMessage: () => '', saveImage, rateLimitDelayMs: () => 0, async setAppState() {},
    retryable: () => true, async pauseForAccountError() { assert.fail('no account error'); }
  });
  return { job, logs, outcome, scheduled, worker, h };
}

test('a failing album copy never fails or retries the paid, already saved job', async () => {
  const w = workerHarness(async () => { throw new Error('Synthetic album write failure'); });
  await w.worker.processOne(w.job);
  assert.equal(w.job.status, 'completed');
  assert.deepEqual(w.outcome, { failed: 0, pending: 0 }, 'no failure and no retry');
  assert.equal(w.scheduled.length, 1);
  assert.deepEqual(await w.scheduled[0], { saved: false, reason: 'error' });
  assert.ok(w.h.logs.some(entry => entry.phase === 'phone-gallery' && entry.level === 'warn' && /Synthetic album write failure/.test(entry.message)));
  assert.equal(w.h.toasts.length, 1);
});

test('a copy waiting on a permission prompt does not hold the queue', async () => {
  let release;
  const w = workerHarness(() => new Promise(resolve => { release = resolve; }));
  await w.worker.processOne(w.job);
  assert.equal(w.job.status, 'completed', 'job completes while the album copy is still pending');
  release({ saved: true });
  assert.equal((await w.scheduled[0]).saved, true);
});

test('switch off: the queue completes and nothing is copied', async () => {
  let calls = 0;
  const w = workerHarness(async () => { calls++; return { saved: true }; });
  await w.h.phone.setEnabled(false);
  await w.worker.processOne(w.job);
  assert.equal(w.job.status, 'completed');
  assert.deepEqual(await w.scheduled[0], { saved: false, skipped: true });
  assert.equal(calls, 0);
});
