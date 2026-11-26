import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function runExperienceChecks({page,db,dataRoot,png,downloadEvents,media,folderPickerCount,temporary}) {
  const call=(url,body,method=body?'POST':'GET')=>page.evaluate(async({url,body,method})=>{
    const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,data:await r.json()};
  },{url,body,method});
  async function touch(selector) {
    const found=await page.locator(selector).evaluate(el=>{
      const r=el.getBoundingClientRect(),target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {width:r.width,height:r.height,left:r.left,right:r.right,top:r.top,bottom:r.bottom,visible:r.left>=0&&r.top>=0&&r.right<=innerWidth+.5&&r.bottom<=innerHeight+.5&&el.contains(target)};
    });
    assert.ok(found.visible,`${selector} visible and tappable: ${JSON.stringify(found)}`);
    assert.ok(found.height>=48,`${selector} has a 48px touch target`);
  }
  const optionIds=['qualityToggle','preferBrownian','varietyBoost','nativeAlpha'];
  function contrast(a,b) {
    const luminance=rgb=>rgb.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
  }
  async function visual(selector) {
    return page.locator(selector).evaluate(el=>{
      const ctx=document.createElement('canvas').getContext('2d');
      const rgba=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
      const style=getComputedStyle(el),mark=getComputedStyle(el,'::before');
      let bg=[255,255,255,255];
      for(const node of [...(function*(node){while(node){yield node;node=node.parentElement;}})(el)].reverse()){
        const color=rgba(getComputedStyle(node).backgroundColor),alpha=color[3]/255;
        bg=color.slice(0,3).map((v,i)=>v*alpha+bg[i]*(1-alpha)).concat(255);
      }
      return {color:rgba(style.color),background:bg,backgroundImage:style.backgroundImage,mark:mark.content,markOpacity:mark.opacity};
    });
  }
  async function setOption(id,checked) {
    if(await page.locator(`#${id}`).isChecked()!==checked)await page.locator(`#${id} + span`).click();
    assert.equal(await page.locator(`#${id}`).isChecked(),checked,`${id} responds to its visible label`);
  }
  async function savedOptions(checked) {
    await page.waitForFunction(({optionIds,checked})=>{
      const params=JSON.parse(localStorage.getItem('nai-pocket-editor-draft')||'null')?.data?.params;
      return params&&optionIds.every(id=>id==='varietyBoost'?(params[id]>0)===checked:params[id]===checked);
    },{optionIds,checked});
    return page.evaluate(()=>JSON.parse(localStorage.getItem('nai-pocket-editor-draft')).data);
  }
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.setViewportSize({width:390,height:844});
  const motion=await page.evaluate(async()=>{
    const frames=()=>document.querySelector('#editorTab').getAnimations().flatMap(animation=>animation.effect.getKeyframes());
    document.querySelector('[data-tab="queue"]').click();
    await Promise.resolve();
    document.querySelector('[data-tab="editor"]').click();
    await new Promise(requestAnimationFrame);
    return {frames:frames(),transform:getComputedStyle(document.querySelector('#editorTab')).transform};
  });
  assert.ok(motion.frames.length>0,'switching back to the editor triggers a short reveal');
  assert.ok(motion.frames.every(frame=>!('transform' in frame)),'page reveals do not re-anchor fixed action docks');
  assert.equal(motion.transform,'none');
  await touch('.floating-generate-button');
  const rapid=await page.evaluate(async()=>{
    for(const tab of ['queue','codex','editor']){
      document.querySelector(`[data-tab="${tab}"]`).click();
      await Promise.resolve();
    }
    return ['queue','codex','editor'].map(tab=>({tab,active:document.querySelector(`#${tab}Tab`).classList.contains('active'),animations:document.querySelector(`#${tab}Tab`).getAnimations().length}));
  });
  assert.deepEqual(rapid.filter(panel=>panel.active).map(panel=>panel.tab),['editor']);
  assert.ok(rapid.filter(panel=>!panel.active).every(panel=>panel.animations===0),'quick tab changes cancel hidden page animations');
  await page.locator('#mobileMoreButton').click();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#mobileMoreDialog')).opacity==='1');
  await page.evaluate(()=>fixtureApp.emit('backButton'));
  assert.equal(await page.locator('#mobileMoreDialog').evaluate(dialog=>dialog.open),false,'native Back updates dialog state immediately');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'mobileMoreButton','dialog close restores native focus');
  assert.equal(await page.locator('#mobileMoreButton').getAttribute('aria-expanded'),'false');
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#mobileMoreDialog')).display==='none');
  await page.locator('#mobileMoreButton').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#mobileMoreDialog').evaluate(dialog=>dialog.open),false,'Escape still closes animated dialogs');
  for (const width of [360,390,430]) {
    for (const height of [640,844]) {
      await page.setViewportSize({width,height});
      for(const name of ['editor','codex','gallery','queue'])await touch(`[data-tab="${name}"]`);
      assert.deepEqual(await page.locator('.workspace-nav-list [data-ef-nav="primary"]').evaluateAll(nodes=>nodes
        .sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left).map(node=>node.dataset.tab)),
      ['editor','codex','gallery','queue'],'frequently used Codex occupies the second mobile position');
      await touch('#mobileMoreButton');
      await page.locator('[data-tab="codex"]').click();
      assert.equal(await page.locator('#codexTab').isVisible(),true);
      assert.equal(await page.locator('[data-tab="codex"]').getAttribute('aria-current'),'page');
      await page.locator('[data-tab="queue"]').click();
      assert.equal(await page.locator('#queueTab').isVisible(),true);
      await page.locator('#mobileMoreButton').click();
      await page.locator('#mobileMoreDialog button').filter({hasText:'画师'}).click();
      assert.equal(await page.locator('#artistsTab').isVisible(),true);
      assert.equal(await page.locator('#mobileMoreButton').getAttribute('aria-current'),'page');
      await page.locator('#mobileMoreButton').click();
      await page.locator('#mobileMoreDialog button').filter({hasText:'Storm'}).click();
      await touch('#generateStormButton');
      await page.locator('[data-tab="editor"]').click();
      await touch('.floating-generate-button');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal document overflow');
    }
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('#openSettingsButton').click();
  await page.locator('#appearanceTheme').selectOption('dark');
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.locator('#appearanceTheme').selectOption('light');
  await page.locator('#closeSettingsButton').click();
  // Check the actual option labels and persisted generation state, not only CSS tokens.
  for(const [group,text] of [['scene','outdoors'],['camera','wide shot'],['style','watercolor'],['misc','soft light']]){
    if(!await page.locator(`[data-tag-input="${group}"]`).isVisible())await page.locator(`[data-section-add="${group}"]`).click();
    await page.locator(`[data-tag-input="${group}"]`).fill(text);
    await page.locator(`[data-tag-input="${group}"]`).press('Enter');
    await page.waitForFunction(group=>document.querySelector(`.tag-section[data-group="${group}"] .tag-chip`),group);
  }
  await page.locator('#model').selectOption({index:0});
  for(const theme of ['light','dark']){
    await page.locator('#openSettingsButton').click();
    await page.locator('#appearanceTheme').selectOption(theme);
    await page.locator('#closeSettingsButton').click();
    const off={};
    for(const id of optionIds)await setOption(id,false);
    const offState=await savedOptions(false);
    for(const id of optionIds){
      off[id]=await visual(`#${id} + span`);
      assert.ok(contrast(off[id].color,off[id].background)>=4.5,`${theme} ${id} unchecked label remains readable`);
    }
    const offPayload=await call('/api/payload-preview',{state:offState});
    assert.equal(offPayload.status,200,JSON.stringify(offPayload.data));
    assert.equal(offPayload.data.parameters.qualityToggle,false);
    assert.equal(offPayload.data.parameters.prefer_brownian,false);
    assert.equal(offPayload.data.parameters.skip_cfg_above_sigma,undefined);
    assert.equal(offPayload.data.parameters.straight_alpha,undefined);
    await page.locator('#optionStrip').screenshot({path:path.join(temporary,`options-off-${theme}.png`)});
    for(const id of optionIds)await setOption(id,true);
    const onState=await savedOptions(true);
    for(const id of optionIds){
      const on=await visual(`#${id} + span`);
      assert.ok(contrast(on.color,on.background)>=4.5,`${theme} ${id} checked label remains readable`);
      assert.notDeepEqual(on.background,off[id].background,`${theme} ${id} has distinct selected fill`);
      assert.notEqual(on.mark,off[id].mark,`${theme} ${id} has a non-color selected indicator`);
      assert.equal(on.markOpacity,'1');
      assert.equal(on.backgroundImage,'none',`${theme} ${id} has no distracting inherited texture`);
    }
    const onPayload=await call('/api/payload-preview',{state:onState});
    assert.equal(onPayload.status,200,JSON.stringify(onPayload.data));
    assert.equal(onPayload.data.parameters.qualityToggle,true);
    assert.equal(onPayload.data.parameters.prefer_brownian,true);
    assert.ok(onPayload.data.parameters.skip_cfg_above_sigma>0);
    assert.equal(onPayload.data.parameters.straight_alpha,true,'原生透明 still reaches the V5 generation payload');
    assert.equal(onPayload.data.parameters.tag_hint_transparent_background,true);
    assert.equal(onPayload.data.parameters.image_format,'png');
    await page.locator('#optionStrip').screenshot({path:path.join(temporary,`options-on-${theme}.png`)});
    const categoryColors=[],chipTints=[];
    for(const group of ['scene','camera','style','misc']){
      const heading=await visual(`.tag-section[data-group="${group}"] .tag-section-head strong`);
      assert.ok(contrast(heading.color,heading.background)>=4.5,`${theme} ${group} category heading contrast`);
      categoryColors.push(heading.color.join(','));
      const chip=await visual(`.tag-section[data-group="${group}"] .tag-chip .chip-line strong`);
      assert.ok(contrast(chip.color,chip.background)>=4.5,`${theme} ${group} tinted chip text remains readable`);
      chipTints.push(chip.background.join(','));
    }
    assert.equal(new Set(categoryColors).size,4,`${theme} categories retain distinct semantic colors`);
    assert.equal(new Set(chipTints).size,4,`${theme} category chips inherit their respective subtle tints`);
    await page.locator('#tagGroups').screenshot({
      path:path.join(temporary,`categories-${theme}.png`),
      style:'.workspace-topbar,.editor-command-bar,.floating-generate-bar,.workspace-nav,.toast-host { visibility:hidden!important; }'
    });
  }
  await page.reload();
  await page.waitForFunction(()=>!document.body.classList.contains('native-booting'));
  for(const id of optionIds)assert.equal(await page.locator(`#${id}`).isChecked(),true,`${id} survives reopening`);
  await page.locator('#model').selectOption('nai-diffusion-4-5-full');
  assert.equal(await page.locator('#nativeAlpha').isDisabled(),true,'V4 transparency remains unavailable');
  await page.locator('#model').selectOption({index:0});
  assert.equal(await page.locator('#nativeAlpha').isDisabled(),false,'V5 restores transparency availability');
  await page.locator('#openSettingsButton').click();
  await page.locator('#appearanceTheme').selectOption('light');
  await page.locator('#closeSettingsButton').click();
  // Real SQLite records and image bytes; the only mocked boundary is Android.
  await fs.mkdir(path.join(dataRoot,'originals'),{recursive:true});
  await fs.mkdir(path.join(dataRoot,'thumbnails'),{recursive:true});
  const insert=db.prepare('INSERT INTO images(id,job_id,batch_id,original_name,thumb_name,mime,width,height,bytes,thumb_bytes,prompt,negative_prompt,seed,params_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for(let i=1;i<=3;i++){
    const id=`experience-${i}`;
    db.prepare("INSERT INTO jobs(id,batch_id,position,status,request_json,seed,initiated_at,created_at) VALUES(?,'test-batch',?,'completed','{}',42,10,10)").run(`test-job-${i}`,i);
    insert.run(id,`test-job-${i}`,'test-batch',`${id}.png`,`${id}.webp`,'image/png',512,768,png.length,png.length,'synthetic fixture','',42,'{}',Date.now()+i);
    await fs.writeFile(path.join(dataRoot,'originals',`${id}.png`),png);
    await fs.writeFile(path.join(dataRoot,'thumbnails',`${id}.webp`),png);
  }
  await page.locator('[data-tab="gallery"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#galleryGrid .gallery-card').length===3);
  await page.locator('#gallerySelectToggle').click();
  await page.locator('#gallerySelectAll').click();
  await page.locator('#galleryDownloadSelected').click();
  await page.locator('#downloadOriginalButton').click();
  await page.waitForFunction(()=>document.querySelector('#galleryDownloadProgress').textContent.includes('已保存 3 / 3 张'));
  assert.equal(downloadEvents.length,3);
  for(const event of downloadEvents){assert.equal(event.destination,'album');assert.deepEqual(event.bytes,png,'original byte-for-byte metadata preservation');}
  await page.locator('#gallerySelectAll').click();
  await page.locator('#galleryDownloadSelected').click();
  await page.waitForFunction(()=>document.querySelector('#galleryDownloadProgress').textContent.includes('已保存 3 / 3 张')&&document.querySelector('#galleryCancelDownload').classList.contains('hidden'));
  assert.equal(await page.locator('#downloadChoiceDialog').evaluate(d=>d.open),false,'remembered metadata skips chooser');
  assert.equal(downloadEvents.length,6);
  await page.locator('#galleryExitSelection').click();
  await page.locator('#openSettingsButton').click();
  await page.locator('#downloadMetadataPreference').selectOption('clean');
  await page.locator('#downloadDestinationPreference').selectOption('folder');
  await page.locator('#closeSettingsButton').click();
  await page.locator('#gallerySelectToggle').click();
  await page.locator('#gallerySelectAll').click();
  await page.locator('#galleryDownloadSelected').click();
  await page.waitForFunction(()=>document.querySelector('#galleryDownloadProgress').textContent.includes('已保存 3 / 3 张')&&document.querySelector('#galleryCancelDownload').classList.contains('hidden'));
  assert.equal(folderPickerCount(),1,'folder authorized once for batch');
  assert.equal(downloadEvents.length,9);
  for(const event of downloadEvents.slice(6)){
    assert.equal(event.destination,'folder');assert.equal(event.mime,'image/png');
    assert.ok(!event.bytes.includes(Buffer.from('synthetic fixture')),'clean exports remove prompt text');
    assert.ok(!event.bytes.equals(png),'clean exports are re-encoded');
  }
  await page.locator('#galleryExitSelection').click();
  await page.locator('#gallerySelectToggle').click();
  await page.locator('[data-gallery-id="experience-1"]').click();
  await page.locator('[data-gallery-id="experience-2"]').click();
  await page.locator('#galleryDeleteSelected').click();
  await page.waitForFunction(()=>!document.querySelector('#galleryScopeTrash').hidden);
  await page.locator('#galleryExitSelection').click();
  const trash=await call('/api/images/trash');
  assert.equal(trash.data.images.length,2);
  assert.ok(media.has('/api/images/trash/experience-1/thumbnail'));
  assert.ok(!media.has('/api/images/experience-1/thumbnail'),'old route removed on trash');
  await page.locator('#galleryScopeTrash').click();
  await page.locator('.gallery-trash-preview').first().click();
  await page.waitForFunction(()=>document.querySelector('#trashImagePreview').naturalWidth>0&&document.querySelector('#trashImageStatus').textContent.includes('仍在回收站'));
  const current=await page.locator('#trashImageDialog').getAttribute('data-image-id');
  assert.equal((await call('/api/images/trash')).data.images.length,2,'viewing does not restore');
  await page.screenshot({path:path.join(temporary,'trash-preview.png')});
  await page.locator('#trashLoadOriginal').click();
  await page.waitForFunction(()=>document.querySelector('#trashImagePreview').complete&&document.querySelector('#trashImagePreview').naturalWidth>0);
  await page.locator('#trashRestoreImage').click();
  await page.waitForFunction(()=>!document.querySelector('#trashImageDialog').open);
  assert.equal((await call('/api/images/trash')).data.images.length,1);
  assert.ok(!media.has(`/api/images/trash/${current}/thumbnail`),'trash route removed after restore');
  assert.ok(media.has(`/api/images/${current}/thumbnail`));
  await page.reload();
  await page.waitForFunction(()=>!document.body.classList.contains('native-booting'));
  await page.waitForTimeout(1200);
  assert.ok(await page.locator('.toast').evaluateAll(nodes=>nodes.every(el=>el.getBoundingClientRect().height<200)),'toasts remain compact with a top and bottom navigation');
  await page.waitForFunction(()=>!document.querySelector('.toast'),{},{timeout:12000});
  assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
  await page.locator('#openSettingsButton').click();
  assert.equal(await page.locator('#downloadMetadataPreference').inputValue(),'clean');
  assert.equal(await page.locator('#downloadDestinationPreference').inputValue(),'folder');
  await page.locator('#appearanceTheme').selectOption('dark');
  await page.screenshot({path:path.join(temporary,'settings-dark.png')});
  await page.locator('#closeSettingsButton').click();
  await page.screenshot({path:path.join(temporary,'editor-dark.png')});
  for(const theme of ['light','dark']){
    await page.locator('#openSettingsButton').click();
    await page.locator('#appearanceTheme').selectOption(theme);
    await page.locator('#closeSettingsButton').click();
    for(const tab of ['editor','codex','artists','queue','gallery','storm','scheme']){
      await page.locator(`[data-tab="${tab}"]`).evaluate(b=>b.click());
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${theme} ${tab} fits mobile`);
      await page.screenshot({path:path.join(temporary,`${tab}-${theme}.png`)});
    }
  }
  await page.locator('[data-tab="editor"]').click();
  await page.setViewportSize({width:390,height:400});
  await touch('[data-tab="queue"]');
  await touch('.floating-generate-button');
  await page.locator('[data-tab="storm"]').evaluate(b=>b.click());
  await touch('#generateStormButton');
  await page.locator('[data-tab="editor"]').click();
  await page.setViewportSize({width:390,height:844});
  await page.locator('[data-tab="queue"]').evaluate(button=>button.click());
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>[...document.querySelectorAll('.tab-panel')].every(panel=>panel.getAnimations().length===0));
  await page.locator('[data-tab="editor"]').click();
  assert.equal(await page.locator('#editorTab').evaluate(panel=>panel.getAnimations().length),0,'reduced motion prevents page reveals');
  assert.equal(await page.locator('.floating-generate-button').evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
  await page.locator('#mobileMoreButton').click();
  assert.equal(await page.locator('#mobileMoreDialog').evaluate(dialog=>getComputedStyle(dialog).opacity),'1');
  assert.equal(await page.locator('#mobileMoreDialog').evaluate(dialog=>dialog.getAnimations().length),0,'reduced motion opens dialogs immediately');
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:1280,height:900});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(temporary,'desktop-dark.png')});
  console.log(`PASS experience: 6 mobile viewports, Codex/More/generation tap targets, light/dark option contrast and semantic categories/chip tints, all 4 option states and V5 transparency payload/persistence, animated page interruption/fixed docks/native Back/focus/Escape, batch original/clean bytes, folder reuse, trash preview/restore routes, reduced motion, desktop. Screenshots: ${temporary}`);
}
