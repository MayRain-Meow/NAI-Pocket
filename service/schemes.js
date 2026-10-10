import { normalizeArtistPreference } from './artist-browser.js';

function safeJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export class SchemesServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(status, message) {
  throw new SchemesServiceError(status, message);
}


// Store methods may return values or promises. Atomic commands own their entire
// read/write sequence; clock.now and ids.next are called only when needed.
export function createSchemesService({ store, clock, ids, sanitizeState, includeArtistPreferences = false }) {
  const writePorts = { now: () => clock.now(), nextId: () => ids.next() };
  return {
    async listSchemes() {
      const rows = await store.listSchemes();
      return rows.map(row => ({
        id: row.id,
        name: row.name,
        data: safeJson(row.data_json),
        isDefault: Boolean(row.is_default),
        coverImageId: row.cover_exists ? row.cover_image_id : null,
        coverThumbUrl: row.cover_exists ? `/api/images/${row.cover_image_id}/thumbnail` : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    },

    async createScheme(body) {
      const name = String(body.name || '').trim().slice(0, 100);
      if (!name) fail(400, '方案名称不能为空。');
      if (!body.data || typeof body.data !== 'object') fail(400, '方案数据无效。');
      // Checkpoints retain missing Img2Img/Inpaint media; queue validation is strict.
      const data = sanitizeState(body.data, { allowMissingMedia: true });
      const result = await store.createScheme({
        name, data, requestedCover: body.coverImageId,
        makeDefault: body.isDefault === true
      }, writePorts);
      if (!result) fail(409, '已有同名方案；请换一个名称。');
      return result;
    },

    async getScheme(id) {
      const row = await store.getScheme(id);
      if (!row) fail(404, '方案不存在。');
      return row;
    },

    async updateScheme(id, body, row) {
      if (!row) row = await store.getScheme(id);
      if (!row) fail(404, '方案不存在。');
      const name = String(body.name || row.name).trim().slice(0, 100);
      const data = sanitizeState(body.data || safeJson(row.data_json), { allowMissingMedia: true });
      await store.updateScheme({
        id, name, data, row,
        replaceCover: Object.prototype.hasOwnProperty.call(body, 'coverImageId'),
        requestedCover: String(body.coverImageId || '').trim(),
        makeDefault: body.isDefault === true
      }, writePorts);
      return { ok: true };
    },

    async deleteScheme(id) {
      if (!await store.deleteScheme(id)) fail(404, '方案不存在。');
      return { ok: true };
    },

    async listSnippets() {
      const rows = await store.listSnippets();
      return rows.map(row => ({
        id: row.id, name: row.name, category: row.category,
        tags: safeJson(row.tags_json, []), createdAt: row.created_at, updatedAt: row.updated_at
      }));
    },

    async saveSnippet(body) {
      const name = String(body.name || '').trim().slice(0, 100);
      const category = String(body.category || 'style').trim().slice(0, 50);
      const tags = Array.isArray(body.tags) ? body.tags.slice(0, 200) : [];
      if (!name || !tags.length) fail(400, '片段名称和 Tag 不能为空。');
      return store.saveSnippet({ name, category, tags }, writePorts);
    },

    async deleteSnippet(id) {
      if (!await store.deleteSnippet(id)) fail(404, '片段不存在。');
      return { ok: true };
    },

    async exportBackup() {
      const { schemes, snippets, artistPreferences } = await store.exportBackup({ includeArtistPreferences });
      return {
        format: 'nai-pocket-backup-v1', exportedAt: clock.now(),
        schemes: schemes.map(item => ({ name: item.name, is_default: item.is_default, created_at: item.created_at, updated_at: item.updated_at, data: safeJson(item.data_json) })),
        snippets: snippets.map(item => ({ name: item.name, category: item.category, created_at: item.created_at, updated_at: item.updated_at, tags: safeJson(item.tags_json, []) })),
        ...(includeArtistPreferences ? { artistPreferences: artistPreferences.map(item => ({ artist: item.artist, favorite: Boolean(item.favorite), note: item.note })) } : {})
      };
    },

    async importBackup(body) {
      if (body.format !== 'nai-pocket-backup-v1') fail(400, '备份格式不正确。');
      const schemes = Array.isArray(body.schemes) ? body.schemes.slice(0, 500) : [];
      const snippets = Array.isArray(body.snippets) ? body.snippets.slice(0, 1000) : [];
      // Native-only optional v1 extension: validate before the shared transaction.
      
      let artistPreferences;
      if (includeArtistPreferences && Object.hasOwn(body, 'artistPreferences')) {
        if (!Array.isArray(body.artistPreferences) || body.artistPreferences.length > 50000) fail(400, '画师备份格式无效，最多支持 50000 条记录。');
        const records = body.artistPreferences.map(item => normalizeArtistPreference(item));
        artistPreferences = [...new Map(records.map(item => [item.artist, item])).values()];
      }
      const now = clock.now();
      const schemeRecords = [];
      for (const item of schemes) {
        if (!item?.name || !item?.data) continue;
        let data;
        try { data = sanitizeState(item.data, { allowMissingMedia: true }); } catch { continue; }
        schemeRecords.push({ name: String(item.name).slice(0, 100), data });
      }
      const snippetRecords = [];
      for (const item of snippets) {
        if (!item?.name || !Array.isArray(item.tags)) continue;
        snippetRecords.push({
          name: String(item.name).slice(0, 100),
          category: String(item.category || 'style').slice(0, 50), tags: item.tags.slice(0, 200)
        });
      }
      await store.importBackup({ schemes: schemeRecords, snippets: snippetRecords, now, ...(artistPreferences ? { artistPreferences } : {}) }, writePorts);
      return { ok: true, schemes: schemes.length, snippets: snippets.length, ...(artistPreferences ? { artistPreferences: artistPreferences.length } : {}) };
    }
  };
}
