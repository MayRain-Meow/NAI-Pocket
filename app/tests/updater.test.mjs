import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdater, selectUpdate, compareVersions, parseVersion, releaseSummary, RELEASES_URL, CHECK_INTERVAL_MS, LAST_CHECK_KEY, SKIPPED_KEY } from '../src/updater.js';

const base = 'https://github.com/MayRain-Meow/NAI-Pocket/releases/download/';
function release(version, { tag = `v${version}-preview`, draft = false, prerelease = true, assetName = `NAI-Pocket-v${version}-preview.apk`, checksum = false, digest = '', body = '' } = {}) {
  const assets = [{ name: `NAI-Pocket-v${version}-source.zip`, browser_download_url: `${base}${tag}/NAI-Pocket-v${version}-source.zip`, size: 5 }];
  if (assetName) assets.push({ name: assetName, browser_download_url: `${base}${tag}/${assetName}`, size: 12828668, ...(digest ? { digest } : {}) });
  if (checksum) assets.push({ name: `${assetName}.sha256`, browser_download_url: `${base}${tag}/${assetName}.sha256`, size: 98 });
  return { tag_name: tag, name: `NAI Pocket ${version} preview`, draft, prerelease, body, assets };
}
function memoryState(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, async get(key, fallback = '') { return values.has(key) ? values.get(key) : fallback; }, async set(key, value) { values.set(key, String(value)); } };
}
function harness({ releases = [], status = 200, current = '0.3.4', state = memoryState(), clock = { now: 1_000_000_000_000 }, failure = null } = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (failure) throw failure;
    return new Response(JSON.stringify(releases), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, state, clock, updater: createUpdater({ fetch, state, currentVersion: current, now: () => clock.now }) };
}

test('versions parse and compare numerically', () => {
  assert.deepEqual(parseVersion('v0.3.10-preview'), [0, 3, 10]);
  assert.deepEqual(parseVersion('0.3.4'), [0, 3, 4]);
  assert.equal(parseVersion('v0.3.4-beta'), null);
  assert.equal(compareVersions('0.3.10', '0.3.9'), 1);
  assert.equal(compareVersions('0.10.0', '0.9.99'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.3.4', '0.4.0'), -1);
});

test('selects the highest valid release with the exact APK asset', () => {
  const releases = [
    release('0.3.6', { draft: true }),
    release('0.3.9', { assetName: 'NAI-Pocket-v0.3.9.apk' }),
    release('0.4.0', { tag: 'v0.4.0-beta' }),
    release('0.3.5', { checksum: true, body: '## 更新\n- **修复** 画师页\n- 新增 [说明](https://example.invalid)\n\n第四行\n第五行' }),
    release('0.3.10', { prerelease: false, digest: 'sha256:' + 'AB'.repeat(32) }),
    release('0.3.4')
  ];
  const update = selectUpdate(releases, '0.3.4');
  assert.equal(update.version, '0.3.10', 'numeric order, not list order; prerelease flag ignored');
  assert.equal(update.url, `${base}v0.3.10-preview/NAI-Pocket-v0.3.10-preview.apk`);
  assert.equal(update.sha256, 'ab'.repeat(32));
  assert.equal(update.sha256Url, '');
  const older = selectUpdate(releases.filter(item => item.tag_name !== 'v0.3.10-preview'), '0.3.4');
  assert.equal(older.version, '0.3.5');
  assert.equal(older.sha256Url, `${base}v0.3.5-preview/NAI-Pocket-v0.3.5-preview.apk.sha256`);
  assert.equal(older.notes, '更新\n修复 画师页\n新增 说明');
  assert.equal(selectUpdate(releases, '0.3.10'), null, 'same version is not an update');
  assert.equal(selectUpdate(releases, '0.4.0'), null, 'older releases are not updates');
  assert.equal(selectUpdate([release('0.3.5', { assetName: '' })], '0.3.4'), null, 'no APK asset, no update');
  const foreign = release('0.3.5'); foreign.assets[1].browser_download_url = 'https://github.com/someone/fork/releases/download/v0.3.5-preview/NAI-Pocket-v0.3.5-preview.apk';
  assert.equal(selectUpdate([foreign], '0.3.4'), null, 'asset must come from this repository and tag');
  assert.equal(selectUpdate({ message: 'Not Found' }, '0.3.4'), null);
});

test('release summary is plain text, three lines at most', () => {
  assert.equal(releaseSummary('<!-- hidden -->\n# 标题\n\n> 引用\n1. 一\n---\n![img](x.png)\n`code` 二\n三'), '标题\n引用\n一');
  assert.equal(releaseSummary(''), '');
  assert.equal(releaseSummary('x'.repeat(200)).length, 120);
});

test('automatic check runs at most once every 12 hours; manual always runs', async () => {
  const h = harness({ releases: [release('0.3.5')] });
  const first = await h.updater.check();
  assert.equal(first.status, 'available'); assert.equal(first.update.version, '0.3.5');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, RELEASES_URL);
  assert.equal(h.calls[0].options.headers.Authorization, undefined, 'no credentials');
  assert.equal(h.state.values.get(LAST_CHECK_KEY), String(h.clock.now));
  h.clock.now += CHECK_INTERVAL_MS - 1;
  assert.equal((await h.updater.check()).status, 'throttled'); assert.equal(h.calls.length, 1);
  assert.equal((await h.updater.check({ manual: true })).status, 'available'); assert.equal(h.calls.length, 2, 'manual check ignores the throttle');
  h.clock.now += CHECK_INTERVAL_MS;
  await h.updater.check(); assert.equal(h.calls.length, 3, 'after 12 hours the automatic check runs again');
  // A clock moved backwards does not block checks forever.
  h.clock.now -= 10 * CHECK_INTERVAL_MS;
  await h.updater.check(); assert.equal(h.calls.length, 4);
});

test('failed attempts count toward the throttle and are reported quietly', async () => {
  for (const [status, expected] of [[403, 'rate-limited'], [429, 'rate-limited'], [500, 'error']]) {
    const h = harness({ status });
    assert.equal((await h.updater.check()).status, expected);
    assert.equal((await h.updater.check()).status, 'throttled');
  }
  const offline = harness({ failure: new TypeError('Native HTTP request failed') });
  assert.equal((await offline.updater.check({ manual: true })).status, 'error');
  assert.equal((await harness({ releases: [release('0.3.4')] }).updater.check()).status, 'none');
});

test('a skipped version is not announced automatically but is shown on manual check', async () => {
  const h = harness({ releases: [release('0.3.5')] });
  await h.updater.skip('0.3.5');
  assert.equal(h.state.values.get(SKIPPED_KEY), '0.3.5');
  assert.equal((await h.updater.check()).status, 'skipped');
  assert.equal((await h.updater.check({ manual: true })).status, 'available');
  const newer = harness({ releases: [release('0.3.6')], state: memoryState({ [SKIPPED_KEY]: '0.3.5' }) });
  assert.equal((await newer.updater.check()).status, 'available', 'a newer release than the skipped one is announced');
});
