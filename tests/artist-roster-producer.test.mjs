import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeArtistRoster, ARTIST_ROSTER_MAX_BYTES } from '../scripts/build-artist-roster.mjs';

const fixture = () => ({ format: 'nai-pocket-artist-collection', formatVersion: 1, id: 'fixture-artists', version: '1',
  title: 'Synthetic prepared collection', synthetic: true, artists: [
    { artist: 'Second_Artist', aliases: ['画师二', 'Alias_Two', 'alias two'], examples: [] },
    { artist: 'First Artist', aliases: [], examples: [] }
  ] });

test('only public names, aliases and collection identity reach the output; excluded fields are not read', () => {
  const source = fixture();
  source.token = 'fixture-private-token'; source.localPath = 'C:\\private\\metadata.json';
  source.artists[0].note = 'private-user-note'; source.artists[0].favorite = true;
  Object.defineProperty(source.artists[0], 'examples', { get() { assert.fail('roster producer must not traverse example metadata or images'); } });
  const beforeAliases = [...source.artists[0].aliases], roster = makeArtistRoster(source);
  assert.deepEqual(roster, { format: 'nai-pocket-artist-roster', formatVersion: 1, collectionId: 'fixture-artists', version: '1', artists: [
    { artist: 'First Artist', aliases: [] }, { artist: 'Second_Artist', aliases: ['Alias_Two', '画师二'] }
  ] });
  assert.deepEqual(source.artists[0].aliases, beforeAliases, 'the prepared input remains unchanged');
  assert.doesNotMatch(JSON.stringify(roster), /private|examples|metadata|favorite|localPath|token|note/i);
});

test('artist and alias input ordering cannot change the emitted roster', () => {
  const source = fixture(), expected = JSON.stringify(makeArtistRoster(source));
  source.artists.reverse(); source.artists.forEach(artist => artist.aliases.reverse());
  assert.equal(JSON.stringify(makeArtistRoster(source)), expected);
  delete source.artists[0].aliases;
  assert.equal(JSON.stringify(makeArtistRoster(source)), expected, 'missing aliases stay empty');
});

test('invalid prepared shape, names, aliases, private text and normalized conflicts are rejected', () => {
  for (const mutate of [
    source => { source.format = 'private-database'; },
    source => { source.formatVersion = 2; },
    source => { source.id = '../private'; },
    source => { source.version = ''; },
    source => { source.artists = []; },
    source => { source.artists[0].artist = ''; },
    source => { source.artists[0].artist = 'artist:   '; },
    source => { source.artists[0].artist = 'a'.repeat(161); },
    source => { source.artists[0].artist = 'https://example.test/artist'; },
    source => { source.artists[0].artist = 'artist\nname'; },
    source => { source.artists[0].artist = 'C:\\private\\source'; },
    source => { source.artists[0].artist = '/home/private/source'; },
    source => { source.artists[0].artist = 'pst-' + 'a'.repeat(40); },
    source => { source.artists[0].aliases = 'bad'; },
    source => { source.artists[0].aliases = ['']; },
    source => { source.artists[0].aliases = ['artist:']; },
    source => { source.artists[0].aliases = ['https://example.test/private']; },
    source => { source.artists[0].aliases = Array.from({ length: 41 }, (_, i) => `alias-${i}`); },
    source => { source.artists.push({ artist: 'artist:first_artist', aliases: [] }); },
    source => { source.artists[0].aliases = ['first_artist']; },
    source => { source.artists[1].aliases = ['ALIAS TWO']; }
  ]) {
    const source = fixture(); mutate(source);
    assert.throws(() => makeArtistRoster(source), undefined, mutate.toString());
  }
});

test('the bound counts encoded UTF-8 bytes rather than JavaScript character length', () => {
  const source = fixture();
  source.artists = Array.from({ length: 4100 }, (_, i) => ({ artist: `artist-${i}`,
    aliases: Array.from({ length: 4 }, (_, j) => `${i}-${j}-` + '名'.repeat(45)) }));
  assert.ok(JSON.stringify(source).length < ARTIST_ROSTER_MAX_BYTES, 'fixture character count is below the byte cap');
  assert.throws(() => makeArtistRoster(source), /smaller than 2 MiB/);
});

test('CLI writes only metadata, refuses overwrite by default, and replaces only when requested', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-roster-producer-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'prepared.json'), destination = path.join(directory, 'roster.json');
  const script = fileURLToPath(new URL('../scripts/build-artist-roster.mjs', import.meta.url));
  const prepared = fixture(); await fs.writeFile(source, JSON.stringify(prepared), 'utf8');
  const run = extra => spawnSync(process.execPath, [script, source, destination, ...extra], { encoding: 'utf8' });
  const first = run([]); assert.equal(first.status, 0, first.stderr);
  const initial = await fs.readFile(destination, 'utf8');
  assert.deepEqual(JSON.parse(initial), makeArtistRoster(prepared));
  prepared.version = '2'; await fs.writeFile(source, JSON.stringify(prepared), 'utf8');
  const refused = run([]); assert.notEqual(refused.status, 0); assert.match(refused.stderr, /EEXIST/);
  assert.equal(await fs.readFile(destination, 'utf8'), initial, 'refused overwrite preserves existing output');
  const replaced = run(['--replace']); assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(JSON.parse(await fs.readFile(destination, 'utf8')).version, '2');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['prepared.json', 'roster.json']);
});
