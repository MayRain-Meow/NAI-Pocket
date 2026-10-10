
// Reads prepared metadata only. No images, database, credentials or network access.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeArtistIdentity } from '../public/artist-index-v5.js';

export const ARTIST_ROSTER_MAX_BYTES = 2 * 1024 * 1024;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
function safeText(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]|:\/\/|\b[A-Za-z]:[\\/]|(?:^|[\s"'=:(\[])\/(?:app\/data|opt|home|root)\//i.test(value)
    || /\bpst-[A-Za-z0-9_-]{35,}|\bsk-[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value)) {
    fail(`${label}: invalid or private text (value suppressed)`);
  }
  return value;
}
function artistName(value, label) {
  const name = safeText(value, 180, label), key = normalizeArtistIdentity(name);
  if (!key || key.length > 160) fail(`${label}: invalid normalized identity`);
  return { name, key };
}

export function makeArtistRoster(source) {
  if (!object(source) || source.format !== 'nai-pocket-artist-collection' || source.formatVersion !== 1
    || typeof source.id !== 'string' || !/^[A-Za-z0-9_-]{1,90}$/.test(source.id)
    || !Array.isArray(source.artists) || !source.artists.length || source.artists.length > 50000) {
    fail('Invalid prepared artist collection');
  }
  const version = safeText(source.version, 100, 'Collection version');
  const names = new Map(), entries = [];
  for (const row of source.artists) {
    if (!object(row)) fail('Artist: expected an object');
    const { name, key } = artistName(row.artist, 'Artist');
    if (names.has(key)) fail('Duplicate normalized artist identity');
    names.set(key, name);
    const inputAliases = row.aliases ?? [];
    if (!Array.isArray(inputAliases) || inputAliases.length > 40) fail('Artist aliases: invalid list');
    const uniqueAliases = new Map();
    for (const value of inputAliases) {
      const alias = artistName(value, 'Artist alias'), previous = uniqueAliases.get(alias.key);
      // Sorting the retained spelling makes duplicate normalization independent
      // of input order, without rewriting or inventing any public name.
      if (previous === undefined || compare(alias.name, previous) < 0) uniqueAliases.set(alias.key, alias.name);
    }
    const aliases = [...uniqueAliases].sort(([a], [b]) => compare(a, b)).map(([, name]) => name);
    entries.push({ key, artist: name, aliases });
  }
  const aliasOwners = new Map();
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const key = normalizeArtistIdentity(alias), owner = aliasOwners.get(key);
      if ((names.has(key) && key !== entry.key) || (owner !== undefined && owner !== entry.key)) {
        fail('Conflicting normalized artist alias');
      }
      aliasOwners.set(key, entry.key);
    }
  }
  entries.sort((a, b) => compare(a.key, b.key));
  // Deliberate output allowlist: no examples, provenance, notes, paths or
  // preferences are traversed, cloned, or serialized into this artifact.
  const roster = { format: 'nai-pocket-artist-roster', formatVersion: 1, collectionId: source.id, version,
    artists: entries.map(({ artist, aliases }) => ({ artist, aliases })) };
  if (Buffer.byteLength(JSON.stringify(roster) + '\n', 'utf8') >= ARTIST_ROSTER_MAX_BYTES) fail('Artist roster must be smaller than 2 MiB');
  return roster;
}

export async function buildArtistRoster({ sourceFile, destinationFile, replace = false }) {
  const sourcePath = path.resolve(sourceFile), destination = path.resolve(destinationFile);
  if (sourcePath === destination) fail('Source and destination must be different files');
  if ((await fs.stat(sourcePath)).size > 128 * 1024 * 1024) fail('Prepared source exceeds 128 MiB');
  let source;
  try { source = JSON.parse(await fs.readFile(sourcePath, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) fail('Prepared source is not valid JSON'); throw error; }
  const roster = makeArtistRoster(source), text = JSON.stringify(roster) + '\n';
  if (replace) {
    const target = await fs.lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (target && (!target.isFile() || target.isSymbolicLink())) fail('Replacement destination must be a regular file');
  }
  await fs.writeFile(destination, text, { encoding: 'utf8', flag: replace ? 'w' : 'wx' });
  return { roster, bytes: Buffer.byteLength(text, 'utf8') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), replace = args.includes('--replace'), positional = args.filter(value => value !== '--replace');
  if (positional.length !== 2 || positional.some(value => value.startsWith('--')) || args.filter(value => value === '--replace').length > 1) {
    fail('Usage: node scripts/build-artist-roster.mjs <prepared.json> <roster.json> [--replace]');
  }
  const { roster, bytes } = await buildArtistRoster({ sourceFile: positional[0], destinationFile: positional[1], replace });
  console.log(`Prepared artist roster: ${roster.artists.length} names, ${roster.artists.reduce((sum, row) => sum + row.aliases.length, 0)} aliases, ${bytes} UTF-8 bytes. No example files read or uploaded.`);
}
