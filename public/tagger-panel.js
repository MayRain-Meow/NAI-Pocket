// 图片反推: an image (from the gallery or the device) → Danbooru Tags through the server's
// /api/tagger (a public WD Tagger Space). The result is a sheet of selectable chips, like the
// 法典 detail: 追加 / 替换 into the editor (through the same editor operations), 复制, and
// 推荐画师 from the chosen Tags (DanbooruSearch co-occurrence).


const $ = selector => document.querySelector(selector);
function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function pill(text, className, data = {}) {
  const node = el('button', className, text);
  node.type = 'button';
  Object.assign(node.dataset, data);
  return node;
}

const RATING_LABELS = Object.freeze({ general: '全年龄', sensitive: '轻度', questionable: 'R15', explicit: 'R18' });
// Chips at or above this confidence start selected; the rest are offered, not assumed.
const PRESELECT = 0.5;

/**
 * @param {object} deps
 * @param {Function} deps.api        app api(url, options)
 * @param {Function} deps.toast
 * @param {Function} deps.parse      text → editor Tag object (or null)
 * @param {Function} deps.tagKey     Tag → presence key
 * @param {object}   deps.editor     { globalTagKeys(), appendTags(tags) → count, replaceTags(tags) → { count, removed } }
 * @param {Function} deps.addArtist  name → true when added to 画风
 */
