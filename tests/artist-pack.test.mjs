import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APP_SCHEMA } from '../service/storage/schema.js';
import { runSteps } from '../service/port-flow.js';
import { createArtistResourceStore } from '../service/storage/artist-resources.js';
import { createArtistResourceService } from '../service/artist-resources.js';
import { createArtistPackInstaller,validateArtistPack,validateArtistPackDownload } from '../service/artist-pack.js';
import { createArtistBrowserStore } from '../service/storage/artist-browser.js';
import { createArtistBrowserService } from '../service/artist-browser.js';
import { packFixture } from './artist-pack-fixtures.mjs';

const url='https://github.com/example/resources/releases/download/v1/artist-pack.zip';
assert.equal(validateArtistPackDownload({url}).url,url);
for(const bad of [url.replace('https:','http:'),url.replace('github.com','github.com.evil.invalid'),url+'?token=fixture',url.replace('/releases/download/','/raw/'),url.replace('.zip','.exe')])assert.throws(()=>validateArtistPackDownload({url:bad}),error=>error.status===400);
assert.throws(()=>validateArtistPackDownload({url,sha256:'incorrect'}),error=>error.status===400);


for(const asyncMode of [false,true]) {
  const database=new DatabaseSync(':memory:');database.exec(APP_SCHEMA);
  const db=asyncMode?{prepare(sql){const statement=database.prepare(sql);return Object.fromEntries(['all','get','run'].map(method=>[method,async(...args)=>statement[method](...args)]));}}:database;
  const transaction=asyncMode?async program=>{database.exec('BEGIN');try{const result=await runSteps(program());database.exec('COMMIT');return result;}catch(error){database.exec('ROLLBACK');throw error;}}
    :program=>{database.exec('BEGIN');try{const result=runSteps(program());database.exec('COMMIT');return result;}catch(error){database.exec('ROLLBACK');throw error;}};
  const store=createArtistResourceStore(db,transaction),installer=createArtistPackInstaller({store});
  const reads=[];const resources=createArtistResourceService({store,files:{async stat(){return {isFile:true,size:100};},async read(path){reads.push(path);return packFixture().buffer;}}});
  const browser=createArtistBrowserService({store:createArtistBrowserStore(db),resources,names:[]});
  try {
    assert.deepEqual(await store.activeDirectories(),[]);
    database.prepare('INSERT INTO artist_resource_sets(id,version,title) VALUES (?,?,?)').run('legacy-empty','1','Prepared legacy set');
    assert.deepEqual(await store.activeDirectories(),['legacy-empty'],'even an empty legacy set protects its directory');
    await browser.save({artist:'fixture_artist',favorite:true,note:'自己的备注'});
    assert.equal((await installer.install(packFixture())).installed,true);
    await assert.rejects(installer.install(packFixture()),error=>error.status===409,'active directories cannot be reused as staging');
    const initial=await browser.get('fixture_artist');assert.equal(initial.note,'自己的备注');assert.equal(initial.favorite,true);assert.equal(initial.observations[0].note,'合成标注');
    await resources.image('pack-example');assert.match(reads.at(-1),/staged-one\/pack-example-thumb.png$/);
    const updated=packFixture({version:'two',directory:'staged-two'});updated.manifest.artists[0].examples[0].observations[0].reviewed=true;
    assert.equal((await installer.install(updated)).previousDirectory,'staged-one');
    assert.deepEqual((await store.activeDirectories()).sort(),['legacy-empty','staged-two'],'only the committed replacement is protected at next startup');
    await assert.rejects(resources.image('pack-example','preview',{revision:initial.resourceSet.revision}),error=>error.status===409,'old annotations cannot silently show a newer image version');
    assert.equal((await browser.get('fixture_artist')).observations[0].reviewed,true);
    await resources.image('pack-example');assert.match(reads.at(-1),/staged-two\/pack-example-thumb.png$/);
    for(const mutate of [
      pack=>pack.files[0].sha256='0'.repeat(64),pack=>pack.files.pop(),pack=>pack.files.push(pack.files[0]),
      pack=>pack.manifest.artists[0].examples[0].observations[0].exampleId='other-image',
      pack=>pack.manifest.artists[0].examples[0].images.thumb.name='../secret.png',
      pack=>pack.manifest.artists[0].examples[0].sourceType='generated',
      pack=>pack.manifest.artists[0].examples[0].observations[0].reviewed='false',
      pack=>pack.files[0].width=32000001,pack=>pack.files[0].mime='image/svg+xml'
    ]) {
      const invalid=structuredClone(packFixture({version:'bad',directory:'bad-stage'}));mutate(invalid);
      await assert.rejects(installer.install(invalid),error=>error.status===400);
      assert.equal((await browser.get('fixture_artist')).resourceSet.version,'two');
    }
    const other=packFixture();other.manifest.id='pack-b';await assert.rejects(installer.install(other),error=>error.status===409);
    database.exec("CREATE TRIGGER refuse_resource_observation BEFORE INSERT ON artist_resource_observations WHEN NEW.note='fail-late' BEGIN SELECT RAISE(ABORT,'late install failure'); END;");
    const late=packFixture({version:'three',directory:'staged-three'});late.manifest.artists[0].examples[0].observations[0].note='fail-late';
    await assert.rejects(installer.install(late),/late install failure/);
    const preserved=await browser.get('fixture_artist');assert.equal(preserved.resourceSet.version,'two');assert.equal(preserved.observations[0].reviewed,true);assert.equal(preserved.note,'自己的备注');
    assert.deepEqual((await store.activeDirectories()).sort(),['legacy-empty','staged-two'],'rolled-back staging must not become an active directory');
    await resources.image('pack-example');assert.match(reads.at(-1),/staged-two\/pack-example-thumb.png$/,'late rollback restores both metadata and active file directory');
    const duplicate=packFixture().manifest;duplicate.artists.push({...duplicate.artists[0],artist:'fixture artist'});assert.throws(()=>validateArtistPack(duplicate),/重复/);
  } finally {database.close();}
}
console.log('Artist pack passed: strict manifest/bytes/identity checks, sync/async atomic update, late rollback, cross-pack protection and independent preferences.');
