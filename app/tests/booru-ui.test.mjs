import assert from 'node:assert/strict';
import path from 'node:path';

export function booruFixturePost(id, overrides = {}) {
  return { id, rating: 'g', file_ext: 'png', image_width: 512, image_height: 768,
    score: 100 - id % 100, fav_count: 20, created_at: '2026-11-26T10:00:00Z', file_size: 10000,
    preview_file_url: `https://cdn.donmai.us/booru-fixture/preview/${id}.png`,
    large_file_url: `https://cdn.donmai.us/booru-fixture/sample/${id}.png`,
    file_url: `https://cdn.donmai.us/booru-fixture/original/${id}.png`,
    tag_string_artist: 'fixture_artist', tag_string_copyright: 'fixture_work',
    tag_string_character: 'fixture_character', tag_string_general: 'sky blue_hair forest',
    tag_string_meta: 'highres', ...overrides };
}
export async function runBooruChecks({ page, temporary, calls, downloadEvents, getBooruVault, getProviderVault }) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('#appView')?.getAttribute('aria-busy') === 'false');
  const call = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  }, { url, method, body });
  await page.locator('[data-section-add="misc"]').click();
  await page.locator('[data-tag-input="misc"]').fill('kept fixture');
  await page.locator('[data-tag-input="misc"]').press('Enter');
  const open = async () => {
    await page.locator('[data-tab="codex"]').click();
    assert.equal(await page.locator('#referenceBooru').getAttribute('aria-selected'), 'true', 'entering the page defaults to gallery');
  };
  const saveSettings = async () => {
    await page.locator('.booru-settings [type="submit"]').click();
    await page.locator('.booru-settings').waitFor({ state: 'detached' });
    await page.waitForFunction(() => !document.querySelector('#booruCancel').checkVisibility());
  };
  await open();
  assert.equal(await page.locator('#referenceSwitch button').first().getAttribute('id'), 'referenceBooru', 'gallery is the first subpage');
  await page.locator('.booru-card').first().waitFor();
  assert.equal(await page.locator('.booru-card').count(), 40);
  assert.match(calls.at(-1).tags, /rating:g/);
  await page.locator('#booruQuery').fill('sky');
  await page.locator('#booruSearchForm [type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#booruCancel').checkVisibility());
  await page.evaluate(() => window.scrollTo(0, 520));
  const scroll = await page.evaluate(() => scrollY);
  await page.locator('#referenceCodex').evaluate(el => el.click());
  assert.equal(await page.locator('#booruMount').isVisible(), false);
  await page.locator('#referenceBooru').evaluate(el => el.click());
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#booruQuery').inputValue(), 'sky');
  assert.ok(Math.abs(await page.evaluate(() => scrollY) - scroll) < 4, 'each subpage restores scroll');
  await page.locator('#booruQuery').fill('fixture_slow');
  await page.locator('#booruSearchForm [type="submit"]').click();
  await page.locator('#booruQuery').fill('fixture_fast');
  await page.locator('#booruSearchForm [type="submit"]').click();
  await page.locator('.booru-card[data-post="9000"]').waitFor();
  await page.waitForTimeout(900);
  assert.equal(await page.locator('.booru-card').first().getAttribute('data-post'), '9000', 'older response cannot replace latest');
  await page.locator('#booruQuery').fill('fixture_slow');
  await page.locator('#booruSearchForm [type="submit"]').click();
  await page.locator('#booruCancel').click();
  await page.waitForFunction(() => document.querySelector('#booruStatus').textContent.includes('加载已取消'));
  assert.equal(await page.locator('.booru-card').first().getAttribute('data-post'), '9000');
  await page.locator('#booruQuery').fill('fixture_error');
  await page.locator('#booruSearchForm [type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#booruStatus').textContent.includes('请求过于频繁'));
  assert.equal(await page.locator('.booru-card').first().getAttribute('data-post'), '9000');
  await page.locator('#booruQuery').fill('sky');
  await page.locator('#booruSearchForm [type="submit"]').click();
  await page.locator('.booru-card[data-post="100"]').waitFor();
  console.log('PASS stale search response, user cancellation and network error preserve current results');
  await page.locator('.booru-card').first().click();
  await page.locator('.booru-import-actions').waitFor();
  await page.waitForFunction(() => document.querySelector('.booru-image-stage img')?.naturalWidth === 512);
  await page.locator('.booru-detail [data-zoom="in"]').click();
  assert.ok(Number(await page.locator('.booru-image-stage').getAttribute('data-zoom')) > 1);
  assert.equal(await page.locator('.booru-tag[data-category="artist"]').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('.booru-tag[data-tag="sky"]').getAttribute('aria-pressed'), 'true');
  await page.locator('.booru-tag[data-tag="forest"]').click();
  await page.locator('.booru-import-actions .booru-primary').click();
  assert.equal(await page.locator('.tag-chip[data-group="misc"]').count(), 5, 'existing tag plus four selected tags');
  assert.match(await page.locator('#promptPreview').inputValue(), /kept fixture/);
  assert.doesNotMatch(await page.locator('#promptPreview').inputValue(), /forest|highres|fixture_artist/);
  await page.locator('[data-history="undo"]').click();
  assert.equal(await page.locator('.tag-chip[data-group="misc"]').count(), 1);
  console.log('PASS page switching, partial selection, append and one-step undo');

  await open(); await page.locator('.booru-card').first().click();
  await page.locator('.booru-import-actions').waitFor();
  await page.locator('.booru-import-actions').getByRole('button', { name: '替换此分区' }).click();
  await page.locator('[data-confirm-cancel]').click();
  assert.equal(await page.locator('.booru-detail').count(), 1, 'cancel preserves draft');
  await page.locator('.booru-import-actions').getByRole('button', { name: '替换此分区' }).click();
  await page.locator('[data-confirm-accept]').click();
  assert.doesNotMatch(await page.locator('#promptPreview').inputValue(), /kept fixture/);
  await page.locator('[data-history="undo"]').click();
  assert.match(await page.locator('#promptPreview').inputValue(), /kept fixture/);
  const negativeBefore = await page.locator('#negativePrompt').inputValue();
  await open(); await page.locator('.booru-card').first().click();
  await page.locator('#booruImportTarget').selectOption('negative');
  await page.locator('.booru-import-actions .booru-primary').click();
  assert.match(await page.locator('#negativePrompt').inputValue(), /blue_hair/);
  await page.locator('[data-history="undo"]').click();
  assert.equal(await page.locator('#negativePrompt').inputValue(), negativeBefore);
  await page.locator('#addCharacterButton').click();
  const characterId = await page.locator('[data-character-card]').last().getAttribute('data-character-card');
  await open(); await page.locator('.booru-card').first().click();
  await page.locator('#booruImportTarget').selectOption(`character:${characterId}`);
  await page.locator('.booru-import-actions .booru-primary').click();
  assert.equal(await page.locator(`[data-character-card="${characterId}"] .tag-chip`).count(), 5);
  await page.locator('[data-history="undo"]').click();
  assert.equal(await page.locator(`[data-character-card="${characterId}"] .tag-chip`).count(), 0);
  await open(); await page.locator('.booru-card').first().click();
  await page.locator('.booru-detail').getByRole('button', { name: '取消选择', exact: true }).click();
  await page.locator('.booru-category-label input[data-category="artist"]').check();
  await page.locator('#booruImportTarget').selectOption('style');
  await page.locator('.booru-import-actions .booru-primary').click();
  assert.match(await page.locator('#promptPreview').inputValue(), /artist:fixture_artist/);
  await open(); await page.locator('.booru-card').first().click();
  await page.locator('.booru-detail').getByRole('button', { name: '取消选择', exact: true }).click();
  await page.locator('.booru-category-label input[data-category="artist"]').check();
  await page.locator('#booruImportTarget').selectOption('style');
  await page.locator('.booru-import-actions .booru-primary').click();
  assert.equal(await page.locator('.tag-chip[data-group="style"]').count(), 1, 'second append does not duplicate artist');
  await page.locator('[data-history="undo"]').click();
  assert.equal(await page.locator('.tag-chip[data-group="style"]').count(), 0, 'no-op append adds no undo step');
  console.log('PASS negative/character destinations, artist prefix, duplicate skipping and undo');
  await open(); await page.locator('.booru-card').first().click();
  await page.locator('.booru-import-actions').waitFor();
  await page.evaluate(() => localStorage.setItem('nai-pocket-download-preferences-v1', JSON.stringify({ metadata: 'ask', destination: 'folder' })));
  await page.locator('.booru-detail').getByRole('button', { name: '保存原图', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.toast-host')?.textContent.includes('原图已保存'));
  assert.equal(downloadEvents.at(-1).destination, 'folder');
  assert.match(downloadEvents.at(-1).name, /^danbooru-\d+\.png$/);
  await page.locator('.booru-detail .booru-close').click();
  console.log('PASS explicit replacement, cancel, undo and download destination');

  await page.locator('#booruSettings').click();
  await page.locator('.booru-settings input[name="username"]').fill('fixture-user');
  await page.locator('.booru-settings input[name="apiKey"]').fill('fixture-key');
  await page.locator('.booru-settings textarea[name="outputFilter"]').fill('sky');
  await saveSettings();
  await page.locator('.booru-card').first().waitFor();
  assert.equal(getBooruVault().credentials.apiKey, 'fixture-key');
  assert.equal(getProviderVault().credentials, undefined, 'independent credential namespace');
  const settings = await call('/api/booru/settings');
  assert.equal(settings.data.configured, true);
  assert.doesNotMatch(JSON.stringify(settings), /fixture-key|fixture-user/);
  assert.doesNotMatch(await page.evaluate(() => JSON.stringify(localStorage)), /fixture-key|fixture-user/);
  assert.doesNotMatch(JSON.stringify((await call('/api/export')).data), /fixture-key|fixture-user/);
  await page.locator('.booru-card').first().click();
  await page.locator('.booru-import-actions').waitFor();
  assert.equal(await page.locator('.booru-tag[data-tag="sky"]').isDisabled(), true);
  assert.equal(await page.locator('.booru-tag[data-tag="sky"]').getAttribute('aria-pressed'), 'false');
  await page.locator('.booru-detail .booru-close').click();
  await page.locator('#booruSettings').click();
  await page.locator('#booruTestConnection').click();
  await page.waitForFunction(() => document.querySelector('#booruSettingsStatus')?.textContent === '账号连接成功。');
  assert.equal(await page.locator('.booru-settings input[name="apiKey"]').inputValue(), '');
  await page.locator('.booru-settings textarea[name="blacklist"]').fill('forest');
  await saveSettings();
  await page.waitForFunction(() => document.querySelector('#booruStatus')?.textContent.includes('过滤 40 张'));
  assert.equal(await page.locator('.booru-card').count(), 0);
  assert.equal(await page.locator('#booruMore').isDisabled(), false, 'empty filtered page can continue');
  await page.locator('#booruSettings').click();
  await page.locator('.booru-settings textarea[name="blacklist"]').fill('');
  await saveSettings();
  await page.locator('.booru-card').first().waitFor();
  await page.locator('#booruChannel').selectOption('week');
  await page.waitForFunction(() => !document.querySelector('#booruCancel').checkVisibility());
  assert.equal(calls.at(-1).path, '/explore/posts/popular.json');
  assert.equal(await page.locator('#booruQuery').isDisabled(), true);
  await page.locator('#booruNext').click();
  await page.waitForFunction(() => document.querySelector('#booruStatus').textContent.startsWith('第 2 页'));
  console.log('PASS settings, encrypted namespace, export privacy, filtering and ranking pagination');

  await page.waitForTimeout(4500); // Let real transient notifications dismiss before screenshots.
  for (const theme of ['light', 'dark', 'blue-coral', 'rose-night']) {
    await page.locator('#openSettingsButton').click();
    await page.locator('#appearanceTheme').selectOption(theme);
    await page.locator('#closeSettingsButton').click();
    for (const width of [360, 390, 430, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme}/${width} page overflow`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(temporary, `booru-${theme}.png`) });
    await page.locator('.booru-card').first().click();
    await page.locator('.booru-import-actions').waitFor();
    await page.waitForFunction(() => document.querySelector('.booru-image-stage img')?.naturalWidth === 512);
    for (const width of [360, 390, 430, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      const result = await page.locator('.booru-import-actions .booru-primary').evaluate(el => {
        const r = el.getBoundingClientRect(), modal = document.querySelector('.booru-detail');
        return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && r.height >= 48 && modal.scrollWidth <= modal.clientWidth;
      });
      assert.equal(result, true, `${theme}/${width} import action visible and touchable`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(temporary, `booru-detail-${theme}.png`) });
    await page.setViewportSize({ width: 390, height: 400 });
    assert.equal(await page.locator('.booru-import-actions .booru-primary').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), true, 'short viewport keeps import action visible');
    await page.locator('.booru-detail .booru-close').click();
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await page.locator('#booruSettings').click();
  await page.locator('#booruClearCache').click();
  await page.waitForFunction(() => document.querySelector('#booruSettingsStatus')?.textContent.includes('缓存已清空'));
  assert.equal((await call('/api/booru/settings')).data.cacheBytes, 0);
  await page.locator('.booru-settings .booru-close').click();
  await page.locator('#referenceCodex').click();
  await page.evaluate(() => fixtureApp.emit('backButton'));
  assert.equal(await page.locator('#booruMount').isVisible(), true, 'Android back returns from Codex to default gallery');
  await page.locator('#referenceCodex').click();
  await page.locator('[data-tab="editor"]').click();
  await open();
  assert.equal(await page.locator('#booruMount').isVisible(), true, 're-entering after using Codex still defaults to gallery');
  console.log('PASS four palettes, responsive import dock and cache clearing');
  console.log(`Booru screenshots: ${temporary}`);
}
