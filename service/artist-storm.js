// Artist Storm (1.9.27; shared by the website and the app since 1.9.41): one batch on one fixed seed in
// which only the editor's artist weights change (and, in the 加画师 modes, one candidate artist is added),
// so the pictures differ by those weights alone. This module turns the Storm plan into one job state per
// variant and summarises a stored batch for 上一轮; each host inserts the jobs into its own queue.
import { formatTag } from '../public/prompt-utils.js';
import { buildArtistStormPlan } from '../public/storm-utils.js';

const GROUP_ORDER = ['style', 'scene', 'camera', 'misc'];

// The prompt the queue sends, rebuilt from the groups (the editor's own order rules).
export function stormPromptFromGroups(state) {
  let tags = GROUP_ORDER.flatMap(key => state.groups?.[key] || []);
  if (state.promptOrderMode === 'original') {
    tags = tags.map((tag, index) => ({
      tag, index,
      order: Number.isFinite(Number(tag.originalOrder)) ? Number(tag.originalOrder) : Number.MAX_SAFE_INTEGER
    })).sort((a, b) => (a.order - b.order) || (a.index - b.index)).map(item => item.tag);
  }
  return tags.filter(tag => tag.enabled !== false).map(formatTag).filter(Boolean).join(', ');
}

// `isArtistTag(text)` says whether a tag is a confirmed artist (the host's identity index).
export function createArtistStorm({ isArtistTag }) {
  function artistRefs(state, selectedIds) {
    const selected = Array.isArray(selectedIds) ? new Set(selectedIds.map(String)) : null;
    const refs = [];
    for (const [groupKey, tags] of Object.entries(state.groups || {})) {
      (tags || []).forEach((tag, index) => {
        if (tag.enabled === false || (selected ? !selected.has(tag.id) : !isArtistTag(tag.text))) return;
        refs.push({ id: tag.id || `${groupKey}:${index}`, text: tag.text, weight: tag.weight, groupKey, index });
      });
    }
    return refs;
  }
  function appendExternalArtist(state, external, index) {
    if (!external) return;
    const style = state.groups.style || (state.groups.style = []);
    const artistOrders = style.filter(tag => isArtistTag(tag.text) && Number.isFinite(Number(tag.originalOrder))).map(tag => Number(tag.originalOrder));
    const originalOrder = artistOrders.length ? Math.max(...artistOrders) + 0.0001 : null;
    style.push({
      id: `storm-external-${index + 1}`, text: external.text, exactText: external.text, weight: 1,
      enabled: true, translation: '', bundle: false, preserveRaw: false, raw: '',
      originalText: external.text, originalExactText: external.text, originalWeight: 1, originalOrder
    });
  }
  // A sanitized state and the request's options → { plan, jobs: [{ state, log }] } on one fixed seed.
  function stormJobs(state, options = {}, { maxSize, seed }) {
    const count = Math.round(Number(options.count));
    if (!Number.isInteger(count) || count < 2 || count > maxSize) {
      throw new Error(`Storm 数量必须在 2–${maxSize} 之间；可用 MAX_STORM_SIZE 调整安全阈值。`);
    }
    const refs = artistRefs(state, options.artistIds);
    const roll = Number(options.roll);
    const plan = buildArtistStormPlan(refs, { count, delta: options.delta, mode: options.mode, externalArtists: options.externalArtists,
      roll: Number.isInteger(roll) && roll >= 0 && roll <= 4294967295 ? roll : undefined });
    if (plan.count < 2) throw new Error('当前范围只得到一个不同组合，请扩大权重变化范围。');
    const jobs = plan.variants.map((variant, index) => {
      const jobState = structuredClone(state);
      const weightById = new Map(variant.weights.map(item => [item.id, item.weight]));
      for (const ref of refs) jobState.groups[ref.groupKey][ref.index].weight = weightById.get(ref.id);
      const externalArtist = variant.externalArtist;
      appendExternalArtist(jobState, externalArtist, index);
      jobState.prompt = variant.isBaseline ? state.prompt : stormPromptFromGroups(jobState);
      jobState.previewPrompt = jobState.prompt;
      jobState.seedMode = 'fixed';
      jobState.seed = seed;
      jobState.experiment = {
        type: 'artist-storm', mode: plan.mode, index: index + 1, total: plan.count,
        delta: plan.delta, weights: variant.weights, externalArtist, isBaseline: variant.isBaseline
      };
      const externalText = externalArtist ? ` · 外来 ${externalArtist.text}` : '';
      return { state: jobState, log: `画风 Storm ${index + 1}/${plan.count}${externalText} · Seed ${seed}` };
    });
    return { plan, count, jobs };
  }
  return { artistRefs, stormJobs };
}

// 上一轮: a stored batch's rows ({ position, status, image_id, seed, created_at, experiment }) with
// `experiment` as parsed JSON or text → every variant with its weights, added artist, status and picture.
export function summarizeStorm(batchId, rows) {
  if (!batchId || !rows.length) return null;
  const parse = value => { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '{}'); } catch { return {}; } };
  const items = rows.map(row => {
    const experiment = parse(row.experiment);
    return { index: row.position, status: row.status, imageId: row.image_id || null, isBaseline: experiment.isBaseline === true,
      weights: (experiment.weights || []).map(item => ({ text: item.text, weight: item.weight, baseWeight: item.baseWeight })),
      externalArtist: experiment.externalArtist?.text || '' };
  });
  return { batchId, seed: rows[0]?.seed ?? null, createdAt: rows[0]?.created_at ?? null, mode: parse(rows[0]?.experiment).mode || 'mix', items };
}
