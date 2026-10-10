// Versioned, observable descriptors shared by search, annotation and editing.
export const STYLE_SCHEMA_VERSION = 2;
const opt = (value, label, ...aliases) => ({ value, label, aliases });
const attribute = (key, label, definition, options) => ({ key, group: key.split('.')[0], label, definition, options });
export const STYLE_ATTRIBUTES = Object.freeze([
  attribute('line.weight', '线条粗细', '观察主要轮廓的线宽；头发细不等于线条细。', [opt('fine', '纤细', '细线', '细腻线条'), opt('bold', '粗重', '粗线'), opt('varied', '粗细变化')]),
  attribute('line.edge', '轮廓清晰度', '独立线稿或轮廓的显著程度；不以画面整体明暗判断。', [opt('soft', '弱轮廓', '无线稿', '弱线条'), opt('defined', '清晰轮廓')]),
  attribute('line.finish', '线条完成度', '草稿有重复寻找形体的线；画得细密不一定是草稿。', [opt('sketch', '草稿感', '草稿线'), opt('clean', '干净线稿')]),
  attribute('coloring.technique', '上色技法', '平涂为色块，赛璐璐有分区阴影，厚涂以色塑形，水彩有透明晕染，水墨以墨色浓淡与渗化塑形；可并存。', [opt('flat', '平涂'), opt('cel', '赛璐璐', 'cel shading'), opt('painterly', '厚涂', 'painterly'), opt('watercolor', '水彩感', '水彩', 'watercolor'), opt('ink', '水墨/墨线', '水墨', '水墨画', '墨', '墨线', 'ink', 'ink wash')]),
  attribute('palette.temperature', '整体冷暖', '按全画面主要色块判断；只有蓝色头发不能证明整体冷色。', [opt('cool', '冷色调', '冷色'), opt('warm', '暖色调', '暖色'), opt('mixed', '冷暖混合'), opt('neutral', '中性色调')]),
  attribute('palette.saturation', '整体饱和度', '按主体及主要色块判断鲜艳程度；小面积高饱和点缀不代表全图。完全无彩的黑白画面用 monochrome，此时不要再填 palette.breadth。', [opt('muted', '低饱和', '低饱和度', 'muted'), opt('vivid', '高饱和', '高饱和度', '鲜艳'), opt('moderate', '中饱和'), opt('monochrome', '无彩黑白', '黑白', '单色', '黑白线稿'), opt('greyscale', '灰度', '灰阶', 'grayscale')]),
  attribute('palette.brightness', '整体明度', '主要面积的明暗；白色小饰品不能证明整体高明度。', [opt('light', '高明度', '明亮画面'), opt('dark', '低明度', '暗调'), opt('mid', '中间明度')]),
  attribute('palette.breadth', '配色范围', '有限色板是少量主色，单色另有标记；不按人物数量判断。', [opt('limited', '有限色板', '少量配色'), opt('broad', '丰富色板'), opt('monochrome', '单色画面', '黑白画面')]),
  attribute('lighting.shadow', '阴影边缘', '看主要阴影交界的软硬；柔光与低反差可以独立出现。', [opt('soft', '柔光', '柔和光影'), opt('hard', '硬边阴影', '硬阴影'), opt('mixed', '软硬混合阴影')]),
  attribute('lighting.contrast', '明暗反差', '主要明暗层次的差距；不能由饱和度推出。', [opt('lowContrast', '低反差', '低对比'), opt('highContrast', '高反差', '高对比'), opt('moderate', '中等反差')]),
  attribute('lighting.direction', '主光方向', '只在有可见光向证据时标注；发丝亮色不一定是逆光。', [opt('backlit', '逆光'), opt('front', '正面光'), opt('side', '侧光'), opt('ambient', '环境漫射光')]),
  attribute('texture.surface', '表面质感', '观察渲染材质；纸感/颗粒/笔触/晕染可并存，不从文件压缩噪点推断。', [opt('smooth', '平滑'), opt('grain', '颗粒', '颗粒感'), opt('paper', '纸感', '纸张质感'), opt('brush', '可见笔触', '笔触'), opt('wash', '晕染/渗化', '晕染', '渗化', 'ink bleed')]),
  attribute('shape.proportion', '造型比例', '观察整体比例趋向；细节多不等于写实比例。', [opt('stylized', '夸张比例'), opt('realistic', '偏写实', '写实', 'realistic'), opt('chibi', 'Q版比例')]),
  attribute('shape.volume', '体积塑造', '平面概括与立体塑形；有线稿不意味着平面。', [opt('flat', '平面概括', '平面化'), opt('volumetric', '立体塑形')]),
  attribute('shape.detail', '细节密度', '主要主体的有效细节密度；重复压缩纹理不算设计细节。', [opt('detailed', '细节密集', '丰富细节'), opt('simple', '简化造型'), opt('moderate', '适中细节')]),
  attribute('composition.framing', '景别', '按实际裁切范围描述，不作为画师固定风格。', [opt('closeup', '特写'), opt('halfbody', '半身'), opt('fullbody', '全身'), opt('wide', '远景')]),
  attribute('composition.placement', '主体布局', '主体在画面中的位置；画面无主要主体时留空。', [opt('centered', '居中构图'), opt('offset', '偏心构图'), opt('multiple', '多主体构图')]),
  attribute('composition.depth', '空间层次', '由前中后景组织判断；物体写实不自动代表深空间。', [opt('shallow', '浅空间'), opt('deep', '纵深空间')]),
  attribute('composition.space', '留白', '主要视觉区域之外的留白比例，白色物体不是留白。', [opt('sparse', '大留白'), opt('dense', '密集构图')]),
  attribute('work.type', '作品类型', '描述这张作品用途/题材组织，不推断画师身份或擅长范围。', [opt('portrait', '肖像'), opt('character', '角色插画'), opt('scene', '场景插画'), opt('design', '设定稿'), opt('comic', '漫画页')])
]);
const byKey = new Map(STYLE_ATTRIBUTES.map(item => [item.key, item]));
const legacyMappings = [
  ['line', 'fine', 'line.weight'], ['line', 'bold', 'line.weight'], ['line', 'soft', 'line.edge'], ['line', 'sketch', 'line.finish'],
  ...['flat', 'cel', 'painterly', 'watercolor', 'ink'].map(value => ['coloring', value, 'coloring.technique']),
  ...['muted', 'vivid', 'greyscale', 'monochrome'].map(value => ['palette', value, 'palette.saturation']),
  ...['cool', 'warm'].map(value => ['palette', value, 'palette.temperature']), ['palette', 'limited', 'palette.breadth'],
  ...['soft', 'hard'].map(value => ['lighting', value, 'lighting.shadow']),
  ...['lowContrast', 'highContrast'].map(value => ['lighting', value, 'lighting.contrast']), ['lighting', 'backlit', 'lighting.direction'],
  ...['smooth', 'grain', 'paper', 'brush', 'wash'].map(value => ['texture', value, 'texture.surface']),
  ['shape', 'flat', 'shape.volume'], ['shape', 'stylized', 'shape.proportion'], ['shape', 'realistic', 'shape.proportion'], ['shape', 'detailed', 'shape.detail']
];

