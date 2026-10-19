import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Reuse the real native API/provider/vault fixture, without generating images.
export async function runRelaySettingsChecks({ page, getVault, generationCalls, temporary }) {
  const api = (url, body, method = body ? 'POST' : 'GET') => page.evaluate(async ({ url, body, method }) => {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }, { url, body, method });
  const records = () => JSON.parse(getVault().state?.provider_relays_v1 || '[]');
  const secretFor = record => getVault().secrets[record.encryptedKey];
  async function openSettings() {
    if (!(await page.locator('#settingsDialog').evaluate(node => node.open))) await page.locator('#openSettingsButton').click();
    if (!(await page.locator('#relayManager').evaluate(node => node.open))) await page.locator('#relayManager > summary').click();
  }
  async function assertReset() {
    for (const id of ['relayName', 'relayApiUrl', 'rbqApiKey', 'relayExtraKey']) assert.equal(await page.locator(`#${id}`).inputValue(), '', `${id} reset`);
    assert.equal(await page.locator('#relayAllowHttp').isChecked(), false, 'HTTP permission never carries into a new form');
    assert.equal(await page.locator('#cancelRelayEdit').isVisible(), false);
  }
  await page.evaluate(() => {
    const original = window.fetch;
    window.relaySettingsSubmissions = [];
    window.fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input, location.origin);
      if (/^\/api\/providers\/relays(?:\/|$)/.test(url.pathname) && ['POST', 'PUT'].includes(options?.method)) {
        window.relaySettingsSubmissions.push({ path: url.pathname, method: options.method, body: JSON.parse(options.body) });
      }
      return original(input, options);
    };
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await openSettings();
  await page.locator('#relayKind').selectOption('custom');
  assert.equal(await page.locator('#relayExtraKey').isVisible(), true);
  assert.equal(await page.locator('#relayHttpField').isVisible(), true);
  assert.equal(await page.locator('#relayAllowHttp').isChecked(), false);
  const endpoint = 'http://relay.example.test:8080/v1/images/generations';
  const first = 'front-key-', extra = 'internal-nai-key-123', combined = first + extra;
  const name = '自定义 HTTP 中转 · 测试长名称的手机布局';
  await page.locator('#relayName').fill(name);
  await page.locator('#relayApiUrl').fill(endpoint);
  await page.locator('#rbqApiKey').fill(`  ${first}  `);
  await page.locator('#relayExtraKey').fill(`  ${extra}  `);
  await page.locator('#saveRbqKeyButton').click();
  await page.getByText('这个地址使用 HTTP，请勾选“允许此中转使用 HTTP”。', { exact: true }).waitFor();
  assert.equal(records().length, 0, 'HTTP without explicit permission never persists to native vault');
  let submitted = await page.evaluate(() => window.relaySettingsSubmissions);
  assert.deepEqual(submitted.at(-1).body, { name, apiUrl: endpoint, key: combined, allowInsecureHttp: false });
  await page.locator('#relayAllowHttp').check();
  await page.locator('#saveRbqKeyButton').click();
  await page.locator('#relayList .provider-account-row').waitFor();
  assert.equal(records().length, 1);
  const saved = records()[0], providerId = `relay:${saved.id}`;
  assert.equal(saved.allowInsecureHttp, true, 'native vault saves explicit HTTP consent');
  assert.equal(saved.apiUrl, endpoint, 'native API keeps the exact endpoint path');
  assert.equal(secretFor(saved), combined, 'UI trims each half and concatenates without adding separators');
  assert.equal(await page.locator('#generationProvider').inputValue(), providerId);
  assert.equal((await api('/api/providers')).data.providers.relays[0].allowInsecureHttp, true);
  await assertReset();

  await page.locator(`[data-edit-relay="${providerId}"]`).click();
  assert.equal(await page.locator('#rbqApiKey').inputValue(), '');
  assert.equal(await page.locator('#relayExtraKey').inputValue(), '');
  assert.equal(await page.locator('#relayAllowHttp').isChecked(), true, 'editing restores this relay permission');
  assert.equal(await page.locator('#relayApiUrl').inputValue(), endpoint);
  await page.locator('#relayName').fill(`${name}（已编辑）`);
  await page.locator('#saveRbqKeyButton').click();
  await page.getByText('中转已更新。', { exact: true }).waitFor();
  submitted = await page.evaluate(() => window.relaySettingsSubmissions);
  assert.equal(submitted.at(-1).method, 'PUT');
  assert.equal(submitted.at(-1).body.key, '', 'blank edit sends no credential replacement');
  assert.equal(submitted.at(-1).body.allowInsecureHttp, true);
  assert.equal(secretFor(records()[0]), combined, 'native storage keeps the old credential when edit key is blank');
  await assertReset();

  await page.locator(`[data-edit-relay="${providerId}"]`).click();
  await page.locator('#relayAllowHttp').uncheck();
  await page.locator('#saveRbqKeyButton').click();
  await page.getByText('这个地址使用 HTTP，请勾选“允许此中转使用 HTTP”。', { exact: true }).waitFor();
  assert.equal(records()[0].allowInsecureHttp, true, 'failed edit does not overwrite native permission');
  await page.locator('#relayAllowHttp').check();
  await page.locator('#rbqApiKey').fill('discarded-first');
  await page.locator('#relayExtraKey').fill('discarded-extra');
  await page.locator('#cancelRelayEdit').click();
  await assertReset();
  const countBefore = (await page.evaluate(() => window.relaySettingsSubmissions)).length;
  await page.locator('#relayApiUrl').fill('https://relay.example.test/v1/generate');
  await page.locator('#relayExtraKey').fill('extra-without-first-key');
  await page.locator('#saveRbqKeyButton').click();
  await page.getByText('填写内部 NAI Key 时也要填写前半段 Key，或直接粘贴完整 Token。', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.relaySettingsSubmissions)).length, countBefore, 'extra key without prefix is rejected before API submission');

  await page.reload();
  await page.waitForFunction(() => globalThis.NAI_RUNTIME && !document.querySelector('#appView').classList.contains('hidden'));
  await openSettings();
  await page.locator(`[data-edit-relay="${providerId}"]`).click();
  assert.equal(await page.locator('#relayAllowHttp').isChecked(), true, 'reloaded native vault restores HTTP permission');
  assert.equal(await page.locator('#rbqApiKey').inputValue(), '');
  assert.equal(await page.locator('#relayExtraKey').inputValue(), '');
  assert.equal(secretFor(records()[0]), combined);

  const screenshots = [];
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('#relayHttpField').scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => {
      const dialog = document.querySelector('#settingsDialog'), body = dialog.querySelector('.settings-dialog-body'), form = dialog.querySelector('.relay-form');
      const nodes = [dialog, body, form, ...form.children].filter(node => node.getBoundingClientRect().width && !node.hidden);
      return { body: body.scrollWidth - body.clientWidth, form: form.scrollWidth - form.clientWidth,
        outside: nodes.filter(node => { const r = node.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).map(node => node.id || node.className) };
    });
    assert.ok(overflow.body <= 1 && overflow.form <= 1, `${width}px horizontal content overflow: ${JSON.stringify(overflow)}`);
    assert.deepEqual(overflow.outside, [], `${width}px controls stay within viewport`);
    const screenshot = path.join(temporary, `native-relay-settings-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(screenshot);
  }
  await page.locator('#cancelRelayEdit').click();
  await assertReset();
  await page.locator('#relayKind').selectOption('rbq');
  assert.equal(await page.locator('#relayExtraKey').isVisible(), false);
  assert.equal(await page.locator('#relayHttpField').isVisible(), false);
  assert.equal(generationCalls.length, 0, 'configuration tests never send a generation request');
  console.log('Relay settings passed: two-part key, explicit HTTP, native vault/reload, blank-key edit, rollback/reset, 360px/1280px overflow; zero generation calls.');
  for (const screenshot of screenshots) console.log(`Screenshot: ${screenshot}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./offline-integration.mjs', import.meta.url)), '--relay-settings-only'], { stdio: 'inherit', windowsHide: true });
  child.once('error', error => { console.error(error); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}
