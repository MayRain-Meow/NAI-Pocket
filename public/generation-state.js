// The generation-state shape, in ONE place, because the same defaults were listed in the editor
// and again as sanitize fallbacks on the server.
//
// Before this file existed, `createDefaultState()` in `public/app.js` wrote the empty groups, the
// default model, and the canvas numbers (832×1216, 28 steps, scale 5, k_euler_ancestral / karras).
// `sanitizeGenerationState()` in `src/novelai.js` wrote the same numbers again as the fallbacks
// used when a saved job, scheme, or import omitted a field. JSON/PNG import in `public/nai-import.js`
// wrote 832 / 1216 / 28 a third time when metadata had no size. A field added in one place and
// forgotten in another fails silently: the editor shows it, enqueue drops it; or a restore writes
// it and the next hydrate fills the old default.
//
// It lives in `public/` because that directory is this project's shared pure layer. The browser
// and the Node server already import prompt/parameter helpers from here, so both runtimes read
// the same object. Nothing here may touch `db.js`, `node:*` or the network — the browser loads
// this file directly.
import { DEFAULT_NAI_MODEL } from './model-utils.js?v=1.9.41';


export const DEFAULT_GENERATION_MODEL = DEFAULT_NAI_MODEL;

export const GENERATION_GROUP_KEYS = Object.freeze(['scene', 'camera', 'style', 'misc']);

export const DEFAULT_ENHANCE_UPSCALE_FACTOR = 1.5; // 空白态 / 缺数字 / 选 Enhance 的倍率；非 V5 的 max 入队仍是 2

export const DEFAULT_GENERATION_PARAMS = Object.freeze({
  width: 832,
  height: 1216,
  steps: 28,
  scale: 5,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  ucPreset: 0,
  cfgRescale: 0,
  qualityToggle: true,
  preferBrownian: true,
  sm: false,
  smDyn: false,
  deliberateEulerAncestralBug: false,
  varietyBoost: 0,
  nativeAlpha: false,
  furryMode: false,
  effort: 'high'
});

export function createDefaultGenerationState() {
  return {
    provider: 'official',
    officialAccountId: '',
    groups: Object.fromEntries(GENERATION_GROUP_KEYS.map(key => [key, []])),
    characters: [],
    v4Options: { useCoords: false, useOrder: true, negativeUseOrder: false, legacyUc: false },
    imageWorkflow: {
      mode: 'text', baseImage: null, maskImage: null, inpaintRegion: null, strength: 0.65, noise: 0,
      colorCorrect: false, enhance: false, enhanceUpscaleFactor: DEFAULT_ENHANCE_UPSCALE_FACTOR,
      enhanceTargetWidth: null, enhanceTargetHeight: null
    },
    imageTool: { type: 'none', scale: 4, reqType: '', prompt: '', defry: 0 },
    imageRecovery: null,
    workflowMetadata: null,
    referenceControl: { mode: 'none', precise: [], vibes: [] },
    promptOrderMode: 'grouped',
    prompt: '',
    negativePrompt: '',
    model: DEFAULT_GENERATION_MODEL,
    params: {
      ...DEFAULT_GENERATION_PARAMS,
      advancedOverrides: {},
      importedExtras: {}
    },
    seedMode: 'random',
    seed: 0
  };
}
