// 图片反推: an image (from the gallery or the device) → Danbooru Tags through the server's
// /api/tagger (a public WD Tagger Space). The result is a sheet of selectable chips, like the
// 法典 detail: 追加 / 替换 into the editor (through the same editor operations), 复制, and
// 推荐画师 from the chosen Tags (DanbooruSearch co-occurrence).
// AI 反推 (1.9.5) sits above it: a vision model on the 画风标注 route writes a whole draft — four
// sections, sentences, characters — reviewed first, explicitly applied as one undo step.



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
// The parts of a draft that can be filled separately (1.9.12).
const PARTS = ['style', 'scene', 'camera', 'misc', 'characters'];
const PART_LABELS = Object.freeze({ style: '画风与质感', scene: '场景', camera: '镜头', misc: '关系与其他', characters: '角色' });
// 替换 / 追加 (1.9.13): a per-device convenience, so it lives in localStorage.

/**
 * @param {object} deps
 * @param {Function} deps.api        app api(url, options)
 * @param {Function} deps.toast
 * @param {Function} deps.parse      text → editor Tag object (or null)
 * @param {Function} deps.tagKey     Tag → presence key
 * @param {object}   deps.editor     { globalTagKeys(), appendTags(tags) → count, replaceTags(tags) → { count, removed }, applyReverse(result) → counts }
 * @param {Function} deps.addArtist  name → true when added to 画风
 */