// Identity fingerprint for one unexpected value: length, first/last code point
// and character classes. This is metadata about a token rather than image or
// prose content, and it is what keeps a long-running mismatch diagnosable
// without ever storing or displaying the rejected string.
export function valueFingerprint(value) {
  if (typeof value !== 'string' || !value) return '';
  const length = [...value].length;
  // An enum token is short by construction; anything longer is not a fingerprint
  // candidate and is reported as an unreadable shape instead.
  if (length > 160) return '';
  const first = value.codePointAt(0) || 0;
  const last = value.codePointAt(value.length - 1) || 0;
  const flags = `${/^[a-z]+$/.test(value) ? 'L' : ''}${/[A-Z]/.test(value) ? 'C' : ''}${/[0-9]/.test(value) ? 'D' : ''}${/[^A-Za-z0-9]/.test(value) ? 'S' : ''}${/[\u3000-\u9fff\uff00-\uffef]/.test(value) ? 'J' : ''}`;
  return `${length}:${first}:${last}:${flags || 'x'}`;
}

// Structural reason a provider result was rejected. Every field is a boolean or a
// bounded number plus indexes into the public catalog and token fingerprints —
// no model text, no rejected key or value string, no image data.
export function attributeDiagnostic(value) {
  const present = value !== undefined && value !== null;
  const object = present && typeof value === 'object' && !Array.isArray(value);
  const diagnostic = {
    present,
    object,
    unknownKeys: 0,
    valueNotArray: 0,
    emptyArray: 0,
    tooManyValues: 0,
    invalidValues: 0,
    unknownKeyIndexes: [],
    invalidValueKeyIndexes: [],
    invalidValueOptionIndexes: [],
    invalidValueFingerprints: [],
    messages: []
  };
  if (!object) return diagnostic;
  for (const [key, values] of Object.entries(value)) {
    const definition = byKey.get(key);
    if (!definition) {
      diagnostic.unknownKeys += 1;
      if (diagnostic.unknownKeyIndexes.length < 8) diagnostic.unknownKeyIndexes.push(STYLE_ATTRIBUTES.length);
      continue;
    }
    const keyIndex = STYLE_ATTRIBUTES.indexOf(definition);
    if (!Array.isArray(values)) { diagnostic.valueNotArray += 1; continue; }
    if (!values.length) { diagnostic.emptyArray += 1; continue; }
    if (values.length > definition.options.length) diagnostic.tooManyValues += 1;
    for (const item of values) {
      if (definition.options.some(option => option.value === item)) continue;
      diagnostic.invalidValues += 1;
      if (diagnostic.invalidValueKeyIndexes.length < 8) {
        diagnostic.invalidValueKeyIndexes.push(keyIndex);
        diagnostic.invalidValueOptionIndexes.push(definition.options.length);
      }
      const fingerprint = valueFingerprint(item);
      if (fingerprint && diagnostic.invalidValueFingerprints.length < 4 && !diagnostic.invalidValueFingerprints.includes(fingerprint)) {
        diagnostic.invalidValueFingerprints.push(fingerprint);
      }
    }
  }
  return diagnostic;
}

