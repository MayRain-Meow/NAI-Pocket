// Settings → 应用更新 (app only) and the one-line startup toast when a newer release exists.
// `native` is the AppUpdate plugin: downloadUpdate / updateStatus / cancelUpdate / installUpdate.
const el = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };

export function appUpdateSection({ updater, native, currentVersion }) {
  const section = el('section', '', 'settings-dialog-section native-update-section'); section.id = 'nativeAppUpdate';
  const heading = el('div', '', 'settings-section-heading');
  heading.append(el('span', 'Update', 'workspace-eyebrow'), el('h2', '应用更新'));
  const version = el('p', `当前版本 ${currentVersion}`, 'native-update-version');
  const found = el('div', '', 'native-update-found'); found.hidden = true;
  const foundTitle = el('strong'), foundName = el('p', '', 'native-update-title'), foundNotes = el('p', '', 'native-update-notes');
  found.append(foundTitle, foundName, foundNotes);
  const status = el('p', '', 'hint native-update-status'); status.setAttribute('role', 'status'); status.hidden = true;
  const progress = el('progress'); progress.max = 1; progress.hidden = true;
  const check = el('button', '检查更新', 'ghost'), install = el('button', '下载并安装', 'primary'), skip = el('button', '忽略此版本', 'ghost'), cancel = el('button', '取消', 'ghost');
  check.type = install.type = skip.type = cancel.type = 'button';
  const actions = el('div', '', 'native-update-actions'); actions.append(check, install, skip, cancel);
  section.append(heading, version, found, status, progress, actions);
  let update = null, downloaded = '', busy = false, downloading = false, toast = null;

  const say = text => { status.textContent = text; status.hidden = !text; };
  function sync() {
    check.disabled = busy; cancel.hidden = !downloading;
    install.hidden = skip.hidden = !update; install.disabled = skip.disabled = busy;
    install.textContent = downloaded ? '安装' : '下载并安装';
  }
  function show(next) {
    if (update?.version !== next?.version) downloaded = '';
    update = next || null; found.hidden = !update;
    if (update) {
      foundTitle.textContent = `发现新版本 ${update.version}`;
      const title = update.title && update.title !== update.tag ? update.title : '';
      foundName.textContent = title; foundName.hidden = !title;
      foundNotes.textContent = update.notes; foundNotes.hidden = !update.notes;
    }
    sync();
  }
  function closeToast() { toast?.remove(); toast = null; }
  function announce() {
    closeToast();
    const host = document.getElementById('toastHost') || document.body;
    toast = el('div', '', 'toast native-update-toast'); toast.setAttribute('role', 'status');
    const open = el('button', '查看', 'primary'), close = el('button', '×', 'ghost');
    open.type = close.type = 'button'; close.setAttribute('aria-label', '关闭');
    open.addEventListener('click', () => {
      closeToast();
      document.getElementById('openSettingsButton')?.click();
      requestAnimationFrame(() => section.scrollIntoView({ block: 'start' }));
    });
    close.addEventListener('click', closeToast);
    toast.append(el('span', `发现新版本 ${update.version}`), open, close);
    host.append(toast);
    const current = toast; setTimeout(() => { if (toast === current) closeToast(); }, 15000);
  }
  const messages = { none: '已是最新版本', 'rate-limited': 'GitHub 请求过多，请稍后再试', error: '检查失败，请检查网络' };
  check.addEventListener('click', async () => {
    if (busy) return;
    busy = true; say('正在检查…'); sync();
    let result;
    try { result = await updater.check({ manual: true }); } catch { result = { status: 'error' }; }
    busy = false;
    if (result.status === 'available') { show(result.update); say(''); }
    else { show(null); say(messages[result.status] || messages.error); }
  });
  async function installDownloaded() {
    const result = await native.installUpdate({ path: downloaded });
    if (result?.needsPermission) say('请允许本应用「安装未知应用」，返回后点「安装」');
    else say('已打开系统安装程序');
  }
  install.addEventListener('click', async () => {
    if (busy || !update) return;
    busy = true; closeToast();
    let timer = null;
    try {
      if (!downloaded) {
        say('正在下载…'); progress.removeAttribute('value'); progress.hidden = false; downloading = true; sync();
        timer = setInterval(async () => {
          try {
            const state = await native.updateStatus();
            if (downloading && state.totalBytes > 0) { progress.value = Math.min(1, state.receivedBytes / state.totalBytes); say(`正在下载… ${Math.floor(progress.value * 100)}%`); }
          } catch { /* the download call reports its own outcome */ }
        }, 500);
        const result = await native.downloadUpdate({ url: update.url, sha256: update.sha256, sha256Url: update.sha256Url });
        clearInterval(timer); timer = null; progress.hidden = true; downloading = false;
        if (result?.cancelled) { say('已取消下载'); return; }
        downloaded = result.path;
      }
      sync(); await installDownloaded();
    } catch (error) {
      say(`${downloaded ? '安装' : '下载'}失败：${error?.message || error}`); downloaded = '';
    } finally { if (timer) clearInterval(timer); progress.hidden = true; busy = downloading = false; sync(); }
  });
  cancel.addEventListener('click', () => { native.cancelUpdate().catch(() => {}); });
  skip.addEventListener('click', async () => {
    if (!update || busy) return;
    const version = update.version;
    try { await updater.skip(version); } catch { /* still hidden for this session */ }
    closeToast(); show(null); say(`已忽略 ${version}`);
  });
  // Startup: never blocks, never reports a failure; announces once per found version.
  section.autoCheck = async () => {
    try {
      const result = await updater.check({ manual: false });
      if (result.status === 'available' && !busy) { show(result.update); announce(); }
    } catch { /* silent on automatic checks */ }
  };
  sync();
  return section;
}
