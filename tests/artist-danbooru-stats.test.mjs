// The app's Danbooru artist facts: ids from the prepared examples, one paced batch per call,
// server-shaped results, and the facts shown on the shared artist page.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APP_SCHEMA } from '../service/storage/schema.js';
import { ARTIST_DANBOORU_STATS_SCHEMA, createArtistDanbooruStatsStore } from '../service/storage/artist-danbooru-stats.js';
import { createArtistDanbooruStats } from '../service/artist-danbooru-stats.js';
import { createArtistLibraryView } from '../service/artist-library-view.js';
import { createArtistLibraryViewStore } from '../service/storage/artist-library-view.js';
import { createArtistBrowserStore } from '../service/storage/artist-browser.js';
import { selectDanbooruArtistStats } from '../public/danbooru-artist-stats.js';


const db = new DatabaseSync(':memory:');
db.exec(APP_SCHEMA); db.exec(ARTIST_DANBOORU_STATS_SCHEMA);
db.prepare("INSERT INTO artist_resource_sets(id,version,title,synthetic) VALUES ('set','1','t',1)").run();
for (const [artist, id] of [['anmi', 101], ['gone_artist', 202], ['no_id', null]]) {
  db.prepare("INSERT INTO artist_resource_profiles(artist,display_name,aliases_json,set_id) VALUES (?,?,'[]','set')").run(artist, artist);
  db.prepare('INSERT INTO artist_resource_examples(id,artist,position,width,height,metadata_json) VALUES (?,?,0,512,768,?)').run(`ex-${artist}`, artist, JSON.stringify(id ? { provider: 'Danbooru', artistId: id } : {}));
}
const calls = [];
const http = { async fetch(url, options) {
  calls.push({ url, options });
  const ids = new URL(url).searchParams.get('search[id]').split(',').map(Number);
  return Response.json(ids.filter(id => id === 101).map(id => ({ id, name: 'anmi', created_at: '2012-11-09T00:00:00Z', updated_at: '2026-07-29T00:00:00Z', urls: [{ url: 'https://x.com/anmi' }], tag: { post_count: 18794 } })));
} };
let now = 1_800_000_000_000;
const clock = { now: () => now };
const store = createArtistDanbooruStatsStore(db);
const stats = createArtistDanbooruStats({ store, http, clock, wait: async ms => { now += ms; } });

const one = await stats.sync({ artist: 'anmi' });
assert.equal(one.synced, 1);
assert.equal(calls.length, 1);
assert.equal(new URL(calls[0].url).hostname, 'danbooru.donmai.us');
assert.equal(calls[0].options.credentials, 'omit', 'no credentials are sent');
assert.deepEqual(await stats.get('anmi'), { postCount: 18794, createdAt: Date.parse('2012-11-09T00:00:00Z'), updatedAt: Date.parse('2026-07-29T00:00:00Z'), homepages: ['https://x.com/anmi'], syncedAt: now, source: 'danbooru.donmai.us' });

const noId = await stats.sync({ artist: 'no_id' });
assert.equal(noId.skipped, 1, 'an artist without a known Danbooru id is skipped, not guessed');
assert.equal(calls.length, 1);

const batch = await stats.sync({});
assert.equal(batch.requested, 2, 'a batch covers artists with known ids');
assert.equal(batch.missing, 1, 'an id that Danbooru no longer has is recorded as missing');
assert.equal(batch.remaining, 0);
assert.ok(now > 1_800_000_000_000, 'batches are paced');

const view = createArtistLibraryView({ store: createArtistLibraryViewStore(db), preferences: createArtistBrowserStore(db), imageUrl: (id, tier) => `/img/${id}/${tier}`, danbooru: stats });
assert.equal((await view.profile('anmi')).danbooru.postCount, 18794, 'the detail page shows the facts');
const sorted = await view.list({ sort: 'posts' });
assert.equal(sorted.artists[0].artist, 'anmi', 'sorting by posts uses the facts');
console.log('artist danbooru stats passed');
