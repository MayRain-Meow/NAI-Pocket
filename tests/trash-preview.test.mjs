import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APP_SCHEMA } from '../service/storage/schema.js';
import { createGalleryStore } from '../service/storage/gallery.js';
import { createGalleryService, TRASH_KEEP_MS } from '../service/gallery.js';
import * as cursors from '../public/gallery-utils.js';
const db=new DatabaseSync(':memory:'); db.exec(APP_SCHEMA);
db.prepare("INSERT INTO jobs(id,batch_id,position,status,request_json,seed,initiated_at,created_at) VALUES('job','batch',0,'completed','{}',42,10,10)").run();
const insert=db.prepare('INSERT INTO images(id,job_id,batch_id,original_name,thumb_name,mime,width,height,bytes,thumb_bytes,prompt,negative_prompt,seed,params_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
insert.run('picture','job','batch','picture.png','picture.webp','image/png',64,64,100,20,'test','',42,'{}',10);
let now=100; const events=[];
const gallery=createGalleryService({store:createGalleryStore(db),cursors,clock:{now:()=>now},effects:{
  afterTrash:async rows=>events.push(['trash',rows.map(x=>x.id)]),
  afterRestore:async rows=>events.push(['restore',rows.map(x=>x.id)]),
  deleteGalleryRows:async rows=>events.push(['purge',rows.map(x=>x.id)])
}});
await gallery.deleteImages(['picture']);
const list=await gallery.listTrash();
assert.equal(list.images[0].previewUrl,'/api/images/trash/picture/preview');
const image=await gallery.getTrashImage('picture');
assert.equal(image.original_name,'picture.png'); assert.equal(image.deletedAt,100);
assert.equal((await gallery.getTrashImage('picture')).expiresAt,100+TRASH_KEEP_MS,'viewing leaves expiration unchanged');
await assert.rejects(gallery.getImage('picture'),{status:404});
await gallery.restoreTrash(['picture']);
assert.equal((await gallery.getImage('picture')).seed,42);
await assert.rejects(gallery.getTrashImage('picture'),{status:404});
await gallery.deleteImages(['picture']); now+=TRASH_KEEP_MS+1;
assert.equal((await gallery.purgeExpiredTrash()).purged,1);
await assert.rejects(gallery.getTrashImage('picture'),{status:404});
assert.deepEqual(events.map(x=>x[0]),['trash','restore','trash','purge']);
db.close(); console.log('PASS trash preview, unchanged expiry, restoration and purge');
