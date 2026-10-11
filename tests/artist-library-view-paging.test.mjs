// The app's artist page must never read all annotations in one storage call: on the phone each
// result crosses the native bridge, and a single ~43 MB result crashed the WebView (0.3.1).
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APP_SCHEMA } from '../service/storage/schema.js';
import { createArtistLibraryView } from '../service/artist-library-view.js';
import { createArtistLibraryViewStore } from '../service/storage/artist-library-view.js';
import { createArtistBrowserStore } from '../service/storage/artist-browser.js';

const db = new DatabaseSync(':memory:');
db.exec(APP_SCHEMA);
db.prepare("INSERT INTO artist_resource_sets(id,version,title,synthetic) VALUES ('set-a','1','fixture',1)").run();
const artists = 900, perArtist = 3;
for (let a = 0; a < artists; a++) {
  const artist = `paging_artist_${String(a).padStart(4, '0')}`;
  db.prepare("INSERT INTO artist_resource_profiles(artist,display_name,aliases_json,set_id) VALUES (?,?,'[]','set-a')").run(artist, artist);
  for (let e = 0; e < perArtist; e++) {
    const id = `ex-${a}-${e}`;
    db.prepare('INSERT INTO artist_resource_examples(id,artist,position,width,height,thumb_ext,preview_ext) VALUES (?,?,?,512,768,?,?)').run(id, artist, e, 'remote', 'remote');
    db.prepare(`INSERT INTO artist_resource_observations(id,example_id,model,facets_json,attributes_json,note,schema_version,source,reviewed)
      VALUES (?,?,'original','{}',?,?,2,'assistant-visual',0)`).run(`ob-${a}-${e}`, id,
      JSON.stringify({ 'palette.temperature': [a % 2 ? 'warm' : 'cool'] }), a === 7 ? '雨夜和服' : 'plain description');
  }
}
const rows = [];
const store = createArtistLibraryViewStore(db);
const counted = Object.fromEntries(Object.entries(store).map(([name, fn]) => [name, async (...args) => {
  const result = await fn(...args);
  rows.push([name, Array.isArray(result) ? result.length : 1]);
  return result;
}]));
const view = createArtistLibraryView({ store: counted, preferences: createArtistBrowserStore(db), imageUrl: (id, tier) => `/img/${id}/${tier}` });

const list = await view.list({});
assert.equal(list.total, artists);
const largest = Math.max(...rows.filter(([name]) => name.endsWith('Page')).map(([, count]) => count));
assert.ok(largest <= 1000, `each page is bounded (largest ${largest} rows)`);
assert.ok(rows.filter(([name]) => name === 'observationsPage').length >= 3, `${artists * perArtist} annotations arrive in several pages`);
assert.equal(rows.some(([name]) => name === 'notesPage'), false, 'browsing does not read descriptions');

rows.length = 0;
const warm = await view.list({ attributes: JSON.stringify({ 'palette.temperature': ['warm'] }) });
assert.equal(warm.total, artists / 2, 'style filters work on the paged catalog');
assert.equal(rows.some(([name]) => name.endsWith('Page')), false, 'the cached catalog is reused');

const text = await view.list({ query: '和服' });
assert.equal(rows.some(([name]) => name === 'notesPage'), true, 'a typed query reads descriptions on demand');
assert.deepEqual(text.artists.map(item => item.artist), ['paging_artist_0007'], 'and description search still finds the artist');
console.log('artist library view paging passed');
