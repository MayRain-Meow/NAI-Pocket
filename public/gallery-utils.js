import { utf8Base64url, fromBase64url } from './base64.js?v=1.9.42';
const MAX_CURSOR_ID_LENGTH = 160;

export function encodeGalleryCompletionCursor(row) {
  const finishedAt = Number(row?.completion_finished_at ?? row?.finished_at);
  const id = String(row?.completion_job_id ?? row?.job_id ?? row?.id ?? '');
  if (!Number.isFinite(finishedAt) || finishedAt < 0 || (!id && finishedAt !== 0)) return '';
  return utf8Base64url(JSON.stringify([finishedAt, id]));
}

export function decodeGalleryCompletionCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(fromBase64url(value));
    const finishedAt = Number(parsed?.[0]);
    const id = String(parsed?.[1] ?? '');
    if (!Number.isFinite(finishedAt) || finishedAt < 0 || id.length > MAX_CURSOR_ID_LENGTH) return null;
    if (!id && finishedAt !== 0) return null;
    return { finishedAt, id };
  } catch {
    return null;
  }
}

export function encodeGalleryCursor(row) {
  const createdAt = Number(row?.created_at);
  const id = String(row?.id || '');
  if (!Number.isFinite(createdAt) || !id) return '';
  return utf8Base64url(JSON.stringify([createdAt, id]));
}

export function decodeGalleryCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(fromBase64url(value));
    const createdAt = Number(parsed?.[0]);
    const id = String(parsed?.[1] || '');
    if (!Number.isFinite(createdAt) || !id || id.length > MAX_CURSOR_ID_LENGTH) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function escapeGalleryLike(value) {
  return String(value || '').replace(/[\\%_]/g, match => `\\${match}`);
}

// Gallery kinds. `gallery` is deliberate work; `rotation` is an artist-rotation
// sample kept in its own view so the main gallery is not diluted by batches.
export const GALLERY_KINDS = Object.freeze(['gallery', 'rotation', 'iteration']);
export const normalizeGalleryKind = value => (GALLERY_KINDS.includes(String(value || '')) ? String(value) : 'gallery');

export function buildGalleryFilter({ favorite = false, query = '', since = 0, until = 0, snapshot = null, cursor = null, kind = 'gallery' } = {}, { includeCursor = true } = {}) {
  const clauses = [];
  const values = [];
  if (favorite) clauses.push('favorite=1');

  // Scoped to one kind, never "everything": the two views stay separate by design.
  clauses.push('kind=?');
  values.push(normalizeGalleryKind(kind));

  const cleanQuery = String(query || '').trim().slice(0, 120);
  if (cleanQuery) {
    const contains = `%${escapeGalleryLike(cleanQuery)}%`;
    clauses.push("(prompt LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR CAST(seed AS TEXT)=?)");
    values.push(contains, contains, cleanQuery);
  }

  const cleanSince = Number(since);
  if (Number.isFinite(cleanSince) && cleanSince > 0) {
    clauses.push('created_at>=?');
    values.push(Math.trunc(cleanSince));
  }

  const cleanUntil = Number(until);
  if (Number.isFinite(cleanUntil) && cleanUntil > 0) {
    clauses.push('created_at<?');
    values.push(Math.trunc(cleanUntil));
  }

  if (snapshot) {
    clauses.push('(created_at<? OR (created_at=? AND id<=?))');
    values.push(snapshot.createdAt, snapshot.createdAt, snapshot.id);
  }

  if (includeCursor && cursor) {
    clauses.push('(created_at<? OR (created_at=? AND id<?))');
    values.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    values,
    query: cleanQuery
  };
}

export function galleryImageSummary(row) {
  if (!row) return null;
  // `rotation_artist` is the raw SQL alias; it is exposed as a plain `artist` and only
  // when it has a value, so an ordinary gallery row keeps exactly the shape it had.
  const { rotation_artist: rotationArtist, ...rest } = row;
  const artist = typeof rotationArtist === 'string' ? rotationArtist.trim().slice(0, 160) : '';
  return {
    ...rest,
    ...(artist ? { artist } : {}),
    favorite: Boolean(row.favorite),
    thumbUrl: `/api/images/${row.id}/thumbnail`,
    previewUrl: `/api/images/${row.id}/preview`,
    originalUrl: `/api/images/${row.id}/original`
  };
}
