import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makePngFixture } from '../../tests/png-metadata-fixtures.mjs';

// Run through the real app/router against the isolated offline fixture database.
// The native bridge fixture validates registrations with the production Java allowlist.
export async function runGalleryRegressionChecks({ page, db, dataRoot, media, temporary }) {
  const call = (url, body) => page.evaluate(async ({ url, body }) => {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, data: await response.json() };
  }, { url, body });
  const createdAt = Date.now() - 3_600_000;
  const dimensions = [[32, 96], [96, 32], [64, 64], [48, 96]];
  const insertJob = db.prepare(`INSERT INTO jobs
    (id,batch_id,position,status,request_json,seed,image_id,initiated_at,created_at,finished_at)
    VALUES (?,'gallery-regression',?,'completed','{}',42,?,?,?,?)`);
  const insertImage = db.prepare(`INSERT INTO images
    (id,job_id,batch_id,original_name,thumb_name,mime,width,height,bytes,thumb_bytes,prompt,negative_prompt,seed,params_json,created_at)
    VALUES (?,?,'gallery-regression',?,?,'image/png',?,?,?,?,'gallery regression fixture','',42,'{}',?)`);
  await fs.mkdir(path.join(dataRoot, 'originals'), { recursive: true });
  await fs.mkdir(path.join(dataRoot, 'thumbnails'), { recursive: true });
  async function addImage(id, index, time, finishedAt = null) {
    const [width, height] = dimensions[index % dimensions.length];
    const bytes = makePngFixture({ width, height, rgba: Buffer.alloc(width * height * 4, 255) });
    await fs.writeFile(path.join(dataRoot, 'originals', `${id}.png`), bytes);
    await fs.writeFile(path.join(dataRoot, 'thumbnails', `${id}.webp`), bytes);
    insertJob.run(`${id}-job`, index, id, time, time, finishedAt);
    insertImage.run(id, `${id}-job`, `${id}.png`, `${id}.webp`, width, height, bytes.length, bytes.length, time);
  }
  // Several equal timestamps straddle the 30-image page boundary.
  for (let index = 0; index < 36; index += 1) {
    await addImage(`gallery-regression-${String(index).padStart(2, '0')}`, index, createdAt + Math.floor(index / 4));
  }
  const expectedIds = () => db.prepare("SELECT id FROM images WHERE kind='gallery' ORDER BY created_at DESC,id DESC").all().map(row => row.id);
  const loadedIds = () => page.locator('#galleryGrid .gallery-card').evaluateAll(cards => cards.map(card => card.dataset.galleryId));
  async function waitCount(count) {
    await page.waitForFunction(count => document.querySelectorAll('#galleryGrid .gallery-card').length === count, count);
  }
  async function assertOrder(expected, label) {
    assert.deepEqual(await loadedIds(), expected, `${label}: document and keyboard order is newest first`);
    const visual = await page.locator('#galleryGrid .gallery-card').evaluateAll(cards => cards.map(card => {
      const box = card.getBoundingClientRect();
      return { id: card.dataset.galleryId, top: box.top, left: box.left, right: box.right, bottom: box.bottom };
    }));
    assert.deepEqual(
      [...visual].sort((left, right) => Math.abs(left.top - right.top) <= 1 ? left.left - right.left : left.top - right.top).map(card => card.id),
      expected,
      `${label}: reading left-to-right then top-to-bottom follows the same dates`
    );
    for (let index = 1; index < visual.length; index += 1) {
      const previous = visual[index - 1], current = visual[index];
      if (Math.abs(current.top - previous.top) <= 1) {
        assert.ok(current.left >= previous.right - 1, `${label}: cards in the same row do not overlap`);
      }
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no horizontal overflow`);
  }
  async function loadAll() {
    while (await page.locator('#loadMoreButton').isVisible()) {
      const before = (await loadedIds()).length;
      await page.locator('#loadMoreButton').click();
      await page.waitForFunction(before => document.querySelectorAll('#galleryGrid .gallery-card').length > before, before);
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-tab="gallery"]').click();
  if (await page.locator('#galleryExitSelection').isVisible()) await page.locator('#galleryExitSelection').click();
  await page.locator('#gallerySearch').fill('');
  await page.locator('#favoriteOnly').setChecked(false);
  await page.locator('#galleryAgeFilter').selectOption('all');
  await page.locator('#galleryScopeIteration').click();
  await page.locator('#galleryScopeGallery').click();
  await waitCount(30);
  await assertOrder(expectedIds().slice(0, 30), 'First mobile page with mixed image proportions');
  await loadAll();
  await assertOrder(expectedIds(), 'Appended page with timestamp ties');
  for (const width of [360, 430, 1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#galleryGrid')).display === 'grid');
    await assertOrder(expectedIds(), `Viewport ${width}`);
  }

  // Completion polling must prepend in date order even when old column heights differ.
  await page.evaluate(() => window.scrollTo(0, 0));
  const completedAt = Date.now() + 10_000;
  await addImage('gallery-regression-new-a', 40, completedAt, completedAt);
  await addImage('gallery-regression-new-z', 41, completedAt, completedAt + 1);
  await page.waitForFunction(() => document.querySelector('[data-gallery-id="gallery-regression-new-z"]'), {}, { timeout: 12_000 });
  await waitCount(expectedIds().length);
  await assertOrder(expectedIds(), 'Newly completed images prepend at the top');
  await page.screenshot({ path: path.join(temporary, 'gallery-chronological-mobile.png') });

  const trashedId = 'gallery-regression-18';
  const beforeTrash = db.prepare('SELECT created_at,original_name FROM images WHERE id=?').get(trashedId);
  const deleted = await call('/api/images/batch-delete', { ids: [trashedId] });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.ok(deleted.data.deletedIds.includes(trashedId));
  for (const tier of ['thumbnail', 'preview', 'original']) {
    assert.ok(media.has(`/api/images/trash/${trashedId}/${tier}`), `${tier} trash route is accepted by the native contract`);
    assert.ok(!media.has(`/api/images/${trashedId}/${tier}`), `${tier} live route is removed`);
  }
  const listed = await call('/api/images/trash');
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.ok(listed.data.images.some(image => image.id === trashedId), 'trash list remains readable after delete');
  const deletedAt = db.prepare('SELECT deleted_at FROM image_trash WHERE id=?').get(trashedId).deleted_at;

  // Reopening the app must reconstruct media registrations from persisted trash rows.
  media.clear();
  await page.reload();
  await page.waitForFunction(() => globalThis.NAI_RUNTIME && !document.body.classList.contains('native-booting') && !document.querySelector('#appView').classList.contains('hidden'));
  await page.locator('[data-tab="gallery"]').click();
  await page.locator('#galleryScopeTrash').click();
  await page.waitForFunction(id => {
    const image = document.querySelector(`[data-trash-id="${id}"] img`);
    return image?.complete && image.naturalWidth > 0;
  }, trashedId);
  assert.ok(media.has(`/api/images/trash/${trashedId}/thumbnail`), 'trash thumbnail route is registered again after restart');
  assert.doesNotMatch(await page.locator('#galleryGrid').textContent(), /读取回收站失败/);
  await page.locator(`[data-trash-id="${trashedId}"] .gallery-trash-preview`).click();
  await page.waitForFunction(() => document.querySelector('#trashImagePreview').naturalWidth > 0 && document.querySelector('#trashImageStatus').textContent.includes('仍在回收站'));
  await page.locator('#trashLoadOriginal').click();
  await page.waitForFunction(() => {
    const image = document.querySelector('#trashImagePreview');
    return image.src.endsWith('/original') && image.complete && image.naturalWidth > 0;
  });
  assert.equal(db.prepare('SELECT deleted_at FROM image_trash WHERE id=?').get(trashedId).deleted_at, deletedAt, 'viewing does not extend trash retention');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM images WHERE id=?').get(trashedId).count, 0, 'preview does not restore the image');
  await page.screenshot({ path: path.join(temporary, 'trash-preview-after-restart.png') });
  await page.locator('#trashRestoreImage').click();
  await page.waitForFunction(() => !document.querySelector('#trashImageDialog').open);
  assert.equal(db.prepare('SELECT created_at FROM images WHERE id=?').get(trashedId).created_at, beforeTrash.created_at, 'restoring keeps original creation time');
  assert.equal(db.prepare('SELECT image_id FROM jobs WHERE id=?').get(`${trashedId}-job`).image_id, trashedId, 'restoring relinks the completed job');
  for (const tier of ['thumbnail', 'preview', 'original']) {
    assert.ok(media.has(`/api/images/${trashedId}/${tier}`), `${tier} live route is restored`);
    assert.ok(!media.has(`/api/images/trash/${trashedId}/${tier}`), `${tier} old trash route is removed`);
  }
  await page.locator('#galleryScopeGallery').click();
  await waitCount(30);
  await loadAll();
  await assertOrder(expectedIds(), 'Restored image returns to its chronological position');
  // After deleting the last card, a new completion must remove the empty message.
  // A direct-grid layout cannot rely on detached masonry columns to detect this reset.
  await page.locator('#gallerySelectToggle').click();
  await page.locator('#gallerySelectAll').click();
  await page.locator('#galleryDeleteSelected').click();
  await waitCount(0);
  await page.locator('#galleryExitSelection').click();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM images WHERE kind='gallery'").get().count, 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await addImage('gallery-regression-after-empty', 42, completedAt + 20_000, completedAt + 20_000);
  await waitCount(1);
  assert.doesNotMatch(await page.locator('#galleryGrid').textContent(), /暂无图片/, 'new completion replaces the empty gallery message');
  await assertOrder(expectedIds(), 'New completion after removing the last image');
  await page.locator('[data-tab="editor"]').click();
  console.log('PASS gallery regression: mixed proportions, row-major mobile/desktop order, pagination ties, completion prepend including empty-gallery transition, strict native trash routes, restart preview/original and restore lifecycle');
}
