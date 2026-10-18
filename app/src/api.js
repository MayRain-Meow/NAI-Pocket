import { Buffer } from 'buffer';
import { buildPayload, sanitizeGenerationState } from '../../public/generation-payload.js';
import { hasCjk } from '../../public/translation-core.js';
import { NAX_V5_ARTISTS } from '../../public/artist-index-v5.js';
import { nativeFiles, localPath } from './files.js';
import { PocketNative } from './providers.js';

function previewPayload(raw, seed) {
  const state = sanitizeGenerationState(raw), media = {};
  if (state.imageWorkflow?.baseImage) media.baseImage = `[asset:${state.imageWorkflow.baseImage.id}]`;
  if (state.imageWorkflow?.maskImage) media.maskImage = `[mask:${state.imageWorkflow.maskImage.id}]`;
  if (state.referenceControl?.mode === 'precise') media.precise = state.referenceControl.precise.map(item => ({ ...item, image: `[precise:${item.image.id}]` }));
  if (state.referenceControl?.mode === 'vibe') media.vibes = state.referenceControl.vibes.map(item => ({ ...item, image: `[encoded-vibe:${item.image.id}]` }));
  return buildPayload(state, seed ?? (state.seed || 1), media);
}
const failure = (status, message) => Object.assign(new Error(message), { status });
const bounded = (value, fallback, max) => Math.max(1, Math.min(max, Number.parseInt(value, 10) || fallback));

