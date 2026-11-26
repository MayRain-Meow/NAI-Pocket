
import { App } from '@capacitor/app';
import { registerPlugin } from '@capacitor/core';
import { version as appVersion } from '../package.json';
import { createNativeGenerationClient } from './novelai.js';
import { createSchemesService } from '../../service/schemes.js';
import { createSchemesStore } from '../../service/storage/schemes.js';
import { sanitizeGenerationState } from '../../public/generation-payload.js';
import { openDatabase } from './sqlite.js';
import { openProviders, PocketNative } from './providers.js';
import { nativeFetch } from './http.js';
import { openAssets } from './assets.js';
import { openMedia } from './media.js';
import { openQueue } from './queue.js';
import { openReferences } from './references.js';
import { createLocalApi } from './api.js';
import { settings } from './settings.js';
import { artistResourcesSection, artistResourceNotice, stylePackSection, styleModelSection, exampleImagesSection } from './artist-resources-section.js';
import { createImageLoader } from './image-loader.js';
import { DEFAULT_ARTIST_CATALOG_URL, V5_EXAMPLES_CATALOG_URL, CURRENT_ARTIST_CATALOG_VERSION, PREVIOUS_ARTIST_CATALOG_URLS } from './artist-resource-source.js';
import { CURRENT_STYLE_VERSION } from './style-pack.js';
import { createUpdater } from './updater.js';
import { appUpdateSection } from './update-section.js';
import { downloadSettingsSection } from './download-settings.js';

