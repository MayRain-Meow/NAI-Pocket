// Settings section for artist resource packs (annotation packs or the user's own packs).
// The artist page itself is the shared artist-library UI; installing data lives here so the
// library view stays the same as on the server site.

const el = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
const mib = bytes => `${(Math.max(0, Number(bytes) || 0) / 1024 / 1024).toFixed(1)} MB`;

export function artistResourcesSection({ request, defaultCatalogUrl = '', notice = () => {} }) {
  const section = el('section', '', 'settings-dialog-section native-artist-resources');
  const heading = el('div', '', 'settings-section-heading');
  heading.append(el('span', 'Artists', 'workspace-eyebrow'), el('h2', '画师标注资料'));
  const status = el('p', '正在读取本机资料…', 'hint'); status.setAttribute('role', 'status');
  const url = el('input'); url.type = 'url'; url.placeholder = '资料目录链接（catalog.json）'; url.setAttribute('aria-label', '资料目录链接');
  try { url.value = localStorage.getItem('nai-artist-resource-catalog-url') || defaultCatalogUrl; } catch { url.value = defaultCatalogUrl; }
  const read = el('button', '读取目录', 'ghost'), all = el('button', '', 'primary'), importPack = el('button', '导入资料包', 'ghost'), cancel = el('button', '取消', 'ghost');
  all.hidden = true; cancel.hidden = true;
  const progress = el('progress'); progress.max = 1; progress.hidden = true;
  const actions = el('div', '', 'native-artist-resources-actions'); actions.append(read, all, importPack, cancel);
  const hint = el('p', '标注资料只含画师名、逐图标注和例图地址，不含图片；例图在打开画师时从 Danbooru 读取并缓存在本机。也可导入自己准备的资料包。', 'hint');
  section.append(heading, status, url, actions, progress, hint);
  let catalog = null, installed = new Map(), busy = false, stop = false;

  const pending = () => catalog ? catalog.shards.filter(row => installed.get(row.id) !== row.version) : [];
  function sync() {
    read.disabled = importPack.disabled = busy; cancel.hidden = !busy; progress.hidden = !busy;
    const rows = pending();
    all.hidden = !catalog || busy;
    all.disabled = !rows.length;
    all.textContent = !catalog ? '' : rows.length ? `下载 ${rows.length} 个资料包（约 ${mib(rows.reduce((sum, row) => sum + row.bytes, 0))}）` : '已是目录中的最新版本';
  }
  // The outcome of the last operation stays in front of the installed summary; refreshing the
  // summary used to overwrite a cancel/stop/failure message the moment the operation ended.
  async function refresh(outcome = '') {
    let summary;
    try {
      const result = await request('/api/artists/resources/sets');
      installed = new Map(result.sets.map(row => [row.id, row.version]));
      summary = result.sets.length ? `本机已安装 ${result.sets.length} 个资料包，共 ${result.artists.toLocaleString()} 位画师。` : '本机还没有画师标注资料。';
    } catch (error) { summary = `读取本机资料失败：${error.message}`; }
    status.textContent = outcome ? `${outcome} ${summary}` : summary;
    sync();
  }
  async function run(work, failure) {
    if (busy) return;
    busy = true; stop = false; sync();
    let outcome = '', changed = false;
    const installedOne = () => { changed = true; };
    try { outcome = (await work(installedOne)) || ''; }
    catch (error) { outcome = failure; notice(error.message); }
    finally {
      busy = false;
      // Packs installed before a later failure or stop are live; tell the pages either way.
      if (changed) window.dispatchEvent(new Event('nai-artist-resources-changed'));
      await refresh(outcome);
    }
  }
  read.addEventListener('click', () => run(async () => {
    const value = url.value.trim();
    if (!value) { notice('请先填写资料目录链接。'); return ''; }
    status.textContent = '正在读取资料目录…';
    catalog = (await request('/api/artists/resources/catalog', { method: 'POST', body: { url: value } })).catalog;
    try { localStorage.setItem('nai-artist-resource-catalog-url', catalog.url || value); } catch {}
    return `已读取资料目录（${catalog.shards.length} 个资料包）。`;
  }, '目录读取失败，原有目录和本机资料保持不变。'));
  all.addEventListener('click', () => run(async installedOne => {
    const rows = pending();
    for (const [index, row] of rows.entries()) {
      if (stop) return `已停止，完成 ${index} / ${rows.length} 个资料包；已安装的保持可用。`;
      status.textContent = `正在下载第 ${index + 1} / ${rows.length} 个资料包（${row.id}）…`;
      progress.value = index / rows.length;
      const result = await request('/api/artists/resources/download', { method: 'POST', body: { url: row.url, sha256: row.sha256, expectedId: row.id, expectedVersion: row.version } });
      if (result.cancelled) return '已取消，已安装的资料包保持可用。';
      installed.set(row.id, row.version); installedOne();
    }
    return `已安装 ${rows.length} 个资料包。`;
  }, '资料包未安装，已安装的资料保持可用。'));
  importPack.addEventListener('click', () => run(async installedOne => {
    status.textContent = '请选择资料包文件…';
    const result = await request('/api/artists/resources/import', { method: 'POST' });
    if (result.cancelled) return '已取消导入。';
    installedOne();
    return `已安装 ${result.artists} 位画师的 ${result.examples} 张例图及对应标注。`;
  }, '资料包未安装，原有资料保持不变。'));
  cancel.addEventListener('click', async () => {
    stop = true;
    try { await request('/api/artists/resources/cancel', { method: 'POST' }); } catch { /* the running request reports its own outcome */ }
  });
  // Started from the artist page banner: read the catalog so the download button appears.
  section.begin = () => { if (!catalog && !busy) read.click(); };
  refresh();
  return section;
}

