import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makePngFixture } from '../../tests/png-metadata-fixtures.mjs';

export async function runUsabilityChecks({ page, db, dataRoot, temporary }) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('#appView')?.getAttribute('aria-busy') === 'false');
  const call = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }, { url, method, body });
  await call('/api/jobs/pause', 'POST');
  const insert = db.prepare("INSERT INTO jobs(id,batch_id,position,status,request_json,seed,initiated_at,created_at) VALUES (?,'usability',1,?,'{}',42,1,1)");
  for (const id of ['failed-one', 'failed-two']) insert.run(id, 'failed');
  insert.run('waiting', 'pending');
  await page.locator('[data-tab="queue"]').click();
  const row = id => page.locator(`[data-queue-id="${id}"]`);
  await row('failed-one').locator('[data-queue-action="delete"]').click();
  await page.locator('[data-confirm-cancel]').click();
  assert.ok(db.prepare("SELECT id FROM jobs WHERE id='failed-one'").get(), 'cancel keeps record');
  await row('failed-one').locator('[data-queue-action="delete"]').click();
  await page.locator('[data-confirm-accept]').click();
  await row('failed-one').waitFor({ state: 'detached' });
  await page.locator('#queueClearFailedButton').click();
  await page.locator('[data-confirm-accept]').click();
  await row('failed-two').waitFor({ state: 'detached' });
  assert.ok(db.prepare("SELECT id FROM jobs WHERE id='waiting'").get(), 'clear failed preserves pending');
  assert.equal((await call('/api/jobs/waiting', 'DELETE')).status, 409);
  console.log('PASS queue removal through real UI and native API');

  // Install the isolated fixture style pack, then enter details from a name search.
  await page.locator('#openSettingsButton').click();
  await page.locator('.native-style-pack').getByRole('button', { name: '下载画风数据', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.native-style-pack p[role="status"]')?.textContent.startsWith('画风数据已安装'));
  await page.locator('#closeSettingsButton').click();
  await page.evaluate(() => document.querySelector('[data-tab="artists"]').click());
  const search = page.locator('#artistLibraryMount input[name="query"]');
  await search.fill('anmi');
  await page.locator('[data-artist-card="anmi"]').click();
  await page.locator('[data-artist-similar-style="anmi"]').click();
  await page.locator('[data-artist-card="fixture same image"]').waitFor();
  assert.equal(await search.inputValue(), '');
  assert.equal(await page.locator('[data-artist-card="anmi"]').count(), 0);
  console.log('PASS detail similarity clears the prior name search');

  const paletteValues = { light: ['#F4F4F2','#FFFA00'], dark: ['#0B0C10','#636AFF'], 'blue-coral': ['#F4F4F2','#636AFF'], 'rose-night': ['#141414','#E4397E'] };
  for (const [theme, colors] of Object.entries(paletteValues)) {
    await page.locator('#openSettingsButton').click();
    await page.locator('#appearanceTheme').selectOption(theme);
    await page.locator('#closeSettingsButton').click();
    await page.locator('[data-tab="editor"]').click();
    assert.deepEqual(await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['--ef-paper','--ef-accent'].map(key => style.getPropertyValue(key).trim().toUpperCase());
    }), colors);
    for (const width of [360, 390, 430, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme}/${width} no overflow`);
      const contrast = await page.locator('.floating-generate-button').evaluate(el => {
        const css = getComputedStyle(el);
        const luma = c => c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((a, v, i) => a + v * [.2126,.7152,.0722][i], 0);
        const a = luma(css.color), b = luma(css.backgroundColor);
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      });
      assert.ok(contrast >= 4.5, `${theme} action text contrast ${contrast}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(temporary, `palette-${theme}.png`) });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#appView')?.getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('html').getAttribute('data-ef-palette'), theme, 'saved palette survives reload');
  }
  await page.locator('#openSettingsButton').click();
  await page.locator('#appearanceTheme').selectOption('system');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.locator('#appearanceTheme').selectOption('dark');
  await page.locator('#closeSettingsButton').click();
  console.log('PASS palettes, contrast, persistence, system mode and mobile/desktop widths');

  await page.locator('[data-tab="editor"]').click();
  await page.locator('[data-section-add="scene"]').click();
  await page.locator('[data-tag-input="scene"]').fill(Array.from({ length: 45 }, (_, i) => `scroll fixture ${i}`).join(', '));
  await page.locator('[data-tag-input="scene"]').press('Enter');
  const handle = page.locator('.tag-chip[data-group="scene"] .drag-handle').first();
  await handle.waitFor();
  await handle.evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 330));
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => document.body.classList.contains('tag-drag-active'));
  await page.mouse.move(40, 400);
  const atCenter = await page.evaluate(() => scrollY);
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => scrollY), atCenter, 'dragging in center does not scroll');
  const edge = await page.evaluate(() => document.querySelector('.floating-generate-bar').getBoundingClientRect().top - 4);
  await page.mouse.move(40, edge);
  await page.waitForTimeout(650);
  assert.ok(await page.evaluate(() => scrollY) > atCenter + 30, 'holding at bottom edge scrolls gradually');
  await page.mouse.move(40, 400);
  const stopped = await page.evaluate(() => scrollY);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => scrollY), stopped, 'leaving edge immediately stops');
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel')));
  await page.mouse.up();
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('tag-drag-active')), false);
  console.log('PASS real tag drag: stable center, edge scroll and immediate stop');

  // Two distinct synthetic pictures: the image ID must stay fixed during pinch/pan.
  await fs.mkdir(path.join(dataRoot, 'originals'), { recursive: true });
  await fs.mkdir(path.join(dataRoot, 'thumbnails'), { recursive: true });
  const rgba = Buffer.alloc(512 * 768 * 4);
  for (let y = 0; y < 768; y++) for (let x = 0; x < 512; x++) {
    const at = (y * 512 + x) * 4;
    rgba.set([x % 255, y % 255, ((x >> 5) + (y >> 5)) % 2 ? 220 : 80, 255], at);
  }
  const png = makePngFixture({ width: 512, height: 768, rgba });
  for (const id of ['zoom-a', 'zoom-b']) {
    insert.run(id, 'completed');
    await fs.writeFile(path.join(dataRoot, 'originals', `${id}.png`), png);
    await fs.writeFile(path.join(dataRoot, 'thumbnails', `${id}.png`), png);
    db.prepare(`INSERT INTO images(id,job_id,batch_id,original_name,thumb_name,mime,width,height,bytes,thumb_bytes,prompt,negative_prompt,params_json,seed,created_at)
      VALUES (?,?,'usability',?,?,'image/png',512,768,?,?,'synthetic zoom fixture','','{}',42,?)`).run(id,id,`${id}.png`,`${id}.png`,png.length,png.length,Date.now());
  }
  await page.locator('[data-tab="gallery"]').click();
  await page.locator('#galleryGrid .gallery-card').first().click();
  await page.waitForFunction(() => document.querySelector('#dialogImage').naturalWidth === 512);
  const stage = page.locator('#dialogImageStage');
  const imageSource = () => stage.getAttribute('data-image-id');
  const startSource = await imageSource();
  const cdp = await page.context().newCDPSession(page);
  const bounds = await page.locator('.zoom-surface').boundingBox();
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x,y,id]) => ({ x,y,id,radiusX:4,radiusY:4 })) });
  await touch('touchStart', [[cx-30,cy,1],[cx+30,cy,2]]);
  for (const distance of [40,55,75,95]) await touch('touchMove', [[cx-distance,cy,1],[cx+distance,cy,2]]);
  await touch('touchEnd', []);
  assert.ok(Number(await stage.getAttribute('data-zoom')) > 2.5, 'actual two-finger input zooms image');
  assert.equal(await imageSource(), startSource, 'pinch never switches images');
  const beforePan = await page.locator('#dialogImage').evaluate(el => el.style.transform);
  await touch('touchStart', [[cx,cy,1]]);
  await touch('touchMove', [[cx+55,cy+35,1]]);
  await touch('touchEnd', []);
  assert.notEqual(await page.locator('#dialogImage').evaluate(el => el.style.transform), beforePan, 'zoomed image pans');
  assert.equal(await imageSource(), startSource, 'pan never switches images');
  await page.locator('#dialogLoadOriginal').click();
  await page.waitForFunction(() => document.querySelector('#dialogImage').complete && document.querySelector('#dialogImage').src.includes('/original'));
  assert.ok(Number(await stage.getAttribute('data-zoom')) > 2.5, 'loading original preserves zoom');
  await page.screenshot({ path: path.join(temporary, 'image-zoom-mobile.png') });
  await page.locator('[data-zoom="reset"]').click();
  assert.equal(Number(await stage.getAttribute('data-zoom')), 1);
  // Double-tap toggles 2.5x / fit without moving to the next picture.
  for (let i = 0; i < 2; i++) { await touch('touchStart', [[cx,cy,1]]); await touch('touchEnd', []); }
  assert.equal(Number(await stage.getAttribute('data-zoom')), 2.5);
  await page.locator('#dialogNext').click();
  assert.equal(Number(await stage.getAttribute('data-zoom')), 1, 'changing picture resets zoom');
  await page.locator('[data-zoom="in"]').click();
  await page.locator('#closeDialogButton').click();
  assert.equal(Number(await stage.getAttribute('data-zoom')), 1, 'closing resets zoom');
  await cdp.detach();
  console.log('PASS actual mobile pinch, pan, double-tap, original loading, navigation and close reset');
  console.log(`Usability screenshots: ${temporary}`);
}
