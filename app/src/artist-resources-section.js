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
  refresh();
  return section;
}