// Local /api transport for the existing UI. No server URL or credentials cross this boundary.
export function createLocalApi({ database, settings, providers, client, assets, media, schemes, queue, references }) {
  const { translations, search, codex, tagger } = references;
  const { db, serial } = database;
  const providerCall = providers.call;
  const json = value => Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
  async function assetResponse(asset) { await media.registerAsset(await assets.get(asset.id)); return asset; }
  async function route(request) {
    const url = new URL(request.url), pathname = url.pathname, method = request.method, query = url.searchParams;
    const body = async () => { if (Number(request.headers.get('content-length') || 0) > 8 * 1024 * 1024) throw failure(413, '请求过大。'); return request.json(); };
    const bytes = async () => { const data = Buffer.from(await request.arrayBuffer()); if (data.length > 24 * 1024 * 1024) throw failure(413, '图片最大 24 MB。'); return data; };
    if (pathname === '/api/auth/me') return { role: 'owner', local: true };
    if (pathname === '/api/auth/visitor-password' && method === 'GET') return { enabled: false };
    if (pathname === '/api/artists/identities' && method === 'GET') return { identities: await references.artists.identities() };
    if (pathname === '/api/artists/resources/import' && method === 'POST') return references.artistPacks.importPack();
    if (pathname === '/api/artists/resources/download' && method === 'POST') return references.artistPacks.downloadPack(await body());
    if (pathname === '/api/artists/resources/catalog' && method === 'POST') return references.artistPacks.readCatalog(await body());
    if (pathname === '/api/artists/resources/status' && method === 'GET') return references.artistPacks.status();
    if (pathname === '/api/artists/resources/cancel' && method === 'POST') return references.artistPacks.cancel();
    if (pathname === '/api/artists/resources/image' && method === 'GET') {
      const result = await references.artistResources.image(query.get('id'), query.get('tier') || 'thumb', { signal:request.signal, revision:query.get('revision') });
      return new Response(result.buffer, { headers: { 'Content-Type':result.contentType, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' } });
    }
    // 画风数据: the style index behind 按感觉找 / 找相似 (same /api/artists/style-index shape as the server).
    if (pathname === '/api/artists/style-index' && method === 'GET') return references.artistLibrary.styleInfo();
    if (pathname === '/api/artists/style-pack' && method === 'GET') return references.stylePack.state();
    if (pathname === '/api/artists/style-pack' && method === 'DELETE') return references.stylePack.remove();
    if (pathname === '/api/artists/style-pack/manifest' && method === 'POST') return references.stylePack.readManifest(await body());
    if (pathname === '/api/artists/style-pack/download' && method === 'POST') return references.stylePack.download(await body());
    if (pathname === '/api/artists/style-pack/status' && method === 'GET') return references.stylePack.status();
    if (pathname === '/api/artists/style-pack/cancel' && method === 'POST') return references.stylePack.cancel();
    // 以图找画师: the picture is embedded on the phone; list requests then rank by image=<id>.
    if (pathname === '/api/artists/style-image' && method === 'POST') return { image: await references.styleImages.embed(await bytes()) };
    if (pathname === '/api/artists/style-model' && method === 'GET') return references.styleImages.state();
    if (pathname === '/api/artists/style-model' && method === 'DELETE') return references.styleImages.remove();
    if (pathname === '/api/artists/style-model/manifest' && method === 'POST') return references.styleImages.readManifest(await body());
    if (pathname === '/api/artists/style-model/download' && method === 'POST') return references.styleImages.download(await body());
    if (pathname === '/api/artists/style-model/status' && method === 'GET') return references.styleImages.status();
    if (pathname === '/api/artists/style-model/cancel' && method === 'POST') return references.styleImages.cancel();
    if (pathname === '/api/artists/resources/sets' && method === 'GET') { const { sets, profiles } = await references.artistResources.catalog(); return { sets, artists: profiles.length }; }
    // The artist page is the shared artist-library UI; these follow the server's response shapes.
    if (pathname === '/api/artists' && method === 'GET') return references.artistLibrary.list(Object.fromEntries(query));
    if (pathname === '/api/artists/summary' && method === 'GET') return { summary: await references.artistLibrary.summary() };
    if (pathname === '/api/artists/stats' && method === 'POST') { const data = await body(); return { stats: await references.artistDanbooru.sync({ artist: typeof data?.artist === 'string' ? data.artist : '' }, { signal: request.signal }) }; }
    if (pathname === '/api/artists/profile') {
      if (method === 'GET') return { artist: await references.artistLibrary.profile(query.get('artist')) };
      if (method === 'PUT') return { artist: await references.artistLibrary.save(await body()) };
    }
    if (pathname === '/api/nax/artist-preview' && method === 'GET') {
      const preview = await references.naxPreview(query.get('artist'), { signal: request.signal });
      return new Response(preview.buffer, { headers: { 'Content-Type': preview.contentType, 'Cache-Control': 'no-store' } });
    }
    if (pathname === '/api/providers' && method === 'GET') return { providers: await providerCall('providerStatus') };
    if (pathname === '/api/providers/rbq' && method === 'POST') return { providers: await providerCall('saveRbqToken', (await body()).token) };
    if (pathname === '/api/providers/rbq/account') return providerCall('getRbqAccountStatus');
    if (pathname === '/api/providers/rbq' && method === 'DELETE') {
      const active = await serial(() => db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending','running') AND json_extract(request_json,'$.provider')='rbq'").get());
      if (Number(active.count)) throw failure(409, `仍有 ${active.count} 个任务使用 RBQ，请先完成或取消任务。`);
      return { providers: await providerCall('deleteRbqToken') };
    }
    if (pathname === '/api/providers/relays' && method === 'POST') return providerCall('saveRelay', await body());
    if (pathname === '/api/providers/official/accounts' && method === 'POST') { const data = await body(); return providerCall('saveOfficialToken', data.name, data.token); }
    let match = pathname.match(/^\/api\/providers\/relays\/([^/]+)$/);
    if (match) {
      const id = `relay:${decodeURIComponent(match[1])}`;
      if (method === 'PUT') return providerCall('saveRelay', { ...(await body()), id });
      if (method === 'DELETE') {
        const active = await serial(() => db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending','running') AND json_extract(request_json,'$.provider')=?").get(id));
        if (Number(active.count)) throw failure(409, `仍有 ${active.count} 个任务使用这个中转，请先完成或取消任务。`);
        return { providers: await providerCall('deleteRelay', id) };
      }
    }
    match = pathname.match(/^\/api\/providers\/official\/accounts\/([^/]+)(\/default)?$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (method === 'PUT' && match[2]) return { providers: await providerCall('setDefaultOfficialAccount', id) };
      if (method === 'PUT') { const data = await body(); return providerCall('updateOfficialToken', id, data.name, data.token); }
      if (method === 'DELETE') {
        const active = await serial(() => db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending','running') AND (COALESCE(json_extract(request_json,'$.provider'),'official')='official' OR json_extract(request_json,'$.referenceControl.mode')='vibe') AND json_extract(request_json,'$.officialAccountId')=?").get(id));
        if (Number(active.count)) throw failure(409, `仍有 ${active.count} 个任务固定使用此 Token，请先完成或取消任务。`);
        return { providers: await providerCall('deleteOfficialToken', id) };
      }
    }
    if (pathname === '/api/novelai/account') return client.getSubscriptionStatus({ officialAccountId: query.get('accountId') || '', signal: request.signal });
    if (pathname === '/api/system') return { version: '1.6.81-android', queuePaused: await queue.control.isQueuePaused(),
      limits: { maxBatchSize: settings.maxBatchSize, maxQueueSize: settings.maxQueueSize, maxStormSize: settings.maxStormSize },
      resources: await queue.resources(), counts: (await queue.jobs.list(new URLSearchParams('limit=1'))).counts, storageAudit: null };
    if (pathname === '/api/schemes') {
      if (method === 'GET') return schemes.listSchemes();
      if (method === 'POST') return schemes.createScheme(await body());
    }
    match = pathname.match(/^\/api\/schemes\/([^/]+)$/);
    if (match && method === 'PUT') return schemes.updateScheme(match[1], await body());
    if (match && method === 'DELETE') return schemes.deleteScheme(match[1]);
    if (pathname === '/api/snippets' && method === 'GET') return schemes.listSnippets();
    if (pathname === '/api/snippets' && method === 'POST') return (await schemes.saveSnippet(await body())).data;
    match = pathname.match(/^\/api\/snippets\/([^/]+)$/);
    if (match && method === 'DELETE') return schemes.deleteSnippet(match[1]);
    if (pathname === '/api/export' && method === 'GET') return schemes.exportBackup();
    if (pathname === '/api/import' && method === 'POST') return schemes.importBackup(await body());
    if (pathname === '/api/assets' && method === 'POST') return assetResponse(await assets.save(await bytes(), { mime: request.headers.get('content-type'), originalName: decodeURIComponent(request.headers.get('x-file-name') || '') }));
    if (pathname === '/api/assets/from-gallery' && method === 'POST') return assetResponse(await assets.cloneGallery((await body()).imageId));
    if (pathname === '/api/assets/recent') return assets.recent(query.get('limit'));
    match = pathname.match(/^\/api\/assets\/([^/]+)\/original$/);
    if (match && ['GET','HEAD'].includes(method)) {
      const row = await assets.get(match[1]); if (!row) throw failure(404, '参考图不存在。');
      return new Response(method === 'HEAD' ? null : await nativeFiles.read(localPath('input-assets', row.stored_name)), { headers: { 'Content-Type': row.mime } });
    }
    if (pathname === '/api/payload-preview' && method === 'POST') return previewPayload((await body()).state);
    if (pathname === '/api/inspect-image' && method === 'POST') return references.inspectNovelAiPng(await bytes());
    if (pathname === '/api/jobs' && method === 'GET') {
      const result = await queue.jobs.list(query);
      await media.registerIds([...result.jobs.map(job => job.image_id), ...result.completedImages.map(item => item.image.id)]);
      return result;
    }
    if (pathname === '/api/jobs/enqueue' && method === 'POST') { const data = await body(); return queue.enqueue(data.state, bounded(data.count, 1, settings.maxBatchSize)); }
    if (['/api/jobs/pause','/api/jobs/resume'].includes(pathname) && method === 'POST') {
      const paused = pathname.endsWith('pause'); await queue.control.setQueuePaused(paused); queue.kick(); return { paused };
    }
    if (pathname === '/api/jobs/cancel-all' && method === 'POST') {
      const result = await queue.control.cancelQueuedJobs(await body()); queue.kick(); return result;
    }
    if (pathname === '/api/jobs/reroute' && method === 'POST') {
      const data = await body(), result = await queue.control.rerouteQueuedJobs(data);
      if (data.resume === true) { await queue.control.setQueuePaused(false); queue.kick(); }
      return { ...result, paused: await queue.control.isQueuePaused() };
    }
    match = pathname.match(/^\/api\/(jobs|batches)\/([^/]+)\/(cancel|retry|logs)$/);
    if (match) {
      const [, kind, id, action] = match;
      if (action === 'logs' && method === 'GET') return { jobId: id, logs: await queue.control.getJobLogs(id, query.get('limit')) };
      if (method === 'POST') {
        const result = await queue.control[kind === 'batches' ? 'cancelBatch' : action === 'cancel' ? 'cancelJob' : 'retryJob'](id);
        if (!result.ok) throw failure(409, result.reason); queue.kick(); return result;
      }
    }
    if (pathname === '/api/images' && method === 'GET') { const result = await media.gallery.list(query); await media.registerIds(result.images.map(image => image.id)); return result; }
    if (pathname === '/api/images/batch-delete' && method === 'POST') { const data = await body(); return media.gallery.deleteImages(data.ids, { permanent: data.permanent === true }); }
    // 回收站 (1.8.4 / 0.6.1): as on the server.
    if (pathname === '/api/images/trash' && method === 'GET') return media.gallery.listTrash();
    if (pathname === '/api/images/trash/restore' && method === 'POST') { const result = await media.gallery.restoreTrash((await body()).ids); await media.registerIds(result.restored); return result; }
    if (pathname === '/api/images/trash/purge' && method === 'POST') { const data = await body(); return media.gallery.purgeTrash({ ids: data.ids, all: data.all === true }); }
    match = pathname.match(/^\/api\/images\/trash\/([^/]+)\/thumbnail$/);
    if (match && ['GET', 'HEAD'].includes(method)) {
      const name = await media.gallery.trashThumbnailName(decodeURIComponent(match[1]));
      return new Response(method === 'HEAD' ? null : await nativeFiles.read(localPath('thumbnails', name)), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store' } });
    }
    match = pathname.match(/^\/api\/images\/([^/]+)(?:\/(payload|thumbnail|preview|original|clean|favorite|note))?$/);
    if (match) {
      const [, id, action] = match;
      if (!action && method === 'GET') return media.gallery.getImage(id);
      if (!action && method === 'DELETE') return media.gallery.deleteImage(id);
      if (action === 'favorite' && method === 'POST') return media.gallery.setFavorite(id, (await body()).favorite);
      if (action === 'note' && method === 'PATCH') return media.gallery.setNote(id, (await body()).note);
      if (action === 'payload' && method === 'GET') { const row = await media.gallery.getImage(id); return previewPayload(row.params, row.seed); }
      if (action === 'clean' && method === 'GET') { const value = await media.media.clean(id); return new Response(value.body, { headers: value.headers }); }
      if (['thumbnail','preview','original'].includes(action) && ['GET','HEAD'].includes(method)) {
        const value = await media.media[action](id, query.get('download') === '1');
        return new Response(method === 'HEAD' ? null : await nativeFiles.read(value.file), { headers: { 'Content-Type': value.mime, ...value.options?.headers } });
      }
    }
    if (pathname === '/api/translations/status') return { ...await translations.translationStatus(), search: search.danbooruSearchStatus() };
    if (pathname === '/api/translate' && method === 'POST') { const data = await body(), value = String(data.text || '').trim().slice(0, 500); if (!value) throw failure(400, '待翻译文本不能为空。'); return translations.translateText(value, data.source || 'auto', data.target || (hasCjk(value) ? 'en' : 'zh-CN'), { allowRemote: data.remote !== false, force: data.force === true }); }
    if (pathname === '/api/translations/batch' && method === 'POST') { const data = await body(); return translations.translateBatch((Array.isArray(data.items) ? data.items : []).slice(0, 100), data.source || 'en', data.target || 'zh-CN', { allowRemote: data.remote !== false }); }
    if (pathname === '/api/translations/manual' && method === 'POST') { const data = await body(); return translations.saveManualTranslation(data.sourceText, data.translatedText, data.source || 'en', data.target || 'zh-CN'); }
    if (pathname === '/api/translations/refresh' && method === 'POST') return references.refreshTagTranslations((await body()).items, { signal: request.signal });
    match = pathname.match(/^\/api\/danbooru\/(search|related|artists)$/);
    if (match && method === 'POST') return search[{ search: 'semanticSearch', related: 'relatedTags', artists: 'artistRecommendations' }[match[1]]](await body(), { signal: request.signal });
    if (pathname === '/api/codex' && method === 'GET') return codex.listCodexes();
    match = pathname.match(/^\/api\/codex\/([A-Za-z0-9_-]{1,80})$/);
    if (match && method === 'GET') return codex.queryCodex(match[1], Object.fromEntries(query));
    if (pathname === '/api/tagger' && method === 'POST') {
      const image = query.get('imageId') ? await media.media.readForTagger(query.get('imageId')) : { buffer: await bytes(), mime: request.headers.get('content-type') };
      return tagger.interrogateImage(image.buffer, image.mime, { signal: request.signal });
    }
    if (pathname === '/api/tags/suggest' && method === 'GET') {
      const q = String(query.get('q') || '').trim().slice(0, 120); if (!q) return [];
      if (query.get('local') === '1') return translations.localTagSuggestions(q, NAX_V5_ARTISTS);
      let english = q;
      if (hasCjk(q)) { const translated = await translations.translateText(q, 'zh-CN', 'en'); english = translated.text || q; }
      const result = await client.suggestTags(query.get('model'), english);
      const translated = await translations.translateBatch(result.slice(0, settings.translationSuggestLimit).map(item => item.tag), 'en', 'zh-CN', { allowRemote: false });
      const labels = new Map(translated.map(item => [item.sourceText, item]));
      return result.map(item => ({ ...item, translation: labels.get(item.tag)?.text || '', queryEnglish: english }));
    }
    throw failure(404, '此本机版本不提供该功能。');
  }
  return {
    async fetch(input, options) {
      const request = input instanceof Request ? new Request(input, options) : new Request(new URL(input, location.origin), options);
      request.signal.throwIfAborted();
      try { const result = await route(request); request.signal.throwIfAborted(); return result instanceof Response ? result : json(result); }
      catch (error) {
        if (request.signal.aborted) throw request.signal.reason;
        const status = Number(error.status) >= 400 && Number(error.status) <= 599 ? Number(error.status) : 400;
        return Response.json({ error: error.message || '本机操作失败。', source: 'local-runtime' }, { status, headers: { 'Cache-Control': 'no-store', ...(error.retryAfterMs ? { 'Retry-After': String(Math.ceil(error.retryAfterMs / 1000)) } : {}) } });
      }
    },
    async download(url) {
      const parsed = new URL(url, location.origin), match = parsed.pathname.match(/^\/api\/images\/([^/]+)\/(original|clean)$/);
      if (match?.[2] === 'original') {
        const descriptor = await media.media.original(match[1], true);
        const name = descriptor.options.headers['Content-Disposition'].match(/filename="([^"]+)"/)?.[1] || 'nai-image.png';
        return (await PocketNative.exportFile({ path: descriptor.file, mime: descriptor.mime, name })).saved;
      }
      const response = await this.fetch(parsed.href);
      if (!response.ok) throw new Error((await response.json()).error);
      const name = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || `nai-pocket-backup-${new Date().toISOString().slice(0, 10)}.json`;
      return (await PocketNative.exportFile({ data: Buffer.from(await response.arrayBuffer()).toString('base64'), name, mime: response.headers.get('content-type') || 'application/octet-stream' })).saved;
    }
  };
}
