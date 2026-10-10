
import { Buffer } from 'buffer';
import { App } from '@capacitor/app';
import { createGenerationClient } from '../../service/generation.js';
import { createSchemesService } from '../../service/schemes.js';
import { createSchemesStore } from '../../service/storage/schemes.js';
import { sanitizeGenerationState } from '../../public/generation-payload.js';
import { openDatabase } from './sqlite.js';
import { openProviders } from './providers.js';
import { nativeFetch } from './http.js';
import { openAssets } from './assets.js';
import { inflateRaw } from './codecs.js';
import { openMedia } from './media.js';
import { openQueue } from './queue.js';
import { openReferences } from './references.js';
import { createLocalApi } from './api.js';
import { settings } from './settings.js';

document.body.classList.add('native-mode');
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
  globalThis.NAI_RUNTIME = { native: true, download: url => api.download(url) };
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
  settingsBody?.append(licenseButton);
  await media.registerAll();
  await import('../../public/app.js');
  await queue.start();
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
  const panel = document.createElement('main'); panel.className = 'native-startup-error';
  const title = document.createElement('h1'); title.textContent = '本机数据未能打开';
  const detail = document.createElement('p'); detail.textContent = error.message;
  const retry = document.createElement('button'); retry.textContent = '重新打开'; retry.onclick = () => location.reload();
  panel.append(title, detail, retry); document.body.append(panel);
}
