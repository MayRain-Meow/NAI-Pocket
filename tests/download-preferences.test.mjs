import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readDownloadPreferences, writeDownloadPreferences, saveGalleryImages } from '../public/download-preferences.js';
test('download preferences survive reload and invalid storage safely', () => {
  const data = new Map(), storage = { getItem:k=>data.get(k), setItem:(k,v)=>data.set(k,v) };
  assert.deepEqual(readDownloadPreferences(storage), { metadata:'ask', destination:'album' });
  writeDownloadPreferences({ metadata:'clean', destination:'folder' }, storage);
  assert.deepEqual(readDownloadPreferences(storage), { metadata:'clean', destination:'folder' });
  writeDownloadPreferences({ destination:'ask' }, storage);
  assert.equal(readDownloadPreferences(storage).metadata, 'clean');
  data.set('nai-pocket-download-preferences-v1', '{broken');
  assert.equal(readDownloadPreferences(storage).metadata, 'ask');
});
test('batch download deduplicates, runs serially and uses selected metadata', async () => {
  let active=0; const urls=[],progress=[];
  const result = await saveGalleryImages({ ids:['a','a','b c'], mode:'original', destination:'album',
    download:async(url,options)=>{ assert.equal(active++,0); urls.push(url); assert.equal(options.destination,'album'); await Promise.resolve(); active--; return true; },
    onProgress:p=>progress.push(p.completed) });
  assert.deepEqual(result.saved,['a','b c']); assert.deepEqual(progress,[1,2]);
  assert.deepEqual(urls,['/api/images/a/original?download=1','/api/images/b%20c/original?download=1']);
});
test('partial failure and cancellation retain accurate completed IDs', async () => {
  let calls=0;
  const failed=await saveGalleryImages({ids:['a','b','c'],mode:'clean',download:async()=>{if(++calls===2)throw Error('folder unavailable');return true;}});
  assert.deepEqual(failed.saved,['a']); assert.equal(failed.failed[0].id,'b'); assert.equal(calls,2);
  let stop=false;
  const cancelled=await saveGalleryImages({ids:['a','b'],mode:'clean',download:async()=>true,onProgress:()=>{stop=true;},cancelled:()=>stop});
  assert.deepEqual(cancelled.saved,['a']); assert.equal(cancelled.cancelled,true);
  const chooser=await saveGalleryImages({ids:['a','b'],mode:'clean',download:async()=>false});
  assert.equal(chooser.saved.length,0); assert.equal(chooser.cancelled,true);
});
