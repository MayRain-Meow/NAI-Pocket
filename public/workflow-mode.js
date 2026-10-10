/**
 * The editor stores image workflows in the provider-compatible shape
 * (text/img2img/inpaint plus an optional imageTool).  The UI needs one stable
 * mode key so a restored Enhance or dedicated Upscale operation is visible in
 * the same control as the ordinary generation modes.
 */

export const WORKFLOW_MODE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'text', label: '文生图' }),
  Object.freeze({ value: 'img2img', label: '图生图' }),
  Object.freeze({ value: 'enhance', label: '官方 Enhance' }),
  Object.freeze({ value: 'upscale', label: '官方 Upscale' }),
  Object.freeze({ value: 'inpaint', label: '局部重绘' }),
  Object.freeze({ value: 'director', label: 'Director 工具' }),
  Object.freeze({ value: 'unknown', label: '待确认' })
]);

const KNOWN_MODE_KEYS = new Set(WORKFLOW_MODE_OPTIONS.map(item => item.value));

function compact(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function recordedOperationMode(value) {
  const text = compact(value);
  if (!text) return '';
  if (text === 'unknown') return 'unknown';
  if (/^(?:text|text2image|texttoimage|texttoimg|text2img|txt2img|txt2image|txttoimg|t2i|promptgenerate|promptgeneration|nativegenerate|generate|generateimage|imagegenerate|imagegeneration|textgeneration|texttoimagegeneration)(?:request|operation)?$/.test(text)) return 'text';
  if (/(?:infill|inpaint|nativeinfilling|maskgeneration)/.test(text)) return 'inpaint';
  if (/(?:enhance(?:upscale|image)?|upscaleenhance|upscaledenhance)/.test(text)) return 'enhance';
  if (/(?:img2img|i2i|image2image|imagetoimage)/.test(text)) return 'img2img';
  if (/(?:director|augment|lineart|sketch|bgremoval|removebackground|backgroundremoval|declutter|colorize|emotion)/.test(text)) return 'director';
  if (/^(?:upscale|upscaling|upscalingrequest|imageupscale|imageupscaling|upscaleimage|superresolution|superresolutionimage|imagesuperresolution|upscalerequest|imageupscalerequest|upscaleimagerequest|imageupscalingrequest|superresolutionimagerequest|imagesuperresolutionrequest|nativeupscale|nativeupscaling|nativeupscalerequest|nativeupscalingrequest|superresolutionrequest|upscaleoperation)$/.test(text)) return 'upscale';
  return text.includes('image') || text.includes('upscale') || text.includes('inpaint') || text.includes('infill') || text.includes('director') || text.includes('augment') || text.includes('mask') || text.includes('reference') || text.includes('vibe') ? 'unknown' : '';
}

/** Return the UI mode represented by a canonical generation state. */
export function workflowModeForState(state = {}) {
  const workflow = state?.imageWorkflow && typeof state.imageWorkflow === 'object'
    ? state.imageWorkflow : {};
  const tool = state?.imageTool && typeof state.imageTool === 'object'
    ? state.imageTool : {};
  const recovery = state?.imageRecovery && typeof state.imageRecovery === 'object'
    ? state.imageRecovery : {};
  const metadata = state?.workflowMetadata && typeof state.workflowMetadata === 'object'
    ? state.workflowMetadata : {};
  // An explicit ambiguity marker wins over a provider-compatible fallback.
  // This keeps imported text-plus-embedded-image records visible as “待确认”
  // even when an older normalizer already wrote `mode: img2img`.
  if (recovery.ambiguous === true || metadata.ambiguous === true) return 'unknown';
  const recoveryOperation = compact(recovery.operation);
  const metadataOperation = compact(metadata.operation);
  const recordedModes = [recoveryOperation, metadataOperation]
    .map(recordedOperationMode)
    .filter(Boolean);
  const distinctRecordedModes = new Set(recordedModes);
  const enhanceImg2ImgAlias = distinctRecordedModes.has('enhance') && distinctRecordedModes.has('img2img') && distinctRecordedModes.size === 2;
  if (distinctRecordedModes.has('unknown') || (distinctRecordedModes.size > 1 && !enhanceImg2ImgAlias)) return 'unknown';
  const recordedOperation = enhanceImg2ImgAlias
    ? 'enhance'
    : recoveryOperation || metadataOperation;
  if (recordedOperation === 'unknown') return 'unknown';
  // A dedicated Upscale result can retain the source PNG's old text-generation
  // Comment. Keep the canonical state text-safe, but surface the ambiguity in
  // the selector so the user can explicitly choose Text / Upscale / another
  // operation instead of trusting an invisible inference.
  const sourceStatuses = [recovery.source?.status, recovery.sourceStatus, metadata.sourceStatus, state?.embeddedInputImage?.status]
    .map(compact);
  const mediaEvidence = sourceStatuses.some(status => ['embedded', 'toolarge', 'unresolved', 'uploadfailed'].includes(status));
  if ((recordedOperation === 'text' || !recordedOperation) && mediaEvidence) return 'unknown';
  if (compact(tool.type) === 'upscale') return 'upscale';
  if (compact(tool.type) === 'director') return 'director';
  if (workflow.mode === 'inpaint') return 'inpaint';
  if (workflow.enhance === true) return 'enhance';
  if (workflow.mode === 'img2img') return 'img2img';
  // A known operation descriptor can recover a partially normalized state
  // (for example an older save with `operation: upscale` but no imageTool).
  // Do this after canonical fields, so an explicit editor choice remains the
  // source of truth while a stale unknown descriptor is still surfaced above.
  const recordedMode = recordedOperationMode(recordedOperation);
  if (recordedMode) return recordedMode;
  return 'text';
}

export function workflowModeLabel(mode) {
  const key = String(mode || '').trim().toLowerCase();
  return WORKFLOW_MODE_OPTIONS.find(item => item.value === key)?.label || '文生图';
}

export function isWorkflowMode(mode) {
  return KNOWN_MODE_KEYS.has(String(mode || '').trim().toLowerCase());
}
