import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APP_SCHEMA } from '../service/storage/schema.js';
import { createArtistBrowserStore } from '../service/storage/artist-browser.js';
import { createArtistBrowserService } from '../service/artist-browser.js';

for(const asyncMode of [false,true]) {
  const database=new DatabaseSync(':memory:');database.exec(APP_SCHEMA);
  const db=asyncMode?{prepare(sql){const statement=database.prepare(sql);return Object.fromEntries(['all','get','run'].map(method=>[method,async(...args)=>statement[method](...args)]));}}:database;
  const store=createArtistBrowserStore(db);
  const service=createArtistBrowserService({store,names:['anmi','neki (wakiko)','kantoku'],clock:{now:()=>123}});
  try {
    const first=await service.list({limit:2});assert.equal(first.total,3);assert.equal(first.artists.length,2);assert.equal(first.favorites,0);
    await Promise.all([service.save({artist:'artist:neki_(wakiko)',favorite:true}),service.save({artist:'neki (wakiko)',note:'星空方案，待比较'})]);
    const profile=await service.get('NEKI_(WAKIKO)');assert.equal(profile.favorite,true);assert.equal(profile.note,'星空方案，待比较');
    assert.equal((await service.list()).artists[0].artist,'neki (wakiko)');
    assert.equal((await service.list({q:'星空'})).total,1);assert.equal((await service.list({favorite:'1'})).total,1);
    const last=await service.list({page:99,limit:2});assert.equal(last.page,2);assert.equal(last.artists.length,1);
    await service.save({artist:'my original artist',note:'自己的本机记录'});
    assert.equal((await service.list({q:'my_original_artist'})).artists[0].source,'local');
    assert.equal((await service.get('my original artist')).indexed,false);
    const reopened=createArtistBrowserService({store:createArtistBrowserStore(db),names:['anmi','neki (wakiko)','kantoku']});
    assert.equal((await reopened.get('neki (wakiko)')).favorite,true);assert.equal((await reopened.list({q:'星空'})).total,1);
    await service.save({artist:'neki (wakiko)',favorite:false});assert.equal((await service.get('neki (wakiko)')).note,'星空方案，待比较');
    for(const input of [{artist:'',favorite:true},{artist:'https://example.invalid',note:'x'},{artist:'anmi',favorite:'true'},{artist:'anmi',note:'x'.repeat(2001)},{artist:'anmi'}])await assert.rejects(service.save(input),error=>error.status===400);
    const failing=createArtistBrowserService({store:{...store,save:async()=>{throw new Error('disk failed');}},names:['anmi']});
    await assert.rejects(failing.save({artist:'anmi',favorite:true}),/disk failed/);assert.equal((await service.get('anmi')).favorite,false);
    const roster=[{artist:'Synthetic Roster Artist',aliases:['名单别名']},{artist:'anmi',aliases:[]}];
    const indexed=createArtistBrowserService({store,names:[],roster});
    const fresh=await indexed.get('synthetic_roster_artist');
    assert.equal(fresh.artist,'Synthetic Roster Artist');assert.equal(fresh.source,'built-in-roster');assert.equal(fresh.indexed,false);
    assert.deepEqual(fresh.aliases,['名单别名']);assert.equal(fresh.exampleCount,0);assert.deepEqual(fresh.examples,[]);
    assert.equal((await indexed.list({q:'名单别名'})).artists[0].artist,'Synthetic Roster Artist');
    const identities=await indexed.identities();assert.ok(identities.names.includes('Synthetic Roster Artist'));
    assert.deepEqual(identities.aliases,[['名单别名','Synthetic Roster Artist']]);
    assert.ok(identities.names.includes('my original artist'),'existing personal names are retained');
    const installed=createArtistBrowserService({store,names:[],roster,resources:{async catalog(){return {sets:[{id:'synthetic-pack'}],profiles:[
      {artist:'synthetic roster artist',displayName:'Synthetic Roster Artist',aliases:['更新别名'],exampleCount:3,annotatedCount:2,reviewedCount:0}
    ]};}}});
    const installedRows=await installed.list({q:'更新别名'});assert.equal(installedRows.total,1);assert.equal(installedRows.artists[0].source,'resource-pack');
    assert.equal(installedRows.artists[0].exampleCount,3);assert.equal((await installed.list({q:'名单别名'})).total,0,'installed metadata supersedes the frozen alias');
    assert.deepEqual((await installed.identities()).aliases,[['更新别名','Synthetic Roster Artist']]);
  }finally{database.close();}
}
console.log('Artist browser service passed: sync/async SQLite, partial-update preservation, local records, filters, paging, reopen, failed-save behavior and offline roster/alias precedence.');