// Throws with a safe structural code so one rejected response stays diagnosable
// without persisting any provider text.
export function validateStyleAttributesWithDiagnostic(value) {
  try { return validateStyleAttributes(value); }
  catch (error) { throw Object.assign(new Error('画风属性格式无效。'), { attributeDiagnostic: attributeDiagnostic(value) }); }
}

export function validateStyleAttributes(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('画风属性格式无效。');
  const result = {};
  for (const [key, values] of Object.entries(value)) {
    const definition = byKey.get(key);
    if (!definition || !Array.isArray(values) || values.length > definition.options.length || values.some(item => !definition.options.some(option => option.value === item))) throw new Error('包含未知的画风属性。');
    if (values.length) result[key] = [...new Set(values)];
  }
  return result;
}

// A monochrome saturation value is the required core representative for a
// colorless image and must not additionally imply the breadth descriptor, or one
// observation would count twice in the same summary.
const CORE_REPRESENTATIVE_VALUES = new Set(['palette.saturation=monochrome']);

export function attributesFromLegacy(facets = {}) {
  const result = {};
  for (const [group, value, key] of legacyMappings) if (facets?.[group]?.includes(value)) result[key] = [...(result[key] || []), value];
  return result;
}

export function legacyFromAttributes(attributes = {}) {
  const result = {};
  for (const [group, value, key] of legacyMappings) {
    if (!attributes?.[key]?.includes(value)) continue;
    if (CORE_REPRESENTATIVE_VALUES.has(`${key}=${value}`)) continue;
    result[group] = [...(result[group] || []), value];
  }
  return result;
}

// Deriving an observation's attributes means parsing two JSON blobs and merging them
// through validateStyleAttributes + attributesFromLegacy, both Set-heavy. That derivation
// was being redone for EVERY observation of EVERY artist on every list request — measured
// at ~600 ms of fixed cost per request regardless of how many artists were returned
// (limit=1 and limit=80 cost the same). It is memoised by object identity instead, which is
// safe because the catalog never mutates an observation in place: a changed row produces a
// NEW object via the store's own parse cache.
//
// A WeakMap rather than a property on the observation: an extra own key would be serialised
// into the API response and would grow the payload this release is trying to shrink.
const attributeMemo = new WeakMap();

export function observationAttributes(observation = {}) {
  const cached = attributeMemo.get(observation);
  if (cached) return cached;
  const value = { ...attributesFromLegacy(observation.facets), ...validateStyleAttributes(observation.attributes || {}) };
  attributeMemo.set(observation, value);
  return value;
}

// Turns an attribute map back into labelled entries so a caller can show WHAT it
// understood from a typed query ("画风特征：水墨／墨线 · 无彩黑白") instead of
// leaving the user to guess whether their words were recognized at all.
export function describeStyleAttributes(attributes = {}) {
  const result = [];
  for (const [key, values] of Object.entries(attributes)) {
    const definition = byKey.get(key);
    if (!definition || !Array.isArray(values)) continue;
    for (const value of values) {
      const option = definition.options.find(item => item.value === value);
      if (option) result.push({ key, value, label: option.label });
    }
  }
  return result;
}

export function matchesStyleAttributes(observation, constraints = {}) {
  const attributes = observationAttributes(observation);
  return Object.entries(constraints).every(([key, values]) => values.some(value => attributes[key]?.includes(value)));
}

// A ranked match is partial by definition, so the example worth showing is the one
// evidencing ANY requested property rather than all of them.
export function matchesAnyStyleAttribute(observation, constraints = {}) {
  const attributes = observationAttributes(observation);
  return Object.entries(constraints).some(([key, values]) => values.some(value => attributes[key]?.includes(value)));
}

