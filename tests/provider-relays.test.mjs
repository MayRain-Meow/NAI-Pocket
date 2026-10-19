// Third-party relays: the shared provider id rules and the provider service's relay storage.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeProviderId, isOfficialProvider, providerCapabilities } from '../public/provider-route.js';
import { createProviderService } from '../service/providers.js';

function service({ allowCustomRelays = true, store = new Map() } = {}) {
  let next = 0;
  const providers = createProviderService({
    settings: { rbqNaiImageApi: 'https://gnai.rbq.my/ai/generate-image', naiImageApi: 'https://image.novelai.net/ai/generate-image' },
    state: { get: (key, fallback) => (store.has(key) ? store.get(key) : fallback), set: (key, value) => store.set(key, value) },
    secrets: { encrypt: value => `enc:${value}`, decrypt: value => (value ? String(value).replace(/^enc:/, '') : '') },
    ids: { next: () => `relay-id-${String(++next).padStart(4, '0')}` },
    clock: { now: () => 1000 },
    allowCustomRelays
  });
  return { providers, store };
}

test('provider ids: rbq and relay ids survive, anything else is official', () => {
  assert.equal(normalizeProviderId('rbq'), 'rbq');
  assert.equal(normalizeProviderId('relay:relay-id-0001'), 'relay:relay-id-0001');
  for (const value of [undefined, '', 'official', 'RBQ', 'relay:', 'relay:x', 'relay:../../etc', 'other']) assert.equal(normalizeProviderId(value), 'official', String(value));
  assert.equal(isOfficialProvider('official'), true);
  assert.equal(isOfficialProvider('rbq'), false);
  assert.deepEqual(providerCapabilities('official'), { imageTools: true, vibeEncoding: true, anlasBilling: true });
  assert.deepEqual(providerCapabilities('relay:relay-id-0001'), { imageTools: false, vibeEncoding: false, anlasBilling: false });
  assert.deepEqual(providerCapabilities('rbq'), providerCapabilities('relay:relay-id-0001'), 'every relay has the RBQ capabilities');
});

test('a custom relay is saved, listed without its key, and routes generation', () => {
  const { providers, store } = service();
  const saved = providers.saveRelay({ name: '我的中转', apiUrl: 'https://relay.example.com/ai/generate-image#x', key: 'sk-relay-key-123456' });
  assert.equal(saved.providerId, 'relay:relay-id-0001');
  const listed = saved.providers.relays;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, '我的中转');
  assert.equal(listed[0].host, 'relay.example.com');
  assert.equal(listed[0].configured, true);
  assert.equal(listed[0].tokenHint, 'sk-r…3456');
  assert.equal(saved.providers.customRelays, true);
  assert.doesNotMatch(JSON.stringify(saved.providers), /sk-relay-key-123456/, 'the key never appears in the status');
  assert.match(store.get('provider_relays_v1'), /enc:sk-relay-key-123456/, 'the stored key goes through the secrets port');
  const route = providers.generationProvider('relay:relay-id-0001');
  assert.deepEqual(route, { id: 'relay:relay-id-0001', label: '中转 · 我的中转', apiUrl: 'https://relay.example.com/ai/generate-image', token: 'sk-relay-key-123456' });
});

test('updating keeps the key when none is given; deleting removes the route', () => {
  const { providers } = service();
  providers.saveRelay({ name: 'A', apiUrl: 'https://a.example.com/gen', key: 'first-key-123' });
  providers.saveRelay({ id: 'relay:relay-id-0001', name: 'B', apiUrl: 'https://b.example.com/gen', key: '' });
  let route = providers.generationProvider('relay:relay-id-0001');
  assert.equal(route.token, 'first-key-123');
  assert.equal(route.apiUrl, 'https://b.example.com/gen');
  providers.saveRelay({ id: 'relay:relay-id-0001', name: 'B', apiUrl: 'https://b.example.com/gen', key: 'second-key-456' });
  route = providers.generationProvider('relay:relay-id-0001');
  assert.equal(route.token, 'second-key-456');
  const status = providers.deleteRelay('relay:relay-id-0001');
  assert.deepEqual(status.relays, []);
  assert.throws(() => providers.generationProvider('relay:relay-id-0001'), error => error.status === 404);
});

test('relay addresses default to https without credentials; keys are checked', () => {
  const { providers } = service();
  for (const apiUrl of ['http://relay.example.com/gen', 'ftp://x/y', 'not a url', 'https://user:pw@relay.example.com/gen', `https://x.example.com/${'a'.repeat(600)}`]) {
    assert.throws(() => providers.saveRelay({ name: 'x', apiUrl, key: 'valid-key-123' }), error => error.status === 400, apiUrl);
  }
  for (const key of ['', 'short', 'has space inside', 'x'.repeat(501)]) {
    assert.throws(() => providers.saveRelay({ name: 'x', apiUrl: 'https://relay.example.com/gen', key }), error => error.status === 400, key);
  }
});

test('HTTP requires a strict boolean opt-in and rejected saves do not create records', () => {
  const { providers, store } = service();
  for (const allowInsecureHttp of [undefined, false, 'true', 'false', 1, 0, null, {}]) {
    assert.throws(() => providers.saveRelay({
      name: 'HTTP fixture', apiUrl: 'http://relay.example.com/image/custom', key: 'synthetic-key-123', allowInsecureHttp
    }), error => error.status === 400 && /HTTP/.test(error.message));
    assert.equal(store.has('provider_relays_v1'), false, 'a rejected save cannot persist consent or a key');
    assert.deepEqual(providers.providerStatus().relays, []);
  }
  for (const apiUrl of ['http://user:pass@relay.example.com/image/custom', 'ftp://relay.example.com/image/custom']) {
    assert.throws(() => providers.saveRelay({ name: 'invalid', apiUrl, key: 'synthetic-key-123', allowInsecureHttp: true }), error => error.status === 400);
  }
});

