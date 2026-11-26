import assert from 'node:assert/strict';
import path from 'node:path';

// Run against the real editor with the offline harness; no generation is requested.
export async function runPromptSelectionChecks({ page, temporary }) {
  const chips = group => page.locator(`.tag-chip[data-group="${group}"]`);
  const texts = group => chips(group).locator('.chip-line strong').allTextContents();
  const select = (group, text) => chips(group).filter({ has: page.locator('.chip-line strong', { hasText: text }) }).locator('.tag-copy').click();
  const count = async n => assert.match(await page.locator('#tagBatchActions').innerText(), new RegExp(`已选 ${n} 个 Tag`));
  async function add(group, text) {
    const input = page.locator(`[data-tag-input="${group}"]`);
    if (!await input.isVisible()) await page.locator(`[data-section-add="${group}"]`).click();
    await input.fill(text);
    if (group === 'scene') {
      // The artist index refreshes asynchronously at boot and after resource
      // changes. Exercise the real rerender while an empty section is being
      // edited; a refresh must retain both the open input and its unsaved text.
      const oldInput = await input.elementHandle();
      await page.evaluate(() => window.dispatchEvent(new Event('nai-artist-resources-changed')));
      await page.waitForFunction(el => !el.isConnected, oldInput);
      await page.waitForFunction(({ group, text }) => {
        const current = document.querySelector(`[data-tag-input="${group}"]`);
        return current?.getClientRects().length && current.value === text && document.activeElement === current;
      }, { group, text });
      await oldInput.dispose();
    }
    await input.press('Enter');
    await page.waitForFunction(({ group }) => !document.querySelector(`[data-tag-input="${group}"]`).disabled, { group });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('#appView')?.getAttribute('aria-busy') === 'false');
  await page.locator('[data-tab="editor"]').click();
  await add('scene', '1.3::batch first::, batch second, 0.7::batch third::');
  await add('camera', 'batch existing');
  await page.locator('#tagMultiSelectButton').click();
  await count(0);
  // Click in reverse order: the destination must still keep the source order.
  await select('scene', 'batch third');
  await select('scene', 'batch first');
  await count(2);
  assert.equal(await page.locator('#tagMultiSelectButton').getAttribute('aria-pressed'), 'true');
  assert.equal(await chips('scene').filter({ has: page.locator('.chip-line strong', { hasText: 'batch first' }) }).locator('.tag-copy').getAttribute('aria-pressed'), 'true');
  // Tapping another area must not silently cancel an explicit batch selection.
  await page.locator('#promptMeterText').click();
  await count(2);
  for (const theme of ['light', 'dark']) {
    await page.locator('#openSettingsButton').click();
    await page.locator('#appearanceTheme').selectOption(theme);
    await page.locator('#closeSettingsButton').click();
    for (const width of [360, 390, 430, 1280]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      await page.locator('#tagBatchActions').scrollIntoViewIfNeeded();
      const layout = await page.locator('#tagBatchActions').evaluate(host => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        controls: [...host.querySelectorAll('button,select')].map(el => {
          const r = el.getBoundingClientRect();
          return { width: r.width, height: r.height, left: r.left, right: r.right };
        })
      }));
      assert.equal(layout.overflow, false, `${theme} ${width}px has no horizontal overflow`);
      assert.ok(layout.controls.every(r => r.height >= 44 && r.width > 0 && r.left >= 0 && r.right <= width + 1), JSON.stringify(layout));
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // Exercise the actual mobile destination sheet, not only a synthetic change event.
  await page.locator('[data-tag-batch="move"]').click();
  await page.locator('.select-sheet[open]').getByRole('option', { name: '全局 · 镜头', exact: true }).click();
  assert.deepEqual(await texts('scene'), ['batch second']);
  assert.deepEqual(await texts('camera'), ['batch existing', 'batch first', 'batch third']);
  assert.match(await chips('camera').filter({ hasText: 'batch first' }).innerText(), /×1.3/);
  assert.match(await chips('camera').filter({ hasText: 'batch third' }).innerText(), /×0.7/);
  await count(0);
  await page.locator('[data-history="undo"]').click();
  assert.deepEqual(await texts('scene'), ['batch first', 'batch second', 'batch third'], 'one undo restores the whole batch');
  assert.deepEqual(await texts('camera'), ['batch existing']);
  await page.locator('[data-history="redo"]').click();
  assert.deepEqual(await texts('camera'), ['batch existing', 'batch first', 'batch third']);
  // Same-area moves do not reorder or introduce an extra undo step.
  await select('camera', 'batch third');
  await select('camera', 'batch first');
  await page.locator('[data-tag-batch="move"]').selectOption('g|camera');
  assert.deepEqual(await texts('camera'), ['batch existing', 'batch first', 'batch third']);
  await page.locator('[data-history="undo"]').click();
  assert.deepEqual(await texts('scene'), ['batch first', 'batch second', 'batch third']);
  await count(0);
  // A selection survives switching sides; moving from UC must remove its source text.
  await page.locator('[data-edit-side="negative"]').click();
  await page.locator('#ucChipInput').fill('1.4::batch negative first::, batch negative second');
  await page.locator('#ucChipInput').press('Enter');
  await page.locator('.tag-chip[data-uc-chip]').filter({ hasText: 'batch negative first' }).locator('.tag-copy').click();
  await page.locator('.tag-chip[data-uc-chip]').filter({ hasText: 'batch negative second' }).locator('.tag-copy').click();
  await count(2);
  await page.locator('[data-edit-side="positive"]').click();
  await count(2);
  await page.locator('[data-tag-batch="move"]').selectOption('g|misc');
  assert.match((await texts('misc')).join(','), /batch negative first,batch negative second/);
  assert.doesNotMatch(await page.locator('#negativePrompt').inputValue(), /batch negative/);
  await page.locator('[data-history="undo"]').click();
  assert.match(await page.locator('#negativePrompt').inputValue(), /1.4::batch negative first::, batch negative second/);
  assert.deepEqual(await texts('misc'), []);
  // Character destinations preserve the selected order and allow one-step undo.
  await page.locator('#addCharacterButton').click();
  const characterId = await page.locator('[data-character-card]').last().getAttribute('data-character-card');
  await select('scene', 'batch third');
  await select('scene', 'batch first');
  await page.locator('[data-tag-batch="move"]').selectOption(`c|${characterId}|prompt`);
  assert.deepEqual(await texts('scene'), ['batch second']);
  await page.locator('[data-history="undo"]').click();
  assert.deepEqual(await texts('scene'), ['batch first', 'batch second', 'batch third']);
  // Select-all uses visible chips, and bulk delete is a single undoable change.
  const visible = await page.locator('#editorTab .tag-chip').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden').length);
  await page.locator('[data-tag-batch="all"]').click();
  await count(visible);
  await page.locator('[data-tag-batch="delete"]').click();
  await count(0);
  assert.deepEqual(await texts('scene'), []);
  await page.locator('[data-history="undo"]').click();
  assert.deepEqual(await texts('scene'), ['batch first', 'batch second', 'batch third']);
  await page.screenshot({ path: path.join(temporary, 'prompt-batch-selection-mobile.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#tagMultiSelectButton').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#tagBatchActions').isVisible(), false);
  await page.locator('#commandMenuButton').click();
  await page.locator('#quickDeleteButton').click();
  assert.equal(await page.locator('#commandMenu').isVisible(), false, 'quick delete closes the overflow menu');
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('quick-delete')), true);
  await page.locator('#tagMultiSelectButton').click();
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('quick-delete')), false, 'batch selection disables quick delete');
  await select('scene', 'batch first');
  await select('scene', 'batch third');
  await count(2);
  assert.deepEqual(await texts('scene'), ['batch first', 'batch second', 'batch third'], 'selection never deletes tags');
  await page.screenshot({ path: path.join(temporary, 'prompt-batch-selected-mobile.png') });
  await page.locator('#tagMultiSelectButton').click();
  assert.equal(await page.locator('#tagBatchActions').isVisible(), false);
  console.log(`PASS prompt batch selection: mobile/desktop light+dark layout, visible select-all, cross-area and character moves, source order/weights, UC source synchronization, one-step undo/redo, same-source no-op, cancel. Screenshot: ${temporary}`);
}