document.body.classList.add('native-mode');
// Native-only settings row, created here so the shared web markup stays unchanged.
// Settings → 关于: who makes the app and where its source and releases live.
export const APP_AUTHOR = 'MayRain-Meow';
export const APP_REPOSITORY = 'https://github.com/MayRain-Meow/NAI-Pocket';
function aboutSection(version, licenseButton) {
  const section = document.createElement('section'); section.className = 'settings-dialog-section native-about-section';
  const heading = document.createElement('div'); heading.className = 'settings-section-heading';
  heading.innerHTML = '<span class="workspace-eyebrow">About</span><h2>关于</h2>';
  const name = document.createElement('p'); name.className = 'native-about-name';
  name.append(Object.assign(document.createElement('strong'), { textContent: 'NAI Pocket' }), Object.assign(document.createElement('span'), { textContent: ` ${version}` }));
  const author = document.createElement('p'); author.className = 'native-about-author'; author.textContent = `作者 ${APP_AUTHOR}`;
  const link = document.createElement('a'); link.className = 'native-about-link'; link.href = APP_REPOSITORY; link.target = '_blank'; link.rel = 'noopener';
  link.textContent = APP_REPOSITORY.replace(/^https:\/\//, '');
  const star = document.createElement('a'); star.className = 'native-star-button'; star.href = APP_REPOSITORY; star.target = '_blank'; star.rel = 'noopener';
  star.innerHTML = '<span aria-hidden="true">★</span>在 GitHub 点个 Star';
  const starHint = document.createElement('p'); starHint.className = 'native-star-hint';
  starHint.textContent = 'NAI Pocket 开源免费。觉得好用的话点个 Star，能让更多人找到它。';
  const actions = document.createElement('div'); actions.className = 'native-about-actions';
  licenseButton.textContent = '开源许可';
  actions.append(star, licenseButton);
  section.append(heading, name, author, link, starHint, actions);
  return section;
}

// One gentle invitation, once, after the app has been opened a few times. Never repeated,
// never part of the release notes. Local counters only.
const STAR_LAUNCHES = 'nai-pocket-launches', STAR_ASKED = 'nai-pocket-star-invited';
function inviteStarLater(confirmAction) {
  try {
    if (localStorage.getItem(STAR_ASKED)) return;
    const launches = Number(localStorage.getItem(STAR_LAUNCHES) || 0) + 1;
    localStorage.setItem(STAR_LAUNCHES, String(launches));
    if (launches < 5) return;
    setTimeout(async () => {
      if (document.querySelector('dialog[open]')) return; // never on top of something the user is doing
      localStorage.setItem(STAR_ASKED, String(Date.now()));
      const yes = await confirmAction('NAI Pocket 是开源免费的。觉得好用的话，去 GitHub 点个 Star，能让更多人找到它。', { title: '喜欢 NAI Pocket 吗？', confirmLabel: '去点 Star', cancelLabel: '以后再说' });
      if (yes) window.open(APP_REPOSITORY, '_blank', 'noopener');
    }, 12000);
  } catch {}
}

// 本机存储 (0.7.5): what the app keeps on the phone and the one safe thing to clear, plus the warning that
// uninstalling erases the gallery, schemes and accounts (a user reinstalled to fix a start-up problem).
const STORAGE_KINDS = [
  ['生成的图', ['originals', 'thumbnails', 'previews']], ['参考图', ['input-assets']],
  ['画师资料与例图包', ['artist-resources']], ['例图缓存', ['artist-cache']], ['画风数据', ['style-index']], ['以图找画师模型', ['style-model']]
];
const megabytes = bytes => { const value = Math.max(0, Number(bytes) || 0); return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`; };
function storageSection({ request, notice }) {
  const block = document.createElement('section'); block.className = 'settings-dialog-section native-storage';
  const heading = document.createElement('div'); heading.className = 'settings-section-heading';
  const eyebrow = document.createElement('span'); eyebrow.className = 'workspace-eyebrow'; eyebrow.textContent = 'Storage';
  const title = document.createElement('h2'); title.textContent = '本机存储'; heading.append(eyebrow, title);
  const status = document.createElement('p'); status.className = 'hint'; status.setAttribute('role', 'status'); status.textContent = '打开设置时统计…';
  const list = document.createElement('div'); list.className = 'native-storage-list';
  const clear = document.createElement('button'); clear.className = 'ghost'; clear.textContent = '清理例图缓存'; clear.dataset.storageClear = 'example-cache';
  const warn = document.createElement('p'); warn.className = 'hint native-storage-warning';
  warn.textContent = '遇到打不开、卡住或空间不够，先在这里清理例图缓存，或在下面删除、重新下载资料。不要卸载重装：卸载会清空图库、方案和账号，无法找回（相册里的原图除外）。';
  block.append(heading, status, list, clear, warn);
  let busy = false;
  async function measure(outcome = '') {
    if (busy) return; busy = true;
    try {
      const usage = await request('/api/storage/usage'), folders = usage.folders || {};
      const known = new Set(STORAGE_KINDS.flatMap(([, names]) => names));
      const other = Object.entries(folders).filter(([name]) => !known.has(name)).reduce((sum, [, bytes]) => sum + Number(bytes || 0), 0) + Number(usage.databaseBytes || 0) + Number(usage.cacheBytes || 0);
      const rows = [...STORAGE_KINDS.map(([label, names]) => [label, names.reduce((sum, name) => sum + Number(folders[name] || 0), 0)]), ['任务记录、设置与其他', other]];
      list.replaceChildren(...rows.map(([label, bytes]) => { const row = document.createElement('div'); row.className = 'native-storage-row'; row.dataset.storageKind = label;
        const name = document.createElement('span'); name.textContent = label; const size = document.createElement('b'); size.textContent = megabytes(bytes); row.append(name, size); return row; }));
      const total = rows.reduce((sum, [, bytes]) => sum + bytes, 0);
      status.textContent = `${outcome ? `${outcome} ` : ''}本机共占用 ${megabytes(total)}，手机剩余 ${megabytes(usage.freeBytes)}。`;
      clear.disabled = !Number(folders['artist-cache'] || 0);
    } catch (error) { status.textContent = `本机存储读取失败：${error.message}`; }
    finally { busy = false; }
  }
  clear.addEventListener('click', async () => {
    clear.disabled = true;
    try { const result = await request('/api/storage/example-cache', { method: 'DELETE' }); await measure(`已清理例图缓存 ${megabytes(result.freedBytes)}。`); }
    catch (error) { notice(error.message); clear.disabled = false; }
  });
  // Measured when 设置 opens (never at start-up): walking the folders takes a moment on a large gallery.
  const dialog = document.getElementById('settingsDialog');
  if (dialog) new MutationObserver(() => { if (dialog.open) measure(); }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  return block;
}

async function phoneAlbumSection(queue) {
  const section = document.createElement('section'); section.className = 'settings-dialog-section native-album-section';
  const heading = document.createElement('div'); heading.className = 'settings-section-heading';
  const eyebrow = document.createElement('span'); eyebrow.className = 'workspace-eyebrow'; eyebrow.textContent = 'Album';
  const title = document.createElement('h2'); title.textContent = '手机相册'; heading.append(eyebrow, title);
  const label = document.createElement('label'); label.className = 'native-album-toggle';
  const input = document.createElement('input'); input.type = 'checkbox'; input.id = 'nativePhoneAlbumToggle';
  const text = document.createElement('span'); text.textContent = '生成完成后，自动保存原图'; label.append(input, text);
  const hint = document.createElement('p'); hint.className = 'hint';
  const album = typeof __POCKET_EXPERIENCE__ !== 'undefined' && __POCKET_EXPERIENCE__ ? 'NAI Pocket Experience' : 'NAI Pocket';
  hint.textContent = `自动另存到系统相册 Pictures/${album}，始终保留元数据；不使用“图片下载”的净图选项。应用内图库不受影响，复制失败也不影响任务。`;
  try { input.checked = await queue.phoneGallery.enabled(); } catch { input.checked = true; }
  input.addEventListener('change', async () => {
    const wanted = input.checked;
    try {
      await queue.phoneGallery.setEnabled(wanted);
      if (wanted && !(await PocketNative.requestGalleryAccess()).granted) notice('未获得存储权限，新图片不会复制到手机相册；应用内图库照常保存。');
    } catch (error) { input.checked = await queue.phoneGallery.enabled().catch(() => !wanted); notice(error.message); }
  });
  section.append(heading, label, hint); return section;
}
// The page's toast rules (public/app.js) for the app's own messages: a repeated message restarts its
// timer, at most three stay on screen, and the update prompts are never pushed out.
const notice = (message, type = 'error') => {
  const host = document.getElementById('toastHost'); if (!host || !message) return;
  const messages = () => [...host.querySelectorAll('.toast:not(.update-banner):not(.native-update-toast)')];
  let node = messages().find(item => item.textContent === message && item.dataset.type === type);
  if (node) clearTimeout(node.toastTimer);
  else { node = document.createElement('div'); node.className = `toast ${type}`; node.dataset.type = type; node.textContent = message; }
  host.append(node);
  const stack = messages();
  for (const old of stack.slice(0, Math.max(0, stack.length - 3))) { clearTimeout(old.toastTimer); old.remove(); }
  node.toastTimer = setTimeout(() => node.remove(), type === 'error' ? 8000 : 4200);
};
window.addEventListener('nai-runtime-error', event => notice(event.detail));
// Start-up watchdog (0.7.5): the launch screen never just hangs. After 15 s without the editor, say which
// step is running and offer 继续等待 / 安全启动 / 重新打开 — never an uninstall, which erases the gallery.
const SAFE_START_KEY = 'nai-pocket-safe-start';
let safeStart = false;
try { safeStart = localStorage.getItem(SAFE_START_KEY) === '1'; localStorage.removeItem(SAFE_START_KEY); } catch { /* storage unavailable: a normal start */ }
let bootStep = '打开本机数据库', bootStartedAt = Date.now(), bootWatchdog = 0;
// Start-up record (0.7.7): each step is written to disk (natively, so it survives a crash) before it
// runs. A start that never reached the editor — a crash, a dead WebView, the app killed — makes the next
// start a safe start, with a card that says where it stopped and copies the diagnostics for the author.
let bootRecord = null;
try { bootRecord = await PocketNative.bootBegin({ version: appVersion }); } catch { /* older shell: no record */ }
const lastStartFailed = Boolean(bootRecord?.previous && bootRecord.previous.done === false);
if (lastStartFailed) safeStart = true;
const markStep = async step => { bootStep = step; try { await PocketNative.bootMark({ step }); } catch {} };
function bootDiagnostics() {
  const d = bootRecord?.device || {}, gb = bytes => bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : '?';
  const when = at => at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '?';
  const lines = [`NAI Pocket ${appVersion} · Android ${d.android || '?'} (SDK ${d.sdk || '?'}) · ${[d.manufacturer, d.model].filter(Boolean).join(' ') || '未知机型'}`,
    `内存：可用 ${gb(d.availableMemory)} / 共 ${gb(d.totalMemory)}${d.lowMemory ? '（系统内存紧张）' : ''} · 单应用上限 ${d.memoryClass || '?'} MB（大内存 ${d.largeMemoryClass || '?'} MB）`,
    `WebView：${d.webView || '?'}`];
  if (bootRecord?.previous) lines.push(`上次启动：${bootRecord.previous.version || '?'} · 停在「${bootRecord.previous.step || '?'}」 · ${when(bootRecord.previous.startedAt)} · 连续未完成 ${bootRecord.failures || 0} 次`);
  if (bootRecord?.crash) lines.push(`崩溃记录（${bootRecord.crash.type === 'renderer' ? '页面进程退出' : '原生异常'}，${when(bootRecord.crash.at)}）：`, bootRecord.crash.detail || '');
  return lines.join('\n');
}
function recoveredCard({ hold = false } = {}) {
  const card = document.createElement('section'); card.className = 'native-start-recovered'; card.setAttribute('role', 'status');
  const title = document.createElement('strong'); title.textContent = '上次没有正常打开，这次用安全启动打开了';
  const detail = document.createElement('p');
  detail.textContent = `上次停在「${bootRecord.previous.step || '启动'}」${bootRecord.failures > 1 ? `，已连续 ${bootRecord.failures} 次` : ''}。这次跳过了资料整理和图库预载；图库、方案和账号都还在，请不要卸载重装。如果还是打不开，把诊断信息发给作者。`;
  const actions = document.createElement('div'); actions.className = 'native-start-recovered-actions';
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制诊断信息';
  copy.onclick = async () => {
    const text = bootDiagnostics();
    try { await navigator.clipboard.writeText(text); copy.textContent = '已复制'; }
    catch { const area = document.createElement('textarea'); area.value = text; area.readOnly = true; card.append(area); area.select(); copy.textContent = '请长按复制'; }
  };
  const close = document.createElement('button'); close.type = 'button'; close.className = 'is-quiet'; close.textContent = hold ? '继续启动' : '知道了';
  // Stopped twice or more in a row: the start waits here, so the diagnostics can be copied even when every
  // start dies at the same step a moment later.
  card.proceed = new Promise(resolve => { close.onclick = () => { if (hold) { close.textContent = '知道了'; hold = false; resolve(); } else card.remove(); }; if (!hold) resolve(); });
  actions.append(copy, close); card.append(title, detail, actions);
  return card;
}
if (lastStartFailed) {
  const card = recoveredCard({ hold: bootRecord.failures >= 2 });
  document.body.append(card);
  await card.proceed;
}
const bootStuckPanel = () => {
  if (!document.body.classList.contains('native-booting') || document.querySelector('.native-startup-slow')) return;
  const panel = document.createElement('main'); panel.className = 'native-startup-error native-startup-slow';
  const title = document.createElement('h1'); title.textContent = '启动比平常慢';
  const detail = document.createElement('p'); detail.textContent = `正在：${bootStep}（已 ${Math.round((Date.now() - bootStartedAt) / 1000)} 秒）。图库很大时第一次会慢一些。`;
  const keep = document.createElement('p'); keep.textContent = '不要卸载重装：卸载会清空图库、方案和账号，无法找回。可以先「安全启动」，进去后在 设置 → 本机存储 清理。';
  const wait = document.createElement('button'); wait.textContent = '继续等待';
  wait.onclick = () => { panel.remove(); bootWatchdog = setTimeout(bootStuckPanel, 20000); };
  const safe = document.createElement('button'); safe.textContent = '安全启动';
  safe.onclick = () => { try { localStorage.setItem(SAFE_START_KEY, '1'); } catch {} location.reload(); };
  const retry = document.createElement('button'); retry.className = 'ghost'; retry.textContent = '重新打开'; retry.onclick = () => location.reload();
  panel.append(title, detail, keep, wait, safe, retry); document.body.append(panel);
};
bootStartedAt = Date.now(); bootWatchdog = setTimeout(bootStuckPanel, 15000);
try {
  await markStep('打开本机数据库');
  const database = await openDatabase(), http = { fetch: nativeFetch };
  await markStep('读取账号与通道');
  const providers = await openProviders(settings, http), assets = openAssets(database, settings, http, providers);
  const client = createNativeGenerationClient({ settings, assets, generationProvider: providers.generationProvider,
    ids: { request: () => crypto.randomUUID().slice(0, 6) }, http });
  let queue;
  const media = openMedia(database, () => queue.resources());
  queue = openQueue(database, settings, providers, client, media, assets);
  const schemes = createSchemesService({ store: database.store(createSchemesStore(database.db, database.transaction)),
    clock: { now: () => Date.now() }, ids: { next: () => crypto.randomUUID() }, sanitizeState: sanitizeGenerationState, includeArtistPreferences: true });
  const references = openReferences(database, settings, http);
  await markStep('整理画师资料');
  if (safeStart && !lastStartFailed) setTimeout(() => notice('这次是安全启动：跳过了资料整理和图库预载。可在 设置 → 本机存储 清理，下次正常启动。', 'info'), 1200);
  else {
    try {await references.artistPacks.recover();}
    catch {notice('旧资料清理未完成，现有资料仍可使用；下次启动会重试。');}
  }
  const api = createLocalApi({ database, settings, providers, assets, media, queue, client, schemes, references });
  const browserFetch = window.fetch.bind(window);
  window.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input, location.origin);
    return url.origin === location.origin && url.pathname.startsWith('/api/') ? api.fetch(input, options) : browserFetch(input, options);
  };
  globalThis.NAI_RUNTIME = { native: true, download: (url, options) => api.download(url, options),
    downloads: { getFolder: () => PocketNative.getExportFolder(), chooseFolder: () => PocketNative.chooseExportFolder() },
    loadImage: createImageLoader(url => api.fetch(url)) };
  const settingsBody = document.querySelector('.settings-dialog-body') || document.querySelector('#settingsDialog .dialog-body');
  const licenseButton = document.createElement('button'); licenseButton.className = 'ghost'; licenseButton.textContent = '关于 / 开源许可';
  licenseButton.addEventListener('click', async () => {
    try {
      const dialog = document.createElement('dialog'); dialog.className = 'native-license-dialog';
      const heading = document.createElement('strong'); heading.textContent = 'NAI Pocket · AGPL-3.0';
      const close = document.createElement('button'); close.textContent = '关闭'; close.onclick = () => dialog.close();
      const content = document.createElement('pre'); content.textContent = await (await browserFetch('/licenses.txt')).text();
      dialog.append(heading, close, content); dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
    } catch (error) { notice(error.message); }
  });
  const request = async (path, { method = 'GET', body } = {}) => {
    const response = await api.fetch(path, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || '本机操作失败。'); return data;
  };
  const resourcesSection = artistResourcesSection({ request, defaultCatalogUrl: DEFAULT_ARTIST_CATALOG_URL, previousCatalogUrls: PREVIOUS_ARTIST_CATALOG_URLS, notice });
  const styleSection = stylePackSection({ request, notice });
  const experience = typeof __POCKET_EXPERIENCE__ !== 'undefined' && __POCKET_EXPERIENCE__;
  const updateSection = experience ? document.createElement('section') : appUpdateSection({ updater: createUpdater({ fetch: http.fetch, state: queue.state, currentVersion: appVersion }),
    native: registerPlugin('AppUpdate'), currentVersion: appVersion });
  if (experience) {
    updateSection.className = 'settings-dialog-section';
    updateSection.innerHTML = '<div class="settings-section-heading"><span class="workspace-eyebrow">// ENDFIELD</span><h2>Endfield 独立版</h2></div><p class="hint">版本 0.7.10-endfield.2，基于 NAI Pocket 0.7.10。此为独立修改版，并非原作者的官方发布。不接收原版自动更新；源码与修改说明随安装包提供。</p>';
  }
  settingsBody?.append(downloadSettingsSection({ native: PocketNative, notice, experience: typeof __POCKET_EXPERIENCE__ !== 'undefined' && __POCKET_EXPERIENCE__ }),
    await phoneAlbumSection(queue), storageSection({ request, notice }), resourcesSection, exampleImagesSection({ request, catalogUrl: V5_EXAMPLES_CATALOG_URL, notice }), styleSection, styleModelSection({ request, notice }), updateSection, aboutSection(appVersion, licenseButton));
  document.getElementById('artistLibraryMount')?.before(artistResourceNotice({ request, section: resourcesSection, styleSection, currentCatalogVersion: CURRENT_ARTIST_CATALOG_VERSION, currentStyleVersion: CURRENT_STYLE_VERSION }));
  await markStep('载入编辑器');
  await import('../../public/app.js');
  if (experience) {
    const { installEndfieldUi } = await import('../../public/endfield/ui.js');
    installEndfieldUi({ systemBars: registerPlugin('SystemBars'), appearance: options => PocketNative.setAppearance(options) });
  }
  // Keep the launch screen until the editor is actually shown (app.js reveals #appView).
  const appView = document.getElementById('appView');
  const revealed = () => !appView || !appView.classList.contains('hidden');
  const shown = () => { clearTimeout(bootWatchdog); document.querySelector('.native-startup-slow')?.remove(); document.body.classList.remove('native-booting');
    PocketNative.bootDone().catch(() => {});
    // Every screen that shows pictures registers its own; the rest are registered after the editor is up.
    if (!safeStart) media.registerAll().catch(() => {}); };
  if (revealed()) shown();
  else new MutationObserver((_, observer) => { if (revealed()) { observer.disconnect(); shown(); } }).observe(appView, { attributes: true, attributeFilter: ['class'] });
  await queue.start();
  // 回收站: pictures deleted more than 24 hours ago are deleted for good — after start, then hourly.
  const purgeTrash = () => media.gallery.purgeExpiredTrash().catch(() => {});
  setTimeout(purgeTrash, 30 * 1000); setInterval(purgeTrash, 60 * 60 * 1000);
  updateSection.autoCheck?.(); // Experience builds never install official releases.
  import('../../public/confirm-sheet.js').then(({ confirmAction }) => inviteStarLater(confirmAction)).catch(() => {});
  await App.addListener('appStateChange', state => { if (state.isActive) queue.kick(); });
  await App.addListener('backButton', async () => {
    const dialogs = [...document.querySelectorAll('dialog[open]')];
    if (dialogs.length) { dialogs.at(-1).close(); return; }
    if (!window.dispatchEvent(new Event('nai-navigation-back', { cancelable: true }))) return;
    if (!document.body.classList.contains('editor-tab-active')) { document.querySelector('[data-tab="editor"]')?.click(); return; }
    await App.minimizeApp();
  });
} catch (error) {
  clearTimeout(bootWatchdog); document.querySelector('.native-startup-slow')?.remove();
  document.getElementById('loginView')?.classList.add('hidden');
  document.body.classList.remove('native-booting');
  const panel = document.createElement('main'); panel.className = 'native-startup-error';
  const title = document.createElement('h1'); title.textContent = '本机数据未能打开';
  const detail = document.createElement('p'); detail.textContent = error.message;
  const keep = document.createElement('p'); keep.textContent = '请先点「重新打开」或重启手机。不要卸载重装：卸载会清空图库、方案和账号，无法找回。';
  const retry = document.createElement('button'); retry.textContent = '重新打开'; retry.onclick = () => location.reload();
  panel.append(title, detail, keep, retry); document.body.append(panel);
}
