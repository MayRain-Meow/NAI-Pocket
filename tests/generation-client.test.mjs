import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createGenerationClient } from '../service/generation.js';
import { sanitizeGenerationState } from '../public/generation-payload.js';
import { createQueueControl } from '../service/queue-control.js';

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

const relayRequests = [], relayEvents = [];
let relayReply = () => new Response('not an image', { status: 200 });
const relay = createGenerationClient({
  settings: { naiTimeoutMs: 2000 }, assets: {}, binary: Buffer, inflateRaw: zlib.inflateRawSync,
  ids: { request: () => 'test01' },
  generationProvider: async () => ({ id: 'relay:fixture', label: '测试中转', token: 'fixture-key-unused',
    apiUrl: 'http://fixture.invalid/image/chami', allowInsecureHttp: true }),
  http: { async fetch(url, init) { relayRequests.push({ url, ...init }); return relayReply(url); } }
});
const queue = createQueueControl({ settings: {} });
await assert.rejects(relay.generateImage(state, 42), error =>
  error.generationResponseReceived === true && !error.imageReceived && !queue.retryable(error));
assert.equal(relayRequests.length, 1, 'unrecognized successful response never probes another endpoint');
relayReply = () => Response.json({ error: { message: '触发NAI远程API错误，附带码: 400' } }, { status: 502 });
await assert.rejects(relay.generateImage(state, 42, { onEvent: event => relayEvents.push(event) }), error =>
  error.status === 400 && error.gatewayStatus === 502 && !error.generationResponseReceived && !queue.retryable(error));
assert.equal(relayEvents.find(e => e.phase === 'response-error').detail.upstreamStatus, 400);
assert.ok(!JSON.stringify(relayEvents).includes('fixture-key-unused'));
relayReply = url => url.includes('fixture.invalid')
  ? Response.json({ url: 'http://cdn.invalid/generated.png' }) : new Response(image);
relayRequests.length = 0;
const relayImage = await relay.generateImage(state, 42);
assert.deepEqual(relayImage.buffer, image);
assert.deepEqual(relayRequests.map(r => [r.method, r.url, r.allowInsecureHttp]), [
  ['POST', 'http://fixture.invalid/image/chami', true], ['GET', 'http://cdn.invalid/generated.png', true]
]);
assert.equal(relayRequests[0].headers.Authorization, 'Bearer fixture-key-unused');
assert.equal(relayRequests[1].headers, undefined, 'the generated-image host never receives the relay token');
relayReply = url => url.includes('fixture.invalid')
  ? Response.json({ url: 'https://cdn.invalid/generated.png' }) : new Response('missing', { status: 404 });
await assert.rejects(relay.generateImage(state, 42), error => error.generationResponseReceived === true && !queue.retryable(error));
console.log('shared relay: explicit HTTP, exact endpoint, credential-free download, wrapped errors and 2xx retry guard passed');