test('HTTP choice persists across provider reloads without rewriting the endpoint or exposing its key', () => {
  const { providers, store } = service();
  const apiUrl = 'http://relay.example.com:8080/image/custom//exact%2Fpath?model=v4.5&route=%2Fai%2Fgenerate-image';
  const key = 'synthetic-site-key+synthetic-internal-NAI-key';
  const saved = providers.saveRelay({ name: 'HTTP fixture', apiUrl: `  ${apiUrl}#local-fragment  `, key, allowInsecureHttp: true });
  const record = JSON.parse(store.get('provider_relays_v1'))[0];
  assert.equal(record.allowInsecureHttp, true);
  assert.equal(record.apiUrl, apiUrl);
  assert.equal(record.encryptedKey, `enc:${key}`);
  const reloaded = service({ store: new Map(store) }).providers;
  assert.deepEqual(reloaded.generationProvider(saved.providerId), {
    id: saved.providerId, label: '中转 · HTTP fixture', apiUrl, token: key, allowInsecureHttp: true
  });
  for (const status of [saved.providers, providers.providerStatus(), reloaded.providerStatus()]) {
    const listed = status.relays[0];
    assert.equal(listed.endpoint, apiUrl);
    assert.equal(listed.allowInsecureHttp, true);
    assert.equal(listed.host, 'relay.example.com:8080');
    assert.equal(listed.configured, true);
    assert.equal(JSON.stringify(status).includes(key), false);
    for (const field of ['key', 'token', 'encryptedKey']) assert.equal(Object.hasOwn(listed, field), false);
  }
});

test('editing HTTP keeps an empty key, rejects revoked HTTP atomically, and permits switching to HTTPS', () => {
  const { providers, store } = service();
  const apiUrl = 'http://relay.example.com/image/custom?version=4.5', key = 'synthetic-persisted-key-123';
  const { providerId } = providers.saveRelay({ name: 'Before', apiUrl, key, allowInsecureHttp: true });
  providers.saveRelay({ id: providerId, name: 'After', apiUrl, key: '', allowInsecureHttp: true });
  const beforeRejectedEdit = store.get('provider_relays_v1');
  assert.equal(providers.generationProvider(providerId).token, key);
  for (const allowInsecureHttp of [false, undefined, 'true']) {
    assert.throws(() => providers.saveRelay({ id: providerId, name: 'Rejected', apiUrl, key: 'uncommitted-replacement-key', allowInsecureHttp }), error => error.status === 400);
    assert.equal(store.get('provider_relays_v1'), beforeRejectedEdit, 'failed HTTP revocation must not partly change name, key, URL or consent');
  }
  const httpsUrl = apiUrl.replace('http:', 'https:');
  providers.saveRelay({ id: providerId, name: 'HTTPS', apiUrl: httpsUrl, key: '   ', allowInsecureHttp: false });
  const reloaded = service({ store: new Map(store) }).providers;
  assert.deepEqual(reloaded.generationProvider(providerId), { id: providerId, label: '中转 · HTTPS', apiUrl: httpsUrl, token: key });
  assert.equal(reloaded.providerStatus().relays[0].allowInsecureHttp, false);
  assert.equal(JSON.parse(store.get('provider_relays_v1'))[0].allowInsecureHttp, false);
  assert.equal(JSON.stringify(reloaded.providerStatus()).includes(key), false);
  assert.throws(() => reloaded.saveRelay({ id: providerId, name: 'No implicit consent', apiUrl, key: '' }), error => error.status === 400);
  assert.equal(reloaded.generationProvider(providerId).apiUrl, httpsUrl);
});

test('stored legacy or nonboolean flags never grant HTTP consent and HTTPS remains compatible', () => {
  const { providers, store } = service();
  const { providerId } = providers.saveRelay({ name: 'Legacy', apiUrl: 'https://relay.example.com/custom', key: 'synthetic-legacy-key' });
  const original = JSON.parse(store.get('provider_relays_v1'))[0];
  const legacy = { ...original };
  delete legacy.allowInsecureHttp;
  store.set('provider_relays_v1', JSON.stringify([legacy]));
  assert.equal(service({ store }).providers.generationProvider(providerId).apiUrl, legacy.apiUrl);
  for (const allowInsecureHttp of [undefined, false, 'true', 1]) {
    const stored = { ...legacy, apiUrl: 'http://relay.example.com/custom', allowInsecureHttp };
    const fixtureStore = new Map([['provider_relays_v1', JSON.stringify([stored])]]);
    const reloaded = service({ store: fixtureStore }).providers;
    assert.equal(reloaded.providerStatus().relays[0].allowInsecureHttp, false);
    assert.throws(() => reloaded.generationProvider(providerId), error => error.status === 400);
  }
});

test('a host without the private-address guard refuses custom relays', () => {
  const { providers } = service({ allowCustomRelays: false });
  assert.throws(() => providers.saveRelay({ name: 'x', apiUrl: 'https://relay.example.com/gen', key: 'valid-key-123' }), error => error.status === 403);
  assert.equal(providers.providerStatus().customRelays, false);
});

test('RBQ keeps its id and key storage, and its key can be removed', () => {
  const { providers } = service();
  providers.saveRbqToken('rbq_key_abcdefghijklmnopqrstuvwxyz');
  assert.equal(providers.providerStatus().rbq.configured, true);
  assert.equal(providers.generationProvider('rbq').apiUrl, 'https://gnai.rbq.my/ai/generate-image');
  assert.equal(providers.deleteRbqToken().rbq.configured, false);
  assert.throws(() => providers.generationProvider('rbq'), error => error.status === 400);
});