// 画风数据 (0.5.0): the style index behind 按感觉找 / 找相似. One press checks the Release and, when it
// is new or missing, downloads and installs it; the installed copy stays until the new one is verified.
export function stylePackSection({ request, notice = () => {} }) {
  const block = el('section', '', 'settings-dialog-section native-style-pack');
  const title = el('div', '', 'settings-section-heading');
  title.append(el('span', 'Style', 'workspace-eyebrow'), el('h2', '画风数据'));
  const status = el('p', '正在读取…', 'hint'); status.setAttribute('role', 'status');
  const get = el('button', '下载画风数据', 'primary'), cancel = el('button', '取消', 'ghost'), remove = el('button', '删除', 'ghost');
  cancel.hidden = true; remove.hidden = true;
  const progress = el('progress'); progress.max = 1; progress.hidden = true;
  const actions = el('div', '', 'native-artist-resources-actions'); actions.append(get, cancel, remove);
  block.append(title, status, actions, progress, el('p', '用于画师页的按感觉找画师和找相似。只含画风向量与画师名，覆盖标注资料中的全年龄原作。', 'hint'));
  let installed = null, busy = false, timer = 0;
  const describe = state => `已安装 ${state.version}：${state.artists.toLocaleString()} 位画师、${state.images.toLocaleString()} 张原作（${mib(state.bytes)}）。`;
  function sync() {
    get.disabled = busy; cancel.hidden = !busy; progress.hidden = !busy; remove.hidden = busy || !installed;
    get.textContent = installed ? '检查更新' : '下载画风数据';
  }
  async function refresh(outcome = '') {
    try { installed = (await request('/api/artists/style-pack')).installed; } catch { installed = null; }
    const summary = installed ? describe(installed) : '还没有画风数据。';
    status.textContent = outcome ? `${outcome} ${summary}` : summary;
    sync();
  }
  async function poll() {
    try {
      const state = await request('/api/artists/style-pack/status');
      if (state.busy && state.totalBytes > 0) { progress.value = state.receivedBytes / state.totalBytes; status.textContent = `正在下载画风数据 ${mib(state.receivedBytes)} / ${mib(state.totalBytes)}…`; }
    } catch { /* the download reports its own outcome */ }
    if (busy) timer = setTimeout(poll, 500);
  }
  get.addEventListener('click', async () => {
    if (busy) return;
    busy = true; sync(); progress.removeAttribute('value'); status.textContent = '正在读取画风数据目录…';
    let outcome = '';
    try {
      const { manifest } = await request('/api/artists/style-pack/manifest', { method: 'POST', body: {} });
      if (installed?.sha256 === manifest.file.sha256) outcome = '已是最新版本。';
      else {
        status.textContent = `正在下载画风数据（约 ${mib(manifest.file.bytes)}）…`; poll();
        const result = await request('/api/artists/style-pack/download', { method: 'POST', body: { manifest } });
        outcome = result.cancelled ? '已取消，原有画风数据保持不变。' : '画风数据已安装。';
        if (!result.cancelled) window.dispatchEvent(new Event('nai-artist-resources-changed'));
      }
    } catch (error) { outcome = '画风数据未更新，原有数据保持不变。'; notice(error.message); }
    finally { busy = false; clearTimeout(timer); await refresh(outcome); }
  });
  cancel.addEventListener('click', () => request('/api/artists/style-pack/cancel', { method: 'POST' }).catch(() => {}));
  remove.addEventListener('click', async () => {
    if (busy) return;
    try { await request('/api/artists/style-pack', { method: 'DELETE' }); window.dispatchEvent(new Event('nai-artist-resources-changed')); await refresh('已删除画风数据。'); }
    catch (error) { notice(error.message); }
  });
  block.begin = () => { if (!busy && !installed) get.click(); };
  refresh();
  return block;
}

