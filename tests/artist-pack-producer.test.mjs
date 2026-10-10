import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {buildArtistPacks,artistShard,prepareArtistCollection} from '../scripts/build-artist-packs.mjs';
import {packFixture} from './artist-pack-fixtures.mjs';
import {APP_SCHEMA} from '../service/storage/schema.js';
import {createArtistPackInstaller} from '../service/artist-pack.js';
import {createArtistResourceStore} from '../service/storage/artist-resources.js';
import {runSteps} from '../service/port-flow.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'nai-pack-producer-')),images=path.join(temporary,'images'),sourceFile=path.join(temporary,'source.json');
await fs.mkdir(images);const fixture=packFixture();
const source={format:'nai-pocket-artist-collection',formatVersion:1,id:'test-artists',version:'1',title:'Synthetic resource producer',synthetic:true,artists:[]};
for(const [index,count] of [0,1,2,3,4].entries()) {
  const artist={artist:`Artist_${index}`,aliases:[`画师 ${index}`],examples:[]};
  for(let n=0;n<count;n++) {
    const example=structuredClone(fixture.manifest.artists[0].examples[0]);example.id=`example-${index}-${n}`;
    for(const tier of ['thumb','preview']){const name=`${example.id}-${tier}.png`;example.images[tier]={name,ext:'png'};await fs.writeFile(path.join(images,name),fixture.buffer);}
    example.observations=n===1?[]:[{...example.observations[0],id:`observation-${index}-${n}`,exampleId:example.id}];artist.examples.push(example);
  }
  source.artists.push(artist);
}
await fs.writeFile(sourceFile,JSON.stringify(source));
const output=path.join(temporary,'packs');const catalog=await buildArtistPacks({sourceFile,imageDirectory:images,outputDirectory:output});
assert.equal(catalog.artists,5);assert.equal(catalog.examples,10);assert.equal(catalog.annotatedExamples,7);
assert.deepEqual(catalog.artistsByExampleCount,{0:1,1:1,2:1,3:1,4:1});
await assert.rejects(fs.access(path.join(output,'INCOMPLETE.json')));
const database=new DatabaseSync(':memory:');database.exec(APP_SCHEMA);
const transaction=program=>{database.exec('BEGIN');try{const result=runSteps(program());database.exec('COMMIT');return result;}catch(error){database.exec('ROLLBACK');throw error;}};
const store=createArtistResourceStore(database,transaction),installer=createArtistPackInstaller({store});
const archives=[];
try {
  for(const [index,shard] of catalog.shards.entries()) {
    const file=path.join(output,shard.file),bytes=await fs.readFile(file);archives.push(file);
    assert.equal(hash(bytes),shard.sha256);assert.equal(bytes.length,shard.bytes);
    // Read stored entries for the real shared installer; the JVM archive reader
    // independently verifies these emitted ZIPs, including their CRCs.
    const entries=new Map();let offset=0;
    while(bytes.readUInt32LE(offset)===0x04034b50) {
      assert.equal(bytes.readUInt16LE(offset+8),0);
      const size=bytes.readUInt32LE(offset+18),nameSize=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28);
      const name=bytes.toString('utf8',offset+30,offset+30+nameSize),start=offset+30+nameSize+extra;
      assert.ok(!entries.has(name));entries.set(name,bytes.subarray(start,start+size));offset=start+size;
    }
    const manifest=JSON.parse(entries.get('manifest.json'));entries.delete('manifest.json');
    for(const artist of manifest.artists)assert.equal(shard.id,`${source.id}-${artistShard(artist.artist)}`);
    const files=[...entries].map(([name,buffer])=>({name,bytes:buffer.length,sha256:hash(buffer),mime:'image/png',width:2,height:2}));
    const installed=await installer.install({directory:`producer-${index}`,manifest,files});assert.equal(installed.examples,shard.examples);
  }
  const records=(await store.catalog()).profiles;assert.equal(records.length,5);
  assert.equal(records.reduce((sum,row)=>sum+row.example_count,0),10);assert.equal(records.reduce((sum,row)=>sum+row.annotated_count,0),7);
} finally {database.close();}
await fs.writeFile(path.join(temporary,'archives.json'),JSON.stringify(archives));
source.artists.reverse();await fs.writeFile(sourceFile,JSON.stringify(source));
const repeat=await buildArtistPacks({sourceFile,imageDirectory:images,outputDirectory:path.join(temporary,'repeat')});
assert.deepEqual(repeat,catalog,'reordered artists produce identical shard bytes and ownership');
await assert.rejects(buildArtistPacks({sourceFile,imageDirectory:images,outputDirectory:output}),error=>error.code==='EEXIST','never overwrite an earlier delivery');
// Public artwork provenance may use /home/ as a web route. Keep the exact URL
// while still rejecting local paths in plain text, JSON fragments and queries.
for(const route of ['/home/work/123.html','/assets/home/cover.png','/root/art/123']) {
  const valid=structuredClone(source),url='https://art.example.test'+route;
  valid.artists[0].examples[0].metadata={originalSourceUrl:url};
  await fs.writeFile(sourceFile,JSON.stringify(valid));
  const prepared=await prepareArtistCollection({sourceFile,imageDirectory:images});
  assert.equal(prepared.source.artists[0].examples[0].metadata.originalSourceUrl,url);
}
for(const value of ['/home/user/image.png','/root/private/file','/opt/app/file','/app/data/private.png',
  'source: /home/user/image.png','path=/home/user/image.png','["/home/user/image.png"]',
  'D:\\private\\image.png','https://art.example.test/?file=/home/user/image.png',
  'https://art.example.test/home/pst-'+'a'.repeat(40),'sk-'+'a'.repeat(35)]) {
  const invalid=structuredClone(source);invalid.artists[0].examples[0].metadata={originalSourceUrl:value};
  await fs.writeFile(sourceFile,JSON.stringify(invalid));
  await assert.rejects(prepareArtistCollection({sourceFile,imageDirectory:images}),/possible private credential or local path/);
}
for(const mutate of [
  value=>delete value.id,
  value=>value.artists.push({...value.artists[0]}),
  value=>value.artists[0].favorite=true,
  value=>value.artists[0].examples[0].images.thumb.name='../private.png',
  value=>value.artists[0].examples[0].images.thumb.sha256='0'.repeat(64),
  value=>value.artists[0].examples[0].metadata={token:'private'},
  value=>value.artists[0].examples[0].observations[0].reviewed=true,
  value=>value.artists[0].examples[0].observations[0].exampleId='unrelated'
]) {
  const invalid=structuredClone(source);mutate(invalid);await fs.writeFile(sourceFile,JSON.stringify(invalid));
  const invalidOutput=path.join(temporary,'invalid');await assert.rejects(buildArtistPacks({sourceFile,imageDirectory:images,outputDirectory:invalidOutput}));
  await assert.rejects(fs.access(invalidOutput),'invalid input never creates a publishable output');
}
console.log('Artist pack producer passed: stable shard ownership, byte integrity, paired annotations, honest coverage, independent installation, reproducibility and private-field rejection.');
console.log(`Producer fixture: ${temporary}`);