// Artist-level style profile, for ranked retrieval rather than admission. The exact
// filter above asks whether ONE example satisfies every requested property at once,
// which drops an artist whose examples each evidence part of the intent and returns
// an unordered set that cannot express "closest". This scores the artist instead:
// per requested property, how often their own observed examples actually show it.
// A property nobody annotated contributes 0 instead of disqualifying, so unknown
// stays unknown — callers MUST surface `evidence` beside `score`, otherwise a sparsely
// annotated artist looks like a confirmed bad match. Ranking is opt-in; the caller
// admits on `score > 0` and never treats this as a filter by itself.
export function scoreStyleMatch(observations = [], constraints = {}) {
  const axes = Object.entries(constraints).filter(([, values]) => Array.isArray(values) && values.length);
  if (!axes.length) return null;
  const perAxis = axes.map(([key, values]) => ({ key, values, evaluated: 0, hit: 0, exampleIds: [] }));
  for (const observation of observations) {
    const attributes = observationAttributes(observation);
    for (const axis of perAxis) {
      const own = attributes[axis.key];
      if (!own?.length) continue;
      axis.evaluated += 1;
      if (!axis.values.some(value => own.includes(value))) continue;
      axis.hit += 1;
      if (axis.exampleIds.length < 4) axis.exampleIds.push(observation.exampleId);
    }
  }
  let sum = 0;
  let matched = 0;
  let evidence = 0;
  for (const axis of perAxis) {
    axis.confidence = axis.evaluated ? axis.hit / axis.evaluated : 0;
    sum += axis.confidence;
    if (axis.hit) matched += 1;
    if (axis.evaluated) evidence += 1;
  }
  return { score: sum / perAxis.length, axes: perAxis.length, matched, evidence, perAxis };
}

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Query vocabulary: an option's label, its aliases **and its stored enum value**.
// The enum value is what the schema, the annotation payload and every stored
// observation actually contain, so typing `monochrome` or `watercolor` has to work
// even when no Chinese label is involved; indexing labels alone made the app's own
// stored value unsearchable.
const QUERY_TERMS = (() => {
  const byTerm = new Map();
  for (const item of STYLE_ATTRIBUTES) {
    for (const option of item.options) {
      for (const raw of [option.label, ...option.aliases, option.value]) {
        const term = String(raw).toLowerCase();
        if (!term) continue;
        if (!byTerm.has(term)) byTerm.set(term, new Map());
        byTerm.get(term).set(item.key, option.value);
      }
    }
  }
  return [...byTerm.entries()].sort((a, b) => b[0].length - a[0].length);
})();
// A value owned by several properties is ambiguous as a bare word (`soft` is both
// 轮廓清晰度 and 阴影边缘; `monochrome` is both 饱和度 and 配色范围). Constraining
// every owner would demand two properties the schema says must not co-occur, so an
// ambiguous word is reported for the user to choose instead of guessed — except the
// one value the schema already names as a property's canonical representative, which
// resolves to its owner.

const CANONICAL_VALUE_OWNER = new Map([['monochrome', 'palette.saturation']]);
export function parseAttributeQuery(text = '') {
  let rest = String(text).trim().toLowerCase().slice(0, 300);
  const attributes = {};
  const ambiguousTerms = [];
  for (const [term, owners] of QUERY_TERMS) {
    const pattern = new RegExp(/^[a-z]/.test(term) ? `\\b${escapeRegex(term)}\\b` : escapeRegex(term), 'g');
    if (!pattern.test(rest)) continue;
    rest = rest.replace(pattern, ' ');
    const key = owners.size === 1 ? [...owners.keys()][0] : CANONICAL_VALUE_OWNER.get(term);
    if (!key || !owners.has(key)) { ambiguousTerms.push(term); continue; }
    const value = owners.get(key);
    attributes[key] = [...new Set([...(attributes[key] || []), value])];
  }
  return { attributes, ambiguousTerms, rest };
}

export function summarizeStyleEvidence(examples = [], observations = [], model = '') {
  const scoped = examples.filter(item => !model || item.model === model);
  const ids = new Set(scoped.map(item => item.id));
  const rows = observations.filter(item => ids.has(item.exampleId) && (!model || item.model === model));
  const attributes = rows.map(item => ({ ...item, attributes: observationAttributes(item) }));
  const features = [];
  for (const definition of STYLE_ATTRIBUTES) {
    const evaluable = attributes.filter(item => item.attributes[definition.key]?.length);
    for (const option of definition.options) {
      const supporting = evaluable.filter(item => item.attributes[definition.key].includes(option.value));
      if (!supporting.length) continue;
      const exampleIds = [...new Set(supporting.map(item => item.exampleId))];
      features.push({ key: definition.key, value: option.value, label: option.label, supporting: exampleIds.length,
        evaluable: new Set(evaluable.map(item => item.exampleId)).size, total: scoped.length, exampleIds,
        sources: [...new Set(supporting.map(item => item.source || 'manual'))], confirmed: supporting.filter(item => item.reviewed).length });
    }
  }
  return { total: scoped.length, annotated: new Set(rows.map(item => item.exampleId)).size, features };
}
