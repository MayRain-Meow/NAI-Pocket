// Helpers for archiving request metadata without copying resolved input media
// into SQLite.  Queue jobs keep asset references in the normalized generation
// state; the Base64 strings only exist while a request is being sent upstream.

const ASSET_ID_RE = /^[0-9a-f-]{16,80}$/i;

const MEDIA_KEY_KIND = new Map([
  ['image', 'asset'],
  ['inputimage', 'asset'],
  ['baseimage', 'asset'],
  ['sourceimage', 'asset'],
  ['originalimage', 'asset'],
  ['mask', 'mask'],
  ['maskimage', 'mask'],
  ['referenceimage', 'vibe'],
  ['referenceimagemultiple', 'vibe-list'],
  ['directorreferenceimage', 'precise'],
  ['directorreferenceimages', 'precise-list']
]);

const EXISTING_MARKER_RE = /^\[(?:asset|mask|vibe|encoded-vibe|precise|media|resolved):[^\]]+\]$/i;

function canonicalKey(key) {
  return String(key || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function safeAssetId(ref) {
  const id = String(ref?.id || '');
  return ref?.source === 'asset' && ASSET_ID_RE.test(id) ? id : '';
}

function marker(kind, index, state) {
  let label = 'asset';
  let ref = state?.imageWorkflow?.baseImage;
  if (kind === 'mask') {
    label = 'mask';
    ref = state?.imageWorkflow?.maskImage;
  } else if (kind === 'vibe' || kind === 'vibe-list') {
    label = 'encoded-vibe';
    ref = state?.referenceControl?.vibes?.[index]?.image;
  } else if (kind === 'precise' || kind === 'precise-list') {
    label = 'precise';
    ref = state?.referenceControl?.precise?.[index]?.image;
  }
  return `[${label}:${safeAssetId(ref) || 'resolved'}]`;
}

function redactMediaValue(value, kind, state, index = 0) {
  if (value == null || value === '') return value;
  if (typeof value === 'string' && EXISTING_MARKER_RE.test(value.trim())) return value;
  if (kind.endsWith('-list')) {
    if (!Array.isArray(value)) return marker(kind.slice(0, -5), index, state);
    return value.map((item, itemIndex) => redactMediaValue(item, kind.slice(0, -5), state, itemIndex));
  }
  return marker(kind, index, state);
}

function redactNode(value, key, state, seen, depth) {
  if (value == null || typeof value !== 'object') {
    const kind = MEDIA_KEY_KIND.get(canonicalKey(key));
    return kind ? redactMediaValue(value, kind, state) : value;
  }

  const kind = MEDIA_KEY_KIND.get(canonicalKey(key));
  if (kind) return redactMediaValue(value, kind, state);
  if (depth > 32) return null;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const output = [];
    seen.set(value, output);
    value.forEach((item, index) => output.push(redactNode(item, '', state, seen, depth + 1)));
    return output;
  }

  const output = {};
  seen.set(value, output);
  for (const [childKey, childValue] of Object.entries(value)) {
    output[childKey] = redactNode(childValue, childKey, state, seen, depth + 1);
  }
  return output;
}

/**
 * Clone a request payload for gallery persistence while replacing every
 * request-media field with a compact asset marker.  The returned object is
 * safe to JSON.stringify and the payload used for the upstream request is not
 * mutated.  `state` supplies the durable input-asset IDs when available.
 */
export function redactPersistedApiPayload(payload, state = {}) {
  return redactNode(payload, '', state, new WeakMap(), 0);
}

