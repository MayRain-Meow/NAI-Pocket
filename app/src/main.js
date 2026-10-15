
import { Buffer } from 'buffer';
import { App } from '@capacitor/app';
import { registerPlugin } from '@capacitor/core';
import { version as appVersion } from '../package.json';
import { createGenerationClient } from '../../service/generation.js';
import { createSchemesService } from '../../service/schemes.js';
import { createSchemesStore } from '../../service/storage/schemes.js';
import { sanitizeGenerationState } from '../../public/generation-payload.js';
import { openDatabase } from './sqlite.js';
import { openProviders, PocketNative } from './providers.js';
import { nativeFetch } from './http.js';
import { openAssets } from './assets.js';
import { inflateRaw } from './codecs.js';
import { openMedia } from './media.js';
import { openQueue } from './queue.js';
import { openReferences } from './references.js';
import { createLocalApi } from './api.js';
import { settings } from './settings.js';
import { artistResourcesSection, artistResourceNotice } from './artist-resources-section.js';
import { createImageLoader } from './image-loader.js';
import { DEFAULT_ARTIST_CATALOG_URL } from './artist-resource-source.js';
import { createUpdater } from './updater.js';
import { appUpdateSection } from './update-section.js';

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

async function phoneAlbumSection(queue) {
  const section = document.createElement('section'); section.className = 'settings-dialog-section native-album-section';
  const heading = document.createElement('div'); heading.className = 'settings-section-heading';
  const eyebrow = document.createElement('span'); eyebrow.className = 'workspace-eyebrow'; eyebrow.textContent = 'Album';
  const title = document.createElement('h2'); title.textContent = '手机相册'; heading.append(eyebrow, title);
  const label = document.createElement('label'); label.className = 'native-album-toggle';
  const input = document.createElement('input'); input.type = 'checkbox'; input.id = 'nativePhoneAlbumToggle';
  const text = document.createElement('span'); text.textContent = '保存到手机相册'; label.append(input, text);
  const hint = document.createElement('p'); hint.className = 'hint';
  hint.textContent = '生成完成后另存一份原图到系统相册 Pictures/NAI Pocket；应用内图库不受影响，复制失败也不影响任务。';
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
const notice = message => {
  const host = document.getElementById('toastHost');
  const text = document.createElement('div'); text.className = 'toast error'; text.textContent = message; host?.append(text);
  setTimeout(() => text.remove(), 10000);
};
window.addEventListener('nai-runtime-error', event => notice(event.detail));
try {
  const database = await openDatabase(), http = { fetch: nativeFetch };
  const providers = await openProviders(settings, http), assets = openAssets(database, settings, http, providers);
  const client = createGenerationClient({ settings, assets, generationProvider: providers.generationProvider, binary: Buffer, inflateRaw,
    ids: { request: () => crypto.randomUUID().slice(0, 6) }, http });
  let queue;
  const media = openMedia(database, () => queue.resources());
  queue = openQueue(database, settings, providers, client, media, assets);
  const schemes = createSchemesService({ store: database.store(createSchemesStore(database.db, database.transaction)),
    clock: { now: () => Date.now() }, ids: { next: () => crypto.randomUUID() }, sanitizeState: sanitizeGenerationState, includeArtistPreferences: true });
  const references = openReferences(database, settings, http);
  try {await references.artistPacks.recover();}
  catch {notice('旧资料清理未完成，现有资料仍可使用；下次启动会重试。');}
  const api = createLocalApi({ database, settings, providers, assets, media, queue, client, schemes, references });
  const browserFetch = window.fetch.bind(window);
  window.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input, location.origin);
    return url.origin === location.origin && url.pathname.startsWith('/api/') ? api.fetch(input, options) : browserFetch(input, options);
  };
  globalThis.NAI_RUNTIME = { native: true, download: url => api.download(url), loadImage: createImageLoader(url => api.fetch(url)) };
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
  const resourcesSection = artistResourcesSection({ request, defaultCatalogUrl: DEFAULT_ARTIST_CATALOG_URL, notice });
  const updateSection = appUpdateSection({ updater: createUpdater({ fetch: http.fetch, state: queue.state, currentVersion: appVersion }),
    native: registerPlugin('AppUpdate'), currentVersion: appVersion });
  settingsBody?.append(await phoneAlbumSection(queue), resourcesSection, updateSection, aboutSection(appVersion, licenseButton));
  document.getElementById('artistLibraryMount')?.before(artistResourceNotice({ request, section: resourcesSection }));
  await media.registerAll();
  await import('../../public/app.js');
  // Keep the launch screen until the editor is actually shown (app.js reveals #appView).
  const appView = document.getElementById('appView');
  const revealed = () => !appView || !appView.classList.contains('hidden');
  if (revealed()) document.body.classList.remove('native-booting');
  else new MutationObserver((_, observer) => { if (revealed()) { observer.disconnect(); document.body.classList.remove('native-booting'); } }).observe(appView, { attributes: true, attributeFilter: ['class'] });
  await queue.start();
  updateSection.autoCheck(); // not awaited: startup never waits for GitHub
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
  document.getElementById('loginView')?.classList.add('hidden');
  document.body.classList.remove('native-booting');
  const panel = document.createElement('main'); panel.className = 'native-startup-error';
  const title = document.createElement('h1'); title.textContent = '本机数据未能打开';
  const detail = document.createElement('p'); detail.textContent = error.message;
  const retry = document.createElement('button'); retry.textContent = '重新打开'; retry.onclick = () => location.reload();
  panel.append(title, detail, retry); document.body.append(panel);
}
