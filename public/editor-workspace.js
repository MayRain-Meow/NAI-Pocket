import { identifyArtistTag } from './artist-index-v5.js?v=1.9.42';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const dimension = value => clamp(Math.round((Number(value) || 64) / 64) * 64, 64, 2048);

// Match the application's supported 64-pixel grid, 2048 side limit and 3 MP ceiling.
// Apply only to explicit size edits; imported states and masks remain untouched.
export function fitGenerationDimensions(rawWidth, rawHeight, { ratio = 'free', changed = 'width' } = {}) {
  let width = dimension(rawWidth);
  let height = dimension(rawHeight);
  const [a, b] = String(ratio).split(':').map(Number);
  if (a > 0 && b > 0 && Number.isFinite(a / b)) {
    if (changed === 'height') width = height * a / b;
    else height = width * b / a;
    const factor = Math.min(1, 2048 / width, 2048 / height, Math.sqrt(3145728 / (width * height)));
    width *= factor;
    height *= factor;
    // Nearby grid pairs trade a little size precision for a much closer aspect ratio.
    let best = null;
    for (let w = dimension(width) - 64; w <= dimension(width) + 64; w += 64) {
      for (let h = dimension(height) - 64; h <= dimension(height) + 64; h += 64) {
        if (w < 64 || h < 64 || w > 2048 || h > 2048 || w * h > 3145728) continue;
        const score = Math.abs(Math.log(w / h / (a / b))) * 4 + Math.abs(Math.log(w / width)) + Math.abs(Math.log(h / height));
        if (!best || score < best.score) best = { width: w, height: h, score };
      }
    }
    if (best) return { width: best.width, height: best.height };
  }
  if (width * height > 3145728) {
    const factor = Math.sqrt(3145728 / (width * height));
    width = Math.max(64, Math.floor(width * factor / 64) * 64);
    height = Math.max(64, Math.floor(height * factor / 64) * 64);
  }
  return { width: dimension(width), height: dimension(height) };
}

export function requiresSeedDecision(state, count) {
  return Number(count) > 1 && state?.seedMode === 'fixed' && !['upscale', 'director'].includes(state?.imageTool?.type);
}

export function createTranslationDraft(text, translation = '') {
  return { text: String(text).trim(), translation: String(translation), manual: false, revision: 0 };
}

export function editTranslationDraft(draft, text, translation, field) {
  const nextText = String(text).trim();
  const changedText = nextText !== draft.text;
  return {
    text: nextText,
    translation: changedText ? '' : String(translation),
    manual: !changedText && (field === 'translation' || draft.manual),
    revision: draft.revision + 1
  };
}

export function canApplyDraftTranslation(draft, request) {
  return Boolean(draft && request && draft.text === request.text && draft.revision === request.revision);
}

export function cleanArtistTranslation(text, translation) {
  return translation === '外来画师' && identifyArtistTag(text).recognized ? '' : String(translation || '');
}

// 普通 Tag 的 ＋/－ 按钮每次走 0.1，但权重本身是 0.01 精度（编辑框、导入的 Prompt、已保存方案都可能带
// 1.23 这种值）。若直接 ±0.1，百分位永远不动：1.23 → 1.33 → 1.43，用按钮再也回不到整十分位。
// 因此第一次按下先把值吸附到 0.1 网格，方向由按键决定：＋向上取到下一个十分位，－向下取到上一个；
// 之后才按 0.1 步进；已经落在网格上的值行为与从前完全一致。
// 全程用整数「百分位」计算，避免 0.1 + 0.2 这类浮点误差累积。
// Note: 为什么普通按钮第一次按下要吸附到 0.1 网格、而不是直接 ±0.1，以及为什么这条路径不加
// 权重上下界（v0.8.6 刻意解除了限制），见

export const TAG_WEIGHT_STEP = 0.1;
const WEIGHT_UNITS = 100;
const WEIGHT_STEP_UNITS = Math.round(TAG_WEIGHT_STEP * WEIGHT_UNITS);

