import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APP_SCHEMA } from '../service/storage/schema.js';
import { runSteps } from '../service/port-flow.js';
import { createSchemesStore } from '../service/storage/schemes.js';
import { createSchemesService } from '../service/schemes.js';
import { createArtistBrowserStore } from '../service/storage/artist-browser.js';
import { createArtistBrowserService } from '../service/artist-browser.js';
import { sanitizeGenerationState } from '../public/generation-payload.js';

function fixture(asyncMode, includeArtistPreferences=true) {
  const database=new DatabaseSync(':memory:');database.exec(APP_SCHEMA);let sequence=0;
  const db=asyncMode?{prepare(sql){const statement=database.prepare(sql);return Object.fromEntries(['all','get','run'].map(method=>[method,async(...args)=>statement[method](...args)]));}}:database;
  const transaction=program=>{
    database.exec('BEGIN');
    const commit=value=>{database.exec('COMMIT');return value;},rollback=error=>{database.exec('ROLLBACK');throw error;};
    try {const result=runSteps(program());return result?.then?result.then(commit,rollback):commit(result);}catch(error){return rollback(error);}
  };
  const service=createSchemesService({store:createSchemesStore(db,transaction),clock:{now:()=>100},ids:{next:()=>`id-${++sequence}`},sanitizeState:sanitizeGenerationState,includeArtistPreferences});
  const artists=createArtistBrowserService({store:createArtistBrowserStore(db),clock:{now:()=>200}});
  const snapshot=()=>['schemes','snippets','artist_preferences'].map(table=>database.prepare(`SELECT * FROM ${table}`).all());
  return {database,service,artists,snapshot};
}

for (const asyncMode of [false,true]) {
  const source=fixture(asyncMode),target=fixture(asyncMode),legacy=fixture(asyncMode,false);
  try {
    await source.service.createScheme({name:'demo',data:{prompt:'artist:anmi'}});
    await source.service.saveSnippet({name:'tags',tags:['clouds']});
    await source.artists.save({artist:'anmi',favorite:true,note:'本机收藏'});
    await source.artists.save({artist:'my artist',favorite:false,note:'自定义画师'});
    const backup=await source.service.exportBackup();
    assert.equal(backup.format,'nai-pocket-backup-v1');
    assert.deepEqual(backup.artistPreferences,[{artist:'anmi',favorite:true,note:'本机收藏'},{artist:'my artist',favorite:false,note:'自定义画师'}]);
    assert.equal((await target.service.importBackup(backup)).artistPreferences,2);
    assert.deepEqual((await target.service.exportBackup()).artistPreferences,backup.artistPreferences,'round trip to a new installation');
    assert.equal((await target.service.listSchemes())[0].data.prompt,'artist:anmi');
    assert.equal((await target.service.listSnippets())[0].name,'tags');
    const before=target.snapshot();
    await target.service.importBackup({format:backup.format});
    await target.service.importBackup({format:backup.format,artistPreferences:[]});
    assert.deepEqual(target.snapshot(),before,'old/empty backups retain local artist records');
    const merged=await target.service.importBackup({format:backup.format,artistPreferences:[
      {artist:'artist:anmi',favorite:true,note:'earlier'},
      {artist:'ANMI',favorite:false,note:'replacement',token:'never-copy-this',examples:['private']}
    ]});
    assert.equal(merged.artistPreferences,1,'normalized duplicate names count once, last wins');
    const reexport=(await target.service.exportBackup()).artistPreferences;
    assert.deepEqual(reexport,[{artist:'anmi',favorite:false,note:'replacement'},{artist:'my artist',favorite:false,note:'自定义画师'}]);
    for (const bad of [null,{},[null],[{artist:'anmi',favorite:true}],[{artist:'anmi',favorite:1,note:''}],[{artist:'anmi',favorite:true,note:'x'.repeat(2001)}],Array(50001).fill({artist:'anmi',favorite:true,note:''})]) {
      const unchanged=target.snapshot();
      await assert.rejects(target.service.importBackup({format:backup.format,schemes:[{name:'bad-import',data:{prompt:'x'}}],artistPreferences:bad}),error=>error.status===400);
      assert.deepEqual(target.snapshot(),unchanged,'invalid artist input prevents all writes');
    }
    target.database.exec("CREATE TRIGGER refuse_artist BEFORE INSERT ON artist_preferences WHEN NEW.artist='refuse' BEGIN SELECT RAISE(ABORT,'fixture refusal'); END;");
    const rollback=target.snapshot();
    await assert.rejects(target.service.importBackup({format:backup.format,
      schemes:[{name:'rolled-back',data:{prompt:'new'}}],snippets:[{name:'rolled-back',tags:['new']}],
      artistPreferences:[{artist:'anmi',favorite:true,note:'rolled-back'},{artist:'refuse',favorite:true,note:''}]
    }),/fixture refusal/);
    assert.deepEqual(target.snapshot(),rollback,'late artist write failure rolls back all three tables');
    legacy.database.exec('DROP TABLE artist_preferences');
    assert.equal(Object.hasOwn(await legacy.service.exportBackup(),'artistPreferences'),false,'Node host needs no public-artist table');
    assert.deepEqual(await legacy.service.importBackup(backup),{ok:true,schemes:1,snippets:1},'Node legacy result remains unchanged');
  } finally {source.database.close();target.database.close();legacy.database.close();}
}
console.log('Artist backups passed: sync/async round trips, legacy compatibility, merge/validation, field allowlist and all-table rollback.');