export function createTaggerPanel({ api, toast, parse, tagKey, editor, addArtist, navigate, isActive, chooseFile, openGallery, openEditor = () => {}, openArtistPage = () => {} }) {
  const panel = $('#reverseWorkspace');
  const settingsDialog = $('#reverseSettingsDialog');
  const settingsSession = { ai: {} };
  let session = null; // { token, items: [{ text, confidence, kind, selected, present }], translations, imageUrl }
  let token = 0;
  const TASK_STORAGE = 'nai-pocket-reverse-jobs-v1';
  const tasks = [];
  // No AI 反推 here (the app: no server route, no model key): the page is the Tagger's 候选 Tag only.
  let aiUnavailable = false;

  function close() {
    if (settingsDialog?.open) settingsDialog.close();
  }

  function shell(imageUrl, label) {
    const head = el('div', 'tagger-head');
    const title = el('div', 'tagger-title');
    title.append(el('strong', '', '图片反推'));
    const headerActions = el('div', 'tagger-header-actions');
    headerActions.append(pill('换图', 'tagger-change-image', { reverseChoose: '' }));
    if (!aiUnavailable) headerActions.append(pill('设置', 'tagger-settings-button', { reverseSettings: '' }));
    head.append(title, headerActions);
    const viewNav = el('nav', 'tagger-view-nav');
    viewNav.setAttribute('aria-label', '反推内容');
    for (const [view, text] of [['draft', '提示词草稿'], ['tags', '候选 Tag']]) {
      const button = pill(text, 'tagger-view-tab', { reverseView: view });
      button.setAttribute('aria-selected', String(view === 'draft'));
      viewNav.append(button);
    }
    const body = el('div', 'tagger-body');
    const media = el('div', 'tagger-media');
    const img = el('img', 'tagger-image');
    img.alt = '';
    if (imageUrl) {
      img.src = imageUrl;
      const imageButton = pill('', 'tagger-image-button');
      imageButton.setAttribute('aria-label', '放大查看原图，再次点击收起');
      imageButton.setAttribute('aria-expanded', 'false');
      imageButton.append(img);
      imageButton.addEventListener('click', () => { const expanded = media.classList.toggle('expanded'); imageButton.setAttribute('aria-expanded', String(expanded)); });
      media.append(imageButton);
    }
    else media.append(el('p', 'tagger-image-missing', '已恢复的任务 · 本地原图不会保存在浏览器中'));
    media.append(el('p', 'tagger-media-caption', '查看原图 ↗'));
    const content = el('div', 'tagger-content');
    const ai = el('section', 'tagger-ai');
    const candidates = el('section', 'tagger-candidates');
    candidates.hidden = true;
    candidates.append(el('h2', '', '从候选词开始挑选'), el('p', 'tagger-hint', '这些是 Tagger 的候选，不会自动加入 AI 草稿。'));
    const wd = el('div', 'tagger-wd');
    candidates.append(wd);
    content.append(ai, candidates);
    body.append(media, content);
    const footer = el('div', 'tagger-footer');
    footer.hidden = true;
    panel.dataset.view = 'draft';
    panel.replaceChildren(head, viewNav, body, footer);
    if (aiUnavailable) showTaggerOnly();
    return { ai, wd };
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
    const content = panel.querySelector('.tagger-wd');
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
    const content = panel.querySelector('.tagger-wd');
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
    const name = pill(item.artist.replace(/_/g, ' '), 'tagger-artist-name', { artistLook: item.artist.replace(/_/g, ' ') });
    text.append(name, el('small', '', `共现 ${item.coocCount ?? 0} · 作品 ${item.postCount ?? 0}`));
    const top = (item.topTags || []).slice(0, 6).map(tag => tag.tag.replace(/_/g, ' ')).join(' · ');
    if (top) text.append(el('em', '', top));
    const actions = el('div', 'tagger-artist-actions');
    actions.append(pill('画师页', 'tagger-secondary', { artistLook: item.artist.replace(/_/g, ' ') }), addArtistButton(item.artist.replace(/_/g, ' ')));
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

  // ---- AI 反推 ----
  let aiSettings = null; // { rule, customRule, defaultRule, presets, last, route }
  const EFFORTS = [['off', '关'], ['low', '低'], ['high', '高']];
  const MODES = [['quick', '直接写稿'], ['agent', '细看查证']];
  // The Tagger view alone: no 草稿 tab, no AI section, no footer, no 设置.
  function showTaggerOnly() {
    panel.dataset.view = 'tags';
    panel.classList.add('no-ai');
    panel.querySelector('.tagger-view-nav')?.setAttribute('hidden', '');
    panel.querySelector('.tagger-ai')?.setAttribute('hidden', '');
    panel.querySelector('.tagger-candidates')?.removeAttribute('hidden');
    panel.querySelector('.tagger-footer')?.setAttribute('hidden', '');
    panel.querySelector('.tagger-settings-button')?.remove();
    const intro = panel.querySelector('.tagger-candidates > .tagger-hint');
    if (intro) intro.textContent = '点掉不想要的，再加进编辑器。';
  }

  async function loadAiSettings(current) {
    if (aiUnavailable) return;
    try {
      aiSettings = (await api('/api/prompt-reverse/settings')).settings;
      if (current !== (session || settingsSession)) return;
      current.ai.mode ??= aiSettings.last.mode || 'quick';
      current.ai.effort ??= aiSettings.last.effort;
      current.ai.requirement ??= aiSettings.last.requirement;
    } catch (error) {
      if (error.status === 404) {
        aiUnavailable = true;
        if (session) showTaggerOnly(); else if (panel?.dataset.reverseState === 'empty') show();
        return;
      }
      if (current !== (session || settingsSession)) return;
      current.ai.settingsError = error.message;
    }
    renderAi(current);
    if (settingsDialog.open) renderSettings(current);
  }

  function renderAi(current) {
    const ai = current.ai, node = ai.node;
    if (!node) return;
    panel.dataset.reverseState = ai.task ? ai.task.state : 'idle';
    const mediaCaption = panel.querySelector('.tagger-media-caption');
    if (mediaCaption) mediaCaption.textContent = '原图 ↗';
    const head = el('div', 'tagger-ai-head');
    if (ai.settingsError) head.append(el('small', '', ai.settingsError));
    const taskNav = el('nav', 'tagger-task-nav');
    taskNav.setAttribute('aria-label', '最近的反推任务');
    for (const task of tasks.length === 1 && tasks[0] === ai.task ? [] : tasks) {
      const button = pill(taskTabLabel(task), 'tagger-task-tab');
      button.dataset.taskIndex = String(tasks.indexOf(task));
      button.title = task.label || '图片';
      button.setAttribute('aria-current', String(task === ai.task));
      button.addEventListener('click', () => resumeTask(task));
      taskNav.append(button);
    }
    if (ai.task) {
      const taskHost = el('div', 'tagger-task-host');
      taskHost.append(taskView(ai.task));
      node.replaceChildren(taskNav, taskHost, ...(ai.status ? [ai.status] : []));
      renderFooter(ai.task);
      return;
    }
    const presets = el('div', 'tagger-ai-presets');
    const shortNames = { '细看画法': '画法', '只借画风': '画风', '构图与互动': '构图', '角色与服装': '服装' };
    for (const [index, preset] of (aiSettings?.presets || []).entries()) {
      const button = pill(shortNames[preset.name] || preset.name, 'tagger-ai-preset', { aiPreset: String(index) });
      button.title = preset.name;
      button.setAttribute('aria-label', preset.name);
      button.setAttribute('aria-pressed', String((ai.mode || 'quick') === preset.mode && (ai.effort || 'off') === preset.effort && (ai.requirement || '') === preset.requirement));
      presets.append(button);
    }
    const selected = aiSettings?.presets.find(preset => preset.requirement === ai.requirement);
    const summaries = { '完整草稿': '还原内容、构图与画法', '细看画法': '放大细节，细看笔触与材质', '只借画风': '只提取可复用的画法', '构图与互动': '提取取景、位置与人物互动', '角色与服装': '提取人物外貌与服饰细节' };
    const text = (ai.requirement || '').replace(/\s+/g, ' ').trim();
    const summary = selected ? summaries[selected.name] || selected.name : text ? `自定 · ${text.slice(0, 52)}${text.length > 52 ? '…' : ''}` : '还原内容、构图与画法';
    const intent = el('div', 'tagger-intent');
    intent.append(el('p', '', summary), pill('调整要求', 'tagger-intent-edit', { reverseSettings: 'run' }));
    const parts = [taskNav, ...(head.childElementCount ? [head] : []), presets, intent];
    if (aiSettings && !aiSettings.route.configured) parts.push(el('p', 'tagger-hint', '请先在设置中配置模型通道。'));
    if (ai.status) parts.push(ai.status);
    node.replaceChildren(...parts);
    renderFooter(null);
  }

  function taskTabLabel(task) {
    const label = /^[a-f0-9]{16,}(?:\.[a-z0-9]+)?$/i.test(task.label || '') ? `图片 ${tasks.indexOf(task) + 1}` : (task.label || '图片').replace(/\.[^.]+$/, '').slice(0, 16);
    return `${task.state === 'done' ? (task.applied ? '已填入' : '待审') : task.state === 'unconfirmed' ? '待确认' : task.state === 'failed' || task.state === 'unavailable' ? '失败' : '进行中'} · ${label}`;
  }

  function renderFooter(task) {
    const footer = panel.querySelector('.tagger-footer');
    if (!footer) return;
    const idle = !task && Boolean(session?.ai?.start);
    footer.hidden = panel.dataset.view !== 'draft' || (!idle && (task?.state !== 'done' || !task.result));
    if (footer.hidden) { footer.replaceChildren(); return; }
    if (idle) {
      const start = pill('开始反推', 'tagger-primary', { aiRun: '' });
      start.disabled = !aiSettings?.route.configured;
      footer.replaceChildren(start);
      return;
    }
    const parts = task.include ?? new Set(PARTS);
    // The draft stays usable after a fill: it can be filled again (other parts, 追加 instead of 替换 …).
    // 替换 and 追加 are the two ways to fill, side by side; the one used confirms for a moment.
    const flash = task.flashUntil && Date.now() < task.flashUntil ? task.flashMode : '';
    const replace = pill(flash === 'replace' ? '✓ 已替换' : '替换填入', `tagger-primary${flash === 'replace' ? ' flashed' : ''}`, { aiApply: 'replace' });
    const append = pill(flash === 'append' ? '✓ 已追加' : '追加', `tagger-secondary tagger-append${flash === 'append' ? ' flashed' : ''}`, { aiApply: 'append' });
    replace.disabled = append.disabled = !parts.size;
    const copy = pill('复制', 'tagger-secondary tagger-copy', { aiCopy: '' });
    copy.setAttribute('aria-label', '复制草稿');
    const actions = el('div', 'tagger-review-actions');
    actions.append(replace, append, copy);
    const chosen = PARTS.filter(part => parts.has(part)).map(part => PART_LABELS[part]);
    const where = chosen.length === PARTS.length ? '正面词' : chosen.join('、');
    const plan = !parts.size ? '没有选中要填入的部分。'
      : `替换：换掉${where}原有内容${parts.has('style') ? '（含画师串，这页加入的保留）' : ''}；追加：只补没有的。都可撤销。`;
    const note = el('small', 'tagger-apply-note');
    if (task.appliedHere) note.append(`刚才${task.appliedMode === 'append' ? '追加' : '替换'}填入：${task.appliedSummary || '草稿'}，撤销一步即可还原。`, pill('去编辑器看看 ›', 'tagger-link tagger-note-link', { aiOpenEditor: '' }));
    else note.append(task.applied ? `此前已填入过。${plan}` : plan);
    footer.replaceChildren(actions, note);
  }

  function showSettings(tab = 'run') {
    const current = session || settingsSession;
    current.ai.settingsTab = ['run', 'rule', 'channel', 'presets'].includes(tab) ? tab : 'run';
    renderSettings(current);
    if (!settingsDialog.open) settingsDialog.showModal();
    if (!aiSettings) loadAiSettings(current);
  }

  function renderSettings(current) {
    const head = el('div', 'reverse-settings-head');
    head.append(el('strong', '', '反推设置'), pill('完成', 'tagger-secondary', { reverseSettingsClose: '' }));
    const tabs = el('nav', 'reverse-settings-tabs');
    for (const [key, text] of [['run', '运行方式'], ['rule', '写词规则'], ['channel', '模型通道'], ['presets', '预设']]) {
      const button = pill(text, 'tagger-view-tab', { reverseSettingsTab: key });
      button.setAttribute('aria-selected', String(key === (current.ai.settingsTab || 'run')));
      tabs.append(button);
    }
    settingsDialog.replaceChildren(head, tabs, ruleEditor(current));
    if (current.ai.settingsError) settingsDialog.append(status('error', el('p', '', current.ai.settingsError)));
  }

  // Advanced controls live in one settings surface, not a stack of folds in the workspace.
  // Each tab is a few labelled sections (a small title, the control, one line on what it does).
  const EFFORT_NOTES = { off: '最快；大多数图够用。', low: '多想一步，稍慢一点。', high: '想得最细，也最慢、最费额度。' };
  function section(title, ...children) {
    const box = el('section', 'rs-section');
    if (title) box.append(el('h3', 'rs-title', title));
    box.append(...children);
    return box;
  }
  function field(label, control) {
    const box = el('label', 'rs-field');
    box.append(el('span', 'rs-label', label), control);
    return box;
  }
  function ruleEditor(current) {
    const box = el('div', 'reverse-settings-body');
    if (!aiSettings) { box.append(el('p', 'tagger-hint', current.ai.settingsError || '读取设置…')); return box; }
    const tab = current.ai.settingsTab || 'run';
    box.dataset.settingsTab = tab;
    if (tab === 'run') {
      const ask = el('textarea', 'tagger-ai-ask');
      ask.rows = 4;
      ask.maxLength = 300;
      ask.setAttribute('aria-label', '这次反推的要求');
      ask.placeholder = '例如：多写头发质感，保留环境光色…';
      ask.value = current.ai.requirement || '';
      ask.dataset.aiAsk = '';
      const modes = el('div', 'rs-options');
      modes.setAttribute('role', 'radiogroup');
      modes.setAttribute('aria-label', '方式');
      for (const [value, label] of MODES) {
        const on = (current.ai.mode || 'quick') === value;
        const button = pill('', `rs-option${on ? ' on' : ''}`, { aiMode: value });
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(on));
        const copy = el('span', 'rs-option-copy');
        copy.append(el('strong', '', label), el('small', '', value === 'quick' ? '一次看全图，直接写出草稿。几十秒。' : '按需放大细节、查 Tag 后交稿。更全，一两分钟。'));
        button.append(el('span', 'rs-radio'), copy);
        modes.append(button);
      }
      const effort = current.ai.effort || 'off';
      const efforts = el('div', 'rs-segment');
      efforts.setAttribute('role', 'radiogroup');
      efforts.setAttribute('aria-label', '思考强度');
      for (const [value, label] of EFFORTS) {
        const button = pill(label, 'rs-segment-option', { aiEffort: value });
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(effort === value));
        button.setAttribute('aria-pressed', String(effort === value));
        efforts.append(button);
      }
      box.append(
        section('这次要求', ask, el('p', 'rs-note', '选首页的预设会填进来；也可以直接改写。只用于这一次，存成预设才会保留。')),
        section('方式', modes),
        section('思考强度', efforts, el('p', 'rs-note', EFFORT_NOTES[effort] || '')));
      return box;
    }
    if (tab === 'channel') {
      const state = el('div', `rs-status${aiSettings.route.configured ? ' ok' : ''}`);
      state.append(el('span', 'rs-status-dot'), el('span', '', `${aiSettings.route.label} · ${aiSettings.route.model || '未选模型'}`),
        el('small', '', aiSettings.route.configured ? '可用' : '未配置'));
      box.append(state, channelForm(current), el('p', 'rs-note', '图片会发送给所选接口。Key 加密存在服务器上，同一接口地址共用一把。'));
      return box;
    }
    if (tab === 'rule') {
      const area = el('textarea', 'tagger-ai-rule-text');
      area.value = current.ai.ruleDraft ?? aiSettings.rule;
      area.rows = 10;
      area.setAttribute('aria-label', '写词规则');
      area.addEventListener('input', () => { current.ai.ruleDraft = area.value; });
      const actions = el('div', 'rs-actions');
      actions.append(pill('保存规则', 'tagger-primary', { aiRuleSave: '' }), pill('恢复默认', 'tagger-secondary', { aiRuleReset: '' }));
      box.append(el('p', 'rs-note', aiSettings.customRule ? '正在用你改过的规则。保存后用于之后的任务，进行中和已完成的不变。' : '正在用内置规则。改了保存后用于之后的任务，进行中和已完成的不变。'), area, actions);
      return box;
    }
    const list = el('ul', 'rs-list');
    const modeName = Object.fromEntries(MODES), effortName = Object.fromEntries(EFFORTS);
    for (const [index, preset] of aiSettings.presets.entries()) {
      const row = el('li', 'rs-row');
      const copy = el('span', 'rs-row-copy');
      const ask = String(preset.requirement || '').replace(/\s+/g, ' ').trim();
      copy.append(el('strong', '', preset.name), el('small', '', `${modeName[preset.mode] || preset.mode} · 思考${effortName[preset.effort] || preset.effort}${ask ? ` · ${ask.slice(0, 28)}${ask.length > 28 ? '…' : ''}` : ''}`));
      const remove = pill('×', 'rs-row-remove', { aiPresetDelete: String(index) });
      remove.setAttribute('aria-label', `删除预设「${preset.name}」`);
      row.append(copy, remove);
      list.append(row);
    }
    if (!aiSettings.presets.length) list.append(el('li', 'rs-row rs-empty', '还没有预设。'));
    const presetName = el('input', 'tagger-ai-preset-name');
    presetName.type = 'text';
    presetName.maxLength = 20;
    presetName.placeholder = '给它起个名';
    presetName.dataset.aiPresetName = '';
    const saveRow = el('div', 'rs-inline');
    saveRow.append(presetName, pill('保存', 'tagger-primary', { aiPresetSave: '' }));
    const reset = pill('恢复默认预设', 'tagger-link rs-reset', { aiPresetsReset: '' });
    box.append(section('首页的预设', list),
      section('存为新预设', saveRow, el('p', 'rs-note', '保存“运行方式”里当前的方式、思考强度和这次要求。')),
      reset);
    return box;
  }

  // Which route answers: follow 画风标注, or this feature's own route and model. Any OpenAI-compatible
  // service (Gemini, OpenRouter, a relay) goes in as 自定义. A key typed here is kept per host and shared.
  function channelForm(current) {
    const draft = current.ai.channelDraft ??= { ...aiSettings.channel };
    const form = el('div', 'tagger-ai-channel');
    const route = el('select', 'tagger-ai-select');
    route.dataset.aiChannel = 'endpointId';
    const follow = new Option('跟随画风标注', 'annotation');
    route.append(follow, ...aiSettings.routes.map(item => new Option(`${item.label}${item.hasKey ? ' · 已有 Key' : ''}`, item.id)));
    route.value = draft.endpointId;
    form.append(field('通道', route));
    const entry = aiSettings.routes.find(item => item.id === draft.endpointId);
    if (entry) {
      const model = el('input', 'tagger-ai-preset-name');
      model.type = 'text';
      model.placeholder = entry.models[0] || '模型名，如 gemini-2.5-flash';
      model.value = draft.model;
      model.dataset.aiChannel = 'model';
      model.setAttribute('list', 'taggerAiModels');
      const models = el('datalist');
      models.id = 'taggerAiModels';
      models.append(...entry.models.map(name => new Option(name, name)));
      form.append(field('模型', model), models);
      if (entry.custom) {
        const address = el('input', 'tagger-ai-preset-name');
        address.type = 'url';
        address.placeholder = 'https://…/v1/chat/completions';
        address.value = draft.customUrl;
        address.dataset.aiChannel = 'customUrl';
        const thinking = el('select', 'tagger-ai-select');
        thinking.dataset.aiChannel = 'customThinking';
        thinking.append(...aiSettings.thinkingOptions.map(item => new Option(item.label, item.id)));
        thinking.value = draft.customThinking;
        form.append(field('接口地址', address), field('关闭思考的写法', thinking));
      }
      const key = el('input', 'tagger-ai-preset-name');
      key.type = 'password';
      key.autocomplete = 'off';
      key.placeholder = entry.hasKey ? '已有 Key；要换才填' : `API Key（${entry.keyPlaceholder}）`;
      key.dataset.aiChannel = 'apiKey';
      if (current.ai.keyDraft?.endpointId === draft.endpointId && current.ai.keyDraft?.customUrl === (draft.customUrl || '')) key.value = current.ai.keyDraft.value;
      form.append(field('API Key', key));
    } else form.append(el('p', 'rs-note', '用“画风标注”里设好的通道和 Key。'));
    form.append(pill('保存通道', 'tagger-primary rs-wide', { aiChannelSave: '' }));
    return form;
  }

  function status(className, ...children) {
    const box = el('div', `tagger-ai-status ${className}`.trim());
    box.append(...children);
    return box;
  }

  async function saveAi(body, current) {
    try {
      aiSettings = (await api('/api/prompt-reverse/settings', { method: 'PUT', body })).settings;
      if ('rule' in body) current.ai.ruleDraft = undefined;
      if ('channel' in body || 'apiKey' in body) { current.ai.channelDraft = undefined; current.ai.keyDraft = undefined; }
      current.ai.settingsError = '';
      current.ai.status = null;
      toast('反推设置已保存。', 'success');
    } catch (error) { current.ai.settingsError = `保存失败：${error.message}`; }
    if (current === session) renderAi(current);
    if (settingsDialog.open && current === (session || settingsSession)) renderSettings(current);
  }

  function stepList(steps) {
    const box = el('ol', 'tagger-ai-steps');
    for (const step of steps) box.append(el('li', '', `${(step.at / 1000).toFixed(0)}s · ${step.text}`));
    return box;
  }

  function aiResult(data, task) {
    const draft = data.result;
    const tagCount = ['style', 'scene', 'camera', 'misc'].reduce((count, key) => count + (draft[key]?.length || 0), 0)
      + (draft.characters || []).reduce((count, character) => count + character.tags.length, 0);
    const sentenceCount = (draft.sentences?.length || 0) + (draft.characters || []).reduce((count, character) => count + (character.sentences?.length || 0), 0);
    const parts = [el('div', 'tagger-result-heading', task.applied ? task.appliedHere ? '已填入编辑器' : '此前已填入' : '草稿已就绪'),
      el('p', 'tagger-result-summary', `${tagCount} 个 Tag · ${sentenceCount} 句描述 · ${draft.characters?.length || 0} 个角色`)];
    if (task.steps?.length) parts.push(thoughts(task, false));
    const report = data.result.tagReport;
    if (draft.notes) {
      const notes = el('section', 'tagger-review-notes');
      const notesHead = el('div', 'tagger-notes-head');
      notesHead.append(el('strong', '', '疑点'));
      if (draft.notes.length > 60) {
        const toggle = pill('展开', 'tagger-notes-toggle');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', () => { const expanded = notes.classList.toggle('expanded'); toggle.textContent = expanded ? '收起' : '展开'; toggle.setAttribute('aria-expanded', String(expanded)); });
        notes.classList.add('collapsible');
        notesHead.append(toggle);
      }
      notes.append(notesHead, el('p', '', draft.notes));
      parts.push(notes);
    }
    const groups = el('div', 'tagger-draft-groups');
    const sentenceGroup = { relation: 'misc', scene: 'scene', texture: 'style', style: 'style' };
    task.include ??= new Set(PARTS);
    task.excluded ??= new Set();
    const item = (key, text, className) => {
      const node = pill(text, className, { draftItem: key });
      node.setAttribute('aria-pressed', String(!task.excluded.has(key)));
      node.title = task.excluded.has(key) ? '点一下放回草稿' : '点一下从草稿里去掉';
      return node;
    };
    const appendGroup = (part, title, tags, sentences) => {
      if (!tags.length && !sentences.length) return;
      const on = task.include.has(part);
      const section = el('section', `tagger-draft-group${on ? '' : ' off'}`);
      const head = el('div', 'tagger-draft-head');
      const toggle = pill(on ? '填入' : '不填', 'tagger-draft-toggle', { draftPart: part });
      toggle.setAttribute('aria-pressed', String(on));
      toggle.setAttribute('aria-label', `${title}：${on ? '填入' : '不填'}`);
      const label = el('h3', '', title);
      if (task.filledParts?.has(part)) label.append(el('span', 'tagger-draft-filled', '已填入'));
      head.append(label, toggle);
      section.append(head);
      if (tags.length) { const box = el('div', 'tagger-draft-chips'); tags.forEach(([key, text]) => box.append(item(key, text, 'tagger-draft-chip'))); section.append(box); }
      for (const [key, text] of sentences) section.append(item(key, text, 'tagger-draft-sentence'));
      groups.append(section);
    };
    const sentencesOf = key => (draft.sentences || []).map((entry, index) => [entry, index]).filter(([entry]) => (sentenceGroup[entry.kind] || 'scene') === key).map(([entry, index]) => [`sent:${index}`, entry.text]);
    for (const [key, label] of [['style', '画风与质感'], ['scene', '场景'], ['camera', '镜头'], ['misc', '关系与其他']]) {
      appendGroup(key, label, (draft[key] || []).map((text, index) => [`${key}:${index}`, text]), sentencesOf(key));
    }
    for (const [index, character] of (draft.characters || []).entries()) appendGroup('characters', `角色 ${index + 1}${character.label ? ` · ${character.label}` : ''}`,
      (character.tags || []).map((text, i) => [`char${index}:t:${i}`, text]), (character.sentences || []).map((text, i) => [`char${index}:s:${i}`, text]));
    parts.push(el('p', 'tagger-draft-hint', '点 Tag 或句子可以先去掉；关掉某一栏，填入时就保留编辑器里原来的那一栏。填过之后也能改了再填。'));
    parts.push(groups);
    if (report?.checked) parts.push(el('small', '', `核对 ${report.checked} 个 Tag · ${report.renamed?.length || 0} 个规范写法 · ${report.phrases?.length || 0} 个未查到活跃记录，保留原文。`));
    const facts = [`${data.mode === 'agent' ? `Agent ${data.steps} 步 · ` : ''}用时 ${(data.durationMs / 1000).toFixed(1)} 秒`];
    if (Number.isFinite(data.cost)) facts.push(`约 ${data.cost < 0.01 ? data.cost.toFixed(4) : data.cost.toFixed(3)} ${data.currency}`);
    parts.push(el('small', '', facts.join(' · ')));
    if (data.artists?.length) {
      // Each card shows the artist's picture closest to this one, so the likeness is visible before adding.
      const section = el('section', 'reverse-artists');
      section.append(el('h3', '', '画风相近的画师'), el('p', 'tagger-hint', '卡片上是这位画师最像你这张图的作品。点图进画师页，看完点“回到反推”。'));
      const grid = el('div', 'reverse-artist-grid');
      for (const item of data.artists.slice(0, 6)) {
        const card = el('div', 'reverse-artist-card');
        const look = pill('', 'reverse-artist-look', { artistLook: item.artist });
        look.setAttribute('aria-label', `打开 ${item.artist} 的画师页`);
        const cover = el('span', 'reverse-artist-cover');
        if (item.thumbUrl) { const img = el('img'); img.alt = ''; img.loading = 'lazy'; img.src = item.thumbUrl; cover.append(img); }
        else cover.append(el('i', '', item.artist.slice(0, 1).toUpperCase()));
        look.append(cover, el('strong', '', item.artist));
        card.append(look, addArtistButton(item.artist));
        grid.append(card);
      }
      section.append(grid);
      parts.push(section);
    }
    const dismiss = pill('移除记录', 'tagger-link', { aiDismiss: '' });
    parts.push(dismiss);
    return status('done', ...parts);
  }

  function duration(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
  }

  function elapsed(task) { return task.elapsedMs ?? Math.max(0, Date.now() - task.startedAt); }

  // 思考过程 (1.9.15): the steps as a thread on the page, like a chat's reasoning — open while the task
  // runs (the newest step breathes), folded to one line once the draft is in. The reason the model gave
  // for a step (the part in （）) is shown under it.
  function thoughts(task, running) {
    const steps = task.steps || [];
    const box = el('details', `reverse-thoughts${running ? ' running' : ''}`);
    box.open = task.thoughtsOpen ?? running;
    // Only the reader's own click is remembered; the toggle event also fires for the open set above.
    box.addEventListener('click', event => { if (event.target.closest('summary')) task.thoughtsOpen = !box.open; });
    const summary = el('summary');
    const meta = el('small', '', `${steps.length} 步 · ${duration(elapsed(task))}`);
    if (running) meta.dataset.thoughtMeta = '';
    summary.append(el('span', 'reverse-thoughts-title', running ? '思考中' : '思考过程'), meta);
    const list = el('ol', 'reverse-thought-list');
    const rows = steps.length ? steps : [{ at: 0, text: task.state === 'starting' ? '正在提交图片' : '等待服务器接收任务' }];
    rows.forEach((step, index) => {
      const [, main = step.text, why = ''] = String(step.text).match(/^(.*?)(?:（(.+)）)?$/) || [];
      const item = el('li', `reverse-thought${running && index === rows.length - 1 ? ' active' : ''}`);
      const line = el('div', 'reverse-thought-line');
      line.append(el('span', 'reverse-thought-text', main), el('time', '', `${Math.round((step.at || 0) / 1000)}s`));
      item.append(line);
      if (why) item.append(el('small', '', why));
      list.append(item);
    });
    box.append(summary, list);
    return box;
  }

  // ＋ 加入 reads the editor every time it is shown: an artist taken out of 画风 there can be added again,
  // and tapping one that is in 画风 takes it out. Artists added here survive a 替换 fill of this draft.
  function artistButtonState(button) {
    const name = button.dataset.artistAdd;
    const on = Boolean(editor.hasArtist?.(name));
    button.textContent = on ? '✓ 画风中' : '＋ 加入';
    button.classList.toggle('added', on);
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', on ? `从画风移除 ${name}` : `加入画风 ${name}`);
  }
  function addArtistButton(name) {
    const button = pill('', 'reverse-artist-add', { artistAdd: name });
    artistButtonState(button);
    return button;
  }
  function syncArtistButtons() { for (const button of document.querySelectorAll('[data-artist-add]')) artistButtonState(button); }
  function toggleArtist(name) {
    const task = session?.ai?.task;
    if (editor.hasArtist?.(name)) { if (editor.removeArtist?.(name)) task?.pickedArtists?.delete(name); }
    else if (addArtist(name) && task) (task.pickedArtists ??= new Set()).add(name);
    syncArtistButtons();
  }

  function taskView(task) {
    if (isActive()) task.seen = true;
    if (task.state === 'done' && task.result) return aiResult(task.result, task);
    if (task.state === 'unconfirmed') return status('error', el('strong', '', '提交结果未确认'),
      el('p', '', task.error), el('small', '', '移除此提示不会取消服务端可能已启动的任务。'),
      pill('移除此提示', 'tagger-secondary', { aiDismiss: '' }));
    if (task.state === 'failed' || task.state === 'unavailable') return status('error', el('strong', '', task.state === 'unavailable' ? '任务暂不可恢复' : '这次反推未完成'),
      el('p', '', task.error || '请检查通道配置后重新开始。'),
      el('small', '', '编辑器内容未被改动。若服务器已重启或结果保留期已过，需要重新选择图片开始。'),
      pill('移除此任务入口', 'tagger-secondary', { aiDismiss: '' }));
    const title = el('div', 'tagger-progress-title');
    title.append(el('span', 'tagger-spinner'), el('strong', 'tagger-phase', task.state === 'starting' ? '正在提交图片' : task.connectionError ? '进度中断，正在自动重连' : task.steps?.at(-1)?.text || '等待服务器接收任务…'));
    const clock = el('span', 'tagger-elapsed', `已用时 ${duration(elapsed(task))}`);
    clock.dataset.taskElapsed = '';
    title.append(clock);
    const leave = el('p', 'tagger-leave-note', leaveText(task));
    leave.dataset.taskLeave = '';
    return status('working', title, leave, thoughts(task, true));
  }

  function leaveText(task) {
    if (task.state === 'starting') return '上传中，请稍候。';
    if (task.connectionError) return '正在重连原任务，不会重复提交。';
    return '后台处理中，可离开此页。';
  }

  // Persist identifiers only: never the source File, a data URL, route key or model output.
  // The job owns polling independently of the current page and source selection.
  function persistTasks() {
    try {
      localStorage.setItem(TASK_STORAGE, JSON.stringify(tasks.filter(task => task.id).slice(-8).map(task => ({
        id: task.id, startedAt: task.startedAt, label: task.label, imageId: task.imageId || '', mode: task.mode, effort: task.effort, applied: Boolean(task.applied)
      }))));
    } catch { /* Storage may be denied; the in-memory task remains usable. */ }
  }

  function refreshTask(task) {
    if (session?.ai?.task === task) { panel.dataset.reverseState = task.state; session.ai.node.querySelector('.tagger-task-host')?.replaceChildren(taskView(task)); renderFooter(task); }
    for (const button of panel.querySelectorAll('[data-task-index]')) {
      const item = tasks[Number(button.dataset.taskIndex)];
      if (item) button.textContent = taskTabLabel(item);
    }
  }

  function schedulePoll(task, wait = document.hidden ? 8000 : 1800) {
    clearTimeout(task.timer);
    if (!tasks.includes(task) || !task.id || !['running', 'starting'].includes(task.state)) return;
    task.timer = setTimeout(() => pollTask(task), wait);
  }

  async function pollTask(task) {
    if (task.polling || !tasks.includes(task)) return;
    task.polling = true;
    try {
      const job = await api(`/api/prompt-reverse/jobs/${encodeURIComponent(task.id)}`);
      if (!tasks.includes(task)) return;
      task.state = job.status;
      task.startedAt = Number(job.startedAt) || task.startedAt;
      task.steps = job.steps || [];
      task.connectionError = '';
      if (job.status !== 'running') {
        task.elapsedMs = job.elapsedMs ?? job.result?.durationMs ?? Date.now() - task.startedAt;
        task.result = job.result;
        task.error = job.error?.message;
        persistTasks();
        // The dock (or this page, when open) is where the outcome shows; no toast on top of it.
      }
    } catch (error) {
      if (error.status === 404 && task.restored && !RUNNING_NOW.has(task)) { forgetTask(task); return; }
      if (error.status === 404) { task.state = 'unavailable'; task.error = '服务器上已没有这次任务（可能重启过），请重新开始。'; }
      else task.connectionError = '暂时无法读取进度，正在自动重连。原任务不会重复提交。';
      if ($('#appView')?.classList.contains('hidden')) close();
    } finally {
      task.polling = false;
      refreshTask(task);
      renderDock();
      if (task.state !== 'running' && session?.ai?.task === task && isActive()) window.scrollTo({ top: 0, behavior: 'auto' });
      schedulePoll(task, task.connectionError ? 8000 : undefined);
    }
  }

  function resumeTask(task) {
    if (task.context) {
      session = task.context;
      const nodes = shell(session.imageUrl, session.label);
      session.ai.node = nodes.ai;
      if (session.items) render();
      else nodes.wd.append(el('p', 'tagger-hint', '返回任务后可直接审阅 AI 草稿。Tagger 候选仅在原始会话保留。'));
    } else {
      const imageUrl = task.imageId ? `/api/images/${encodeURIComponent(task.imageId)}/preview` : '';
      session = { token: ++token, translations: new Map(), imageUrl, label: task.label, imageId: task.imageId };
      session.ai = { node: shell(imageUrl, task.label).ai, task, mode: task.mode, effort: task.effort };
      task.context = session;
      panel.querySelector('.tagger-wd').append(el('p', 'tagger-hint', '刷新后只恢复 AI 草稿；需要重新选图才能重新获取 Tagger 候选。'));
    }
    renderAi(session);
    loadAiSettings(session);
    navigate();
    schedulePoll(task, 0);
    renderDock();
  }

  // Quietly drops a task whose result is gone from the server (expired or restarted): nothing to review,
  // nothing failed on the owner's side, so no message either.
  function forgetTask(task) {
    clearTimeout(task.timer);
    const index = tasks.indexOf(task);
    if (index >= 0) tasks.splice(index, 1);
    persistTasks();
    if (session === task.context && session?.ai?.task === task) { session = null; if (isActive()) show(); }
    else if (session?.ai?.node) renderAi(session);
    renderDock();
  }

  function dismissTask(task) {
    clearTimeout(task.timer);
    const index = tasks.indexOf(task);
    if (index >= 0) tasks.splice(index, 1);
    if (task.context?.revoke) URL.revokeObjectURL(task.context.imageUrl);
    persistTasks();
    if (session === task.context) session = null;
    show();
    renderDock();
  }

  async function runAi(current) {
    const ai = current.ai;
    if (ai.task || !ai.start) return;
    const task = { state: 'starting', startedAt: Date.now(), label: current.label, imageId: current.imageId || '', mode: ai.mode || 'quick', effort: ai.effort || 'off', context: current, steps: [] };
    tasks.push(task);
    RUNNING_NOW.add(task);
    ai.task = task;
    ai.status = null;
    renderAi(current);
    try {
      const { jobId } = await ai.start(ai.mode || 'quick', ai.effort || 'off', ai.requirement || '');
      task.id = jobId;
      task.state = 'running';
      persistTasks();
      refreshTask(task);
      schedulePoll(task, 0);
    } catch (error) {
      const rejected = error.status >= 400 && error.status < 500 && error.status !== 408;
      task.state = rejected ? 'failed' : 'unconfirmed';
      task.error = rejected ? error.message || '服务器拒绝了这次请求。' : '未能确认提交结果，服务器可能已经开始处理。请不要立即重复提交，以免重复调用。';
      refreshTask(task);
    }
  }

  function aiClick(event) {
    const current = session || settingsSession;
    if (!current?.ai) return false;
    const ai = current.ai, target = event.target;
    const preset = target.closest('[data-ai-preset]');
    if (preset) {
      const item = aiSettings?.presets[Number(preset.dataset.aiPreset)];
      if (item) { ai.mode = item.mode || 'quick'; ai.effort = item.effort; ai.requirement = item.requirement; renderAi(current); }
      return true;
    }
    const mode = target.closest('[data-ai-mode]');
    if (mode) { ai.mode = mode.dataset.aiMode; renderAi(current); if (settingsDialog.open) renderSettings(current); return true; }
    const effort = target.closest('[data-ai-effort]');
    if (effort) { ai.effort = effort.dataset.aiEffort; renderAi(current); if (settingsDialog.open) renderSettings(current); return true; }
    if (target.closest('[data-ai-run]')) { runAi(current); return true; }
    const applyButton = target.closest('[data-ai-apply]');
    if (applyButton && ai.task?.result) {
      const include = [...(ai.task.include ?? new Set(PARTS))];
      if (!include.length) return true;
      const mode = applyButton.dataset.aiApply === 'append' ? 'append' : 'replace';
      const applied = editor.applyReverse(chosenDraft(ai.task), { include, mode, keepArtists: [...(ai.task.pickedArtists || [])] });
      ai.task.appliedMode = mode;
      ai.task.flashMode = mode;
      syncArtistButtons();
      ai.task.applied = true;
      ai.task.appliedHere = true;
      ai.task.filledParts = new Set([...(ai.task.filledParts || []), ...include]);
      // The button confirms for a moment, then offers to fill again.
      ai.task.flashUntil = Date.now() + 1500;
      const task = ai.task;
      setTimeout(() => { if (task.flashUntil && Date.now() >= task.flashUntil) refreshTask(task); }, 1600);
      ai.task.appliedSummary = `${applied.tags} 个 Tag、${applied.sentences} 句描述${applied.characters ? `、${applied.characters} 个角色` : ''}`;
      persistTasks();
      refreshTask(ai.task);
      return true;
    }
    if (target.closest('[data-ai-open-editor]')) { openEditor(); return true; }
    const draftItem = target.closest('[data-draft-item]');
    if (draftItem && ai.task?.result) {
      const key = draftItem.dataset.draftItem;
      ai.task.excluded ??= new Set();
      if (ai.task.excluded.has(key)) ai.task.excluded.delete(key); else ai.task.excluded.add(key);
      draftItem.setAttribute('aria-pressed', String(!ai.task.excluded.has(key)));
      return true;
    }
    const draftPart = target.closest('[data-draft-part]');
    if (draftPart && ai.task?.result) {
      const part = draftPart.dataset.draftPart;
      ai.task.include ??= new Set(PARTS);
      if (ai.task.include.has(part)) ai.task.include.delete(part); else ai.task.include.add(part);
      refreshTask(ai.task);
      return true;
    }
    if (target.closest('[data-ai-copy]') && ai.task?.result) {
      const draft = chosenDraft(ai.task);
      const text = [
        ...[['scene', '场景'], ['camera', '镜头'], ['style', '画风与质感'], ['misc', '关系与其他']].map(([key, label]) => `${label}\n${(draft[key] || []).join(', ')}`),
        ...(draft.sentences || []).map(item => item.text),
        ...(draft.characters || []).map((item, index) => `角色 ${index + 1}\n${item.tags.join(', ')}\n${(item.sentences || []).join('\n')}`),
        ...(draft.notes ? [`审阅提示与疑点\n${draft.notes}`] : [])
      ].join('\n\n');
      navigator.clipboard.writeText(text).then(() => toast('草稿已复制。', 'success')).catch(() => toast('复制失败，浏览器未允许访问剪贴板。', 'error'));
      return true;
    }
    if (target.closest('[data-ai-dismiss]') && ai.task) { dismissTask(ai.task); return true; }

    if (target.closest('[data-ai-channel-save]')) {
      const apiKey = settingsDialog.querySelector('[data-ai-channel="apiKey"]')?.value.trim() || '';
      saveAi({ channel: { ...ai.channelDraft }, ...(apiKey ? { apiKey } : {}) }, current);
      return true;
    }
    if (target.closest('[data-ai-rule-save]')) { saveAi({ rule: ai.ruleDraft ?? aiSettings.rule }, current); return true; }
    if (target.closest('[data-ai-rule-reset]')) { saveAi({ rule: '' }, current); return true; }
    if (target.closest('[data-ai-presets-reset]')) { saveAi({ presets: null }, current); return true; }
    if (target.closest('[data-ai-preset-save]')) {
      const name = settingsDialog.querySelector('[data-ai-preset-name]')?.value.trim();
      if (!name) { ai.status = status('error', el('p', '', '先填一个预设名。')); renderAi(current); return true; }
      saveAi({ presets: [...aiSettings.presets.filter(item => item.name !== name), { name, mode: ai.mode || 'quick', effort: ai.effort || 'off', requirement: ai.requirement || '' }] }, current);
      return true;
    }
    const remove = target.closest('[data-ai-preset-delete]');
    if (remove) { saveAi({ presets: aiSettings.presets.filter((_, index) => index !== Number(remove.dataset.aiPresetDelete)) }, current); return true; }
    return false;
  }

  // What filling takes: the draft without the Tags and sentences the owner dropped.
  function chosenDraft(task) {
    const draft = task.result.result, dropped = task.excluded || new Set();
    const keep = prefix => (_, index) => !dropped.has(`${prefix}${index}`);
    const out = { ...draft };
    for (const key of ['scene', 'camera', 'style', 'misc']) out[key] = (draft[key] || []).filter(keep(`${key}:`));
    out.sentences = (draft.sentences || []).filter(keep('sent:'));
    out.characters = (draft.characters || []).map((character, index) => ({ ...character,
      tags: (character.tags || []).filter(keep(`char${index}:t:`)), sentences: (character.sentences || []).filter(keep(`char${index}:s:`)) }));
    return out;
  }

  // The dock: on every page but this one, a running or unreviewed task stays one tap away. It is the
  // only signal that a draft is ready — no toast besides it. × hides it until the task changes state.
  const dock = el('div', 'reverse-dock');
  dock.hidden = true;
  dock.setAttribute('role', 'status');
  document.body.append(dock);
  const RUNNING = ['running', 'starting'];
  // Tasks started in this page's life: a 404 for one of them is news; for a restored one it is just expiry.
  const RUNNING_NOW = new WeakSet();
  function dockTask() {
    const visible = task => task.dockHidden !== task.state;
    return tasks.find(task => task.state === 'done' && task.result && !task.applied && visible(task))
      || tasks.find(task => RUNNING.includes(task.state) && visible(task))
      || tasks.find(task => ['failed', 'unconfirmed'].includes(task.state) && !task.seen && visible(task)) || null;
  }
  function placeDock() {
    if (dock.hidden) return;
    // On the editor the generate bar sits above the navigation: the dock goes above it.
    const bar = document.body.classList.contains('editor-tab-active') ? document.querySelector('.floating-generate-bar') : null;
    const rect = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect() : null;
    dock.style.bottom = rect && rect.height && window.innerWidth < 900 ? `${Math.round(window.innerHeight - rect.top + 6)}px` : '';
  }
  function renderDock() {
    const task = isActive() ? null : dockTask();
    document.body.classList.toggle('reverse-dock-visible', Boolean(task));
    if (!task) { dock.hidden = true; dock.replaceChildren(); return; }
    const state = task.state === 'done' ? 'ready' : RUNNING.includes(task.state) ? 'running' : 'failed';
    if (dock.dataset.state !== state || dock.hidden) { dock.classList.remove('arrive'); void dock.offsetWidth; dock.classList.add('arrive'); }
    dock.dataset.state = state;
    dock.hidden = false;
    const main = pill('', 'reverse-dock-main', { dockOpen: '' });
    const thumb = el('span', 'reverse-dock-thumb');
    const source = task.context?.imageUrl || (task.imageId ? `/api/images/${encodeURIComponent(task.imageId)}/preview` : '');
    if (source) { const img = el('img'); img.alt = ''; img.src = source; thumb.append(img); }
    else thumb.append(el('i', '', '↗'));
    if (state === 'running') thumb.append(el('span', 'tagger-spinner'));
    const text = el('span', 'reverse-dock-text');
    const label = (task.label || '图片').replace(/\.[^.]+$/, '');
    text.append(el('strong', '', state === 'ready' ? '反推草稿已就绪' : state === 'running' ? `反推中 · ${duration(elapsed(task))}` : '反推没有完成'),
      el('small', '', state === 'ready' ? `点开审阅后填入 · ${label}` : state === 'running' ? `${task.steps?.at(-1)?.text || '等待模型'} · ${label}` : `点开查看原因 · ${label}`));
    main.append(thumb, text, el('span', 'reverse-dock-go', '›'));
    const hide = pill('×', 'reverse-dock-hide', { dockHide: '' });
    hide.setAttribute('aria-label', '先收起，状态变化时再出现');
    dock.replaceChildren(main, hide);
    // The page switch lays the generate bar out after this call: place again once it has settled.
    placeDock();
    requestAnimationFrame(placeDock);
  }
  dock.addEventListener('click', event => {
    const task = dockTask();
    if (!task) return renderDock();
    if (event.target.closest('[data-dock-hide]')) { task.dockHidden = task.state; return renderDock(); }
    if (event.target.closest('[data-dock-open]')) resumeTask(task);
  });
  window.addEventListener('resize', placeDock);

  function artistClick(event) {
    const look = event.target.closest('[data-artist-look]');
    if (look) { openArtistPage(look.dataset.artistLook); return true; }
    const add = event.target.closest('[data-artist-add]');
    if (add) { toggleArtist(add.dataset.artistAdd); return true; }
    return false;
  }

  function bind() {
    if (!panel) return;
    panel.addEventListener('click', event => {
      if (artistClick(event)) return;
      if (event.target.closest('[data-reverse-choose]')) return chooseFile();
      if (event.target.closest('[data-reverse-gallery]')) return openGallery();
      const settings = event.target.closest('[data-reverse-settings]');
      if (settings) return showSettings(settings.dataset.reverseSettings || 'run');
      const view = event.target.closest('[data-reverse-view]')?.dataset.reverseView;
      if (view) {
        panel.dataset.view = view;
        panel.querySelector('.tagger-ai').hidden = view !== 'draft';
        panel.querySelector('.tagger-candidates').hidden = view !== 'tags';
        panel.querySelectorAll('[data-reverse-view]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.reverseView === view)));
        renderFooter(session?.ai?.task);
        return;
      }
      if (event.target.closest('.tagger-ai, .tagger-footer') && aiClick(event)) return;
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
    const onInput = event => {
      const current = session || settingsSession;
      if (event.target.matches?.('[data-ai-ask]')) current.ai.requirement = event.target.value;
      const field = event.target.dataset?.aiChannel;
      // Unsaved credentials stay in this page's memory and are bound to their route, never localStorage.
      if (field === 'apiKey') current.ai.keyDraft = { endpointId: current.ai.channelDraft?.endpointId, customUrl: current.ai.channelDraft?.customUrl || '', value: event.target.value };
      if (field === 'customUrl') current.ai.keyDraft = undefined;
      if (field && field !== 'apiKey' && current.ai.channelDraft) current.ai.channelDraft[field] = event.target.value;
    };
    panel.addEventListener('input', onInput);
    settingsDialog.addEventListener('input', onInput);
    // Another route has other models and key: the form is drawn again for it.
    settingsDialog.addEventListener('change', event => {
      const current = session || settingsSession;
      if (event.target.dataset?.aiChannel !== 'endpointId' || !current.ai.channelDraft) return;
      Object.assign(current.ai.channelDraft, { endpointId: event.target.value, model: '' });
      current.ai.keyDraft = undefined;
      renderSettings(current);
    });
    settingsDialog.addEventListener('click', event => {
      if (event.target === settingsDialog || event.target.closest('[data-reverse-settings-close]')) return settingsDialog.close();
      const tab = event.target.closest('[data-reverse-settings-tab]')?.dataset.reverseSettingsTab;
      if (tab) return showSettings(tab);
      aiClick(event);
    });
    settingsDialog.addEventListener('close', () => {
      if (session && !session.ai.task) renderAi(session); });
    panel.addEventListener('dragover', event => event.preventDefault());
    panel.addEventListener('drop', event => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (file?.type.startsWith('image/')) open({ file });
    });
  }

  // One of: { imageId, label } for a gallery image, or { file } for an image from the device.
  function open({ imageId = '', file = null, label = '' } = {}) {
    if (!panel) return;
    if (session?.revoke && !tasks.some(task => task.context === session)) URL.revokeObjectURL(session.imageUrl);
    const imageUrl = file ? URL.createObjectURL(file) : `/api/images/${encodeURIComponent(imageId)}/preview`;
    session = { token: ++token, translations: new Map(), imageUrl, imageId, label: label || (file ? file.name : '图库图片'), revoke: Boolean(file) };
    const { ai } = shell(imageUrl, session.label);
    session.ai = { node: ai, state: 'idle', start: (mode, effort, requirement) => {
      const query = `mode=${encodeURIComponent(mode)}&effort=${encodeURIComponent(effort)}&requirement=${encodeURIComponent(requirement)}`;
      return file
        ? api(`/api/prompt-reverse?${query}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } })
        : api(`/api/prompt-reverse?imageId=${encodeURIComponent(imageId)}&${query}`, { method: 'POST' });
    } };
    renderAi(session);
    loadAiSettings(session);
    navigate();
    const request = file
      ? () => api('/api/tagger', { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } })
      : () => api(`/api/tagger?imageId=${encodeURIComponent(imageId)}`, { method: 'POST' });
    run(request, session);
  }

  function show() {
    if (session) { syncArtistButtons(); return; }
    const task = tasks.find(item => item.state === 'done' && !item.applied) || tasks.find(item => item.state === 'running') || tasks.at(-1);
    if (task) { resumeTask(task); return; }
    const header = el('header', 'tagger-head');
    header.append(el('strong', '', '图片反推'));
    if (!aiUnavailable) header.append(pill('设置', 'tagger-settings-button', { reverseSettings: '' }));
    const empty = el('div', 'reverse-empty');
    const mark = el('div', 'reverse-empty-mark'); mark.setAttribute('aria-hidden', 'true'); mark.textContent = '↗';
    empty.append(mark, el('h1', '', '从一张图开始'), el('p', '', aiUnavailable ? '从图里认出 Tag，\n挑着加进编辑器。' : '把画面里的内容与画法，\n变成一份可以慢慢修改的提示词。'),
      pill('选择图片', 'tagger-primary', { reverseChoose: '' }), pill('去图库找一张', 'reverse-empty-gallery', { reverseGallery: '' }),
      el('small', '', '支持 PNG、JPG、WebP，也可以拖入图片'));
    panel.dataset.reverseState = 'empty';
    panel.replaceChildren(header, empty);
    // Find out once whether AI 反推 is here, so the empty page says the right thing.
    if (!aiSettings && !aiUnavailable && !settingsSession.probed) { settingsSession.probed = true; loadAiSettings(settingsSession); }
  }

  bind();
  const reconnect = () => { if (!document.hidden) for (const task of tasks) schedulePoll(task, 0); };
  document.addEventListener('visibilitychange', reconnect);
  window.addEventListener('focus', reconnect);
  window.addEventListener('online', reconnect);
  try {
    const saved = JSON.parse(localStorage.getItem(TASK_STORAGE) || '[]');
    for (const item of (Array.isArray(saved) ? saved : []).slice(-8)) {
      if (!item || !/^[a-z0-9-]{1,100}$/i.test(item.id) || !Number.isFinite(item.startedAt)) continue;
      if (Date.now() - item.startedAt > 24 * 3600 * 1000) continue;
      const task = { id: item.id, startedAt: item.startedAt, imageId: String(item.imageId || '').slice(0, 150), label: String(item.label || '图片').slice(0, 180), mode: item.mode === 'agent' ? 'agent' : 'quick', effort: EFFORTS.some(([value]) => value === item.effort) ? item.effort : 'off', applied: Boolean(item.applied), state: 'running', steps: [], restored: true };
      tasks.push(task);
      schedulePoll(task, 0);
    }
  } catch { /* Ignore a broken local bookmark; do not start any paid request. */ }
  setInterval(() => {
    const task = session?.ai?.task;
    if (isActive() && task && ['running', 'starting'].includes(task.state)) {
      const clock = panel.querySelector('[data-task-elapsed]');
      if (clock) clock.textContent = `已用时 ${duration(elapsed(task))}`;
      const leave = panel.querySelector('[data-task-leave]');
      if (leave) leave.textContent = leaveText(task);
    }
    if (!dock.hidden && dock.dataset.state === 'running') renderDock();
    const meta = isActive() && task ? panel.querySelector('[data-thought-meta]') : null;
    if (meta) meta.textContent = `${task.steps?.length || 0} 步 · ${duration(elapsed(task))}`;
  }, 1000);
  // The app calls this on every page change, so the dock appears and leaves with the page.
  return { open, close, show, syncDock: renderDock };
}
