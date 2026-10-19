import assert from 'node:assert/strict';
import { registerPlugin } from '@capacitor/core';

const calls = [], cancellations = [];
let reply = async () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('ok').toString('base64') });
registerPlugin('PocketNative', { web: () => ({
  request: async value => { calls.push(value); return reply(value); },
  cancelRequest: async value => { cancellations.push(value); }
}) });
const { nativeFetch } = await import('../src/http.js');

for (const consent of [undefined, false, 'true', true]) {
  const response = await nativeFetch('http://relay.example/api/generate-image', {
    method: 'POST', headers: { Authorization: 'Bearer test-only-key' }, body: 'prompt',
    ...(consent === undefined ? {} : { allowInsecureHttp: consent })
  });
  assert.equal(await response.text(), 'ok');
  const request = calls.at(-1);
  assert.equal(request.allowInsecureHttp, consent === true, 'only boolean true opts into HTTP');
  assert.equal(Buffer.from(request.body, 'base64').toString(), 'prompt');
  assert.equal(request.headers.authorization, 'Bearer test-only-key');
}
await nativeFetch('https://relay.example/api/generate-image');
assert.equal(calls.at(-1).allowInsecureHttp, false);

reply = async () => ({ status: 302, headers: { location: 'http://other.example/' }, body: '' });
await assert.rejects(nativeFetch('http://relay.example/generate', { allowInsecureHttp: true, redirect: 'error' }), /Redirect refused/);
assert.equal(calls.length, 6, 'a redirect never triggers a second bridge request');

const earlyAbort = new AbortController(); earlyAbort.abort();
await assert.rejects(nativeFetch('https://relay.example/generate', { signal: earlyAbort.signal }), { name: 'AbortError' });
assert.equal(calls.length, 6);
const activeAbort = new AbortController();
let finish;
reply = () => new Promise(resolve => { finish = resolve; });
const pending = nativeFetch('http://relay.example/generate', { allowInsecureHttp: true, signal: activeAbort.signal });
while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
activeAbort.abort();
finish({ status: 200, headers: {}, body: '' });
await assert.rejects(pending, { name: 'AbortError' });
assert.equal(cancellations.at(-1).id, calls.at(-1).id);
assert.equal(calls.length, 7, 'cancellation is not retried');
console.log('PASS native HTTP adapter: explicit consent, body/headers, redirect refusal, cancellation; no network used.');
