// 法典 (QuickTagCloud codexes): a read-only reference panel. Browse a codex by
// category or search, open an entry, then copy it or use it in the editor.
// Data comes through /api/codex (server-side cache); images load straight
// from QuickTagCloud's image hosts (allowed in CSP img-src).
//
// The panel never reads or writes the editor state itself. Everything it does
// to the editor goes through the `editor` operations app.js provides, which
// own rendering and undo grouping; `tags` supplies the editor's Tag parsing,
// presence key and formatting so chips match what the editor would make.


const CODEX_NSFW_KEY = 'nai-pocket-codex-nsfw';
const CODEX_LAST_KEY = 'nai-pocket-codex-last';
const CODEX_PAGE = 40;
const CODEX_TYPES = { codex: '法典', string: '画师串', composition: '构图', pack: '图包' };
const CODEX_SAMPLER_LABELS = Object.freeze({ k_euler_ancestral: 'Euler A', k_euler: 'Euler', k_dpmpp_2s_ancestral: 'DPM++ 2S A', k_dpmpp_2m_sde: 'DPM++ 2M SDE', k_dpmpp_2m: 'DPM++ 2M', k_dpmpp_sde: 'DPM++ SDE' });

const $ = selector => document.querySelector(selector);
function readStore(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeStore(key, value) { try { localStorage.setItem(key, value); } catch {} }

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const genericCharacterLabel = label => !label || /^(char(acter)?|角色)\s*\d*$/i.test(label);
const isCharacterBlock = key => /^c\d+$/.test(key);
const selectedCodexTags = block => block.tags.filter(item => item.selected).map(item => item.tag);

/**
 * @param {object} deps
 * @param {Function} deps.api       app api(url, options)
 * @param {Function} deps.toast     app toast(message, type)
 * @param {Function} deps.isActive  true while the 法典 tab is shown
 * @param {object} deps.tags        { parse(raw) → Tags, key(tag) → presence key, format(tag) → prompt text, formatWeight(n), hasCjk(text) }
 * @param {object} deps.editor      see codexEditor in app.js
 */
// `storage` lets a host keep the panel's preferences per signed-in user (relay);
// it defaults to this device's localStorage.
export function createCodexPanel({ api, toast, isActive, tags: tagTools, editor, storage = { get: readStore, set: writeStore } }) {
  const codexTags = tagTools.parse;
  const codexTagKey = tagTools.key;
  // `base`: the position of entries[0] in the section — non-zero after a jump with the rail.
  const codexState = { site: '', list: null, id: '', meta: null, path: [], q: '', tree: [], entries: [], base: 0, total: 0, token: 0, loading: false, nsfw: false };
  // Copying Tags from an entry: each prompt block is shown as chips. Tags that
  // are already in the prompt are marked 「已有」 and start deselected; a tap
  // toggles a chip, and the block's action appends only the selected ones.
  let codexDetail = null; // { index, blocks: [{ key, label, name, raw, tags: [{ tag, present, selected }], ucTags }] }

  // The 法典 tab loads its index the first time it is shown.
  async function ensureCodexLoaded() {
    stickCodexHeader();
    if (codexState.list || codexState.opening) return;
    codexState.opening = true;
    const grid = $('#codexGrid');
    grid.replaceChildren(el('p', 'codex-empty', '正在读取法典目录…'));
    try {
      const { site, codexes } = await api('/api/codex');
      codexState.site = site;
      codexState.list = codexes;
    } catch (error) {
      grid.replaceChildren(el('p', 'codex-empty', `法典目录读取失败：${error.message}`));
      return;
    } finally {
      codexState.opening = false;
    }
    codexState.nsfw = storage.get(CODEX_NSFW_KEY) === '1';
    $('#codexNsfw').checked = codexState.nsfw;
    const last = storage.get(CODEX_LAST_KEY);
    const visible = codexBooks();
    // First visit opens the first real 法典 rather than an artist-string list.
    codexState.id = visible.some(item => item.id === last) ? last : (visible.find(item => item.type === 'codex') || visible[0])?.id || '';
    renderCodexBooks();
    await loadCodexPage(true);
  }

  // The book / search / category block sticks right under the page header.
  function stickCodexHeader() {
    const header = document.querySelector('.workspace-topbar');
    const offset = header && getComputedStyle(header).position === 'sticky' ? header.getBoundingClientRect().height : 0;
    $('#codexTab')?.style.setProperty('--codex-sticky-top', `${Math.round(offset)}px`);
  }

  // Category / book / search changes start from the top of the tab.
  function scrollCodexTop() {
    if (isActive() && window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'auto' });
  }

  const codexBooks = () => (codexState.list || []).filter(item => codexState.nsfw || !item.nsfw);

  // One source line (kind · title · count ⌄); the full list opens under it,
  // grouped by kind, so long titles stay readable instead of a sideways strip.
  function renderCodexBooks() {
    const visible = codexBooks();
    const current = visible.find(item => item.id === codexState.id);
    const label = $('#codexSourceLabel');
    label.replaceChildren();
    if (current) {
      label.append(el('i', 'codex-kind', CODEX_TYPES[current.type] || '法典'), el('b', '', current.selectorTitle || current.title || current.id));
      if (current.entryCount) label.append(el('small', '', String(current.entryCount)));
    } else label.append(el('b', '', '选择来源'));
    const book = item => {
      const button = el('button', 'codex-book');
      button.type = 'button';
      button.dataset.codexBook = item.id;
      button.setAttribute('aria-pressed', String(item.id === codexState.id));
      button.append(el('b', '', item.selectorTitle || item.title || item.id));
      if (item.nsfw) button.append(el('i', 'codex-r18', 'R18'));
      if (item.entryCount) button.append(el('small', '', String(item.entryCount)));
      return button;
    };
    const kindOf = item => item.type || 'codex';
    const order = [...new Set([...Object.keys(CODEX_TYPES), ...visible.map(kindOf)])];
    $('#codexBooks').replaceChildren(...order.flatMap(type => {
      const items = visible.filter(item => kindOf(item) === type);
      if (!items.length) return [];
      return [el('p', 'codex-source-group', CODEX_TYPES[type] || type), ...items.map(book)];
    }));
  }

  function toggleCodexSources(open = $('#codexSourcePanel').hidden) {
    $('#codexSourcePanel').hidden = !open;
    $('#codexSourceButton').setAttribute('aria-expanded', String(open));
    if (open) $('#codexBooks [aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  // reset: start the section at `start` (0 = the top; the rail jumps elsewhere). Otherwise the next page.
  async function loadCodexPage(reset, start = 0) {
    if (!codexState.id) {
      $('#codexGrid').replaceChildren(el('p', 'codex-empty', '没有可显示的法典。'));
      return;
    }
    if (codexState.loading && !reset) return;
    const token = ++codexState.token;
    codexState.loading = true;
    const loaded = codexState.entries.length;
    const offset = reset ? start : codexState.base + loaded;
    if (reset) { $('#codexGrid').replaceChildren(el('p', 'codex-empty', start ? `正在跳到第 ${start + 1} 条…` : '正在载入…首次打开一部法典需要几秒。')); scrollCodexTop(); }
    $('#codexMore').hidden = true;
    const params = new URLSearchParams({ path: codexState.path.join('/'), q: codexState.q, offset: String(offset), limit: String(CODEX_PAGE) });
    try {
      const page = await api(`/api/codex/${encodeURIComponent(codexState.id)}?${params}`);
      if (token !== codexState.token) return;
      codexState.meta = page.meta;
      codexState.tree = page.tree;
      codexState.total = page.total;
      if (reset) codexState.base = offset;
      codexState.entries = reset ? page.entries : codexState.entries.concat(page.entries);
      renderCodexPath();
      renderCodexGrid(reset ? 0 : loaded);
      renderCodexCredit();
    } catch (error) {
      if (token === codexState.token) $('#codexGrid').replaceChildren(el('p', 'codex-empty', `读取失败：${error.message}`));
    } finally {
      if (token === codexState.token) { codexState.loading = false; syncCodexRail(); }
    }
  }

  // 载入前面: the page before entries[0]. The grid is laid out again and the card that was first stays
  // where it was on screen.
  async function loadCodexBefore() {
    if (!codexState.base || codexState.loading) return;
    const token = ++codexState.token;
    codexState.loading = true;
    const offset = Math.max(0, codexState.base - CODEX_PAGE), count = codexState.base - offset;
    const params = new URLSearchParams({ path: codexState.path.join('/'), q: codexState.q, offset: String(offset), limit: String(count) });
    try {
      const page = await api(`/api/codex/${encodeURIComponent(codexState.id)}?${params}`);
      if (token !== codexState.token) return;
      const anchor = $('#codexGrid .codex-card[data-codex-index="0"]'), before = anchor?.getBoundingClientRect().top ?? 0;
      codexState.base = offset;
      codexState.entries = page.entries.slice(0, count).concat(codexState.entries);
      renderCodexGrid(0);
      const moved = $(`#codexGrid .codex-card[data-codex-index="${Math.min(count, page.entries.length)}"]`);
      if (moved) window.scrollBy({ top: moved.getBoundingClientRect().top - before, behavior: 'auto' });
    } catch (error) {
      if (token === codexState.token) toast(`读取失败：${error.message}`, 'error');
    } finally {
      if (token === codexState.token) { codexState.loading = false; syncCodexRail(); }
    }
  }

  // The rail: a thin track on the right edge. The handle sits at the first card on screen; dragging
  // shows 第 N 条 and jumps there on release (within what is loaded it only scrolls).
  let rail = null, railDrag = null, railFrame = 0;
  // Below the sticky book / search block, which covers the cards scrolling under it.
  const visibleTop = () => Math.max(0, $('#codexTab .codex-top')?.getBoundingClientRect().bottom || 0) + 8;
  function firstVisibleIndex() {
    const line = visibleTop();
    // Columns are filled one card at a time, so the earliest card still on screen is the smallest index.
    let first = Infinity;
    for (const card of $('#codexGrid').querySelectorAll('.codex-card')) if (card.getBoundingClientRect().bottom > line) first = Math.min(first, Number(card.dataset.codexIndex));
    return Number.isFinite(first) ? first : 0;
  }
  function railPosition(fraction, label) {
    const track = rail.querySelector('.codex-rail-track'), thumb = rail.querySelector('.codex-rail-thumb');
    const room = Math.max(0, track.clientHeight - thumb.offsetHeight);
    const offset = `translateY(${Math.round(Math.min(1, Math.max(0, fraction)) * room)}px)`;
    thumb.style.transform = offset;
    const tag = rail.querySelector('.codex-rail-label');
    tag.textContent = label;
    tag.style.transform = offset;
  }
  function syncCodexRail() {
    if (!rail) return;
    const show = isActive() && codexState.total > CODEX_PAGE * 2 && codexState.entries.length > 0;
    rail.hidden = !show;
    $('#codexTab').classList.toggle('has-rail', show);
    const before = $('#codexBefore');
    if (before) {
      before.hidden = !codexState.base;
      before.textContent = `↑ 载入前面（还有 ${codexState.base} 条）`;
    }
    if (!show || railDrag) return;
    rail.style.top = `${Math.round(visibleTop())}px`;
    const position = codexState.base + firstVisibleIndex();
    railPosition(position / Math.max(1, codexState.total - 1), `${(position + 1).toLocaleString()} / ${codexState.total.toLocaleString()}`);
  }
  function railTarget(event) {
    const box = rail.querySelector('.codex-rail-track').getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientY - box.top) / Math.max(1, box.height)));
    return { fraction, index: Math.min(codexState.total - 1, Math.floor(fraction * codexState.total)) };
  }
  function bindCodexRail() {
    rail = el('div', 'codex-rail');
    rail.hidden = true;
    rail.setAttribute('role', 'slider');
    rail.setAttribute('aria-label', '在这一栏里跳到某个位置');
    const track = el('div', 'codex-rail-track');
    track.append(el('div', 'codex-rail-thumb'));
    rail.append(track, el('span', 'codex-rail-label'));
    $('#codexTab').append(rail);
    const before = el('button', 'codex-before');
    before.type = 'button';
    before.id = 'codexBefore';
    before.hidden = true;
    before.addEventListener('click', loadCodexBefore);
    $('#codexGrid').before(before);
    rail.addEventListener('pointerdown', event => {
      event.preventDefault();
      rail.setPointerCapture(event.pointerId);
      railDrag = railTarget(event);
      rail.classList.add('dragging');
      railPosition(railDrag.fraction, `第 ${(railDrag.index + 1).toLocaleString()} 条`);
    });
    rail.addEventListener('pointermove', event => {
      if (!railDrag) return;
      railDrag = railTarget(event);
      railPosition(railDrag.fraction, `第 ${(railDrag.index + 1).toLocaleString()} 条`);
    });
    const finish = event => {
      if (!railDrag) return;
      const { index } = railTarget(event);
      railDrag = null;
      rail.classList.remove('dragging');
      const local = index - codexState.base;
      const loadedCard = local >= 0 && local < codexState.entries.length ? $(`#codexGrid .codex-card[data-codex-index="${local}"]`) : null;
      if (loadedCard) {
        window.scrollBy({ top: loadedCard.getBoundingClientRect().top - visibleTop(), behavior: 'auto' });
        syncCodexRail();
      } else loadCodexPage(true, Math.floor(index / CODEX_PAGE) * CODEX_PAGE);
    };
    rail.addEventListener('pointerup', finish);
    rail.addEventListener('pointercancel', () => { railDrag = null; rail.classList.remove('dragging'); syncCodexRail(); });
    // The position shows while dragging and for a moment after scrolling.
    let scrollingTimer = 0;
    window.addEventListener('scroll', () => {
      if (rail.hidden) return;
      rail.classList.add('scrolling');
      clearTimeout(scrollingTimer);
      scrollingTimer = setTimeout(() => rail.classList.remove('scrolling'), 1200);
      if (railFrame) return;
      railFrame = requestAnimationFrame(() => { railFrame = 0; syncCodexRail(); });
    }, { passive: true });
  }

  function codexTreeChildren() {
    let nodes = codexState.tree;
    for (const name of codexState.path) nodes = nodes.find(node => node.name === name)?.children || [];
    return nodes;
  }

  function renderCodexPath() {
    const crumbs = [['全部', 0], ...codexState.path.map((name, index) => [name, index + 1])];
    const trail = el('div', 'codex-trail');
    crumbs.forEach(([name, depth], index) => {
      const button = el('button', 'codex-crumb', name);
      button.type = 'button';
      button.dataset.codexDepth = String(depth);
      if (index === crumbs.length - 1) button.setAttribute('aria-current', 'true');
      trail.append(button);
    });
    trail.append(el('span', 'codex-total', `${codexState.total} 条`));
    const children = el('div', 'codex-cats');
    for (const node of codexTreeChildren()) {
      const button = el('button', 'codex-cat');
      button.type = 'button';
      button.dataset.codexCat = node.name;
      button.append(document.createTextNode(node.name));
      if (node.count) button.append(el('small', '', String(node.count)));
      children.append(button);
    }
    $('#codexPath').replaceChildren(trail, ...(children.childElementCount ? [children] : []));
  }

  function codexImage(entry, className) {
    const img = el('img', className);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    if (entry.width && entry.height) img.style.aspectRatio = `${entry.width} / ${entry.height}`;
    img.addEventListener('error', () => img.classList.add('broken'), { once: true });
    img.src = entry.image;
    return img;
  }

  // Masonry with fixed columns: each card goes into the shortest column and never moves.
  // CSS `columns` re-balanced every card whenever a page was appended, so cards already
  // seen jumped to the other column or further down, and the reading order ran down the
  // left column first.
  const wideGrid = window.matchMedia('(min-width: 900px)');
  const columnCount = () => (wideGrid.matches ? 4 : 2);
  let gridColumns = [];
  let columnHeights = [];

  function resetGridColumns(grid) {
    gridColumns = Array.from({ length: columnCount() }, () => el('div', 'codex-col'));
    columnHeights = gridColumns.map(() => 0);
    grid.replaceChildren(...gridColumns);
  }

  function placeCard(card, entry) {
    let target = 0;
    for (let i = 1; i < columnHeights.length; i += 1) if (columnHeights[i] < columnHeights[target] - 1) target = i;
    gridColumns[target].append(card);
    let height = card.offsetHeight;
    // An image without known dimensions has no height until it loads; count it as 4:3.
    if (entry.image && !(entry.width && entry.height)) height += Math.max(0, gridColumns[target].clientWidth * 1.33 - 80);
    columnHeights[target] += height;
  }

  // Crossing the wide breakpoint changes the column count: lay the loaded cards out again,
  // in their order.
  wideGrid.addEventListener?.('change', () => {
    const grid = $('#codexGrid');
    if (!grid || !gridColumns.length || !grid.contains(gridColumns[0])) return;
    const cards = [...grid.querySelectorAll('.codex-card')].sort((a, b) => Number(a.dataset.codexIndex) - Number(b.dataset.codexIndex));
    resetGridColumns(grid);
    cards.forEach(card => placeCard(card, codexState.entries[Number(card.dataset.codexIndex)] || {}));
  });

  function renderCodexGrid(from) {
    const grid = $('#codexGrid');
    if (!from || !gridColumns.length || !grid.contains(gridColumns[0])) resetGridColumns(grid);
    if (!codexState.entries.length) grid.replaceChildren(el('p', 'codex-empty', codexState.q ? '没有匹配的条目。' : '这一类下没有条目。'));
    codexState.entries.slice(from).forEach((entry, offset) => {
      const index = from + offset;
      const card = el('div', `codex-card${entry.image ? '' : ' text-only'}`);
      card.dataset.codexIndex = String(index);
      const open = el('button', 'codex-open');
      open.type = 'button';
      open.dataset.codexEntry = String(index);
      if (entry.image) open.append(codexImage(entry, 'codex-thumb'));
      open.append(el('b', '', entry.title || '未命名'));
      if (!entry.image) open.append(el('small', '', entry.prompt.slice(0, 160)));
      if (entry.characters.length) open.append(el('i', 'codex-chars', `${entry.characters.length} 角色`));
      card.append(open);
      // Quick ＋ opens two choices: 追加 (skip Tags already present) or 替换
      // (the whole entry: global Tags and characters).
      if (entry.prompt) {
        const quick = el('button', 'codex-quick', '＋');
        quick.type = 'button';
        quick.dataset.codexQuick = String(index);
        quick.setAttribute('aria-label', `使用「${entry.title || '未命名'}」的主提示词`);
        const menu = el('div', 'codex-quick-menu');
        const add = el('button', '', '追加');
        add.type = 'button';
        add.dataset.codexQuickAdd = String(index);
        const replace = el('button', '', '替换');
        replace.type = 'button';
        replace.dataset.codexQuickReplace = String(index);
        menu.append(add, replace);
        card.append(quick, menu);
      }
      placeCard(card, entry);
    });
    $('#codexMore').hidden = codexState.base + codexState.entries.length >= codexState.total;
  }

  function renderCodexCredit() {
    const meta = codexState.meta;
    const credit = $('#codexCredit');
    if (!meta) return credit.replaceChildren();
    const parts = [meta.title || meta.id];
    if (meta.version) parts.push(meta.version);
    if (meta.author) parts.push(`作者 ${meta.author}`);
    const helpers = meta.contributors.map(item => item.name).join('、');
    if (helpers) parts.push(`贡献 ${helpers}`);
    const link = el('a', '', 'QuickTagCloud');
    link.href = codexState.site;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    credit.replaceChildren(document.createTextNode(`${parts.join(' · ')} · 来源 `), link);
  }

  function codexBlock(key, label, name, raw, present, negative = '') {
    const tags = codexTags(raw).map(tag => {
      const has = (key === 'main' || key === 'neg') && present.has(codexTagKey(tag));
      return { tag, present: has, selected: !has };
    });
    return { key, label, name, raw, tags, ucTags: negative ? codexTags(negative) : [] };
  }

  // An entry character counts as already added when one editor character has
  // every one of its Tags (weights and extra Tags aside).
  function matchingCharacterIndex(tags) {
    const keys = tags.map(codexTagKey);
    if (!keys.length) return -1;
    return editor.characterTagKeys().findIndex(own => keys.every(key => own.has(key)));
  }

  const codexCharacterInput = character => ({
    name: genericCharacterLabel(character.label) ? '' : character.label,
    tags: codexTags(character.prompt),
    ucTags: character.negative ? codexTags(character.negative) : []
  });

  function openCodexDetail(index) {
    const entry = codexState.entries[index];
    if (!entry) return;
    const present = editor.globalTagKeys();
    codexDetail = { index, translations: new Map(), blocks: [
      ...(entry.prompt ? [codexBlock('main', '主提示词', '', entry.prompt, present)] : []),
      ...entry.characters.map((character, n) => codexBlock(`c${n}`, genericCharacterLabel(character.label) ? `角色 ${n + 1}` : character.label,
        genericCharacterLabel(character.label) ? '' : character.label, character.prompt, present, character.negative)),
      ...(entry.negative ? [codexBlock('neg', '负面提示词', '', entry.negative, editor.negativeTagKeys())] : [])
    ] };
    const detail = $('#codexDetail');
    const head = el('div', 'codex-detail-head');
    const back = el('button', 'command-icon-button', '‹');
    back.type = 'button';
    back.dataset.codexBack = '';
    back.setAttribute('aria-label', '返回列表');
    head.append(back, el('strong', '', entry.title || '未命名'));
    const body = el('div', 'codex-detail-body');
    const media = el('div', 'cx-media');
    if (entry.image) media.append(codexImage(entry, 'codex-detail-image'));
    if (entry.path.length) media.append(el('p', 'codex-detail-path', entry.path.join(' › ')));
    const content = el('div', 'cx-content');
    body.append(media, content);
    detail.replaceChildren(head, body);
    detail.hidden = false;
    document.body.classList.add('codex-detail-open');
    body.scrollTop = 0;
    renderCodexBlocks();
    loadCodexTranslations().catch(() => {});
  }

  function codexChip(item, blockKey, n) {
    const { tag } = item;
    const chip = el('button', 'cx-tag');
    chip.type = 'button';
    chip.dataset.cxBlock = blockKey;
    chip.dataset.cxTag = String(n);
    chip.setAttribute('aria-pressed', String(item.selected));
    if (item.present) chip.classList.add('present');
    if (tag.bundle) chip.classList.add('bundle');
    const weight = Number(tag.weight);
    if (weight < 0) chip.classList.add('negative-weight');
    else if (weight > 1) chip.classList.add('weight-up');
    else if (weight < 1) chip.classList.add('weight-down');
    const line = el('span', 'cx-line');
    line.append(el('b', '', tag.text));
    if (weight !== 1) line.append(el('em', '', `×${tagTools.formatWeight(weight)}`));
    if (item.present) line.append(el('i', 'cx-present', '✓ 已有'));
    chip.append(line);
    const translation = codexDetail.translations.get(tag.text.toLowerCase());
    if (translation && translation.toLowerCase() !== tag.text.toLowerCase()) chip.append(el('small', '', translation));
    return chip;
  }

  function codexParamsSection(params) {
    const section = el('section', 'cx-block cx-params');
    const head = el('div', 'cx-head');
    head.append(el('span', 'cx-label', '生成参数'));
    const model = /nai5/.test(codexState.id) ? 'V5' : /nai45/.test(codexState.id) ? 'V4.5' : '';
    if (model) head.append(el('small', 'cx-count', `原图 ${model}（按来源推测）`));
    const apply = el('button', 'cx-link cx-params-apply', '套用参数');
    apply.type = 'button';
    apply.dataset.cxParams = '';
    head.append(apply);
    const row = el('div', 'cx-param-row');
    const item = (label, value) => { const node = el('span', 'cx-param'); node.append(el('small', '', label), el('b', '', String(value))); row.append(node); };
    if (params.seed !== undefined) item('Seed', params.seed);
    if (params.steps) item('步数', params.steps);
    if (params.scale !== undefined) item('CFG', params.scale);
    if (params.cfgRescale !== undefined) item('Rescale', params.cfgRescale);
    if (params.sampler) item('采样', CODEX_SAMPLER_LABELS[params.sampler] || params.sampler);
    if (params.width) item('尺寸', `${params.width}×${params.height}`);
    if (params.noiseSchedule) item('噪声', params.noiseSchedule);
    section.append(head, row);
    return section;
  }

  function renderCodexBlocks() {
    const root = $('#codexDetail .cx-content');
    if (!root || !codexDetail) return;
    // Re-rendering must not move the page (the tapped button is replaced too).
    const scroller = root.closest('.codex-detail-body');
    const scrollTop = scroller?.scrollTop || 0;
    const focused = document.activeElement?.closest?.('#codexDetail [data-cx-apply], #codexDetail [data-cx-reproduce], #codexDetail [data-cx-replace], #codexDetail [data-cx-apply-all]');
    const focusKey = focused ? ['cxApply', 'cxReproduce', 'cxReplace', 'cxApplyAll'].find(key => key in focused.dataset) : '';
    const focusValue = focusKey ? focused.dataset[focusKey] : '';
    // Presence is live: undo or edits elsewhere flip chips back, re-selected.
    for (const [key, present] of [['main', editor.globalTagKeys()], ['neg', editor.negativeTagKeys()]]) {
      for (const item of codexDetail.blocks.find(block => block.key === key)?.tags || []) {
        const has = present.has(codexTagKey(item.tag));
        if (item.present !== has) item.selected = !has;
        item.present = has;
      }
    }
    const sections = codexDetail.blocks.map(block => {
      const selected = block.tags.filter(item => item.selected).length;
      const section = el('section', 'cx-block');
      section.dataset.cxBlock = block.key;
      const head = el('div', 'cx-head');
      head.append(el('span', 'cx-label', block.label), el('small', 'cx-count', `${selected} / ${block.tags.length}`));
      const toggle = el('button', 'cx-link', selected === block.tags.length ? '全不选' : '全选');
      toggle.type = 'button';
      toggle.dataset.cxToggleAll = block.key;
      const copy = el('button', 'cx-link', '复制所选');
      copy.type = 'button';
      copy.dataset.cxCopy = block.key;
      head.append(toggle, copy);
      const tags = el('div', 'cx-tags');
      block.tags.forEach((item, n) => tags.append(codexChip(item, block.key, n)));
      const added = isCharacterBlock(block.key) ? matchingCharacterIndex(block.tags.map(item => item.tag)) : -1;
      if (added >= 0) section.classList.add('added');
      const apply = el('button', 'cx-apply', block.key === 'main' ? `追加 ${selected} 个到 Tag` : block.key === 'neg' ? `追加 ${selected} 个到负面`
        : added >= 0 ? `✓ 已是角色 ${added + 1}` : `新建角色 · ${selected} 个 Tag${block.ucTags.length ? `（含负面 ${block.ucTags.length}）` : ''}`);
      apply.type = 'button';
      apply.dataset.cxApply = block.key;
      apply.disabled = !selected || added >= 0;
      if (block.key === 'main' || block.key === 'neg') {
        const actions = el('div', 'cx-actions');
        const replace = el('button', 'cx-replace', block.key === 'neg' ? '替换负面' : '替换现有');
        replace.type = 'button';
        replace.dataset.cxReplace = block.key;
        replace.title = block.key === 'neg' ? '用所选替换当前的负面提示词（可撤销）' : '清空当前的全局 Tag 再放入所选（角色不变，可撤销）';
        replace.disabled = !block.tags.length;
        actions.append(apply, replace);
        section.append(head, tags, actions);
      } else section.append(head, tags, apply);
      return section;
    });
    const characters = codexDetail.blocks.filter(block => isCharacterBlock(block.key) && matchingCharacterIndex(block.tags.map(item => item.tag)) < 0).length;
    const params = codexState.entries[codexDetail.index]?.params;
    if (params) sections.unshift(codexParamsSection(params));
    if (characters > 1 || (characters && codexDetail.blocks[0]?.key === 'main')) {
      const all = el('button', 'codex-apply-all', `全部追加：主提示词 + ${characters} 个角色`);
      all.type = 'button';
      all.dataset.cxApplyAll = '';
      sections.push(all);
    }
    const entry = codexState.entries[codexDetail.index];
    const replaced = editor.characterCount();
    const reproduce = el('button', 'cx-reproduce', '一键复现：提示词、负面、参数和角色');
    reproduce.type = 'button';
    reproduce.dataset.cxReproduce = '';
    const hint = el('small', 'cx-reproduce-hint', `${replaced ? `当前 ${replaced} 个角色会换成这张图的 ${entry?.characters.length || 0} 个；` : ''}全局 Tag 与负面会被替换，可撤销。`);
    sections.push(reproduce, hint);
    root.replaceChildren(...sections);
    if (scroller) scroller.scrollTop = scrollTop;
    if (focusKey) root.querySelector(`[data-${focusKey.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${CSS.escape(focusValue)}"]`)?.focus({ preventScroll: true });
  }

  // Chinese lines for the chips, from this server's cache only (no points).
  async function loadCodexTranslations() {
    const detail = codexDetail;
    const texts = [...new Set(detail.blocks.flatMap(block => block.tags.map(item => item.tag))
      .filter(tag => !tag.bundle && !/^artist:/i.test(tag.text) && !tagTools.hasCjk(tag.text)).map(tag => tag.text))].slice(0, 100);
    if (!texts.length) return;
    const results = await api('/api/translations/batch', { method: 'POST', body: { items: texts, source: 'en', target: 'zh-CN', remote: false } });
    if (detail !== codexDetail) return;
    for (const item of results) if (item?.text && item.sourceText) detail.translations.set(String(item.sourceText).toLowerCase(), item.text);
    renderCodexBlocks();
  }

  function closeCodexDetail() {
    const detail = $('#codexDetail');
    if (detail) { detail.hidden = true; detail.replaceChildren(); }
    codexDetail = null;
    document.body.classList.remove('codex-detail-open');
  }

  function characterToast({ created, skipped, limit }) {
    if (skipped) toast(`已新建 ${created} 个角色；当前模型最多 ${limit} 个，另有 ${skipped} 个未加入。`, created ? 'success' : 'error');
    else toast(`已新建 ${created} 个角色。`, 'success');
  }

  function applyCodexBlock(key) {
    const block = codexDetail?.blocks.find(item => item.key === key);
    if (!block) return;
    const chosen = selectedCodexTags(block);
    if (!chosen.length) return toast('没有选中的 Tag。');
    if (key === 'neg') {
      const count = editor.addNegative(chosen, { replace: false });
      renderCodexBlocks();
      return toast(count ? `已追加 ${count} 个负面 Tag。` : '这些负面 Tag 都已存在。', count ? 'success' : '');
    }
    if (key === 'main') {
      const count = editor.appendTags(chosen);
      // After appending, chips that are now in the prompt flip to 「已有」.
      renderCodexBlocks();
      return toast(count ? `已追加 ${count} 个 Tag 到对应分区。` : '这些 Tag 都已存在。', count ? 'success' : '');
    }
    if (matchingCharacterIndex(block.tags.map(item => item.tag)) >= 0) return toast('这个角色已经在编辑区里了。');
    characterToast(editor.addCharacters([{ name: block.name, tags: chosen, ucTags: block.ucTags }]));
    renderCodexBlocks();
  }

  function applyCodexAll() {
    if (!codexDetail) return;
    const main = codexDetail.blocks.find(block => block.key === 'main');
    const count = main ? editor.appendTags(selectedCodexTags(main)) : 0;
    const characters = codexDetail.blocks.filter(block => isCharacterBlock(block.key) && block.tags.some(item => item.selected)
      && matchingCharacterIndex(block.tags.map(item => item.tag)) < 0)
      .map(block => ({ name: block.name, tags: selectedCodexTags(block), ucTags: block.ucTags }));
    const result = editor.addCharacters(characters);
    renderCodexBlocks();
    if (result.skipped) characterToast(result);
    else toast(`已追加 ${count} 个 Tag、${result.created} 个角色。`, 'success');
  }

  function quickAppendCodex(index, { replace = false, card = null } = {}) {
    const entry = codexState.entries[Number(index)];
    if (!entry?.prompt) return;
    const tags = codexTags(entry.prompt);
    let count, note = '', roles = '';
    if (replace) {
      const result = editor.replaceWithEntry({ tags, characters: entry.characters.map(codexCharacterInput) });
      count = result.count;
      if (entry.characters.length) roles = `、${result.created} 个角色`;
      else if (result.hadCharacters) roles = '，原有角色已移除';
    } else {
      const present = editor.globalTagKeys();
      const fresh = tags.filter(tag => !present.has(codexTagKey(tag)));
      count = fresh.length ? editor.appendTags(fresh) : 0;
      const skipped = tags.length - fresh.length;
      note = skipped ? `（${skipped} 个已有）` : '';
    }
    const quick = card?.querySelector('.codex-quick');
    if (quick) {
      quick.textContent = '✓';
      quick.classList.add('done');
      setTimeout(() => { quick.textContent = '＋'; quick.classList.remove('done'); }, 1600);
    }
    card?.classList.remove('quick-open');
    if (replace) return toast(`已替换为 ${count} 个 Tag${roles}，可撤销。`, 'success');
    if (entry.characters.length) roles = '；角色请在详情里添加';
    toast(count ? `已追加 ${count} 个 Tag${note}${roles}。` : `这些 Tag 都已存在${roles}。`, count ? 'success' : '');
  }

  // 一键复现: global Tags, negative, characters and parameters from the entry,
  // as one undo step (parameters are form fields, outside Tag history).
  function reproduceCodexEntry() {
    const entry = codexState.entries[codexDetail.index];
    if (!entry) return;
    const result = editor.replaceWithEntry({
      tags: codexTags(entry.prompt),
      negative: entry.negative ? codexTags(entry.negative) : null,
      characters: entry.characters.map(codexCharacterInput)
    });
    editor.applyParams(entry.params);
    renderCodexBlocks();
    toast(`已复现：${result.count} 个 Tag${entry.characters.length ? `、${result.created} 个角色` : ''}${entry.negative ? '、负面提示词' : ''}${entry.params ? '、参数（Seed 已固定）' : ''}。可撤销。`, 'success');
  }

  function bindCodex() {
    const panel = $('#codexTab');
    if (!panel) return;
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !$('#codexSourcePanel').hidden) return toggleCodexSources(false);
      if (event.key === 'Escape' && !$('#codexDetail').hidden) closeCodexDetail();
    });
    document.addEventListener('pointerdown', event => {
      if (!$('#codexSourcePanel').hidden && !event.target.closest('#codexSourcePanel, #codexSourceButton')) toggleCodexSources(false);
    });
    bindCodexRail();
    // Load more as the end of the list comes into view.
    const more = $('#codexMore');
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting) && !more.hidden && isActive()) loadCodexPage(false);
      }, { rootMargin: '600px 0px' }).observe(more);
    }
    $('#codexNsfw').addEventListener('change', event => {
      codexState.nsfw = event.target.checked;
      storage.set(CODEX_NSFW_KEY, codexState.nsfw ? '1' : '0');
      const visible = codexBooks();
      const keep = visible.some(item => item.id === codexState.id);
      if (!keep) { codexState.id = visible[0]?.id || ''; codexState.path = []; }
      renderCodexBooks();
      if (!keep) loadCodexPage(true);
    });
    let searchTimer = 0;
    $('#codexSearch').addEventListener('input', event => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { codexState.q = event.target.value.trim(); loadCodexPage(true); }, 280);
    });
    $('#codexMore').addEventListener('click', () => loadCodexPage(false));
    panel.addEventListener('click', async event => {
      const book = event.target.closest('[data-codex-book]');
      if (event.target.closest('#codexSourceButton')) return toggleCodexSources();
      if (book) {
        toggleCodexSources(false);
        if (book.dataset.codexBook === codexState.id) return;
        codexState.id = book.dataset.codexBook;
        codexState.path = [];
        storage.set(CODEX_LAST_KEY, codexState.id);
        renderCodexBooks();
        return loadCodexPage(true);
      }
      const crumb = event.target.closest('[data-codex-depth]');
      if (crumb) { codexState.path = codexState.path.slice(0, Number(crumb.dataset.codexDepth)); return loadCodexPage(true); }
      const cat = event.target.closest('[data-codex-cat]');
      if (cat) { codexState.path = [...codexState.path, cat.dataset.codexCat]; return loadCodexPage(true); }
      const quick = event.target.closest('[data-codex-quick]');
      if (quick) {
        const card = quick.closest('.codex-card');
        const open = !card.classList.contains('quick-open');
        document.querySelectorAll('.codex-card.quick-open').forEach(node => node.classList.remove('quick-open'));
        card.classList.toggle('quick-open', open);
        return;
      }
      const quickAdd = event.target.closest('[data-codex-quick-add], [data-codex-quick-replace]');
      if (quickAdd) return quickAppendCodex(quickAdd.dataset.codexQuickAdd ?? quickAdd.dataset.codexQuickReplace, { replace: 'codexQuickReplace' in quickAdd.dataset, card: quickAdd.closest('.codex-card') });
      document.querySelectorAll('.codex-card.quick-open').forEach(node => node.classList.remove('quick-open'));
      const card = event.target.closest('[data-codex-entry]');
      if (card) return openCodexDetail(Number(card.dataset.codexEntry));
      if (event.target.closest('[data-codex-back]')) return closeCodexDetail();
      const chip = event.target.closest('[data-cx-tag]');
      if (chip && codexDetail) {
        const item = codexDetail.blocks.find(block => block.key === chip.dataset.cxBlock)?.tags[Number(chip.dataset.cxTag)];
        if (item) { item.selected = !item.selected; renderCodexBlocks(); }
        return;
      }
      const toggleAll = event.target.closest('[data-cx-toggle-all]');
      if (toggleAll && codexDetail) {
        const block = codexDetail.blocks.find(item => item.key === toggleAll.dataset.cxToggleAll);
        const select = block.tags.some(item => !item.selected);
        block.tags.forEach(item => { item.selected = select; });
        return renderCodexBlocks();
      }
      const copy = event.target.closest('[data-cx-copy]');
      if (copy && codexDetail) {
        const block = codexDetail.blocks.find(item => item.key === copy.dataset.cxCopy);
        const text = selectedCodexTags(block).map(tagTools.format).filter(Boolean).join(', ');
        if (!text) return toast('没有选中的 Tag。');
        try { await navigator.clipboard.writeText(text); toast('已复制所选 Tag。', 'success'); }
        catch { toast('复制失败，浏览器未允许访问剪贴板。', 'error'); }
        return;
      }
      const apply = event.target.closest('[data-cx-apply]');
      if (apply) return applyCodexBlock(apply.dataset.cxApply);
      const replaceButton = event.target.closest('[data-cx-replace]');
      if (replaceButton?.dataset.cxReplace === 'neg' && codexDetail) {
        const neg = codexDetail.blocks.find(block => block.key === 'neg');
        const chosen = neg.tags.filter(item => item.selected || item.present).map(item => item.tag);
        if (!chosen.length) return toast('没有选中的 Tag。');
        const count = editor.addNegative(chosen, { replace: true });
        renderCodexBlocks();
        return toast(`负面提示词已替换为 ${count} 个 Tag，可撤销。`, 'success');
      }
      if (event.target.closest('[data-cx-params]') && codexDetail) {
        editor.applyParams(codexState.entries[codexDetail.index]?.params);
        return toast('已套用这张图的参数，Seed 已固定。', 'success');
      }
      if (event.target.closest('[data-cx-reproduce]') && codexDetail) return reproduceCodexEntry();
      if (replaceButton && codexDetail) {
        const main = codexDetail.blocks.find(block => block.key === 'main');
        // Replacing uses every chip the user kept selected, including ones that
        // were already present (they are being cleared first).
        const chosen = main.tags.filter(item => item.selected || item.present).map(item => item.tag);
        if (!chosen.length) return toast('没有选中的 Tag。');
        const { count, removed } = editor.replaceTags(chosen);
        renderCodexBlocks();
        return toast(`已替换为 ${count} 个 Tag${removed ? `，原有 ${removed} 个可撤销恢复` : ''}。`, 'success');
      }
      if (event.target.closest('[data-cx-apply-all]')) return applyCodexAll();
    });
  }

  // Signing out forgets the loaded directory, so the next account reads its own preferences.
  function resetCodex() {
    if (codexDetail) closeCodexDetail();
    Object.assign(codexState, { list: null, id: '', meta: null, path: [], q: '', tree: [], entries: [], base: 0, total: 0, token: codexState.token + 1, loading: false, nsfw: false, opening: false });
    $('#codexGrid')?.replaceChildren();
    syncCodexRail();
  }

  return { bind: bindCodex, ensureLoaded: ensureCodexLoaded, stickHeader: stickCodexHeader, closeDetail: closeCodexDetail, reset: resetCodex };
}
