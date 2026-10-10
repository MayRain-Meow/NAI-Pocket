import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueueRunner } from '../src/queue-runner.js';
import { createLocalApi } from '../src/api.js';
import { createQueueWorker } from '../../service/queue-worker.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function within(promise, milliseconds = 1500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Queue operation did not settle')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function harness() {
  const state = { paused: false, cooldown: 0, background: false, active: false };
  const jobs = [], activity = [], errors = [], processed = [];
  const cooling = deferred();
  const ports = {
    control: {
      async isQueuePaused() { return state.paused; },
      async queueCooldownUntil() {
        if (state.cooldown > Date.now()) cooling.resolve();
        return state.cooldown;
      }
    },
    async nextJob() { const job = jobs.find(row => row.status === 'pending'); return job ? { ...job } : undefined; },
    async processOne(job) { processed.push(job.id); jobs.find(row => row.id === job.id).status = 'completed'; },
    async clearCooldown() { state.cooldown = 0; },
    async setActive(active) {
      if (active && !state.active && state.background) throw new Error('Synthetic Android background foreground-service start refused');
      activity.push(active); state.active = active;
    },
    async onError(error) { errors.push(error); state.paused = true; }
  };
  function add(id) { const row = { id, status: 'pending', attempts: 0, seed: 42, request_json: JSON.stringify({ provider: 'rbq', model: 'nai-diffusion-4-5-full' }) }; jobs.push(row); return row; }
  return { state, jobs, activity, errors, processed, cooling, ports, add };
}

test('actual shared 429 worker retains the foreground service through background cooldown and completion', async () => {
  const h = harness(), row = h.add('limited');
  const logs = [], controllers = new Map();
  let generationCalls = 0, saves = 0;
  const worker = createQueueWorker({
    store: {
      async claim(id, attempts) {
        assert.equal(id, row.id);
        if (row.status !== 'pending') return 0;
        row.status = 'running'; row.attempts = attempts; return 1;
      },
      async pending(id, message, rateLimited) {
        assert.equal(id, row.id); assert.equal(rateLimited, true);
        row.status = 'pending'; row.error = message;
      },
      async fail(id, message) { assert.equal(id, row.id); row.status = 'failed'; row.error = message; }
    },
    settings: { naiTimeoutMs: 1000, rateLimitRetries: 2, maxRetries: 0 },
    activeJobControllers: controllers,
    async appendJobLog(id, level, phase) { logs.push({ id, level, phase }); },
    providerLabel: () => 'Synthetic RBQ',
    async ensureResources() {},
    async currentJobStatus() { return row.status; },
    cancelledError: () => Object.assign(new Error('Cancelled'), { code: 'JOB_CANCELLED' }),
    isV5State: () => false,
    async safeSubscriptionSnapshot() { assert.fail('RBQ generation does not query official billing'); },
    async generateImage() {
      generationCalls++;
      assert.equal(h.state.active, true, 'native foreground service is active before each request');
      if (generationCalls === 1) {
        h.state.background = true;
        throw Object.assign(new Error('Synthetic rate limit'), { status: 429 });
      }
      assert.equal(h.state.background, true, 'retry happens after the user left the foreground');
      return { buffer: new Uint8Array([1]) };
    },
    calculateUsageDelta: () => null,
    billingMessage: () => '',
    async saveImage() { saves++; row.status = 'completed'; },
    rateLimitDelayMs: () => 35,
    async setAppState(key, value) { assert.equal(key, 'queue_rate_limit_until'); h.state.cooldown = Number(value); },
    retryable: () => false,
    async pauseForAccountError() { assert.fail('429 is a cooldown, not an account rejection'); }
  });
  const runner = createQueueRunner({ ...h.ports, processOne: worker.processOne });
  await within(runner.kick());
  assert.equal(row.status, 'completed');
  assert.equal(row.attempts, 2);
  assert.equal(generationCalls, 2);
  assert.equal(saves, 1);
  assert.equal(controllers.size, 0);
  assert.ok(logs.some(event => event.phase === 'retry-wait'));
  assert.deepEqual(h.errors, []);
  assert.ok(h.activity[0]);
  assert.equal(h.activity.at(-1), false);
  assert.equal(h.activity.filter(active => !active).length, 1, 'service stops only after final completion, never during the cooldown');
});

for (const action of ['pause', 'cancel']) {
  test(`${action} during cooldown wakes the runner, releases the service, and submits nothing else`, async () => {
    const h = harness(), row = h.add(action);
    let calls = 0;
    const runner = createQueueRunner({ ...h.ports, async processOne() {
      calls++; h.state.cooldown = Date.now() + 1000;
    } });
    const draining = runner.kick();
    await within(h.cooling.promise);
    assert.equal(h.state.active, true);
    if (action === 'pause') h.state.paused = true;
    else row.status = 'cancelled';
    const wake = runner.kick();
    await within(Promise.all([draining, wake]), 500);
    assert.equal(calls, 1, 'wake checks pending/paused state without submitting again');
    assert.equal(h.state.active, false);
    assert.deepEqual(h.errors, []);
    assert.equal(h.activity.filter(active => !active).length, 1);
  });
}

