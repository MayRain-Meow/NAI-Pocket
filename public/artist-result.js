import { STYLE_ATTRIBUTES, observationAttributes } from './artist-style-schema.js?v=1.9.42';

const GROUPS = { line: '线条', coloring: '上色', palette: '色彩', lighting: '光影', texture: '质感', shape: '造型', composition: '构图', work: '作品类型' };
const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
function el(tag, text = '', className = '') {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function link(url) {
  try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : ''; } catch { return ''; }
}

// One read-only surface for immutable task output and the current editable observation.
export function createArtistResultViewer({ api, onProfile = () => {}, onLocate = () => {}, onEdit, canEdit = () => true }) {
  let dialog, heading, body, controller, revision = 0, target;
  function close() {
    revision += 1; controller?.abort(); controller = null; target = null;
    if (dialog?.open) dialog.close();
    body?.replaceChildren(); if (heading) heading.textContent = '标注结果';
  }
  function button(text, operation) {
    const node = el('button', text, 'ghost'); node.type = 'button'; node.addEventListener('click', operation); return node;
  }
  function ensure() {
    if (dialog?.isConnected) return;
    dialog = el('dialog', '', 'artist-result-dialog'); dialog.setAttribute('aria-labelledby', 'artistResultTitle');
    heading = el('h2', '标注结果'); heading.setAttribute('id', 'artistResultTitle');
    const header = el('header', '', 'artist-result-header'); header.append(heading, button('关闭', close));
    body = el('div', '', 'artist-result-body'); dialog.append(header, body); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { if (!dialog.open) close(); });
  }
  function fromProfile(profile) {
    const example = profile.examples?.find(item => item.id === target.exampleId);
    if (!example) throw new Error('这张例图已移除。');
    const observations = (profile.observations || []).filter(item => item.exampleId === example.id);
    const observation = observations.find(item => item.reviewed === true) || observations.find(item => item.automatic !== true) || observations[0];
    const provenance = observation?.provenance || {};
    return { artist: profile.artist, exampleId: example.id, previewUrl: example.previewUrl || example.thumbUrl, sourceUrl: example.sourceUrl,
      attributes: observation ? observationAttributes(observation) : {}, evidence: observation?.note || '', available: Boolean(observation),
      model: provenance.model || '', preset: { id: provenance.presetId, name: provenance.presetName, revision: provenance.presetRevision },
      source: !observation ? '暂无标注' : observation.reviewed ? '人工已确认' : ['assistant-visual', 'deepseek-visual'].includes(observation.source) ? 'AI 初标 · 未人工确认' : observation.automatic ? 'D 站标签映射 · 未人工确认' : '手动草稿' };
  }
  function render(result) {
    const scroll = body.scrollTop;
    const unknownOpen = body.querySelector('.artist-result-unknown')?.open || false;
    body.replaceChildren();
    // `picture` (1.9.40): the artist page's picture viewer — the annotations it showed are retired.
    heading.textContent = `${target.jobId ? '本次 AI 输出' : target.picture ? '例图' : '当前例图标注'} · ${clean(result.artist, 160) || '例图已移除'}`;
    const media = el('div', '', 'artist-result-media');
    const previewUrl = result.previewUrl || '';
    if (/^\/api\/artists\/examples\/[\w-]+\/(preview|thumb)$/.test(previewUrl) || /^\/api\/artists\/resources\/image\?/.test(previewUrl)) {
      const image = el('img'); image.setAttribute('alt', `${clean(result.artist, 160)} 的标注例图`);
      // The local app serves /api/ in-process; it loads the image through its own loader.
      const load = globalThis.NAI_RUNTIME?.loadImage;
      if (typeof load === 'function') load(image, previewUrl); else image.setAttribute('src', previewUrl);
      media.append(image);
    } else media.append(el('p', result.deleted ? '例图已移除，保留本次输出记录。' : '暂无例图预览'));
    const info = el('div', '', 'artist-result-info');
    if (!target.picture) {
    const meta = [target.jobId ? 'AI 输出快照' : result.source, result.model, result.preset?.name || result.preset?.id,
      result.preset?.revision ? `预设版本 ${clean(result.preset.revision, 20)}` : ''].filter(Boolean);
    info.append(el('p', meta.map(value => clean(value, 160)).join(' · '), 'artist-result-meta'));
    if (result.available === false) info.append(el('p', '暂无可查看的标注结果。'));
    else {
      const attributes = result.attributes || {};
      const grid = el('div', '', 'artist-result-groups');
      let judged = 0;
      for (const [group, label] of Object.entries(GROUPS)) {
        const section = el('section'); section.append(el('h3', label));
        for (const definition of STYLE_ATTRIBUTES.filter(item => item.group === group)) {
          const values = definition.options.filter(option => attributes[definition.key]?.includes(option.value));
          if (!values.length) continue;
          judged += 1;
          const row = el('div', '', 'artist-result-attribute'); row.append(el('span', definition.label));
          const chips = el('div'); values.forEach(value => chips.append(el('span', value.label, 'artist-result-chip'))); row.append(chips); section.append(row);
        }
        if (section.childNodes.length > 1) grid.append(section);
      }
      info.append(el('p', `已判断 ${judged} / ${STYLE_ATTRIBUTES.length} 项`, 'artist-result-meta'), grid);
      const unknown = STYLE_ATTRIBUTES.filter(item => !item.options.some(option => attributes[item.key]?.includes(option.value)));
      if (unknown.length) {
        const details = el('details', '', 'artist-result-unknown'); details.open = unknownOpen; details.append(el('summary', `未判断 ${unknown.length} 项`), el('p', unknown.map(item => item.label).join(' · '))); info.append(details);
      }
      const evidence = el('section', '', 'artist-result-evidence'); evidence.append(el('h3', '判断依据'), el('p', clean(result.evidence) || '未保存文字依据。')); info.append(evidence);
    }
    }
    const actions = el('div', '', 'artist-result-actions');
    const href = link(result.sourceUrl);
    if (href) { const source = el('a', '打开原作来源'); source.setAttribute('href', href); source.setAttribute('target', '_blank'); source.setAttribute('rel', 'noopener noreferrer'); actions.append(source); }
    if (!result.deleted && result.artist && result.exampleId) actions.append(button('定位例图', () => { close(); Promise.resolve(onLocate(result.artist, result.exampleId)).catch(() => {}); }));
    if (!target.picture && !result.deleted && result.artist && result.exampleId && canEdit() && typeof onEdit === 'function') actions.append(button('编辑标注', () => { close(); Promise.resolve(onEdit(result.artist, result.exampleId)).catch(() => {}); }));
    media.append(actions); body.append(media, ...(target.picture ? [] : [info])); body.scrollTop = scroll;
    dialog.classList.toggle('is-picture', Boolean(target.picture));
  }
  async function open(selection) {
    ensure(); controller?.abort(); controller = new AbortController();
    const token = ++revision; target = { ...selection };
    heading.textContent = target.picture ? '例图' : '标注结果'; body.replaceChildren(el('p', target.picture ? '正在读取…' : '读取已保存结果…', 'artist-result-loading'));
    if (!dialog.open) dialog.showModal();
    try {
      const data = await api(target.jobId ? `/api/artists/annotation/result?jobId=${encodeURIComponent(target.jobId)}` : `/api/artists/profile?artist=${encodeURIComponent(target.artist)}`, { signal: controller.signal });
      if (token !== revision || !dialog.open) return;
      if (!target.jobId) { render(fromProfile(data.artist)); onProfile(data, target.artist); }
      else render(data.result);
    } catch (error) {
      if (token !== revision || error.name === 'AbortError' || !dialog.open) return;
      const message = el('p', clean(error.message, 300) || '结果读取失败。'); message.setAttribute('role', 'alert');
      const selection = { ...target }; body.replaceChildren(message, button('重新读取', () => open(selection)));
    }
  }
  function updateProfile(profile) {
    if (!dialog?.open || !target || target.jobId || target.artist !== profile.artist) return;
    try { render(fromProfile(profile)); } catch (error) { body.replaceChildren(el('p', error.message)); }
  }
  return { open, reset: close, updateProfile };
}