// 以图找画师 (0.6.0): the CLIP vision model, an optional ~293 MB download verified by checksum. Once it
// is on the phone the artist page's picture button appears; pictures are searched on the phone.
export function styleModelSection({ request, notice = () => {} }) {
  const block = el('section', '', 'settings-dialog-section native-style-model');
  const title = el('div', '', 'settings-section-heading');
  title.append(el('span', 'Picture', 'workspace-eyebrow'), el('h2', '以图找画师'));
  const status = el('p', '正在读取…', 'hint'); status.setAttribute('role', 'status');
  const get = el('button', '下载模型', 'primary'), cancel = el('button', '取消', 'ghost'), remove = el('button', '删除', 'ghost');
  cancel.hidden = true; remove.hidden = true;
  const progress = el('progress'); progress.max = 1; progress.hidden = true;
  const actions = el('div', '', 'native-artist-resources-actions'); actions.append(get, cancel, remove);
  block.append(title, status, actions, progress,
    el('p', '在画师页搜索栏点图片按钮，选一张图，按画风接近程度排列画师。需要先装好画风数据。模型约 293 MB，只下载一次；图片只在本机处理，不上传。', 'hint'));
  let present = false, busy = false, timer = 0;
  function sync() { get.disabled = busy; cancel.hidden = !busy; progress.hidden = !busy; remove.hidden = busy || !present; get.hidden = present && !busy; }
  async function refresh(outcome = '') {
    try { const state = await request('/api/artists/style-model'); present = Boolean(state.present); status.textContent = `${outcome ? `${outcome} ` : ''}${present ? `模型已就绪（${mib(state.bytes)}）。` : '还没有下载模型。'}`; }
    catch (error) { status.textContent = `读取失败：${error.message}`; }
    sync();
  }
  async function poll() {
    try {
      const state = await request('/api/artists/style-model/status');
      if (state.busy && state.totalBytes > 0) { progress.value = state.receivedBytes / state.totalBytes; status.textContent = `正在下载模型 ${mib(state.receivedBytes)} / ${mib(state.totalBytes)}…`; }
    } catch { /* the download reports its own outcome */ }
    if (busy) timer = setTimeout(poll, 700);
  }
  get.addEventListener('click', async () => {
    if (busy) return;
    busy = true; sync(); progress.removeAttribute('value'); status.textContent = '正在读取模型目录…';
    let outcome = '';
    try {
      const { manifest } = await request('/api/artists/style-model/manifest', { method: 'POST', body: {} });
      status.textContent = `正在下载模型（约 ${mib(manifest.file.bytes)}）…`; poll();
      const result = await request('/api/artists/style-model/download', { method: 'POST', body: { manifest } });
      outcome = result.cancelled ? '已取消。' : '模型已安装，画师页搜索栏出现图片按钮。';
      if (!result.cancelled) window.dispatchEvent(new Event('nai-artist-resources-changed'));
    } catch (error) { outcome = '模型未安装。'; notice(error.message); }
    finally { busy = false; clearTimeout(timer); await refresh(outcome); }
  });
  cancel.addEventListener('click', () => request('/api/artists/style-model/cancel', { method: 'POST' }).catch(() => {}));
  remove.addEventListener('click', async () => {
    if (busy) return;
    try { await request('/api/artists/style-model', { method: 'DELETE' }); window.dispatchEvent(new Event('nai-artist-resources-changed')); await refresh('已删除模型。'); }
    catch (error) { notice(error.message); }
  });
  refresh();
  return block;
}