test('repeated kicks share one serial worker and finish every pending job once', async () => {
  const h = harness();
  for (const id of ['one', 'two', 'three']) h.add(id);
  const entered = deferred(), release = deferred();
  let simultaneous = 0, maximum = 0;
  const runner = createQueueRunner({ ...h.ports, async processOne(job) {
    simultaneous++; maximum = Math.max(maximum, simultaneous);
    h.processed.push(job.id);
    if (job.id === 'one') { entered.resolve(); await release.promise; }
    h.jobs.find(row => row.id === job.id).status = 'completed';
    simultaneous--;
  } });
  const draining = runner.kick();
  await within(entered.promise);
  const wakes = Array.from({ length: 20 }, () => runner.kick());
  release.resolve();
  await within(Promise.all([draining, ...wakes]));
  assert.deepEqual(h.processed, ['one', 'two', 'three']);
  assert.equal(maximum, 1);
  assert.equal(h.jobs.filter(job => job.status === 'completed').length, 3);
  assert.equal(h.state.active, false);
  assert.deepEqual(h.errors, []);
});

test('a kick while native stop is awaiting completion does not lose newly enqueued work', async () => {
  const h = harness(); h.add('before-stop');
  const stopping = deferred(), allowStop = deferred();
  let stopCount = 0;
  const runner = createQueueRunner({ ...h.ports, async setActive(active) {
    await h.ports.setActive(active);
    if (!active && ++stopCount === 1) { stopping.resolve(); await allowStop.promise; }
  } });
  const draining = runner.kick();
  await within(stopping.promise);
  h.add('during-stop');
  const wake = runner.kick();
  allowStop.resolve();
  await within(Promise.all([draining, wake]));
  assert.deepEqual(h.processed, ['before-stop', 'during-stop']);
  assert.equal(h.jobs.filter(job => job.status === 'completed').length, 2);
  assert.equal(h.state.active, false);
  assert.deepEqual(h.errors, []);
});

test('unexpected adapter failure is reported and paused before another kick can resubmit', async () => {
  const h = harness(); h.add('adapter-error');
  const reporting = deferred(), allowPause = deferred();
  const failure = new Error('Synthetic archive adapter failure');
  let calls = 0;
  const runner = createQueueRunner({ ...h.ports,
    async processOne() { calls++; throw failure; },
    async onError(error) { reporting.resolve(); await allowPause.promise; await h.ports.onError(error); }
  });
  const draining = runner.kick();
  await within(reporting.promise);
  const wake = runner.kick();
  allowPause.resolve();
  await within(Promise.all([draining, wake]));
  await within(runner.kick());
  assert.deepEqual(h.errors, [failure]);
  assert.equal(h.state.paused, true);
  assert.equal(calls, 1, 'pending work is never silently resubmitted after an adapter failure');
  assert.equal(h.state.active, false);
  const stopped = h.activity.indexOf(false);
  assert.ok(stopped >= 0);
  assert.ok(h.activity.slice(stopped).every(active => !active), 'later kicks never start the service while the queue is paused');
});

const controlRoutes = [
  { path: '/api/jobs/pause', method: 'setQueuePaused', argument: true, result: undefined },
  { path: '/api/jobs/cancel-all', method: 'cancelQueuedJobs', argument: { scope: 'pending' }, result: { cancelled: 2 } },
  { path: '/api/jobs/job-1/cancel', method: 'cancelJob', argument: 'job-1', result: { ok: true, cancelled: 1 } },
  { path: '/api/batches/batch-1/cancel', method: 'cancelBatch', argument: 'batch-1', result: { ok: true, cancelled: 2 } }
];
const controlRequest = path => new Request(`https://localhost${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'pending' })
});

test('actual local API wakes cooldown only after each successful pause or cancellation completes', async () => {
  for (const route of controlRoutes) {
    const entered = deferred(), complete = deferred(), events = [];
    const api = createLocalApi({ database: {}, providers: {}, references: {}, queue: {
      control: { async [route.method](argument) {
        assert.deepEqual(argument, route.argument);
        events.push('mutation-start'); entered.resolve(); await complete.promise;
        events.push('mutation-end'); return route.result;
      } },
      kick() { events.push('kick'); }
    } });
    const response = api.fetch(controlRequest(route.path));
    await within(entered.promise);
    assert.deepEqual(events, ['mutation-start'], `${route.path} does not wake an uncommitted control change`);
    complete.resolve();
    assert.equal((await within(response)).status, 200, route.path);
    assert.deepEqual(events, ['mutation-start', 'mutation-end', 'kick'], route.path);
  }
});

test('actual local API does not kick when pause or cancellation fails', async () => {
  for (const route of controlRoutes) {
    let kicks = 0;
    const reportsFailure = ['cancelJob', 'cancelBatch'].includes(route.method);
    const api = createLocalApi({ database: {}, providers: {}, references: {}, queue: {
      control: { async [route.method]() {
        if (reportsFailure) return { ok: false, reason: 'Synthetic cancellation refused' };
        throw Object.assign(new Error('Synthetic control write failed'), { status: 503 });
      } },
      kick() { kicks++; }
    } });
    const response = await within(api.fetch(controlRequest(route.path)));
    assert.equal(response.status, reportsFailure ? 409 : 503, route.path);
    assert.equal(kicks, 0, route.path);
  }
});
