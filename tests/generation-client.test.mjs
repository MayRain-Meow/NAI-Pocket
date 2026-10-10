import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createGenerationClient } from '../service/generation.js';
import { sanitizeGenerationState } from '../public/generation-payload.js';

const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let requests = 0, mode = 'image';
const client = createGenerationClient({
  settings: { naiTimeoutMs: 2000 }, assets: {}, binary: Buffer, inflateRaw: zlib.inflateRawSync,
  ids: { request: () => 'test00' },
  generationProvider: async () => ({ id: 'official', label: 'test', token: 'pst-test-unused', apiUrl: 'https://fixture.invalid/generate' }),
  http: { async fetch(url, options) {
    requests++;
    assert.equal(url, 'https://fixture.invalid/generate');
    const payload = JSON.parse(options.body);
    assert.equal(payload.parameters.seed, 42);
    if (mode === 'rate') return new Response('fixture limit', { status: 429, headers: { 'retry-after': '4' } });
    return Response.json({ images: [{ image: image.toString('base64'), seed: 42 }] });
  } }
});
const state = sanitizeGenerationState({ prompt: '1girl', model: 'nai-diffusion-5-full', params: { width: 832, height: 1216, steps: 28 } });
const output = await client.generateImage(state, 42);
assert.deepEqual(output.buffer, image);
assert.equal(output.effectiveState, state);
mode = 'rate';
await assert.rejects(client.generateImage(state, 42), error => error.status === 429 && error.retryAfterMs === 4000);
const cancelled = new AbortController(); cancelled.abort();
await assert.rejects(client.generateImage(state, 42, { signal: cancelled.signal }), error => error.code === 'JOB_CANCELLED');
assert.equal(requests, 2, 'cancelled generation never dispatches');
console.log('shared generation: async provider, JSON image, rate-limit and cancellation passed without upstream calls');