// Artist page banner (app only): tells the user to download the annotation packs when none
// are installed, and explains repeated image failures (Danbooru's CDN may be unreachable).
export function artistResourceNotice({ request, section, styleSection = null }) {
  const banner = el('div', '', 'native-artist-notice'); banner.hidden = true; banner.setAttribute('role', 'status');
  const text = el('p'), action = el('button', '', 'primary');
  banner.append(text, action);
  const later = el('button', '以后再说', 'ghost'); banner.append(later);
  let failures = 0, installed = null, style = true, styleDismissed = false;
  try { styleDismissed = localStorage.getItem('nai-style-pack-later') === '1'; } catch {}
  action.addEventListener('click', () => {
    const wantsStyle = installed > 0 && !style;
    document.getElementById('openSettingsButton')?.click();
    requestAnimationFrame(() => {
      if (wantsStyle && styleSection) { styleSection.scrollIntoView({ block: 'start' }); styleSection.begin?.(); return; }
      section.scrollIntoView({ block: 'start' }); if (installed === 0) section.begin?.();
    });
  });
  later.addEventListener('click', () => { styleDismissed = true; try { localStorage.setItem('nai-style-pack-later', '1'); } catch {} render(); });
  function render() {
    later.hidden = true;
    if (installed === 0) {
      text.textContent = '还没有画师标注资料。下载后可看例图和逐图画风标注（约 79 MB，不含图片，例图从 Danbooru 按需读取）。';
      action.textContent = '去下载'; action.hidden = false; banner.hidden = false;
    } else if (installed > 0 && !style && !styleDismissed) {
      text.textContent = '新增画风数据：下载后可按感觉找画师、找相似（约 24 MB）。';
      action.textContent = '去下载'; action.hidden = false; later.hidden = false; banner.hidden = false;
    } else if (failures >= 3) {
      text.textContent = `已有 ${failures} 张例图读取失败：可能无法连接 Danbooru 图片服务器（cdn.donmai.us）。当前网络无法访问时，标注和筛选仍可使用。`;
      action.hidden = true; banner.hidden = false;
    } else banner.hidden = true;
  }
  async function refresh() {
    try { installed = (await request('/api/artists/resources/sets')).sets.length; } catch { installed = null; }
    try { style = Boolean((await request('/api/artists/style-pack')).installed); } catch { style = true; }
    if (installed) failures = 0;
    render();
  }
  window.addEventListener('nai-artist-resources-changed', refresh);
  window.addEventListener('nai-artist-image-failed', () => { failures++; render(); });
  refresh();
  return banner;
}
