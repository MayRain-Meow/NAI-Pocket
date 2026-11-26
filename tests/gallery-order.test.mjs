import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APP_SCHEMA } from '../service/storage/schema.js';
import { createGalleryStore } from '../service/storage/gallery.js';
import { createGalleryService } from '../service/gallery.js';
import * as cursors from '../public/gallery-utils.js';

const db = new DatabaseSync(':memory:');
db.exec(APP_SCHEMA);
const job = db.prepare("INSERT INTO jobs(id,batch_id,position,status,request_json,seed,initiated_at,created_at) VALUES(?,'order-test',?,'completed','{}',42,?,?)");
const image = db.prepare(`INSERT INTO images(id,job_id,batch_id,original_name,thumb_name,mime,width,height,bytes,thumb_bytes,prompt,negative_prompt,seed,params_json,created_at,favorite)
  VALUES(?,?,'order-test',?,?,'image/png',512,768,100,20,'order fixture','',42,'{}',?,?)`);
function seed(id, createdAt, index = 0) {
  job.run(`job-${id}`, index, createdAt, createdAt);
  image.run(id, `job-${id}`, `${id}.png`, `${id}.webp`, createdAt, index % 2);
}
// Insert out of chronological order, with enough tied timestamps to cross page boundaries.
const records = Array.from({ length: 65 }, (_, i) => ({ id: `picture-${String(i).padStart(3, '0')}`, created_at: 1000 + Math.floor(i / 4) }));
for (const row of [...records.filter((_, i) => i % 2), ...records.filter((_, i) => !(i % 2))]) seed(row.id, row.created_at, Number(row.id.slice(-3)));
const expected = [...records].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
const gallery = createGalleryService({ store: createGalleryStore(db), cursors, clock: { now: () => 2000 } });

try {
  const first = await gallery.list(new URLSearchParams({ cursor: '', limit: '30' }));
  assert.deepEqual(first.images.map(row => row.id), expected.slice(0, 30).map(row => row.id));
  assert.equal(first.hasMore, true);
  seed('new-picture', 3000);
  const second = await gallery.list(new URLSearchParams({ cursor: first.nextCursor, snapshot: first.snapshotCursor, limit: '30' }));
  const third = await gallery.list(new URLSearchParams({ cursor: second.nextCursor, snapshot: first.snapshotCursor, limit: '30' }));
  const pages = [...first.images, ...second.images, ...third.images];
  assert.deepEqual(pages.map(row => row.id), expected.map(row => row.id), 'cursor pages retain newest-first order with no duplicate or skipped ties');
  assert.equal(new Set(pages.map(row => row.id)).size, 65);
  assert.equal(second.total, 65, 'new arrivals do not alter an existing snapshot');
  assert.equal(third.hasMore, false);
  assert.equal((await gallery.list(new URLSearchParams({ cursor: '', limit: '30' }))).images[0].id, 'new-picture', 'refresh puts new arrivals first');

  const offset = await gallery.list(new URLSearchParams({ offset: '28', limit: '6', snapshot: first.snapshotCursor }));
  assert.deepEqual(offset.images.map(row => row.id), expected.slice(28, 34).map(row => row.id), 'cleanup navigation follows the same stable order');
  const search = await gallery.list(new URLSearchParams({ cursor: '', limit: '60', q: 'order fixture', favorite: '1' }));
  assert.deepEqual(search.images.map(row => row.id), expected.filter(row => Number(row.id.slice(-3)) % 2).map(row => row.id), 'search and favorites retain newest-first order');
  const dates = await gallery.list(new URLSearchParams({ cursor: '', limit: '60', since: '1005', until: '1008' }));
  assert.deepEqual(dates.images.map(row => row.id), expected.filter(row => row.created_at >= 1005 && row.created_at < 1008).map(row => row.id));

  const restoredId = expected[12].id;
  await gallery.deleteImages([restoredId]);
  await gallery.restoreTrash([restoredId]);
  const restored = await gallery.list(new URLSearchParams({ cursor: '', snapshot: first.snapshotCursor, limit: '30' }));
  assert.deepEqual(restored.images.map(row => row.id), expected.slice(0, 30).map(row => row.id), 'restoring preserves generation time and original position');
  console.log('PASS gallery newest-first order, tied timestamps, cursor/offset pages, snapshot, filters and restoration');
} finally {
  db.close();
}
