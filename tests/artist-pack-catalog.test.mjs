import assert from 'node:assert/strict';
import { validateArtistPackCatalog,ARTIST_CATALOG_BYTES } from '../service/artist-pack-catalog.js';
import { validateArtistPackDownload,createArtistPackInstaller } from '../service/artist-pack.js';
import { catalogFixture } from './artist-pack-fixtures.mjs';
const url='https://github.com/example/resources/releases/download/feature%2Fv1/catalog.json';
const {catalog,staged}=catalogFixture(),validated=validateArtistPackCatalog(catalog,url),row=validated.shards[0];
assert.equal(row.url,url.replace('catalog.json','catalog-test-10.zip'));
assert.deepEqual(validateArtistPackDownload(row),{url:row.url,sha256:'a'.repeat(64),expectedId:row.id,expectedVersion:row.version});
for(const mutate of [
  value=>value.shards[0].file='../private.zip',value=>value.shards[0].file='https://evil.invalid/p.zip',
  value=>value.shards[0].id='catalog-test-ff',value=>value.shards.push(value.shards[0]),
  value=>value.shards[0].bytes=256*1024*1024+1,value=>value.shards[0].sha256='invalid',
  value=>value.shards[0].version='another',value=>value.artists++,value=>value.examples++,
  value=>value.shards[0].artistNames=[],value=>value.shards[0].artistNames=['https://private.invalid'],
  value=>value.shards[0].manualReviewedExamples=2,value=>value.artistsByExampleCount[0]=1,
  value=>value.shards[0].artistNames=[null],value=>value.padding='x'.repeat(ARTIST_CATALOG_BYTES)
]){const invalid=structuredClone(catalog);mutate(invalid);assert.throws(()=>validateArtistPackCatalog(invalid,url),error=>error.status===400);}
for(const bad of [url.replace('https:','http:'),url+'?token=fixture',url.replace('github.com','evil.invalid'),url.replace('.json','.zip')])assert.throws(()=>validateArtistPackCatalog(catalog,bad),error=>error.status===400);
let installed=0;const installer=createArtistPackInstaller({store:{install:async()=>{installed++;return {};}}});
await assert.rejects(installer.install(staged,{expectedId:'wrong',expectedVersion:row.version}),error=>error.status===400);
await assert.rejects(installer.install(staged,{expectedId:row.id,expectedVersion:'wrong'}),error=>error.status===400);
assert.equal(installed,0,'catalog mismatch must be rejected before any metadata mutation');
await installer.install(staged,row);assert.equal(installed,1);
assert.throws(()=>validateArtistPackDownload({...row,sha256:''}),error=>error.status===400,'catalog-bound installation requires archive integrity');
console.log('Artist catalog passed: bounded public URLs, same-release files, coverage/name consistency, integrity and pre-transaction identity binding.');
