import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueueWorker } from '../service/queue-worker.js';
import { createQueueControl } from '../service/queue-control.js';

function fixture(overrides = {}) {
  let status = 'pending'; const effects = []; const controllers = new Map();
  const policy = createQueueControl({ settings: {}, activeJobControllers: controllers });
  const ports = {
    settings: { naiTimeoutMs: 1000, maxRetries: 2, rateLimitRetries: 3 }, activeJobControllers: controllers,
    store: { async claim() { status = 'running'; return 1; }, async pending() { status = 'pending'; effects.push('retry'); }, async fail() { status = 'failed'; } },
    clock: { now: () => 123 }, sleep: async () => {}, appendJobLog: async (...args) => effects.push(args[2]),
    providerLabel: () => 'mock', ensureResources: async () => {}, currentJobStatus: async () => status,
    cancelledError: policy.cancelledError, retryable: policy.retryable, isV5State: () => false,
    generateImage: async () => ({ buffer: new Uint8Array([1]) }), saveImage: async () => { status = 'completed'; },
    rateLimitDelayMs: () => 1000, setAppState: async () => effects.push('cooldown'), pauseForAccountError: async () => effects.push('pause'),
    ...overrides
  };
  return { worker: createQueueWorker(ports), ports, effects, controllers, status: () => status, cancel: () => { status = 'cancelled'; } };
}
const job = () => ({ id: 'job', attempts: 0, seed: 1, request_json: '{"provider":"official"}' });
test('received image never retries local save failures, including a 429-shaped error', async () => {
  for (const status of [0, 429, 500]) {
    let calls = 0;
    const f = fixture({ generateImage: async () => { calls++; return {}; }, saveImage: async () => { throw Object.assign(new Error('local save failed'), { status }); } });
    await f.worker.processOne(job());
    assert.equal(calls, 1); assert.equal(f.status(), 'failed'); assert.ok(!f.effects.includes('retry')); assert.equal(f.controllers.size, 0);
  }
});
test('upstream rate limit requeues once and records cooldown', async () => {
  const f = fixture({ generateImage: async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); } });
  await f.worker.processOne(job()); assert.equal(f.status(), 'pending'); assert.ok(f.effects.includes('cooldown')); assert.equal(f.controllers.size, 0);
});
test('successful generation response never resubmits after wrapper or download failures', async () => {
  for (const status of [0, 429, 502]) {
    let calls = 0;
    const f = fixture({ generateImage: async () => { calls++; throw Object.assign(new Error('response decode failed'), { status, generationResponseReceived: true }); } });
    await f.worker.processOne(job());
    assert.equal(calls, 1); assert.equal(f.status(), 'failed');
    assert.ok(!f.effects.includes('retry')); assert.ok(!f.effects.includes('cooldown'));
    assert.equal(f.controllers.size, 0);
  }
});
test('cancel during response prevents saving', async () => {
  let saved = false; const f = fixture({ generateImage: async () => { f.cancel(); return {}; }, saveImage: async () => { saved = true; } });
  await f.worker.processOne(job()); assert.equal(saved, false); assert.equal(f.status(), 'cancelled'); assert.equal(f.controllers.size, 0);
});
test('failed async claim releases the active controller', async () => {
  const f = fixture({ store: { claim: async () => { throw new Error('database unavailable'); } } });
  await assert.rejects(f.worker.processOne(job()), /database unavailable/); assert.equal(f.controllers.size, 0);
});
