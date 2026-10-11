// Danbooru artist facts (post count, dates, profile links, other names): request fields and the
// bounded parsing of an artist record. Shared by the Node server and the Android app, which
// both read the same public API; no network or storage here.
// Artist records themselves carry no post count; the associated tag record does.
// These facts are optional display parameters, never evidence about style.
export const ARTIST_STAT_FIELDS = 'id,name,other_names,is_banned,is_deleted,created_at,updated_at,urls[url],tag[post_count]';
export const DANBOORU_ARTIST_ID_BATCH = 40;
export const DANBOORU_HOMEPAGE_LIMIT = 8;
export const HOMEPAGE_HOST_LIMIT = 200;
export const NON_NAME_PATTERN = /[@\s]|^https?:/i;

export function parseDanbooruTimestamp(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function allowedHomepage(value) {
  if (typeof value !== 'string' || !value || value.length > HOMEPAGE_HOST_LIMIT) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

// Only bounded facts leave this module: a post count, two timestamps, external
// profile links and alternative names. Missing or malformed values stay null so
// a later sync can fill them instead of a zero being mistaken for a real count.
export function selectDanbooruArtistStats(record) {
  if (!record || !Number.isSafeInteger(record.id) || record.id <= 0) return null;
  const raw = Number(record.tag?.post_count);
  const postCount = Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  const homepages = [];
  for (const entry of Array.isArray(record.urls) ? record.urls : []) {
    const url = allowedHomepage(entry?.url);
    if (url && !homepages.includes(url)) homepages.push(url);
    if (homepages.length >= DANBOORU_HOMEPAGE_LIMIT) break;
  }
  const names = [];
  for (const value of Array.isArray(record.other_names) ? record.other_names : []) {
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (!name || name.length > 100 || NON_NAME_PATTERN.test(name) || name === record.name || names.includes(name)) continue;
    names.push(name);
    if (names.length >= 12) break;
  }
  return { id: record.id, name: String(record.name || ''), postCount,
    createdAt: parseDanbooruTimestamp(record.created_at), updatedAt: parseDanbooruTimestamp(record.updated_at), homepages, otherNames: names };
}
