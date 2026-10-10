import { normalizeArtistIdentity } from '../public/artist-index-v5.js';
import { observationAttributes, matchesStyleAttributes, validateStyleAttributes } from '../public/artist-style-schema.js';
import { imageDimensionsFromBytes } from '../public/image-bytes.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const missing = error => error.code === 'ENOENT' || error.code === 'OS-PLUG-FILE-0008';
const json = (value, fallback) => value ? JSON.parse(value) : fallback;
const link = value => {
  try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
};
const automatic = row => !row.reviewed && ['assistant-visual','danbooru-tags'].includes(row.source);
const observation = row => ({
  id: row.id, exampleId: row.example_id, model: row.model, facets: json(row.facets_json, {}),
  attributes: validateStyleAttributes(json(row.attributes_json, {})), note: row.note,
  schemaVersion: row.schema_version, source: row.source, reviewed: Boolean(row.reviewed),
  automatic: automatic(row), provenance: json(row.provenance_json, {}), updatedAt: row.updated_at
});
export const artistResourceImageUrl = (id, tier = 'thumb', revision = '') => `/api/artists/resources/image?id=${encodeURIComponent(id)}&tier=${tier}&revision=${encodeURIComponent(revision)}`;


export function createArtistResourceService({ store, files }) {
  return {
    async catalog() {
      const { sets, profiles } = await store.catalog();
      return { sets: sets.map(row => ({ ...row, synthetic: Boolean(row.synthetic) })), profiles: profiles.map(row => ({
        artist: row.artist, displayName: row.display_name, aliases: json(row.aliases_json, []),
        exampleCount: row.example_count, annotatedCount: row.annotated_count, reviewedCount: row.reviewed_count,
        coverUrl: row.cover_id ? artistResourceImageUrl(row.cover_id,'thumb',row.storage_id) : null
      })) };
    },
    async get(value) {
      const result = await store.profile(normalizeArtistIdentity(value));
      if (!result) return null;
      const { profile, examples, observations } = result;
      return { artist: profile.display_name, aliases: json(profile.aliases_json, []),
        resourceSet: { id: profile.set_id, version: profile.version, revision:profile.storage_id, title: profile.title, synthetic: Boolean(profile.synthetic) },
        examples: examples.map(row => ({ id: row.id, artist: profile.display_name, sourceType: 'original',
          sourceUrl: link(row.source_url), width: row.width, height: row.height, note: row.note,
          metadata: json(row.metadata_json, {}), thumbUrl: artistResourceImageUrl(row.id,'thumb',profile.storage_id), previewUrl: artistResourceImageUrl(row.id,'preview',profile.storage_id) })),
        observations: observations.map(observation)
      };
    },
    async matching({ attributes = {}, confirmedOnly = false, signal }) {
      signal?.throwIfAborted();
      let constraints;
      try { constraints = validateStyleAttributes(attributes); }
      catch { throw fail(400, '画风筛选条件无效。'); }
      const matches = new Set();
      await store.scanEvidence(rows=>{
        for (const row of rows) {
          const item = { facets: json(row.facets_json, {}), attributes: json(row.attributes_json, {}) };
          if (!Object.values(observationAttributes(item)).some(values => values.length)) continue;
          // Every requested dimension must match ONE observation, never a union of images.
          if (matchesStyleAttributes(item, constraints)) matches.add(row.artist);
        }
      },{confirmedOnly,signal});
      return matches;
    },
    async image(id, tier = 'thumb', { signal, revision } = {}) {
      if (!identity(id) || !['thumb','preview'].includes(tier)) throw fail(400, '例图请求无效。');
      signal?.throwIfAborted();
      const row = await store.image(id);
      if (!row) throw fail(404, '资料包中没有这张例图。');
      if (revision && revision !== row.storage_id) throw fail(409, '资料版本已更新，请重新打开画师资料。');
      const extension = row[`${tier}_ext`];
      if (!identity(row.storage_id) || !['webp','png','jpg'].includes(extension)) throw fail(422, '例图资料格式无效。');
      const path = `artist-resources/${row.storage_id}/${id}-${tier}.${extension}`;
      try {
        const stat = await files.stat(path);
        if (!stat.isFile || stat.size > 4 * 1024 * 1024) throw fail(422, '例图文件过大或格式无效。');
        const buffer = await files.read(path, { signal });
        signal?.throwIfAborted();
        const size = imageDimensionsFromBytes(buffer);
        if (buffer.length > 4 * 1024 * 1024 || !size || size.width * size.height > 32000000 || Math.max(size.width,size.height) > 10000) throw fail(422, '例图文件损坏或尺寸过大。');
        return { buffer, contentType: `image/${extension === 'jpg' ? 'jpeg' : extension}` };
      } catch (error) { if (missing(error)) throw fail(404, '这张例图尚未下载到本机。'); throw error; }
    }
  };
}
