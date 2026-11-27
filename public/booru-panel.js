import { BOORU_CATEGORIES, BOORU_LABELS, booruKey, matchesBooruRule, booruSelection } from './booru-core.js';
import { installImageViewer } from './image-viewer.js';
import { confirmAction } from './confirm-sheet.js';
import { readDownloadPreferences } from './download-preferences.js';

const node = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
const button = (text, action, className = '') => {
  const value = node('button', className, text); value.type = 'button'; value.addEventListener('click', action); return value;
};
const ratingNames = { g: '全年龄', s: '敏感', q: '存疑', e: '成人' };

export function createReferenceHub({ api, toast, codex, editor }) {
  const root = document.querySelector('#codexTab'), library = document.querySelector('#codexLibrary');
  const mount = document.querySelector('#booruMount'), nav = document.querySelector('#referenceSwitch');
  let active = 'codex', scroll = { codex: 0, booru: 0 }, initialized = false, config = null, shown = false;
  let request = null, revision = 0, page = 1, hasMore = true, loaded = false, busy = false, detailRequest = null;
  let detail = null, lastSearch = {}, posts = [], pageFailed = false, retryPage = 1, retryAppend = false, retryCriteria = {};
  const imageUrls = new Map(), imageRequests = new Set(), imageQueue = [];
  let imageBytes = 0;
  let activeImages = 0, imageEpoch = 0;
  const $ = selector => mount.querySelector(selector);
  const enabled = Boolean(globalThis.NAI_RUNTIME?.booru);
  const panel = node('div', 'booru-panel');
  panel.innerHTML = `
    <header class="booru-heading"><div><span class="workspace-eyebrow">// DANBOORU</span><h1>画廊</h1></div><button type="button" id="booruSettings">画廊设置</button></header>
    <form id="booruSearchForm" class="booru-search">
      <label class="booru-query"><span>搜索标签</span><input id="booruQuery" type="search" placeholder="如 sky blue_hair；逗号分隔短语" autocomplete="off" maxlength="1000"></label>
      <button class="booru-primary" type="submit">搜索</button>
      <div class="booru-filters">
        <label>浏览方式<select id="booruChannel"><option value="latest">最新</option><option value="score">高分</option><option value="favcount">收藏数</option><option value="day">日榜</option><option value="week">周榜</option><option value="month">月榜</option></select></label>
        <label>内容分级<select id="booruRating"><option value="g">全年龄</option><option value="g,s">全年龄＋敏感</option><option value="s">敏感</option><option value="q">存疑</option><option value="e">成人</option><option value="g,s,q,e">全部分级</option></select></label>
      </div>
    </form>
    <p class="booru-hint">使用英文标签搜索；普通账号通常最多两个标签。点图片后可勾选标签，导入到编辑器。</p>
    <div class="booru-status-row"><p id="booruStatus" role="status" aria-live="polite">打开画廊后加载图片。</p><button id="booruCancel" type="button" hidden>取消加载</button></div>
    <div id="booruGrid" class="booru-grid"></div>
    <div class="booru-pagination"><button id="booruPrevious" type="button">上一页</button><button id="booruMore" type="button">加载更多</button><button id="booruNext" type="button">下一页</button></div>
    <p class="booru-hint">图片和标签来自 Danbooru。画廊缓存与本机“图库”分开；图片版权归各自作者所有。</p>`;
  mount.append(panel);

  function releaseImages() {
    imageEpoch++; imageQueue.length = 0;
    for (const controller of imageRequests) controller.abort();
    for (const url of imageUrls.keys()) URL.revokeObjectURL(url);
    imageUrls.clear(); imageBytes = 0;
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      observer.unobserve(entry.target);
      imageQueue.push({ image: entry.target, epoch: imageEpoch }); pumpImages();
    }
  }, { rootMargin: '200px' });
  function pumpImages() {
    while (activeImages < 3 && imageQueue.length) {
      const { image, epoch } = imageQueue.shift();
      if (!image.isConnected || epoch !== imageEpoch) continue;
      activeImages++;
      const controller = new AbortController(); imageRequests.add(controller);
      api(image.dataset.url, { signal: controller.signal }).then(blob => {
        if (epoch !== imageEpoch || !image.isConnected) return;
        const url = URL.createObjectURL(blob); imageUrls.set(url, { image, size: blob.size }); imageBytes += blob.size; image.src = url;
        // Decoded thumbnails must also be bounded, independently of the service cache.
        while (imageBytes > 32 * 1024 ** 2 && imageUrls.size > 1) {
          const [oldUrl, old] = imageUrls.entries().next().value;
          old.image.removeAttribute('src'); old.image.alt = '点击图片查看'; URL.revokeObjectURL(oldUrl);
          imageBytes -= old.size; imageUrls.delete(oldUrl);
        }
        image.classList.add('is-loaded');
      }).catch(() => {
        if (epoch === imageEpoch && image.isConnected) { image.alt = '图片未载入，点击可重试'; image.classList.add('is-failed'); }
      }).finally(() => { imageRequests.delete(controller); activeImages--; pumpImages(); });
    }
  }
  function setStatus(text) { $('#booruStatus').textContent = text; }
  function controls() {
    $('#booruCancel').hidden = !busy;
    $('#booruPrevious').disabled = busy || page <= 1;
    $('#booruNext').disabled = busy || !hasMore;
    $('#booruMore').disabled = busy || (!hasMore && !pageFailed);
    $('#booruMore').textContent = pageFailed ? '重试' : posts.length >= 160 ? '继续浏览下一页' : '加载更多';
    $('#booruGrid').setAttribute('aria-busy', String(busy));
  }
  function query() {
    const channel = $('#booruChannel').value;
    return { q: $('#booruQuery').value.trim(), ratings: $('#booruRating').value,
      ...(['day', 'week', 'month'].includes(channel) ? { period: channel } : { sort: channel }) };
  }
  function card(post) {
    const value = button('', () => openDetail(post.id), 'booru-card');
    value.dataset.post = post.id; value.setAttribute('aria-label', `查看图片 ${post.id}，${ratingNames[post.rating]}`);
    const image = node('img'); image.alt = `Danbooru 图片 ${post.id}`; image.decoding = 'async';
    image.dataset.url = `/api/booru/posts/${post.id}/preview`;
    const caption = node('span', 'booru-card-caption');
    caption.append(node('strong', '', `No.${post.id}`), node('small', '', `${ratingNames[post.rating]} / ★ ${post.score}`));
    value.append(image, caption); observer.observe(image); return value;
  }
  async function search(nextPage = 1, append = false, criteria = null) {
    request?.abort(); request = new AbortController();
    const signal = request.signal, token = ++revision;
    busy = true; pageFailed = false; retryPage = nextPage; retryAppend = append;
    const searchCriteria = criteria || lastSearch;
    retryCriteria = searchCriteria;
    setStatus('正在连接 Danbooru…'); controls();
    try {
      config ||= await api('/api/booru/settings', { signal });
      const result = await api(`/api/booru/posts?${new URLSearchParams({ ...searchCriteria, page: nextPage })}`, { signal });
      if (token !== revision) return;
      if (!append) { observer.disconnect(); releaseImages(); $('#booruGrid').replaceChildren(); posts = []; }
      const existing = new Set(posts.map(x => x.id));
      const incoming = result.posts.filter(x => !existing.has(x.id));
      posts.push(...incoming); $('#booruGrid').append(...incoming.map(card));
      page = result.page; hasMore = result.hasMore; loaded = true; lastSearch = searchCriteria;
      setStatus(`第 ${page} 页 / 当前 ${posts.length} 张${result.date ? ` / ${result.date}` : ''}${result.filtered ? ` / 本页过滤 ${result.filtered} 张` : ''}${result.unavailable ? ` / ${result.unavailable} 张无图片权限` : ''}${posts.length ? '' : ' / 没有符合条件的图片，可换标签或继续翻页。'}`);
    } catch (error) {
      if (token !== revision) return;
      pageFailed = true; setStatus(signal.aborted ? '加载已取消，已显示的图片仍然保留。' : error.message);
    } finally { if (token === revision) { busy = false; controls(); } }
  }
  function updateChannel() {
    const ranking = ['day', 'week', 'month'].includes($('#booruChannel').value);
    $('#booruQuery').disabled = ranking;
    $('#booruQuery').placeholder = ranking ? '排行榜不使用搜索标签' : '如 sky blue_hair；逗号分隔短语';
  }
  function currentQuery() { const value = query(); if (value.period) value.q = ''; return value; }
  function dialogShell(title, className) {
    const dialog = node('dialog', `booru-dialog ${className}`);
    const header = node('header', 'booru-dialog-head');
    header.append(node('strong', '', title), button('关闭', () => dialog.close(), 'booru-close'));
    dialog.append(header);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog); return dialog;
  }
  async function openDetail(id) {
    detail?.close(); detailRequest?.abort();
    detailRequest = new AbortController();
    const signal = detailRequest.signal, dialog = dialogShell(`No.${id} / 图片详情`, 'booru-detail');
    detail = dialog; dialog.dataset.post = id;
    const body = node('div', 'booru-detail-body'), media = node('section', 'booru-media'), tags = node('section', 'booru-tags');
    const message = node('p', 'booru-hint', '正在读取图片和标签…');
    body.append(media, tags); dialog.append(message, body); dialog.showModal();
    const urls = new Set(); let selected = new Set(), post, viewer, originalController = null;
    dialog.addEventListener('close', () => {
      if (detail === dialog) detail = null;
      detailRequest?.signal === signal && detailRequest.abort();
      originalController?.abort(); for (const url of urls) URL.revokeObjectURL(url);
    });
    try {
      config ||= await api('/api/booru/settings', { signal });
      post = await api(`/api/booru/posts/${id}`, { signal });
      if (signal.aborted || !dialog.open) return;
      message.textContent = `${post.width} × ${post.height} / ${ratingNames[post.rating]} / 评分 ${post.score} / 收藏 ${post.favorites}${post.date ? ` / ${post.date.slice(0, 10)}` : ''}`;
      const stage = node('div', 'booru-image-stage dialog-image-stage'), surface = node('div'), image = node('img');
      image.alt = `Danbooru 图片 ${id}`; surface.append(image); stage.append(surface); media.append(stage);
      viewer = installImageViewer({ stage, image, dialog, navigate: direction => {
        const index = posts.findIndex(x => x.id === id), next = posts[index + direction];
        if (next) openDetail(next.id);
      } });
      viewer.setImage(id);
      const mediaStatus = node('p', 'booru-hint');
      const loadImage = async tier => {
        originalController?.abort(); originalController = new AbortController();
        const controller = originalController; mediaStatus.textContent = '正在加载图片…';
        try {
          const blob = await api(`/api/booru/posts/${id}/${tier}`, { signal: controller.signal });
          if (controller.signal.aborted || !dialog.open) return;
          const previous = image.src, url = URL.createObjectURL(blob); urls.add(url); image.src = url; mediaStatus.textContent = '';
          if (urls.delete(previous)) URL.revokeObjectURL(previous);
        } catch (error) { if (!controller.signal.aborted && dialog.open) mediaStatus.textContent = error.message; }
      };
      const mediaActions = node('div', 'booru-inline-actions');
      mediaActions.append(button('加载原图', () => loadImage('original')));
      const source = node('a', 'booru-link', '打开来源'); source.href = post.source; source.target = '_blank'; source.rel = 'noopener noreferrer';
      mediaActions.append(source, button('保存原图', async event => {
        const control = event.currentTarget; control.disabled = true;
        try {
          const saved = await globalThis.NAI_RUNTIME.download(`/api/booru/posts/${id}/original`, { destination: readDownloadPreferences().destination });
          toast(saved ? '原图已保存到设置中的下载位置。' : '已取消保存。', saved ? 'success' : 'info');
        } catch (error) { toast(error.message, 'error'); } finally { control.disabled = false; }
      }));
      media.append(mediaStatus, mediaActions);
      loadImage('sample');
      const rules = [...config.blacklist, ...config.outputFilter];
      const eligible = name => !matchesBooruRule(name, rules);
      const categories = new Set(config.categories), chipNodes = new Map();
      for (const category of categories) for (const name of post.tags[category]) if (eligible(name)) selected.add(`${category}:${name}`);
      const selectionStatus = node('p', 'booru-hint');
      const selectionActions = node('div', 'booru-inline-actions');
      const selectedOutput = () => booruSelection(post, selected, config);
      let appendButton, replaceButton, copyButton;
      function refresh() {
        for (const [key, chip] of chipNodes) {
          chip.setAttribute('aria-pressed', String(selected.has(key)));
          chip.disabled = !categories.has(chip.dataset.category) || !eligible(chip.dataset.tag);
        }
        const total = selectedOutput().length;
        selectionStatus.textContent = `已选择 ${total} 个标签；灰色标签已关闭类别或被输出规则过滤。`;
        for (const control of [appendButton, replaceButton, copyButton]) if (control) control.disabled = total === 0;
      }
      selectionActions.append(button('全选启用类别', () => {
        for (const category of categories) for (const name of post.tags[category]) if (eligible(name)) selected.add(`${category}:${name}`);
        refresh();
      }), button('取消选择', () => { selected.clear(); refresh(); }));
      tags.append(selectionStatus, selectionActions);
      for (const category of BOORU_CATEGORIES) {
        const section = node('section', 'booru-tag-category'), heading = node('label', 'booru-category-label');
        const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = categories.has(category); checkbox.dataset.category = category;
        heading.append(checkbox, node('strong', '', `${BOORU_LABELS[category]} / ${post.tags[category].length}`));
        checkbox.addEventListener('change', () => {
          checkbox.checked ? categories.add(category) : categories.delete(category);
          for (const name of post.tags[category]) {
            const key = `${category}:${name}`;
            if (checkbox.checked && eligible(name)) selected.add(key); else selected.delete(key);
          }
          refresh();
        });
        const chips = node('div', 'booru-tag-chips');
        for (const name of post.tags[category]) {
          const key = `${category}:${name}`;
          const chip = button('', () => { selected.has(key) ? selected.delete(key) : selected.add(key); refresh(); }, 'booru-tag');
          chip.dataset.category = category; chip.dataset.tag = name;
          chip.append(node('span', '', name));
          chipNodes.set(key, chip); chips.append(chip);
        }
        section.append(heading, chips); tags.append(section);
      }
      const dock = node('footer', 'booru-import-dock');
      const destination = node('label'); destination.append(node('span', '', '导入位置'));
      const target = node('select'); target.id = 'booruImportTarget';
      for (const [value, text] of editor.targets()) { const option = node('option', '', text); option.value = value; target.append(option); }
      destination.append(target);
      const actions = node('div', 'booru-import-actions');
      const importTags = async replace => {
        const output = selectedOutput(); if (!output.length) return;
        const targetValue = target.value;
        if (replace && !await confirmAction(`替换“${target.selectedOptions[0].textContent}”中的标签？其他分区和生成参数会保留。之后可在编辑器撤销。`, { confirmLabel: '替换标签' })) return;
        if (!dialog.open) return;
        try {
          const count = editor.import(output, { target: targetValue, replace });
          dialog.close(); editor.open();
          toast(count ? `已${replace ? '替换并导入' : '追加'} ${count} 个标签，可在编辑器撤销。` : '所选标签已存在，没有重复添加。', 'success');
        } catch (error) { toast(error.message, 'error'); }
      };
      appendButton = button('追加到编辑器', () => importTags(false), 'booru-primary');
      replaceButton = button('替换此分区', () => importTags(true));
      copyButton = button('复制', async () => {
        try { await navigator.clipboard.writeText(selectedOutput().map(x => x.text).join(', ')); toast('已复制所选标签。', 'success'); }
        catch { toast('复制失败，请检查剪贴板权限。', 'error'); }
      });
      actions.append(copyButton, replaceButton, appendButton); dock.append(destination, actions); dialog.append(dock); refresh();
      // Existing local dictionary only: opening a detail never starts paid translation.
      const names = [...new Set(Object.values(post.tags).flat())].slice(0, 100);
      api('/api/translations/batch', { method: 'POST', body: { items: names, source: 'en', target: 'zh-CN', remote: false }, signal }).then(translations => {
        if (!dialog.open) return;
        const labels = new Map(translations.map(item => [booruKey(item.sourceText), item.text]));
        for (const chip of chipNodes.values()) {
          const text = labels.get(booruKey(chip.dataset.tag));
          if (text && booruKey(text) !== booruKey(chip.dataset.tag)) chip.append(node('small', '', text));
        }
      }).catch(() => {});
    } catch (error) {
      if (!signal.aborted && dialog.open) {
        message.textContent = error.message;
        tags.append(button('重试', () => openDetail(id)));
      }
    }
  }
  async function settings() {
    const dialog = dialogShell('画廊设置', 'booru-settings');
    const body = node('form', 'booru-settings-body'); dialog.append(body);
    const status = node('p', 'booru-hint', '正在读取设置…'); body.append(status); dialog.showModal();
    try {
      const saved = await api('/api/booru/settings');
      if (!dialog.open) return;
      body.innerHTML = `
        <section><h2>账号</h2><p class="booru-hint" id="booruAuthState"></p>
          <label>用户名<input name="username" autocomplete="off" maxlength="120" placeholder="仅更换账号时填写"></label>
          <label>API Key<input name="apiKey" type="password" autocomplete="new-password" maxlength="256" placeholder="留空保留已保存的账号"></label>
          <label class="booru-check"><input name="clearCredentials" type="checkbox">清除已保存的账号</label>
          <a class="booru-link" href="https://danbooru.donmai.us/profile" target="_blank" rel="noopener noreferrer">前往 Danbooru 账号页面</a>
          <button id="booruTestConnection" type="button">测试已保存的连接</button>
        </section>
        <section><h2>内容与提示词</h2>
          <label>内容黑名单<textarea name="blacklist" rows="3" placeholder="每行一个标签；支持 * 通配符"></textarea></label><p class="booru-hint">隐藏匹配图片，并从标签输出中排除。</p>
          <label>仅过滤输出标签<textarea name="outputFilter" rows="3" placeholder="每行一个标签；不隐藏图片"></textarea></label>
          <fieldset id="booruDefaultCategories"><legend>默认选中的标签类别</legend></fieldset>
          <label class="booru-check"><input name="spaces" type="checkbox">导入时把下划线转为空格</label>
          <label class="booru-check"><input name="escapeParentheses" type="checkbox">复制／导入时转义圆括号</label>
        </section>
        <section><h2>网络与缓存</h2>
          <label>请求超时（秒）<input name="timeout" type="number" min="5" max="120" required></label>
          <label>图片缓存上限（MB）<input name="cacheMiB" type="number" min="0" max="128" required></label>
          <p class="booru-hint" id="booruCacheState"></p><button type="button" id="booruClearCache">清空画廊缓存</button>
          <p class="booru-hint">缓存只在本次运行期间保留，关闭应用后释放。不会删除本机生成图片。保存原图沿用应用下载位置。</p>
        </section>
        <p class="booru-hint" id="booruSettingsStatus" role="status"></p>
        <button class="booru-primary" type="submit">保存设置</button>`;
      const field = name => body.elements.namedItem(name);
      const setStatus = text => body.querySelector('#booruSettingsStatus').textContent = text;
      const cacheStatus = value => body.querySelector('#booruCacheState').textContent = `已缓存 ${(value.cacheBytes / 1024 ** 2).toFixed(1)} MB / ${value.cacheCount} 个文件`;
      body.querySelector('#booruAuthState').textContent = saved.configured ? '已配置账号；凭据加密保存在本机，不包含在方案备份中。' : '当前为匿名访问；可以先浏览，需要时再填写账号。';
      for (const key of ['timeout', 'cacheMiB']) field(key).value = saved[key];
      for (const key of ['blacklist', 'outputFilter']) field(key).value = saved[key].join('\n');
      for (const key of ['spaces', 'escapeParentheses']) field(key).checked = saved[key];
      for (const category of BOORU_CATEGORIES) {
        const label = node('label', 'booru-check'), input = node('input'); input.type = 'checkbox'; input.name = `category-${category}`; input.checked = saved.categories.includes(category);
        label.append(input, document.createTextNode(BOORU_LABELS[category])); body.querySelector('fieldset').append(label);
      }
      cacheStatus(saved);
      body.querySelector('#booruTestConnection').onclick = async event => {
        const control = event.currentTarget; control.disabled = true; setStatus('正在测试已保存的连接…');
        try { const result = await api('/api/booru/test', { method: 'POST' }); setStatus(result.authenticated ? '账号连接成功。' : '匿名连接成功。'); }
        catch (error) { setStatus(error.message); } finally { control.disabled = false; }
      };
      body.querySelector('#booruClearCache').onclick = async event => {
        const control = event.currentTarget; control.disabled = true;
        try {
          request?.abort(); revision++; busy = false; controls();
          observer.disconnect(); releaseImages();
          const result = await api('/api/booru/cache', { method: 'DELETE' });
          cacheStatus(result); loaded = false;
          $('#booruGrid').replaceChildren(); posts = [];
          setStatus('画廊缓存已清空。关闭设置后重新搜索即可加载。');
          setStatusOutside('画廊缓存已清空，请搜索或刷新。');
        } catch (error) { setStatus(error.message); } finally { control.disabled = false; }
      };
      body.addEventListener('submit', async event => {
        event.preventDefault(); const control = body.querySelector('[type="submit"]'); control.disabled = true;
        try {
          const value = Object.fromEntries(['timeout', 'cacheMiB', 'blacklist', 'outputFilter'].map(key => [key, field(key).value]));
          value.categories = BOORU_CATEGORIES.filter(category => field(`category-${category}`).checked);
          for (const key of ['spaces', 'escapeParentheses', 'clearCredentials']) value[key] = field(key).checked;
          if (field('username').value || field('apiKey').value) { value.username = field('username').value; value.apiKey = field('apiKey').value; }
          config = await api('/api/booru/settings', { method: 'PUT', body: value });
          field('apiKey').value = ''; field('username').value = '';
          dialog.close(); detail?.close();
          // Old cards must not survive a newly tightened blacklist.
          observer.disconnect(); releaseImages(); $('#booruGrid').replaceChildren(); posts = [];
          search(1, false, currentQuery()); toast('画廊设置已保存。', 'success');
        } catch (error) { setStatus(error.message); } finally { control.disabled = false; }
      });
      dialog.addEventListener('close', () => { field('apiKey').value = ''; field('username').value = ''; });
    } catch (error) { status.textContent = error.message; }
  }
  const setStatusOutside = setStatus;
  function show() {
    shown = true;
    if (active === 'codex') codex.ensureLoaded();
    else if (!loaded && !busy) search(1, false, currentQuery());
  }
  function paintSelection() {
    root.dataset.reference = active;
    library.hidden = active !== 'codex'; mount.hidden = active !== 'booru';
    for (const control of nav.querySelectorAll('button')) {
      const selected = control.dataset.reference === active;
      control.setAttribute('aria-selected', String(selected)); control.tabIndex = selected ? 0 : -1;
    }
  }
  function select(next) {
    if (next === active) return;
    scroll[active] = window.scrollY; active = next;
    paintSelection();
    codex.closeDetail(); detail?.close();
    if (active !== 'booru') request?.abort();
    show();
    requestAnimationFrame(() => window.scrollTo({ top: scroll[active], behavior: 'instant' }));
  }
  return {
    isCodex: () => active === 'codex',
    show() {
      // Entering from the bottom navigation always starts in the preferred gallery.
      // Explicit subpage switching still restores each subpage's independent state.
      if (enabled) { active = 'booru'; paintSelection(); }
      show();
    },
    scrollPosition: () => scroll[active],
    hide(y = window.scrollY) { if (shown) scroll[active] = y; shown = false; detail?.close(); request?.abort(); },
    bind() {
      if (initialized) return; initialized = true; nav.hidden = !enabled;
      if (!enabled) return;
      nav.addEventListener('click', event => { const control = event.target.closest('button'); if (control) select(control.dataset.reference); });
      nav.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); select(event.key === 'Home' ? 'booru' : event.key === 'End' ? 'codex' : active === 'codex' ? 'booru' : 'codex');
        nav.querySelector('[aria-selected="true"]').focus();
      });
      window.addEventListener('nai-navigation-back', event => {
        if (event.defaultPrevented || !shown || active !== 'codex') return;
        select('booru'); event.preventDefault();
      });
      $('#booruSearchForm').addEventListener('submit', event => { event.preventDefault(); search(1, false, currentQuery()); });
      $('#booruChannel').addEventListener('change', () => { updateChannel(); search(1, false, currentQuery()); });
      $('#booruRating').addEventListener('change', () => search(1, false, currentQuery()));
      $('#booruSettings').addEventListener('click', settings);
      $('#booruCancel').addEventListener('click', () => request?.abort());
      $('#booruPrevious').addEventListener('click', () => search(page - 1, false));
      $('#booruNext').addEventListener('click', () => search(page + 1, false));
      $('#booruMore').addEventListener('click', () => pageFailed ? search(retryPage, retryAppend, retryCriteria) : search(page + 1, posts.length < 160));
      controls();
    }
  };
}
