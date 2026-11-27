import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APP_SCHEMA } from '../service/storage/schema.js';
import { createQueueControl } from '../service/queue-control.js';
import { runSteps } from '../service/port-flow.js';

for (const asynchronous of [false, true]) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(APP_SCHEMA);
  const db = asynchronous ? { prepare(sql) {
    const statement = sqlite.prepare(sql);
    return Object.fromEntries(['all', 'get', 'run'].map(method => [method, async (...values) => statement[method](...values)]));
  } } : sqlite;
  const transaction = asynchronous ? async program => {
    sqlite.exec('BEGIN');
    try { const value = await runSteps(program()); sqlite.exec('COMMIT'); return value; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } : program => {
    sqlite.exec('BEGIN');
    try { const value = runSteps(program()); sqlite.exec('COMMIT'); return value; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  };
  const active = new Map([['active', {}]]);
  const control = createQueueControl({ db, transaction, activeJobControllers: active });
  const insert = sqlite.prepare("INSERT INTO jobs(id,batch_id,position,status,request_json,seed,initiated_at,created_at) VALUES (?,'test',1,?,'{}',42,1,1)");
  for (const [id, status] of [['single','failed'],['bulk','failed'],['active','failed'],['saved','failed'],['trashed','failed'],['waiting','pending'],['working','running'],['done','completed'],['cancelled','cancelled']]) {
    insert.run(id, status);
    sqlite.prepare("INSERT INTO job_logs(job_id,message,created_at) VALUES (?,'test',1)").run(id);
  }
  sqlite.prepare(`INSERT INTO images(id,job_id,batch_id,original_name,thumb_name,mime,bytes,thumb_bytes,prompt,negative_prompt,params_json,seed,created_at)
    VALUES ('saved-image','saved','test','test.png','test.webp','image/png',1,1,'','','{}',42,1)`).run();
  sqlite.prepare("INSERT INTO image_trash(id,row_json,created_at,deleted_at) VALUES ('trash',?,1,1)").run(JSON.stringify({ job_id: 'trashed' }));
  for (const id of ['waiting','working','done','cancelled','active','saved','trashed','missing']) {
    assert.equal((await control.deleteFailedJobs(id)).ok, false, `protect ${id}`);
  }
  assert.deepEqual(await control.deleteFailedJobs('single'), { ok: true, deleted: 1, skipped: 0 });
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM job_logs WHERE job_id='single'").get().n, 0);
  assert.deepEqual(await control.deleteFailedJobs(), { ok: true, deleted: 1, skipped: 3 });
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM images').get().n, 1);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM image_trash').get().n, 1);
  active.clear();
  assert.deepEqual(await control.deleteFailedJobs(), { ok: true, deleted: 1, skipped: 2 });
  insert.run('malformed-guard', 'failed');
  sqlite.prepare("UPDATE image_trash SET row_json='invalid'").run();
  assert.equal((await control.deleteFailedJobs()).ok, false);
  assert.ok(sqlite.prepare("SELECT id FROM jobs WHERE id='malformed-guard'").get());
  sqlite.close();
}
console.log('queue cleanup: sync/async, single/bulk, logs, active/status guards and saved/trash image protection passed');
