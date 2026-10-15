// 找画风 panel vocabulary that is not in the style index: how "精确" maps a vibe chip onto a stored
// annotation value, and the label-only chips that exist only as annotations (they filter exactly and
// never rank). The vibe chips themselves come from the server's index (GET /api/artists/style-index).
// Every informative value of the old 画风特征 / 细化特征 / 构图 grids is reachable from here or from
// those grids, which stay available under 更多标注筛选.

export const VIBE_EXACT_ATTRIBUTE = Object.freeze({
  watercolor: ['coloring.technique', 'watercolor'], painterly: ['coloring.technique', 'painterly'], flat: ['coloring.technique', 'flat'],
  monochrome: ['palette.saturation', 'monochrome'], sketch: ['line.finish', 'sketch'], bloom: ['lighting.shadow', 'soft'],
  dramatic: ['lighting.contrast', 'highContrast'], backlit: ['lighting.direction', 'backlit'], vivid: ['palette.saturation', 'vivid'],
  muted: ['palette.saturation', 'muted'], paper: ['texture.surface', 'paper'], lineart: ['line.weight', 'bold'], oil: ['texture.surface', 'brush'],
  semireal: ['shape.proportion', 'realistic'], chibi: ['shape.proportion', 'chibi'], detailed: ['shape.detail', 'detailed'],
  cold: ['palette.temperature', 'cool'], warm: ['palette.temperature', 'warm'], volume: ['shape.volume', 'volumetric'], gloomy: ['palette.brightness', 'dark']
});
const chip = (id, label, group, key, value) => Object.freeze({ id, label, group, attribute: Object.freeze([key, value]) });
export const EXACT_CHIPS = Object.freeze([
  chip('t-cel', '赛璐璐', '画法', 'coloring.technique', 'cel'), chip('t-ink', '水墨', '画法', 'coloring.technique', 'ink'),
  chip('t-wash', '晕染', '画法', 'texture.surface', 'wash'), chip('t-grain', '颗粒', '画法', 'texture.surface', 'grain'),
  chip('t-lineless', '无线稿', '画法', 'line.edge', 'soft'),
  chip('t-limited', '有限色板', '色彩', 'palette.breadth', 'limited'), chip('t-broad', '丰富色板', '色彩', 'palette.breadth', 'broad'),
  chip('t-light', '高明度', '色彩', 'palette.brightness', 'light'), chip('t-highcontrast', '高反差', '色彩', 'lighting.contrast', 'highContrast'),
  chip('t-lowcontrast', '低反差', '色彩', 'lighting.contrast', 'lowContrast'), chip('t-hardshadow', '硬边阴影', '色彩', 'lighting.shadow', 'hard'),
  chip('t-closeup', '特写', '画面', 'composition.framing', 'closeup'), chip('t-halfbody', '半身', '画面', 'composition.framing', 'halfbody'),
  chip('t-fullbody', '全身', '画面', 'composition.framing', 'fullbody'), chip('t-wide', '远景', '画面', 'composition.framing', 'wide'),
  chip('t-multiple', '多人', '画面', 'composition.placement', 'multiple'), chip('t-sparse', '大留白', '画面', 'composition.space', 'sparse'),
  chip('t-deep', '纵深', '画面', 'composition.depth', 'deep'), chip('t-scene', '场景', '画面', 'work.type', 'scene'),
  chip('t-portrait', '肖像', '画面', 'work.type', 'portrait'), chip('t-comic', '漫画分格', '画面', 'work.type', 'comic'),
  chip('t-design', '设定图', '画面', 'work.type', 'design')
]);
export const VIBE_GROUP_ORDER = Object.freeze(['氛围', '场景', '画法', '色彩', '质感', '造型', '年代', '题材', '画面']);
// A typed word that names a chip lights the chip instead of searching text: 「水彩 梦幻」 → two chips.
export function chipForWord(word, vibeChips = []) {
  const text = String(word || '').trim().toLowerCase();
  if (!text) return null;
  const vibe = vibeChips.find(item => item.label.toLowerCase().replace(/\s+/g, '') === text.replace(/\s+/g, ''));
  if (vibe) return { kind: 'vibe', id: vibe.id };
  const exact = EXACT_CHIPS.find(item => item.label === text);
  return exact ? { kind: 'exact', id: exact.id } : null;
}
// The attribute filters a set of chips implies: exact chips always; vibe chips only in 精确 mode.
export function attributesForChips(vibeTokens = [], exactIds = [], exact = false) {
  const result = {};
  const add = ([key, value]) => { (result[key] ||= []).includes(value) || result[key].push(value); };
  for (const id of exactIds) { const entry = EXACT_CHIPS.find(item => item.id === id); if (entry) add(entry.attribute); }
  if (exact) for (const token of vibeTokens) if (!token.startsWith('-') && VIBE_EXACT_ATTRIBUTE[token]) add(VIBE_EXACT_ATTRIBUTE[token]);
  return result;
}