export function createTaggerPanel({ api, toast, parse, tagKey, editor, addArtist }) {
  const dialog = $('#taggerDialog');
  let session = null; // { token, items: [{ text, confidence, kind, selected, present }], translations, imageUrl }
  let token = 0;

  function close() {
    if (session?.revoke) URL.revokeObjectURL(session.imageUrl);
    session = null;
    token += 1;
    if (dialog?.open) dialog.close();
  }

  function shell(imageUrl, label) {
    const head = el('div', 'tagger-head');
    const title = el('div', 'tagger-title');
    title.append(el('strong', '', '图片反推'), el('small', '', label || ''));
    const closeButton = pill('×', 'tagger-close', { taggerClose: '' });
    closeButton.setAttribute('aria-label', '关闭');
    head.append(title, closeButton);
    const body = el('div', 'tagger-body');
    const media = el('div', 'tagger-media');
    const img = el('img', 'tagger-image');
    img.alt = '';
    img.src = imageUrl;
    media.append(img);
    const content = el('div', 'tagger-content');
    body.append(media, content);
    dialog.replaceChildren(head, body);
    return content;
  }

  function renderLoading(content) {
    const box = el('div', 'tagger-loading');
    box.append(el('span', 'tagger-spinner'), el('p', '', '正在反推…'), el('small', '', '图片会上传到 HuggingFace 上的公开 WD Tagger 服务。通常 10–30 秒；服务刚启动时会更久。'));
    content.replaceChildren(box);
  }

  function renderError(content, message, retry) {
    const box = el('div', 'tagger-loading error');
    box.append(el('p', '', message));
    const again = pill('重试', 'tagger-retry');
    again.addEventListener('click', retry);
    box.append(again);
    content.replaceChildren(box);
  }

  function chip(item, index) {
    const node = pill('', `tagger-chip${item.present ? ' present' : ''}`, { taggerChip: String(index) });
    node.setAttribute('aria-pressed', String(item.selected));
    node.style.setProperty('--conf', String(item.confidence));
    const line = el('span', 'tagger-chip-line');
    line.append(el('b', '', item.text));
    if (item.present) line.append(el('i', '', '✓ 已有'));
    node.append(line);
    const translation = session.translations.get(item.text.toLowerCase());
    if (translation && translation.toLowerCase() !== item.text.toLowerCase()) node.append(el('small', '', translation));
    return node;
  }

  function render() {
    const content = dialog.querySelector('.tagger-content');
    if (!content || !session?.items) return;
    const selected = session.items.filter(item => item.selected);
    const sections = [];
    const meta = el('div', 'tagger-meta');
    if (session.rating) meta.append(el('span', `tagger-rating ${session.rating}`, RATING_LABELS[session.rating] || session.rating));
    meta.append(el('span', '', `${session.items.length} 个 Tag${session.cached ? ' · 缓存' : ''}`));
    const toggle = pill(selected.length === session.items.length ? '全不选' : '全选', 'tagger-link', { taggerAll: '' });
    meta.append(toggle);
    sections.push(meta);
    for (const [kind, label] of [['character', '角色'], ['general', 'Tag']]) {
      const list = session.items.map((item, index) => [item, index]).filter(([item]) => item.kind === kind);
      if (!list.length) continue;
      const block = el('section', 'tagger-block');
      block.append(el('div', 'tagger-label', label));
      const chips = el('div', 'tagger-chips');
      for (const [item, index] of list) chips.append(chip(item, index));
      block.append(chips);
      sections.push(block);
    }
    const actions = el('div', 'tagger-actions');
    const add = pill(`追加 ${selected.length} 个到 Tag`, 'tagger-primary', { taggerAction: 'append' });
    add.disabled = !selected.length;
    const replace = pill('替换现有', 'tagger-secondary', { taggerAction: 'replace' });
    replace.disabled = !selected.length;
    const copy = pill('复制', 'tagger-secondary', { taggerAction: 'copy' });
    copy.disabled = !selected.length;
    actions.append(add, replace, copy);
    sections.push(actions);
    const artists = el('section', 'tagger-artists');
    const artistsHead = el('div', 'tagger-artists-head');
    artistsHead.append(el('div', 'tagger-label', '按这些 Tag 找画师'), pill('推荐画师', 'tagger-secondary', { taggerAction: 'artists' }));
    artists.append(artistsHead, session.artistsNode || el('p', 'tagger-hint', '用所选 Tag（没有选中时用这张图的主要 Tag）在 Danbooru 上找经常画这类内容和风格的画师。'));
    sections.push(artists);
    content.replaceChildren(...sections);
  }

  async function loadTranslations(current) {
    const texts = [...new Set(current.items.map(item => item.text))].slice(0, 120);
    if (!texts.length) return;
    const results = await api('/api/translations/batch', { method: 'POST', body: { items: texts, source: 'en', target: 'zh-CN', remote: false } });
    if (current !== session) return;
    for (const item of results || []) if (item?.text && item.sourceText) current.translations.set(String(item.sourceText).toLowerCase(), item.text);
    render();
  }

  async function run(request, current) {
    const content = dialog.querySelector('.tagger-content');
    renderLoading(content);
    try {
      const result = await request();
      if (current !== session) return;
      const present = editor.globalTagKeys();
      const items = [
        ...result.characters.map(item => ({ ...item, kind: 'character' })),
        ...result.tags.map(item => ({ ...item, kind: 'general' }))
      ].map(item => {
        const parsed = parse(item.tag);
        const has = Boolean(parsed && present.has(tagKey(parsed)));
        return { text: item.tag, confidence: item.confidence, kind: item.kind, present: has, selected: !has && item.confidence >= PRESELECT };
      });
      Object.assign(current, { items, rating: result.rating, cached: result.cached });
      render();
      loadTranslations(current).catch(() => {});
    } catch (error) {
      if (current !== session) return;
      renderError(content, error.message || '反推失败。', () => run(request, current));
    }
  }

  async function recommendArtists() {
    const current = session;
    // The selected Tags, or — e.g. right after 追加, which deselects them — every confident one.
    const selected = current.items.filter(item => item.selected);
    const basis = selected.length ? selected : current.items.filter(item => item.confidence >= PRESELECT);
    const tags = basis.map(item => item.text.replace(/ /g, '_'));
    if (!tags.length) return toast('先选一些 Tag。');
    const box = el('div', 'tagger-artist-list');
    box.append(el('p', 'tagger-hint', '正在根据所选 Tag 推荐画师…'));
    current.artistsNode = box;
    render();
    try {
      const data = await api('/api/danbooru/artists', { method: 'POST', body: { tags, limit: 24, minCooc: 3, showNsfw: true } });
      if (current !== session) return;
      const results = Array.isArray(data?.results) ? data.results : [];
      box.replaceChildren(...(results.length ? results.map(artistRow) : [el('p', 'tagger-hint', '没有找到经常同时出现的画师，可以少选几个 Tag 再试。')]));
    } catch (error) {
      if (current !== session) return;
      box.replaceChildren(el('p', 'tagger-hint', `画师推荐失败：${error.message}`));
    }
  }

  function artistRow(item) {
    const row = el('div', 'tagger-artist');
    const text = el('div', 'tagger-artist-text');
    const name = el('a', 'tagger-artist-name', item.artist.replace(/_/g, ' '));
    name.href = `https://danbooru.donmai.us/posts?tags=${encodeURIComponent(item.artist)}`;
    name.target = '_blank';
    name.rel = 'noopener noreferrer';
    text.append(name, el('small', '', `共现 ${item.coocCount ?? 0} · 作品 ${item.postCount ?? 0}`));
    const top = (item.topTags || []).slice(0, 6).map(tag => tag.tag.replace(/_/g, ' ')).join(' · ');
    if (top) text.append(el('em', '', top));
    const actions = el('div', 'tagger-artist-actions');
    const preview = pill('预览', 'tagger-secondary');
    preview.dataset.artistPreview = `artist:${item.artist}`;
    const add = pill('＋ 画风', 'tagger-secondary');
    add.addEventListener('click', () => { if (addArtist(item.artist)) add.disabled = true; });
    actions.append(preview, add);
    row.append(text, actions);
    return row;
  }

  function act(action) {
    const chosen = session.items.filter(item => item.selected);
    const tags = chosen.map(item => parse(item.text)).filter(Boolean);
    if (action === 'append') {
      const count = editor.appendTags(tags);
      for (const item of chosen) { item.present = true; item.selected = false; }
      render();
      return toast(count ? `已追加 ${count} 个 Tag 到对应分区，可撤销。` : '这些 Tag 都已存在。', count ? 'success' : '');
    }
    if (action === 'replace') {
      const { count, removed } = editor.replaceTags(tags);
      for (const item of session.items) { item.present = chosen.includes(item); if (item.present) item.selected = false; }
      render();
      return toast(`已替换为 ${count} 个 Tag${removed ? `，原有 ${removed} 个可撤销恢复` : ''}。`, 'success');
    }
    if (action === 'copy') {
      return navigator.clipboard.writeText(chosen.map(item => item.text).join(', '))
        .then(() => toast('已复制所选 Tag。', 'success'))
        .catch(() => toast('复制失败，浏览器未允许访问剪贴板。', 'error'));
    }
    if (action === 'artists') return recommendArtists();
  }

  function bind() {
    if (!dialog) return;
    dialog.addEventListener('click', event => {
      if (event.target === dialog || event.target.closest('[data-tagger-close]')) return close();
      const chipNode = event.target.closest('[data-tagger-chip]');
      if (chipNode && session?.items) {
        const item = session.items[Number(chipNode.dataset.taggerChip)];
        item.selected = !item.selected;
        return render();
      }
      if (event.target.closest('[data-tagger-all]') && session?.items) {
        const select = session.items.some(item => !item.selected);
        session.items.forEach(item => { item.selected = select; });
        return render();
      }
      const action = event.target.closest('[data-tagger-action]')?.dataset.taggerAction;
      if (action && session?.items) act(action);
    });
    dialog.addEventListener('close', () => { if (session) close(); });
  }

  // One of: { imageId, label } for a gallery image, or { file } for an image from the device.
  function open({ imageId = '', file = null, label = '' } = {}) {
    if (!dialog) return;
    close();
    const imageUrl = file ? URL.createObjectURL(file) : `/api/images/${encodeURIComponent(imageId)}/preview`;
    session = { token: ++token, translations: new Map(), imageUrl, revoke: Boolean(file) };
    shell(imageUrl, label || (file ? file.name : ''));
    dialog.showModal();
    const request = file
      ? () => api('/api/tagger', { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } })
      : () => api(`/api/tagger?imageId=${encodeURIComponent(imageId)}`, { method: 'POST' });
    run(request, session);
  }

  bind();
  return { open, close };
}
