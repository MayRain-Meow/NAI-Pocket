import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APP_SCHEMA } from '../service/storage/schema.js';
import { createArtistResourceStore } from '../service/storage/artist-resources.js';
import { createArtistResourceService } from '../service/artist-resources.js';
import { createArtistBrowserStore } from '../service/storage/artist-browser.js';
import { createArtistBrowserService } from '../service/artist-browser.js';
import { seedArtistResources } from './artist-resources-fixtures.mjs';
import { makePngFixture } from './png-metadata-fixtures.mjs';

const png=makePngFixture({width:2,height:2,rgba:Buffer.alloc(16,255)});
for(const asyncMode of [false,true]) {
  const native=new DatabaseSync(':memory:');native.exec(APP_SCHEMA);
  const db=asyncMode?{prepare(sql){const statement=native.prepare(sql);return Object.fromEntries(['all','get','run'].map(method=>[method,async(...args)=>statement[method](...args)]));}}:native;
  const missing=()=>Object.assign(new Error('missing'),{code:'ENOENT'});
  const bytes=new Map();let readCount=0;
  const files={async stat(path){if(!bytes.has(path))throw missing();return {isFile:true,size:bytes.get(path).length};},async read(path){readCount++;if(!bytes.has(path))throw missing();return bytes.get(path);}};
  const resources=createArtistResourceService({store:createArtistResourceStore(db),files});
  const browser=createArtistBrowserService({store:createArtistBrowserStore(db),resources,names:['anmi','uncollected']});
  try {
    assert.equal((await browser.list()).resources.installed,false);
    for(const item of seedArtistResources(native))bytes.set(item.path,png);
    const catalog=await browser.list();assert.equal(catalog.resources.installed,true);assert.equal(catalog.resources.artists,3);assert.equal(readCount,0,'listing does not decode/load images');
    const profile=await browser.get('artist:ANMI');
    assert.deepEqual(profile.examples.map(item=>item.id),['fixture-anmi-1','fixture-anmi-2','fixture-anmi-3']);
    assert.equal(profile.exampleCount,3);assert.equal(profile.annotatedCount,2);assert.equal(profile.reviewedCount,1);
    assert.equal(profile.observations[0].exampleId,'fixture-anmi-1');assert.equal(profile.observations[0].automatic,true);assert.equal(profile.observations[0].reviewed,false);
    assert.deepEqual(profile.observations[0].provenance,{kind:'synthetic-fixture',exampleId:'fixture-anmi-1'});
    assert.equal(profile.observations[1].reviewed,true);assert.equal(profile.observations[1].automatic,false);
    assert.equal((await browser.list({q:'合成别名'})).artists[0].artist,'anmi');
    assert.deepEqual((await browser.identities()).aliases,[['合成别名','anmi']]);
    const match=await browser.list({attributes:JSON.stringify({'line.weight':['fine'],'palette.temperature':['warm']})});
    assert.deepEqual(match.artists.map(item=>item.artist),['fixture_same_image'],'different images may not combine their style evidence');
    assert.equal((await browser.list({q:'anmi',attributes:{'line.weight':['fine']}})).total,1,'AI initial observations participate by default');
    assert.equal((await browser.list({q:'anmi',attributes:{'line.weight':['fine']},confirmed:'1'})).total,0);
    assert.equal((await browser.list({q:'anmi',attributes:{'line.weight':['bold']},confirmed:'1'})).total,1);
    for(const attributes of ['{',null,{'unknown.key':['fine']},{'line.weight':['invalid']}])if(attributes!==null)await assert.rejects(browser.list({attributes}),error=>error.status===400);
    assert.equal((await browser.get('uncollected')).examples.length,0,'no NAX substitutions');
    assert.equal((await browser.get('fixture_no_image')).exampleCount,1,'resource producer stores normalized identities while preserving display names');
    assert.equal((await browser.list({q:'fixture_no_image'})).total,1);
    assert.deepEqual((await resources.image('fixture-anmi-1','preview')).buffer,png);
    await assert.rejects(resources.image('fixture-missing-1'),error=>error.status===404&&/尚未下载/.test(error.message));
    for(const [id,tier] of [['../outside','thumb'],['fixture-anmi-1','../../vault'],['unknown','thumb']])await assert.rejects(resources.image(id,tier),error=>[400,404].includes(error.status));
    native.prepare("INSERT INTO artist_resource_sets(id,version,title) VALUES ('../outside','bad','bad')").run();
    native.prepare("UPDATE artist_resource_profiles SET set_id='../outside' WHERE artist='anmi'").run();
    await assert.rejects(resources.image('fixture-anmi-1'),error=>error.status===422);
    native.prepare("UPDATE artist_resource_profiles SET set_id='fixture-v1' WHERE artist='anmi'").run();
    bytes.set('artist-resources/fixture-v1/fixture-anmi-1-thumb.png',Buffer.alloc(4*1024*1024+1));
    const before=readCount;await assert.rejects(resources.image('fixture-anmi-1'),error=>error.status===422);assert.equal(readCount,before,'size bound checked before bridge allocation');
    const controller=new AbortController();controller.abort();await assert.rejects(resources.image('fixture-anmi-2','thumb',{signal:controller.signal}),{name:'AbortError'});
    const saved=await browser.save({artist:'anmi',favorite:true,note:'个人记录'});
    assert.equal(saved.coverUrl,profile.examples[0].thumbUrl,'preference updates retain the readable cover');
    native.prepare("UPDATE artist_resource_sets SET version='demo-2'").run();
    const updated=await browser.get('anmi');assert.equal(updated.resourceSet.version,'demo-2');assert.equal(updated.favorite,true);assert.equal(updated.note,'个人记录');
    assert.equal(updated.observations[0].note,profile.observations[0].note,'personal notes never rewrite prepared annotations');
  } finally {native.close();}
}
for(const asyncMode of [false,true]) {
  const native=new DatabaseSync(':memory:');native.exec(APP_SCHEMA);
  native.prepare("INSERT INTO artist_resource_sets(id,version,title) VALUES ('many','1','Synthetic bounded scan')").run();
  native.exec('BEGIN');
  for(let index=0;index<520;index++) {
    const key=`page-${String(index).padStart(3,'0')}`;
    native.prepare('INSERT INTO artist_resource_profiles(artist,display_name,set_id) VALUES (?,?,?)').run(key,key,'many');
    native.prepare('INSERT INTO artist_resource_examples(id,artist,position) VALUES (?,?,0)').run(key,key);
    native.prepare('INSERT INTO artist_resource_observations(id,example_id,attributes_json,schema_version,source,reviewed) VALUES (?,?,?,2,?,?)')
      .run(key,key,JSON.stringify({'line.weight':['fine'],'palette.temperature':[index===519?'warm':'cool']}),[256,519].includes(index)?'manual':'assistant-visual',index===519?1:0);
  }
  native.exec('COMMIT');
  let tail=Promise.resolve(),queuedWrite,cancelAfterPage;const pages=[];
  const serial=work=>{const result=tail.then(work);tail=result.catch(()=>{});return result;};
  const db={prepare(sql){const statement=native.prepare(sql);return Object.fromEntries(['all','get','run'].map(method=>[method,(...args)=>{
    const result=statement[method](...args);
    if(method==='all'&&sql.includes('ORDER BY o.id LIMIT')) {
      pages.push(result);
      cancelAfterPage?.abort();
      if(asyncMode&&pages.length===1&&!queuedWrite)queuedWrite=serial(()=>native.prepare("UPDATE artist_resource_observations SET attributes_json=? WHERE id='page-519'").run(JSON.stringify({'line.weight':['fine'],'palette.temperature':['cool']})));
    }
    return asyncMode?Promise.resolve(result):result;
  }]));}};
  const commands=createArtistResourceStore(db),store=asyncMode?Object.fromEntries(Object.entries(commands).map(([name,command])=>[name,(...args)=>serial(()=>command(...args))])):commands;
  const service=createArtistResourceService({store,files:{}});
  try {
    assert.deepEqual([...(await service.matching({attributes:{'line.weight':['fine'],'palette.temperature':['warm']}}))],['page-519'],'late-page match survives a concurrent queued metadata change');
    assert.equal(pages.flat().length,519,'unreviewed manual drafts are excluded before crossing the bridge');
    assert.ok(pages.length>1&&pages.every(rows=>rows.length<=256),'the full evidence table must never cross as one native response');
    assert.equal(new Set(pages.flat().map(row=>row.id)).size,519,'keyset pages have no skipped or repeated observation');
    if(queuedWrite)await queuedWrite;
    pages.length=0;
    assert.deepEqual([...(await service.matching({confirmedOnly:true}))],['page-519']);
    assert.equal(pages.flat().length,1,'confirmed-only sends only eligible evidence');
    pages.length=0;cancelAfterPage=new AbortController();
    await assert.rejects(service.matching({attributes:{'line.weight':['fine']},signal:cancelAfterPage.signal}),{name:'AbortError'});
    assert.equal(pages.length,1,'a superseded filter stops before reading another batch');
    pages.length=0;
    await assert.rejects(service.matching({signal:cancelAfterPage.signal}),{name:'AbortError'});
    assert.equal(pages.length,0,'an already cancelled scan performs no query');cancelAfterPage=null;
    assert.equal((await service.matching({confirmedOnly:true})).size,1,'cancelled scans release the serialized command queue');
  } finally {native.close();}
}
console.log('Artist resources passed: sync/async SQLite, three-image correspondence, same-observation filters, bounded evidence pages, serialized scan consistency, AI/review distinction and local file bounds.');