export function stepTagWeight(value, direction) {
  // 与 app.js 的 roundTagWeight 同一套约定：先四舍五入到百分位整数；非有限值兜底为 1。
  const parsed = Number(value);
  const units = Math.round(((Number.isFinite(parsed) ? parsed : 1) + Number.EPSILON) * WEIGHT_UNITS);
  const remainder = ((units % WEIGHT_STEP_UNITS) + WEIGHT_STEP_UNITS) % WEIGHT_STEP_UNITS;
  const offset = direction < 0
    ? -(remainder === 0 ? WEIGHT_STEP_UNITS : remainder)
    : (remainder === 0 ? WEIGHT_STEP_UNITS : WEIGHT_STEP_UNITS - remainder);
  return (units + offset) / WEIGHT_UNITS;
}

export function characterPositionPadStyle(x, y = 0.5) {
  // Note: 坐标写在 pad 的 CSS 变量上，避免 details 收起时把 left/top % 冻成 0px。
  
  const clampUnit = value => {
    const n = Number(value);
    return String(Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.5)));
  };
  return { '--pos-x': clampUnit(x), '--pos-y': clampUnit(y) };
}

export const PARAMETER_HELP = Object.freeze({
  workflow: { title: '图像工作流', text: '图生图用 Strength / Noise 控制原图的变化。Enhance 进行二次扩散并可调整放大档位，Max✨ 仅限 V5。Upscale 固定放大 4×，不使用 Prompt。局部重绘需要原图和 Mask。Director 工具可从图库图片详情选择。' },
  sampling: { title: '采样设置', text: 'Sampler 决定去噪算法，Noise Schedule 决定各步的噪声变化。选项随模型调整：V4 / V4.5 / V5 提供 6 种采样器和 Karras、Exponential、Polyexponential；V3 另保留 DDIM V3 与 Native。' },
  mask: { title: '绘制 Mask', text: '白色区域会被重绘。单指或鼠标拖动画笔，橡皮可擦除；撤销、重做和反选可调整范围。提交生成时会自动保存当前 Mask。' },
  advancedOverrides: { title: '高级参数覆盖 JSON', text: '这里接受额外生成参数：controlnet_condition、controlnet_model、controlnet_strength、dynamic_thresholding。Prompt、尺寸、Steps、Seed、Sampler、UC 和图片工作流使用各自控件；skip_cfg_above_sigma 对应 Variety+。模型哈希、签名、调试字段和未知导入项只作记录，不会自动发送。' },
  characterPosition: { title: '角色位置', text: 'V5 可点击或拖动位置标记，坐标保留两位小数。V4 / V4.5 提供 5×5 位置快选，也可编辑 X / Y。修改位置会开启位置引导；导入的额外坐标仍会保留。位置是构图提示，不保证严格布局。' },
  naiImport: { title: '导入方式', text: '“解析到 Tag 编辑器”恢复可编辑的标签、参数和角色位置。“原样复现并抽一发”保留原 Prompt 文字并立即提交一张生成任务。缺少原图或 Mask 时需先补充；部分放大后的 PNG 会保留旧参数，显示“待确认”时请选择实际工作流。' },
  qualityToggle: { title: '自动 Quality', text: '让模型使用质量标签。它可能改变画风，也会占用提示词容量；对比画师时请让各张图保持同一设置。', url: 'https://docs.novelai.net/en/image/qualitytags/' },
  preferBrownian: { title: 'Brownian Noise', text: '控制支持该选项的采样器如何组织随机噪声。它不是画质增强开关；影响取决于采样器。比较效果时固定 Seed，只切换这一项。', url: 'https://docs.novelai.net/en/image/sampling/' },
  varietyBoost: { title: 'Variety Boost', text: '调整采样过程中的提示词引导，让结果更有变化。不是每个模型都使用相同的参数；开启后的实际请求可以在参数预览中查看。', url: 'https://docs.novelai.net/en/image/stepsguidance/' },
  nativeAlpha: { title: '原生透明背景', text: 'V5 支持直接生成带透明通道的图片，不是生成后抠图。若需要完整场景背景请关闭；下载原图可保留透明通道。', url: 'https://docs.novelai.net/en/image/models/' },
  storm: { title: 'Storm 如何探索', text: '所有变体共用 Seed、场景与 UC，只比较画师及权重变化。权重分层覆盖指定范围，重复组合会合并。新画师从候选池等概率抽取并均衡轮换；共现不是画风相似度，也不代表质量排名。基准保留当前画师，不加入候选。' }
});
