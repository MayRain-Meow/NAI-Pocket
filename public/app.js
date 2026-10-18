import {
  tokenizePrompt as tokenizePromptUtil,
  parseTagToken,
  splitInputToTags,
  formatTag as formatPromptTag,
  hasLegacyBrackets,
  unwrapLegacyBrackets,
  parseStructuredPrompt as parseStructuredPromptUtil,
  cloneTagForStorage
} from './prompt-utils.js?v=1.8.7';
import { parseNaiImport, parsePromptTagsRobust, overlayImportOntoEditor } from './nai-import.js?v=1.8.7';
import { canonicalAdvancedParameterKey, filterAdvancedOverrides, isNonAdvancedParameterKey } from './parameter-semantics.js?v=1.8.7';
import { repairImportedPrompt } from './import-repair.js?v=1.8.7';
import { normalizeProviderId, isOfficialProvider } from './provider-route.js?v=1.8.7';
import { buildNaxV5ArtistSearchUrl, identifyArtistTag, installArtistIdentityIndex, normalizeArtistIdentity, applyArtistPrefixToTagText, sameArtistIdentity } from './artist-index-v5.js?v=1.8.7';
import { collectPositiveRecommendationTags } from './storm-utils.js?v=1.8.7';
import { createArtistLibrary, createArtistAutomation, artistLibraryAvailable, artistAutomationAvailable, stormAvailable } from './owner-features.js?v=1.8.7';
import { buildArtistStormPlan } from './storm-utils.js?v=1.8.7';
import { estimatePromptTokens, extractQuotedText, v5ModelProfile } from './v5-utils.js?v=1.8.7';
import { fitGenerationDimensions, requiresSeedDecision, createTranslationDraft, editTranslationDraft, canApplyDraftTranslation, cleanArtistTranslation, stepTagWeight, characterPositionPadStyle, PARAMETER_HELP } from './editor-workspace.js?v=1.8.7';
import { workflowModeForState, workflowModeLabel } from './workflow-mode.js?v=1.8.7';
import { observeToastClearance } from './toast-layout.js?v=1.8.7';
import { installSelectSheets } from './select-sheet.js?v=1.8.7';
import { attachWeightHighlight } from './weight-highlight.js?v=1.8.7';
import { confirmAction, promptText } from './confirm-sheet.js?v=1.8.7';
import { createTaggerPanel } from './tagger-panel.js?v=1.8.7';
import { createCodexPanel } from './codex-panel.js?v=1.8.7';
import { createDefaultGenerationState, GENERATION_GROUP_KEYS, DEFAULT_ENHANCE_UPSCALE_FACTOR } from './generation-state.js?v=1.8.7';
import { characterLimitForModel as sharedCharacterLimit, isV5GenerationModel, supportsPreciseReference as sharedPreciseReference, supportsVibeTransfer as sharedVibeTransfer, supportsCharacterPrompt, DEFAULT_NAI_MODEL, DEFAULT_CHARACTER_LIMIT, modelDisplayName } from './model-utils.js?v=1.8.7';

const GROUP_LABELS_BY_KEY = {
  scene: '场景',
  camera: '镜头',
  style: '画风',
  misc: '其他'
};
const GROUP_DEFS = GENERATION_GROUP_KEYS.map(key => [key, GROUP_LABELS_BY_KEY[key]]);

const GROUP_LABELS = Object.fromEntries(GROUP_DEFS);
// The global prompt's group order. Default 画风 → 场景 → 镜头 → 其他; the user can set their own
// (分组顺序 row beside the 顺序 menu), remembered on this device. Every compile reads it through
// globalPromptOrder(), so the preview, generation and 按分类重建 always agree.
const DEFAULT_GLOBAL_PROMPT_ORDER = Object.freeze(['style', 'scene', 'camera', 'misc']);
const PROMPT_GROUP_ORDER_KEY = 'nai-prompt-group-order';
let customGlobalPromptOrder = null;
function globalPromptOrder() {
  if (!customGlobalPromptOrder) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(PROMPT_GROUP_ORDER_KEY) || 'null'); } catch {}
    customGlobalPromptOrder = Array.isArray(saved) && saved.length === DEFAULT_GLOBAL_PROMPT_ORDER.length && DEFAULT_GLOBAL_PROMPT_ORDER.every(key => saved.includes(key))
      ? saved : [...DEFAULT_GLOBAL_PROMPT_ORDER];
  }
  return customGlobalPromptOrder;
}
function setGlobalPromptOrder(order) {
  customGlobalPromptOrder = [...order];
  try { localStorage.setItem(PROMPT_GROUP_ORDER_KEY, JSON.stringify(customGlobalPromptOrder)); } catch {}
}
function renderPromptGroupOrder() {
  const host = $('#promptGroupOrder'); if (!host) return;
  const option = els.promptOrderMode?.querySelector('option[value="grouped"]');
  if (option) option.textContent = globalPromptOrderLabel();
  host.hidden = appState?.promptOrderMode === 'original';
  host.replaceChildren(...globalPromptOrder().flatMap((key, index) => {
    const chip = document.createElement('span'); chip.className = 'prompt-group-order-chip'; chip.dataset.group = key;
    if (index > 0) {
      const earlier = document.createElement('button'); earlier.type = 'button'; earlier.className = 'prompt-group-order-move'; earlier.dataset.groupEarlier = key;
      earlier.textContent = '‹'; earlier.setAttribute('aria-label', `把「${GROUP_LABELS[key] || key}」往前移`);
      chip.append(earlier);
    }
    chip.append(Object.assign(document.createElement('b'), { textContent: GROUP_LABELS[key] || key }));
    if (!index) return [chip];
    const sep = document.createElement('span'); sep.className = 'prompt-group-order-sep'; sep.setAttribute('aria-hidden', 'true'); sep.textContent = '→';
    return [sep, chip];
  }));
}
function globalPromptOrderLabel() { return globalPromptOrder().map(key => GROUP_LABELS[key] || key).join(' → '); }
const SEMANTIC_MODE_PRESETS = Object.freeze({
  precise_lookup: { topK: 20, limit: 10, popularityWeight: 0.15, useSegmentation: false, groupMode: 'off', maxPerGroup: 2 },
  subject_describe: { topK: 20, limit: 20, popularityWeight: 0.15, useSegmentation: false, groupMode: 'off', maxPerGroup: 2 },
  concept_explore: { topK: 50, limit: 80, popularityWeight: 0.15, useSegmentation: true, groupMode: 'expand', maxPerGroup: 2 },
  full_scene: { topK: 5, limit: 80, popularityWeight: 0.15, useSegmentation: true, groupMode: 'diverse', maxPerGroup: 2 }
});
const SEMANTIC_SETTINGS_KEY = 'nai-pocket-semantic-settings-v3';
const ARTIST_OVERRIDES_KEY = 'nai-pocket-artist-overrides-v1';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const uid = () => crypto.randomUUID?.() || `tag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hasCjk = value => /[\u3400-\u9fff\uf900-\ufaff]/u.test(String(value || ''));
const storageGet = key => { try { return localStorage.getItem(key); } catch { return null; } };
const storageSet = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const finiteTagWeight = (value, fallback = 1) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
const roundTagWeight = value => Math.round((finiteTagWeight(value) + Number.EPSILON) * 100) / 100;
const formatTagWeight = value => {
  const rounded = roundTagWeight(value);
  const tenths = rounded * 10;
  return Math.abs(tenths - Math.round(tenths)) < 1e-8 ? rounded.toFixed(1) : rounded.toFixed(2);
};
const finiteOriginalOrder = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const els = {
  loginView: $('#loginView'), appView: $('#appView'), loginForm: $('#loginForm'), loginPassword: $('#loginPassword'), loginError: $('#loginError'),
  tagGroups: $('#tagGroups'), tagSelectionDock: $('#tagSelectionDock'), promptPreview: $('#promptPreview'), v5PromptBudget: $('#v5PromptBudget'), negativePrompt: $('#negativePrompt'), schemeLibraryName: $('#schemeLibraryName'), schemeGrid: $('#schemeGrid'),
  queueList: $('#queueList'), queueSummary: $('#queueSummary'), cleanAdvancedOverridesButton: $('#cleanAdvancedOverridesButton'),
  galleryGrid: $('#galleryGrid'), loadMoreButton: $('#loadMoreButton'), favoriteOnly: $('#favoriteOnly'), gallerySearch: $('#gallerySearch'), galleryScopeGallery: $('#galleryScopeGallery'), galleryScopeRotation: $('#galleryScopeRotation'), galleryScopeIteration: $('#galleryScopeIteration'), galleryAgeFilter: $('#galleryAgeFilter'), galleryMonthFilter: $('#galleryMonthFilter'), galleryCustomRange: $('#galleryCustomRange'), galleryDateFrom: $('#galleryDateFrom'), galleryDateTo: $('#galleryDateTo'), galleryNewImagesButton: $('#galleryNewImagesButton'), galleryResultSummary: $('#galleryResultSummary'), storageMeter: $('#storageMeter'), storageAuditButton: $('#storageAuditButton'), queueBadge: $('#queueBadge'),
  charactersList: $('#charactersList'), addCharacterButton: $('#addCharacterButton'), characterUseCoords: $('#characterUseCoords'),
  galleryCleanupToggle: $('#galleryCleanupToggle'), gallerySelectToggle: $('#gallerySelectToggle'), gallerySelectAll: $('#gallerySelectAll'), gallerySelectNonFavorites: $('#gallerySelectNonFavorites'), galleryClearSelection: $('#galleryClearSelection'), galleryDeleteSelected: $('#galleryDeleteSelected'), gallerySelectionText: $('#gallerySelectionText'), galleryExitSelection: $('#galleryExitSelection'),
  cleanupActionBar: $('#cleanupActionBar'), cleanupSessionStatus: $('#cleanupSessionStatus'), cleanupUndoButton: $('#cleanupUndoButton'), cleanupDeleteButton: $('#cleanupDeleteButton'), cleanupKeepButton: $('#cleanupKeepButton'), cleanupLoadOriginalButton: $('#cleanupLoadOriginalButton'),
  cleanupFavoriteButton: $('#cleanupFavoriteButton'), cleanupJumpControls: $('#cleanupJumpControls'), cleanupJumpInput: $('#cleanupJumpInput'), cleanupJumpTotal: $('#cleanupJumpTotal'), cleanupJumpButton: $('#cleanupJumpButton'), imageDialogTitle: $('#imageDialogTitle'),
  imageDialog: $('#imageDialog'), dialogImage: $('#dialogImage'), dialogImageStage: $('#dialogImageStage'), dialogMeta: $('#dialogMeta'), dialogNote: $('#dialogNote'), dialogFavorite: $('#dialogFavorite'), dialogLoadOriginal: $('#dialogLoadOriginal'),
  dialogPrevious: $('#dialogPrevious'), dialogNext: $('#dialogNext'), dialogPosition: $('#dialogPosition'), dialogDownload: $('#dialogDownload'), downloadChoiceDialog: $('#downloadChoiceDialog'), imageRestoreDialog: $('#imageRestoreDialog'), imageRestoreCharacterActions: $('#imageRestoreCharacterActions'), jsonDialog: $('#jsonDialog'), jsonPreview: $('#jsonPreview'), installButton: $('#installButton'), connectionText: $('#connectionText'),
  tagEditorDialog: $('#tagEditorDialog'), tagEditorForm: $('#tagEditorForm'), tagEditorText: $('#tagEditorText'), tagEditorTranslation: $('#tagEditorTranslation'),
  tagEditorGroup: $('#tagEditorGroup'), tagEditorWeight: $('#tagEditorWeight'), tagEditorEnabled: $('#tagEditorEnabled'), translationStatus: $('#translationStatus'),
  semanticDialog: $('#semanticDialog'), semanticTargetLabel: $('#semanticTargetLabel'), semanticQuery: $('#semanticQuery'), semanticMode: $('#semanticMode'), semanticShowNsfw: $('#semanticShowNsfw'), semanticStatus: $('#semanticStatus'), semanticResults: $('#semanticResults'),
  semanticAdvanced: $('#semanticAdvanced'), semanticAdvancedSummary: $('#semanticAdvancedSummary'), semanticTopK: $('#semanticTopK'), semanticLimit: $('#semanticLimit'), semanticPopularityWeight: $('#semanticPopularityWeight'), semanticPopularityValue: $('#semanticPopularityValue'), semanticUseSegmentation: $('#semanticUseSegmentation'), semanticGroupMode: $('#semanticGroupMode'), semanticMaxPerGroup: $('#semanticMaxPerGroup'),
  semanticDisplaySemantic: $('#semanticDisplaySemantic'), semanticDisplayLayer: $('#semanticDisplayLayer'), semanticDisplaySource: $('#semanticDisplaySource'), semanticSelectionSummary: $('#semanticSelectionSummary'), semanticAddSelectedButton: $('#semanticAddSelectedButton'), semanticClearSelectedButton: $('#semanticClearSelectedButton'),
  semanticSeedSource: $('#semanticSeedSource'), semanticRelatedLimit: $('#semanticRelatedLimit'), semanticArtistLimit: $('#semanticArtistLimit'), semanticRecommendationStatus: $('#semanticRecommendationStatus'), semanticRecommendationResults: $('#semanticRecommendationResults'),
  visitorAccessPanel: $('#visitorAccessPanel'), visitorPasswordInput: $('#visitorPasswordInput'), visitorPasswordHours: $('#visitorPasswordHours'), saveVisitorPasswordButton: $('#saveVisitorPasswordButton'), revokeVisitorPasswordButton: $('#revokeVisitorPasswordButton'), visitorPasswordStatus: $('#visitorPasswordStatus'), visitorPasswordSummary: $('#visitorPasswordSummary'),
  inspectImageFile: $('#inspectImageFile'), restoreToolButton: $('#restoreToolButton'), restoreToolLabel: $('#restoreToolButton .restore-tool-label'), inspectDialog: $('#inspectDialog'), inspectPreview: $('#inspectPreview'), inspectSourceLabel: $('#inspectSourceLabel'), inspectSummary: $('#inspectSummary'), inspectPrompts: $('#inspectPrompts'), inspectFieldMap: $('#inspectFieldMap'), inspectRawParameters: $('#inspectRawParameters'), inspectWarnings: $('#inspectWarnings'), inspectActionStatus: $('#inspectActionStatus'), inspectDropOverlay: $('#inspectDropOverlay'),
  editorCommandBar: $('#editorCommandBar'), promptTagSearch: $('#promptTagSearch'), focusModeButton: $('#focusModeButton'), denseTagsButton: $('#denseTagsButton'), characterDragTargets: $('#characterDragTargets'),
  floatingGenerateBar: $('#floatingGenerateBar'), floatingGenerateButton: $('#floatingGenerateButton'), floatingQueueButton: $('#floatingQueueButton'), floatingQueueCount: $('#floatingQueueCount'),
  accountUsagePanel: $('#accountUsagePanel'), accountUsageSummary: $('#accountUsageSummary'), naiAccountUsage: $('#naiAccountUsage'), naiAccountTier: $('#naiAccountTier'), naiV5UsageText: $('#naiV5UsageText'), naiV5UsageMeter: $('#naiV5UsageMeter'), naiV5UsageHint: $('#naiV5UsageHint'), naiAnlasText: $('#naiAnlasText'), refreshNaiAccountButton: $('#refreshNaiAccountButton'),
  generationProvider: $('#generationProvider'), officialProviderPanel: $('#officialProviderPanel'), officialProviderStatus: $('#officialProviderStatus'), officialAccountSelect: $('#officialAccountSelect'), officialAccountName: $('#officialAccountName'), officialApiToken: $('#officialApiToken'), saveOfficialTokenButton: $('#saveOfficialTokenButton'), cancelOfficialTokenEdit: $('#cancelOfficialTokenEdit'), officialAccountList: $('#officialAccountList'), rbqProviderPanel: $('#rbqProviderPanel'), rbqApiKey: $('#rbqApiKey'), rbqProviderStatus: $('#rbqProviderStatus'), saveRbqKeyButton: $('#saveRbqKeyButton'),
  rbqAccountUsage: $('#rbqAccountUsage'), rbqAccountName: $('#rbqAccountName'), rbqUsageText: $('#rbqUsageText'), rbqUsageMeter: $('#rbqUsageMeter'), rbqUsageHint: $('#rbqUsageHint'), rbqRemainingText: $('#rbqRemainingText'), rbqConcurrentText: $('#rbqConcurrentText'), refreshRbqAccountButton: $('#refreshRbqAccountButton'),
  artistStormPanel: $('#artistStormPanel'), stormCount: $('#stormCount'), stormDelta: $('#stormDelta'), stormMode: $('#stormMode'), stormArtistSummary: $('#stormArtistSummary'), stormPlanPreview: $('#stormPlanPreview'), refreshStormPlanButton: $('#refreshStormPlanButton'), generateStormButton: $('#generateStormButton'), stormUseExternalArtists: $('#stormUseExternalArtists'), stormExternalControls: $('#stormExternalControls'), stormExternalPoolSize: $('#stormExternalPoolSize'), refreshStormExternalArtistsButton: $('#refreshStormExternalArtistsButton'), stormExternalArtistList: $('#stormExternalArtistList'),
  schemeDialog: $('#schemeDialog'), schemeDialogTitle: $('#schemeDialogTitle'), schemeDialogSubtitle: $('#schemeDialogSubtitle'), schemeDialogCover: $('#schemeDialogCover'), schemeDialogMeta: $('#schemeDialogMeta'), schemeDialogSections: $('#schemeDialogSections'),
  naiImportDialog: $('#naiImportDialog'), naiImportText: $('#naiImportText'), naiImportSummary: $('#naiImportSummary'), naiImportSemanticSummary: $('#naiImportSemanticSummary'), naiImportWorkflowLabel: $('#naiImportWorkflowLabel'), naiImportInputStatus: $('#naiImportInputStatus'), naiImportAdvancedCount: $('#naiImportAdvancedCount'), naiImportExtrasCount: $('#naiImportExtrasCount'), naiImportWarnings: $('#naiImportWarnings'), naiImportReview: $('#naiImportReview'), naiImportActionStatus: $('#naiImportActionStatus'),
  artistPreviewDialog: $('#artistPreviewDialog'), artistPreviewName: $('#artistPreviewName'), artistPreviewStatus: $('#artistPreviewStatus'), artistPreviewImage: $('#artistPreviewImage'), artistPreviewFallback: $('#artistPreviewFallback'),
  artistPreviewDanbooru: $('#artistPreviewDanbooru'), artistPreviewNax: $('#artistPreviewNax'), artistPreviewRetry: $('#artistPreviewRetry'), artistPreviewReject: $('#artistPreviewReject'), artistPreviewAddPrefix: $('#artistPreviewAddPrefix'),
  promptOrderMode: $('#promptOrderMode'), rebuildPromptOrderButton: $('#rebuildPromptOrderButton'),
  generationModeSwitch: $('#generationModeSwitch'), generationModeSelect: $('#generationModeSelect'), referenceModeSwitch: $('#referenceModeSwitch'), baseImageWorkflow: $('#baseImageWorkflow'), baseImageWorkflowTitle: $('#baseImageWorkflowTitle'), baseImageWorkflowHint: $('#baseImageWorkflowHint'), workflowRecoveryHint: $('#workflowRecoveryHint'),
  chooseBaseImageButton: $('#chooseBaseImageButton'), replaceBaseImageButton: $('#replaceBaseImageButton'), clearBaseImageButton: $('#clearBaseImageButton'), baseImagePreview: $('#baseImagePreview'), baseImagePlaceholder: $('#baseImagePlaceholder'), baseImageMeta: $('#baseImageMeta'), workflowSliderGrid: $('#workflowSliderGrid'), officialImageToolPanel: $('#officialImageToolPanel'), officialImageToolName: $('#officialImageToolName'), officialImageToolHint: $('#officialImageToolHint'), enhanceUpscaleFactorField: $('#enhanceUpscaleFactorField'), enhanceUpscaleFactor: $('#enhanceUpscaleFactor'), officialUpscaleScaleField: $('#officialUpscaleScaleField'), officialDirectorPromptField: $('#officialDirectorPromptField'), officialDirectorPrompt: $('#officialDirectorPrompt'), officialDirectorDefryField: $('#officialDirectorDefryField'), officialDirectorDefry: $('#officialDirectorDefry'),
  imageStrength: $('#imageStrength'), imageStrengthValue: $('#imageStrengthValue'), imageNoise: $('#imageNoise'), imageNoiseValue: $('#imageNoiseValue'), imageColorCorrect: $('#imageColorCorrect'),
  inpaintEditor: $('#inpaintEditor'), inpaintBaseImage: $('#inpaintBaseImage'), inpaintMaskCanvas: $('#inpaintMaskCanvas'), maskStatus: $('#maskStatus'), maskBrushButton: $('#maskBrushButton'), maskEraserButton: $('#maskEraserButton'), maskBrushSize: $('#maskBrushSize'), maskUndoButton: $('#maskUndoButton'), maskRedoButton: $('#maskRedoButton'), maskInvertButton: $('#maskInvertButton'), maskClearButton: $('#maskClearButton'),
  preciseReferencePanel: $('#preciseReferencePanel'), preciseReferenceList: $('#preciseReferenceList'), addPreciseReferenceButton: $('#addPreciseReferenceButton'), vibeReferencePanel: $('#vibeReferencePanel'), vibeReferenceList: $('#vibeReferenceList'), addVibeReferenceButton: $('#addVibeReferenceButton'), vibeTotalStrength: $('#vibeTotalStrength'), normalizeVibeStrengthButton: $('#normalizeVibeStrengthButton'),
  imagePickerDialog: $('#imagePickerDialog'), imagePickerTitle: $('#imagePickerTitle'), imagePickerStatus: $('#imagePickerStatus'), imagePickerGallery: $('#imagePickerGallery'), workflowImageFile: $('#workflowImageFile'), uploadWorkflowImageButton: $('#uploadWorkflowImageButton'), refreshImagePickerGallery: $('#refreshImagePickerGallery'),
  imageCreateDialog: $('#imageCreateDialog'), dialogCreateFromImage: $('#dialogCreateFromImage'), dialogSimilarFromImage: $('#dialogSimilarFromImage')
};

const paramIds = ['model', 'width', 'height', 'steps', 'scale', 'sampler', 'noiseSchedule', 'ucPreset', 'cfgRescale', 'qualityToggle', 'preferBrownian', 'varietyBoost', 'nativeAlpha', 'seedMode', 'seed', 'advancedOverrides'];

const SAMPLING_PROFILES = {
  v4: {
    samplers: [
      ['k_euler_ancestral', 'Euler Ancestral'],
      ['k_euler', 'Euler'],
      ['k_dpmpp_2s_ancestral', 'DPM++ 2S Ancestral'],
      ['k_dpmpp_2m_sde', 'DPM++ 2M SDE'],
      ['k_dpmpp_2m', 'DPM++ 2M'],
      ['k_dpmpp_sde', 'DPM++ SDE']
    ],
    schedules: [
      ['karras', 'Karras'],
      ['exponential', 'Exponential'],
      ['polyexponential', 'Polyexponential']
    ],
    defaultSampler: 'k_euler_ancestral',
    defaultSchedule: 'karras'
  },
  v3: {
    samplers: [
      ['k_euler_ancestral', 'Euler Ancestral'],
      ['k_euler', 'Euler'],
      ['k_dpmpp_2s_ancestral', 'DPM++ 2S Ancestral'],
      ['k_dpmpp_2m', 'DPM++ 2M'],
      ['k_dpmpp_sde', 'DPM++ SDE'],
      ['ddim_v3', 'DDIM V3']
    ],
    schedules: [
      ['native', 'Native'],
      ['karras', 'Karras'],
      ['exponential', 'Exponential'],
      ['polyexponential', 'Polyexponential']
    ],
    defaultSampler: 'k_euler_ancestral',
    defaultSchedule: 'karras'
  }
};

function isV5Model(model = $('#model')?.value || appState?.model) {
  return isV5GenerationModel(model);
}

function characterLimitForModel(model = $('#model')?.value || appState?.model) {
  return sharedCharacterLimit(model);
}

function supportsPreciseReference(model = $('#model')?.value || appState?.model) {
  return sharedPreciseReference(model);
}

function supportsVibeTransfer(model = $('#model')?.value || appState?.model) {
  return sharedVibeTransfer(model);
}

function samplingProfileForModel(model) {
  return supportsCharacterPrompt(model) ? SAMPLING_PROFILES.v4 : SAMPLING_PROFILES.v3;
}

function setSelectOptions(select, options, requestedValue, fallbackValue) {
  const allowed = new Set(options.map(([value]) => value));
  const nextValue = allowed.has(requestedValue) ? requestedValue : fallbackValue;
  select.innerHTML = options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  select.value = nextValue;
  return nextValue;
}

function syncSamplingOptions(model = $('#model')?.value, requested = {}) {
  const samplerSelect = $('#sampler');
  const scheduleSelect = $('#noiseSchedule');
  if (!samplerSelect || !scheduleSelect) return { sampler: requested.sampler, noiseSchedule: requested.noiseSchedule };
  const profile = samplingProfileForModel(model);
  const sampler = setSelectOptions(samplerSelect, profile.samplers, requested.sampler ?? samplerSelect.value, profile.defaultSampler);
  const noiseSchedule = setSelectOptions(scheduleSelect, profile.schedules, requested.noiseSchedule ?? scheduleSelect.value, profile.defaultSchedule);
  labelDeckSampler();
  return { sampler, noiseSchedule };
}
let appState = createDefaultState();
let authContext = { role: 'owner', expiresAt: 0 };
let artistLibrary = null;
let artistAutomation = null;
let artistOverrides = (() => {
  try {
    const parsed = JSON.parse(storageGet(ARTIST_OVERRIDES_KEY) || '{}');
    return Object.fromEntries(Object.entries(parsed || {}).filter(([, value]) => typeof value === 'boolean'));
  } catch { return {}; }
})();
const NAX_PREVIEW_TIMEOUT_MS = 26_000;
let activeArtistPreview = null;
let nativeArtistPreview = null;
let artistPreviewLoadTimer = 0;
let artistPreviewRequestId = 0;
let schemes = [];
let snippets = [];
let currentImage = null;
let galleryPage = 1;
let galleryTotal = 0;
let galleryLoaded = 0;
let loadedGalleryImages = [];
let galleryWindowStart = 0;
let galleryCursor = '';
let gallerySnapshotCursor = '';
let galleryHasMore = false;
let galleryFilterTimer = 0;
let artistRefreshAfterCompletion = 0;
let galleryNewImageCount = 0;
let galleryCompletionCursor = '';
let pendingGallerySnapshotCursor = '';
const pendingGalleryImages = new Map();
let galleryFilterSince = 0;
let galleryFilterUntil = 0;
// Which list the gallery is showing: 'gallery' for deliberate work, 'rotation' for
// artist-rotation samples. They are never mixed.
let galleryScope = 'gallery';
let galleryMasonryColumns = [];
let galleryMasonryColumnCount = 0;
let galleryEpoch = 0;
const galleryLoadRequests = new Map();
let installPrompt = null;
let pollTimer = null;
let systemTimer = null;
let storageAuditSummary = '';
let diskCapacitySnapshot = null;
let refreshJobsRequest = null;
let queueRenderSignature = '';
const jobLogRefreshAt = new Map();
const jobLogRequests = new Map();
let providerCatalog = null;
let editingOfficialAccountId = '';
let stormExternalArtistPool = [];
let latestNaiAccount = null;
let latestRbqAccount = null;
let serverMaxStormSize = 1000;
const expandedJobLogs = new Set();
const jobLogCache = new Map();
let directPromptEdited = false;
let editingTagRef = null;
let translationDraft = null;
let enqueueBusy = false;
let translationBusy = false;
let gallerySelectionMode = false;
let galleryCleanupMode = false;
const cleanupDeleteRequests = new Set();
const cleanupPendingDeletes = [];
const CLEANUP_COMMIT_DELAY_MS = 5000;
const CLEANUP_BATCH_SIZE = 20;
const GALLERY_DOM_LIMIT = 180;
let cleanupCommitTimer = 0;
let cleanupInFlightCount = 0;
let cleanupSessionKept = 0;
let cleanupSessionDeleted = 0;
let cleanupSessionCommitted = 0;
let cleanupSessionExamplesDeleted = 0;
let semanticTarget = null;
let semanticBusy = false;
let semanticSelectedTags = new Map();
let semanticLastSearchData = null;
let semanticLastRecommendationKind = '';
let semanticRecommendationTimer = null;
  let currentInspection = null;
let currentInspectionObjectUrl = '';
let inspectBusy = false;
let restoreBusy = false;
let inspectStatusTimer = 0;
let naiImportBusy = false;
const selectedGalleryIds = new Set();
const openTagGroups = new Set(['scene']);
const translationCache = new Map();
const imageDetailCache = new Map();
const imagePreviewCache = new Map();
let scheduledPreviewPrefetch = 0;
let activeEditorModule = 'all';
let editorFocusMode = false;
let denseTagsMode = false;
let tagSearchQuery = '';
let tagDragSuppressClickUntil = 0;
let activeTagDrag = null;
let editorScrollRaf = 0;
let schemesInitialized = false;
let currentSchemeDetail = null;
let activeMainTab = 'editor';
const tabScrollPositions = { editor: 0, queue: 0, scheme: 0, gallery: 0 };
let imagePickerTarget = null;
let imagePickerActionToken = 0;
const workflowAssetMeta = new Map();
let imagePickerGalleryPromise = null;
let imagePickerGalleryCache = null;
const IMAGE_PICKER_CACHE_TTL_MS = 30_000;
const IMAGE_PICKER_FETCH_TIMEOUT_MS = 30_000;
let imagePickerStatusTimer = 0;
let imagePickerStatusToken = 0;
let imagePickerGalleryStartedAt = 0;
let imagePickerActionBusy = false;
let imageCreateActionBusy = false;
let maskTool = 'brush';
let maskDrawing = false;
let maskLastPoint = null;
let maskDirty = false;
let maskHasPaint = false;
let maskHistory = [];
let maskHistoryIndex = -1;
let inpaintImageEpoch = 0;


function createDefaultState() {
  return createDefaultGenerationState();
}

function hydrateTag(item) {
  const parsed = typeof item === 'string' ? parseTagToken(item) : { ...item };
  const tag = {
    id: parsed.id || uid(),
    text: String(parsed.text || '').trim(),
    exactText: String(parsed.exactText ?? parsed.text ?? ''),
    weight: Number.isFinite(Number(parsed.weight)) ? Number(parsed.weight) : 1,
    enabled: parsed.enabled !== false,
    translation: cleanArtistTranslation(parsed.text, String(parsed.translation || '').trim()),
    bundle: parsed.bundle === true,
    preserveRaw: parsed.preserveRaw === true,
    raw: String(parsed.raw || ''),
    originalText: String(parsed.originalText ?? parsed.text ?? '').trim(),
    originalExactText: String(parsed.originalExactText ?? parsed.exactText ?? parsed.text ?? ''),
    originalWeight: Number.isFinite(Number(parsed.originalWeight)) ? Number(parsed.originalWeight) : Number(parsed.weight || 1),
    originalOrder: finiteOriginalOrder(parsed.originalOrder)
  };
  // Tags saved before 1.6.44 kept { } / [ ] inside their text at weight 1.
  // Read the bracket weight now; the original text is still what gets output.
  if (!tag.preserveRaw && Math.abs(tag.weight - 1) < 1e-9) {
    const bracket = unwrapLegacyBrackets(tag.text);
    if (bracket) {
      Object.assign(tag, { raw: tag.text, preserveRaw: true, text: bracket.text, exactText: bracket.text, weight: bracket.weight,
        originalText: bracket.text, originalExactText: bracket.text, originalWeight: bracket.weight, bundle: tag.bundle || tokenizePromptUtil(bracket.text).length > 1 });
    }
  }
  return tag;
}

// 括号权重转数字: a Tag still written as { } / [ ] switches to the numeric
// form, rounded to 0.01 (1.1025 → 1.1). Returns how many Tags changed.
function convertBracketWeights(tags) {
  let changed = 0;
  for (const tag of tags) {
    if (!hasLegacyBrackets(tag)) continue;
    const weight = Math.round(Number(tag.weight) * 100) / 100;
    Object.assign(tag, { weight, preserveRaw: false, raw: '', originalWeight: weight, originalText: tag.text, originalExactText: tag.text });
    changed += 1;
  }
  return changed;
}

function convertAllBracketWeights() {
  let changed = convertBracketWeights([
    ...GROUP_DEFS.flatMap(([key]) => appState.groups[key] || []),
    ...appState.characters.flatMap(character => [...character.promptTags, ...character.ucTags])
  ]);
  const uc = convertBracketWeights(ucChipTags());
  if (uc) commitUcChips();
  changed += uc;
  if (!changed) return toast('没有括号权重需要转换。');
  refreshTagEditor();
  toast(`已把 ${changed} 个括号权重改为数字格式，可撤销。`, 'success');
}

function createCharacter(data = {}) {
  const legacyPrompt = String(data.prompt || '').trim();
  const legacyUc = String(data.uc || '').trim();
  const promptTags = Array.isArray(data.promptTags)
    ? data.promptTags.map(hydrateTag).filter(tag => tag.text)
    : tokenizePrompt(legacyPrompt).map(token => hydrateTag(parseTagToken(token)));
  const ucTags = Array.isArray(data.ucTags)
    ? data.ucTags.map(hydrateTag).filter(tag => tag.text)
    : tokenizePrompt(legacyUc).map(token => hydrateTag(parseTagToken(token)));
  return {
    id: data.id || uid(),
    name: String(data.name || '').trim(),
    promptTags,
    ucTags,
    centers: normalizeCharacterCenters(data.centers),
    enabled: data.enabled !== false
  };
}

function normalizeCharacterCenters(value) {
  if (!Array.isArray(value) || !value.length) return [{ x: 0.5, y: 0.5 }];
  return value.slice(0, 4).map(item => ({
    x: Math.min(1, Math.max(0, Number.isFinite(Number(item?.x)) ? Number(item.x) : 0.5)),
    y: Math.min(1, Math.max(0, Number.isFinite(Number(item?.y)) ? Number(item.y) : 0.5))
  }));
}

function setCharacterPrimaryCenter(character, x, y) {
  const centers = normalizeCharacterCenters(character?.centers);
  centers[0] = {
    x: Math.min(1, Math.max(0, Number.isFinite(Number(x)) ? Number(x) : 0.5)),
    y: Math.min(1, Math.max(0, Number.isFinite(Number(y)) ? Number(y) : 0.5))
  };
  character.centers = centers;
  return centers[0];
}

function compileTagList(tags) {
  return (tags || []).filter(tag => tag.enabled !== false).map(formatTag).filter(Boolean).join(', ');
}

function normalizeDanbooruTagForNai(value) {
  return String(value || '')
    .replace(/\\([()])/g, '$1')
    .replace(/_/g, ' ')
    .trim();
}

function normalizeNaiTagForDanbooru(value) {
  return String(value || '')
    .trim()
    .replace(/^artist\s*:\s*/i, '')
    .replace(/\s+/g, '_');
}

function danbooruArtistPostsUrl(value) {
  const tag = normalizeNaiTagForDanbooru(value);
  return `https://danbooru.donmai.us/posts?tags=${encodeURIComponent(tag)}`;
}

function clearArtistPreviewLoadTimer() {
  if (!artistPreviewLoadTimer) return;
  window.clearTimeout(artistPreviewLoadTimer);
  artistPreviewLoadTimer = 0;
}

function isConfirmedArtistTag(value) {
  return identifyArtistTag(value, artistOverrides).recognized;
}

const ARTIST_PALETTE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1 0 1.6-.7 1.6-1.5 0-.4-.2-.8-.5-1.1a1.6 1.6 0 0 1 1.2-2.7h1.9a4.8 4.8 0 0 0 4.8-4.8C21 6.8 17 3.5 12 3.5z"/><circle cx="7.6" cy="11.2" r="1.25"/><circle cx="10.2" cy="7.6" r="1.25"/><circle cx="14.6" cy="7.6" r="1.25"/></svg>';

function artistJumpLinkHtml(value, className = 'tag-artist-jump', target = null) {
  const artist = identifyArtistTag(value, artistOverrides);
  if (!artist.recognized) return '';
  const targetAttrs = target ? [
    ['data-artist-scope', target.scope], ['data-artist-group', target.groupKey], ['data-artist-character', target.characterId],
    ['data-artist-kind', target.kind], ['data-artist-tag-id', target.tagId]
  ].filter(([, item]) => item).map(([name, item]) => `${name}="${escapeHtml(item)}"`).join(' ') : '';
  const detectedClass = artist.explicit ? '' : ' detected';
  const title = artist.explicit ? '预览画师作品'
    : artist.source === 'nax-v5' ? '已从 NAX V5 画师索引识别；点击审核'
    : '已从画师库识别；点击审核';
  // New-layout chips show a palette badge; legacy cards keep the ◈ mark.
  const mark = className === 'chip-artist-jump' ? ARTIST_PALETTE_ICON : '◈';
  return `<button type="button" class="${className}${detectedClass}" data-artist-preview="${escapeHtml(artist.literal)}" ${targetAttrs} aria-label="预览画师 ${escapeHtml(artist.name)}" title="${title}">${mark}</button>`;
}

function saveArtistOverride(name, value) {
  const normalized = normalizeArtistIdentity(name);
  if (!normalized) return;
  artistOverrides[normalized] = Boolean(value);
  storageSet(ARTIST_OVERRIDES_KEY, JSON.stringify(artistOverrides));
}

async function loadArtistIdentityIndex() {
  
  try {
    const data = await api('/api/artists/identities');
    installArtistIdentityIndex(data.identities || {});
    renderTagGroups();
    renderCharacters();
  } catch {
    // The NAX snapshot still classifies gallery names; roster-only tags stay unmarked until this load succeeds.
  }
}
window.addEventListener('nai-artist-resources-changed',()=>{ loadArtistIdentityIndex(); artistLibrary?.refreshList?.(); });

function artistRefFromButton(button) {
  const scope = button.dataset.artistScope;
  if (!scope || !button.dataset.artistTagId) return null;
  return scope === 'character'
    ? { scope, characterId: button.dataset.artistCharacter, kind: button.dataset.artistKind || 'prompt', id: button.dataset.artistTagId }
    : { scope: 'global', groupKey: button.dataset.artistGroup, id: button.dataset.artistTagId };
}

function releaseNativeArtistPreview() {
  if (!nativeArtistPreview) return;
  nativeArtistPreview.controller.abort();
  if (nativeArtistPreview.url) URL.revokeObjectURL(nativeArtistPreview.url);
  nativeArtistPreview = null;
}

async function loadNativeArtistPreview(artist, requestId) {
  const resource = { controller: new AbortController(), url: '' };
  nativeArtistPreview = resource;
  const current = () => nativeArtistPreview === resource && activeArtistPreview?.requestId === requestId && !activeArtistPreview.timedOut;
  try {
    // Image tags bypass the JS local API; fetch bytes through the native port first.
    const response = await fetch(`/api/nax/artist-preview?artist=${encodeURIComponent(artist.normalized)}`, { signal: resource.controller.signal });
    if (!response.ok) throw new Error((await response.json()).error || 'NAX 例图读取失败。');
    const blob = await response.blob();
    if (!current()) return;
    resource.url = URL.createObjectURL(blob);
    els.artistPreviewImage.src = resource.url;
  } catch (error) {
    if (!current() || resource.controller.signal.aborted) return;
    clearArtistPreviewLoadTimer();
    els.artistPreviewImage.classList.add('hidden');
    els.artistPreviewFallback.textContent = `${error.message} 可重试，或打开下方的来源链接。`;
    els.artistPreviewFallback.classList.remove('hidden');
    els.artistPreviewRetry?.classList.remove('hidden');
    els.artistPreviewStatus.textContent = '画师已识别 · 例图暂不可用';
  }
}

function closeArtistPreview() {
  clearArtistPreviewLoadTimer();
  releaseNativeArtistPreview();
  activeArtistPreview = null;
  if (els.artistPreviewImage) {
    els.artistPreviewImage.dataset.previewRequestId = '';
    els.artistPreviewImage.removeAttribute('src');
    els.artistPreviewImage.classList.add('hidden');
  }
  els.artistPreviewDialog?.close();
}

function openArtistPreview(button) {
  const artist = identifyArtistTag(button.dataset.artistPreview || '', artistOverrides);
  if (!artist.recognized) return;
  clearArtistPreviewLoadTimer();
  releaseNativeArtistPreview();
  if (els.artistPreviewImage) {
    els.artistPreviewImage.dataset.previewRequestId = '';
    els.artistPreviewImage.removeAttribute('src');
  }
  const requestId = ++artistPreviewRequestId;
  activeArtistPreview = { artist, ref: artistRefFromButton(button), sourceButton: button, requestId };
  els.artistPreviewName.textContent = artist.canonical || artist.name;
  els.artistPreviewStatus.textContent = artist.explicit
    ? '已由 artist: 前缀确认'
    : artist.indexed
      ? '已按 NAX V5 精确名单识别 · 请审核'
      : '已按画师库精确名单识别 · 请审核';
  els.artistPreviewDanbooru.href = danbooruArtistPostsUrl(artist.canonical || artist.name);
  els.artistPreviewNax.href = buildNaxV5ArtistSearchUrl(artist.canonical || artist.name);
  els.artistPreviewNax.textContent = 'NAX V5 作者搜索 ↗';
  els.artistPreviewReject.classList.toggle('hidden', artist.explicit);
  els.artistPreviewAddPrefix.classList.toggle('hidden', artist.explicit || !activeArtistPreview.ref);
  els.artistPreviewRetry?.classList.add('hidden');
  els.artistPreviewFallback.classList.remove('hidden');
  els.artistPreviewImage.classList.add('hidden');
  els.artistPreviewImage.dataset.previewRequestId = String(requestId);
  els.artistPreviewImage.alt = `${artist.name} 的 NAX V5 参考样图`;
  if (artist.indexed) {
    els.artistPreviewStatus.textContent += ' · 正在载入（最长约 25 秒）';
    els.artistPreviewFallback.textContent = '正在载入 NAX V5 对照图，最长约 25 秒；也可以直接打开 NAX 作者搜索。';
    artistPreviewLoadTimer = window.setTimeout(() => {
      if (!activeArtistPreview || activeArtistPreview.requestId !== requestId) return;
      activeArtistPreview.timedOut = true;
      releaseNativeArtistPreview();
      els.artistPreviewImage.removeAttribute('src');
      els.artistPreviewImage.classList.add('hidden');
      els.artistPreviewFallback.textContent = 'NAX V5 预览超过 25 秒未响应；可重试，或直接查看本机已保存的例图。';
      els.artistPreviewFallback.classList.remove('hidden');
      els.artistPreviewRetry?.classList.remove('hidden');
      els.artistPreviewStatus.textContent = '画师已识别 · NAX 预览超时';
      artistPreviewLoadTimer = 0;
      // A timed-out NAX sample is exactly when a local example is most useful.
      showLocalArtistExample(activeArtistPreview.artist, requestId);
    }, NAX_PREVIEW_TIMEOUT_MS);
    els.artistPreviewImage.addEventListener('error', () => {
      if (!activeArtistPreview || activeArtistPreview.requestId !== requestId) return;
      els.artistPreviewImage.classList.add('hidden');
      showLocalArtistExample(activeArtistPreview.artist, requestId);
    }, { once: true });
    if (window.NAI_RUNTIME?.native) loadNativeArtistPreview(artist, requestId);
    else els.artistPreviewImage.src = `/api/nax/artist-preview?artist=${encodeURIComponent(artist.normalized)}`;
  } else {
    // No NAX entry does not mean no picture: this library already stores original
    // examples for many artists, so show one instead of only explaining the gap.
    showLocalArtistExample(artist, requestId);
  }
  els.artistPreviewDialog?.showModal();
}

// Shows a locally saved example for an artist whose NAX sample is missing or
// unusable. The image comes from this library, so it is labelled as such rather
// than being passed off as a NAX V5 reference.
async function showLocalArtistExample(artist, requestId) {
  const current = () => activeArtistPreview && activeArtistPreview.requestId === requestId;
  if (!current()) return;
  if (window.NAI_RUNTIME?.native && !artistLibraryAvailable) {
    els.artistPreviewFallback.textContent = artist.indexed
      ? 'NAX V5 例图暂时不可用，本机例图库尚未接入；可重试或打开下方的来源链接。'
      : '这位画师未收录在 NAX V5 公开例图索引中，本机例图库尚未接入。';
    els.artistPreviewFallback.classList.remove('hidden');
    els.artistPreviewImage.classList.add('hidden');
    return;
  }
  els.artistPreviewFallback.textContent = '这个 artist: Tag 没有 NAX V5 对照图；正在查找本机已保存的例图…';
  els.artistPreviewFallback.classList.remove('hidden');
  let profile = null;
  try {
    const response = await api(`/api/artists/profile?artist=${encodeURIComponent(artist.canonical || artist.normalized || artist.name)}`);
    profile = response?.artist || null;
  } catch { /* An unavailable profile simply leaves the explanation in place. */ }
  if (!current()) return;
  const example = profile?.naxExample || (profile?.examples || []).find(item => item.previewUrl) || null;
  const url = example?.previewUrl || example?.thumbUrl || profile?.coverUrl || '';
  if (!url) {
    els.artistPreviewFallback.textContent = window.NAI_RUNTIME?.native && artist.indexed
      ? 'NAX 公开例图暂时不可用，本机也没有保存的例图；可重试或打开下方的来源链接。'
      : '这个 artist: Tag 不在本地 NAX V5 对照索引中，本机也还没有保存它的例图；可在下方查看画师资料，或前往 Danbooru。';
    els.artistPreviewImage.classList.add('hidden');
    return;
  }
  els.artistPreviewImage.dataset.previewRequestId = String(requestId);
  els.artistPreviewImage.alt = `${artist.name} 的本机已保存例图`;
  els.artistPreviewImage.src = url;
  els.artistPreviewImage.classList.remove('hidden');
  els.artistPreviewFallback.classList.add('hidden');
  const kind = example?.sourceType === 'nax' ? '本机 NAX V5 例图' : '本机已保存例图';
  const model = example?.model && !['original', 'unknown'].includes(example.model) ? ` · ${example.model}` : '';
  els.artistPreviewStatus.textContent = `${artist.explicit ? '已由 artist: 前缀确认' : '已按 NAX V5 精确名单识别'} · ${kind}${model}`;
}

// Note: 顶栏高度只能运行时测量，且不能只测一次（启动时工作区隐藏，高度为 0）。

// The gallery toolbar is sticky and must pin flush under the top bar. The top bar's height
// follows its content, so a hardcoded top offset drifts and leaves a gap; the measured
// height is published as `--topbar-h` for the CSS to use.
//
// Measuring once is not enough: at startup the workspace is still hidden, so the bar has no
// height yet and the first measurement would be 0. A ResizeObserver re-measures whenever the
// bar's box changes, which covers the reveal after sign-in, font loading and wrapping.
let topbarObserver = null;
function syncTopbarHeight() {
  const bar = document.querySelector('.workspace-topbar') || document.querySelector('.topbar');
  if (!bar) return 0;
  if (!topbarObserver && typeof ResizeObserver === 'function') {
    topbarObserver = new ResizeObserver(() => measureTopbar(bar));
    topbarObserver.observe(bar);
  }
  return measureTopbar(bar);
}

function measureTopbar(bar) {
  const height = Math.round(bar.getBoundingClientRect().height);
  if (!height) return 0;
  document.documentElement.style.setProperty('--topbar-h', `${height}px`);
  return height;
}

function retryArtistPreview() {  const sourceButton = activeArtistPreview?.sourceButton;
  if (sourceButton) openArtistPreview(sourceButton);
}

function ensureArtistAutomation() {
  if (!artistAutomationAvailable) throw new Error('此版本未包含画师后台管理工具。');
  if (!artistAutomation) {
    artistAutomation = createArtistAutomation({ api, toast, isReadOnly: () => authContext.role !== 'owner',
      onChanged: () => artistLibrary?.refresh(),
      onOpenResult: item => { $('#settingsDialog')?.close(); return ensureArtistLibrary().openResult({ jobId: item.id, artist: item.artist, exampleId: item.exampleId }); },
      onOpenArtist: name => { $('#settingsDialog')?.close(); return ensureArtistLibrary().open(name); }
    });
    artistAutomation.mountSettings($('#artistAnnotationSettings'));
  }
  return artistAutomation;
}

function ensureArtistLibrary() {
  if (!artistLibraryAvailable) throw new Error('本机画师栏尚未接入。');
  if (!artistLibrary) artistLibrary = createArtistLibrary({
    api, toast,
    mount: $('#artistLibraryMount'),
    onNavigate: () => switchTabTo('artists'),
    isReadOnly: () => authContext.role !== 'owner',
    // Library management (collection, annotation, rotation, covers) needs the private tools.
    canManage: () => artistAutomationAvailable,
    // Always supply the mount hook: omitting it enables the legacy embedded
    // ingestion panel in the private library. Browsing never implies management.
    mountAutomation: (host, summary) => {
      if (artistAutomationAvailable) ensureArtistAutomation().mountTasks(host, summary);
    },
    onAnnotateExample: artistAutomationAvailable ? example => ensureArtistAutomation().trial(example) : undefined,
    // The rotation's frozen prompt is captured from the workspace only when the
    // user explicitly asks for it; nothing else reads or writes it.
    //
    // The generation route is stripped, exactly as when saving a scheme: the route and its
    // token are settings, not content. Freezing them pinned the 通道 and the official
    // account for every later run, so switching to RBQ had no effect on example generation.
    // The route in use is sent with each start request instead.
    // prepareGenerationState is async: without the await, structuredClone received a Promise
    // and every 「保存基准」 failed with “#<Promise> could not be cloned”.
    captureRotationState: async () => withoutGenerationRoute(await prepareGenerationState(serializeState())),
    rotationRoute: () => currentGenerationRoute(),
    addArtist: name => authContext.role === 'owner' && addSemanticArtist({ artist: name }),
    previewArtist: name => {
      const button = document.createElement('button');
      button.dataset.artistPreview = `artist:${name}`;
      openArtistPreview(button);
    }
  });
  return artistLibrary;
}

function openArtistLibrary(artist = '') {
  if (!artistLibraryAvailable) return toast('本机画师栏尚未接入。');
  // 语义工作台是顶层 modal；不先关掉它，画师页会切到对话框后面，例图与资料看起来没反应。
  
  if (els.semanticDialog?.open) els.semanticDialog.close();
  ensureArtistLibrary();
  artistLibrary.open(artist);
}

// Native back first lets the current page unwind its own detail view.
window.addEventListener('nai-navigation-back', event => {
  if ($('#artistsTab')?.classList.contains('active') && artistLibrary?.back?.()) event.preventDefault();
});

function rejectArtistPreview() {
  const active = activeArtistPreview;
  if (!active || active.artist.explicit) return;
  saveArtistOverride(active.artist.name, false);
  closeArtistPreview();
  renderTagGroups();
  renderCharacters();
  renderSchemes();
  toast(`已记住“${active.artist.name}”不是画师；可在 Tag 前手动加 artist: 重新确认。`);
}

function addArtistPrefixFromPreview() {
  const active = activeArtistPreview;
  const found = getScopedTag(active?.ref);
  if (!active || !found || /^artist\s*:/i.test(found.tag.text)) return;
  const nextText = `artist:${found.tag.text.trim()}`;
  found.tag.text = nextText;
  found.tag.exactText = nextText;
  found.tag.preserveRaw = false;
  found.tag.raw = '';
  found.tag.originalText = nextText;
  found.tag.originalExactText = nextText;
  found.tag.originalWeight = found.tag.weight;
  saveArtistOverride(active.artist.name, true);
  closeArtistPreview();
  if (active.ref.scope === 'character') renderCharacters();
  else renderTagGroups();
  compilePromptToPreview();
  toast(`已确认画师并改为 ${nextText}。`, 'success');
}

function semanticTargetInfo(target = semanticTarget) {
  if (!target) return { label: '当前区域', tags: [] };
  if (target.scope === 'character') {
    const character = findCharacter(target.characterId);
    const index = Math.max(0, appState.characters.findIndex(item => item.id === target.characterId));
    const tags = character?.[target.kind === 'uc' ? 'ucTags' : 'promptTags'] || [];
    return { label: `角色 ${index + 1} · ${target.kind === 'uc' ? 'Character UC' : 'Character Prompt'}`, tags };
  }
  return { label: GROUP_LABELS[target.groupKey] || '全局 Tag', tags: appState.groups[target.groupKey] || [] };
}

function collectAllEnabledTags() {
  const tags = GROUP_DEFS.flatMap(([key]) => appState.groups[key] || []);
  for (const character of appState.characters) {
    if (character.enabled === false) continue;
    tags.push(...character.promptTags, ...character.ucTags);
  }
  return tags.filter(tag => tag.enabled !== false && tag.text).map(tag => normalizeNaiTagForDanbooru(tag.text));
}

function semanticTargetHas(tagName) {
  const naiTag = normalizeDanbooruTagForNai(tagName).toLowerCase();
  return semanticTargetInfo().tags.some(tag => String(tag.text || '').trim().toLowerCase() === naiTag);
}

// `quiet`: the caller reports the outcome itself (a batch add shows one summary, not one message per item).
function addSemanticTag(item, { quiet = false } = {}) {
  if (!semanticTarget || !item?.tag) return false;
  if (String(item.category || '').toLowerCase() === 'artist') return addSemanticArtist({ artist: item.tag }, { quiet });
  const text = normalizeDanbooruTagForNai(item.tag);
  const parsed = {
    ...parseTagToken(text),
    text,
    exactText: text,
    translation: String(item.cnName || ''),
    preserveRaw: false,
    raw: '',
    originalText: text,
    originalExactText: text
  };
  let added = null;
  if (semanticTarget.scope === 'character') {
    const list = getCharacterTagList(semanticTarget.characterId, semanticTarget.kind);
    if (!list) return false;
    added = addParsedTagToList(list, parsed);
    if (added) renderCharacters();
  } else {
    added = addTag(semanticTarget.groupKey, parsed, 1, true, parsed.translation, { render: false, translate: false });
    if (added) renderTagGroups();
  }
  if (added) {
    compilePromptToPreview();
    if (!quiet) toast(`已添加：${text}`, 'success');
  }
  return Boolean(added);
}

// The one place that reports adding an artist, whichever button asked (artist library, 语义, 图片反推):
// added, or already there. Callers stay silent, so one tap is one message (owner 2026-10-15).
function addSemanticArtist(item, { quiet = false } = {}) {
  const artist = String(item?.artist || '').trim();
  if (!artist) return false;
  const text = `artist:${normalizeDanbooruTagForNai(artist)}`;
  if (directPromptEdited) {
    const raw = els.promptPreview.value;
    if (tokenizePrompt(raw).some(token => normalizeArtistIdentity(parseTagToken(token).text) === normalizeArtistIdentity(artist))) {
      if (!quiet) toast(`${text} 已在 Prompt 中，没有重复添加。`);
      return false;
    }
    const existing = raw.trimEnd();
    const prompt = `${existing}${existing ? /,$/.test(existing) ? ' ' : ', ' : ''}${text}`;
    els.promptPreview.value = prompt;
    appState.prompt = prompt;
    autoGrowTextarea(els.promptPreview);
    syncV5PromptBudget(prompt);
    if (!quiet) toast(`已加入 Prompt：${text}`, 'success');
    return true;
  }
  const added = addTag('style', { ...parseTagToken(text), text, exactText: text }, 1, true, '画师', { render: false, translate: false });
  if (!added) {
    if (!quiet) toast(`${text} 已在画风中，没有重复添加。`);
    return false;
  }
  openTagGroups.add('style');
  renderTagGroups();
  compilePromptToPreview();
  if (!quiet) toast(`已加入画风：${text}`, 'success');
  return true;
}

function scorePercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) return '';
  return `${(numeric <= 1 ? numeric * 100 : numeric).toFixed(1)}%`;
}

function semanticMeta(item, kind = 'search') {
  const parts = [];
  if (item.category) parts.push(item.category);
  if (kind === 'search' && Number(item.score)) parts.push(`综合 ${scorePercent(item.score)}`);
  if (kind === 'search' && els.semanticDisplaySemantic?.checked && Number(item.semanticScore)) parts.push(`语义 ${scorePercent(item.semanticScore)}`);
  if (Number(item.postCount)) parts.push(`${formatCompactNumber(item.postCount)} posts`);
  if (els.semanticDisplayLayer?.checked && item.layer) parts.push(`匹配层 ${item.layer}`);
  if (els.semanticDisplaySource?.checked && item.source) parts.push(`来源 ${item.source}`);
  return parts.join(' · ');
}

function normalizeSemanticSeedItem(item) {
  const tag = String(item?.tag || '').trim();
  if (!tag) return null;
  return { tag, cnName: String(item?.cnName || '').trim(), category: String(item?.category || '').trim() };
}

function semanticSeedKey(tag) {
  return String(tag || '').trim().toLowerCase();
}

function selectedSemanticSeedTags() {
  return [...semanticSelectedTags.values()].map(item => item.tag);
}

function semanticTargetSeedTags() {
  return semanticTargetInfo().tags
    .filter(tag => tag.enabled !== false && tag.text)
    .map(tag => normalizeNaiTagForDanbooru(tag.text));
}

function uniqueSemanticTags(tags) {
  const seen = new Set();
  const result = [];
  for (const raw of tags || []) {
    const tag = String(raw || '').trim();
    const key = semanticSeedKey(tag);
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

function semanticRecommendationSeedTags(kind = 'related') {
  const source = els.semanticSeedSource?.value || 'selected';
  if (kind === 'artists' && (source === 'all' || (source === 'target' && semanticTarget?.scope === 'character' && semanticTarget.kind === 'uc'))) {
    return collectPositiveRecommendationTags(appState);
  }
  if (source === 'target') return uniqueSemanticTags(semanticTargetSeedTags());
  if (source === 'all') return uniqueSemanticTags(collectAllEnabledTags());
  return uniqueSemanticTags(selectedSemanticSeedTags());
}

// Short name of the target, for the 加入 button.
function semanticTargetShortLabel(target = semanticTarget) {
  if (target?.scope !== 'character') return GROUP_LABELS[target?.groupKey] || '当前区域';
  const index = Math.max(0, appState.characters.findIndex(item => item.id === target.characterId));
  return `角色 ${index + 1}${target.kind === 'uc' ? ' 负面' : ''}`;
}

function syncSemanticChips() {
  $$('[data-semantic-mode-chip]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.semanticModeChip === els.semanticMode?.value)));
  $$('[data-semantic-seed-chip]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.semanticSeedChip === (els.semanticSeedSource?.value || 'selected'))));
}

function updateSemanticSelectionSummary() {
  const count = semanticSelectedTags.size;
  const bar = $('#semanticActionBar');
  if (bar) {
    bar.hidden = count === 0;
    $('#semanticBarCount').textContent = `已选 ${count}`;
    bar.querySelector('[data-semantic-bar="add"]').textContent = `加入${semanticTargetShortLabel()}`;
  }
  syncSemanticChips();
  if (els.semanticSelectionSummary) els.semanticSelectionSummary.textContent = `已选 ${count} 个探索标签`;
  if (els.semanticAddSelectedButton) els.semanticAddSelectedButton.disabled = count === 0;
  if (els.semanticClearSelectedButton) els.semanticClearSelectedButton.disabled = count === 0;
  const kind = semanticLastRecommendationKind || 'related';
  const seeds = semanticRecommendationSeedTags(kind);
  if (els.semanticRecommendationStatus && !semanticBusy && els.semanticRecommendationResults?.classList.contains('empty-state') !== false) {
    const usesPositiveContext = kind === 'artists' && (els.semanticSeedSource?.value === 'all'
      || (els.semanticSeedSource?.value === 'target' && semanticTarget?.scope === 'character' && semanticTarget.kind === 'uc'));
    const sourceLabel = usesPositiveContext ? '已启用的正向提示词' : els.semanticSeedSource?.selectedOptions?.[0]?.textContent || '本次勾选';
    els.semanticRecommendationStatus.textContent = seeds.length
      ? `${sourceLabel}：${seeds.length} 个标签可用于${kind === 'artists' ? '画师推荐' : '关联探索'}。`
      : `${sourceLabel}暂无可用标签。`;
  }
}

function scheduleSemanticRecommendationRefresh() {
  clearTimeout(semanticRecommendationTimer);
  if (!semanticLastRecommendationKind || semanticBusy) return;
  semanticRecommendationTimer = setTimeout(() => {
    if (semanticLastRecommendationKind === 'related') runSemanticRelated({ silentEmpty: true });
    if (semanticLastRecommendationKind === 'artists') runSemanticArtists({ silentEmpty: true });
  }, 260);
}

function toggleSemanticSeed(item, checked) {
  const normalized = normalizeSemanticSeedItem(item);
  if (!normalized) return;
  const key = semanticSeedKey(normalized.tag);
  if (checked) semanticSelectedTags.set(key, normalized);
  else semanticSelectedTags.delete(key);
  updateSemanticSelectionSummary();
  if ((els.semanticSeedSource?.value || 'selected') === 'selected') scheduleSemanticRecommendationRefresh();
}

function semanticResultCard(item, index, kind, exists, seedable = true) {
  const selected = semanticSelectedTags.has(semanticSeedKey(item.tag));
  const sources = kind === 'related' && Array.isArray(item.sources) && item.sources.length
    ? `<small class="semantic-related-source">共同来源：${escapeHtml(item.sources.slice(0, 6).join(', '))}</small>` : '';
  return `<article class="semantic-result-card ${exists ? 'already-added' : ''}">
    <div class="semantic-result-main">
      <div class="semantic-result-title-row">
        ${seedable ? `<label class="semantic-seed-check" title="勾选后用于相关推荐 / 画师推荐"><input type="checkbox" data-semantic-seed="${index}" ${selected ? 'checked' : ''}><span>探索</span></label>` : ''}
        ${String(item.category || '').toLowerCase() === 'artist'
          ? `<a class="semantic-inline-artist-link" href="${escapeHtml(danbooruArtistPostsUrl(item.tag))}" target="_blank" rel="noopener noreferrer" title="在 Danbooru 查看作品"><strong>${escapeHtml(item.tag)}</strong><span aria-hidden="true">↗</span></a>`
          : `<strong>${escapeHtml(item.tag)}</strong>`}
      </div>
      <span>${escapeHtml(item.cnName || '暂无中文名')}</span>
      <small>${escapeHtml(semanticMeta(item, kind))}</small>
      ${sources}
      ${item.wiki ? `<em>${escapeHtml(item.wiki)}</em>` : ''}
    </div>
    <button type="button" class="${exists ? 'ghost' : 'primary'} semantic-result-add" data-semantic-add="${index}" ${exists ? 'disabled' : ''}>${exists ? '已有' : '添加'}</button>
  </article>`;
}

// New layout: one flat row per result. A tap selects it (the selection feeds
// 加入 and the recommendations, replacing the old 探索 checkbox); ＋ adds it
// right away. Legacy keeps semanticResultCard.
const SEMANTIC_KIND_LABELS = Object.freeze({ copyright: '作品', character: '角色', artist: '画师', meta: 'Meta' });
function semanticResultRow(item, index, kind, exists, seedable = true) {
  const selected = seedable && semanticSelectedTags.has(semanticSeedKey(item.tag));
  const category = String(item.category || '').toLowerCase();
  const label = SEMANTIC_KIND_LABELS[category] || '';
  const name = category === 'artist'
    ? `<a class="semantic-inline-artist-link" href="${escapeHtml(danbooruArtistPostsUrl(item.tag))}" target="_blank" rel="noopener noreferrer" title="在 Danbooru 查看作品"><strong>${escapeHtml(item.tag)}</strong><span aria-hidden="true">↗</span></a>`
    : `<strong>${escapeHtml(normalizeDanbooruTagForNai(item.tag))}</strong>`;
  const extras = [];
  if (kind === 'search' && els.semanticDisplaySemantic?.checked && Number(item.semanticScore)) extras.push(`语义 ${scorePercent(item.semanticScore)}`);
  if (els.semanticDisplayLayer?.checked && item.layer) extras.push(`匹配层 ${item.layer}`);
  if (els.semanticDisplaySource?.checked && item.source) extras.push(`来源 ${item.source}`);
  if (kind === 'related' && Array.isArray(item.sources) && item.sources.length) extras.push(`共同来源：${item.sources.slice(0, 6).join(', ')}`);
  return `<article class="semantic-row${selected ? ' selected' : ''}${exists ? ' exists' : ''}"${seedable ? ` data-semantic-row="${index}" role="button" tabindex="0" aria-pressed="${selected}"` : ''}>
    <span class="semantic-row-check" aria-hidden="true"></span>
    <div class="semantic-row-text">
      <div class="semantic-row-title">${name}${label ? `<i class="semantic-row-kind">${label}</i>` : ''}${Number(item.postCount) ? `<small class="semantic-row-count">${formatCompactNumber(item.postCount)}</small>` : ''}</div>
      ${item.cnName ? `<span class="semantic-row-cn">${escapeHtml(item.cnName)}</span>` : ''}
      ${item.wiki ? `<em class="semantic-row-wiki">${escapeHtml(item.wiki)}</em>` : ''}
      ${extras.length ? `<small class="semantic-row-meta">${escapeHtml(extras.join(' · '))}</small>` : ''}
    </div>
    <button type="button" class="semantic-row-add" data-semantic-add="${index}" ${exists ? 'disabled' : ''} aria-label="${exists ? '已有' : `添加 ${escapeHtml(item.tag)}`}">${exists ? '已有' : '＋'}</button>
  </article>`;
}

function renderSemanticTagResults(data, kind = 'search', container = els.semanticResults) {
  if (container === els.semanticRecommendationResults) clearSemanticRecommendationLoading(container);
  const results = Array.isArray(data?.results) ? data.results : [];
  container.classList.toggle('empty-state', !results.length);
  if (!results.length) {
    container.textContent = kind === 'related' ? '没有相关推荐结果。' : '没有结果。可换一种描述、模式或调整高级选项。';
    return;
  }
  const render = tagLayout() === 'legacy' ? semanticResultCard : semanticResultRow;
  container.innerHTML = results.map((item, index) => render(item, index, kind, semanticTargetHas(item.tag))).join('');
  container.querySelectorAll('[data-semantic-add]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    const item = results[Number(button.dataset.semanticAdd)];
    if (addSemanticTag(item)) renderSemanticTagResults(data, kind, container);
  }));
  container.querySelectorAll('[data-semantic-row]').forEach(row => {
    const toggle = () => {
      const item = results[Number(row.dataset.semanticRow)];
      const on = !semanticSelectedTags.has(semanticSeedKey(item.tag));
      row.classList.toggle('selected', on);
      row.setAttribute('aria-pressed', String(on));
      toggleSemanticSeed(item, on);
    };
    row.addEventListener('click', event => { if (!event.target.closest('a, button')) toggle(); });
    row.addEventListener('keydown', event => {
      if (event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(); }
    });
  });
  container.querySelectorAll('[data-semantic-seed]').forEach(input => input.addEventListener('change', () => {
    const item = results[Number(input.dataset.semanticSeed)];
    toggleSemanticSeed(item, input.checked);
  }));
}

function setSemanticRecommendationLoading(label = '推荐中…') {
  const container = els.semanticRecommendationResults;
  if (!container) return;
  container.setAttribute('aria-busy', 'true');
  container.classList.add('is-loading');
  const hasStableContent = container.children.length > 0 && !container.classList.contains('empty-state');
  if (!hasStableContent) {
    container.classList.remove('empty-state');
    container.innerHTML = `<div class="semantic-loading-state"><span class="semantic-loading-spinner" aria-hidden="true"></span><span>${escapeHtml(label)}</span></div>`;
  }
}

function clearSemanticRecommendationLoading(container = els.semanticRecommendationResults) {
  if (!container) return;
  container.removeAttribute('aria-busy');
  container.classList.remove('is-loading');
}

// New layout: an artist is a flat row; its most shared Tags are one muted line.
function semanticArtistRow(item, index) {
  const topTags = (item.topTags || []).slice(0, 8).map(tag => `${normalizeDanbooruTagForNai(tag.tag)}${tag.cnName ? ` ${tag.cnName}` : ''}`).join(' · ');
  return `<article class="semantic-artist-row">
    <div class="semantic-row-text">
      <div class="semantic-row-title"><a class="semantic-artist-link" href="${escapeHtml(danbooruArtistPostsUrl(item.artist))}" target="_blank" rel="noopener noreferrer" title="在 Danbooru 查看 ${escapeHtml(item.artist)} 的作品"><strong>${escapeHtml(item.artist)}</strong><span aria-hidden="true">↗</span></a><small class="semantic-row-count">共现 ${formatCompactNumber(item.coocCount)} · 作品 ${formatCompactNumber(item.postCount)}</small></div>
      ${topTags ? `<em class="semantic-row-wiki">${escapeHtml(topTags)}</em>` : ''}
    </div>
    <div class="semantic-artist-actions">
      <button type="button" data-artist-preview="artist:${escapeHtml(item.artist)}">预览</button>
      <button type="button" data-open-artist-library="${escapeHtml(item.artist)}">例图与资料</button>
      <button type="button" class="semantic-artist-add" data-artist-add="${index}" ${authContext.role === 'owner' ? '' : 'disabled'}>＋ 画风</button>
    </div>
  </article>`;
}

function renderSemanticArtistResults(data, container = els.semanticRecommendationResults) {
  clearSemanticRecommendationLoading(container);
  const results = Array.isArray(data?.results) ? data.results : [];
  container.classList.toggle('empty-state', !results.length);
  if (!results.length) {
    container.textContent = '没有画师推荐结果。';
    return;
  }
  if (tagLayout() !== 'legacy') {
    container.innerHTML = results.map(semanticArtistRow).join('');
    container.querySelectorAll('[data-artist-add]').forEach(button => button.addEventListener('click', () => addSemanticArtist(results[Number(button.dataset.artistAdd)])));
    return;
  }
  container.innerHTML = results.map((item, index) => {
    const topTags = (item.topTags || []).slice(0, 8).map(tag => `<span class="semantic-mini-chip">${escapeHtml(tag.tag)}${tag.cnName ? ` · ${escapeHtml(tag.cnName)}` : ''}</span>`).join('');
    const artistUrl = danbooruArtistPostsUrl(item.artist);
    return `<article class="semantic-result-card artist-result-card">
      <div class="semantic-result-main">
        <a class="semantic-artist-link" href="${escapeHtml(artistUrl)}" target="_blank" rel="noopener noreferrer" title="在 Danbooru 查看 ${escapeHtml(item.artist)} 的作品">
          <strong>${escapeHtml(item.artist)}</strong><span aria-hidden="true">↗</span>
        </a>
        <span>共现 ${formatCompactNumber(item.coocCount)} · 作品 ${formatCompactNumber(item.postCount)}</span>
        <small>${escapeHtml((item.sources || []).slice(0, 8).join(', '))}</small>
      </div>
      <div class="inline-actions compact-actions artist-result-actions">
        <button type="button" class="ghost" data-open-artist-library="${escapeHtml(item.artist)}">例图与资料</button>
        <button type="button" class="ghost" data-artist-preview="artist:${escapeHtml(item.artist)}">预览</button>
        <button type="button" class="primary semantic-result-add" data-artist-add="${index}" ${authContext.role === 'owner' ? '' : 'disabled'}>加入画风</button>
      </div>
      ${topTags ? `<div class="semantic-mini-chips">${topTags}</div>` : ''}
    </article>`;
  }).join('');
  container.querySelectorAll('[data-artist-add]').forEach(button => button.addEventListener('click', () => addSemanticArtist(results[Number(button.dataset.artistAdd)])));
}

function setSemanticBusy(busy, message = '') {
  semanticBusy = busy;
  ['semanticSearchButton', 'semanticRelatedButton', 'semanticArtistsButton'].forEach(id => {
    const button = $(`#${id}`);
    if (button) button.disabled = busy;
  });
  if (message) els.semanticStatus.textContent = message;
}

function selectedSemanticValues(selector, datasetKey) {
  return $$(selector).filter(input => input.checked).map(input => input.dataset[datasetKey]);
}

function semanticSettingsSnapshot() {
  return {
    mode: els.semanticMode?.value || 'subject_describe',
    topK: Number(els.semanticTopK?.value || 20),
    limit: Number(els.semanticLimit?.value || 20),
    popularityWeight: Number(els.semanticPopularityWeight?.value || 0.15),
    useSegmentation: Boolean(els.semanticUseSegmentation?.checked),
    groupMode: els.semanticGroupMode?.value || 'off',
    maxPerGroup: Number(els.semanticMaxPerGroup?.value || 2),
    showNsfw: Boolean(els.semanticShowNsfw?.checked),
    targetLayers: selectedSemanticValues('[data-semantic-layer]', 'semanticLayer'),
    targetCategories: selectedSemanticValues('[data-semantic-category]', 'semanticCategory'),
    displaySemantic: Boolean(els.semanticDisplaySemantic?.checked),
    displayLayer: Boolean(els.semanticDisplayLayer?.checked),
    displaySource: Boolean(els.semanticDisplaySource?.checked),
    relatedLimit: Number(els.semanticRelatedLimit?.value || 50),
    artistLimit: Number(els.semanticArtistLimit?.value || 64),
    seedSource: els.semanticSeedSource?.value || 'selected'
  };
}

function saveSemanticSettings() {
  storageSet(SEMANTIC_SETTINGS_KEY, JSON.stringify(semanticSettingsSnapshot()));
}

function updateSemanticAdvancedUi() {
  if (els.semanticPopularityValue) els.semanticPopularityValue.value = Number(els.semanticPopularityWeight?.value || 0).toFixed(2);
  if (els.semanticMaxPerGroup) els.semanticMaxPerGroup.disabled = els.semanticGroupMode?.value !== 'diverse';
  if (els.semanticAdvancedSummary) {
    els.semanticAdvancedSummary.textContent = `Top K ${els.semanticTopK?.value || 20} · 结果 ${els.semanticLimit?.value || 20} · 热度 ${Number(els.semanticPopularityWeight?.value || 0.15).toFixed(2)}`;
  }
  syncSemanticChips();
  saveSemanticSettings();
}

function applySemanticModePreset(mode = els.semanticMode?.value, options = {}) {
  const preset = SEMANTIC_MODE_PRESETS[mode] || SEMANTIC_MODE_PRESETS.subject_describe;
  if (els.semanticTopK) els.semanticTopK.value = preset.topK;
  if (els.semanticLimit) els.semanticLimit.value = preset.limit;
  if (els.semanticPopularityWeight) els.semanticPopularityWeight.value = preset.popularityWeight;
  if (els.semanticUseSegmentation) els.semanticUseSegmentation.checked = preset.useSegmentation;
  if (els.semanticGroupMode) els.semanticGroupMode.value = preset.groupMode;
  if (els.semanticMaxPerGroup) els.semanticMaxPerGroup.value = preset.maxPerGroup;
  updateSemanticAdvancedUi();
  if (options.announce) toast(`已载入“${els.semanticMode?.selectedOptions?.[0]?.textContent || mode}”参数。`);
}

function restoreSemanticSettings() {
  let stored = null;
  try { stored = JSON.parse(storageGet(SEMANTIC_SETTINGS_KEY) || 'null'); } catch {}
  if (!stored || typeof stored !== 'object') {
    applySemanticModePreset(els.semanticMode?.value || 'subject_describe');
    return;
  }
  if (els.semanticMode && SEMANTIC_MODE_PRESETS[stored.mode]) els.semanticMode.value = stored.mode;
  if (els.semanticTopK) els.semanticTopK.value = Math.min(50, Math.max(1, Number(stored.topK) || 20));
  if (els.semanticLimit) els.semanticLimit.value = Math.min(500, Math.max(1, Number(stored.limit) || 20));
  if (els.semanticPopularityWeight) els.semanticPopularityWeight.value = Math.min(1, Math.max(0, Number(stored.popularityWeight ?? 0.15)));
  if (els.semanticUseSegmentation) els.semanticUseSegmentation.checked = stored.useSegmentation === true;
  if (els.semanticGroupMode && ['off', 'expand', 'diverse'].includes(stored.groupMode)) els.semanticGroupMode.value = stored.groupMode;
  if (els.semanticMaxPerGroup) els.semanticMaxPerGroup.value = Math.min(50, Math.max(1, Number(stored.maxPerGroup) || 2));
  if (els.semanticShowNsfw) els.semanticShowNsfw.checked = stored.showNsfw !== false;
  const layerSet = new Set(Array.isArray(stored.targetLayers) ? stored.targetLayers : ['英文', '中文扩展词', '释义', '中文核心词']);
  $$('[data-semantic-layer]').forEach(input => { input.checked = layerSet.has(input.dataset.semanticLayer); });
  const categorySet = new Set(Array.isArray(stored.targetCategories) ? stored.targetCategories : ['General', 'Copyright', 'Character']);
  $$('[data-semantic-category]').forEach(input => { input.checked = categorySet.has(input.dataset.semanticCategory); });
  if (els.semanticDisplaySemantic) els.semanticDisplaySemantic.checked = stored.displaySemantic === true;
  if (els.semanticDisplayLayer) els.semanticDisplayLayer.checked = stored.displayLayer === true;
  if (els.semanticDisplaySource) els.semanticDisplaySource.checked = stored.displaySource === true;
  if (els.semanticRelatedLimit) els.semanticRelatedLimit.value = Math.min(200, Math.max(1, Number(stored.relatedLimit) || 50));
  if (els.semanticArtistLimit) els.semanticArtistLimit.value = Math.min(100, Math.max(1, Number(stored.artistLimit) || 64));
  if (els.semanticSeedSource && ['selected', 'target', 'all'].includes(stored.seedSource)) els.semanticSeedSource.value = stored.seedSource;
  updateSemanticAdvancedUi();
}

async function runSemanticSearch() {
  const query = els.semanticQuery.value.trim();
  if (!query) return toast('先输入要查找的画面或概念。', 'error');
  const targetLayers = selectedSemanticValues('[data-semantic-layer]', 'semanticLayer');
  const targetCategories = selectedSemanticValues('[data-semantic-category]', 'semanticCategory');
  if (!targetLayers.length) return toast('高级选项里至少选择一个匹配层。', 'error');
  if (!targetCategories.length) return toast('高级选项里至少选择一种标签类型。', 'error');
  saveSemanticSettings();
  // On a phone the keyboard would cover the results.
  if (tagLayout() !== 'legacy') els.semanticQuery.blur();
  setSemanticBusy(true, '正在调用 Danbooru 语义搜索；首次冷启动可能需要 30–60 秒…');
  els.semanticResults.classList.add('empty-state');
  els.semanticResults.textContent = '搜索中…';
  try {
    const data = await api('/api/danbooru/search', {
      method: 'POST',
      body: {
        query,
        mode: els.semanticMode.value,
        topK: Number(els.semanticTopK.value),
        limit: Number(els.semanticLimit.value),
        popularityWeight: Number(els.semanticPopularityWeight.value),
        showNsfw: els.semanticShowNsfw.checked,
        useSegmentation: els.semanticUseSegmentation.checked,
        targetLayers,
        targetCategories,
        groupMode: els.semanticGroupMode.value,
        maxPerGroup: Number(els.semanticMaxPerGroup.value)
      }
    });
    semanticLastSearchData = data;
    const cacheText = data.cached ? ' · 缓存结果' : '';
    const keywordText = data.keywords?.length ? ` · 分词：${data.keywords.slice(0, 10).join(' / ')}` : '';
    els.semanticStatus.textContent = `返回 ${data.results?.length || 0} 个结果${cacheText}${keywordText}${data.correctionNote ? ` · ${data.correctionNote}` : ''}`;
    renderSemanticTagResults(data, 'search', els.semanticResults);
  } catch (error) {
    els.semanticStatus.textContent = `语义搜索失败：${error.message}`;
    els.semanticResults.textContent = 'NovelAI 快速联想仍可正常使用。';
  } finally { setSemanticBusy(false); updateSemanticSelectionSummary(); }
}

async function runSemanticRelated(options = {}) {
  const tags = semanticRecommendationSeedTags();
  if (!tags.length) {
    if (!options.silentEmpty) toast('当前“推荐依据”没有可用 Tag。', 'error');
    return;
  }
  semanticLastRecommendationKind = 'related';
  setSemanticTab('explore');
  setSemanticBusy(true, `正在根据 ${tags.length} 个 Tag 查询共现关系…`);
  els.semanticRecommendationStatus.textContent = `相关推荐：${tags.slice(0, 6).join(', ')}${tags.length > 6 ? '…' : ''}`;
  setSemanticRecommendationLoading('正在查询相关推荐…');
  try {
    const data = await api('/api/danbooru/related', { method: 'POST', body: { tags, limit: Number(els.semanticRelatedLimit?.value || 50), showNsfw: els.semanticShowNsfw.checked } });
    els.semanticRecommendationStatus.textContent = `返回 ${data.results?.length || 0} 个搭配建议${data.cached ? ' · 缓存结果' : ''}${data.correctionNote ? ` · ${data.correctionNote}` : ''}`;
    renderSemanticTagResults(data, 'related', els.semanticRecommendationResults);
  } catch (error) {
    clearSemanticRecommendationLoading();
    els.semanticRecommendationStatus.textContent = `相关推荐失败：${error.message}`;
    els.semanticRecommendationResults.classList.add('empty-state');
    els.semanticRecommendationResults.textContent = '稍后重试。';
  } finally { setSemanticBusy(false); updateSemanticSelectionSummary(); }
}

async function runSemanticArtists(options = {}) {
  const tags = semanticRecommendationSeedTags('artists');
  if (!tags.length) {
    if (!options.silentEmpty) toast('当前“推荐依据”没有可用 Tag。', 'error');
    return;
  }
  semanticLastRecommendationKind = 'artists';
  setSemanticTab('explore');
  setSemanticBusy(true, `正在根据 ${tags.length} 个 Tag 推荐画师…`);
  const positiveContext = els.semanticSeedSource?.value === 'target' && semanticTarget?.scope === 'character' && semanticTarget.kind === 'uc';
  els.semanticRecommendationStatus.textContent = `${positiveContext ? '使用正向提示词推荐画师' : '画师推荐'}：${tags.slice(0, 6).join(', ')}${tags.length > 6 ? '…' : ''}`;
  setSemanticRecommendationLoading('正在计算画师推荐…');
  try {
    const data = await api('/api/danbooru/artists', { method: 'POST', body: { tags, limit: Number(els.semanticArtistLimit?.value || 64), minCooc: 3, showNsfw: els.semanticShowNsfw.checked } });
    els.semanticRecommendationStatus.textContent = `返回 ${data.results?.length || 0} 位画师${data.cached ? ' · 缓存结果' : ''}`;
    renderSemanticArtistResults(data, els.semanticRecommendationResults);
  } catch (error) {
    clearSemanticRecommendationLoading();
    els.semanticRecommendationStatus.textContent = `画师推荐失败：${error.message}`;
    els.semanticRecommendationResults.classList.add('empty-state');
    els.semanticRecommendationResults.textContent = '稍后重试。';
  } finally { setSemanticBusy(false); updateSemanticSelectionSummary(); }
}

function addSelectedSemanticTags() {
  if (!semanticSelectedTags.size) return;
  let added = 0;
  for (const item of semanticSelectedTags.values()) {
    if (item.category === 'Artist') {
      if (addSemanticArtist({ artist: item.tag }, { quiet: true })) added += 1;
    } else if (addSemanticTag(item, { quiet: true })) added += 1;
  }
  toast(added ? `已加入 ${added} 个 Tag。` : '选择的 Tag 已经存在。', added ? 'success' : '');
  if (semanticLastSearchData) renderSemanticTagResults(semanticLastSearchData, 'search', els.semanticResults);
}

function clearSemanticSelection() {
  semanticSelectedTags.clear();
  if (semanticLastSearchData) renderSemanticTagResults(semanticLastSearchData, 'search', els.semanticResults);
  if (semanticLastRecommendationKind === 'related') {
    els.semanticRecommendationResults.querySelectorAll('[data-semantic-seed]').forEach(input => { input.checked = false; });
    els.semanticRecommendationResults.querySelectorAll('.semantic-row.selected').forEach(row => { row.classList.remove('selected'); row.setAttribute('aria-pressed', 'false'); });
  }
  updateSemanticSelectionSummary();
}

function openSemanticSearch(target, initialQuery = '') {
  semanticTarget = target;
  // The sheet takes the target's hue (section or character).
  els.semanticDialog.dataset.targetGroup = target?.scope === 'character' ? 'character' : target?.groupKey || '';
  const info = semanticTargetInfo(target);
  els.semanticTargetLabel.textContent = `添加到：${info.label}`;
  els.semanticQuery.value = initialQuery.trim();
  semanticSelectedTags.clear();
  semanticLastSearchData = null;
  semanticLastRecommendationKind = '';
  els.semanticResults.classList.add('empty-state');
  els.semanticResults.textContent = '尚未搜索';
  els.semanticRecommendationResults.classList.add('empty-state');
  els.semanticRecommendationResults.textContent = '暂无推荐';
  els.semanticStatus.textContent = '';
  restoreSemanticSettings();
  updateSemanticSelectionSummary();
  setSemanticTab('search');
  els.semanticDialog.showModal();
  requestAnimationFrame(() => els.semanticQuery.focus());
}

function setupCollapsiblePanel(selector, storageKey) {
  const panel = $(selector);
  if (!panel || panel.dataset.collapsibleReady) return;
  const header = panel.querySelector(':scope > .panel-title-row');
  if (!header) return;
  const body = document.createElement('div');
  body.className = 'collapsible-panel-body';
  let node = header.nextSibling;
  while (node) {
    const next = node.nextSibling;
    body.append(node);
    node = next;
  }
  panel.append(body);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost panel-collapse-button';
  button.setAttribute('aria-label', '收起或展开');
  const collapseHost = header.querySelector('[data-collapse-actions]') || header;
  collapseHost.append(button);
  const apply = collapsed => {
    panel.classList.toggle('collapsed', collapsed);
    button.textContent = collapsed ? '展开' : '收起';
    button.setAttribute('aria-expanded', String(!collapsed));
  };
  const stored = storageGet(`nai-pocket-collapse-${storageKey}`);
  apply(stored === null ? storageKey === 'parameters' && tagLayout() !== 'legacy' : stored === '1');
  button.addEventListener('click', event => {
    event.preventDefault();
    const collapsed = !panel.classList.contains('collapsed');
    apply(collapsed);
    storageSet(`nai-pocket-collapse-${storageKey}`, collapsed ? '1' : '0');
  });
  panel.dataset.collapsibleReady = '1';
}

function setupCollapsiblePanels() {
  setupCollapsiblePanel('.raw-panel', 'prompt');
  setupCollapsiblePanel('.character-panel', 'characters');
  setupCollapsiblePanel('.negative-panel', 'global-uc');
  setupCollapsiblePanel('.sticky-settings', 'parameters');
}

function bindHoldRepeat(button, onStep) {
  if (!button || button.dataset.holdReady) return;
  let delayTimer = null;
  let repeatTimer = null;
  let pointerApplied = false;
  const stop = () => {
    clearTimeout(delayTimer);
    clearInterval(repeatTimer);
    delayTimer = null;
    repeatTimer = null;
    button.classList.remove('holding');
  };
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    pointerApplied = true;
    button.setPointerCapture?.(event.pointerId);
    onStep();
    delayTimer = setTimeout(() => {
      button.classList.add('holding');
      repeatTimer = setInterval(onStep, 85);
    }, 380);
  });
  ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave'].forEach(type => button.addEventListener(type, stop));
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (!pointerApplied) onStep();
    pointerApplied = false;
  });
  button.addEventListener('contextmenu', event => event.preventDefault());
  button.dataset.holdReady = '1';
}

// Banners sit just under the current page's header, never over it.
function placeToastHost() {
  const host = $('#toastHost');
  if (!host) return;
  const header = activeMainTab === 'editor' ? els.editorCommandBar : document.querySelector('.workspace-topbar');
  const bottom = header && header.offsetParent !== null ? header.getBoundingClientRect().bottom : 0;
  host.style.setProperty('--toast-top', `${Math.max(10, Math.round(bottom) + 8)}px`);
}

// The same message again restarts its timer instead of stacking a copy, and at most three messages
// stay on screen (oldest go first), so quick repeated actions never wall off the page. The update
// prompts (site banner, app update toast) live in the same host but are not messages and are never evicted.
const TOAST_LIMIT = 3;
function toast(message, type = '', { action = null } = {}) {
  placeToastHost();
  const host = $('#toastHost');
  const messages = () => [...host.querySelectorAll('.toast:not(.update-banner):not(.native-update-toast)')];
  let node = messages().find(item => item.textContent === message && item.dataset.type === type);
  if (node) clearTimeout(node.toastTimer);
  else {
    node = document.createElement('div');
    node.className = `toast ${type}`;
    node.dataset.type = type;
    node.textContent = message;
  }
  if (action) {
    node.classList.add('has-action');
    const run = document.createElement('button');
    run.type = 'button'; run.className = 'toast-action'; run.textContent = action.label;
    run.addEventListener('click', () => { clearTimeout(node.toastTimer); node.remove(); action.run(); }, { once: true });
    node.querySelector('.toast-action')?.remove(); node.append(run);
  }
  host.append(node);
  const stack = messages();
  for (const old of stack.slice(0, Math.max(0, stack.length - TOAST_LIMIT))) { clearTimeout(old.toastTimer); old.remove(); }
  node.toastTimer = setTimeout(() => node.remove(), action ? 7000 : 4200);
}

// 回收站 (1.8.4): deleted pictures wait 24 hours. The list response says whether this backend has a bin;
// only then does a delete skip its confirmation, because only then can it be undone.
let galleryTrashSupported = false, galleryTrashCount = 0;
function noteGalleryTrash(data) {
  if (typeof data?.trash === 'boolean') galleryTrashSupported = data.trash;
  if (Number.isFinite(Number(data?.trashCount))) galleryTrashCount = Number(data.trashCount);
  renderGalleryTrashButton();
}
function renderGalleryTrashButton() {
  const tab = $('#galleryScopeTrash'); if (!tab) return;
  tab.hidden = !galleryTrashSupported || authContext.role !== 'owner' || (!galleryTrashCount && galleryScope !== 'trash');
  tab.textContent = galleryTrashCount ? `回收站 ${galleryTrashCount > 99 ? '99+' : galleryTrashCount}` : '回收站';
}
async function confirmGalleryDelete(message) {
  return galleryTrashSupported || confirmAction(message, { confirmLabel: '删除', danger: true });
}
function trashedToast(ids, prefix = '') {
  const count = ids.length;
  toast(`${prefix}${count > 1 ? `${count} 张图片` : '图片'}已移到回收站，24 小时内可恢复。`, 'success', { action: { label: '撤销', run: () => restoreTrashedImages(ids) } });
}
async function restoreTrashedImages(ids) {
  try {
    const result = await api('/api/images/trash/restore', { method: 'POST', body: { ids } });
    galleryTrashCount = Number(result.trashCount) || 0; renderGalleryTrashButton();
    if (result.latestImage !== undefined) renderQuickLatest(result.latestImage || null);
    if (galleryScope === 'trash') await renderTrashView(); else await resetGallery();
    toast(`已恢复 ${result.restored.length} 张图片。`, 'success');
    return result;
  } catch (error) { toast(`恢复失败：${error.message}`, 'error'); return null; }
}
// The 回收站 view: trashed pictures in the normal grid, newest deletion first, each with 恢复 /
// 彻底删除; 全部恢复 / 清空 sit in the bar above. Search, time filters and batch modes do not apply.
let trashViewEpoch = 0;
async function renderTrashView() {
  const epoch = ++trashViewEpoch, grid = els.galleryGrid;
  let images = [];
  try { images = (await api('/api/images/trash')).images || []; }
  catch (error) { if (epoch === trashViewEpoch) { grid.textContent = `读取回收站失败：${error.message}`; } return; }
  if (epoch !== trashViewEpoch || galleryScope !== 'trash') return;
  galleryTrashCount = images.length; renderGalleryTrashButton();
  const left = image => { const hours = Math.max(0, (image.expiresAt - Date.now()) / 3600000); return hours >= 1 ? `还剩 ${Math.ceil(hours)} 小时` : `还剩 ${Math.max(1, Math.round(hours * 60))} 分钟`; };
  $('#galleryTrashRestoreAll').disabled = $('#galleryTrashEmpty').disabled = !images.length;
  $('#galleryTrashRestoreAll').onclick = async () => { $('#galleryTrashRestoreAll').disabled = true; await restoreTrashedImages(images.map(image => image.id)); };
  $('#galleryTrashEmpty').onclick = async () => {
    if (!(await confirmAction(`彻底删除回收站里的 ${images.length} 张图片？之后无法恢复。`, { confirmLabel: '清空', danger: true }))) return;
    $('#galleryTrashEmpty').disabled = true;
    try { const result = await api('/api/images/trash/purge', { method: 'POST', body: { all: true } }); noteGalleryExamplesDeleted(result); toast('回收站已清空。', 'success'); }
    catch (error) { toast(`清空失败：${error.message}`, 'error'); }
    await renderTrashView();
  };
  els.loadMoreButton.classList.add('hidden');
  if (els.galleryResultSummary) els.galleryResultSummary.textContent = images.length ? `回收站 ${images.length} 张` : '回收站是空的';
  grid.classList.toggle('empty-state', !images.length);
  if (!images.length) { grid.textContent = '回收站是空的。'; return; }
  const list = document.createElement('div'); list.className = 'gallery-trash-grid';
  list.append(...images.map(image => {
    const card = document.createElement('div'); card.className = 'gallery-trash-card'; card.dataset.trashId = image.id;
    const img = document.createElement('img'); img.src = image.thumbUrl; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    const meta = document.createElement('small'); meta.textContent = left(image);
    const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'ghost'; restore.textContent = '恢复';
    restore.addEventListener('click', async () => { restore.disabled = true; if (!(await restoreTrashedImages([image.id]))) restore.disabled = false; });
    const purge = document.createElement('button'); purge.type = 'button'; purge.className = 'ghost danger'; purge.textContent = '彻底删除';
    purge.addEventListener('click', async () => {
      if (!(await confirmAction('彻底删除这张图片？之后无法恢复。', { confirmLabel: '彻底删除', danger: true }))) return;
      try { const result = await api('/api/images/trash/purge', { method: 'POST', body: { ids: [image.id] } }); noteGalleryExamplesDeleted(result); }
      catch (error) { toast(`删除失败：${error.message}`, 'error'); }
      await renderTrashView();
    });
    const row = document.createElement('div'); row.className = 'gallery-trash-card-actions'; row.append(restore, purge);
    card.append(img, meta, row);
    return card;
  }));
  grid.replaceChildren(list);
}

// A release takes over open pages (its worker skips waiting and claims them),
// but a page keeps running the code it loaded until it reloads, so it offers
// that. An app left in the background learns of a release only when asked,
// so returning to it checks again (at most every 10 minutes).
function watchForUpdates() {
  if (!('serviceWorker' in navigator)) return;
  let controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled) { controlled = true; return; } // first install, not an update
    showUpdateBanner();
  });
  navigator.serviceWorker.register('/sw.js?v=1.8.7').then(registration => {
    let checkedAt = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - checkedAt < 10 * 60 * 1000) return;
      checkedAt = Date.now();
      registration.update().catch(() => {});
    });
  }).catch(() => {});
}

function showUpdateBanner() {
  if (document.getElementById('updateBanner')) return; // created here, not in the markup
  placeToastHost();
  const banner = document.createElement('button');
  banner.type = 'button';
  banner.id = 'updateBanner';
  banner.className = 'toast update-banner';
  banner.textContent = '新版本已就绪，点此刷新';
  banner.addEventListener('click', () => location.reload());
  $('#toastHost').prepend(banner);
}

function isAppUnauthenticated(status, payload) {
  
  return status === 401 && payload?.error === '未登录。';
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData) && !(options.body instanceof Blob) && typeof options.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
  if (response.status === 401) {
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (isAppUnauthenticated(response.status, payload)) {
      showLogin();
      throw new Error('登录已失效。');
    }
    throw new Error(payload.error || response.statusText || '请求未被授权。');
  }
  if (!response.ok) {
    let message = response.statusText;
    try { message = (await response.json()).error || message; } catch { message = (await response.text()) || message; }
    const error = new Error(message);
    error.status = response.status;
    const retryAfter = Number(response.headers.get('retry-after'));
    if (retryAfter > 0) error.retryAfterMs = retryAfter * 1000;
    throw error;
  }
  if (response.status === 204) return null;
  const type = response.headers.get('content-type') || '';
  return type.includes('application/json') ? response.json() : response.blob();
}

function showLogin() {
  authContext = { role: 'owner', expiresAt: 0 };
  document.body.classList.remove('visitor-mode');
  $('#settingsDialog')?.close();
  artistAutomation?.reset();
  artistLibrary?.reset();
  els.loginView.classList.remove('hidden');
  els.appView.classList.add('hidden');
  if (pollTimer) clearInterval(pollTimer);
  if (systemTimer) clearInterval(systemTimer);
}

function showApp() {
  els.loginView.classList.add('hidden');
  els.appView.classList.remove('hidden');
}

function applyAuthContext(context = {}) {
  authContext = { role: context.role === 'visitor' ? 'visitor' : 'owner', expiresAt: Number(context.visitorExpiresAt || context.expiresAt || 0) };
  document.body.classList.toggle('visitor-mode', authContext.role === 'visitor');
  if (els.connectionText && authContext.role === 'visitor') els.connectionText.textContent = '参观模式 · 只读';
}

function formatExpiry(timestamp) {
  if (!timestamp) return '未设置';
  return new Date(Number(timestamp)).toLocaleString('zh-CN', { hour12: false });
}

async function refreshVisitorPasswordStatus() {
  if (authContext.role !== 'owner' || !els.visitorPasswordStatus) return;
  try {
    const status = await api('/api/auth/visitor-password');
    els.visitorPasswordStatus.textContent = status.enabled ? `已启用 · 到期 ${formatExpiry(status.expiresAt)}` : '尚未设置临时密码。';
    if (els.visitorPasswordSummary) els.visitorPasswordSummary.textContent = status.enabled ? `到期 ${formatExpiry(status.expiresAt)}` : '尚未启用';
  } catch (error) {
    els.visitorPasswordStatus.textContent = error.message;
  }
}

function normalizeTag(raw) {
  return String(raw || '').trim().replace(/^,+|,+$/g, '').trim();
}

function tokenizePrompt(raw) { return tokenizePromptUtil(raw); }

function splitTagInput(raw) {
  return tokenizePrompt(raw);
}

function parseWeightedTag(raw, options = {}) { return parseTagToken(raw, options); }

function stripWeightSyntax(raw) {
  return parseWeightedTag(raw).text.replace(/^[{[(]+|[}\])]+$/g, '').trim().toLowerCase().replace(/_/g, ' ');
}

// 镜头 is composition: framing, angle, viewpoint and focus. `cropped` is only the
// framing sense (cropped legs), not clothing (cropped jacket).
const CAMERA_TAG_PATTERN = /\b(views?|shot|angle|perspective|portrait|close-up|close up|upper body|lower body|full body|cowboy shot|from (?:above|below|side|the side|behind|front|outside)|pov|profile|foreshortening|depth of field|focus|bokeh|blurry (?:background|foreground)|dynamic angle|dutch angle|tilted frame|fisheye|wide shot|panorama|worm's-eye|bird's-eye|aerial|out of frame|cropped (?:legs|torso|arms|shoulders|head|body)|straight-on|sideways|upside-down|split screen|symmetry|centered|rule of thirds|vanishing point)\b/;
const STYLE_TAG_PATTERN = /\bartist\b|\byear \d{4}\b|\b(game cg|artbook|masterpiece|quality|aesthetic|highres|absurdres|detailed|newest|best quality|amazing quality|no text|anime|realistic|photorealistic|watercolor|oil painting|sketch|lineart|monochrome|3d|pixel art|illustration|official art|render|cel shading|impasto|style)\b/;
const SCENE_TAG_PATTERN = /\b(background|indoors|outdoors|room|bedroom|street|city|forest|beach|ocean|mountain|sky|cloud|rain|snow|weather|night|day|sunset|sunrise|garden|school|office|cafe|restaurant|grass|field|flower|tree|light|lighting|shadow|glow|glowing|backlight|rim light|volumetric|cinematic|studio light|soft light|dramatic|neon|atmosphere|ambient)\b/;

function classifyTag(raw) {
  const text = stripWeightSyntax(raw);
  // An explicit artist is 画风 before anything else: names such as artist:focus_(…) or
  // artist:portrait_studio used to be taken by the 镜头 words inside them.
  if (/^artist\s*:/.test(text)) return 'style';
  if (CAMERA_TAG_PATTERN.test(text)) return 'camera';
  if (STYLE_TAG_PATTERN.test(text)) return 'style';
  if (SCENE_TAG_PATTERN.test(text)) return 'scene';
  // A bare artist name (fuzichoco, wanke) is recognized by the artist index — last, so a
  // general Tag can never be taken for an artist; the user's overrides decide either way.
  if (identifyArtistTag(parseWeightedTag(raw).text, artistOverrides).recognized) return 'style';
  return 'misc';
}

function groupedGlobalTags(groups = appState.groups) {
  return globalPromptOrder().flatMap(key => groups?.[key] || []);
}

function nextGlobalOriginalOrder(groups = appState.groups) {
  let maxOrder = -1;
  for (const tag of groupedGlobalTags(groups)) {
    const value = finiteOriginalOrder(tag?.originalOrder);
    if (value !== null) maxOrder = Math.max(maxOrder, value);
  }
  return maxOrder + 1;
}

function ensureGlobalOriginalOrder(groups = appState.groups) {
  let next = nextGlobalOriginalOrder(groups);
  // Missing values are appended in the current card/group order without disturbing imported positions.
  for (const tag of groupedGlobalTags(groups)) {
    if (finiteOriginalOrder(tag?.originalOrder) !== null) continue;
    tag.originalOrder = next++;
  }
  return groups;
}

function rebuildGlobalOriginalOrderFromGrouped(groups = appState.groups) {
  let order = 0;
  for (const tag of groupedGlobalTags(groups)) tag.originalOrder = order++;
  return order;
}

function seedOriginalOrderFromPrompt(groups, prompt) {
  const all = groupedGlobalTags(groups);
  const used = new Set();
  let order = 0;
  for (const token of tokenizePrompt(prompt || '')) {
    const parsed = parseTagToken(token);
    const parsedText = String(parsed.text || '').trim();
    const parsedWeight = finiteTagWeight(parsed.weight, 1);
    const match = all.find(tag => !used.has(tag) && String(tag.text || '').trim() === parsedText && Math.abs(finiteTagWeight(tag.weight, 1) - parsedWeight) < 0.0001);
    if (!match) continue;
    match.originalOrder = order++;
    used.add(match);
  }
  for (const tag of all) {
    if (used.has(tag)) continue;
    tag.originalOrder = order++;
  }
  return order;
}

function globalTagsForPrompt() {
  const tags = groupedGlobalTags();
  if (appState.promptOrderMode !== 'original') return tags;
  ensureGlobalOriginalOrder();
  return tags
    .map((tag, index) => ({ tag, index, order: finiteOriginalOrder(tag.originalOrder) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => (a.order - b.order) || (a.index - b.index))
    .map(item => item.tag);
}

function globalPromptText() {
  return globalTagsForPrompt()
    .filter(item => item.enabled !== false)
    .map(formatTag)
    .filter(Boolean)
    .join(', ');
}

function combinedPromptText() {
  const sections = [];
  appState.characters.filter(ch => ch.enabled !== false).forEach((ch, index) => {
    const prompt = compileTagList(ch.promptTags);
    const uc = compileTagList(ch.ucTags);
    if (ch.name) sections.push(`Character ${index + 1} Name: ${ch.name}`);
    if (prompt) sections.push(`Character ${index + 1} Prompt: ${prompt}`);
    if (uc) sections.push(`Character ${index + 1} UC: ${uc}`);
    if (ch.name || prompt || uc) sections.push('');
  });
  const global = globalPromptText();
  if (global) sections.push(`Global Prompt: ${global}`);
  if (els.negativePrompt?.value.trim()) sections.push(`Global UC: ${els.negativePrompt.value.trim()}`);
  return sections.join('\n').trim();
}

function findCharacter(characterId) {
  return appState.characters.find(item => item.id === characterId) || null;
}

function getScopedTag(ref) {
  if (!ref) return null;
  if (ref.scope === 'uc') {
    const list = ucChipTags();
    const index = list.findIndex(item => item.id === ref.id);
    return index >= 0 ? { tag: list[index], index, group: list } : null;
  }
  if (ref.scope === 'character') {
    const character = findCharacter(ref.characterId);
    const list = character?.[ref.kind === 'uc' ? 'ucTags' : 'promptTags'];
    if (!list) return null;
    const index = list.findIndex(item => item.id === ref.id);
    return index >= 0 ? { tag: list[index], index, group: list, character } : null;
  }
  return getTag(ref.groupKey, ref.id);
}

function getTag(groupKey, id) {
  const group = appState.groups[groupKey] || [];
  const index = group.findIndex(item => item.id === id);
  return index >= 0 ? { tag: group[index], index, group } : null;
}

function tagKey(tag) {
  return `${String(tag.text || '').trim().toLowerCase()}|${finiteTagWeight(tag.weight)}|${tag.bundle === true ? 'bundle' : 'single'}`;
}

function addParsedTagToList(list, parsed, options = {}) {
  const prefixedText = applyArtistPrefixToTagText(parsed?.text, artistOverrides);
  const incoming = prefixedText === String(parsed?.text || '').trim()
    ? parsed
    : { ...parsed, text: prefixedText, exactText: prefixedText, originalText: prefixedText, originalExactText: prefixedText, preserveRaw: false, raw: '' };
  const tag = hydrateTag({ ...incoming, id: parsed.id || uid() });
  if (!tag.text) return null;
  // 画师按身份去重：已有 `1.2::artist:anmi::` 时再加入裸 artist:anmi 不算新卡。
  
  const existing = list.find(item => sameArtistIdentity(item.text, tag.text, artistOverrides) || tagKey(item) === tagKey(tag));
  if (existing) {
    if (tag.translation && !existing.translation) existing.translation = tag.translation;
    return null;
  }
  list.push(tag);
  if (tag.translation) translationCache.set(tag.text.toLowerCase(), tag.translation);
  return tag;
}

function addTag(groupKey, raw, weight = 1, enabled = true, translation = '', options = {}) {
  const group = appState.groups[groupKey] || (appState.groups[groupKey] = []);
  const parsed = typeof raw === 'object' && raw !== null
    ? { ...raw }
    : { ...parseTagToken(raw), weight: finiteTagWeight(weight), enabled: enabled !== false, translation };
  if (translation && !parsed.translation) parsed.translation = translation;
  const tag = addParsedTagToList(group, parsed, options);
  if (!tag) return null;
  if (appState.promptOrderMode === 'original' && finiteOriginalOrder(tag.originalOrder) === null) tag.originalOrder = nextGlobalOriginalOrder();
  openTagGroups.add(groupKey);
  if (options.render !== false) {
    renderTagGroups();
    compilePromptToPreview();
  }
  if (!tag.translation && !hasCjk(tag.text) && options.translate !== false) requestTagTranslation(groupKey, tag.id).catch(() => {});
  return tag;
}

function addTagBatch(groupKey, raw, options = {}) {
  const group = appState.groups[groupKey] || (appState.groups[groupKey] = []);
  const mode = options.mode === 'whole' ? 'whole' : 'split';
  const parsedTags = splitInputToTags(raw, mode);
  const added = [];
  for (const parsed of parsedTags) {
    const tag = addParsedTagToList(group, parsed, options);
    if (tag) {
      if (appState.promptOrderMode === 'original' && finiteOriginalOrder(tag.originalOrder) === null) tag.originalOrder = nextGlobalOriginalOrder();
      added.push(tag);
    }
  }
  if (!added.length) return [];
  openTagGroups.add(groupKey);
  if (options.render !== false) {
    renderTagGroups();
    compilePromptToPreview();
  }
  if (options.translate !== false) translateSpecificTags(added.slice(0, 20)).catch(() => {});
  return added;
}

function getCharacterTagList(characterId, kind) {
  const character = findCharacter(characterId);
  if (!character) return null;
  return kind === 'uc' ? character.ucTags : character.promptTags;
}

function addCharacterTagBatch(characterId, kind, raw, options = {}) {
  const list = getCharacterTagList(characterId, kind);
  if (!list) return [];
  const mode = options.mode === 'whole' ? 'whole' : 'split';
  const parsedTags = splitInputToTags(raw, mode);
  const added = [];
  for (const parsed of parsedTags) {
    const tag = addParsedTagToList(list, parsed, options);
    if (tag) added.push(tag);
  }
  if (options.render !== false && added.length) {
    renderCharacters();
    compilePromptToPreview();
  }
  if (options.translate !== false && added.length) translateSpecificTags(added.slice(0, 20)).catch(() => {});
  return added;
}

function formatTag(tag) { return formatPromptTag(tag); }

function compiledPrompt() {
  return globalPromptText();
}

function updatePromptOrderUi() {
  const mode = appState.promptOrderMode === 'original' ? 'original' : 'grouped';
  if (els.promptOrderMode) els.promptOrderMode.value = mode;
  // 1.8.7: a two-way switch replaces the menu; 按分组重排 only means something while keeping order.
  $$('[data-prompt-order]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.promptOrder === mode)));
  if (els.rebuildPromptOrderButton) els.rebuildPromptOrderButton.hidden = mode !== 'original';
  const groupOrder = $('#promptGroupOrder'); if (groupOrder) groupOrder.hidden = mode === 'original';
}

function updatePromptModeHint() {
  const hint = $('#promptModeHint');
  if (!hint) return;
  // The order is shown by the 顺序 switch; the title chip only flags hand-edited text, and only then
  // is 按卡片重写文本 offered (otherwise the text already is the cards).
  hint.hidden = !directPromptEdited;
  const sync = $('#syncPromptButton'); if (sync) sync.hidden = !directPromptEdited;
  if (directPromptEdited) {
    hint.textContent = '已手动修改';
    hint.dataset.mode = 'direct';
  } else if (appState.promptOrderMode === 'original') {
    hint.textContent = '保持顺序';
    hint.dataset.mode = 'cards';
  } else {
    hint.textContent = '分类顺序';
    hint.dataset.mode = 'cards';
  }
  updatePromptOrderUi();
}

function autoGrowTextarea(element) {
  if (!element) return;
  element.style.height = 'auto';
  const maxHeight = Math.max(320, Math.floor(window.innerHeight * 0.62));
  const nextHeight = Math.min(Math.max(element.scrollHeight, 170), maxHeight);
  element.style.height = `${nextHeight}px`;
  element.style.overflowY = element.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function syncV5PromptBudget(value = els.promptPreview?.value || appState.prompt || '') {
  const node = els.v5PromptBudget;
  if (!node) return;
  const profile = v5ModelProfile($('#model')?.value || appState.model);
  if (!profile) {
    node.hidden = true;
    node.textContent = '';
    node.removeAttribute('data-state');
    return;
  }
  const prompt = String(value || '').trim();
  const estimatedTokens = estimatePromptTokens(prompt);
  const quoted = extractQuotedText(prompt);
  const quotedCharacters = quoted.reduce((total, item) => total + [...item].length, 0);
  const tokenRatio = estimatedTokens / profile.promptTokenLimit;
  const textRatio = quotedCharacters / profile.textCharacterLimit;
  const state = tokenRatio >= 1 || textRatio > 1 ? 'over' : tokenRatio >= .85 || textRatio >= .85 ? 'warn' : 'ok';
  const textSummary = quoted.length
    ? `引号文字 ${quotedCharacters}/${profile.textCharacterLimit} 字符`
    : `文字上限 ${profile.textCharacterLimit} 字符`;
  node.hidden = false;
  node.dataset.state = state;
  node.textContent = `${profile.label} · Prompt 估算 ${estimatedTokens}/${profile.promptTokenLimit} tokens · ${textSummary}${quoted.length ? ' · 生成时自动补 Text:' : ''}`;
  node.title = '估算值仅用于提醒；NovelAI 上游 tokenizer 才是最终限制。V5 引号文字会在请求参数末尾补 Text: 块。';
}

function compilePromptToPreview(force = false) {
  captureTagHistory();
  scheduleDraftSave();
  const prompt = combinedPromptText();
  if (directPromptEdited && !force) {
    updatePromptModeHint();
    syncV5PromptBudget(els.promptPreview.value);
    updatePromptMeter();
    return prompt;
  }
  appState.prompt = prompt;
  els.promptPreview.value = prompt;
  directPromptEdited = false;
  updatePromptModeHint();
  autoGrowTextarea(els.promptPreview);
  syncV5PromptBudget(prompt);
  updatePromptMeter();
  return prompt;
}

function splitPrompt(text) {
  return tokenizePrompt(text);
}

function translationVisible() {
  return $('#showTranslations')?.checked !== false;
}


function enabledTagCount(tags = []) {
  return tags.filter(tag => tag.enabled !== false && String(tag.text || '').trim()).length;
}

function updateEditorModuleCounts() {
  const moduleNav = $('.module-nav');
  if (moduleNav) {
    let jumps = moduleNav.querySelector('.character-jump-nav');
    if (!jumps) {
      jumps = document.createElement('span');
      jumps.className = 'character-jump-nav';
      moduleNav.querySelector('[data-editor-nav="characters"]')?.after(jumps);
    }
    jumps.innerHTML = appState.characters.map((character, index) => `<button type="button" class="ghost" data-character-jump="${escapeHtml(character.id)}">角色${index + 1}</button>`).join('');
  }
  for (const [key] of GROUP_DEFS) {
    const node = document.querySelector(`[data-module-count="${key}"]`);
    if (node) node.textContent = enabledTagCount(appState.groups[key] || []);
  }
  const characterNode = document.querySelector('[data-module-count="characters"]');
  if (characterNode) characterNode.textContent = appState.characters.filter(ch => ch.enabled !== false).length;
  const ucNode = document.querySelector('[data-module-count="uc"]');
  if (ucNode) ucNode.textContent = tokenizePrompt(els.negativePrompt?.value || appState.negativePrompt || '').length;
}

function setEditorNavActive(name) {
  activeEditorModule = name || 'all';
  document.querySelectorAll('[data-editor-nav]').forEach(button => {
    button.classList.toggle('active', button.dataset.editorNav === activeEditorModule);
  });
}

function editorModuleElement(name) {
  if (GROUP_LABELS[name]) return document.querySelector(`.tag-group[data-group="${name}"]`);
  if (name === 'characters') return document.querySelector('[data-editor-module="characters"]');
  if (name === 'uc') return document.querySelector('[data-editor-module="uc"]');
  return document.querySelector('[data-editor-module="scheme"]');
}

function ensureEditorModuleOpen(name) {
  if (GROUP_LABELS[name]) {
    openTagGroups.add(name);
    const group = document.querySelector(`.tag-group[data-group="${name}"]`);
    if (group) group.open = true;
  }
  if (name === 'characters') {
    const panel = document.querySelector('[data-editor-module="characters"]');
    if (panel?.classList.contains('collapsed')) panel.querySelector('.panel-collapse-button')?.click();
  }
  if (name === 'uc') {
    const panel = document.querySelector('[data-editor-module="uc"]');
    if (panel?.classList.contains('collapsed')) panel.querySelector('.panel-collapse-button')?.click();
  }
}

function scrollToEditorModule(name) {
  const target = editorModuleElement(name);
  if (!target) return;
  ensureEditorModuleOpen(name);
  requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function applyEditorFocusMode({ scroll = false } = {}) {
  document.body.classList.toggle('editor-focus-mode', editorFocusMode);
  const panels = document.querySelectorAll('.editor-column > [data-editor-module]');
  const tagPanel = document.querySelector('[data-editor-module="tags"]');
  const globalTarget = GROUP_LABELS[activeEditorModule] ? activeEditorModule : null;

  panels.forEach(panel => panel.classList.remove('focus-hidden'));
  document.querySelectorAll('.tag-group').forEach(group => group.classList.remove('focus-hidden'));

  if (editorFocusMode) {
    panels.forEach(panel => panel.classList.add('focus-hidden'));
    if (globalTarget) {
      tagPanel?.classList.remove('focus-hidden');
      document.querySelectorAll('.tag-group').forEach(group => {
        group.classList.toggle('focus-hidden', group.dataset.group !== globalTarget);
      });
      ensureEditorModuleOpen(globalTarget);
    } else if (activeEditorModule === 'characters') {
      document.querySelector('[data-editor-module="characters"]')?.classList.remove('focus-hidden');
    } else if (activeEditorModule === 'uc') {
      document.querySelector('[data-editor-module="uc"]')?.classList.remove('focus-hidden');
    }
  }

  els.focusModeButton?.setAttribute('aria-pressed', String(editorFocusMode));
  els.focusModeButton?.classList.toggle('active', editorFocusMode);
  storageSet('nai-pocket-focus-mode', editorFocusMode ? '1' : '0');
  storageSet('nai-pocket-active-module', activeEditorModule);
  setEditorNavActive(activeEditorModule);
  applyTagSearch();
  if (scroll && activeEditorModule !== 'all') requestAnimationFrame(() => editorModuleElement(activeEditorModule)?.scrollIntoView({ block: 'start' }));
}

function selectEditorModule(name, { scroll = true, fromScroll = false } = {}) {
  if (name === 'all') {
    editorFocusMode = false;
    setEditorNavActive('all');
    applyEditorFocusMode();
    if (scroll) document.querySelector('#editorTab')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (!GROUP_LABELS[name] && !['characters', 'uc'].includes(name)) return;
  setEditorNavActive(name);
  ensureEditorModuleOpen(name);
  if (editorFocusMode) applyEditorFocusMode({ scroll: scroll && !fromScroll });
  else if (scroll && !fromScroll) scrollToEditorModule(name);
}

function setDenseTagsMode(enabled) {
  denseTagsMode = Boolean(enabled);
  document.body.classList.toggle('dense-tags', denseTagsMode);
  els.denseTagsButton?.classList.toggle('active', denseTagsMode);
  els.denseTagsButton?.setAttribute('aria-pressed', String(denseTagsMode));
  storageSet('nai-pocket-dense-tags', denseTagsMode ? '1' : '0');
}

function normalizeSearchValue(value) {
  return String(value || '').trim().toLocaleLowerCase('zh-CN');
}

function cardMatchesTagSearch(card, query) {
  if (!query) return true;
  return normalizeSearchValue(card.dataset.searchText || card.textContent).includes(query);
}

function restoreCharacterUcOpenState(details) {
  if (!details?.dataset.characterUcId) return;
  details.dataset.searchForcedOpen = '0';
  details.open = storageGet(`nai-pocket-character-uc-${details.dataset.characterUcId}`) === '1';
}

function applyTagSearch() {
  const query = normalizeSearchValue(tagSearchQuery || els.promptTagSearch?.value || '');
  tagSearchQuery = query;
  document.body.classList.toggle('tag-search-active', Boolean(query));

  document.querySelectorAll('.tag-card').forEach(card => {
    card.classList.toggle('search-hidden', !cardMatchesTagSearch(card, query));
  });

  document.querySelectorAll('.tag-group').forEach(group => {
    const cards = [...group.querySelectorAll('.tag-card')];
    const hasMatch = !query || cards.some(card => !card.classList.contains('search-hidden'));
    group.classList.toggle('search-group-hidden', Boolean(query) && !hasMatch);
    if (query && hasMatch) group.open = true;
    else if (!query) group.open = openTagGroups.has(group.dataset.group);
  });

  document.querySelectorAll('.character-card').forEach(card => {
    const ownName = normalizeSearchValue(card.querySelector('.character-head')?.textContent || '');
    const tagCards = [...card.querySelectorAll('.tag-card')];
    const hasTagMatch = tagCards.some(item => !item.classList.contains('search-hidden'));
    const visible = !query || hasTagMatch || ownName.includes(query);
    card.classList.toggle('search-character-hidden', !visible);
    card.querySelectorAll('details.character-uc-area').forEach(details => {
      const ucMatch = [...details.querySelectorAll('.tag-card')].some(item => !item.classList.contains('search-hidden'));
      if (query && ucMatch) {
        details.dataset.searchForcedOpen = '1';
        details.open = true;
      } else if (!query) restoreCharacterUcOpenState(details);
    });
  });
}

function scheduleEditorScrollSync() {
  if (editorScrollRaf || editorFocusMode || document.querySelector('.tab[data-tab="editor"]')?.classList.contains('active') !== true) return;
  editorScrollRaf = requestAnimationFrame(() => {
    editorScrollRaf = 0;
    const threshold = (els.editorCommandBar?.getBoundingClientRect().bottom || 150) + 24;
    const candidates = [
      ...GROUP_DEFS.map(([key]) => ({ name: key, el: document.querySelector(`.tag-group[data-group="${key}"]`) })),
      { name: 'characters', el: document.querySelector('[data-editor-module="characters"]') },
      { name: 'uc', el: document.querySelector('[data-editor-module="uc"]') }
    ].filter(item => item.el && !item.el.classList.contains('focus-hidden'));
    let best = null;
    for (const item of candidates) {
      const rect = item.el.getBoundingClientRect();
      if (rect.bottom < threshold - 60) continue;
      const distance = Math.abs(rect.top - threshold);
      if (!best || distance < best.distance) best = { ...item, distance };
    }
    if (best) setEditorNavActive(best.name);
  });
}

function tagListForDragRef(ref) {
  if (!ref) return null;
  if (ref.scope === 'global') return appState.groups[ref.groupKey] || null;
  if (ref.scope === 'character') return getCharacterTagList(ref.characterId, ref.kind);
  return null;
}

function dragRefLabel(ref) {
  if (!ref) return '目标区域';
  if (ref.scope === 'global') return GROUP_LABELS[ref.groupKey] || '全局 Tag';
  const index = appState.characters.findIndex(ch => ch.id === ref.characterId);
  return `角色 ${index >= 0 ? index + 1 : ''} · ${ref.kind === 'uc' ? 'UC' : 'Prompt'}`.trim();
}

function prepareTagDropZone(list, ref) {
  if (!list || !ref) return;
  list.dataset.tagDropScope = ref.scope;
  if (ref.scope === 'global') list.dataset.tagDropGroup = ref.groupKey;
  if (ref.scope === 'character') {
    list.dataset.tagDropCharacter = ref.characterId;
    list.dataset.tagDropKind = ref.kind;
  }
}

function dragRefFromDropZone(zone) {
  if (!zone) return null;
  if (zone.dataset.tagDropScope === 'global') return { scope: 'global', groupKey: zone.dataset.tagDropGroup };
  if (zone.dataset.tagDropScope === 'character') return { scope: 'character', characterId: zone.dataset.tagDropCharacter, kind: zone.dataset.tagDropKind };
  return null;
}

function sameDragRef(a, b) {
  if (!a || !b || a.scope !== b.scope) return false;
  if (a.scope === 'global') return a.groupKey === b.groupKey;
  return a.characterId === b.characterId && a.kind === b.kind;
}

function renderCharacterDragTargets(sourceRef) {
  if (!els.characterDragTargets) return;
  els.characterDragTargets.innerHTML = '';
  if (sourceRef?.scope !== 'global' || !appState.characters.length) return;
  const label = document.createElement('span');
  label.className = 'character-drag-target-label';
  label.textContent = '移到角色';
  els.characterDragTargets.append(label);
  appState.characters.forEach((character, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'character-drag-target';
    button.dataset.characterDragTarget = character.id;
    button.textContent = `角色 ${index + 1}`;
    els.characterDragTargets.append(button);
  });
}

function clearTagDropIndicators() {
  document.querySelectorAll('.tag-drop-active, .tag-drop-at-end, .tag-drop-before, .drag-nav-target').forEach(node => {
    node.classList.remove('tag-drop-active', 'tag-drop-at-end', 'tag-drop-before', 'drag-nav-target');
  });
}

function insertionIndexForPoint(zone, x, y) {
  if (!zone) return 0;
  const cards = [...zone.querySelectorAll(':scope > .tag-card:not(.drag-origin):not(.search-hidden)')];
  for (let i = 0; i < cards.length; i += 1) {
    const rect = cards[i].getBoundingClientRect();
    const sameRow = y >= rect.top && y <= rect.bottom;
    if (y < rect.top + rect.height / 2 || (sameRow && x < rect.left + rect.width / 2)) return i;
  }
  return cards.length;
}

function resolveTagDragTarget(x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;

  const characterQuickTarget = hit.closest?.('[data-character-drag-target]');
  if (characterQuickTarget && activeTagDrag?.sourceRef?.scope === 'global') {
    const ref = { scope: 'character', characterId: characterQuickTarget.dataset.characterDragTarget, kind: 'prompt' };
    return { ref, zone: null, index: tagListForDragRef(ref)?.length || 0, highlight: characterQuickTarget, viaNav: true };
  }

  const nav = hit.closest?.('[data-editor-nav]');
  if (nav && GROUP_LABELS[nav.dataset.editorNav]) {
    const ref = { scope: 'global', groupKey: nav.dataset.editorNav };
    const list = document.querySelector(`.tag-list[data-tag-drop-group="${nav.dataset.editorNav}"]`);
    return { ref, zone: list, index: tagListForDragRef(ref)?.length || 0, highlight: nav, viaNav: true };
  }

  let zone = hit.closest?.('[data-tag-drop-scope]');
  if (!zone) {
    const group = hit.closest?.('.tag-group[data-group]');
    if (group) zone = group.querySelector('[data-tag-drop-scope]');
  }
  if (!zone) {
    const area = hit.closest?.('[data-character-area]');
    if (area) zone = area.querySelector('[data-tag-drop-scope]');
  }
  if (!zone) return null;
  const ref = dragRefFromDropZone(zone);
  if (!ref) return null;
  const index = insertionIndexForPoint(zone, x, y);
  const visibleCards = [...zone.querySelectorAll(':scope > .tag-card:not(.drag-origin):not(.search-hidden)')];
  return { ref, zone, index, beforeTagId: visibleCards[index]?.dataset.tagId || null, highlight: zone, viaNav: false };
}

function paintTagDragTarget(target) {
  clearTagDropIndicators();
  if (!target) return;
  target.highlight?.classList.add(target.viaNav ? 'drag-nav-target' : 'tag-drop-active');
  if (target.viaNav || !target.zone) return;
  const cards = [...target.zone.querySelectorAll(':scope > .tag-card:not(.drag-origin):not(.search-hidden)')];
  if (target.index < cards.length) cards[target.index]?.classList.add('tag-drop-before');
  else target.zone.classList.add('tag-drop-at-end');
}

function updateTagDragPosition(x, y) {
  const drag = activeTagDrag;
  if (!drag?.dragging) return;
  drag.lastX = x;
  drag.lastY = y;
  if (drag.ghost) {
    drag.ghost.style.left = `${x}px`;
    drag.ghost.style.top = `${y}px`;
  }
  const trashBox = drag.trash?.getBoundingClientRect();
  const overTrash = Boolean(trashBox && y <= trashBox.bottom + 6 && x >= trashBox.left && x <= trashBox.right);
  drag.target = overTrash ? { trash: true, highlight: drag.trash, zone: null, viaNav: true } : resolveTagDragTarget(x, y);
  paintTagDragTarget(drag.target);
  if (overTrash) { drag.autoScroll = 0; return; }

  const topBand = Math.max(86, (els.editorCommandBar?.getBoundingClientRect().bottom || 0) + 18);
  const bottomBand = window.innerHeight - Math.max(105, (els.floatingGenerateBar?.getBoundingClientRect().height || 0) + 28);
  if (y < topBand) drag.autoScroll = -Math.min(22, Math.max(4, (topBand - y) * 0.24));
  else if (y > bottomBand) drag.autoScroll = Math.min(22, Math.max(4, (y - bottomBand) * 0.24));
  else drag.autoScroll = 0;
}

function runTagDragAutoScroll() {
  const drag = activeTagDrag;
  if (!drag?.dragging) return;
  if (drag.autoScroll && !drag.target?.trash) {
    window.scrollBy(0, drag.autoScroll);
    drag.target = resolveTagDragTarget(drag.lastX, drag.lastY);
    paintTagDragTarget(drag.target);
  }
  drag.raf = requestAnimationFrame(runTagDragAutoScroll);
}

function beginTagDrag(card, sourceRef, tag, x, y) {
  if (!card || !tag || activeTagDrag?.dragging) return;
  const sourceList = tagListForDragRef(sourceRef);
  if (!sourceList?.some(item => item.id === tag.id)) return;

  const ghost = card.cloneNode(true);
  ghost.classList.add('tag-drag-ghost');
  ghost.classList.remove('drag-origin', 'search-hidden');
  ghost.querySelectorAll('button').forEach(button => button.tabIndex = -1);
  // The ghost leaves its list, so pin its exact size and carry the section
  // hue; otherwise it shrink-wraps and its text can wrap into a tall sliver.
  const box = card.getBoundingClientRect();
  ghost.style.setProperty('--ghost-w', `${Math.round(Math.min(box.width, window.innerWidth - 24))}px`);
  ghost.style.setProperty('--ghost-h', `${Math.round(box.height)}px`);
  const hue = getComputedStyle(card).getPropertyValue('--hue').trim();
  if (hue) ghost.style.setProperty('--hue', hue);
  ghost.style.width = `${Math.round(Math.min(box.width, window.innerWidth - 24))}px`;
  document.body.append(ghost);
  // Drop on the 松手删除 zone at the top to delete (undoable).
  const trash = document.createElement('div');
  trash.className = 'tag-drag-trash';
  trash.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 11v5M13.5 11v5"/></svg><span>拖到这里，松手删除</span>';
  document.body.append(trash);
  renderCharacterDragTargets(sourceRef);
  card.classList.add('drag-origin');
  document.body.classList.add('tag-drag-active');
  navigator.vibrate?.(12);

  activeTagDrag = {
    ...(activeTagDrag || {}),
    dragging: true,
    sourceRef,
    tagId: tag.id,
    originCard: card,
    ghost,
    trash,
    lastX: x,
    lastY: y,
    autoScroll: 0,
    target: null,
    raf: 0
  };
  updateTagDragPosition(x, y);
  activeTagDrag.raf = requestAnimationFrame(runTagDragAutoScroll);
}

function commitTagDrag() {
  const drag = activeTagDrag;
  if (!drag?.dragging) return false;
  const target = drag.target;
  const sourceList = tagListForDragRef(drag.sourceRef);
  if (target?.trash) {
    const index = sourceList?.findIndex(item => item.id === drag.tagId) ?? -1;
    if (index < 0) return false;
    const [removed] = sourceList.splice(index, 1);
    renderTagGroups();
    renderCharacters();
    compilePromptToPreview();
    updateEditorModuleCounts();
    toast(`已删除「${removed.text}」，可撤销。`);
    return true;
  }
  const targetList = target ? tagListForDragRef(target.ref) : null;
  const sourceIndex = sourceList?.findIndex(item => item.id === drag.tagId) ?? -1;
  if (!target || !sourceList || !targetList || sourceIndex < 0) return false;

  const [tag] = sourceList.splice(sourceIndex, 1);
  let targetIndex;
  if (target.beforeTagId) {
    const beforeIndex = targetList.findIndex(item => item.id === target.beforeTagId);
    targetIndex = beforeIndex >= 0 ? beforeIndex : targetList.length;
  } else {
    targetIndex = Math.max(0, Math.min(Number(target.index) || 0, targetList.length));
  }
  targetList.splice(targetIndex, 0, tag);
  if (target.ref.scope === 'global') {
    if (appState.promptOrderMode === 'original' && finiteOriginalOrder(tag.originalOrder) === null) tag.originalOrder = nextGlobalOriginalOrder();
    openTagGroups.add(target.ref.groupKey);
  } else if (drag.sourceRef?.scope === 'global') {
    // Once a Global Tag becomes a Character Tag, its old Global slot is no longer meaningful.
    tag.originalOrder = null;
  }

  renderTagGroups();
  renderCharacters();
  compilePromptToPreview();
  updateEditorModuleCounts();
  selectEditorModule(target.ref.scope === 'global' ? target.ref.groupKey : 'characters', { scroll: false });
  const preservesGlobalOrder = appState.promptOrderMode === 'original' && drag.sourceRef?.scope === 'global' && target.ref.scope === 'global';
  toast(`已移动到 ${dragRefLabel(target.ref)}。${preservesGlobalOrder ? ' 保持顺序模式下生成先后未改变。' : ''}`, 'success');
  return true;
}

function finishTagDrag({ commit = true } = {}) {
  const drag = activeTagDrag;
  if (!drag) return;
  if (drag.timer) clearTimeout(drag.timer);
  if (drag.raf) cancelAnimationFrame(drag.raf);
  const wasDragging = Boolean(drag.dragging);
  if (wasDragging && commit) commitTagDrag();
  drag.originCard?.classList.remove('drag-origin');
  drag.ghost?.remove();
  drag.trash?.remove();
  clearTagDropIndicators();
  if (els.characterDragTargets) els.characterDragTargets.innerHTML = '';
  document.body.classList.remove('tag-drag-active');
  if (wasDragging) tagDragSuppressClickUntil = Date.now() + 420;
  activeTagDrag = null;
}

function bindLongPressTagDrag(card, sourceRef, tag) {
  if (!card || card.dataset.longPressDragReady) return;
  card.dataset.longPressDragReady = '1';
  const eligibleSurface = target => Boolean(target.closest?.('.tag-copy, .drag-handle'));

  // Touch: a stationary 360 ms hold enters drag mode. Before that, normal vertical swipes still scroll the page.
  card.addEventListener('touchstart', event => {
    if (event.touches.length !== 1 || !eligibleSurface(event.target) || activeTagDrag) return;
    const touch = event.touches[0];
    const pending = {
      dragging: false,
      sourceRef,
      tagId: tag.id,
      originCard: card,
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      timer: null
    };
    activeTagDrag = pending;
    pending.timer = setTimeout(() => {
      if (activeTagDrag !== pending) return;
      beginTagDrag(card, sourceRef, tag, pending.lastX, pending.lastY);
    }, 360);
  }, { passive: true });

  card.addEventListener('touchmove', event => {
    const drag = activeTagDrag;
    if (!drag || drag.originCard !== card || event.touches.length !== 1) return;
    const touch = event.touches[0];
    drag.lastX = touch.clientX;
    drag.lastY = touch.clientY;
    if (!drag.dragging) {
      if (Math.hypot(touch.clientX - drag.startX, touch.clientY - drag.startY) > 10) finishTagDrag({ commit: false });
      return;
    }
    event.preventDefault();
    updateTagDragPosition(touch.clientX, touch.clientY);
  }, { passive: false });

  card.addEventListener('touchend', event => {
    const drag = activeTagDrag;
    if (!drag || drag.originCard !== card) return;
    if (drag.dragging) event.preventDefault();
    finishTagDrag({ commit: true });
  }, { passive: false });
  card.addEventListener('touchcancel', () => {
    if (activeTagDrag?.originCard === card) finishTagDrag({ commit: false });
  }, { passive: true });

  // Desktop: the visible handle starts immediately, avoiding HTML5 drag-and-drop inconsistencies.
  card.querySelector('.drag-handle')?.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || activeTagDrag) return;
    event.preventDefault();
    const pending = { dragging: false, sourceRef, tagId: tag.id, originCard: card, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY };
    activeTagDrag = pending;
    beginTagDrag(card, sourceRef, tag, event.clientX, event.clientY);
    const move = moveEvent => {
      if (activeTagDrag?.originCard !== card) return;
      moveEvent.preventDefault();
      updateTagDragPosition(moveEvent.clientX, moveEvent.clientY);
    };
    const up = upEvent => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (activeTagDrag?.originCard === card) {
        upEvent.preventDefault();
        finishTagDrag({ commit: true });
      }
    };
    const cancel = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (activeTagDrag?.originCard === card) finishTagDrag({ commit: false });
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up, { passive: false });
    window.addEventListener('pointercancel', cancel, { passive: true });
  });
}

function renderTagGroups() {
  const active = document.activeElement?.dataset?.tagInput || null;
  const selection = active ? { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd, value: document.activeElement.value } : null;
  els.tagGroups.innerHTML = '';
  const flowLayout = tagLayout() !== 'legacy';
  for (const [key, label] of GROUP_DEFS) {
    const tags = appState.groups[key] || [];
    if (flowLayout) { els.tagGroups.append(createTagSection(key, label, tags)); continue; }
    const group = document.createElement('details');
    group.className = 'tag-group';
    group.dataset.group = key;
    group.open = openTagGroups.has(key);
    group.innerHTML = `
      <summary class="tag-group-header"><strong>${escapeHtml(label)}</strong><span class="tag-count">${tags.filter(x => x.enabled !== false).length}/${tags.length}</span></summary>
      <div class="tag-group-body">
        <div class="tag-list" data-drop-group="${key}"></div>
        <div class="tag-add">
          <input autocomplete="off" enterkeyhint="done" autocapitalize="none" spellcheck="false" placeholder="${tagLayout() === 'legacy' ? '回车按逗号拆分；Shift+Enter 整块添加' : '继续添加…'}" title="回车按逗号拆分；Shift+Enter 整块添加" data-tag-input="${key}">
          <button type="button" class="primary tag-add-button" data-add-group="${key}" aria-label="拆分添加 Tag">＋</button>
          <div class="tag-extra-actions">
            <button type="button" class="ghost whole-add-button" data-whole-group="${key}" aria-label="整块添加">整块</button>
            <button type="button" class="ghost semantic-open-button" data-semantic-group="${key}" aria-label="Danbooru 语义搜索">语义</button>
          </div>
          <div class="suggestion-menu hidden" data-suggestions="${key}" role="listbox"></div>
        </div>
      </div>`;
    group.addEventListener('toggle', () => {
      if (tagSearchQuery) return;
      if (group.open) openTagGroups.add(key);
      else openTagGroups.delete(key);
    });
    const list = group.querySelector('.tag-list');
    prepareTagDropZone(list, { scope: 'global', groupKey: key });
    tags.forEach(tag => list.append(createTagCard(key, tag)));
    els.tagGroups.append(group);
  }
  bindTagInputs();
  updateEditorModuleCounts();
  applyTagSearch();
  if (editorFocusMode) applyEditorFocusMode();
  if (tagSelection.size) renderTagDock();
  updateTranslateHint();
  if (active && selection) {
    requestAnimationFrame(() => {
      const input = $(`[data-tag-input="${active}"]`);
      if (!input) return;
      input.value = selection.value;
      input.focus({ preventScroll: true });
      input.setSelectionRange(selection.start, selection.end);
    });
  }
}

function characterAreaHtml(ch, kind, label) {
  const count = (kind === 'uc' ? ch.ucTags : ch.promptTags).filter(tag => tag.enabled !== false).length;
  const body = `
      <div class="character-tag-list" data-character-list="${ch.id}:${kind}"></div>
      <div class="tag-add character-tag-add">
        <input autocomplete="off" enterkeyhint="done" autocapitalize="none" spellcheck="false" placeholder="${tagLayout() === 'legacy' ? '中英文均可；回车按逗号拆分' : '继续添加…'}" title="中英文均可；回车按逗号拆分" data-character-input="${ch.id}:${kind}">
        <button type="button" class="primary tag-add-button" data-character-add="${ch.id}:${kind}" title="拆分添加">＋</button>
        <div class="tag-extra-actions">
          <button type="button" class="ghost whole-add-button" data-character-whole="${ch.id}:${kind}" title="整段作为一个块添加">整块</button>
          <button type="button" class="ghost semantic-open-button" data-character-semantic="${ch.id}:${kind}" title="Danbooru 语义搜索">语义</button>
        </div>
        <div class="suggestion-menu hidden" data-character-suggestions="${ch.id}:${kind}" role="listbox"></div>
      </div>`;

  if (kind === 'uc') {
    const open = storageGet(`nai-pocket-character-uc-${ch.id}`) === '1';
    return `
      <details class="character-tag-area character-uc-area" data-character-area="${ch.id}:${kind}" data-character-uc-id="${ch.id}" ${open ? 'open' : ''}>
        <summary class="character-tag-title character-uc-summary"><strong>${label}</strong><span>${count}</span><em>${open ? '收起' : '展开'}</em></summary>
        <div class="character-tag-body">${body}</div>
      </details>`;
  }
  return `
    <section class="character-tag-area" data-character-area="${ch.id}:${kind}">
      <div class="character-tag-title"><strong>${label}</strong><span>${count}</span></div>
      ${body}
    </section>`;
}

function characterPositionHtml(ch, index = 0) {
  const centers = normalizeCharacterCenters(ch.centers);
  const center = centers[0];
  const x = Math.min(1, Math.max(0, finiteTagWeight(center.x, 0.5)));
  const y = Math.min(1, Math.max(0, finiteTagWeight(center.y, 0.5)));
  const v5 = isV5Model(appState.model);
  const points = [0.1, 0.3, 0.5, 0.7, 0.9];
  const nearestX = points.reduce((best, value) => Math.abs(value - x) < Math.abs(best - x) ? value : best, points[0]);
  const nearestY = points.reduce((best, value) => Math.abs(value - y) < Math.abs(best - y) ? value : best, points[0]);
  const cells = points.flatMap(py => points.map(px => {
    const active = Math.abs(px - nearestX) < 0.001 && Math.abs(py - nearestY) < 0.001;
    return `<button type="button" class="character-position-cell ${active ? 'active' : ''}" data-character-position-cell="${ch.id}" data-x="${px}" data-y="${py}" title="${px.toFixed(1)}, ${py.toFixed(1)}" aria-label="角色 ${index + 1} 位置 ${px.toFixed(1)}, ${py.toFixed(1)}"></button>`;
  })).join('');
  const padVars = characterPositionPadStyle(x, y);
  const positionControl = v5
    ? `<div class="character-position-pad v5-position-pad" data-character-position-pad="${ch.id}" style="--pos-x:${padVars['--pos-x']};--pos-y:${padVars['--pos-y']}" role="application" aria-label="角色 ${index + 1} V5 连续位置编辑">
          <span class="character-position-axis axis-x" aria-hidden="true">左 0 · 右 1</span>
          <span class="character-position-axis axis-y" aria-hidden="true">上 0 · 下 1</span>
          <button type="button" class="character-position-marker" data-character-position-marker="${ch.id}" aria-label="角色 ${index + 1} 当前坐标 ${x.toFixed(2)}, ${y.toFixed(2)}"></button>
        </div>`
    : `<div class="character-position-grid" aria-label="角色 ${index + 1} 位置 5×5 快选">${cells}</div>`;
  return `
    <details class="character-position-box">
      <summary><strong>${v5 ? 'V5 连续位置' : '位置建议'}</strong><span data-character-position-summary>${appState.v4Options?.useCoords ? '已启用 · ' : '未启用 · '}X ${x.toFixed(2)} · Y ${y.toFixed(2)}${centers.length > 1 ? ` · 已保留 ${centers.length} 个坐标` : ''}</span><button class="parameter-help-button inline-help-button" type="button" data-parameter-help="characterPosition" aria-label="角色位置说明">?</button></summary>
      <div class="character-position-body">
        <div class="character-position-inputs">
          <label>X（左 0 → 右 1）<input type="number" min="0" max="1" step="${v5 ? '0.01' : '0.05'}" inputmode="decimal" data-character-x="${ch.id}" value="${x.toFixed(2)}"></label>
          <label>Y（上 0 → 下 1）<input type="number" min="0" max="1" step="${v5 ? '0.01' : '0.05'}" inputmode="decimal" data-character-y="${ch.id}" value="${y.toFixed(2)}"></label>
        </div>
        ${positionControl}
      </div>
    </details>`;
}

function updateCharacterPositionUi(character) {
  const card = els.charactersList?.querySelector(`[data-character-card="${CSS.escape(character.id)}"]`);
  if (!card) return;
  const centers = normalizeCharacterCenters(character.centers);
  const center = centers[0];
  const centerCount = centers.length;
  const x = center.x.toFixed(2);
  const y = center.y.toFixed(2);
  const summary = card.querySelector('[data-character-position-summary]');
  if (summary) summary.textContent = `${appState.v4Options?.useCoords ? '已启用 · ' : '未启用 · '}X ${x} · Y ${y}${centerCount > 1 ? ` · 已保留 ${centerCount} 个坐标` : ''}`;
  const xInput = card.querySelector(`[data-character-x="${CSS.escape(character.id)}"]`);
  const yInput = card.querySelector(`[data-character-y="${CSS.escape(character.id)}"]`);
  if (xInput) xInput.value = x;
  if (yInput) yInput.value = y;
  const pad = card.querySelector(`[data-character-position-pad="${CSS.escape(character.id)}"]`);
  if (pad) {
    const vars = characterPositionPadStyle(center.x, center.y);
    pad.style.setProperty('--pos-x', vars['--pos-x']);
    pad.style.setProperty('--pos-y', vars['--pos-y']);
  }
  const marker = card.querySelector(`[data-character-position-marker="${CSS.escape(character.id)}"]`);
  if (marker) {
    marker.setAttribute('aria-label', `当前坐标 ${x}, ${y}`);
    // Note: Chromium 会把 details 收起时算出来的 left/top % 冻成 0px；打开后再写一次才会按现有盒子重算。
    
    const box = pad?.getBoundingClientRect();
    if (box?.width && box?.height) {
      marker.style.left = 'calc(var(--pos-x) * 100%)';
      marker.style.top = 'calc(var(--pos-y) * 100%)';
    } else {
      marker.style.removeProperty('left');
      marker.style.removeProperty('top');
    }
  }
  const points = [0.1, 0.3, 0.5, 0.7, 0.9];
  const nearestX = points.reduce((best, value) => Math.abs(value - center.x) < Math.abs(best - center.x) ? value : best, points[0]);
  const nearestY = points.reduce((best, value) => Math.abs(value - center.y) < Math.abs(best - center.y) ? value : best, points[0]);
  card.querySelectorAll('[data-character-position-cell]').forEach(cell => {
    const active = Math.abs(Number(cell.dataset.x) - nearestX) < 0.001 && Math.abs(Number(cell.dataset.y) - nearestY) < 0.001;
    cell.classList.toggle('active', active);
  });
}

function syncCharacterPositionCapability() {
  const toggle = els.characterUseCoords?.closest('.character-position-toggle');
  if (!toggle) return;
  toggle.title = isV5Model(appState.model)
    ? 'NovelAI V5 连续角色位置引导'
    : 'NovelAI V4/V4.5 5×5 位置引导';
}

function bindCharacterPositionInteractions() {
  if (!els.charactersList || els.charactersList.dataset.positionInteractionsBound === '1') return;
  els.charactersList.dataset.positionInteractionsBound = '1';
  let activeDrag = null;
  const applyPointerPosition = (event, pad) => {
    const character = findCharacter(pad.dataset.characterPositionPad);
    if (!character) return;
    const rect = pad.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    setCharacterPrimaryCenter(character, x, y);
    appState.v4Options.useCoords = true;
    if (els.characterUseCoords) els.characterUseCoords.checked = true;
    updateCharacterPositionUi(character);
  };
  els.charactersList.addEventListener('click', event => {
    const cell = event.target.closest('[data-character-position-cell]');
    if (!cell) return;
    const character = findCharacter(cell.dataset.characterPositionCell);
    if (!character) return;
    setCharacterPrimaryCenter(character, Number(cell.dataset.x), Number(cell.dataset.y));
    appState.v4Options.useCoords = true;
    if (els.characterUseCoords) els.characterUseCoords.checked = true;
    updateCharacterPositionUi(character);
  });
  els.charactersList.addEventListener('pointerdown', event => {
    const pad = event.target.closest('[data-character-position-pad]');
    if (!pad) return;
    event.preventDefault();
    event.stopPropagation();
    activeDrag = pad;
    try { pad.setPointerCapture?.(event.pointerId); } catch {}
    applyPointerPosition(event, pad);
  });
  els.charactersList.addEventListener('pointermove', event => {
    if (activeDrag) {
      event.preventDefault();
      applyPointerPosition(event, activeDrag);
    }
  }, { passive: false });
  const endDrag = event => {
    if (!activeDrag) return;
    try { activeDrag.releasePointerCapture?.(event.pointerId); } catch {}
    activeDrag = null;
  };
  els.charactersList.addEventListener('pointerup', endDrag);
  els.charactersList.addEventListener('pointercancel', endDrag);
  els.charactersList.addEventListener('change', event => {
    const input = event.target.closest('[data-character-x], [data-character-y]');
    if (!input) return;
    const character = findCharacter(input.dataset.characterX || input.dataset.characterY);
    if (!character) return;
    const center = normalizeCharacterCenters(character.centers)[0];
    const value = Math.min(1, Math.max(0, finiteTagWeight(input.value, 0.5)));
    setCharacterPrimaryCenter(character, input.dataset.characterX ? value : center.x, input.dataset.characterY ? value : center.y);
    appState.v4Options.useCoords = true;
    if (els.characterUseCoords) els.characterUseCoords.checked = true;
    updateCharacterPositionUi(character);
  });
  els.charactersList.addEventListener('toggle', event => {
    if (!event.target?.classList?.contains('character-position-box') || !event.target.open) return;
    const character = findCharacter(event.target.closest('[data-character-card]')?.dataset.characterCard);
    if (!character) return;
    requestAnimationFrame(() => updateCharacterPositionUi(character));
  }, true);
}

function renderCharacters() {
  captureCharacterSetChange();
  scheduleDraftSave();
  if (!els.charactersList) return;
  syncCharacterPositionCapability();
  const openPositionIds = new Set([...els.charactersList.querySelectorAll('.character-position-box[open]')].map(box => box.closest('[data-character-card]')?.dataset.characterCard).filter(Boolean));
  els.charactersList.innerHTML = '';
  if (!appState.characters.length) {
    els.charactersList.textContent = '暂无角色';
    els.charactersList.classList.add('empty-state');
    updateEditorModuleCounts();
    applyTagSearch();
    if (editorFocusMode) applyEditorFocusMode();
    return;
  }
  els.charactersList.classList.remove('empty-state');
  appState.characters.forEach((ch, index) => {
    const card = document.createElement('div');
    card.className = `character-card ${ch.enabled === false ? 'disabled' : ''} ${openCharacterTiles.has(ch.id) ? 'tile-open' : ''}`;
    card.dataset.characterCard = ch.id;
    card.innerHTML = `
      <div class="character-head">
        <strong>角色 ${index + 1}</strong>
        <div class="inline-actions character-card-actions">
          <label class="check-label"><input type="checkbox" data-character-enabled="${ch.id}" ${ch.enabled !== false ? 'checked' : ''}>启用</label>
          <button type="button" class="ghost" data-character-duplicate="${ch.id}">复制</button>
          <button type="button" class="ghost danger" data-character-delete="${ch.id}">删除</button>
        </div>
      </div>
      ${characterTileHtml(ch, index)}
      ${characterPositionHtml(ch, index)}
      ${characterAreaHtml(ch, 'prompt', 'Character Prompt')}
      ${characterAreaHtml(ch, 'uc', 'Character UC')}
    `;
    els.charactersList.append(card);
    const promptList = card.querySelector(`[data-character-list="${ch.id}:prompt"]`);
    const ucList = card.querySelector(`[data-character-list="${ch.id}:uc"]`);
    prepareTagDropZone(promptList, { scope: 'character', characterId: ch.id, kind: 'prompt' });
    prepareTagDropZone(ucList, { scope: 'character', characterId: ch.id, kind: 'uc' });
    ch.promptTags.forEach(tag => promptList.append(createCharacterTagCard(ch.id, 'prompt', tag)));
    ch.ucTags.forEach(tag => ucList.append(createCharacterTagCard(ch.id, 'uc', tag)));
    if (tagSelection.size) requestAnimationFrame(renderTagDock);
    const ucDetails = card.querySelector(`[data-character-uc-id="${ch.id}"]`);
    ucDetails?.addEventListener('toggle', () => {
      const summaryState = ucDetails.querySelector('.character-uc-summary em');
      if (summaryState) summaryState.textContent = ucDetails.open ? '收起' : '展开';
      if (ucDetails.dataset.searchForcedOpen === '1') return;
      storageSet(`nai-pocket-character-uc-${ch.id}`, ucDetails.open ? '1' : '0');
    });
    if (openPositionIds.has(ch.id)) {
      const box = card.querySelector('.character-position-box');
      if (box) box.open = true;
      updateCharacterPositionUi(ch);
    }
  });

  els.charactersList.querySelectorAll('[data-character-enabled]').forEach(el => el.addEventListener('change', event => {
    const ch = findCharacter(event.target.dataset.characterEnabled);
    if (!ch) return;
    ch.enabled = event.target.checked;
    renderCharacters();
    updatePromptPreviewFromStructure();
  }));
  els.charactersList.querySelectorAll('[data-character-delete]').forEach(el => el.addEventListener('click', async event => {
    const idx = appState.characters.findIndex(item => item.id === event.target.dataset.characterDelete);
    if (idx < 0 || !(await confirmAction(`删除角色 ${idx + 1}？`, { confirmLabel: '删除', danger: true }))) return;
    appState.characters.splice(idx, 1);
    renderCharacters();
    updatePromptPreviewFromStructure();
  }));
  els.charactersList.querySelectorAll('[data-character-duplicate]').forEach(el => el.addEventListener('click', event => {
    const ch = findCharacter(event.target.dataset.characterDuplicate);
    if (!ch) return;
    if (appState.characters.length >= characterLimitForModel()) {
      toast(`当前模型最多保留 ${characterLimitForModel()} 个角色。`, 'error');
      return;
    }
    appState.characters.push(createCharacter({
      ...ch,
      id: undefined,
      name: '',
      promptTags: ch.promptTags.map(tag => ({ ...cloneTagForStorage(tag), id: undefined })),
      ucTags: ch.ucTags.map(tag => ({ ...cloneTagForStorage(tag), id: undefined }))
    }));
    renderCharacters();
    updatePromptPreviewFromStructure();
  }));
  bindCharacterPositionInteractions();
  if (els.characterUseCoords) els.characterUseCoords.checked = appState.v4Options?.useCoords === true;

  bindCharacterInputs();
  updateEditorModuleCounts();
  applyTagSearch();
  if (editorFocusMode) applyEditorFocusMode();
  updateCharacterCountBadge();
  if (tagLayout() !== 'legacy') applyEditMode();
}

function addCharacter(initial = {}) {
  const limit = characterLimitForModel();
  if (appState.characters.length >= limit) return toast(`当前模型最多保留 ${limit} 个角色。`, 'error');
  appState.characters.push(createCharacter(initial));
  renderCharacters();
  updatePromptPreviewFromStructure();
}

function updatePromptPreviewFromStructure() {
  if (directPromptEdited) return;
  appState.prompt = combinedPromptText();
  els.promptPreview.value = appState.prompt;
  updatePromptModeHint();
  autoGrowTextarea(els.promptPreview);
}

function adjustTagWeight(tag, direction, card) {
  // 一次按键 = 一步：0.01 级的权重先吸附到 0.1 网格，已在网格上的值照常 ±0.1。规则见 stepTagWeight。
  const next = stepTagWeight(finiteTagWeight(tag.weight), direction);
  if (next === finiteTagWeight(tag.weight)) return;
  tag.weight = next;
  const weightNode = card.querySelector('.tag-weight');
  if (weightNode) weightNode.textContent = formatTagWeight(tag.weight);
  card?.classList.toggle('negative-weight', next < 0);
  compilePromptToPreview();
}

function createLegacyCharacterTagCard(characterId, kind, tag) {
  const card = document.createElement('div');
  card.className = `tag-card character-tag-card ${tag.enabled === false ? 'disabled' : ''} ${finiteTagWeight(tag.weight) < 0 ? 'negative-weight' : ''}`;
  card.dataset.tagId = tag.id;
  card.dataset.characterId = characterId;
  card.dataset.characterKind = kind;
  const translation = tag.translation || translationCache.get(tag.text.toLowerCase()) || '';
  if (translation && !tag.translation) tag.translation = translation;
  card.innerHTML = `
    <button type="button" class="tag-enable" data-action="toggle" aria-pressed="${tag.enabled !== false}">${tag.enabled !== false ? '✓' : '○'}</button>
    <button type="button" class="tag-copy" data-action="edit">
      <strong>${escapeHtml(tag.text)}${tag.bundle ? '<em class="bundle-mark">整块</em>' : ''}</strong>
      <small class="tag-translation ${translation ? '' : 'missing'}">${escapeHtml(translation || '暂无中文释义')}</small>
    </button>
    <div class="tag-controls">
      ${artistJumpLinkHtml(tag.text, 'tag-artist-jump', { scope: 'character', characterId, kind, tagId: tag.id })}
      <button type="button" class="chip-btn" data-action="minus" aria-label="降低权重，长按连续降低">−</button>
      <button type="button" class="tag-weight" data-action="edit">${formatTagWeight(tag.weight)}</button>
      <button type="button" class="chip-btn" data-action="plus" aria-label="提高权重，长按连续提高">＋</button>
      <button type="button" class="chip-btn edit" data-action="edit">✎</button>
      <button type="button" class="chip-btn danger" data-action="delete" aria-label="删除 Tag">×</button>
      <span class="drag-handle" aria-label="拖动 Tag" title="长按 Tag 可拖动">⋮⋮</span>
    </div>`;
  card.classList.toggle('translations-hidden', !translationVisible());
  card.dataset.searchText = `${tag.text} ${translation}`;
  bindLongPressTagDrag(card, { scope: 'character', characterId, kind }, tag);

  bindHoldRepeat(card.querySelector('[data-action="minus"]'), () => adjustTagWeight(tag, -1, card));
  bindHoldRepeat(card.querySelector('[data-action="plus"]'), () => adjustTagWeight(tag, 1, card));

  card.addEventListener('click', event => {
    if (Date.now() < tagDragSuppressClickUntil) { event.preventDefault(); event.stopPropagation(); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action || action === 'minus' || action === 'plus') return;
    event.preventDefault();
    if (action === 'edit') return openTagEditor({ scope: 'character', characterId, kind, id: tag.id });
    if (action === 'delete') {
      const list = getCharacterTagList(characterId, kind);
      const index = list?.findIndex(item => item.id === tag.id) ?? -1;
      if (index >= 0) list.splice(index, 1);
      renderCharacters();
      compilePromptToPreview();
      return;
    }
    if (action === 'toggle') {
      tag.enabled = tag.enabled === false;
      card.classList.toggle('disabled', tag.enabled === false);
      const toggle = card.querySelector('.tag-enable');
      toggle.textContent = tag.enabled !== false ? '✓' : '○';
      toggle.setAttribute('aria-pressed', String(tag.enabled !== false));
      compilePromptToPreview();
    }
  });
  return card;
}

async function submitCharacterInput(characterId, kind, input, mode, hideMenu) {
  const raw = input.value;
  if (!raw.trim()) return;
  input.disabled = true;
  try {
    // Chinese input is translated one token at a time after parsing.
    const parsed = splitInputToTags(raw, mode);
    const list = getCharacterTagList(characterId, kind);
    const added = [];
    for (const item of parsed) {
      if (hasCjk(item.text)) {
        const result = await api('/api/translate', { method: 'POST', body: { text: item.text, source: 'zh-CN', target: 'en' } });
        item.translation = item.text;
        item.text = result.text || item.text;
        item.originalText = item.text;
        item.preserveRaw = false;
        item.raw = '';
      }
      const tag = addParsedTagToList(list, item);
      if (tag) added.push(tag);
    }
    input.value = '';
    hideMenu();
    renderCharacters();
    compilePromptToPreview();
    if (added.length) translateSpecificTags(added.filter(tag => !tag.translation)).catch(() => {});
    toast(added.length ? `已添加 ${added.length} 个角色 Tag。` : '没有新增 Tag，可能已存在。', added.length ? 'success' : '');
  } catch (error) {
    toast(`添加失败：${error.message}`, 'error');
  } finally {
    const current = document.querySelector(`[data-character-input="${CSS.escape(`${characterId}:${kind}`)}"]`);
    if (current) current.disabled = false;
    current?.focus({ preventScroll: true });
  }
}

function bindCharacterInputs() {
  $$('[data-character-input]').forEach(input => {
    const [characterId, kind] = input.dataset.characterInput.split(':');
    const key = `${characterId}:${kind}`;
    const menu = document.querySelector(`[data-character-suggestions="${CSS.escape(key)}"]`);
    let suggestions = [];
    let activeIndex = -1;
    let composing = false;
    let sequence = 0;
    let suggestionController = null;
    const hideMenu = () => { suggestions = []; activeIndex = -1; menu.classList.add('hidden'); menu.innerHTML = ''; };
    const selectSuggestion = index => {
      const item = suggestions[index];
      if (!item) return;
      const list = getCharacterTagList(characterId, kind);
      const tag = addParsedTagToList(list, { ...parseTagToken(item.tag), translation: item.translation || '' });
      hideMenu();
      if (tag) {
        renderCharacters();
        compilePromptToPreview();
        toast(`已添加：${item.tag}`, 'success');
      }
    };
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; });
    input.addEventListener('keydown', event => {
      if (composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'ArrowDown' && suggestions.length) { event.preventDefault(); activeIndex = (activeIndex + 1) % suggestions.length; return; }
      if (event.key === 'ArrowUp' && suggestions.length) { event.preventDefault(); activeIndex = activeIndex <= 0 ? suggestions.length - 1 : activeIndex - 1; return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!event.shiftKey && suggestions.length && !menu.classList.contains('hidden')) selectSuggestion(activeIndex >= 0 ? activeIndex : 0);
        else submitCharacterInput(characterId, kind, input, event.shiftKey ? 'whole' : 'split', hideMenu);
      }
      if (event.key === 'Escape') hideMenu();
    });
    document.querySelector(`[data-character-add="${CSS.escape(key)}"]`)?.addEventListener('click', () => submitCharacterInput(characterId, kind, input, 'split', hideMenu));
    document.querySelector(`[data-character-whole="${CSS.escape(key)}"]`)?.addEventListener('click', () => submitCharacterInput(characterId, kind, input, 'whole', hideMenu));
    document.querySelector(`[data-character-semantic="${CSS.escape(key)}"]`)?.addEventListener('click', () => openSemanticSearch({ scope: 'character', characterId, kind }, input.value));
    menu.addEventListener('click', event => {
      const button = event.target.closest('.suggestion-item');
      if (button) selectSuggestion(Number(button.dataset.index));
    });
    input.addEventListener('input', debounce(async () => {
      const q = input.value.trim();
      const request = ++sequence;
      suggestionController?.abort();
      if (!q || /[,，\n]/.test(q) || /^[-+]?\d+(?:\.\d+)?::/.test(q)) return hideMenu();
      suggestionController = new AbortController();
      menu.innerHTML = '<div class="suggestion-loading">正在搜索并翻译…</div>';
      menu.classList.remove('hidden');
      try {
        const results = await api(`/api/tags/suggest?model=${encodeURIComponent($('#model').value)}&q=${encodeURIComponent(q)}`, { signal: suggestionController.signal });
        if (request !== sequence || input.value.trim() !== q) return;
        suggestions = (Array.isArray(results) ? results : []).slice(0, 12);
        menu.innerHTML = suggestions.map((item, index) => `<button type="button" class="suggestion-item" data-index="${index}"><span class="suggestion-copy"><strong>${escapeHtml(item.tag)}</strong><small${item.translation ? '' : ' class="missing"'}>${escapeHtml(item.translation || '暂无翻译')}</small></span><span class="suggestion-count">${formatCompactNumber(item.count)}</span></button>`).join('') || '<div class="suggestion-empty">没有联想结果；仍可直接添加。</div>';
      } catch (error) {
        if (error.name === 'AbortError') return;
        menu.innerHTML = `<div class="suggestion-empty">联想暂不可用：${escapeHtml(error.message)}</div>`;
      }
    }, 420));
  });
}

function createLegacyTagCard(groupKey, tag) {
  const card = document.createElement('div');
  card.className = `tag-card ${tag.enabled === false ? 'disabled' : ''} ${finiteTagWeight(tag.weight) < 0 ? 'negative-weight' : ''}`;
  card.dataset.group = groupKey;
  card.dataset.tagId = tag.id;
  const translation = tag.translation || translationCache.get(tag.text.toLowerCase()) || '';
  if (translation && !tag.translation) tag.translation = translation;
  card.innerHTML = `
    <button type="button" class="tag-enable" data-action="toggle" aria-pressed="${tag.enabled !== false}" title="启用或停用">${tag.enabled !== false ? '✓' : '○'}</button>
    <button type="button" class="tag-copy" data-action="edit" title="编辑 Tag">
      <strong>${escapeHtml(tag.text)}${tag.bundle ? '<em class="bundle-mark">整块</em>' : ''}</strong>
      <small class="tag-translation ${translation ? '' : 'missing'}">${escapeHtml(translation || '暂无中文释义')}</small>
    </button>
    <div class="tag-controls">
      ${artistJumpLinkHtml(tag.text, 'tag-artist-jump', { scope: 'global', groupKey, tagId: tag.id })}
      <button type="button" class="chip-btn" data-action="minus" aria-label="降低权重，长按连续降低">−</button>
      <button type="button" class="tag-weight" data-action="edit-weight" aria-label="编辑权重">${formatTagWeight(tag.weight)}</button>
      <button type="button" class="chip-btn" data-action="plus" aria-label="提高权重，长按连续提高">＋</button>
      <button type="button" class="chip-btn edit" data-action="edit" aria-label="编辑">✎</button>
      <button type="button" class="chip-btn danger" data-action="delete" aria-label="删除 Tag">×</button>
      <span class="drag-handle" title="电脑端可拖动到其他分组">⋮⋮</span>
    </div>`;
  card.classList.toggle('translations-hidden', !translationVisible());
  card.dataset.searchText = `${tag.text} ${translation}`;
  bindLongPressTagDrag(card, { scope: 'global', groupKey }, tag);

  bindHoldRepeat(card.querySelector('[data-action="minus"]'), () => adjustTagWeight(tag, -1, card));
  bindHoldRepeat(card.querySelector('[data-action="plus"]'), () => adjustTagWeight(tag, 1, card));

  card.addEventListener('click', event => {
    if (Date.now() < tagDragSuppressClickUntil) { event.preventDefault(); event.stopPropagation(); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action || action === 'minus' || action === 'plus') return;
    event.preventDefault();
    if (action === 'edit' || action === 'edit-weight') return openTagEditor(groupKey, tag.id);
    if (action === 'delete') {
      const found = getTag(groupKey, tag.id);
      if (found) found.group.splice(found.index, 1);
      renderTagGroups();
      compilePromptToPreview();
      return;
    }
    if (action === 'toggle') {
      tag.enabled = tag.enabled === false;
      card.classList.toggle('disabled', tag.enabled === false);
      const toggle = card.querySelector('.tag-enable');
      toggle.textContent = tag.enabled !== false ? '✓' : '○';
      toggle.setAttribute('aria-pressed', String(tag.enabled !== false));
      compilePromptToPreview();
    }
  });
  return card;
}

// Plana-style bilingual chips. A tap selects a chip; every action lives in the
// bottom selection dock instead of buttons repeated on each Tag.

const tagSelection = new Map();
let tagMultiSelect = false;
const tagRefKey = ref => ref.scope === 'character' ? `c|${ref.characterId}|${ref.kind}|${ref.id}` : ref.scope === 'uc' ? `u|${ref.id}` : `g|${ref.groupKey}|${ref.id}`;

// Artist Tags: the cache holds many shapes (画师：x, 艺术家：x, the bare name,
// leftovers like "0.5:: artist: x" or "[[[ARTIST: x]]]"). Show one form:
// 画师, plus a Chinese name when the cache really has one.
const isArtistText = text => /^\s*artist\s*:/i.test(String(text || '')) || identifyArtistTag(text, artistOverrides).recognized;
function artistTranslationLine(text, translation) {
  const name = String(text || '').replace(/^\s*artist\s*:\s*/i, '').trim().toLowerCase();
  const rest = String(translation || '')
    .replace(/[-+]?\d+(?:\.\d+)?\s*::/g, '').replace(/::/g, '')
    .replace(/[[\]{}]/g, '')
    .replace(/(画师|艺术家|artist)\s*[:：]?/gi, '')
    .replace(/\d{4}\s*年/g, '')
    .replace(/[,，\s]+$/, '').trim();
  const meaningful = rest && /[\u3400-\u9fff]/u.test(rest) && rest.toLowerCase() !== name;
  return meaningful ? `画师 · ${rest}` : '画师';
}

function tagChipWeightClass(weight) {
  const value = finiteTagWeight(weight);
  if (value < 0) return 'negative-weight';
  if (value > 1) return 'weight-up';
  if (value < 1) return 'weight-down';
  return '';
}

function createTagChip(ref, tag) {
  const card = document.createElement('div');
  const selected = tagSelection.has(tagRefKey({ ...ref, id: tag.id }));
  const artist = identifyArtistTag(tag.text, artistOverrides).recognized;
  card.className = ['tag-card', 'tag-chip', ref.scope === 'character' ? 'character-tag-card' : '', tag.enabled === false ? 'disabled' : '',
    tagChipWeightClass(tag.weight), selected ? 'selected' : '', artist ? 'is-artist' : ''].filter(Boolean).join(' ');
  card.dataset.tagId = tag.id;
  if (ref.scope === 'character') { card.dataset.characterId = ref.characterId; card.dataset.characterKind = ref.kind; }
  else if (ref.scope === 'uc') card.dataset.ucChip = '1';
  else card.dataset.group = ref.groupKey;
  const cachedTranslation = tag.translation || translationCache.get(tag.text.toLowerCase()) || '';
  if (cachedTranslation && !tag.translation) tag.translation = cachedTranslation;
  const translation = artist || /^\s*artist\s*:/i.test(tag.text) ? artistTranslationLine(tag.text, cachedTranslation) : cachedTranslation;
  const weight = finiteTagWeight(tag.weight);
  const artistTarget = ref.scope === 'character' ? { scope: 'character', characterId: ref.characterId, kind: ref.kind, tagId: tag.id }
    : ref.scope === 'global' ? { scope: 'global', groupKey: ref.groupKey, tagId: tag.id } : null;
  card.innerHTML = `
    ${artist ? artistJumpLinkHtml(tag.text, 'chip-artist-jump', artistTarget) : ''}
    <button type="button" class="tag-copy" data-action="select" aria-pressed="${selected}" title="点选后在底部操作；长按拖动">
      <span class="chip-line"><strong>${escapeHtml(tag.text)}</strong>${weight !== 1 ? `<em class="chip-weight">×${escapeHtml(formatTagWeight(weight))}</em>` : ''}${hasLegacyBrackets(tag) ? `<em class="bracket-mark" title="保留原始括号写法 ${escapeHtml(tag.raw)}；改权重后转为数字格式">${tag.raw.startsWith('[') ? '[ ]' : '{ }'}</em>` : ''}${tag.bundle ? '<em class="bundle-mark">整块</em>' : ''}</span>
      <small class="tag-translation ${translation ? '' : 'missing'}">${escapeHtml(translation || '暂无释义')}</small>
    </button>
    <span class="drag-handle" title="拖动到其他分组或角色" aria-hidden="true">⋮⋮</span>`;
  card.classList.toggle('translations-hidden', !translationVisible());
  // Weight bar: length ∝ |weight| — ×0 none, ×1 half, ×2 and above full;
  // negative weights grow in red. Set through the CSSOM (CSP-safe).
  card.style.setProperty('--wspan', String(Math.min(1, Math.abs(weight) / 2)));
  card.dataset.searchText = `${tag.text} ${translation}`;
  // Global UC chips move through the dock only; drag targets are Tag lists.
  if (ref.scope !== 'uc') bindLongPressTagDrag(card, ref.scope === 'character' ? { scope: 'character', characterId: ref.characterId, kind: ref.kind } : { scope: 'global', groupKey: ref.groupKey }, tag);
  bindWeightScrub(card, ref, tag);
  card.title = '点选后可左右滑动调整权重；长按拖动';
  card.addEventListener('click', event => {
    if (Date.now() < tagDragSuppressClickUntil) { event.preventDefault(); event.stopPropagation(); return; }
    if (quickDeleteMode) { event.preventDefault(); event.stopPropagation(); return quickDeleteTag({ ...ref, id: tag.id }); }
    if (!event.target.closest('[data-action="select"]')) return;
    event.preventDefault();
    toggleTagSelection({ ...ref, id: tag.id }, { additive: tagMultiSelect || event.ctrlKey || event.metaKey || event.shiftKey });
  });
  return card;
}

// The legacy card layout is retired (1.6.69): every browser gets the chip
// layout. Its branches below are dormant until they are deleted.
const tagLayout = () => 'chips';
function applyTagLayoutClass() {
  document.body.classList.remove('tag-layout-legacy');
  placeParameterControls();
}

function createTagCard(groupKey, tag) {
  return tagLayout() === 'legacy' ? createLegacyTagCard(groupKey, tag) : createTagChip({ scope: 'global', groupKey }, tag);
}

function createCharacterTagCard(characterId, kind, tag) {
  return tagLayout() === 'legacy' ? createLegacyCharacterTagCard(characterId, kind, tag) : createTagChip({ scope: 'character', characterId, kind }, tag);
}

function chipNode(ref) {
  const id = CSS.escape(ref.id);
  if (ref.scope === 'uc') return document.querySelector(`.tag-chip[data-uc-chip][data-tag-id="${id}"]`);
  return ref.scope === 'character'
    ? document.querySelector(`.tag-chip[data-tag-id="${id}"][data-character-id="${CSS.escape(ref.characterId)}"][data-character-kind="${CSS.escape(ref.kind)}"]`)
    : document.querySelector(`.tag-chip[data-tag-id="${id}"][data-group="${CSS.escape(ref.groupKey)}"]`);
}

// Undo, drag or the edit dialog may move a selected Tag; follow it by id.
function locateTagById(id) {
  for (const [groupKey] of GROUP_DEFS) if ((appState.groups[groupKey] || []).some(tag => tag.id === id)) return { scope: 'global', groupKey, id };
  for (const character of appState.characters) {
    if (character.promptTags.some(tag => tag.id === id)) return { scope: 'character', characterId: character.id, kind: 'prompt', id };
    if (character.ucTags.some(tag => tag.id === id)) return { scope: 'character', characterId: character.id, kind: 'uc', id };
  }
  if (ucChipState.tags.some(tag => tag.id === id)) return { scope: 'uc', id };
  return null;
}

function selectedTagEntries() {
  const entries = [];
  for (const [key, ref] of [...tagSelection]) {
    let current = ref, found = getScopedTag(ref);
    if (!found) {
      current = locateTagById(ref.id);
      found = current && getScopedTag(current);
      tagSelection.delete(key);
      if (found) tagSelection.set(tagRefKey(current), current);
    }
    if (found) entries.push({ ref: current, ...found });
  }
  return entries;
}

function paintTagSelection() {
  document.querySelectorAll('.tag-chip.selected').forEach(node => {
    node.classList.remove('selected');
    node.querySelector('.tag-copy')?.setAttribute('aria-pressed', 'false');
  });
  for (const { ref } of selectedTagEntries()) {
    const node = chipNode(ref);
    node?.classList.add('selected');
    node?.querySelector('.tag-copy')?.setAttribute('aria-pressed', 'true');
  }
  renderTagDock();
}

function toggleTagSelection(ref, { additive = false } = {}) {
  const key = tagRefKey(ref);
  if (tagSelection.has(key)) tagSelection.delete(key);
  else {
    if (!additive) tagSelection.clear();
    tagSelection.set(key, ref);
  }
  paintTagSelection();
}

function clearTagSelection() {
  if (!tagSelection.size && !tagMultiSelect) return;
  tagSelection.clear();
  tagMultiSelect = false;
  paintTagSelection();
}

// Re-render a chip in place (weight/enable changes) without rebuilding lists.
function refreshTagChip(entry) {
  const node = chipNode(entry.ref);
  if (node) node.replaceWith(createTagChip(entry.ref, entry.tag));
  paintChipQuickActions();
  positionTagDock();
}

function tagMoveOptions() {
  const options = GROUP_DEFS.map(([key, label]) => `<option value="g|${escapeHtml(key)}">全局 · ${escapeHtml(label)}</option>`);
  options.push('<option value="u">全局 · 负面（UC）</option>');
  appState.characters.forEach((character, index) => {
    const name = `角色 ${index + 1}${character.name ? ` · ${escapeHtml(character.name)}` : ''}`;
    options.push(`<option value="c|${escapeHtml(character.id)}|prompt">${name} · Prompt</option>`, `<option value="c|${escapeHtml(character.id)}|uc">${name} · UC</option>`);
  });
  return options.join('');
}

// Since 1.6.45 the controls open inline: a slim strip right under the selected
// chip's row (no bar at the bottom of the screen). Weight stepper (tap the
// value to reset), a labeled 停用 / 启用, ✎, delete, and "更多" for the rest.
let tagDockMoreOpen = false;
let tagDockHome = null;
const dockIcon = path => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
const DOCK_ICONS = Object.freeze({
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  delete: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 11v5M13.5 11v5',
  disable: 'M3 3l18 18M10.6 6.1A9.5 9.5 0 0 1 12 6c5 0 9 6 9 6a15 15 0 0 1-3 3.5M6.5 7.5C4.3 9 3 12 3 12s4 6 9 6a8 8 0 0 0 3.5-.8',
  enable: 'M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6zM12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M6 6l12 12M18 6L6 18',
  move: 'M4 7h6l2 2h8v9H4zM11 13.5h6M14.5 11l2.5 2.5-2.5 2.5',
  copy: 'M8 8h11v11H8zM5 15V5h10',
  multi: 'M7 4h13v13M4 7h13v13H4zM8 13.5l2 2 4-4',
  reset: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4',
  retranslate: 'M4 5h8M8 3v2M5.5 9c1 2.5 3 4.5 6 5.5M10.5 5c-.8 4-3 7-6.5 9M13 21l4-9 4 9M14.3 18h5.4'
});

function renderTagDock() {
  const dock = els.tagSelectionDock;
  if (!dock) return;
  const entries = selectedTagEntries();
  document.body.classList.toggle('tag-selection-active', entries.length > 0);
  dock.classList.toggle('hidden', !entries.length);
  paintChipQuickActions(entries);
  // With nothing selected the strip goes back to its home, so a list re-render
  // never leaves it detached from the page.
  tagDockHome ??= { parent: dock.parentElement, next: dock.nextSibling };
  if (!entries.length) { dock.innerHTML = ''; tagDockMoreOpen = false; if (tagDockHome.parent && dock.parentElement !== tagDockHome.parent) tagDockHome.parent.insertBefore(dock, tagDockHome.next?.parentElement === tagDockHome.parent ? tagDockHome.next : null); return; }
  const single = entries.length === 1 ? entries[0] : null;
  const allDisabled = entries.every(entry => entry.tag.enabled === false);
  const hasUc = entries.some(entry => entry.ref.scope === 'uc');
  const artistTarget = single ? (single.ref.scope === 'character'
    ? { scope: 'character', characterId: single.ref.characterId, kind: single.ref.kind, tagId: single.tag.id }
    : { scope: 'global', groupKey: single.ref.groupKey, tagId: single.tag.id }) : null;
  const iconButton = (action, icon, label, extra = '') => `<button type="button" class="tag-dock-icon-button" data-dock="${action}" aria-label="${label}" title="${label}" ${extra}>${dockIcon(DOCK_ICONS[icon])}</button>`;
  const tool = (action, icon, label, extra = '') => `<button type="button" class="tag-dock-tool" data-dock="${action}" ${extra}>${dockIcon(DOCK_ICONS[icon])}<small>${label}</small></button>`;
  dock.innerHTML = `
    <div class="tag-dock-bar">
      <span class="tag-dock-count" aria-live="polite">${single ? '' : `已选 ${entries.length}`}</span>
      <div class="tag-dock-stepper">
        <button type="button" data-dock="minus" aria-label="降低权重，长按连续">−</button>
        <button type="button" class="tag-dock-weight" data-dock-weight data-dock="weight-reset" title="点按恢复 ×1"></button>
        <button type="button" data-dock="plus" aria-label="提高权重，长按连续">＋</button>
      </div>
      <span class="tag-dock-spacer"></span>
      <button type="button" class="tag-dock-toggle" data-dock="toggle" aria-pressed="${allDisabled}" ${hasUc ? 'disabled title="全局 UC 以纯文本保存，无法保留停用状态"' : ''}>${dockIcon(DOCK_ICONS[allDisabled ? 'enable' : 'disable'])}<span>${allDisabled ? '启用' : '停用'}</span></button>
      ${single && !hasUc ? iconButton('edit', 'edit', '编辑文本、释义与权重') : ''}
      ${iconButton('delete', 'delete', '删除', 'data-tone="danger"')}
      ${iconButton('more', 'more', '更多', `aria-expanded="${tagDockMoreOpen}"`)}
      ${iconButton('close', 'close', '取消选择')}
    </div>
    <div class="tag-dock-toolbar" ${tagDockMoreOpen ? '' : 'hidden'}>
      <label class="tag-dock-tool tag-dock-move">${dockIcon(DOCK_ICONS.move)}<small>移动</small><select data-dock="move" aria-label="移动到"><option value="">移动到…</option>${tagMoveOptions()}</select></label>
      ${tool('copy', 'copy', '复制')}
      ${tool('multi', 'multi', '多选', `aria-pressed="${tagMultiSelect}"`)}
      ${single ? artistJumpLinkHtml(single.tag.text, 'tag-dock-tool tag-artist-jump', artistTarget) : ''}
      ${tool('retranslate', 'retranslate', '重新翻译')}
      ${tool('reset-weight', 'reset', '重置权重')}
      ${entries.some(entry => hasLegacyBrackets(entry.tag)) ? tool('brackets', 'reset', '括号转数字') : ''}
    </div>`;
  updateTagDockValues(entries);
  bindHoldRepeat(dock.querySelector('[data-dock="minus"]'), () => stepSelectedTagWeights(-1));
  bindHoldRepeat(dock.querySelector('[data-dock="plus"]'), () => stepSelectedTagWeights(1));
  positionTagDock();
}

// Place the strip in the Tag list right after the last chip on the selected
// chip's row, so the row stays whole and the strip opens beneath it. Drop
// targets count only .tag-card children, so the strip never shifts indexes.
function positionTagDock() {
  const dock = els.tagSelectionDock;
  if (!dock || dock.classList.contains('hidden')) return;
  const anchor = chipNode(selectedTagEntries().at(-1)?.ref);
  if (!anchor?.parentElement) return;
  let last = anchor;
  for (let next = anchor.nextElementSibling; next; next = next.nextElementSibling) {
    if (next === dock) continue;
    if (!next.classList.contains('tag-card') || next.offsetTop !== anchor.offsetTop) break;
    last = next;
  }
  if (last.nextElementSibling !== dock) last.after(dock);
}

// Quick ✎ / × on the single selected chip.
function paintChipQuickActions(entries = selectedTagEntries()) {
  document.querySelectorAll('.chip-quick').forEach(node => node.remove());
  // The inline strip under the chip carries ✎ and delete now.
  if (els.tagSelectionDock || entries.length !== 1 || tagMultiSelect || tagLayout() === 'legacy') return;
  const [{ ref }] = entries;
  const chip = chipNode(ref);
  if (!chip) return;
  const quick = document.createElement('span');
  quick.className = 'chip-quick';
  quick.innerHTML = `${ref.scope === 'uc' ? '' : `<button type="button" data-chip-quick="edit" aria-label="编辑">${dockIcon(DOCK_ICONS.edit)}</button>`}<button type="button" data-chip-quick="delete" aria-label="删除" data-tone="danger">${dockIcon(DOCK_ICONS.close)}</button>`;
  chip.append(quick);
}

function updateTagDockValues(entries = selectedTagEntries()) {
  const output = els.tagSelectionDock?.querySelector('[data-dock-weight]');
  if (output) {
    const weights = [...new Set(entries.map(entry => finiteTagWeight(entry.tag.weight)))];
    output.textContent = weights.length === 1 ? `×${formatTagWeight(weights[0])}` : '混合';
  }
  const atOne = entries.every(entry => finiteTagWeight(entry.tag.weight) === 1);
  els.tagSelectionDock?.querySelectorAll('[data-dock="reset-weight"], [data-dock="weight-reset"]').forEach(button => { button.disabled = atOne; });
  updateTagHistoryButtons();
}

function stepSelectedTagWeights(direction) {
  const entries = selectedTagEntries();
  let changed = false;
  for (const entry of entries) {
    const next = stepTagWeight(finiteTagWeight(entry.tag.weight), direction);
    if (next === finiteTagWeight(entry.tag.weight)) continue;
    entry.tag.weight = next;
    refreshTagChip(entry);
    changed = true;
  }
  if (!changed) return;
  syncUcChipsIfTouched(entries.map(entry => entry.ref));
  tagHistory.mergeKey = `weight:${[...tagSelection.keys()].sort().join(',')}`;
  compilePromptToPreview();
  updateTagDockValues(entries);
}

function tagListForRef(ref) {
  if (ref.scope === 'uc') return ucChipTags();
  if (ref.scope === 'character') return getCharacterTagList(ref.characterId, ref.kind);
  return appState.groups[ref.groupKey] || null;
}

function moveSelectedTags(value) {
  const [scope, first, kind] = String(value || '').split('|');
  const target = scope === 'c' ? { scope: 'character', characterId: first, kind } : scope === 'g' ? { scope: 'global', groupKey: first } : scope === 'u' ? { scope: 'uc' } : null;
  const targetList = target && tagListForRef(target);
  if (!targetList) return;
  const moved = [];
  for (const entry of selectedTagEntries()) {
    if (entry.ref.scope === target.scope && (target.scope === 'uc' || sameDragRef(entry.ref, target))) { moved.push({ ...target, id: entry.tag.id }); continue; }
    const sourceList = tagListForRef(entry.ref);
    const index = sourceList?.findIndex(item => item.id === entry.tag.id) ?? -1;
    if (index < 0) continue;
    const [tag] = sourceList.splice(index, 1);
    if (target.scope === 'global') {
      if (appState.promptOrderMode === 'original' && finiteOriginalOrder(tag.originalOrder) === null) tag.originalOrder = nextGlobalOriginalOrder();
      openTagGroups.add(target.groupKey);
    } else if (entry.ref.scope === 'global') tag.originalOrder = null;
    // Global UC is plain text and cannot keep a disabled Tag.
    if (target.scope === 'uc') tag.enabled = true;
    targetList.push(tag);
    moved.push({ ...target, id: tag.id });
  }
  tagSelection.clear();
  for (const ref of moved) tagSelection.set(tagRefKey(ref), ref);
  syncUcChipsIfTouched([target, ...moved]);
  refreshTagEditor();
}

function deleteSelectedTags() {
  const entries = selectedTagEntries();
  for (const entry of entries) {
    const list = tagListForRef(entry.ref);
    const index = list?.findIndex(item => item.id === entry.tag.id) ?? -1;
    if (index >= 0) list.splice(index, 1);
  }
  tagSelection.clear();
  syncUcChipsIfTouched(entries.map(entry => entry.ref));
  refreshTagEditor();
  toast(`已删除 ${entries.length} 个 Tag，可撤销。`);
}

function toggleSelectedTags() {
  const entries = selectedTagEntries();
  if (entries.some(entry => entry.ref.scope === 'uc')) return;
  const enable = entries.every(entry => entry.tag.enabled === false);
  for (const entry of entries) { entry.tag.enabled = enable; refreshTagChip(entry); }
  compilePromptToPreview();
  renderTagDock();
  updateEditorModuleCounts();
}

// Old machine translations can be redone: public names first, then a forced
// remote translation; manual and builtin meanings are kept as they are.
async function retranslateSelectedTags() {
  const entries = selectedTagEntries().filter(entry => !hasCjk(entry.tag.text));
  if (!entries.length) return;
  toast(`正在重新翻译 ${entries.length} 个 Tag…`);
  try {
    const { results, searchError } = await api('/api/translations/refresh', { method: 'POST', body: { items: entries.map(entry => entry.tag.text) } });
    const byText = new Map((results || []).map(item => [String(item.sourceText || '').toLowerCase(), item]));
    let updated = 0, kept = 0;
    for (const entry of entries) {
      const result = byText.get(entry.tag.text.trim().toLowerCase());
      if (!result?.text) continue;
      if (['manual', 'builtin'].includes(result.status)) kept += 1;
      if (result.text !== entry.tag.translation) updated += 1;
      entry.tag.translation = result.text;
      translationCache.set(entry.tag.text.toLowerCase(), result.text);
      refreshTagChip(entry);
    }
    if (entries.some(entry => entry.ref.scope === 'uc')) renderUcChips();
    updateTranslateHint();
    const notes = [kept ? `${kept} 个为手动或内置释义，已保留` : '', searchError ? `公共词库暂不可用（${searchError}）` : ''].filter(Boolean).join('；');
    toast(`已更新 ${updated} 个释义${notes ? `；${notes}` : '。'}`, updated ? 'success' : '');
  } catch (error) {
    toast(`重新翻译失败：${error.message}`, 'error');
  }
}

async function copySelectedTags() {
  const text = selectedTagEntries().map(entry => formatPromptTag(entry.tag)).join(', ');
  try { await navigator.clipboard.writeText(text); toast('已复制所选 Tag。', 'success'); }
  catch { toast('浏览器未允许写入剪贴板。', 'error'); }
}

function syncUcChipsIfTouched(refs) {
  if (refs.some(ref => ref?.scope === 'uc')) commitUcChips();
}

function refreshTagEditor() {
  renderTagGroups();
  renderCharacters();
  if (editMode.side === 'negative') renderUcChips();
  compilePromptToPreview();
  updateEditorModuleCounts();
  paintTagSelection();
}

function handleTagDockClick(event) {
  const action = event.target.closest('[data-dock]')?.dataset.dock;
  if (!action || action === 'minus' || action === 'plus' || action === 'move') return;
  const entries = selectedTagEntries();
  if (action === 'close') return clearTagSelection();
  if (action === 'undo') return stepTagHistory(-1);
  if (action === 'redo') return stepTagHistory(1);
  if (action === 'multi') { tagMultiSelect = !tagMultiSelect; return renderTagDock(); }
  if (action === 'more') { tagDockMoreOpen = !tagDockMoreOpen; return renderTagDock(); }
  if (!entries.length) return;
  if (action === 'edit' && entries.length === 1) {
    const { ref } = entries[0];
    return openTagEditor(ref.scope === 'character' ? { scope: 'character', characterId: ref.characterId, kind: ref.kind, id: ref.id } : { scope: 'global', groupKey: ref.groupKey, id: ref.id });
  }
  if (action === 'copy') return copySelectedTags();
  if (action === 'retranslate') return retranslateSelectedTags();
  if (action === 'toggle') return toggleSelectedTags();
  if (action === 'delete') return deleteSelectedTags();
  if (action === 'brackets') {
    const count = convertBracketWeights(entries.map(entry => entry.tag));
    for (const entry of entries) refreshTagChip(entry);
    syncUcChipsIfTouched(entries.map(entry => entry.ref));
    compilePromptToPreview();
    updateTagDockValues(entries);
    renderTagDock();
    return toast(count ? `已把 ${count} 个括号权重改为数字格式。` : '所选 Tag 没有括号权重。', count ? 'success' : '');
  }
  if (action === 'weight-reset') {
    if (entries.every(entry => finiteTagWeight(entry.tag.weight) === 1)) return;
    for (const entry of entries) { entry.tag.weight = 1; refreshTagChip(entry); }
    syncUcChipsIfTouched(entries.map(entry => entry.ref));
    compilePromptToPreview();
    updateTagDockValues(entries);
    return positionTagDock();
  }
  if (action === 'reset-weight') {
    for (const entry of entries) { entry.tag.weight = 1; refreshTagChip(entry); }
    syncUcChipsIfTouched(entries.map(entry => entry.ref));
    compilePromptToPreview();
    updateTagDockValues(entries);
  }
}

// One undo history for every Tag edit path. Each preview compile records the
// change since the previous checkpoint; loading a scheme or state resets it.
const tagHistory = { undo: [], redo: [], last: '', at: 0, restoring: false, mergeKey: '', batching: false };
// Name, position and on/off of every character seen, so undoing a removal
// brings the whole character back (snapshots only carry its Tags).
const characterArchive = new Map();
function tagStateSnapshot() {
  for (const ch of appState.characters) characterArchive.set(ch.id, { name: ch.name, centers: ch.centers, enabled: ch.enabled });
  return JSON.stringify({ groups: appState.groups, negativePrompt: els.negativePrompt?.value || '', characters: appState.characters.map(ch => ({ id: ch.id, promptTags: ch.promptTags, ucTags: ch.ucTags })) });
}

// Adding or removing a character is its own undo step.
function captureCharacterSetChange() {
  if (tagHistory.restoring || tagHistory.batching || !tagHistory.last) return;
  const ids = appState.characters.map(ch => ch.id).join('|');
  const lastIds = JSON.parse(tagHistory.last).characters.map(ch => ch.id).join('|');
  if (ids !== lastIds) captureTagHistory();
}

// Several edits (Tags, negative, characters) recorded as one undo step.
function asOneHistoryStep(run) {
  tagHistory.batching = true;
  try { return run(); }
  finally { tagHistory.batching = false; captureTagHistory(); }
}

function resetTagHistory() {
  tagHistory.undo.length = 0;
  tagHistory.redo.length = 0;
  tagHistory.last = tagStateSnapshot();
  tagHistory.at = 0;
  tagSelection.clear();
  tagMultiSelect = false;
  renderTagDock();
  updateTagHistoryButtons();
}

function captureTagHistory() {
  if (tagHistory.restoring || tagHistory.batching) return;
  const mergeKey = tagHistory.mergeKey;
  tagHistory.mergeKey = '';
  const current = tagStateSnapshot();
  if (current === tagHistory.last) return;
  const now = Date.now(), previous = tagHistory.undo.at(-1);
  // Only a held/repeated weight step on the same selection merges into one
  // undo step; any other edit, however quick, stays separately undoable.
  if (mergeKey && previous?.mergeKey === mergeKey && now - tagHistory.at < 700 && previous.after === tagHistory.last) previous.after = current;
  else {
    tagHistory.undo.push({ before: tagHistory.last, after: current, mergeKey });
    if (tagHistory.undo.length > 80) tagHistory.undo.shift();
  }
  tagHistory.redo.length = 0;
  tagHistory.last = current;
  tagHistory.at = now;
  updateTagHistoryButtons();
}

function stepTagHistory(direction) {
  const from = direction < 0 ? tagHistory.undo : tagHistory.redo;
  const to = direction < 0 ? tagHistory.redo : tagHistory.undo;
  const entry = from.pop();
  if (!entry) return;
  const target = JSON.parse(direction < 0 ? entry.before : entry.after);
  to.push(entry);
  // The character set follows the snapshot; removed characters come back
  // with their name and position.
  appState.characters = target.characters.map(saved => findCharacter(saved.id)
    || createCharacter({ ...characterArchive.get(saved.id), id: saved.id, promptTags: saved.promptTags, ucTags: saved.ucTags }));
  appState.groups = target.groups;
  if (typeof target.negativePrompt === 'string' && target.negativePrompt !== els.negativePrompt.value) {
    els.negativePrompt.value = target.negativePrompt;
    appState.negativePrompt = target.negativePrompt;
    autoGrowTextarea(els.negativePrompt);
  }
  for (const saved of target.characters) {
    const character = findCharacter(saved.id);
    character.promptTags = saved.promptTags;
    character.ucTags = saved.ucTags;
  }
  tagHistory.restoring = true;
  try { refreshTagEditor(); }
  finally { tagHistory.restoring = false; }
  tagHistory.last = tagStateSnapshot();
  tagHistory.at = 0;
  updateTagHistoryButtons();
}

function updateTagHistoryButtons() {
  document.querySelectorAll('[data-dock="undo"], #tagUndoButton, [data-history="undo"]').forEach(button => { button.disabled = !tagHistory.undo.length; });
  document.querySelectorAll('[data-dock="redo"], #tagRedoButton, [data-history="redo"]').forEach(button => { button.disabled = !tagHistory.redo.length; });
}

// Global UC as chips (new layout). Schemes keep UC as one raw string, so chips
// are parsed from it and the string is rebuilt only after a chip edit; an
// untouched UC keeps its exact original text. UC chips cannot be disabled.
const ucChipState = { source: null, tags: [] };

function ucChipTags() {
  const text = els.negativePrompt?.value || '';
  if (ucChipState.source !== text) {
    ucChipState.source = text;
    ucChipState.tags = splitInputToTags(text).map(item => {
      const tag = hydrateTag({ ...item, id: uid() });
      tag.translation = tag.translation || translationCache.get(tag.text.toLowerCase()) || '';
      return tag;
    });
  }
  return ucChipState.tags;
}

function commitUcChips() {
  const text = ucChipState.tags.map(tag => formatPromptTag({ ...tag, enabled: true })).join(', ');
  ucChipState.source = text;
  els.negativePrompt.value = text;
  // Reuse the textarea's own listener for state, preview and counts.
  els.negativePrompt.dispatchEvent(new Event('input', { bubbles: true }));
}

function renderUcChips() {
  const list = $('#ucChipList');
  if (!list) return;
  const tags = ucChipTags();
  list.replaceChildren(...tags.map(tag => createTagChip({ scope: 'uc' }, tag)));
  list.classList.toggle('empty', !tags.length);
  const missing = tags.filter(tag => !tag.translation && !hasCjk(tag.text));
  if (missing.length && translationVisible()) translateSpecificTags(missing.slice(0, 30)).catch(() => {});
}

async function submitUcChipInput() {
  const input = $('#ucChipInput');
  const raw = input?.value || '';
  if (!raw.trim()) return;
  input.disabled = true;
  try {
    const list = ucChipTags();
    let added = 0;
    for (const item of splitInputToTags(raw)) {
      if (hasCjk(item.text)) {
        const result = await api('/api/translate', { method: 'POST', body: { text: item.text, source: 'zh-CN', target: 'en' } });
        item.translation = item.text;
        item.text = result.text || item.text;
        item.raw = '';
        item.preserveRaw = false;
      }
      const tag = hydrateTag({ ...item, id: uid() });
      if (!tag.text || list.some(existing => tagKey(existing) === tagKey(tag))) continue;
      list.push(tag);
      added += 1;
    }
    input.value = '';
    if (added) { commitUcChips(); renderUcChips(); compilePromptToPreview(); }
  } catch (error) {
    toast(`添加失败：${error.message}`, 'error');
  } finally {
    input.disabled = false;
    input.focus({ preventScroll: true });
  }
}

// Plana-style editing switches for the new layout: positive/negative side and
// text mode replace always-visible modules. The legacy layout ignores them.
const editMode = { side: 'positive', text: false };

function applyEditMode() {
  const negative = editMode.side === 'negative';
  document.body.classList.toggle('edit-side-negative', negative);
  document.body.classList.toggle('edit-text-mode', editMode.text);
  document.querySelectorAll('[data-edit-side]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.editSide === editMode.side)));
  document.querySelectorAll('[data-edit-text]').forEach(button => button.setAttribute('aria-pressed', String(editMode.text)));
  if (negative) document.querySelectorAll('details.character-uc-area').forEach(details => { details.open = true; });
  if (negative && !editMode.text) renderUcChips();
  if (tagLayout() !== 'legacy') {
    document.querySelectorAll('.character-card').forEach(card => {
      const character = findCharacter(card.dataset.characterCard);
      const tile = card.querySelector('.character-tile');
      if (character && tile) tile.outerHTML = characterTileHtml(character, appState.characters.indexOf(character));
    });
  }
  if (editMode.text) autoGrowTextarea(negative ? els.negativePrompt : els.promptPreview);
  updatePromptMeter();
}

function setEditMode(patch) {
  Object.assign(editMode, patch);
  applyEditMode();
}

// New layout: the image workflow is three flat tool rows (图生图 / Vibe /
// 角色参考). Rows only forward to the existing controls and reflect their
// state, so picking, masks, strengths and billing checks stay unchanged.

function setGenerationModeFromRow(mode) {
  const select = els.generationModeSelect;
  const option = select && [...select.options].find(item => item.value === mode);
  if (!option || option.disabled || select.value === mode) return;
  select.value = mode;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function updateWorkflowRows() {
  const panel = $('.image-workflow-panel');
  if (!panel || tagLayout() === 'legacy') return;
  const select = els.generationModeSelect;
  const mode = select?.value || 'text';
  const reference = appState.referenceControl?.mode || 'none';
  const hasBase = Boolean(appState.imageWorkflow?.baseImage);
  const label = select?.selectedOptions?.[0]?.textContent?.trim() || '文生图';
  $('#wfBaseState').textContent = mode === 'text' ? '未使用' : `${label}${hasBase ? '' : ' · 待选图'}`;
  document.querySelectorAll('[data-wf-mode]').forEach(button => {
    const option = select && [...select.options].find(item => item.value === button.dataset.wfMode);
    button.disabled = !option || option.disabled;
    button.setAttribute('aria-pressed', String(button.dataset.wfMode === mode));
  });
  const referenceState = (kind, list) => {
    const button = document.querySelector(`[data-reference-mode="${kind}"]`);
    if (reference === kind) return `${list.filter(item => item?.image).length} 张`;
    return button?.disabled ? '当前模型不可用' : '未启用';
  };
  $('#wfVibeState').textContent = referenceState('vibe', appState.referenceControl?.vibes || []);
  $('#wfPreciseState').textContent = referenceState('precise', appState.referenceControl?.precise || []);
  panel.classList.toggle('wf-base-active', mode !== 'text');
  panel.classList.toggle('wf-vibe-active', reference === 'vibe');
  panel.classList.toggle('wf-precise-active', reference === 'precise');
}

function bindWorkflowRows() {
  const panel = $('.image-workflow-panel');
  if (!panel) return;
  panel.addEventListener('click', event => {
    const toggle = event.target.closest('[data-wf-toggle]')?.dataset.wfToggle;
    if (toggle) { panel.classList.toggle(`wf-open-${toggle}`); return; }
    const mode = event.target.closest('[data-wf-mode]')?.dataset.wfMode;
    if (mode) { setGenerationModeFromRow(mode); return; }
    const add = event.target.closest('[data-wf-add]')?.dataset.wfAdd;
    if (add === 'base') {
      if (els.generationModeSelect?.value === 'text') setGenerationModeFromRow('img2img');
      panel.classList.add('wf-open-base');
      els.chooseBaseImageButton?.click();
    } else if (add === 'vibe' || add === 'precise') {
      if (appState.referenceControl?.mode !== add) {
        setReferenceMode(add);
        if (appState.referenceControl?.mode !== add) return;
      }
      panel.classList.add(`wf-open-${add}`);
      (add === 'vibe' ? els.addVibeReferenceButton : els.addPreciseReferenceButton)?.click();
    }
    const off = event.target.closest('[data-wf-off]')?.dataset.wfOff;
    if (off === 'reference') setReferenceMode('none');
    if (off === 'base') setGenerationModeFromRow('text');
  });
  updateWorkflowRows();
}

// New layout: each character is a two-line tile (power · name · position ·
// copy · delete / one-line preview) that expands in place to its chips.
const openCharacterTiles = new Set();

function characterPositionLabel(character) {
  if (appState.v4Options?.useCoords !== true) return 'AUTO';
  const center = normalizeCharacterCenters(character.centers)[0];
  if (isV5Model(appState.model)) return `${center.x.toFixed(2)}, ${center.y.toFixed(2)}`;
  const column = 'ABCDE'[Math.min(4, Math.max(0, Math.round((center.x - .1) / .2)))];
  return `${column}${Math.min(5, Math.max(1, Math.round((center.y - .1) / .2) + 1))}`;
}

const CHARACTER_ICONS = Object.freeze({
  duplicate: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/></svg>',
  clear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 20h11M5.6 13.6l7.8-7.8a2 2 0 0 1 2.8 0l2 2a2 2 0 0 1 0 2.8l-7.1 7.1H8.9z"/><path d="M9.5 9.7l4.8 4.8"/></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 11v5M13.5 11v5"/></svg>'
});

// A character row: a numbered disc that is also the on/off switch, a title
// that says who it is (its name, else its first Tag), and one capsule for
// position · duplicate · clear Tags · delete.
function characterTileHtml(character, index) {
  const negative = editMode.side === 'negative';
  const enabledPrompt = character.promptTags.filter(tag => tag.enabled !== false);
  const titleFromTag = !character.name && enabledPrompt.length ? enabledPrompt[0].text : '';
  const title = character.name || titleFromTag || `角色 ${index + 1}`;
  const sideTags = negative ? character.ucTags : character.promptTags;
  const previewTags = !negative && titleFromTag ? sideTags.filter(tag => tag !== enabledPrompt[0]) : sideTags;
  const text = enabledTagText(previewTags);
  const enabled = character.enabled !== false;
  const open = openCharacterTiles.has(character.id);
  return `
    <div class="character-tile" data-new-layout-only>
      <div class="character-tile-row">
        <button type="button" class="character-disc" data-character-power="${character.id}" aria-pressed="${enabled}" title="${enabled ? '点按停用（保留配置）' : '点按启用'}">${index + 1}</button>
        <button type="button" class="character-tile-name" data-character-expand="${character.id}" aria-expanded="${open}"><b>${escapeHtml(title)}</b>${enabled ? '' : '<em>已停用</em>'}<i aria-hidden="true">▾</i></button>
        <span class="character-actions" role="group" aria-label="角色操作">
          <button type="button" class="character-position-chip" data-character-position-toggle="${character.id}" title="站位">▦ ${escapeHtml(characterPositionLabel(character))}</button>
          <button type="button" class="character-tile-icon" data-character-proxy="duplicate" aria-label="复制角色" title="复制角色">${CHARACTER_ICONS.duplicate}</button>
          <button type="button" class="character-tile-icon" data-character-clear="${character.id}" aria-label="清空${negative ? '负面' : ''} Tag" title="清空本角色${negative ? '负面' : ''} Tag（可撤销）" ${sideTags.length ? '' : 'disabled'}>${CHARACTER_ICONS.clear}</button>
          <button type="button" class="character-tile-icon danger" data-character-proxy="delete" aria-label="删除角色" title="删除角色">${CHARACTER_ICONS.delete}</button>
        </span>
      </div>
      <button type="button" class="character-tile-preview" data-character-expand="${character.id}" aria-expanded="${open}">
        <span class="${text ? '' : 'placeholder'}">${escapeHtml(text || (negative ? '点击添加角色负面…' : titleFromTag ? '（只有这一个 Tag）' : '点击添加角色提示词…'))}</span>
        <em>${estimatePromptTokens(enabledTagText(sideTags))}</em><i aria-hidden="true">▾</i>
      </button>
    </div>`;
}

function updateCharacterCountBadge() {
  const badge = $('#characterCountBadge');
  if (!badge) return;
  const active = appState.characters.filter(character => character.enabled !== false).length;
  const cap = characterLimitForModel(appState.model);
  badge.textContent = `${active} / ${cap}`;
  badge.classList.toggle('over', active > cap);
}

function bindCharacterTiles() {
  els.charactersList?.addEventListener('click', event => {
    const card = event.target.closest('[data-character-card]');
    if (!card || tagLayout() === 'legacy') return;
    const id = card.dataset.characterCard;
    if (event.target.closest('[data-character-power]')) {
      card.querySelector(`[data-character-enabled="${CSS.escape(id)}"]`)?.click();
      return;
    }
    if (event.target.closest('[data-character-position-toggle]')) {
      openPositionSheet(id);
      return;
    }
    if (event.target.closest('[data-character-clear]')) {
      const character = findCharacter(id);
      const list = editMode.side === 'negative' ? character?.ucTags : character?.promptTags;
      if (!list?.length) return;
      const count = list.length;
      list.length = 0;
      renderCharacters();
      compilePromptToPreview();
      toast(`已清空这个角色的 ${count} 个${editMode.side === 'negative' ? '负面 ' : ' '}Tag，可撤销。`);
      return;
    }
    if (event.target.closest('[data-character-expand]')) {
      const open = !openCharacterTiles.has(id);
      if (open) openCharacterTiles.add(id); else openCharacterTiles.delete(id);
      card.classList.toggle('tile-open', open);
      card.querySelectorAll('[data-character-expand]').forEach(node => node.setAttribute('aria-expanded', String(open)));
      return;
    }
    const proxy = event.target.closest('[data-character-proxy]')?.dataset.characterProxy;
    if (proxy) card.querySelector(`[data-character-${proxy}="${CSS.escape(id)}"]`)?.click();
  });
}

// New layout: parameters live in a bottom sheet opened from bar readouts.
function openParamsSheet(target = 'advanced') {
  document.body.classList.add('params-sheet-open');
  renderSizeTiles();
  syncParamSliders();
  const sheet = $('.sticky-settings');
  if (!sheet) return;
  const field = target === 'size' ? $('#width') : target === 'steps' ? $('#steps') : null;
  requestAnimationFrame(() => {
    if (field) field.closest('label')?.scrollIntoView({ block: 'center' });
    else sheet.scrollTop = 0;
  });
}

function closeParamsSheet() {
  document.body.classList.remove('params-sheet-open');
  updateParameterSummary();
}

function bindParamsSheet() {
  document.querySelectorAll('[data-param-open]').forEach(button => button.addEventListener('click', () => openParamsSheet(button.dataset.paramOpen)));
  $('#paramsSheetClose')?.addEventListener('click', closeParamsSheet);
  $('#paramsSheetBackdrop')?.addEventListener('click', closeParamsSheet);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('params-sheet-open')) closeParamsSheet(); });
}

// Empty Tag sections show one line; ＋ reveals their input.
function bindEmptySections() {
  els.tagGroups?.addEventListener('click', event => {
    const key = event.target.closest('[data-section-add]')?.dataset.sectionAdd;
    if (!key) return;
    const section = event.target.closest('.tag-section');
    section?.classList.add('adding');
    section?.querySelector(`[data-tag-input="${CSS.escape(key)}"]`)?.focus();
  });
}

// New layout: one position sheet for all characters (after Plana's position
// dialog). A strip picks the character; V5 places freely on a canvas shaped
// like the output, V4/V4.5 snaps to the 5×5 grid. AUTO is image-wide and
// never erases anyone's coordinates; placing someone turns it off.
const POSITION_GRID = [0.1, 0.3, 0.5, 0.7, 0.9];
const positionSheet = { characterId: null, dragging: false };
const snapToGrid = value => POSITION_GRID.reduce((best, point) => Math.abs(point - value) < Math.abs(best - value) ? point : best, POSITION_GRID[0]);

function openPositionSheet(characterId) {
  positionSheet.characterId = findCharacter(characterId) ? characterId : appState.characters[0]?.id || null;
  if (!positionSheet.characterId) return;
  document.body.classList.add('position-sheet-open');
  renderPositionSheet();
}

function closePositionSheet() {
  document.body.classList.remove('position-sheet-open');
  positionSheet.dragging = false;
  renderCharacters();
}

function renderPositionSheet() {
  const canvas = $('#positionCanvas');
  if (!canvas || !document.body.classList.contains('position-sheet-open')) return;
  const auto = appState.v4Options?.useCoords !== true;
  const v5 = isV5Model(appState.model);
  const current = findCharacter(positionSheet.characterId);
  $('#positionAuto').setAttribute('aria-pressed', String(auto));
  $('#positionStrip').innerHTML = appState.characters.map((character, index) =>
    `<button type="button" data-position-pick="${escapeHtml(character.id)}" aria-pressed="${character.id === positionSheet.characterId}"><b>${index + 1}</b>${character.name ? escapeHtml(character.name) : `角色 ${index + 1}`}</button>`).join('');
  const width = Number($('#width')?.value) || 832, height = Number($('#height')?.value) || 1216;
  canvas.style.aspectRatio = `${width} / ${height}`;
  canvas.style.setProperty("--ratio", String(width / height));
  canvas.classList.toggle('grid-mode', !v5);
  canvas.classList.toggle('auto', auto);
  // The page CSP blocks inline style attributes, so position via the CSSOM.
  const node = (tag, className, x, y, text = '') => {
    const element = document.createElement(tag);
    element.className = className;
    element.style.left = `${x * 100}%`;
    element.style.top = `${y * 100}%`;
    element.textContent = text;
    return element;
  };
  const parts = [];
  if (!v5) for (const y of POSITION_GRID) for (const x of POSITION_GRID) parts.push(node('i', 'position-cell', x - .1, y - .1));
  const guide = document.createElement('span');
  guide.className = 'position-guide';
  guide.setAttribute('aria-hidden', 'true');
  parts.push(guide);
  appState.characters.forEach((character, index) => {
    const point = normalizeCharacterCenters(character.centers)[0];
    const classes = ['position-dot', character.id === positionSheet.characterId ? 'current' : '', character.enabled === false ? 'disabled' : ''].filter(Boolean).join(' ');
    parts.push(node('span', classes, v5 ? point.x : snapToGrid(point.x), v5 ? point.y : snapToGrid(point.y), String(index + 1)));
  });
  if (auto) {
    const note = document.createElement('em');
    note.className = 'position-auto-note';
    note.textContent = '由模型安排';
    parts.push(note);
  }
  canvas.replaceChildren(...parts);
  const center = current ? normalizeCharacterCenters(current.centers)[0] : { x: .5, y: .5 };
  const who = current ? (current.name || `角色 ${appState.characters.indexOf(current) + 1}`) : '';
  $('#positionReadout').textContent = auto ? '自动：模型安排站位，坐标保留；点画布改为手动'
    : v5 ? `${who} · X ${center.x.toFixed(2)} · Y ${center.y.toFixed(2)}` : `${who} · 格子 ${characterPositionLabel(current)}`;
  $('#positionReadout').classList.toggle('manual', !auto);
}

function placeFromPointer(event) {
  const canvas = $('#positionCanvas'), character = findCharacter(positionSheet.characterId);
  if (!canvas || !character) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  let x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  let y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
  if (!isV5Model(appState.model)) { x = snapToGrid(x); y = snapToGrid(y); }
  setCharacterPrimaryCenter(character, x, y);
  appState.v4Options.useCoords = true;
  if (els.characterUseCoords) els.characterUseCoords.checked = true;
  renderPositionSheet();
}

function bindPositionSheet() {
  const canvas = $('#positionCanvas');
  if (!canvas) return;
  canvas.addEventListener('pointerdown', event => {
    event.preventDefault();
    positionSheet.dragging = true;
    try { canvas.setPointerCapture?.(event.pointerId); } catch {}
    placeFromPointer(event);
  });
  canvas.addEventListener('pointermove', event => { if (positionSheet.dragging) { event.preventDefault(); placeFromPointer(event); } }, { passive: false });
  const end = event => { positionSheet.dragging = false; try { canvas.releasePointerCapture?.(event.pointerId); } catch {} };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  $('#positionStrip')?.addEventListener('click', event => {
    const id = event.target.closest('[data-position-pick]')?.dataset.positionPick;
    if (id) { positionSheet.characterId = id; renderPositionSheet(); }
  });
  // AUTO flips the existing image-wide switch; coordinates are never touched.
  $('#positionAuto')?.addEventListener('click', () => {
    if (!els.characterUseCoords) return;
    els.characterUseCoords.checked = !els.characterUseCoords.checked;
    els.characterUseCoords.dispatchEvent(new Event('change', { bubbles: true }));
    renderPositionSheet();
  });
  $('#positionSheetClose')?.addEventListener('click', closePositionSheet);
  $('#paramsSheetBackdrop')?.addEventListener('click', () => { if (document.body.classList.contains('position-sheet-open')) closePositionSheet(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('position-sheet-open')) closePositionSheet(); });
}

// Visible "补翻译" prompt above the Tags whenever some Tags lack a meaning.
function missingTranslationCount() {
  return [
    ...GROUP_DEFS.flatMap(([key]) => appState.groups[key] || []),
    ...appState.characters.flatMap(character => [...character.promptTags, ...character.ucTags])
  ].filter(tag => tag.text && !tag.translation && !hasCjk(tag.text) && !isArtistText(tag.text)).length;
}

function updateTranslateHint() {
  const hint = $('#translateHint');
  if (!hint) return;
  const count = translationVisible() ? missingTranslationCount() : 0;
  hint.hidden = count === 0;
  hint.querySelector('span').textContent = `${count} 个 Tag 暂无中文释义`;
}

// Parameter sheet: proportional size tiles and sliders beside the number
// fields. The original inputs stay the source of truth (values and events).
const PARAM_SLIDERS = Object.freeze([
  { id: 'steps', min: 1, max: 50, step: 1 },
  { id: 'scale', min: 0, max: 10, step: 0.1 },
  { id: 'cfgRescale', min: 0, max: 1, step: 0.01 }
]);

function renderSizeTiles() {
  const host = $('#sizeTiles'), select = $('#sizePreset');
  if (!host || !select) return;
  const width = Number($('#width')?.value), height = Number($('#height')?.value);
  host.replaceChildren(...[...select.options].filter(option => option.value !== 'custom').map(option => {
    const [w, h] = option.value.split('x').map(Number);
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.sizePreset = option.value;
    button.setAttribute('aria-pressed', String(w === width && h === height));
    const shape = document.createElement('i');
    // CSSOM sizing (the page CSP blocks inline style attributes).
    const scale = 26 / Math.max(w, h);
    shape.style.width = `${Math.round(w * scale)}px`;
    shape.style.height = `${Math.round(h * scale)}px`;
    const name = document.createElement('b');
    name.textContent = option.textContent.replace(/\s*\d+×\d+\s*$/, '');
    const size = document.createElement('small');
    size.textContent = `${w}×${h}`;
    button.append(shape, name, size);
    return button;
  }));
}

function syncParamSliders() {
  for (const { id } of PARAM_SLIDERS) {
    const input = $(`#${id}`), slider = $(`[data-slider-for="${id}"]`);
    if (input && slider && input.value !== '') slider.value = input.value;
  }
}

function bindParamSheetControls() {
  for (const config of PARAM_SLIDERS) {
    const input = $(`#${config.id}`);
    if (!input || $(`[data-slider-for="${config.id}"]`)) continue;
    const slider = document.createElement('input');
    Object.assign(slider, { type: 'range', min: config.min, max: config.max, step: config.step, className: 'param-slider' });
    slider.dataset.sliderFor = config.id;
    slider.dataset.newLayoutOnly = '';
    slider.setAttribute('aria-label', input.closest('label')?.firstChild?.textContent?.trim() || config.id);
    input.after(slider);
    slider.addEventListener('input', () => { input.value = slider.value; input.dispatchEvent(new Event('input', { bubbles: true })); });
    slider.addEventListener('change', () => { input.dispatchEvent(new Event('change', { bubbles: true })); updateParameterSummary(); });
    input.addEventListener('input', () => { slider.value = input.value; });
    input.addEventListener('change', () => { slider.value = input.value; });
  }
  $('#sizeTiles')?.addEventListener('click', event => {
    const value = event.target.closest('[data-size-preset]')?.dataset.sizePreset;
    const select = $('#sizePreset');
    if (!value || !select) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    requestAnimationFrame(() => { renderSizeTiles(); updateParameterSummary(); });
  });
  ['#width', '#height', '#swapDimensionsButton', '#aspectRatio'].forEach(selector => {
    $(selector)?.addEventListener(selector === '#swapDimensionsButton' ? 'click' : 'change', () => requestAnimationFrame(renderSizeTiles));
  });
}

// New layout generate bar: the parameters that change between shots live on
// the bar itself — steps and CFG steppers (hold to repeat), a fixed/random
// seed switch that is always visible, size, and the batch count. Every control
// writes the original form field and fires its usual events.
let latestImageSeed = null;
const GEN_STEPPERS = Object.freeze({
  steps: { step: 1, min: 1, max: 50, digits: 0 },
  scale: { step: 0.1, min: 0, max: 20, digits: 1 },
  cfgRescale: { step: 0.05, min: 0, max: 1, digits: 2 },
  ucPreset: { step: 1, min: 0, max: 9, digits: 0 }
});

function stepParamField(id, direction) {
  const config = GEN_STEPPERS[id], input = $(`#${id}`);
  if (!config || !input) return;
  const current = Number(input.value);
  const base = Number.isFinite(current) ? current : config.min;
  const next = Math.min(config.max, Math.max(config.min, Math.round((base + direction * config.step) / config.step) * config.step));
  if (next === current) return;
  input.value = next.toFixed(config.digits);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  updateGenerateBar();
}

function stepBatchCount(direction) {
  const select = $('#batchCount'), custom = $('#customCount');
  if (!select || !custom) return;
  const max = Number(custom.max || 12);
  const next = Math.min(max, Math.max(1, selectedBatchCount() + direction));
  if ([...select.options].some(option => option.value === String(next))) select.value = String(next);
  else { select.value = 'custom'; custom.value = String(next); }
  select.dispatchEvent(new Event('change', { bubbles: true }));
  custom.dispatchEvent(new Event('input', { bubbles: true }));
  updateGenerateBar();
}

// One tap flips random ↔ fixed. Fixing locks the newest image's seed when
// there is one, so "keep this composition" is a single tap.
function toggleSeedMode() {
  const mode = $('#seedMode'), seed = $('#seed');
  if (!mode || !seed) return;
  if (mode.value === 'random') {
    if (Number.isFinite(latestImageSeed) && latestImageSeed > 0) seed.value = String(latestImageSeed);
    else if (!(Number(seed.value) > 0)) seed.value = String(Math.floor(Math.random() * 4294967295));
    mode.value = 'fixed';
  } else mode.value = 'random';
  mode.dispatchEvent(new Event('change', { bubbles: true }));
  seed.dispatchEvent(new Event('change', { bubbles: true }));
  updateGenerateBar();
  toast(mode.value === 'fixed' ? `Seed 已固定：${seed.value}` : 'Seed 改为每张随机');
}

function updateGenerateBar() {
  if (!$('#genSeedMode')) return;
  const steps = $('#steps')?.value || '?', scale = Number($('#scale')?.value);
  if ($('#paramStepsReadout')) $('#paramStepsReadout').textContent = `${steps} 步`;
  if ($('#genScaleValue')) $('#genScaleValue').textContent = Number.isFinite(scale) ? String(Math.round(scale * 10) / 10) : '?';
  const rescale = Number($('#cfgRescale')?.value);
  // Rescale always shows two decimals; 0 means off and reads dimmed.
  const rescaleNode = $('#genRescaleValue');
  if (rescaleNode) { rescaleNode.textContent = Number.isFinite(rescale) ? rescale.toFixed(2) : '?'; rescaleNode.classList.toggle('is-off', !(rescale > 0)); }
  if ($('#genUcValue')) $('#genUcValue').textContent = $('#ucPreset')?.value || '0';
  if ($('#paramSizeReadout')) $('#paramSizeReadout').textContent = `${$('#width')?.value || '?'}×${$('#height')?.value || '?'}`;
  const mode = $('#seedMode')?.value || 'random';
  const seedButton = $('#genSeedMode');
  seedButton.dataset.mode = mode;
  seedButton.querySelector('b').textContent = mode === 'fixed' ? '固定' : mode === 'increment' ? '递增' : '随机';
  seedButton.title = mode === 'random' ? '每张随机 Seed；点按固定' : `Seed ${$('#seed')?.value || 0}（${mode === 'fixed' ? '固定' : '逐张 +1'}）；点按改为随机`;
  if ($('#genCountValue')) $('#genCountValue').textContent = `×${selectedBatchCount()}`;
  paintLatestCanvas();
}

function bindGenerateBar() {
  document.querySelectorAll('[data-gen-step]').forEach(button => {
    bindHoldRepeat(button, () => stepParamField(button.closest('[data-gen-stepper]').dataset.genStepper, Number(button.dataset.genStep)));
  });
  document.querySelectorAll('[data-gen-count]').forEach(button => bindHoldRepeat(button, () => stepBatchCount(Number(button.dataset.genCount))));
  $('#genSeedMode')?.addEventListener('click', toggleSeedMode);
  ['#steps', '#scale', '#cfgRescale', '#ucPreset', '#seedMode', '#seed', '#batchCount', '#customCount', '#width', '#height'].forEach(selector => {
    $(selector)?.addEventListener('change', updateGenerateBar);
    $(selector)?.addEventListener('input', updateGenerateBar);
  });
  updateGenerateBar();
}

// New layout: the generate bar carries the real model / sampler / UC preset
// controls and the four option buttons. The original elements are moved (not
// copied), so IDs, listeners and saved state are untouched; switching back to
// the legacy layout returns each one to its original place.
const relocatedHomes = new Map();
let relocatedChoices = null;

function placeParameterControls() {
  const legacy = tagLayout() === 'legacy';
  relocatedChoices ??= [...document.querySelectorAll('.sticky-settings .parameter-choice')];
  const moves = [
    [$('#model'), $('#genModelSlot')],
    [$('#sampler'), $('#genSamplerSlot')],
    [$('#ucPreset'), $('#genUcSlot')],
    ...relocatedChoices.map(node => [node, $('#optionStrip')])
  ];
  for (const [node, slot] of moves) {
    if (!node || !slot) continue;
    if (!relocatedHomes.has(node)) {
      const home = document.createComment('parameter-home');
      node.before(home);
      relocatedHomes.set(node, home);
    }
    const home = relocatedHomes.get(node);
    if (legacy) home.after(node);
    else if (node.parentNode !== slot) slot.append(node);
    // The label left behind in the sheet (模型 / Sampler / UC Preset) is hidden while empty.
    if (home.parentElement?.matches('label')) home.parentElement.classList.toggle('relocated-home', !legacy);
  }
  labelDeckSampler();
}

// Short names on the bar and the option strip (equal-width cells); the full
// names come back in legacy. Runs again whenever sampler options are rebuilt
// for a model change.
var DECK_SHORT = Object.freeze({
  model: { 'nai-diffusion-5-full': 'V5 Full', 'nai-diffusion-5-curated': 'V5 Cur', 'nai-diffusion-4-5-full': 'V4.5 Full', 'nai-diffusion-4-5-curated': 'V4.5 Cur',
    'nai-diffusion-4-full': 'V4 Full', 'nai-diffusion-4-curated-preview': 'V4 Cur', 'nai-diffusion-3': 'V3' },
  sampler: { k_euler_ancestral: 'Euler A', k_euler: 'Euler', k_dpmpp_2s_ancestral: 'DPM 2S A', k_dpmpp_2m_sde: '2M SDE', k_dpmpp_2m: 'DPM 2M', k_dpmpp_sde: 'DPM SDE' },
  choice: { qualityToggle: 'Quality', preferBrownian: 'Brownian', varietyBoost: 'Variety+', nativeAlpha: '原生透明' }
});

function labelDeckSampler() {
  const legacy = tagLayout() === 'legacy';
  for (const [id, names] of [['model', DECK_SHORT?.model], ['sampler', DECK_SHORT?.sampler]]) {
    for (const option of $(`#${id}`)?.options || []) {
      option.dataset.fullLabel ??= option.textContent;
      option.textContent = legacy ? option.dataset.fullLabel : names?.[option.value] || option.dataset.fullLabel;
    }
  }
  for (const [id, short] of Object.entries(DECK_SHORT?.choice || {})) {
    const span = $(`#${id}`)?.nextElementSibling;
    if (!span) continue;
    span.dataset.fullLabel ??= span.textContent;
    span.textContent = legacy ? span.dataset.fullLabel : short;
    span.title = span.dataset.fullLabel;
  }
}

// 法典 panel (public/codex-panel.js). It changes the editor only through
// codexEditor below, which keeps rendering and undo grouping here.


// Presence ignores the artist: prefix the editor adds to known artists.
const codexTagKey = tag => stripWeightSyntax(tag.text).replace(/^artist\s*:\s*/i, '').trim().toLowerCase();

// Community prompts are often messy (full-width commas, blank lines, unclosed
// "2::" weights, doubled commas); the import parser repairs those per Tag.
// Bracket weights become plain numeric weights: copying from a codex is not
// an exact-text restore, so the { } / [ ] marks would only be noise.
const codexTags = raw => {
  const tags = (parsePromptTagsRobust(raw)?.tags || []).filter(tag => tag?.text);
  convertBracketWeights(tags);
  return tags;
};

function appendCodexTags(parsedTags) {
  const added = [];
  for (const parsed of parsedTags) {
    const tag = addTag(classifyTag(parsed.text), { ...parsed }, 1, true, '', { render: false, translate: false });
    if (tag) added.push(tag);
  }
  if (added.length) {
    renderTagGroups();
    compilePromptToPreview();
    translateSpecificTags(added.slice(0, 40)).catch(() => {});
  }
  return added.length;
}

function appendCodexCharacters(characters) {
  const limit = characterLimitForModel();
  const created = [];
  for (const character of characters) {
    if (appState.characters.length >= limit) break;
    const next = createCharacter({ name: character.name || '', promptTags: character.tags.map(tag => ({ ...tag })), ucTags: (character.ucTags || []).map(tag => ({ ...tag })) });
    appState.characters.push(next);
    created.push(next);
  }
  if (created.length) {
    renderCharacters();
    compilePromptToPreview();
    translateSpecificTags(created.flatMap(character => character.promptTags).slice(0, 40)).catch(() => {});
  }
  return { created: created.length, skipped: characters.length - created.length, limit };
}

// Replace = clear every global section, then add; one undo step.
function clearGlobalTagsForReplace() {
  let removed = 0;
  for (const [key] of GROUP_DEFS) { removed += appState.groups[key]?.length || 0; appState.groups[key] = []; }
  clearTagSelection();
  return removed;
}

// Negative prompt from an entry: append (skip present) or replace.
function appendCodexNegative(tags, { replace }) {
  const current = replace ? [] : ucChipTags();
  const keys = new Set(current.map(codexTagKey));
  let added = 0;
  const next = [...current];
  for (const tag of tags) {
    if (keys.has(codexTagKey(tag))) continue;
    keys.add(codexTagKey(tag));
    next.push(hydrateTag({ ...tag, id: uid() }));
    added += 1;
  }
  ucChipState.tags = next;
  commitUcChips();
  if (editMode.side === 'negative') renderUcChips();
  return added;
}

// Writes the original form fields and fires their usual events.
function applyCodexParams(params) {
  if (!params) return;
  const set = (id, value) => {
    const node = $(`#${id}`);
    if (!node || value === undefined || value === null) return;
    if (node.tagName === 'SELECT' && ![...node.options].some(option => option.value === String(value))) return;
    node.value = String(value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  };
  set('width', params.width); set('height', params.height);
  set('steps', params.steps); set('scale', params.scale); set('cfgRescale', params.cfgRescale);
  set('sampler', params.sampler); set('noiseSchedule', params.noiseSchedule);
  if (params.seed !== undefined) { set('seed', params.seed); set('seedMode', 'fixed'); }
  updateGenerateBar();
}

const codexEditor = {
  globalTagKeys: () => new Set(GROUP_DEFS.flatMap(([key]) => appState.groups[key] || []).map(codexTagKey)),
  negativeTagKeys: () => new Set(ucChipTags().map(codexTagKey)),
  characterTagKeys: () => appState.characters.map(ch => new Set(ch.promptTags.map(codexTagKey))),
  characterCount: () => appState.characters.length,
  appendTags: appendCodexTags,
  addNegative: appendCodexNegative,
  addCharacters: appendCodexCharacters,
  applyParams: applyCodexParams,
  // Global Tags only; characters stay.
  replaceTags(tags) {
    const removed = clearGlobalTagsForReplace();
    const count = appendCodexTags(tags);
    if (!count) { renderTagGroups(); compilePromptToPreview(); }
    return { count, removed };
  },
  // A whole entry as one undo step: the global Tags, the negative when given,
  // and the characters (the current ones are replaced by the entry's, or
  // removed when it has none).
  replaceWithEntry({ tags, negative = null, characters }) {
    const hadCharacters = appState.characters.length;
    let count = 0, created = 0;
    asOneHistoryStep(() => {
      clearGlobalTagsForReplace();
      count = appendCodexTags(tags);
      if (!count) { renderTagGroups(); compilePromptToPreview(); }
      if (negative) appendCodexNegative(negative, { replace: true });
      if (characters.length || hadCharacters) {
        appState.characters = [];
        const result = appendCodexCharacters(characters);
        if (!result.created) renderCharacters();
        created = result.created;
      }
    });
    return { count, created, hadCharacters };
  }
};

// 图片反推 (public/tagger-panel.js) writes Tags through the same editor operations.
const taggerPanel = createTaggerPanel({
  api, toast,
  parse: text => codexTags(text)[0] || null,
  tagKey: codexTagKey,
  editor: codexEditor,
  addArtist: name => addSemanticArtist({ artist: name })
});

const codexPanel = createCodexPanel({
  api, toast,
  isActive: () => activeMainTab === 'codex',
  tags: { parse: codexTags, key: codexTagKey, format: formatTag, formatWeight: formatTagWeight, hasCjk },
  editor: codexEditor
});

// 清空 in the section headers and over the negative list, and the 画风 header
// link to Storm (its bottom tab is dropped in the new layout).
function bindSectionHeaderActions() {
  document.addEventListener('click', event => {
    if (event.target.closest('[data-storm-link]')) switchTabTo('storm');
    const clear = event.target.closest('[data-section-clear]');
    if (clear) {
      const key = clear.dataset.sectionClear;
      const count = appState.groups[key]?.length || 0;
      if (!count) return;
      appState.groups[key] = [];
      clearTagSelection();
      renderTagGroups();
      compilePromptToPreview();
      toast(`已清空${GROUP_LABELS[key] || ''}（${count} 个 Tag），可撤销。`);
    }
    if (event.target.closest('#ucClearButton')) {
      const count = ucChipTags().length;
      if (!count) return;
      ucChipState.tags = [];
      commitUcChips();
      renderUcChips();
      toast(`已清空负面（${count} 个 Tag），可撤销。`);
    }
  });
}

// 翻新释义缓存: owner-started background job on the server; this dialog shows
// its progress and starts / pauses it. Polls only while the dialog is open.
let renewalTimer = 0;

async function refreshRenewalStatus() {
  try {
    renderRenewalStatus(await api('/api/translations/renewal'));
  } catch (error) {
    $('#renewalText').textContent = `读取状态失败：${error.message}`;
  }
}

function renderRenewalStatus(status) {
  const running = status.state === 'running';
  if (status.renamed > renewalSeenRenamed || (!running && status.renamed && status.renamed !== renewalSeenRenamed)) {
    renewalSeenRenamed = status.renamed;
    syncTagTranslationsFromCache().catch(() => {});
  }
  const total = Math.max(status.total || 0, status.processed + status.remaining, 1);
  const done = status.state === 'done' ? total : Math.min(total, total - status.remaining);
  $('#renewalBar').style.width = `${Math.round(done / total * 100)}%`;
  const estimate = Math.ceil(status.remaining / 8);
  const idleText = status.remaining
    ? `待检查 ${status.remaining} 个机器翻译，约 ${estimate} 次搜索（${estimate * 3} 点），预计 ${Math.max(1, Math.ceil(estimate / 6))} 分钟以上。`
    : '没有待翻新的机器翻译。';
  $('#renewalText').textContent = running || status.state === 'paused' || status.state === 'done' || status.state === 'error'
    ? `${status.message}${running || !status.remaining ? '' : ` 还剩 ${status.remaining} 个。`}`
    : idleText;
  const quota = status.quota || {};
  $('#renewalQuota').textContent = [
    quota.dailyPoints ? `今日公共搜索已用 ${quota.dailyUsed} / ${quota.dailyPoints} 点（翻新最多用到剩 1500 点为止）` : '',
    status.ownerPaused && !running ? '你已暂停：不会自动继续，点「继续」恢复。' : running && status.auto ? '这是启动后自动进行的翻新。' : ''
  ].filter(Boolean).join(' ');
  const start = $('#renewalStart');
  start.hidden = running;
  start.disabled = !status.remaining && status.state !== 'done';
  start.textContent = status.state === 'done' ? '再检查一遍' : status.resumable || status.state === 'paused' ? '继续' : '开始';
  $('#renewalStop').hidden = !running;
}

function openRenewalDialog() {
  const dialog = $('#renewalDialog');
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
  refreshRenewalStatus();
  clearInterval(renewalTimer);
  renewalTimer = setInterval(() => { if (dialog.open) refreshRenewalStatus(); else clearInterval(renewalTimer); }, 3000);
}

function bindRenewalDialog() {
  const dialog = $('#renewalDialog');
  if (!dialog) return;
  $('#renewalClose')?.addEventListener('click', () => dialog.close());
  $('#openRenewalButton')?.addEventListener('click', () => { $('#settingsDialog')?.close(); openRenewalDialog(); });
  dialog.addEventListener('close', () => clearInterval(renewalTimer));
  $('#renewalStart')?.addEventListener('click', async () => {
    renewalSeenRenamed = 0;
    try { renderRenewalStatus(await api('/api/translations/renewal', { method: 'POST', body: { action: 'start' } })); }
    catch (error) { toast(error.message, 'error'); }
  });
  $('#renewalStop')?.addEventListener('click', async () => {
    try { renderRenewalStatus(await api('/api/translations/renewal', { method: 'POST', body: { action: 'stop' } })); }
    catch (error) { toast(error.message, 'error'); }
  });
}

// Tags carry the translation they had when a scheme was saved (or when they
// were imported), so after a load or a renewal the page pulls the current text
// from this server's cache: no remote calls, no points. Translations are not
// undo steps, so the history baseline moves along with them.
let renewalSeenRenamed = 0;
let translationSyncTimer = 0;
function scheduleTranslationSync() {
  clearTimeout(translationSyncTimer);
  translationSyncTimer = setTimeout(() => syncTagTranslationsFromCache().catch(() => {}), 250);
}

async function syncTagTranslationsFromCache() {
  const tags = [
    ...GROUP_DEFS.flatMap(([key]) => appState.groups[key] || []),
    ...appState.characters.flatMap(character => [...character.promptTags, ...character.ucTags]),
    ...ucChipTags()
  ].filter(tag => tag.text && !hasCjk(tag.text));
  const texts = [...new Set(tags.map(tag => tag.text))];
  const current = new Map();
  for (let index = 0; index < texts.length; index += 100) {
    const results = await api('/api/translations/batch', { method: 'POST', body: { items: texts.slice(index, index + 100), source: 'en', target: 'zh-CN', remote: false } });
    for (const item of results) if (item?.text && item.sourceText) current.set(String(item.sourceText).toLowerCase(), item.text);
  }
  let changed = 0;
  for (const tag of tags) {
    const text = current.get(tag.text.toLowerCase());
    if (!text || text === tag.translation) continue;
    tag.translation = text;
    translationCache.set(tag.text.toLowerCase(), text);
    updateTagTranslationDom(tag.id, text);
    changed += 1;
  }
  if (changed) {
    if (editMode.side === 'negative') renderUcChips();
    if (!tagHistory.restoring) tagHistory.last = tagStateSnapshot();
    updateTranslateHint();
  }
  return changed;
}

// 快删 (quick delete): while on, one tap on any chip deletes it, the way the
// legacy cards' × did. Each delete is its own undo step; the dock stays away.
let quickDeleteMode = false;

function setQuickDelete(on) {
  quickDeleteMode = Boolean(on) && tagLayout() !== 'legacy';
  document.body.classList.toggle('quick-delete', quickDeleteMode);
  const button = $('#quickDeleteButton');
  if (button) { button.setAttribute('aria-pressed', String(quickDeleteMode)); button.textContent = quickDeleteMode ? '完成' : '快删'; }
  if (quickDeleteMode) clearTagSelection();
}

function quickDeleteTag(ref) {
  const list = tagListForRef(ref);
  const index = list?.findIndex(item => item.id === ref.id) ?? -1;
  if (index < 0) return;
  list.splice(index, 1);
  syncUcChipsIfTouched([ref]);
  refreshTagEditor();
}

// Tapping anywhere that is not a chip, the control strip or another control
// surface closes the selection.
const SELECTION_KEEPERS = '.tag-chip, #tagSelectionDock, dialog, .command-menu, #commandMenuButton, [data-history], #tagUndoButton, #tagRedoButton, .tag-drag-ghost, .codex-detail, .params-sheet-open .sticky-settings, .position-sheet';
function bindTapOutsideToClear() {
  document.addEventListener('click', event => {
    if (!tagSelection.size || tagLayout() === 'legacy' || Date.now() < tagDragSuppressClickUntil) return;
    // The path is fixed at dispatch time, so a strip button that re-rendered
    // the strip (and is now detached) still counts as inside it.
    if (event.composedPath().some(node => node instanceof Element && node.matches(SELECTION_KEEPERS))) return;
    if (!event.target.isConnected) return;
    clearTagSelection();
  });
}

// Swipe a selected chip left / right to change its weight (one 0.1 step per
// ~22px). Only selected chips respond, vertical moves still scroll, and the
// whole swipe is a single undo step.
const SCRUB_STEP_PX = 22;
function paintChipWeight(card, weight) {
  card.classList.remove('weight-up', 'weight-down', 'negative-weight');
  const cls = tagChipWeightClass(weight);
  if (cls) card.classList.add(cls);
  card.style.setProperty('--wspan', String(Math.min(1, Math.abs(weight) / 2)));
  card.querySelector('.bracket-mark')?.remove();
  let badge = card.querySelector('.chip-weight');
  if (weight === 1) { badge?.remove(); return; }
  if (!badge) {
    badge = document.createElement('em');
    badge.className = 'chip-weight';
    card.querySelector('.chip-line strong')?.after(badge);
  }
  badge.textContent = `×${formatTagWeight(weight)}`;
}

// The swipe is tracked at document level by Tag id, so a re-render of the
// chip mid-gesture (translations arriving, list refresh) does not break it.
let activeScrub = null;
function scrubTarget() {
  if (!activeScrub) return null;
  const ref = { ...activeScrub.ref, id: activeScrub.tagId };
  const tag = tagListForRef(ref)?.find(item => item.id === activeScrub.tagId);
  return tag ? { ref, tag, card: chipNode(ref) } : null;
}

function bindWeightScrub(card, ref, tag) {
  card.addEventListener('pointerdown', event => {
    if (!card.classList.contains('selected') || quickDeleteMode || event.button > 0 || !event.target.closest('.tag-copy')) return;
    activeScrub = { id: event.pointerId, ref, tagId: tag.id, x: event.clientX, y: event.clientY, start: finiteTagWeight(tag.weight), steps: 0, active: false };
  });
}

function bindWeightScrubDocument() {
  document.addEventListener('pointermove', event => {
    const scrub = activeScrub;
    if (!scrub || event.pointerId !== scrub.id) return;
    const dx = event.clientX - scrub.x, dy = event.clientY - scrub.y;
    if (!scrub.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { activeScrub = null; return; }
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      scrub.active = true;
      if (activeTagDrag && !activeTagDrag.dragging) finishTagDrag({ commit: false });
    }
    event.preventDefault();
    const target = scrubTarget();
    if (!target) { activeScrub = null; return; }
    target.card?.classList.add('scrubbing');
    const steps = Math.trunc(dx / SCRUB_STEP_PX);
    if (steps === scrub.steps) return;
    scrub.steps = steps;
    let weight = scrub.start;
    for (let i = 0; i < Math.abs(steps); i += 1) weight = stepTagWeight(weight, Math.sign(steps));
    target.tag.weight = weight;
    if (target.card) paintChipWeight(target.card, weight);
    updateTagDockValues();
    navigator.vibrate?.(4);
  }, { passive: false });
  const finish = event => {
    const scrub = activeScrub;
    if (!scrub || event.pointerId !== scrub.id) return;
    activeScrub = null;
    document.querySelectorAll('.tag-chip.scrubbing').forEach(node => node.classList.remove('scrubbing'));
    if (!scrub.active) return;
    tagDragSuppressClickUntil = Date.now() + 350;
    activeScrub = scrub;
    const target = scrubTarget();
    activeScrub = null;
    if (!target || finiteTagWeight(target.tag.weight) === scrub.start) return;
    syncUcChipsIfTouched([target.ref]);
    compilePromptToPreview();
    refreshTagChip({ ref: target.ref, tag: target.tag });
    updateTagDockValues();
  };
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
}

function bindNewLayoutControls() {
  bindTapOutsideToClear();
  bindWeightScrubDocument();
  $('#quickDeleteButton')?.addEventListener('click', () => setQuickDelete(!quickDeleteMode));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && quickDeleteMode) setQuickDelete(false); });
  document.querySelectorAll('[data-edit-side]').forEach(button => button.addEventListener('click', () => setEditMode({ side: button.dataset.editSide })));
  document.querySelectorAll('[data-edit-text]').forEach(button => button.addEventListener('click', () => setEditMode({ text: !editMode.text })));
  document.querySelectorAll('[data-history]').forEach(button => button.addEventListener('click', () => stepTagHistory(button.dataset.history === 'redo' ? 1 : -1)));
  // Module shortcuts pick the side that shows them.
  document.querySelector('.module-nav')?.addEventListener('click', event => {
    const target = event.target.closest('[data-editor-nav]')?.dataset.editorNav;
    if (!target || tagLayout() === 'legacy') return;
    if (target === 'uc') setEditMode({ side: 'negative', text: false });
    else if (target !== 'all' && target !== 'image') setEditMode({ side: 'positive', text: false });
  }, true);
  $('#commandSearchButton')?.addEventListener('click', () => {
    const open = !els.editorCommandBar.classList.contains('search-open');
    els.editorCommandBar.classList.toggle('search-open', open);
    $('#commandSearchButton').setAttribute('aria-expanded', String(open));
    if (open) els.promptTagSearch?.focus();
  });
  const menu = $('#commandMenu'), menuButton = $('#commandMenuButton');
  const closeMenu = () => { menu?.classList.add('hidden'); menuButton?.setAttribute('aria-expanded', 'false'); };
  menuButton?.addEventListener('click', event => {
    event.stopPropagation();
    const open = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !open);
    menuButton.setAttribute('aria-expanded', String(open));
  });
  // Menu items forward to the existing controls, so their behavior is unchanged.
  menu?.addEventListener('click', event => {
    if (event.target.closest('[data-menu-action="renewal"]')) { closeMenu(); openRenewalDialog(); return; }
    if (event.target.closest('[data-menu-action="brackets"]')) { closeMenu(); convertAllBracketWeights(); return; }
    if (event.target.closest('[data-menu-action="default-scheme"]')) { closeMenu(); loadDefaultScheme().catch(error => toast(error.message, 'error')); return; }
    if (event.target.closest('[data-menu-action="tagger"]')) { closeMenu(); $('#taggerFile')?.click(); return; }
    const item = event.target.closest('[data-proxy]');
    if (!item) return;
    closeMenu();
    document.querySelector(item.dataset.proxy)?.click();
  });
  document.addEventListener('click', event => { if (!event.target.closest('#commandMenu, #commandMenuButton')) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  bindWorkflowRows();
  bindCharacterTiles();
  bindParamsSheet();
  bindParamSheetControls();
  bindGenerateBar();
  $('#translateHintButton')?.addEventListener('click', () => $('#translateMissingButton')?.click());
  bindEmptySections();
  bindPositionSheet();
  codexPanel.bind();
  bindSectionHeaderActions();
  bindRenewalDialog();
  $('#ucChipAddButton')?.addEventListener('click', submitUcChipInput);
  $('#ucChipInput')?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submitUcChipInput(); }
  });
  els.negativePrompt?.addEventListener('input', () => { if (editMode.side === 'negative' && !editMode.text && ucChipState.source !== els.negativePrompt.value) renderUcChips(); });
  applyEditMode();
  bindWorkbenchSummaries();
}

// New layout: one page. Section tabs jump between flat Tag sections; the
// token meter follows the side being edited.

function promptTokenLimit() {
  return v5ModelProfile($('#model')?.value || appState.model)?.promptTokenLimit || 512;
}

const enabledTagText = tags => tags.filter(tag => tag.enabled !== false).map(tag => formatPromptTag(tag)).join(', ');
function promptTokenSource(side) {
  const characters = appState.characters.filter(character => character.enabled !== false);
  if (side === 'negative') return [els.negativePrompt?.value || '', ...characters.map(character => enabledTagText(character.ucTags))].filter(Boolean).join(', ');
  if (directPromptEdited) return els.promptPreview?.value || '';
  return [enabledTagText(globalTagsForPrompt()), ...characters.map(character => enabledTagText(character.promptTags))].filter(Boolean).join(', ');
}

function updatePromptMeter() {
  const text = $('#promptMeterText'), bar = $('#promptMeterBar');
  if (text && bar) {
    const tokens = estimatePromptTokens(promptTokenSource(editMode.side));
    const limit = promptTokenLimit();
    const ratio = tokens / limit;
    text.textContent = `≈${tokens} / ${limit}`;
    text.title = '按当前模型估算的 token，仅供参考';
    bar.style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
    bar.dataset.state = ratio >= 1 ? 'over' : ratio >= .85 ? 'warn' : 'ok';
  }
  updateParameterSummary();
}

function updateParameterSummary() {
  const node = $('#parameterSummary');
  if (!node) return;
  const model = $('#model')?.selectedOptions?.[0]?.textContent?.trim() || '';
  node.textContent = [model, `${$('#width')?.value || '?'}×${$('#height')?.value || '?'}`, `${$('#steps')?.value || '?'} 步`].filter(Boolean).join(' · ');
  if ($('#paramSizeReadout')) $('#paramSizeReadout').textContent = `${$('#width')?.value || '?'}×${$('#height')?.value || '?'}`;
  if ($('#paramStepsReadout')) $('#paramStepsReadout').textContent = `${$('#steps')?.value || '?'} 步`;
  updateGenerateBar();
}

// A flat section: heading, chips and its own "添加到…" input; no boxes.
function createTagSection(key, label, tags) {
  const section = document.createElement('section');
  section.className = `tag-group tag-section${tags.length ? '' : ' is-empty'}`;
  section.dataset.group = key;
  section.innerHTML = `
    <div class="tag-section-head"><strong>${escapeHtml(label)}</strong><span class="tag-count">${tags.filter(tag => tag.enabled !== false).length}/${tags.length}</span>${tags.length ? `<button type="button" class="tag-section-clear" data-section-clear="${key}" title="清空${escapeHtml(label)}（可撤销）">清空</button>` : ''}${key === 'style' && stormAvailable ? '<button type="button" class="tag-section-link" data-storm-link>Storm ›</button>' : ''}<button type="button" class="tag-section-add-toggle" data-section-add="${key}" aria-label="添加到${escapeHtml(label)}">＋</button></div>
    <div class="tag-list" data-drop-group="${key}"></div>
    <div class="tag-add tag-section-add">
      <input autocomplete="off" enterkeyhint="done" autocapitalize="none" spellcheck="false" placeholder="添加到${escapeHtml(label)}…" title="中英文均可；回车按逗号拆分，Shift+Enter 整块添加" data-tag-input="${key}">
      <button type="button" class="primary tag-add-button" data-add-group="${key}" aria-label="添加到${escapeHtml(label)}">＋</button>
      <div class="tag-extra-actions">
        <button type="button" class="ghost whole-add-button" data-whole-group="${key}" aria-label="整块添加">整块</button>
        <button type="button" class="ghost semantic-open-button" data-semantic-group="${key}" aria-label="Danbooru 语义搜索">语义</button>
      </div>
      <div class="suggestion-menu hidden" data-suggestions="${key}" role="listbox"></div>
    </div>`;
  const list = section.querySelector('.tag-list');
  prepareTagDropZone(list, { scope: 'global', groupKey: key });
  tags.forEach(tag => list.append(createTagCard(key, tag)));
  return section;
}

function bindWorkbenchSummaries() {
  ['#model', '#width', '#height', '#steps'].forEach(selector => {
    $(selector)?.addEventListener('change', () => requestAnimationFrame(updatePromptMeter));
    $(selector)?.addEventListener('input', () => requestAnimationFrame(updateParameterSummary));
  });
  els.negativePrompt?.addEventListener('input', updatePromptMeter);
  updatePromptMeter();
}

function updateTagTranslationDom(tagId, translation) {
  const card = document.querySelector(`[data-tag-id="${CSS.escape(tagId)}"]`);
  if (!card) return;
  const text = card.querySelector('.tag-copy strong')?.textContent || '';
  // New-layout artist chips show one normalized form (画师 / 画师 · 中文名).
  if (card.classList.contains('tag-chip') && isArtistText(text)) translation = artistTranslationLine(text, translation);
  const node = card.querySelector('.tag-translation');
  node.textContent = translation || '暂无中文释义';
  node.classList.toggle('missing', !translation);
  card.dataset.searchText = `${text} ${translation || ''}`;
  applyTagSearch();
}

function bindDropZone(list, targetGroup) {
  // Backwards-compatible wrapper: v0.8 uses one mobile-first drag system for both global and character tags.
  prepareTagDropZone(list, { scope: 'global', groupKey: targetGroup });
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function focusTagInput(groupKey) {
  requestAnimationFrame(() => {
    const input = $(`[data-tag-input="${groupKey}"]`);
    input?.focus({ preventScroll: true });
  });
}

// Where a typed Tag lands. An artist always goes to 画风, whichever section's input it was
// typed in. A pasted list is sorted by kind: each recognized Tag goes to its section and
// the rest stay where it was pasted. A single non-artist Tag stays where it was typed —
// that is a deliberate choice.
function sectionForTypedTag(target, text, { multiple = false } = {}) {
  if (/^\s*artist\s*:/i.test(text) || isConfirmedArtistTag(text)) return 'style';
  if (!multiple) return target;
  const kind = classifyTag(text);
  return kind === 'misc' ? target : kind;
}

async function submitTypedTag(groupKey, input, hideMenu, mode = 'split') {
  const raw = input.value;
  if (!raw.trim()) return;
  input.disabled = true;
  try {
    const parsedTags = splitInputToTags(raw, mode);
    const entries = [];
    for (const parsed of parsedTags) {
      if (!parsed.text) continue;
      if (hasCjk(parsed.text)) {
        const result = await api('/api/translate', { method: 'POST', body: { text: parsed.text, source: 'zh-CN', target: 'en' } });
        entries.push({
          ...parsed,
          text: result.text || parsed.text,
          exactText: result.text || parsed.text,
          translation: parsed.text,
          preserveRaw: false,
          raw: '',
          originalText: result.text || parsed.text,
          originalExactText: result.text || parsed.text
        });
      } else entries.push(parsed);
    }
    const addedTags = [];
    const moved = {};
    for (const entry of entries) {
      const section = mode === 'whole' ? groupKey : sectionForTypedTag(groupKey, entry.text, { multiple: entries.length > 1 });
      const tag = addTag(section, entry, entry.weight, true, entry.translation || '', { render: false, translate: false });
      if (!tag) continue;
      addedTags.push(tag);
      if (section !== groupKey) moved[section] = (moved[section] || 0) + 1;
    }
    input.value = '';
    hideMenu();
    if (addedTags.length) {
      renderTagGroups();
      compilePromptToPreview();
      translateSpecificTags(addedTags.filter(item => !item.translation).slice(0, 20)).catch(() => {});
      const sorted = Object.entries(moved).map(([key, count]) => `${GROUP_LABELS_BY_KEY[key] || key} ${count}`).join(' · ');
      toast(`已添加 ${addedTags.length} 个 Tag${mode === 'whole' ? '（整块）' : ''}${sorted ? `；按类别分到 ${sorted}` : ''}。`, 'success');
    } else toast('没有新增 Tag，可能已存在。');
  } catch (error) {
    toast(`添加失败：${error.message}`, 'error');
  } finally {
    const current = $(`[data-tag-input="${groupKey}"]`);
    if (current) current.disabled = false;
    focusTagInput(groupKey);
  }
}

function bindTagInputs() {
  $$('[data-tag-input]').forEach(input => {
    const groupKey = input.dataset.tagInput;
    const menu = $(`[data-suggestions="${groupKey}"]`);
    let suggestions = [];
    let activeIndex = -1;
    let composing = false;
    let requestSequence = 0;
    let suggestionController = null;
    let menuInteracting = false;

    const hideMenu = () => {
      suggestions = [];
      activeIndex = -1;
      menu.classList.add('hidden');
      menu.innerHTML = '';
    };

    const setActive = index => {
      if (!suggestions.length) return;
      activeIndex = (index + suggestions.length) % suggestions.length;
      menu.querySelectorAll('.suggestion-item').forEach((button, i) => {
        button.classList.toggle('active', i === activeIndex);
        if (i === activeIndex) button.scrollIntoView({ block: 'nearest' });
      });
    };

    const selectSuggestion = index => {
      const item = suggestions[index];
      if (!item) return;
      const added = addTag(sectionForTypedTag(groupKey, item.tag), item.tag, 1, true, item.translation || '', { translate: !item.translation });
      hideMenu();
      if (added) toast(`已添加：${item.tag}`, 'success');
      focusTagInput(groupKey);
    };

    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; });
    input.addEventListener('keydown', event => {
      if (composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'ArrowDown' && suggestions.length) {
        event.preventDefault(); setActive(activeIndex + 1); return;
      }
      if (event.key === 'ArrowUp' && suggestions.length) {
        event.preventDefault(); setActive(activeIndex <= 0 ? suggestions.length - 1 : activeIndex - 1); return;
      }
      if (event.key === 'Enter' || event.key === 'NumpadEnter') {
        event.preventDefault();
        if (!menu.classList.contains('hidden') && suggestions.length) selectSuggestion(activeIndex >= 0 ? activeIndex : 0);
        else submitTypedTag(groupKey, input, hideMenu, event.shiftKey ? 'whole' : 'split');
        return;
      }
      if (event.key === 'Escape') hideMenu();
    });

    input.parentElement.querySelector(`[data-add-group="${groupKey}"]`).addEventListener('click', () => submitTypedTag(groupKey, input, hideMenu, 'split'));
    input.parentElement.querySelector(`[data-whole-group="${groupKey}"]`)?.addEventListener('click', () => submitTypedTag(groupKey, input, hideMenu, 'whole'));
    input.parentElement.querySelector(`[data-semantic-group="${groupKey}"]`)?.addEventListener('click', () => openSemanticSearch({ scope: 'global', groupKey }, input.value));
    input.addEventListener('blur', () => setTimeout(() => { if (!menuInteracting) hideMenu(); menuInteracting = false; }, 420));
    menu.addEventListener('pointerdown', () => { menuInteracting = true; });
    menu.addEventListener('pointerup', () => { setTimeout(() => { menuInteracting = false; }, 450); });
    menu.addEventListener('click', event => {
      const button = event.target.closest('.suggestion-item');
      if (!button) return;
      event.preventDefault();
      selectSuggestion(Number(button.dataset.index));
    });

    input.addEventListener('input', debounce(async () => {
      const q = input.value.trim();
      const currentRequest = ++requestSequence;
      suggestionController?.abort();
      if (q.length < 1 || /[,，\n]/.test(q)) return hideMenu();
      suggestionController = new AbortController();
      menu.innerHTML = '<div class="suggestion-loading">正在搜索并翻译…</div>';
      menu.classList.remove('hidden');
      try {
        const results = await api(`/api/tags/suggest?model=${encodeURIComponent($('#model').value)}&q=${encodeURIComponent(q)}`, { signal: suggestionController.signal });
        if (currentRequest !== requestSequence || input.value.trim() !== q) return;
        suggestions = (Array.isArray(results) ? results : []).slice(0, 12);
        activeIndex = -1;
        menu.innerHTML = '';
        suggestions.forEach((item, index) => {
          if (item.translation) translationCache.set(item.tag.toLowerCase(), item.translation);
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'suggestion-item';
          button.dataset.index = index;
          button.setAttribute('role', 'option');
          button.innerHTML = `<span class="suggestion-copy"><strong>${escapeHtml(item.tag)}</strong><small${item.translation ? '' : ' class="missing"'}>${escapeHtml(item.translation || '暂无翻译')}</small></span><span class="suggestion-count">${formatCompactNumber(item.count)}</span>`;
          menu.append(button);
        });
        if (!suggestions.length) menu.innerHTML = '<div class="suggestion-empty">没有联想结果；仍可点右侧＋直接添加。</div>';
        menu.classList.remove('hidden');
      } catch (error) {
        if (error.name === 'AbortError') return;
        if (currentRequest !== requestSequence) return;
        menu.innerHTML = `<div class="suggestion-empty">联想暂不可用：${escapeHtml(error.message)}；可点＋直接添加。</div>`;
        menu.classList.remove('hidden');
      }
    }, 420));
  });
}

async function requestTagTranslation(groupKey, id, force = false) {
  const found = getTag(groupKey, id);
  if (!found || hasCjk(found.tag.text)) return '';
  const cached = translationCache.get(found.tag.text.toLowerCase());
  if (cached && !force) {
    found.tag.translation = cached;
    updateTagTranslationDom(id, cached);
    return cached;
  }
  const sourceText = found.tag.text;
  const result = await api('/api/translate', { method: 'POST', body: { text: sourceText, source: 'en', target: 'zh-CN', remote: true, force } });
  if (result.text && found.tag.text === sourceText) {
    found.tag.translation = result.text;
    translationCache.set(found.tag.text.toLowerCase(), result.text);
    updateTagTranslationDom(id, result.text);
  }
  return result.text || '';
}

async function translateSpecificTags(tags) {
  const pending = tags.filter(tag => tag?.text && !tag.translation && !hasCjk(tag.text) && !isArtistText(tag.text));
  if (!pending.length) return { changed: 0, missing: 0, failed: 0 };
  const results = await api('/api/translations/batch', { method: 'POST', body: { items: pending.map(tag => tag.text), source: 'en', target: 'zh-CN', remote: true } });
  const map = new Map(results.map(item => [String(item.sourceText || '').toLowerCase(), item]));
  let changed = 0, missing = 0, failed = 0;
  for (const tag of pending) {
    const result = map.get(tag.text.toLowerCase());
    if (!result?.text) { if (result?.status === 'error') failed += 1; else missing += 1; continue; }
    tag.translation = result.text;
    translationCache.set(tag.text.toLowerCase(), result.text);
    updateTagTranslationDom(tag.id, result.text);
    changed += 1;
  }
  return { changed, missing, failed };
}

async function translateMissingTags() {
  if (translationBusy) return;
  const missing = [
    ...GROUP_DEFS.flatMap(([key]) => appState.groups[key] || []),
    ...appState.characters.flatMap(character => [...character.promptTags, ...character.ucTags])
  ].filter(tag => tag.text && !tag.translation && !hasCjk(tag.text));
  if (!missing.length) return toast('当前卡片都已有中文释义。');
  translationBusy = true;
  const button = $('#translateMissingButton');
  button.disabled = true;
  try {
    let done = 0, unresolved = 0, failed = 0;
    for (let index = 0; index < missing.length; index += 30) {
      button.textContent = `翻译中 ${done}/${missing.length}`;
      const batch = await translateSpecificTags(missing.slice(index, index + 30));
      done += batch.changed; unresolved += batch.missing; failed += batch.failed;
      await sleep(120);
    }
    button.textContent = '翻译缺失';
    updateTranslateHint();
    // Only successful results are cached; report the rest instead of implying it.
    const rest = [failed ? `${failed} 个翻译服务暂时失败` : '', unresolved ? `${unresolved} 个未取得释义` : ''].filter(Boolean).join('，');
    toast(done ? `已补充 ${done} 个中文释义${rest ? `；${rest}，可稍后重试或选中 Tag 手动编辑` : '。'}` : `未补充释义：${rest || '没有可用结果'}`, done && !failed ? 'success' : '');
    await refreshTranslationStatus();
  } catch (error) {
    toast(`翻译中断：${error.message}`, 'error');
  } finally {
    translationBusy = false;
    button.disabled = false;
    button.textContent = '翻译缺失';
  }
}

async function refreshTranslationStatus() {
  try {
    const status = await api('/api/translations/status');
    const provider = ({ mymemory: 'MyMemory 免费翻译', libretranslate: 'LibreTranslate', off: '已关闭' })[status.provider] || status.provider;
    els.translationStatus.textContent = `${provider} · 已缓存 ${status.cachedCount} 条${status.manualCount ? ` · 手动修正 ${status.manualCount} 条` : ''}`;
  } catch {}
}

function tagEditorDestinationOptions(ref) {
  const globalOptions = GROUP_DEFS.map(([key, label]) => `<option value="${key}">全局 · ${escapeHtml(label)}</option>`);
  if (ref?.scope === 'global') {
    appState.characters.forEach((character, index) => {
      globalOptions.push(`<option value="character:${escapeHtml(character.id)}:prompt">角色 ${index + 1} · Prompt</option>`);
    });
  }
  return globalOptions.join('');
}

function openTagEditor(groupKeyOrRef, id) {
  const ref = typeof groupKeyOrRef === 'object'
    ? groupKeyOrRef
    : { scope: 'global', groupKey: groupKeyOrRef, id };
  const found = getScopedTag(ref);
  if (!found) return;
  editingTagRef = ref;
  els.tagEditorText.value = found.tag.text;
  els.tagEditorTranslation.value = found.tag.translation || '';
  translationDraft = createTranslationDraft(found.tag.text, found.tag.translation || '');
  els.tagEditorWeight.value = finiteTagWeight(found.tag.weight).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  els.tagEditorEnabled.checked = found.tag.enabled !== false;
  if (ref.scope === 'character') {
    els.tagEditorGroup.innerHTML = `<option value="character">${ref.kind === 'uc' ? 'Character UC' : 'Character Prompt'}</option>`;
    els.tagEditorGroup.disabled = true;
  } else {
    els.tagEditorGroup.innerHTML = tagEditorDestinationOptions(ref);
    els.tagEditorGroup.disabled = false;
    els.tagEditorGroup.value = ref.groupKey;
  }
  els.tagEditorDialog.showModal();
  setTimeout(() => els.tagEditorText.focus(), 30);
}

function closeTagEditor() {
  els.tagEditorDialog.close();
  editingTagRef = null;
  translationDraft = null;
  els.tagEditorGroup.disabled = false;
}

function syncTagEditorDraft(field) {
  if (!translationDraft) return;
  translationDraft = editTranslationDraft(translationDraft, normalizeTag(els.tagEditorText.value), els.tagEditorTranslation.value, field);
  els.tagEditorTranslation.value = translationDraft.translation;
}

async function saveTagEditor() {
  if (!editingTagRef) return;
  const ref = { ...editingTagRef };
  const found = getScopedTag(ref);
  if (!found) return closeTagEditor();
  const typedText = normalizeTag(els.tagEditorText.value);
  if (!typedText) throw new Error('英文 Tag 不能为空。');
  if (translationDraft?.text !== typedText) syncTagEditorDraft('text');
  const nextText = applyArtistPrefixToTagText(typedText, artistOverrides);
  const translation = els.tagEditorTranslation.value.trim();
  const textChanged = nextText !== found.tag.text;
  found.tag.text = nextText;
  found.tag.exactText = nextText;
  found.tag.translation = translation;
  found.tag.weight = roundTagWeight(els.tagEditorWeight.value);
  found.tag.enabled = els.tagEditorEnabled.checked;
  if (textChanged) {
    found.tag.preserveRaw = false;
    found.tag.raw = '';
    found.tag.originalText = nextText;
    found.tag.originalExactText = nextText;
    found.tag.originalWeight = found.tag.weight;
  }

  if (ref.scope !== 'character') {
    const target = els.tagEditorGroup.value;
    if (target.startsWith('character:')) {
      const [, characterId, kind = 'prompt'] = target.split(':');
      const targetList = getCharacterTagList(characterId, kind);
      if (!targetList) throw new Error('目标角色不存在，请重新打开 Tag 编辑器。');
      found.group.splice(found.index, 1);
      found.tag.originalOrder = null;
      targetList.push(found.tag);
    } else if (target !== ref.groupKey) {
      found.group.splice(found.index, 1);
      appState.groups[target].push(found.tag);
      openTagGroups.add(target);
    }
  }

  if (translation) {
    translationCache.set(nextText.toLowerCase(), translation);
    if (translationDraft?.manual) await api('/api/translations/manual', { method: 'POST', body: { sourceText: nextText, translatedText: translation, source: 'en', target: 'zh-CN' } });
  }
  closeTagEditor();
  if (ref.scope === 'character') renderCharacters();
  else { renderTagGroups(); renderCharacters(); }
  compilePromptToPreview();
  toast('Tag 已保存。', 'success');
}

async function deleteEditingTag() {
  if (!editingTagRef) return;
  const ref = { ...editingTagRef };
  const found = getScopedTag(ref);
  if (!found || !(await confirmAction(`删除 Tag“${found.tag.text}”？`, { confirmLabel: '删除', danger: true }))) return;
  found.group.splice(found.index, 1);
  closeTagEditor();
  if (ref.scope === 'character') renderCharacters();
  else renderTagGroups();
  compilePromptToPreview();
}

async function autoTranslateEditorTag() {
  const text = normalizeTag(els.tagEditorText.value);
  if (!text) return toast('先填写英文 Tag。', 'error');
  if (translationDraft?.text !== text) syncTagEditorDraft('text');
  const requestDraft = { ...translationDraft };
  const requestRef = editingTagRef;
  const button = $('#tagEditorTranslateButton');
  button.disabled = true;
  button.textContent = '翻译中…';
  try {
    const result = await api('/api/translate', { method: 'POST', body: { text, source: 'en', target: 'zh-CN', remote: true, force: true } });
    if (editingTagRef !== requestRef || !els.tagEditorDialog.open || normalizeTag(els.tagEditorText.value) !== text || !canApplyDraftTranslation(translationDraft, requestDraft)) return;
    els.tagEditorTranslation.value = result.text || '';
    translationDraft = { ...translationDraft, translation: result.text || '', manual: false, revision: translationDraft.revision + 1 };
    if (result.text) translationCache.set(text.toLowerCase(), result.text);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '自动翻译';
  }
}

function parseStructuredPrompt(raw) { return parseStructuredPromptUtil(raw); }

async function importPromptToCards(smart = true) {
  const raw = els.promptPreview.value;
  if (!raw.trim()) return toast('当前 Prompt 为空。', 'error');
  const parsedStructured = parseStructuredPrompt(raw);
  const tokens = splitPrompt(parsedStructured.globalPrompt);
  const existingCount = GROUP_DEFS.reduce((sum, [key]) => sum + appState.groups[key].length, 0) + appState.characters.length;
  if (existingCount && !(await confirmAction('这会替换现有角色与全局 Tag 卡片，但不会修改当前 Prompt。', { confirmLabel: '替换' }))) return;
  for (const [key] of GROUP_DEFS) appState.groups[key] = [];
  appState.characters = parsedStructured.characters.slice(0, characterLimitForModel(appState.model)).map(item => createCharacter({
    name: item.name,
    promptTags: tokenizePrompt(item.promptRaw).map(token => {
      const parsed = parseTagToken(token);
      const text = applyArtistPrefixToTagText(parsed.text, artistOverrides);
      return text === parsed.text ? parsed : { ...parsed, text, exactText: text };
    }),
    ucTags: tokenizePrompt(item.ucRaw).map(token => {
      const parsed = parseTagToken(token);
      const text = applyArtistPrefixToTagText(parsed.text, artistOverrides);
      return text === parsed.text ? parsed : { ...parsed, text, exactText: text };
    })
  }));
  tokens.forEach((rawTag, originalOrder) => {
    const parsed = parseWeightedTag(rawTag);
    const text = applyArtistPrefixToTagText(parsed.text, artistOverrides);
    const tagged = text === parsed.text ? parsed : { ...parsed, text, exactText: text };
    const key = smart ? classifyTag(tagged.text) : 'misc';
    appState.groups[key].push(hydrateTag({ ...tagged, originalOrder }));
  });
  appState.promptOrderMode = 'original';
  if (parsedStructured.globalUc) {
    appState.negativePrompt = parsedStructured.globalUc;
    els.negativePrompt.value = parsedStructured.globalUc;
  }
  directPromptEdited = false;
  openTagGroups.clear();
  for (const [key] of GROUP_DEFS) if (appState.groups[key].length) openTagGroups.add(key);
  renderCharacters();
  renderTagGroups();
  compilePromptToPreview(true);
  const extra = appState.characters.length ? `，识别 ${appState.characters.length} 个角色` : '';
  toast(smart ? `已智能拆分 ${tokens.length} 个全局 Tag${extra}。` : `已拆分 ${tokens.length} 个全局 Tag 到其他${extra}。`, 'success');
}

let currentNaiImport = null;
let currentNaiImportRaw = '';
let naiImportDisabledRepairIds = new Set();

function rawBundleTag(text) {
  const value = String(text || '').trim();
  return value ? hydrateTag({
    text: value, exactText: value, weight: 1, enabled: true, translation: '', bundle: true,
    preserveRaw: false, raw: '', originalText: value, originalExactText: value, originalWeight: 1
  }) : null;
}

function buildNaiImportRepairPlan(data) {
  const disabledIssueIds = [...naiImportDisabledRepairIds];
  const sections = [];
  const addSection = (id, label, raw) => {
    const review = repairImportedPrompt(raw || '', { idPrefix: id, disabledIssueIds });
    const section = { id, label, ...review };
    sections.push(section);
    return section;
  };
  const global = addSection('global', 'Global Prompt', data.prompt || '');
  const characters = (data.characters || []).map((character, index) => ({
    prompt: addSection(`character-${index + 1}-prompt`, `角色 ${character.number || index + 1} · Prompt`, character.promptRaw || ''),
    uc: addSection(`character-${index + 1}-uc`, `角色 ${character.number || index + 1} · UC`, character.ucRaw || '')
  }));
  return { global, characters, sections, issues: sections.flatMap(section => section.issues.map(issue => ({ ...issue, sectionLabel: section.label }))) };
}

function analyzeImportedPrompt(data) {
  const warnings = [...(data.warnings || [])];
  const repairPlan = buildNaiImportRepairPlan(data);
  const global = parsePromptTagsRobust(repairPlan.global.repairedText);
  warnings.push(...global.warnings);
  let tagCount = global.tags.length;
  let corrections = global.corrections + repairPlan.issues.filter(issue => issue.applied).length + (data.syntaxRepairs?.length || 0);
  const recognizedArtists = new Map();
  for (const tag of global.tags) {
    const artist = identifyArtistTag(tag.text, artistOverrides);
    if (artist.recognized) recognizedArtists.set(artist.normalized, artist);
  }
  for (const [index, character] of (data.characters || []).entries()) {
    const prompt = parsePromptTagsRobust(repairPlan.characters[index].prompt.repairedText);
    const uc = parsePromptTagsRobust(repairPlan.characters[index].uc.repairedText);
    tagCount += prompt.tags.length + uc.tags.length;
    corrections += prompt.corrections + uc.corrections;
    warnings.push(...prompt.warnings.map(message => `角色 ${character.number || '?'}：${message}`));
    warnings.push(...uc.warnings.map(message => `角色 ${character.number || '?'} UC：${message}`));
    for (const tag of [...prompt.tags, ...uc.tags]) {
      const artist = identifyArtistTag(tag.text, artistOverrides);
      if (artist.recognized) recognizedArtists.set(artist.normalized, artist);
    }
  }
  return { tagCount, corrections, warnings: [...new Set(warnings)], repairPlan, recognizedArtists: [...recognizedArtists.values()] };
}

function renderNaiImportReview(analysis, data) {
  if (!els.naiImportReview) return;
  const issues = analysis.repairPlan.issues;
  const syntaxRepairs = data.syntaxRepairs || [];
  if (!issues.length && !syntaxRepairs.length) {
    els.naiImportReview.classList.add('hidden');
    els.naiImportReview.innerHTML = '';
    return;
  }
  const rows = issues.map(issue => `
    <div class="nai-import-review-row ${issue.applied ? 'applied' : 'restored'} ${issue.confidence === 'review' ? 'needs-review' : ''}">
      <div class="nai-import-review-copy">
        <span class="nai-import-review-label">${escapeHtml(issue.sectionLabel)} · ${issue.confidence === 'review' ? '请审核' : '自动修复'}</span>
        <strong>${escapeHtml(issue.message)}</strong>
        <code><del>${escapeHtml(issue.original || '∅')}</del><span>→</span><ins>${escapeHtml(issue.replacement || '∅')}</ins></code>
      </div>
      <button type="button" class="ghost" data-import-repair-toggle="${escapeHtml(issue.id)}">${issue.applied ? '恢复原文' : '重新修复'}</button>
    </div>`).join('');
  const syntaxRows = syntaxRepairs.map(issue => `
    <div class="nai-import-review-row applied syntax-only">
      <div class="nai-import-review-copy">
        <span class="nai-import-review-label">JSON 外壳 · 仅用于读取</span>
        <strong>${escapeHtml(issue.message)}</strong>
        <small>粘贴框中的原始 JSON 没有被改写。</small>
      </div><span class="nai-import-original-kept">原文已保留</span>
    </div>`).join('');
  els.naiImportReview.classList.remove('hidden');
  els.naiImportReview.innerHTML = `
    <div class="nai-import-review-toolbar">
      <div><strong>修复审核</strong><small>黄色内容会用于“解析到 Tag 编辑器”，可逐条恢复；“原样复现”始终使用原文。</small></div>
      ${issues.length ? '<div><button type="button" class="ghost" data-import-repair-all="restore">全部恢复</button><button type="button" class="ghost" data-import-repair-all="apply">重新修复</button></div>' : ''}
    </div>${rows}${syntaxRows}`;
}

function renderNaiImportSemanticSummary(data) {
  const node = els.naiImportSemanticSummary;
  if (!node) return;
  const advanced = data?.params?.advancedOverrides;
  const extras = data?.params?.importedExtras;
  const advancedCount = advanced && typeof advanced === 'object' && !Array.isArray(advanced) ? Object.keys(advanced).length : 0;
  const extrasCount = extras && typeof extras === 'object' && !Array.isArray(extras) ? Object.keys(extras).length : 0;
  const recovery = inspectionInputStatus(data);
  if (els.naiImportWorkflowLabel) els.naiImportWorkflowLabel.textContent = inspectionOperationLabel(data);
  if (els.naiImportInputStatus) els.naiImportInputStatus.textContent = recovery.text;
  if (els.naiImportAdvancedCount) els.naiImportAdvancedCount.textContent = `${advancedCount} 项`;
  if (els.naiImportExtrasCount) els.naiImportExtrasCount.textContent = `${extrasCount} 项`;
  node.classList.remove('hidden');
  node.classList.toggle('is-ready', recovery.tone === 'ready');
  node.classList.toggle('is-warning', recovery.tone === 'warning');
}

function resetNaiImportPreview(message = '等待粘贴内容。') {
  currentNaiImport = null;
  currentNaiImportRaw = '';
  if (els.naiImportSummary) els.naiImportSummary.textContent = message;
  els.naiImportSemanticSummary?.classList.add('hidden');
  if (els.naiImportWorkflowLabel) els.naiImportWorkflowLabel.textContent = '—';
  if (els.naiImportInputStatus) els.naiImportInputStatus.textContent = '—';
  if (els.naiImportAdvancedCount) els.naiImportAdvancedCount.textContent = '0 项';
  if (els.naiImportExtrasCount) els.naiImportExtrasCount.textContent = '0 项';
  if (els.naiImportWarnings) { els.naiImportWarnings.classList.add('hidden'); els.naiImportWarnings.innerHTML = ''; }
  if (els.naiImportReview) { els.naiImportReview.classList.add('hidden'); els.naiImportReview.innerHTML = ''; }
}

function renderNaiImportPreview(data) {
  const analysis = analyzeImportedPrompt(data);
  const params = data.params || {};
  const formatLabel = data.sourceFormat === 'json' ? 'JSON' : 'NAI 文本';
  const seedLabel = Number.isFinite(Number(data.seed)) ? String(data.seed) : '随机';
  const samplerLabel = samplingProfileForModel(data.model).samplers.find(([value]) => value === params.sampler)?.[1] || params.sampler || '—';
  els.naiImportSummary.innerHTML = [
    ['格式', formatLabel],
    ['模型', data.modelDetected === false ? '未识别（导入时保持当前模型）' : schemeModelLabel(data.model)],
    ['Tag', `${analysis.tagCount} 项`],
    ['角色', `${data.characters?.length || 0} 个`],
    ['尺寸', `${params.width || '—'}×${params.height || '—'}`],
    ['采样', `${samplerLabel} · ${params.steps || '—'} Steps`],
    ['Seed', seedLabel],
    ['结构修复', analysis.corrections ? `${analysis.corrections} 处` : '无需修复'],
    ['画师识别', analysis.recognizedArtists.length ? `${analysis.recognizedArtists.length} 个` : '未识别']
  ].map(([label, value]) => `<div class="import-stat"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join('');
  renderNaiImportSemanticSummary(data);
  if (analysis.warnings.length) {
    els.naiImportWarnings.classList.remove('hidden');
    els.naiImportWarnings.innerHTML = `<strong>识别提示（${analysis.warnings.length}）</strong><ul>${analysis.warnings.slice(0, 12).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>${analysis.warnings.length > 12 ? `<small>另有 ${analysis.warnings.length - 12} 条未展开。</small>` : ''}`;
  } else {
    els.naiImportWarnings.classList.add('hidden');
    els.naiImportWarnings.innerHTML = '';
  }
  renderNaiImportReview(analysis, data);
  return analysis;
}

function analyzeNaiImportFromDialog() {
  const raw = els.naiImportText?.value || '';
  const parsed = parseNaiImport(raw);
  currentNaiImport = parsed;
  currentNaiImportRaw = raw;
  renderNaiImportPreview(currentNaiImport);
  return currentNaiImport;
}

function recoveryStateSummary(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    status: String(value.status || 'none'),
    operation: String(value.operation || ''),
    label: String(value.label || ''),
    ambiguous: value.ambiguous === true,
    reason: value.reason ? String(value.reason).slice(0, 1000) : '',
    sourceStatus: String(value.source?.status || value.sourceStatus || 'missing'),
    sourceBytes: Number(value.source?.bytes || value.sourceBytes || 0),
    maskStatus: String(value.mask?.status || value.maskStatus || 'missing'),
    maskBytes: Number(value.mask?.bytes || value.maskBytes || 0)
  };
}

function workflowMetadataSummary(value) {
  if (!value || typeof value !== 'object') return null;
  const factor = String(value.enhanceUpscaleFactor || '').trim().toLowerCase();
  const numericFactor = Number(value.enhanceUpscaleFactor);
  return {
    operation: String(value.operation || '').slice(0, 40),
    requestType: String(value.requestType || '').slice(0, 120),
    sourceStatus: String(value.sourceStatus || '').slice(0, 20),
    maskStatus: String(value.maskStatus || '').slice(0, 20),
    ambiguous: value.ambiguous === true,
    ambiguityReason: value.ambiguityReason ? String(value.ambiguityReason).slice(0, 1000) : '',
    enhanceTargetWidth: storedOptionalDimension(value.enhanceTargetWidth),
    enhanceTargetHeight: storedOptionalDimension(value.enhanceTargetHeight),
    enhanceUpscaleFactor: factor === 'max'
      ? 'max' : (Number.isFinite(numericFactor) ? Math.min(2, Math.max(1, numericFactor)) : DEFAULT_ENHANCE_UPSCALE_FACTOR)
  };
}

function buildStateFromNaiImport(data, { structured = false } = {}) {
  const state = createDefaultState();
  // Prompt dump 没有生成参数时叠当前画布/采样器/Quality，不回到 832×1216 空白态。
  
  const overlay = overlayImportOntoEditor(data, {
    model: $('#model')?.value || appState?.model || state.model,
    params: appState?.params || state.params,
    seedMode: appState?.seedMode || state.seedMode,
    seed: appState?.seed ?? state.seed,
    imageWorkflow: appState?.imageWorkflow || state.imageWorkflow,
    imageTool: appState?.imageTool || state.imageTool,
    referenceControl: appState?.referenceControl || state.referenceControl
  });
  state.model = overlay.model;
  state.params = overlay.params;
  state.seedMode = overlay.seedMode;
  state.seed = overlay.seed;
  if (overlay.keepSampling) {
    if (overlay.imageWorkflow) state.imageWorkflow = structuredClone(overlay.imageWorkflow);
    if (overlay.imageTool) state.imageTool = structuredClone(overlay.imageTool);
    if (overlay.referenceControl) state.referenceControl = structuredClone(overlay.referenceControl);
  } else {
    state.imageWorkflow = { ...state.imageWorkflow, ...(data.imageWorkflow || {}) };
    state.imageTool = { ...state.imageTool, ...(data.imageTool || {}) };
  }
  state.imageRecovery = recoveryStateSummary(data.imageRecovery);
  state.workflowMetadata = data.workflowMetadata ? structuredClone(data.workflowMetadata) : null;
  state.negativePrompt = String(data.negativePrompt || '').trim();
  state.v4Options = { ...state.v4Options, ...(data.v4Options || {}) };
  if ((data.characters || []).some(item => item.positionExplicit) && (data.characters || []).length >= 2) state.v4Options.useCoords = true;

  if (structured) {
    const repairPlan = buildNaiImportRepairPlan(data);
    const globalParsed = parsePromptTagsRobust(repairPlan.global.repairedText);
    globalParsed.tags.forEach((tag, originalOrder) => {
      const text = applyArtistPrefixToTagText(tag.text, artistOverrides);
      const prefixed = text === tag.text ? tag : { ...tag, text, exactText: text };
      const key = classifyTag(prefixed.text);
      state.groups[key].push(hydrateTag({ ...prefixed, originalOrder }));
    });
    state.promptOrderMode = 'original';
    state.characters = (data.characters || []).slice(0, characterLimitForModel(state.model)).map((item, index) => createCharacter({
      name: item.name || '', centers: item.centers,
      promptTags: parsePromptTagsRobust(repairPlan.characters[index].prompt.repairedText).tags.map(tag => {
        const text = applyArtistPrefixToTagText(tag.text, artistOverrides);
        return text === tag.text ? tag : { ...tag, text, exactText: text };
      }),
      ucTags: parsePromptTagsRobust(repairPlan.characters[index].uc.repairedText).tags.map(tag => {
        const text = applyArtistPrefixToTagText(tag.text, artistOverrides);
        return text === tag.text ? tag : { ...tag, text, exactText: text };
      }),
      enabled: true
    }));
    state.prompt = repairPlan.global.repairedText.trim();
    state.previewPrompt = state.prompt;
  } else {
    const bundle = rawBundleTag(data.prompt || '');
    if (bundle) state.groups.misc = [bundle];
    state.characters = (data.characters || []).slice(0, characterLimitForModel(state.model)).map(item => createCharacter({
      name: item.name || '', centers: item.centers,
      promptTags: item.promptRaw ? [rawBundleTag(item.promptRaw)] : [],
      ucTags: item.ucRaw ? [rawBundleTag(item.ucRaw)] : [],
      enabled: true
    }));
  }

  if (!structured) {
    state.prompt = String(data.prompt || '').trim();
    state.previewPrompt = state.prompt;
  }
  state.directMode = false;
  return state;
}

function embeddedImageBlob(media) {
  if (!media || media.status !== 'embedded' || !media.base64 || !media.mime) return null;
  const encoded = String(media.base64).replace(/\s+/g, '');
  if (!encoded || encoded.length > 24_000_000 || typeof atob !== 'function') return null;
  let binary;
  try { binary = atob(encoded); } catch { return null; }
  if (!binary.length || binary.length > 16 * 1024 * 1024) return null;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: media.mime });
}

async function attachImportedWorkflowAssets(state, data, { onProgress = null } = {}) {
  const recovery = data?.imageRecovery;
  const progress = message => { try { onProgress?.(message); } catch {} };
  const upload = async (media, label) => {
    const blob = embeddedImageBlob(media);
    if (!blob) throw new Error(`${label}不是可恢复的图片数据。`);
    return uploadWorkflowFile(blob);
  };
  const warnings = [];
  // An explicit Text2Image request is authoritative for routing.  A few
  // exporters leave a stale `image` field in the same record (for example
  // after an Enhance preview); uploading it must never change the canonical
  // mode to Img2Img.  We still retain valid embedded bytes as a *pending,
  // user-controlled source* when the record is marked ambiguous, so choosing
  // Upscale/Img2Img later does not force an unnecessary second upload.
  const operation = String(recovery?.operation || data?.workflowMetadata?.operation || state.imageWorkflow?.mode || 'text')
    .trim().toLowerCase().replace(/[\s_-]+/g, '');
  const recordedSourceStatuses = [
    recovery?.source?.status, recovery?.sourceStatus,
    data?.workflowMetadata?.sourceStatus, data?.embeddedInputImage?.status
  ].map(value => String(value || '').trim().toLowerCase());
  const mediaEvidence = recordedSourceStatuses.some(status => ['embedded', 'too-large', 'unresolved', 'upload-failed'].includes(status));
  const ambiguousTextImage = recovery?.ambiguous === true || data?.workflowMetadata?.ambiguous === true
    || (operation === 'text' && mediaEvidence);
  const restoreEmbeddedMedia = operation !== 'text' || state.imageWorkflow?.mode !== 'text' || state.imageTool?.type !== 'none' || ambiguousTextImage;
  if (restoreEmbeddedMedia && data?.embeddedInputImage?.status === 'embedded') {
    try {
      progress('正在保存记录里的输入图片为本地工作流资产…');
      const asset = await upload(data.embeddedInputImage, '输入图片');
      workflowAssetMeta.set(asset.id, asset);
      state.imageWorkflow.baseImage = structuredClone(asset.ref);
      if (state.imageTool?.type === 'none' && ['inpaint', 'img2img'].includes(operation)) {
        state.imageWorkflow.mode = operation === 'inpaint' ? 'inpaint' : 'img2img';
      }
    } catch (error) { warnings.push(`输入图片恢复失败：${error.message}`); }
  }
  // Keep a valid Mask for unresolved requests as a pending asset too.  The
  // user may later choose Inpaint from the unified selector; dropping it here
  // would force an unnecessary redraw even though the metadata contained it.
  if (restoreEmbeddedMedia && (operation === 'inpaint' || operation === 'unknown' || ambiguousTextImage) && data?.embeddedMaskImage?.status === 'embedded') {
    try {
      progress('正在保存记录里的 Mask 为本地工作流资产…');
      const asset = await upload(data.embeddedMaskImage, 'Mask');
      workflowAssetMeta.set(asset.id, asset);
      state.imageWorkflow.maskImage = structuredClone(asset.ref);
    } catch (error) { warnings.push(`Mask 恢复失败：${error.message}`); }
  }
  const hasInput = Boolean(state.imageWorkflow?.baseImage);
  const needsInput = state.imageWorkflow?.mode !== 'text' || state.imageTool?.type !== 'none';
  const unresolvedDirector = state.imageTool?.type === 'director'
    && String(state.imageTool?.reqType || '').toLowerCase() === 'unknown';
  // An embedded image can be recoverable even when the operation descriptor is
  // unknown.  Keep that request unresolved: the bytes are useful once the user
  // chooses a mode, but they do not prove which endpoint should receive them.
  if (operation === 'unknown') {
    state.imageRecovery = {
      ...(recoveryStateSummary(recovery) || {}), status: 'unresolved', operation,
      label: '未知图片工作流',
      reason: '输入图片已暂存，但请求类型未识别；请在上方手动选择工作流后再生成。'
    };
  } else if (ambiguousTextImage) {
    // The bytes are useful as a pending source, but an embedded image paired
    // with a Text2Image marker is not proof of the endpoint.  Do not label it
    // `ready`: that would make the recovery badge say “已恢复” while the
    // selector correctly remains “待确认”.
    state.imageRecovery = {
      ...(recoveryStateSummary(recovery) || {}),
      status: 'unresolved', operation: 'text', label: '待确认', ambiguous: true,
      sourceStatus: hasInput ? 'embedded' : (recovery?.sourceStatus || 'missing'),
      reason: '输入图片已暂存，但记录同时标为文生图；请在上方明确选择工作流后再生成。'
    };
  } else if (hasInput) {
    state.imageRecovery = {
      ...(recoveryStateSummary(recovery) || {}),
      status: unresolvedDirector
        ? 'unresolved'
        : state.imageWorkflow?.mode === 'inpaint' && !state.imageWorkflow.maskImage ? 'missing' : 'ready'
    };
  } else if (needsInput && recovery?.status !== 'none') {
    state.imageRecovery = recoveryStateSummary(recovery);
  }
  if (warnings.length) {
    state.imageRecovery = { ...(state.imageRecovery || {}), status: 'upload-failed', reason: warnings.join(' ').slice(0, 1000) };
  }
  return warnings;
}

async function applyNaiImport({ structured = false, generate = false } = {}) {
  if (naiImportBusy) return;
  naiImportBusy = true;
  const actionButtons = [$('#importNaiStructuredButton'), $('#importNaiDirectButton')].filter(Boolean);
  actionButtons.forEach(button => { button.disabled = true; });
  const actionStatus = els.naiImportActionStatus;
  if (actionStatus) {
    actionStatus.classList.remove('hidden');
    actionStatus.textContent = '正在整理导入内容…';
  }
  try {
    const raw = els.naiImportText?.value || '';
    // The preview is debounced for paste-heavy input.  Never apply a parsed
    // object that belongs to an older textarea value when the user clicks
    // immediately after editing.
    const data = currentNaiImport && currentNaiImportRaw === raw
      ? currentNaiImport
      : analyzeNaiImportFromDialog();
    const hasPositivePrompt = Boolean(data.prompt) || (data.characters || []).some(item => item.promptRaw);
    const importedToolType = String(data.imageTool?.type || '').trim().toLowerCase();
    // Official image tools are source-driven and may legitimately omit a
    // positive Prompt (dedicated Upscale and Director requests). Text,
    // Img2Img, Enhance, and Inpaint still need an editable Prompt before
    // they can be queued; an unknown image descriptor is allowed into the
    // editor so the user can choose a workflow first.
    const promptRequired = !['upscale', 'director'].includes(importedToolType)
      && String(data.operation || '').trim().toLowerCase() !== 'unknown';
    if (!hasPositivePrompt && promptRequired) throw new Error('导入内容里没有可生成的正向 Prompt。');
    const state = withCurrentGenerationRoute(buildStateFromNaiImport(data, { structured }));
    // Do this check before uploading embedded bytes.  A direct-generation
    // click must never create a durable input asset for a record whose route
    // is still ambiguous; the user has to make the endpoint choice first.
    if (generate && workflowModeForState(state) === 'unknown') {
      throw new Error('这份导入记录的工作流仍待确认；请先用“解析到编辑器”，在生成方式选择器明确选择文生图、图生图、Enhance、Upscale 或局部重绘。');
    }
    const workflowWarnings = await attachImportedWorkflowAssets(state, data, { onProgress: message => { if (actionStatus) actionStatus.textContent = message; } });
    if (generate && workflowModeForState(state) === 'unknown') {
      throw new Error('这份导入记录的工作流仍待确认；请先用“解析到编辑器”，在生成方式选择器明确选择文生图、图生图、Enhance、Upscale 或局部重绘。');
    }
    hydrateState(state);
    els.naiImportDialog?.close();
    switchTabTo('editor');
    if (structured) {
      toast(`已解析到 Tag 编辑器并保留 Global Tag 原始顺序：${analyzeImportedPrompt(data).tagCount} 个 Tag，${data.characters?.length || 0} 个角色。`, 'success');
    } else {
      toast('已按原始 Prompt 结构载入；不会为了整齐重写复制内容。', 'success');
    }
    if (workflowWarnings.length) toast(workflowWarnings.join(' '), 'error');
    else if (state.imageRecovery?.status === 'missing') toast(state.imageRecovery.reason, 'error');
    if (generate) {
      if (actionStatus) actionStatus.textContent = '正在把导入工作流加入队列…';
      await enqueue(1, state);
    }
  } finally {
    naiImportBusy = false;
    actionButtons.forEach(button => { button.disabled = false; });
    actionStatus?.classList.add('hidden');
  }
}

function openNaiImportDialog() {
  resetNaiImportPreview();
  naiImportDisabledRepairIds.clear();
  els.naiImportDialog?.showModal();
  setTimeout(() => els.naiImportText?.focus(), 30);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatCompactNumber(value) {
  const n = Number(value || 0);
  return Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function formatBytes(value) {
  const n = Number(value || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function workflowRefUrl(ref) {
  return ref?.source === 'asset' && ref?.id ? `/api/assets/${encodeURIComponent(ref.id)}/original` : '';
}

function roundImageDimension(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(2048, Math.max(64, Math.round(n / 64) * 64));
}

function setWorkflowDimensionsFromAsset(asset) {
  const width = roundImageDimension(asset?.width);
  const height = roundImageDimension(asset?.height);
  if (!width || !height) return;
  $('#width').value = width;
  $('#height').value = height;
  syncSizePreset();
}

function workflowAssetLabel(ref) {
  if (!ref?.id) return '未选择';
  const meta = workflowAssetMeta.get(ref.id);
  if (!meta) return `资产 ${String(ref.id).slice(0, 8)}`;
  const size = meta.width && meta.height ? `${meta.width}×${meta.height}` : '尺寸未知';
  return `${size} · ${formatBytes(meta.bytes || 0)}`;
}

function setGenerationMode(mode) {
  const requestedMode = String(mode || '').trim().toLowerCase();
  if (!['text', 'img2img', 'enhance', 'upscale', 'inpaint'].includes(requestedMode)) return;
  const defaults = createDefaultState();
  const workflow = appState.imageWorkflow || (appState.imageWorkflow = structuredClone(defaults.imageWorkflow));
  const previousMode = workflowModeForState(appState);

  // The selector exposes user-facing operations, while persisted state keeps
  // the provider-compatible shape used by sanitizeGenerationState/buildPayload.
  // Keep the current input image so the user can compare operations without
  // re-uploading it; clear only fields that could silently route a request.
  workflow.enhanceTargetWidth = null;
  workflow.enhanceTargetHeight = null;
  appState.imageRecovery = null;
  appState.workflowMetadata = null;

  if (requestedMode === 'enhance') {
    workflow.mode = 'img2img';
    workflow.enhance = true;
    appState.imageTool = structuredClone(defaults.imageTool);
  } else if (requestedMode === 'upscale') {
    workflow.mode = 'text';
    workflow.enhance = false;
    appState.imageTool = { type: 'upscale', scale: 4, reqType: '', prompt: '', defry: 0 };
  } else {
    workflow.mode = requestedMode;
    workflow.enhance = false;
    appState.imageTool = structuredClone(defaults.imageTool);
  }

  // Masks belong to one inpaint source. Preserve a recovered Mask when the
  // record was explicitly unresolved and the user is now choosing Inpaint;
  // otherwise never carry a mask into another operation where it could be
  // stale.
  const preserveRecoveredMask = requestedMode === 'inpaint'
    && workflow.maskImage
    && (previousMode === 'inpaint' || previousMode === 'unknown');
  if (!preserveRecoveredMask) workflow.maskImage = null;
  maskDrawing = requestedMode === 'inpaint' && (previousMode === 'inpaint' || preserveRecoveredMask) ? maskDrawing : false;
  if (!preserveRecoveredMask) resetMaskCanvas();
  renderImageWorkflow();
}

function setReferenceMode(mode) {
  if (!['none', 'precise', 'vibe'].includes(mode)) return;
  if (mode === 'precise' && !supportsPreciseReference()) {
    toast('Precise Reference 当前仅支持 V4.5；请先切换模型。', 'error');
    return;
  }
  if (mode === 'vibe' && !supportsVibeTransfer()) {
    toast('NovelAI V5 首发暂不支持 Vibe Transfer；请先切换到 V4/V4.5。', 'error');
    return;
  }
  appState.referenceControl.mode = mode;
  if (mode === 'precise' && !appState.referenceControl.precise.length) appState.referenceControl.precise.push({ image: null, type: 'character', strength: 0.6, fidelity: 0.5 });
  if (mode === 'vibe' && !appState.referenceControl.vibes.length) appState.referenceControl.vibes.push({ image: null, strength: 0.6, informationExtracted: 1 });
  renderImageWorkflow();
}

function renderPreciseReferences() {
  if (!els.preciseReferenceList) return;
  const list = appState.referenceControl.precise || [];
  if (!list.length) {
    els.preciseReferenceList.classList.add('empty-state');
    els.preciseReferenceList.textContent = '暂无参考图。';
    return;
  }
  els.preciseReferenceList.classList.remove('empty-state');
  els.preciseReferenceList.innerHTML = list.map((item, index) => {
    const url = workflowRefUrl(item.image);
    return `<article class="reference-card" data-pr-index="${index}">
      <button class="reference-thumb" type="button" data-ref-pick>${url ? `<img src="${url}" alt="Precise Reference ${index + 1}">` : '<span>＋ 图片</span>'}</button>
      <div class="reference-fields">
        <div class="reference-card-head"><strong>PR ${index + 1}</strong><button class="ghost danger compact" type="button" data-ref-delete>删除</button></div>
        <label>类型<select data-ref-type><option value="character" ${item.type === 'character' ? 'selected' : ''}>Character</option><option value="style" ${item.type === 'style' ? 'selected' : ''}>Style</option><option value="character&style" ${item.type === 'character&style' ? 'selected' : ''}>Character + Style</option></select></label>
        <label>Strength <span>${Number(item.strength ?? .6).toFixed(2)}</span><input data-ref-strength type="range" min="0" max="1" step="0.01" value="${Number(item.strength ?? .6)}"></label>
        <label>Fidelity <span>${Number(item.fidelity ?? .5).toFixed(2)}</span><input data-ref-fidelity type="range" min="0" max="1" step="0.01" value="${Number(item.fidelity ?? .5)}"></label>
      </div>
    </article>`;
  }).join('');
  els.preciseReferenceList.querySelectorAll('[data-pr-index]').forEach(card => {
    const index = Number(card.dataset.prIndex);
    card.querySelector('[data-ref-pick]')?.addEventListener('click', () => openImagePicker({ kind: 'precise', index }));
    card.querySelector('[data-ref-delete]')?.addEventListener('click', () => {
      appState.referenceControl.precise.splice(index, 1);
      if (!appState.referenceControl.precise.length) appState.referenceControl.mode = 'none';
      renderImageWorkflow();
    });
    card.querySelector('[data-ref-type]')?.addEventListener('change', event => { appState.referenceControl.precise[index].type = event.target.value; });
    card.querySelector('[data-ref-strength]')?.addEventListener('input', event => {
      appState.referenceControl.precise[index].strength = Number(event.target.value);
      event.target.closest('label').querySelector('span').textContent = Number(event.target.value).toFixed(2);
    });
    card.querySelector('[data-ref-fidelity]')?.addEventListener('input', event => {
      appState.referenceControl.precise[index].fidelity = Number(event.target.value);
      event.target.closest('label').querySelector('span').textContent = Number(event.target.value).toFixed(2);
    });
  });
}

function renderVibeReferences() {
  if (!els.vibeReferenceList) return;
  const list = appState.referenceControl.vibes || [];
  const total = list.reduce((sum, item) => sum + Number(item.strength || 0), 0);
  if (els.vibeTotalStrength) {
    els.vibeTotalStrength.textContent = total.toFixed(2);
    els.vibeTotalStrength.classList.toggle('warning-text', total > 1.0001);
  }
  if (!list.length) {
    els.vibeReferenceList.classList.add('empty-state');
    els.vibeReferenceList.textContent = '暂无 Vibe。';
    return;
  }
  els.vibeReferenceList.classList.remove('empty-state');
  els.vibeReferenceList.innerHTML = list.map((item, index) => {
    const url = workflowRefUrl(item.image);
    return `<article class="reference-card" data-vibe-index="${index}">
      <button class="reference-thumb" type="button" data-ref-pick>${url ? `<img src="${url}" alt="Vibe ${index + 1}">` : '<span>＋ 图片</span>'}</button>
      <div class="reference-fields">
        <div class="reference-card-head"><strong>Vibe ${index + 1}</strong><button class="ghost danger compact" type="button" data-ref-delete>删除</button></div>
        <label>Reference Strength <span>${Number(item.strength ?? .6).toFixed(2)}</span><input data-vibe-strength type="range" min="0" max="1" step="0.01" value="${Number(item.strength ?? .6)}"></label>
        <label>Information Extracted <span>${Number(item.informationExtracted ?? 1).toFixed(2)}</span><input data-vibe-info type="range" min="0" max="1" step="0.01" value="${Number(item.informationExtracted ?? 1)}"></label>
      </div>
    </article>`;
  }).join('');
  els.vibeReferenceList.querySelectorAll('[data-vibe-index]').forEach(card => {
    const index = Number(card.dataset.vibeIndex);
    card.querySelector('[data-ref-pick]')?.addEventListener('click', () => openImagePicker({ kind: 'vibe', index }));
    card.querySelector('[data-ref-delete]')?.addEventListener('click', () => {
      appState.referenceControl.vibes.splice(index, 1);
      if (!appState.referenceControl.vibes.length) appState.referenceControl.mode = 'none';
      renderImageWorkflow();
    });
    card.querySelector('[data-vibe-strength]')?.addEventListener('input', event => {
      appState.referenceControl.vibes[index].strength = Number(event.target.value);
      event.target.closest('label').querySelector('span').textContent = Number(event.target.value).toFixed(2);
      const nextTotal = (appState.referenceControl.vibes || []).reduce((sum, item) => sum + Number(item.strength || 0), 0);
      if (els.vibeTotalStrength) {
        els.vibeTotalStrength.textContent = nextTotal.toFixed(2);
        els.vibeTotalStrength.classList.toggle('warning-text', nextTotal > 1.0001);
      }
    });
    card.querySelector('[data-vibe-info]')?.addEventListener('input', event => {
      appState.referenceControl.vibes[index].informationExtracted = Number(event.target.value);
      event.target.closest('label').querySelector('span').textContent = Number(event.target.value).toFixed(2);
    });
  });
}

function renderImageWorkflow() {
  const workflow = appState.imageWorkflow || createDefaultState().imageWorkflow;
  const tool = appState.imageTool || createDefaultState().imageTool;
  const hasOfficialTool = tool.type && tool.type !== 'none';
  const selectedGenerationMode = workflowModeForState(appState);
  const reference = appState.referenceControl || createDefaultState().referenceControl;
  const recoveryStatus = String(appState.imageRecovery?.status || '').toLowerCase();
  const recoveryOperation = String(appState.imageRecovery?.operation || appState.workflowMetadata?.operation || '')
    .trim().toLowerCase().replace(/[\s_-]+/g, '');
  const ambiguousWorkflow = selectedGenerationMode === 'unknown';
  const unresolvedWorkflow = ambiguousWorkflow || (recoveryStatus === 'unresolved' && recoveryOperation === 'unknown');
  if ($('#nativeAlpha')) $('#nativeAlpha').disabled = !isV5Model();
  if (els.generationModeSwitch) els.generationModeSwitch.dataset.activeMode = selectedGenerationMode;
  if (els.generationModeSelect) {
    els.generationModeSelect.value = selectedGenerationMode;
    els.generationModeSelect.setAttribute('aria-label', `生成方式：${workflowModeLabel(selectedGenerationMode)}`);
  }
  // Keep compatibility with any older markup that still uses generation
  // buttons, while the current UI uses the single select above.
  document.querySelectorAll('[data-generation-mode]:not(option)').forEach(button => button.classList.toggle('active', button.dataset.generationMode === selectedGenerationMode));
  document.querySelectorAll('[data-reference-mode]').forEach(button => {
    const active = button.dataset.referenceMode === reference.mode;
    button.classList.toggle('active', active);
    const unsupportedPrecise = button.dataset.referenceMode === 'precise' && !supportsPreciseReference();
    const unsupportedVibe = button.dataset.referenceMode === 'vibe' && !supportsVibeTransfer();
    button.disabled = (unsupportedPrecise || unsupportedVibe) && !active;
  });
  els.baseImageWorkflow?.classList.toggle('hidden', workflow.mode === 'text' && !hasOfficialTool && !unresolvedWorkflow);
  els.inpaintEditor?.classList.toggle('hidden', workflow.mode !== 'inpaint');
  if (els.baseImageWorkflowTitle) els.baseImageWorkflowTitle.textContent = unresolvedWorkflow
    ? '待确认的图片工作流'
    : workflow.mode === 'inpaint'
    ? '局部重绘原图'
    : hasOfficialTool ? '官方工具输入图片' : workflow.enhance ? '官方 Enhance 原图' : '图生图输入';
  if (els.baseImageWorkflowHint) {
    els.baseImageWorkflowHint.classList.toggle('hidden', !unresolvedWorkflow);
    els.baseImageWorkflowHint.textContent = unresolvedWorkflow
      ? (recoveryOperation === 'unknown'
      ? '导入记录的请求类型未识别；请在上方“生成方式”手动选择后再生成。'
      : workflow.baseImage
        ? '记录同时带有文生图标记和输入图数据；输入图已暂存但不能证明原操作，请在上方明确选择工作流。'
        : '记录同时带有文生图标记和输入图信息，无法仅凭 PNG 证明是否做过 Upscale；请在上方明确选择，若选图片工作流再提供原图。')
      : '';
  }
  const baseUrl = workflowRefUrl(workflow.baseImage);
  if (els.baseImagePreview) {
    els.baseImagePreview.src = baseUrl || '';
    els.baseImagePreview.classList.toggle('hidden', !baseUrl);
  }
  els.baseImagePlaceholder?.classList.toggle('hidden', Boolean(baseUrl));
  const missingSource = workflow.mode !== 'text' && !baseUrl;
  const missingToolSource = hasOfficialTool && !baseUrl;
  const unresolvedTool = hasOfficialTool && tool.type === 'director' && String(tool.reqType || '').toLowerCase() === 'unknown';
  const recoveryReason = appState.imageRecovery?.reason || (ambiguousWorkflow
    ? '这份记录的文本标记与输入图信息不一致；请手动选择文生图、图生图、Enhance 或 Upscale。'
    : unresolvedTool
    ? '检测到 Director 工具请求，但具体工具类型尚未识别；请重新选择工具。'
    : missingSource || missingToolSource
    ? '当前工作流需要输入图片；请重新选择原图后再生成。'
    : '');
  if (els.baseImageMeta) els.baseImageMeta.textContent = missingSource || missingToolSource
    ? recoveryReason
    : workflowAssetLabel(workflow.baseImage);
  if (els.workflowRecoveryHint) {
    const showRecovery = Boolean(recoveryReason) && (ambiguousWorkflow || unresolvedTool || missingSource || missingToolSource || appState.imageRecovery?.status === 'ready' || ['missing', 'unresolved', 'too-large', 'upload-failed'].includes(recoveryStatus));
    els.workflowRecoveryHint.classList.toggle('hidden', !showRecovery);
    els.workflowRecoveryHint.textContent = showRecovery
      ? (appState.imageRecovery?.status === 'ready' && !missingSource && !missingToolSource
        ? `已恢复${appState.imageRecovery.label || '工作流'}输入图片。`
        : recoveryReason)
      : '';
  }
  if (els.imageStrength) els.imageStrength.value = String(workflow.strength ?? 0.65);
  if (els.imageStrengthValue) els.imageStrengthValue.textContent = Number(workflow.strength ?? .65).toFixed(2);
  if (els.imageNoise) els.imageNoise.value = String(workflow.noise ?? 0);
  if (els.imageNoiseValue) els.imageNoiseValue.textContent = Number(workflow.noise ?? 0).toFixed(2);
  if (els.imageColorCorrect) els.imageColorCorrect.checked = workflow.colorCorrect === true;
  // Until an ambiguous import is resolved, do not present Strength/Noise as
  // if they belonged to a known endpoint.  They become editable immediately
  // after the user selects Img2Img, Enhance, or Inpaint.
  els.workflowSliderGrid?.classList.toggle('hidden', ambiguousWorkflow || (hasOfficialTool && !workflow.enhance));
  els.officialImageToolPanel?.classList.toggle('hidden', !hasOfficialTool && !workflow.enhance);
  const toolNames = {
    upscale: 'NovelAI 官方 Upscale', lineart: 'Director Tools · Line Art', sketch: 'Director Tools · Sketch',
    'bg-removal': 'Director Tools · Remove Background', declutter: 'Director Tools · Declutter',
    colorize: 'Director Tools · Colorize', emotion: 'Director Tools · Emotion'
  };
  if (els.officialImageToolName) els.officialImageToolName.textContent = workflow.enhance ? 'NovelAI 官方 Enhance' : (toolNames[tool.type] || 'NovelAI 官方图片工具');
  if (els.officialImageToolHint) {
    const targetHint = workflow.enhance && workflow.enhanceTargetWidth && workflow.enhanceTargetHeight
      ? `记录目标 ${workflow.enhanceTargetWidth}×${workflow.enhanceTargetHeight}；可用下方档位重新调整。`
      : '';
    els.officialImageToolHint.classList.toggle('hidden', !targetHint);
    els.officialImageToolHint.textContent = targetHint;
  }
  els.enhanceUpscaleFactorField?.classList.toggle('hidden', !workflow.enhance);
  els.officialUpscaleScaleField?.classList.toggle('hidden', tool.type !== 'upscale');
  els.officialDirectorPromptField?.classList.toggle('hidden', tool.type !== 'director' || !['colorize', 'emotion'].includes(tool.reqType));
  els.officialDirectorDefryField?.classList.toggle('hidden', tool.type !== 'director' || !['colorize', 'emotion'].includes(tool.reqType));
  const maxEnhanceOption = els.enhanceUpscaleFactor?.querySelector('option[value="max"]');
  const maxEnhanceSupported = isV5Model();
  if (maxEnhanceOption) maxEnhanceOption.disabled = !maxEnhanceSupported;
  const enhanceFactor = workflow.enhanceUpscaleFactor === 'max'
    ? (maxEnhanceSupported ? 'max' : String(DEFAULT_ENHANCE_UPSCALE_FACTOR))
    : String(workflow.enhanceUpscaleFactor ?? DEFAULT_ENHANCE_UPSCALE_FACTOR);
  if (!maxEnhanceSupported && workflow.enhanceUpscaleFactor === 'max') {
    appState.imageWorkflow.enhanceUpscaleFactor = DEFAULT_ENHANCE_UPSCALE_FACTOR;
  }
  if (els.enhanceUpscaleFactor) els.enhanceUpscaleFactor.value = enhanceFactor;
  if (els.officialDirectorPrompt) els.officialDirectorPrompt.value = String(tool.prompt || '');
  if (els.officialDirectorDefry) els.officialDirectorDefry.value = String(Number(tool.defry || 0));

  els.preciseReferencePanel?.classList.toggle('hidden', reference.mode !== 'precise');
  els.vibeReferencePanel?.classList.toggle('hidden', reference.mode !== 'vibe');
  renderPreciseReferences();
  renderVibeReferences();
  if (workflow.mode === 'inpaint') syncInpaintBaseImage();
  else inpaintImageEpoch += 1;
  updateWorkflowRows();
}

async function uploadWorkflowFile(file) {
  if (!file) throw new Error('没有选择图片。');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('只支持 PNG / JPEG / WebP。');
  const asset = await api('/api/assets', {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'x-file-name': encodeURIComponent(file.name || 'upload') },
    body: file
  });
  workflowAssetMeta.set(asset.id, asset);
  return asset;
}

async function cloneGalleryToWorkflowAsset(imageId) {
  const asset = await api('/api/assets/from-gallery', { method: 'POST', body: { imageId } });
  workflowAssetMeta.set(asset.id, asset);
  return asset;
}

function applyWorkflowAsset(asset, expectedToken = imagePickerActionToken) {
  if (!asset?.ref || !imagePickerTarget || expectedToken !== imagePickerActionToken) return false;
  const target = imagePickerTarget;
  const modeBeforeAsset = workflowModeForState(appState);
  workflowAssetMeta.set(asset.id, asset);
  if (target.kind === 'base') {
    const previousBaseId = String(appState.imageWorkflow?.baseImage?.id || '');
    const nextBaseId = String(asset.ref?.id || '');
    const existingMask = appState.imageWorkflow?.maskImage;
    // If an imported inpaint record retained a Mask but not its source, the
    // first source selection should complete that workflow without throwing
    // away the still-valid Mask.  A genuinely different source invalidates
    // the old mask, while re-selecting the same source is safe.
    const preserveInpaintMask = (appState.imageWorkflow?.mode === 'inpaint' || modeBeforeAsset === 'unknown')
      && existingMask
      && (!previousBaseId || previousBaseId === nextBaseId);
    appState.imageWorkflow.baseImage = structuredClone(asset.ref);
    if (!preserveInpaintMask) appState.imageWorkflow.maskImage = null;
    if (appState.imageWorkflow.enhance) {
      // A replacement source has different dimensions; an imported Enhance
      // target is only a hint for the old source and must not leak forward.
      appState.imageWorkflow.enhanceTargetWidth = null;
      appState.imageWorkflow.enhanceTargetHeight = null;
    }
    const activeOperation = appState.imageTool?.type && appState.imageTool.type !== 'none'
      ? appState.imageTool.type
      : appState.imageWorkflow.enhance ? 'img2img' : appState.imageWorkflow.mode;
    const activeLabel = activeOperation === 'upscale' ? 'Upscale'
      : activeOperation === 'director' ? 'Director 工具'
        : appState.imageWorkflow.enhance ? '官方 Enhance'
          : appState.imageWorkflow.mode === 'inpaint' ? '局部重绘' : '图生图';
    const unresolvedDirector = appState.imageTool?.type === 'director'
      && String(appState.imageTool?.reqType || '').toLowerCase() === 'unknown';
    appState.imageRecovery = modeBeforeAsset === 'unknown'
      ? { status: 'unresolved', operation: 'unknown', label: '待确认', reason: '输入图片已确认，但记录的工作流仍有歧义；请先在上方选择生成方式。' }
      : unresolvedDirector
      ? { status: 'unresolved', operation: activeOperation, label: activeLabel, reason: '检测到 Director 工具请求，但具体工具类型尚未识别；请重新选择工具。' }
      : appState.imageWorkflow.mode === 'inpaint'
        ? appState.imageWorkflow.maskImage
          ? { status: 'ready', operation: 'inpaint', label: '局部重绘' }
          : { status: 'missing', operation: 'inpaint', label: '局部重绘', reason: '原图已恢复；还需要绘制并保存 Mask。' }
        : { status: 'ready', operation: activeOperation, label: activeLabel };
    appState.workflowMetadata = null;
    if (preserveInpaintMask) {
      // Force the inpaint preview to re-read the saved Mask even when the
      // user picked the same source again; otherwise syncInpaintBaseImage()
      // can see an unchanged asset/mask pair and leave a just-cleared canvas.
      if (els.inpaintBaseImage) {
        delete els.inpaintBaseImage.dataset.assetId;
        delete els.inpaintBaseImage.dataset.maskId;
      }
    } else {
      resetMaskCanvas();
    }
    setWorkflowDimensionsFromAsset(asset);
  } else if (target.kind === 'precise') {
    const index = Number(target.index);
    if (!appState.referenceControl.precise[index]) appState.referenceControl.precise[index] = { image: null, type: 'character', strength: .6, fidelity: .5 };
    appState.referenceControl.precise[index].image = structuredClone(asset.ref);
  } else if (target.kind === 'vibe') {
    const index = Number(target.index);
    if (!appState.referenceControl.vibes[index]) appState.referenceControl.vibes[index] = { image: null, strength: .6, informationExtracted: 1 };
    appState.referenceControl.vibes[index].image = structuredClone(asset.ref);
  }
  imagePickerTarget = null;
  imagePickerActionToken += 1;
  // Keep the picker open for one paint frame after a successful confirmation
  // so the completion status is actually visible.  The callers also show a
  // toast, but the inline status is useful when the first gallery read is
  // slow or the picker is being used on a narrow screen.
  if (els.imagePickerStatus) {
    els.imagePickerStatus.classList.remove('hidden');
    els.imagePickerStatus.textContent = target.kind === 'base'
      ? '图片已确认并保存为本地输入资产。'
      : '图片已确认。';
  }
  const closeToken = imagePickerActionToken;
  const closeWhenIdle = () => {
    if (imagePickerActionToken !== closeToken) return;
    // The caller normally clears the busy flag in the same turn.  If a
    // post-confirmation cleanup takes longer than the 180 ms visibility
    // window, retry instead of leaving the dialog stranded open forever.
    if (imagePickerActionBusy) {
      window.setTimeout(closeWhenIdle, 80);
      return;
    }
    els.imagePickerDialog?.close();
  };
  window.setTimeout(closeWhenIdle, 180);
  renderImageWorkflow();
  return true;
}

function renderImagePickerGallery(images = []) {
  if (!els.imagePickerGallery) return;
  if (!images.length) {
    els.imagePickerGallery.classList.add('empty-state');
    els.imagePickerGallery.textContent = '图库还是空的；可以直接从设备上传。';
    return;
  }
  els.imagePickerGallery.classList.remove('empty-state');
  els.imagePickerGallery.innerHTML = images.map(image => `<button class="image-picker-item" type="button" data-picker-gallery-id="${escapeHtml(image.id)}"><img src="${escapeHtml(image.thumbUrl)}" alt="图库图片"><span>Seed ${image.seed}</span></button>`).join('');
  els.imagePickerGallery.querySelectorAll('[data-picker-gallery-id]').forEach(button => button.addEventListener('click', async () => {
    if (imagePickerActionBusy) return;
    imagePickerActionBusy = true;
    const actionToken = imagePickerActionToken;
    const pickerButtons = [
      ...els.imagePickerGallery.querySelectorAll('[data-picker-gallery-id]'),
      els.refreshImagePickerGallery,
      els.uploadWorkflowImageButton
    ].filter(Boolean);
    pickerButtons.forEach(item => { item.disabled = true; });
    if (els.imagePickerStatus) {
      els.imagePickerStatus.classList.remove('hidden');
      els.imagePickerStatus.textContent = '正在确认图片并保存为本地输入资产…';
    }
    try {
      const asset = await cloneGalleryToWorkflowAsset(button.dataset.pickerGalleryId);
      if (!applyWorkflowAsset(asset, actionToken)) throw new Error('图片选择已取消，请重新选择。');
      if (els.imagePickerStatus) els.imagePickerStatus.textContent = '图片已确认。';
      toast('图片已确认并保存为本地输入资产。', 'success');
    } catch (error) {
      toast(error.message, 'error');
      if (els.imagePickerStatus) els.imagePickerStatus.textContent = `确认失败：${error.message}`;
    } finally {
      imagePickerActionBusy = false;
      pickerButtons.forEach(item => { item.disabled = false; });
    }
  }));
}

function pickerUiIsCurrent(token) {
  return token === imagePickerActionToken && Boolean(els.imagePickerDialog?.open);
}

function startImagePickerElapsedTimer(token, startedAt) {
  if (imagePickerStatusTimer) clearInterval(imagePickerStatusTimer);
  imagePickerStatusToken = token;
  imagePickerStatusTimer = setInterval(() => {
    if (!pickerUiIsCurrent(token)) {
      if (imagePickerStatusToken === token) {
        clearInterval(imagePickerStatusTimer);
        imagePickerStatusTimer = 0;
        imagePickerStatusToken = 0;
      }
      return;
    }
    const seconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    els.imagePickerStatus.textContent = `正在读取最近图库… 已用 ${seconds} 秒；请不要重复点击。`;
  }, 700);
}

async function loadImagePickerGallery({ force = false, pickerToken = imagePickerActionToken } = {}) {
  if (!els.imagePickerGallery) return;
  const now = Date.now();
  if (!force && imagePickerGalleryCache && now - imagePickerGalleryCache.fetchedAt < IMAGE_PICKER_CACHE_TTL_MS) {
    if (imagePickerStatusToken === pickerToken && imagePickerStatusTimer) {
      clearInterval(imagePickerStatusTimer); imagePickerStatusTimer = 0; imagePickerStatusToken = 0;
    }
    if (pickerUiIsCurrent(pickerToken)) {
      renderImagePickerGallery(imagePickerGalleryCache.images);
      if (els.imagePickerStatus) els.imagePickerStatus.textContent = `已载入最近 ${imagePickerGalleryCache.images.length} 张图库图片。`;
    }
    return imagePickerGalleryCache.images;
  }
  if (imagePickerGalleryPromise) {
    // A second opener reuses the in-flight request, but gets its own token so
    // a later upload/close cannot let the old request overwrite this picker.
    if (pickerUiIsCurrent(pickerToken) && els.imagePickerStatus) {
      const startedAt = imagePickerGalleryStartedAt || Date.now();
      els.imagePickerStatus.classList.remove('hidden');
      els.imagePickerStatus.textContent = '正在读取最近图库；首次打开可能需要几秒…';
      startImagePickerElapsedTimer(pickerToken, startedAt);
    }
    // The original request owner cleans up its own timer in the `finally`
    // below, but a later opener has a different token and therefore needs its
    // own completion hook.  Without this, the second opener's elapsed timer
    // would keep overwriting the successful "已载入" status forever.
    return imagePickerGalleryPromise.finally(() => {
      if (imagePickerStatusToken === pickerToken && imagePickerStatusTimer) {
        clearInterval(imagePickerStatusTimer);
        imagePickerStatusTimer = 0;
        imagePickerStatusToken = 0;
      }
    });
  }
  const requestToken = pickerToken;
  if (pickerUiIsCurrent(requestToken)) {
    els.imagePickerGallery.classList.add('empty-state');
    els.imagePickerGallery.textContent = '正在读取图库…';
  }
  const startedAt = Date.now();
  imagePickerGalleryStartedAt = startedAt;
  if (pickerUiIsCurrent(requestToken) && els.imagePickerStatus) {
    els.imagePickerStatus.classList.remove('hidden');
    els.imagePickerStatus.textContent = '正在读取最近图库；首次打开可能需要几秒…';
    startImagePickerElapsedTimer(requestToken, startedAt);
  }
  const request = (async () => {
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeout = setTimeout(() => controller?.abort(), IMAGE_PICKER_FETCH_TIMEOUT_MS);
      let data;
      try {
        data = await api('/api/images?picker=1&page=1&limit=24', controller ? { signal: controller.signal } : {});
      } catch (error) {
        if (controller?.signal.aborted) throw new Error('读取图库超时（30 秒）；请检查网络或稍后重试。');
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      const images = Array.isArray(data.images) ? data.images : [];
      imagePickerGalleryCache = { images, fetchedAt: Date.now() };
      if (pickerUiIsCurrent(requestToken)) {
        renderImagePickerGallery(images);
        if (els.imagePickerStatus) els.imagePickerStatus.textContent = `已载入最近 ${images.length} 张图库图片。`;
      }
      return images;
    } catch (error) {
      // Keep the status truthful only for the picker that started this
      // request.  A completed upload or a newly opened picker owns the UI now.
      if (pickerUiIsCurrent(requestToken)) {
        if (els.imagePickerGallery) {
          els.imagePickerGallery.classList.add('empty-state');
          els.imagePickerGallery.textContent = `读取图库失败：${error?.message || error}`;
        }
        if (els.imagePickerStatus) {
          els.imagePickerStatus.classList.remove('hidden');
          els.imagePickerStatus.textContent = `读取图库失败：${error?.message || error}`;
        }
      }
      throw error;
    }
  })();
  imagePickerGalleryPromise = request;
  try {
    return await request;
  } finally {
    if (imagePickerStatusToken === requestToken && imagePickerStatusTimer) {
      clearInterval(imagePickerStatusTimer); imagePickerStatusTimer = 0; imagePickerStatusToken = 0;
    }
    if (imagePickerGalleryStartedAt === startedAt) imagePickerGalleryStartedAt = 0;
    if (imagePickerGalleryPromise === request) imagePickerGalleryPromise = null;
  }
}

function openImagePicker(target) {
  imagePickerActionToken += 1;
  const pickerToken = imagePickerActionToken;
  imagePickerTarget = target;
  imagePickerActionBusy = false;
  if (!imagePickerGalleryPromise && imagePickerStatusTimer) { clearInterval(imagePickerStatusTimer); imagePickerStatusTimer = 0; imagePickerStatusToken = 0; }
  const labels = { base: '选择输入图片', precise: '选择 Precise Reference', vibe: '选择 Vibe 图片' };
  if (els.imagePickerTitle) els.imagePickerTitle.textContent = labels[target?.kind] || '选择图片';
  if (els.imagePickerStatus) {
    els.imagePickerStatus.classList.remove('hidden');
    els.imagePickerStatus.textContent = '正在准备最近图库…';
  }
  els.imagePickerDialog?.showModal();
  loadImagePickerGallery({ pickerToken }).then(images => {
    // Cache/in-flight callers may not have been the request owner; make sure
    // the currently visible picker still receives the completed gallery.
    if (pickerUiIsCurrent(pickerToken) && imagePickerGalleryCache?.images === images) {
      renderImagePickerGallery(images);
      if (els.imagePickerStatus) els.imagePickerStatus.textContent = `已载入最近 ${images.length} 张图库图片。`;
    }
  }).catch(error => {
    if (!pickerUiIsCurrent(pickerToken)) return;
    if (els.imagePickerGallery) els.imagePickerGallery.textContent = `读取图库失败：${error.message}`;
    if (els.imagePickerStatus) {
      els.imagePickerStatus.classList.remove('hidden');
      els.imagePickerStatus.textContent = `读取图库失败：${error.message}`;
    }
  });
}

function resetMaskCanvas() {
  if (els.inpaintMaskCanvas) {
    const ctx = els.inpaintMaskCanvas.getContext('2d');
    ctx?.clearRect(0, 0, els.inpaintMaskCanvas.width, els.inpaintMaskCanvas.height);
  }
  maskDirty = false;
  maskHasPaint = false;
  maskHistory = [];
  maskHistoryIndex = -1;
  if (els.maskStatus) els.maskStatus.textContent = appState.imageWorkflow?.maskImage ? '已有保存的 Mask；继续绘制会以当前画布为准。' : '尚未绘制 Mask。';
}

function markMaskUnsaved(reason = 'Mask 已修改，生成时会自动保存。') {
  appState.imageWorkflow.maskImage = null;
  if (appState.imageWorkflow?.mode !== 'inpaint') return;
  const sourceReady = Boolean(appState.imageWorkflow?.baseImage);
  appState.imageRecovery = {
    ...(appState.imageRecovery || {}),
    status: 'missing', operation: 'inpaint', label: '局部重绘',
    sourceStatus: appState.imageRecovery?.sourceStatus || (sourceReady ? 'ready' : 'missing'),
    maskStatus: 'missing', reason: sourceReady ? reason : '还需要选择局部重绘原图并保存 Mask。'
  };
  if (appState.workflowMetadata) {
    appState.workflowMetadata = { ...appState.workflowMetadata, operation: 'inpaint', maskStatus: 'missing' };
  }
}

function pushMaskHistory() {
  const canvas = els.inpaintMaskCanvas;
  if (!canvas?.width || !canvas?.height) return;
  const snapshot = canvas.toDataURL('image/png');
  if (maskHistoryIndex < maskHistory.length - 1) maskHistory = maskHistory.slice(0, maskHistoryIndex + 1);
  maskHistory.push(snapshot);
  if (maskHistory.length > 10) maskHistory.shift();
  maskHistoryIndex = maskHistory.length - 1;
}

function restoreMaskSnapshot(index) {
  if (index < 0 || index >= maskHistory.length) return;
  const canvas = els.inpaintMaskCanvas;
  const image = new Image();
  image.onload = () => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    maskDirty = true;
    maskHasPaint = true;
    markMaskUnsaved();
    if (els.maskStatus) els.maskStatus.textContent = 'Mask 已修改，生成时会自动保存。';
  };
  image.src = maskHistory[index];
}

async function loadSavedMaskIntoCanvas(ref) {
  const url = workflowRefUrl(ref);
  const canvas = els.inpaintMaskCanvas;
  if (!url || !canvas?.width) return;
  const image = new Image();
  image.decoding = 'async';
  await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('保存的 Mask 读取失败。')); image.src = url; });
  const temp = document.createElement('canvas');
  temp.width = canvas.width; temp.height = canvas.height;
  const tctx = temp.getContext('2d', { willReadFrequently: true });
  tctx.drawImage(image, 0, 0, temp.width, temp.height);
  const pixels = tctx.getImageData(0, 0, temp.width, temp.height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const lum = (pixels.data[i] + pixels.data[i + 1] + pixels.data[i + 2]) / 3;
    pixels.data[i] = 255; pixels.data[i + 1] = 255; pixels.data[i + 2] = 255;
    pixels.data[i + 3] = lum > 80 ? 255 : 0;
  }
  canvas.getContext('2d').putImageData(pixels, 0, 0);
  maskDirty = false;
  maskHasPaint = maskCanvasHasSelection();
  maskHistory = [];
  maskHistoryIndex = -1;
  pushMaskHistory();
  if (els.maskStatus) els.maskStatus.textContent = maskHasPaint ? '已载入保存的 Mask，可继续修改。' : '保存的 Mask 为空。';
}

function syncInpaintBaseImage() {
  const ref = appState.imageWorkflow?.baseImage;
  const url = workflowRefUrl(ref);
  if (!els.inpaintBaseImage || !els.inpaintMaskCanvas) return;
  if (!url) {
    inpaintImageEpoch += 1;
    els.inpaintBaseImage.removeAttribute('src');
    return;
  }
  const maskId = String(appState.imageWorkflow?.maskImage?.id || '');
  if (els.inpaintBaseImage.dataset.assetId === ref.id && els.inpaintBaseImage.dataset.maskId === maskId && els.inpaintBaseImage.src) return;
  const epoch = ++inpaintImageEpoch;
  els.inpaintBaseImage.dataset.assetId = ref.id;
  els.inpaintBaseImage.dataset.maskId = maskId;
  els.inpaintBaseImage.onload = () => {
    if (epoch !== inpaintImageEpoch || appState.imageWorkflow?.mode !== 'inpaint') return;
    const canvas = els.inpaintMaskCanvas;
    canvas.width = els.inpaintBaseImage.naturalWidth || 1;
    canvas.height = els.inpaintBaseImage.naturalHeight || 1;
    resetMaskCanvas();
    if (appState.imageWorkflow?.maskImage) {
      loadSavedMaskIntoCanvas(appState.imageWorkflow.maskImage).catch(error => { if (els.maskStatus) els.maskStatus.textContent = error.message; });
    } else {
      pushMaskHistory();
    }
  };
  els.inpaintBaseImage.src = url;
}

function maskPoint(event) {
  const canvas = els.inpaintMaskCanvas;
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * canvas.width / Math.max(1, rect.width),
    y: (event.clientY - rect.top) * canvas.height / Math.max(1, rect.height)
  };
}

function drawMaskSegment(from, to) {
  const canvas = els.inpaintMaskCanvas;
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const visualScale = canvas.width / Math.max(1, rect.width);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Number(els.maskBrushSize?.value || 48) * visualScale;
  ctx.globalCompositeOperation = maskTool === 'eraser' ? 'destination-out' : 'source-over';
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
  maskDirty = true;
  if (maskTool !== 'eraser') maskHasPaint = true;
  markMaskUnsaved();
  if (els.maskStatus) els.maskStatus.textContent = 'Mask 已修改，生成时会自动保存。';
}

function invertMask() {
  const canvas = els.inpaintMaskCanvas;
  if (!canvas?.width) return;
  const ctx = canvas.getContext('2d');
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < image.data.length; i += 4) {
    const selected = image.data[i + 3] > 16;
    image.data[i] = 255; image.data[i + 1] = 255; image.data[i + 2] = 255; image.data[i + 3] = selected ? 0 : 255;
  }
  ctx.putImageData(image, 0, 0);
  maskDirty = true;
  maskHasPaint = true;
  markMaskUnsaved();
  pushMaskHistory();
  if (els.maskStatus) els.maskStatus.textContent = 'Mask 已反选。';
}

function maskCanvasHasSelection() {
  const canvas = els.inpaintMaskCanvas;
  if (!canvas?.width || !canvas?.height) return false;
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 16) return true;
  return false;
}

async function uploadCurrentMask() {
  const canvas = els.inpaintMaskCanvas;
  if (!canvas?.width || !canvas?.height || !maskCanvasHasSelection()) throw new Error('先在原图上画出需要局部重绘的区域。');
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = canvas.width;
  exportCanvas.height = canvas.height;
  const ctx = exportCanvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
  ctx.drawImage(canvas, 0, 0);
  const blob = await new Promise((resolve, reject) => exportCanvas.toBlob(value => value ? resolve(value) : reject(new Error('Mask 编码失败。')), 'image/png'));
  const asset = await api('/api/assets', {
    method: 'POST', headers: { 'Content-Type': 'image/png', 'x-file-name': encodeURIComponent('inpaint-mask.png') }, body: blob
  });
  workflowAssetMeta.set(asset.id, asset);
  appState.imageWorkflow.maskImage = structuredClone(asset.ref);
  // Keep the recovery badge in sync with the actual canonical state.  An
  // imported Inpaint record may start as `missing`; once both source and Mask
  // exist it must no longer serialize that stale warning into a queue job or
  // gallery snapshot.
  const recoveryOperation = String(appState.imageRecovery?.operation || appState.workflowMetadata?.operation || '')
    .trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (recoveryOperation === 'inpaint' || appState.imageWorkflow?.mode === 'inpaint') {
    const sourceReady = Boolean(appState.imageWorkflow?.baseImage);
    appState.imageRecovery = {
      ...(appState.imageRecovery || {}),
      status: sourceReady ? 'ready' : 'missing',
      operation: 'inpaint',
      label: '局部重绘',
      maskStatus: 'ready',
      reason: sourceReady ? '' : 'Mask 已保存；还需要重新选择局部重绘原图。'
    };
    if (appState.workflowMetadata) {
      appState.workflowMetadata = {
        ...appState.workflowMetadata,
        operation: 'inpaint',
        maskStatus: 'ready'
      };
    }
  }
  maskDirty = false;
  if (els.maskStatus) els.maskStatus.textContent = 'Mask 已保存，可加入队列。';
  renderImageWorkflow();
  return asset.ref;
}

async function prepareGenerationState(rawState, useLiveMask = true) {
  const state = structuredClone(rawState);
  if (useLiveMask && state.imageWorkflow?.mode === 'inpaint' && maskDirty && state.imageWorkflow?.baseImage?.id === appState.imageWorkflow?.baseImage?.id) {
    const ref = await uploadCurrentMask();
    state.imageWorkflow.maskImage = structuredClone(ref);
  }
  return state;
}

function currentGenerationRoute() {
  return {
    provider: normalizeProviderId(els.generationProvider?.value),
    officialAccountId: String(els.officialAccountSelect?.value || appState.officialAccountId || '')
  };
}

function withCurrentGenerationRoute(rawState) {
  const state = structuredClone(rawState || {});
  const route = currentGenerationRoute();
  state.provider = route.provider;
  state.officialAccountId = route.officialAccountId;
  return state;
}

function withoutGenerationRoute(rawState) {
  const state = structuredClone(rawState || {});
  delete state.provider;
  delete state.officialAccountId;
  return state;
}

async function createFromCurrentGalleryImage(mode) {
  // Capture the selected gallery record before the asynchronous copy.  The
  // dialog can be navigated while `/from-gallery` is in flight; reading the
  // mutable `currentImage` after the await could otherwise copy one image but
  // restore another image's prompt/parameters.
  const sourceImage = currentImage ? structuredClone(currentImage) : null;
  if (!sourceImage?.id) throw new Error('当前没有图库图片。');
  const asset = await cloneGalleryToWorkflowAsset(sourceImage.id);
  if (mode === 'enhance' && sourceImage.params) {
    const restored = withCurrentGenerationRoute(sourceImage.params);
    restored.seedMode = 'random';
    hydrateState(restored);
  }
  if (mode === 'img2img' || mode === 'inpaint' || mode === 'enhance') {
    const isEnhance = mode === 'enhance';
    appState.imageRecovery = null;
    appState.workflowMetadata = null;
    appState.imageTool = structuredClone(createDefaultState().imageTool);
    if (isEnhance) {
      appState.imageWorkflow.mode = 'img2img';
      appState.imageWorkflow.enhance = true;
      appState.imageWorkflow.enhanceUpscaleFactor = DEFAULT_ENHANCE_UPSCALE_FACTOR;
      // Choosing Enhance from the gallery is a new operation. Do not let a
      // previous PNG's target dimensions silently override the selected 1.5×.
      appState.imageWorkflow.enhanceTargetWidth = null;
      appState.imageWorkflow.enhanceTargetHeight = null;
    } else {
      appState.imageWorkflow.enhance = false;
    }
    appState.imageWorkflow.mode = mode;
    if (isEnhance) appState.imageWorkflow.mode = 'img2img';
    appState.imageWorkflow.enhanceTargetWidth = null;
    appState.imageWorkflow.enhanceTargetHeight = null;
    appState.imageWorkflow.baseImage = structuredClone(asset.ref);
    appState.imageWorkflow.maskImage = null;
    resetMaskCanvas();
    setWorkflowDimensionsFromAsset(asset);
  } else if (mode === 'upscale' || ['lineart', 'sketch', 'bg-removal', 'declutter', 'colorize', 'emotion'].includes(mode)) {
    appState.imageRecovery = null;
    appState.workflowMetadata = null;
    appState.imageWorkflow.mode = 'text';
    appState.imageWorkflow.enhance = false;
    appState.imageWorkflow.enhanceTargetWidth = null;
    appState.imageWorkflow.enhanceTargetHeight = null;
    appState.imageWorkflow.baseImage = structuredClone(asset.ref);
    appState.imageWorkflow.maskImage = null;
    appState.imageTool = mode === 'upscale'
      ? { type: 'upscale', scale: 4, reqType: '', prompt: '', defry: 0 }
      : { type: 'director', scale: 4, reqType: mode, prompt: '', defry: 0 };
    resetMaskCanvas();
    setWorkflowDimensionsFromAsset(asset);
  } else if (mode === 'precise') {
    if (!supportsPreciseReference()) {
      $('#model').value = DEFAULT_NAI_MODEL;
      appState.model = DEFAULT_NAI_MODEL;
      syncSamplingOptions(appState.model, { sampler: $('#sampler').value, noiseSchedule: $('#noiseSchedule').value });
    }
    appState.referenceControl.mode = 'precise';
    appState.referenceControl.precise.push({ image: structuredClone(asset.ref), type: 'character', strength: .6, fidelity: .5 });
  } else if (mode === 'vibe') {
    if (!supportsVibeTransfer()) {
      $('#model').value = DEFAULT_NAI_MODEL;
      appState.model = DEFAULT_NAI_MODEL;
      syncSamplingOptions(appState.model, { sampler: $('#sampler').value, noiseSchedule: $('#noiseSchedule').value });
      toast('V5 首发暂不支持 Vibe Transfer，已切到 V4.5 Full。');
    }
    appState.referenceControl.mode = 'vibe';
    appState.referenceControl.vibes.push({ image: structuredClone(asset.ref), strength: .6, informationExtracted: 1 });
  }
  renderImageWorkflow();
  els.imageCreateDialog?.close();
  els.imageDialog?.close();
  switchTabTo('editor');
  const toolToast = mode === 'upscale'
    ? '已装入官方 Upscale（固定 4×）。'
    : ['lineart', 'sketch', 'bg-removal', 'declutter', 'colorize', 'emotion'].includes(mode)
      ? `已装入官方 Director Tools：${mode}。`
      : '';
  toast(mode === 'inpaint' ? '已装入局部重绘。' : mode === 'img2img' ? '已装入图生图。' : mode === 'enhance' ? '已装入官方 Enhance。' : toolToast || (mode === 'precise' ? '已作为 Precise Reference。' : '已作为 Vibe。'), 'success');
}


function serializeState() {
  let advancedOverrides = {};
  const advancedText = $('#advancedOverrides').value.trim();
  if (advancedText) {
    advancedOverrides = JSON.parse(advancedText);
    if (!advancedOverrides || typeof advancedOverrides !== 'object' || Array.isArray(advancedOverrides)) throw new Error('高级参数必须是 JSON 对象。');
  }

  let prompt = globalPromptText();
  let negativePrompt = els.negativePrompt.value.trim();
  let characters = appState.characters.map(character => ({
    id: character.id,
    name: character.name,
    enabled: character.enabled !== false,
    centers: structuredClone(character.centers || [{ x: 0.5, y: 0.5 }]),
    promptTags: character.promptTags.map(cloneTagForStorage),
    ucTags: character.ucTags.map(cloneTagForStorage)
  }));

  if (directPromptEdited) {
    const parsed = parseStructuredPrompt(els.promptPreview.value);
    prompt = parsed.globalPrompt.trim();
    if (parsed.globalUc.trim()) negativePrompt = parsed.globalUc.trim();
    characters = parsed.characters.slice(0, characterLimitForModel($('#model').value)).map(item => ({
      id: uid(),
      name: item.name,
      enabled: true,
      centers: [{ x: 0.5, y: 0.5 }],
      promptTags: tokenizePrompt(item.promptRaw).map(token => cloneTagForStorage(hydrateTag(parseTagToken(token)))),
      ucTags: tokenizePrompt(item.ucRaw).map(token => cloneTagForStorage(hydrateTag(parseTagToken(token))))
    }));
  }

  return {
    provider: normalizeProviderId(els.generationProvider?.value),
    officialAccountId: String(els.officialAccountSelect?.value || appState.officialAccountId || ''),
    groups: Object.fromEntries(GROUP_DEFS.map(([key]) => [key, (appState.groups[key] || []).map(cloneTagForStorage)])),
    characters,
    v4Options: structuredClone(appState.v4Options || { useCoords: false, useOrder: true, negativeUseOrder: false, legacyUc: false }),
    imageWorkflow: structuredClone(appState.imageWorkflow || createDefaultState().imageWorkflow),
    imageTool: structuredClone(appState.imageTool || createDefaultState().imageTool),
    imageRecovery: recoveryStateSummary(appState.imageRecovery),
    workflowMetadata: workflowMetadataSummary(appState.workflowMetadata),
    referenceControl: structuredClone(appState.referenceControl || createDefaultState().referenceControl),
    promptOrderMode: appState.promptOrderMode === 'original' ? 'original' : 'grouped',
    prompt,
    previewPrompt: els.promptPreview.value.trim() || combinedPromptText(),
    directMode: directPromptEdited,
    negativePrompt,
    model: $('#model').value,
    params: {
      width: Number($('#width').value), height: Number($('#height').value), steps: Number($('#steps').value), scale: Number($('#scale').value),
      sampler: $('#sampler').value, noiseSchedule: $('#noiseSchedule').value, ucPreset: Number($('#ucPreset').value), cfgRescale: Number($('#cfgRescale').value),
      qualityToggle: $('#qualityToggle').checked, preferBrownian: $('#preferBrownian').checked,
      sm: appState.params.sm === true, smDyn: appState.params.smDyn === true,
      deliberateEulerAncestralBug: appState.params.deliberateEulerAncestralBug === true,
      varietyBoost: $('#varietyBoost').checked ? (Number(appState.params.varietyBoost) > 0 ? Number(appState.params.varietyBoost) : 19) : 0,
      nativeAlpha: $('#nativeAlpha')?.checked === true,
    advancedOverrides: filterAdvancedOverrides(advancedOverrides),
      importedExtras: structuredClone(appState.params.importedExtras || {})
    },
    seedMode: $('#seedMode').value,
    seed: Number($('#seed').value || 0)
  };
}

const STORED_ASSET_ID_RE = /^[0-9a-f-]{16,80}$/i;
const STORED_DIRECTOR_TYPES = new Set(['lineart', 'sketch', 'bg-removal', 'declutter', 'colorize', 'emotion', 'unknown']);

function normalizeStoredAssetRef(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '');
  return value.source === 'asset' && STORED_ASSET_ID_RE.test(id) ? { source: 'asset', id } : null;
}

function storedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function storedOptionalDimension(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 64 && number <= 4096 ? Math.round(number) : fallback;
}

function normalizeStoredImageWorkflow(raw, defaults, model) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rawMode = ['text', 'img2img', 'inpaint'].includes(source.mode) ? source.mode : defaults.mode;
  const enhance = source.enhance === true && rawMode !== 'inpaint';
  const mode = enhance && rawMode === 'text' ? 'img2img' : rawMode;
  const factorText = String(source.enhanceUpscaleFactor || '').trim().toLowerCase();
  const factor = factorText === 'max' && isV5Model(model)
    ? 'max'
    : storedNumber(source.enhanceUpscaleFactor, defaults.enhanceUpscaleFactor === 'max' ? DEFAULT_ENHANCE_UPSCALE_FACTOR : defaults.enhanceUpscaleFactor, 1, 2);
  return {
    mode,
    baseImage: normalizeStoredAssetRef(source.baseImage),
    maskImage: normalizeStoredAssetRef(source.maskImage),
    strength: storedNumber(source.strength, defaults.strength, 0, 1),
    noise: storedNumber(source.noise, defaults.noise, 0, 1),
    colorCorrect: source.colorCorrect === true,
    enhance,
    enhanceUpscaleFactor: factor,
    enhanceTargetWidth: storedOptionalDimension(source.enhanceTargetWidth, defaults.enhanceTargetWidth || null),
    enhanceTargetHeight: storedOptionalDimension(source.enhanceTargetHeight, defaults.enhanceTargetHeight || null)
  };
}

function normalizeStoredImageTool(raw, defaults) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const type = String(source.type || defaults.type || 'none');
  if (type === 'upscale') return { type: 'upscale', scale: 4, reqType: '', prompt: '', defry: 0 };
  const rawReqType = String(source.reqType || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  const reqType = rawReqType === 'bgremoval' || rawReqType === 'remove-background' || rawReqType === 'background-removal'
    ? 'bg-removal' : rawReqType;
  if (type === 'director' && !reqType) {
    return {
      type: 'director', scale: 4, reqType: 'unknown',
      prompt: String(source.prompt || '').slice(0, 4000), defry: Math.min(5, Math.max(0, Math.round(Number(source.defry) || 0)))
    };
  }
  if (type !== 'director' || !STORED_DIRECTOR_TYPES.has(reqType)) {
    return { type: 'none', scale: 4, reqType: '', prompt: '', defry: 0 };
  }
  return {
    type: 'director',
    scale: 4,
    reqType,
    prompt: String(source.prompt || '').slice(0, 4000),
    defry: Math.min(5, Math.max(0, Math.round(Number(source.defry) || 0)))
  };
}

function materializeStoredWorkflowDescriptor(state) {
  if (!state || typeof state !== 'object') return state;
  const workflow = state.imageWorkflow || (state.imageWorkflow = createDefaultState().imageWorkflow);
  const tool = state.imageTool || (state.imageTool = createDefaultState().imageTool);
  const recovery = state.imageRecovery || {};
  const metadata = state.workflowMetadata || {};
  if (recovery.ambiguous === true || metadata.ambiguous === true) return state;
  const canonicalEmpty = workflow.mode === 'text' && workflow.enhance !== true && tool.type === 'none';
  if (!canonicalEmpty) return state;
  const mode = workflowModeForState(state);
  if (mode === 'img2img') {
    workflow.mode = 'img2img';
    workflow.enhance = false;
  } else if (mode === 'enhance') {
    workflow.mode = 'img2img';
    workflow.enhance = true;
    if (metadata.enhanceUpscaleFactor != null) workflow.enhanceUpscaleFactor = metadata.enhanceUpscaleFactor;
    if (metadata.enhanceTargetWidth != null) workflow.enhanceTargetWidth = metadata.enhanceTargetWidth;
    if (metadata.enhanceTargetHeight != null) workflow.enhanceTargetHeight = metadata.enhanceTargetHeight;
  } else if (mode === 'inpaint') {
    workflow.mode = 'inpaint';
    workflow.enhance = false;
  } else if (mode === 'upscale') {
    state.imageTool = { type: 'upscale', scale: 4, reqType: '', prompt: '', defry: 0 };
  } else if (mode === 'director') {
    const descriptor = String(metadata.requestType || metadata.operation || recovery.requestType || recovery.operation || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    const reqType = descriptor.includes('lineart') ? 'lineart'
      : descriptor.includes('sketch') ? 'sketch'
        : (descriptor.includes('bg-removal') || descriptor.includes('bgremoval') || descriptor.includes('remove-background') || descriptor.includes('background-removal')) ? 'bg-removal'
          : descriptor.includes('declutter') ? 'declutter'
            : (descriptor.includes('colorize') || descriptor.includes('colourize')) ? 'colorize'
              : descriptor.includes('emotion') ? 'emotion' : 'unknown';
    state.imageTool = { type: 'director', scale: 4, reqType, prompt: '', defry: 0 };
  }
  return state;
}

function normalizeStoredReferenceControl(raw, defaults) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const mode = ['none', 'precise', 'vibe'].includes(source.mode) ? source.mode : defaults.mode;
  const precise = Array.isArray(source.precise) ? source.precise.slice(0, 16).map(item => {
    const image = normalizeStoredAssetRef(item?.image);
    return image ? {
      image,
      type: ['character', 'style'].includes(item?.type) ? item.type : 'character',
      strength: storedNumber(item?.strength, 0.6, 0, 1),
      fidelity: storedNumber(item?.fidelity, 0.5, 0, 1)
    } : null;
  }).filter(Boolean) : [];
  const vibes = Array.isArray(source.vibes) ? source.vibes.slice(0, 16).map(item => {
    const image = normalizeStoredAssetRef(item?.image);
    return image ? {
      image,
      strength: storedNumber(item?.strength, 0.6, 0, 1),
      informationExtracted: storedNumber(item?.informationExtracted, 1, 0, 1)
    } : null;
  }).filter(Boolean) : [];
  return { mode, precise, vibes };
}

function normalizeStoredState(raw) {
  const defaults = createDefaultState();
  // Gallery/scheme rows from older releases can contain importer-only fields
  // such as rawParameters, apiPayload, or embedded Base64 media.  They are
  // useful while inspecting an import, but are not generation state and must
  // not be copied into the live state (or back into a later queue/scheme
  // save).  Keep forward-compatible state fields while dropping these known
  // transient envelopes before the shallow merge below.
  const rawObject = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const transientKeys = new Set([
    'embeddedinputimage', 'embeddedmaskimage', 'rawobject', 'rawtext',
    'rawparameters', 'metadata', 'apipayload', 'payload', 'parameters', 'comment'
  ]);
  const compactStoredKey = key => String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const storedFields = Object.fromEntries(
    Object.entries(rawObject).filter(([key]) => !transientKeys.has(compactStoredKey(key)))
  );
  const storedParamKeys = new Set([
    'width', 'height', 'steps', 'scale', 'sampler', 'noiseSchedule', 'ucPreset', 'cfgRescale',
    'qualityToggle', 'preferBrownian', 'sm', 'smDyn', 'deliberateEulerAncestralBug',
    'varietyBoost', 'nativeAlpha', 'imageFormat'
  ]);
  const rawParams = rawObject.params && typeof rawObject.params === 'object' && !Array.isArray(rawObject.params)
    ? rawObject.params
    : {};
  const storedParams = Object.fromEntries(
    Object.entries(rawParams).filter(([key]) => storedParamKeys.has(key))
  );
  const restoreModel = String(rawObject.model || '').trim() || $('#model')?.value || defaults.model;
  const oldGroups = rawObject.groups || {};
  const legacyMap = {
    scene: ['scene', 'lighting'],
    camera: ['camera', 'composition'],
    style: ['style', 'artist', 'quality'],
    misc: ['misc', 'subject', 'appearance', 'clothing', 'pose']
  };
  const groups = {};
  for (const [key] of GROUP_DEFS) {
    const incoming = legacyMap[key].flatMap(sourceKey => Array.isArray(oldGroups[sourceKey]) ? oldGroups[sourceKey] : []);
    groups[key] = incoming.slice(0, 1000).map(hydrateTag).filter(item => item.text);
    for (const item of groups[key]) if (item.translation) translationCache.set(item.text.toLowerCase(), item.translation);
  }
  const characters = Array.isArray(rawObject.characters)
    ? rawObject.characters.slice(0, characterLimitForModel(restoreModel)).map(createCharacter).filter(ch => ch.name || ch.promptTags.length || ch.ucTags.length)
    : [];
  const hasExplicitPromptOrderMode = rawObject.promptOrderMode === 'original' || rawObject.promptOrderMode === 'grouped';
  let promptOrderMode = rawObject.promptOrderMode === 'original' ? 'original' : 'grouped';
  // v0.8.7 and earlier did not store order metadata. If a compiled Global Prompt exists,
  // recover the actual order that was saved/generated instead of silently applying today's category order.
  if (!hasExplicitPromptOrderMode && String(rawObject.prompt || '').trim() && groupedGlobalTags(groups).length) {
    seedOriginalOrderFromPrompt(groups, rawObject.prompt);
    promptOrderMode = 'original';
  }
  if (promptOrderMode === 'original') {
    let maxOrder = -1;
    for (const tag of globalPromptOrder().flatMap(key => groups[key] || [])) {
      const value = finiteOriginalOrder(tag.originalOrder);
      if (value !== null) maxOrder = Math.max(maxOrder, value);
    }
    let next = maxOrder + 1;
    for (const tag of globalPromptOrder().flatMap(key => groups[key] || [])) {
      if (finiteOriginalOrder(tag.originalOrder) === null) tag.originalOrder = next++;
    }
  }
  const normalized = {
    ...defaults,
    ...storedFields,
    model: restoreModel,
    provider: normalizeProviderId(rawObject.provider),
    officialAccountId: /^[0-9a-f-]{16,80}$/i.test(String(rawObject.officialAccountId || '')) || rawObject.officialAccountId === 'env'
      ? String(rawObject.officialAccountId)
      : '',
    groups,
    characters,
    promptOrderMode,
    v4Options: { ...defaults.v4Options, ...(rawObject.v4Options || {}) },
    imageWorkflow: normalizeStoredImageWorkflow(rawObject.imageWorkflow, defaults.imageWorkflow, restoreModel),
    imageTool: normalizeStoredImageTool(rawObject.imageTool, defaults.imageTool),
    referenceControl: normalizeStoredReferenceControl(rawObject.referenceControl, defaults.referenceControl),
    imageRecovery: recoveryStateSummary(rawObject.imageRecovery),
    workflowMetadata: rawObject.workflowMetadata && typeof rawObject.workflowMetadata === 'object'
      ? {
          operation: String(rawObject.workflowMetadata.operation || '').slice(0, 40),
          requestType: String(rawObject.workflowMetadata.requestType || '').slice(0, 120),
          sourceStatus: String(rawObject.workflowMetadata.sourceStatus || '').slice(0, 20),
          maskStatus: String(rawObject.workflowMetadata.maskStatus || '').slice(0, 20),
          ambiguous: rawObject.workflowMetadata.ambiguous === true,
          ambiguityReason: rawObject.workflowMetadata.ambiguityReason ? String(rawObject.workflowMetadata.ambiguityReason).slice(0, 1000) : '',
          enhanceTargetWidth: storedOptionalDimension(rawObject.workflowMetadata.enhanceTargetWidth),
          enhanceTargetHeight: storedOptionalDimension(rawObject.workflowMetadata.enhanceTargetHeight),
          enhanceUpscaleFactor: rawObject.workflowMetadata.enhanceUpscaleFactor === 'max'
            ? 'max'
            : storedNumber(rawObject.workflowMetadata.enhanceUpscaleFactor, DEFAULT_ENHANCE_UPSCALE_FACTOR, 1, 2)
        }
      : null,
    params: {
      ...defaults.params,
      ...storedParams,
      advancedOverrides: filterAdvancedOverrides(rawParams.advancedOverrides || {}),
      importedExtras: rawParams.importedExtras && typeof rawParams.importedExtras === 'object' && !Array.isArray(rawParams.importedExtras)
        ? structuredClone(rawParams.importedExtras)
        : {}
    }
  };
  return materializeStoredWorkflowDescriptor(normalized);
}

function hydrateState(raw) {
  appState = normalizeStoredState(raw);
  openTagGroups.clear();
  openTagGroups.add('scene');
  for (const [key] of GROUP_DEFS) if (appState.groups[key]?.length) openTagGroups.add(key);
  els.negativePrompt.value = appState.negativePrompt || '';
  renderCharacters();
  renderTagGroups();
  ucChipState.source = null;
  resetTagHistory();
  // A scheme / import / restore carries the translations as they were when it
  // was saved; the server cache is the source of truth, so refresh from it.
  scheduleTranslationSync();
  applyEditMode();
  // The form fields are filled further down; summarize once they are.
  requestAnimationFrame(updatePromptMeter);
  els.promptPreview.value = appState.previewPrompt || combinedPromptText();
  directPromptEdited = appState.directMode === true;
  updatePromptModeHint();
  autoGrowTextarea(els.promptPreview);
  $('#model').value = appState.model;
  appState.provider = normalizeProviderId(appState.provider);
  syncProviderUi();
  const sampling = syncSamplingOptions(appState.model, { sampler: appState.params.sampler, noiseSchedule: appState.params.noiseSchedule });
  appState.params.sampler = sampling.sampler;
  appState.params.noiseSchedule = sampling.noiseSchedule;
  $('#width').value = appState.params.width;
  $('#height').value = appState.params.height;
  $('#steps').value = appState.params.steps;
  $('#scale').value = appState.params.scale;
  $('#ucPreset').value = appState.params.ucPreset;
  $('#cfgRescale').value = appState.params.cfgRescale;
  $('#qualityToggle').checked = appState.params.qualityToggle !== false;
  $('#preferBrownian').checked = appState.params.preferBrownian !== false;
  $('#varietyBoost').checked = Number(appState.params.varietyBoost || appState.params.advancedOverrides?.skip_cfg_above_sigma || 0) > 0;
  if ($('#nativeAlpha')) $('#nativeAlpha').checked = appState.params.nativeAlpha === true;
  if ($('#nativeAlpha')) $('#nativeAlpha').disabled = !isV5Model(appState.model);
  $('#seedMode').value = appState.seedMode || 'random';
  $('#seed').value = appState.seed || 0;
  $('#advancedOverrides').value = Object.keys(appState.params.advancedOverrides || {}).length ? JSON.stringify(appState.params.advancedOverrides, null, 2) : '';
  renderAdvancedOverrideSummary();
  if (els.characterUseCoords) els.characterUseCoords.checked = appState.v4Options?.useCoords === true;
  updatePromptOrderUi();
  maskDirty = false;
  maskHasPaint = false;
  maskHistory = [];
  maskHistoryIndex = -1;
  renderImageWorkflow();
  syncSizePreset();
  syncV5PromptBudget(els.promptPreview.value);
}

function syncSizePreset() {
  const value = `${$('#width').value}x${$('#height').value}`;
  const option = [...$('#sizePreset').options].some(item => item.value === value);
  $('#sizePreset').value = option ? value : 'custom';
}

function schemeModelLabel(model) {
  const label = modelDisplayName(model);
  return label === '未识别' ? (model || '未知模型') : label;
}

function schemeSummary(scheme) {
  const data = scheme?.data || {};
  const params = data.params || {};
  const size = params.width && params.height ? `${params.width}×${params.height}` : '尺寸未知';
  const steps = Number.isFinite(Number(params.steps)) ? `${params.steps} Steps` : '';
  const seed = data.seedMode === 'fixed' ? `Seed ${data.seed ?? 0}` : ({ increment: 'Seed +1', random: '随机 Seed' })[data.seedMode] || '随机 Seed';
  return [schemeModelLabel(data.model), size, steps, seed].filter(Boolean).join(' · ');
}

function schemeTagTextList(tags = [], limit = 28) {
  const values = tags
    .filter(tag => tag?.enabled !== false && String(tag?.text || '').trim())
    .map(tag => {
      const weight = Number(tag.weight ?? 1);
      const text = String(tag.text || '').trim();
      return { text, display: Math.abs(weight - 1) > 0.001 ? `${text} ×${weight}` : text };
    });
  if (!values.length) return '<span class="scheme-empty-value">无</span>';
  const shown = values.slice(0, limit).map(item => {
    const jump = artistJumpLinkHtml(item.text, 'scheme-artist-jump');
    return `<span class="scheme-detail-chip ${jump ? 'artist-chip' : ''}"><span>${escapeHtml(item.display)}</span>${jump}</span>`;
  }).join('');
  const rest = values.length > limit ? `<span class="scheme-detail-chip muted">+${values.length - limit}</span>` : '';
  return `<div class="scheme-detail-chips">${shown}${rest}</div>`;
}

function schemeParamRows(scheme) {
  const data = normalizeStoredState(scheme?.data || {});
  const params = data.params || {};
  const samplerLabel = samplingProfileForModel(data.model).samplers.find(([value]) => value === params.sampler)?.[1] || params.sampler || '—';
  const scheduleLabel = samplingProfileForModel(data.model).schedules.find(([value]) => value === params.noiseSchedule)?.[1] || params.noiseSchedule || '—';
  return [
    ['模型', schemeModelLabel(data.model)],
    ['尺寸', `${params.width} × ${params.height}`],
    ['Steps', params.steps],
    ['CFG', params.scale],
    ['CFG Rescale', params.cfgRescale],
    ['Sampler', samplerLabel],
    ['Noise', scheduleLabel],
    ['Seed', data.seedMode === 'fixed' ? `${data.seed}（固定）` : data.seedMode === 'increment' ? `${data.seed}（递增）` : '随机']
  ];
}

function renderSchemeDetail(scheme) {
  if (!scheme || !els.schemeDialog) return;
  currentSchemeDetail = scheme;
  const data = normalizeStoredState(scheme.data || {});
  els.schemeDialogTitle.textContent = scheme.name;
  els.schemeDialogSubtitle.textContent = `${schemeSummary(scheme)} · ${formatDate(scheme.updatedAt)}`;
  els.schemeDialogCover.innerHTML = scheme.coverThumbUrl
    ? `<img src="${scheme.coverThumbUrl}" alt="${escapeHtml(scheme.name)} 封面">`
    : '<span class="scheme-cover-placeholder">◇</span>';
  els.schemeDialogMeta.innerHTML = schemeParamRows(scheme).map(([label, value]) => `
    <div class="scheme-detail-meta-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');

  const characterHtml = data.characters.length
    ? data.characters.map((character, index) => `
      <div class="scheme-character-block">
        <strong>角色 ${index + 1}</strong>
        <div><small>Prompt</small>${schemeTagTextList(character.promptTags, 20)}</div>
        <div><small>UC</small>${schemeTagTextList(character.ucTags, 14)}</div>
      </div>`).join('')
    : '<span class="scheme-empty-value">无独立角色卡</span>';

  const section = (title, body) => `<section class="scheme-detail-section"><h3>${title}</h3>${body}</section>`;
  els.schemeDialogSections.innerHTML = [
    section('人物角色', characterHtml),
    section('场景', schemeTagTextList(data.groups.scene)),
    section('镜头', schemeTagTextList(data.groups.camera)),
    section('画风', schemeTagTextList(data.groups.style)),
    section('其他', schemeTagTextList(data.groups.misc)),
    section('Global UC', data.negativePrompt ? `<div class="scheme-detail-text">${escapeHtml(data.negativePrompt)}</div>` : '<span class="scheme-empty-value">无</span>')
  ].join('');
}

function openSchemeDetail(scheme) {
  renderSchemeDetail(scheme);
  els.schemeDialog?.showModal();
  renderSchemeRestoreOptions();
}

function renderSchemes() {
  if (!els.schemeGrid) return;
  els.schemeGrid.innerHTML = '';
  if (!schemes.length) {
    els.schemeGrid.textContent = '暂无方案';
    return;
  }
  for (const scheme of schemes) {
    const card = document.createElement('article');
    card.className = 'scheme-card';
    card.dataset.schemeId = scheme.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `查看方案 ${scheme.name}`);
    const cover = scheme.coverThumbUrl
      ? `<img src="${scheme.coverThumbUrl}" loading="lazy" alt="${escapeHtml(scheme.name)} 封面">`
      : '<span class="scheme-cover-placeholder" aria-hidden="true">◇</span>';
    card.innerHTML = `
      <div class="scheme-cover">
        ${cover}
        ${scheme.isDefault ? '<span class="scheme-default-badge">默认</span>' : ''}
      </div>
      <div class="scheme-card-body">
        <div class="scheme-card-title"><strong title="${escapeHtml(scheme.name)}">${escapeHtml(scheme.name)}</strong></div>
        <div class="scheme-card-meta">${escapeHtml(schemeSummary(scheme))}<br>${escapeHtml(formatDate(scheme.updatedAt))}</div>
        <div class="scheme-card-actions">
          <button class="primary" type="button" data-scheme-detail>详情</button>
          <button class="ghost" type="button" data-scheme-restore>恢复</button>
          <button class="ghost" type="button" data-scheme-default ${scheme.isDefault ? 'disabled' : ''}>${scheme.isDefault ? '已默认' : '默认'}</button>
          <button class="ghost danger" type="button" data-scheme-delete>删除</button>
          <button class="scheme-card-more" type="button" data-scheme-more aria-expanded="false" aria-label="更多方案操作" data-new-layout-only>⋯</button>
        </div>
      </div>`;
    card.querySelector('.scheme-cover img')?.addEventListener('error', event => {
      event.currentTarget.replaceWith(Object.assign(document.createElement('span'), { className: 'scheme-cover-placeholder', textContent: '◇' }));
    });
    const stop = handler => event => { event.stopPropagation(); handler(event); };
    card.querySelector('[data-scheme-detail]').addEventListener('click', stop(() => openSchemeDetail(scheme)));
    card.querySelector('[data-scheme-restore]').addEventListener('click', stop(() => restoreScheme(scheme)));
    card.querySelector('[data-scheme-default]').addEventListener('click', stop(() => setDefaultScheme(scheme).catch(error => toast(error.message, 'error'))));
    card.querySelector('[data-scheme-delete]').addEventListener('click', stop(() => deleteScheme(scheme).catch(error => toast(error.message, 'error'))));
    // New layout: 设为默认 / 删除 unfold in the row behind ⋯.
    card.querySelector('[data-scheme-more]').addEventListener('click', stop(event => {
      const open = !card.classList.contains('menu-open');
      els.schemeGrid.querySelectorAll('.scheme-card.menu-open').forEach(node => { node.classList.remove('menu-open'); node.querySelector('[data-scheme-more]')?.setAttribute('aria-expanded', 'false'); });
      card.classList.toggle('menu-open', open);
      event.currentTarget.setAttribute('aria-expanded', String(open));
    }));
    card.addEventListener('click', () => openSchemeDetail(scheme));
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openSchemeDetail(scheme);
      }
    });
    els.schemeGrid.append(card);
  }
}

// Editor draft: the working state is kept on this device and restored on the
// next open, so a refresh never loses Tags that were not saved as a scheme.
// It is the same snapshot a scheme saves (serializeState), minus the route.
const DRAFT_KEY = 'nai-pocket-editor-draft';
var draftTimer = 0;
var draftReady = false;
var draftRestored = false;

function readDraft() {
  try {
    const draft = JSON.parse(storageGet(DRAFT_KEY) || 'null');
    return draft?.v === 1 && draft.data && typeof draft.data === 'object' ? draft : null;
  } catch { return null; }
}

function saveDraftNow() {
  clearTimeout(draftTimer);
  if (!draftReady) return;
  try { storageSet(DRAFT_KEY, JSON.stringify({ v: 1, savedAt: Date.now(), data: withoutGenerationRoute(serializeState()) })); }
  catch {}
}

function scheduleDraftSave() {
  if (!draftReady) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 800);
}

function clearDraft() {
  clearTimeout(draftTimer);
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
}

// Runs once at startup, before the default scheme would be applied.
function restoreDraft() {
  const draft = readDraft();
  if (!draft) return false;
  try { hydrateState(withCurrentGenerationRoute(draft.data)); }
  catch { clearDraft(); return false; }
  draftRestored = true;
  const time = new Date(draft.savedAt);
  const stamp = Number.isNaN(time.getTime()) ? '' : `（${time.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）`;
  setTimeout(() => toast(`已恢复上次的编辑${stamp}。要用默认方案，可在 ⋯ 里选「载入默认方案」。`), 600);
  return true;
}

function bindDraftAutosave() {
  // Any edit in the editor or the parameter form; Tag edits also pass through
  // compilePromptToPreview, which schedules a save as well.
  for (const type of ['input', 'change']) document.addEventListener(type, event => {
    if (event.target.closest?.('#editorTab, .settings-column, #floatingGenerateBar, #optionStrip')) scheduleDraftSave();
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDraftNow(); });
  window.addEventListener('pagehide', saveDraftNow);
}

async function loadDefaultScheme() {
  const defaultScheme = (schemes.length ? schemes : await api('/api/schemes')).find(item => item.isDefault);
  if (!defaultScheme) return toast('还没有设为默认的方案。');
  hydrateState(withCurrentGenerationRoute(defaultScheme.data));
  saveDraftNow();
  toast(`已载入默认方案「${defaultScheme.name}」。`, 'success');
}

async function loadSchemes({ applyDefault = false } = {}) {
  schemes = await api('/api/schemes');
  renderSchemes();
  if (applyDefault && !schemesInitialized && !draftRestored) {
    const defaultScheme = schemes.find(item => item.isDefault);
    if (defaultScheme) hydrateState(withCurrentGenerationRoute(defaultScheme.data));
  }
  schemesInitialized = true;
}

function latestPreviewImageId() {
  return $('#quickLatest')?.dataset.imageId || null;
}

async function createScheme(name, data, coverImageId = null) {
  const cleanedName = String(name || '').trim();
  if (!cleanedName) throw new Error('先填写方案名称。');
  const result = await api('/api/schemes', { method: 'POST', body: { name: cleanedName, data, coverImageId, isDefault: false } });
  await loadSchemes();
  return result;
}

async function saveSchemeFromEditor(name = els.schemeLibraryName?.value) {
  const state = await prepareGenerationState(serializeState());
  await createScheme(name, withoutGenerationRoute(state), latestPreviewImageId());
  if (els.schemeLibraryName) els.schemeLibraryName.value = '';
  toast('已保存为独立母方案。', 'success');
}

async function saveCurrentImageAsScheme() {
  if (!currentImage) throw new Error('当前没有图片。');
  const image = currentImage.params ? currentImage : await fetchImageDetail(currentImage.id);
  if (!image?.params) throw new Error('这张图片没有可恢复的完整参数。');
  const suggested = String(image.note || '').trim().slice(0, 50);
  const name = await promptText('给这个方案命名', suggested, { confirmLabel: '保存', maxLength: 60 });
  if (name === null) return;
  const schemeState = withoutGenerationRoute(image.params);
  schemeState.seedMode = 'fixed';
  schemeState.seed = Number(image.seed || 0);
  await createScheme(name, schemeState, image.id);
  toast('已把这张图提升为独立方案。', 'success');
}

function schemeRestorePreview(mode, characterIndex = null) {
  const raw = currentSchemeDetail?.data;
  if (!raw) return null;
  return applyImageRestore(normalizeStoredState(serializeState()), normalizeStoredState(raw), raw, mode, characterIndex, restoreMerge);
}

function renderSchemeRestoreOptions() {
  const panel = $('#schemeRestorePanel');
  const raw = currentSchemeDetail?.data;
  if (!panel) return;
  const append = restoreMerge === 'append';
  panel.dataset.merge = restoreMerge;
  panel.querySelectorAll('[data-scheme-merge]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.schemeMerge === restoreMerge)));
  const allLabel = $('#schemeRestoreAllLabel');
  if (allLabel) allLabel.textContent = append ? '全部追加' : '完整恢复';
  const characters = Array.isArray(raw?.characters) ? raw.characters.slice(0, characterLimitForModel(raw?.model || appState.model)) : [];
  const host = $('#schemeRestoreCharacterActions');
  if (host) {
    host.innerHTML = characters.map((character, index) => {
      const first = (character.promptTags || []).find(tag => tag.enabled !== false && tag.text)?.text || '';
      const name = String(character.name || '').trim() || first;
      const detail = restoreDetailText('character', raw ? schemeRestorePreview('character', index) : null, raw);
      const empty = append && detail === '没有新内容';
      return `<button class="restore-tile${append && !empty ? ' has-new' : ''}" type="button" data-scheme-restore-character="${index}"${empty ? ' disabled' : ''}><strong>角色 ${index + 1}${name ? ` · ${escapeHtml(name.slice(0, 24))}` : ''}</strong><small>${escapeHtml(detail)}</small></button>`;
    }).join('');
  }
  panel.querySelectorAll('[data-scheme-restore-mode]').forEach(button => {
    const mode = button.dataset.schemeRestoreMode;
    let enabled = Boolean(raw);
    if (mode === 'characters') enabled = enabled && characters.length > 0;
    if (mode === 'uc') enabled = enabled && Object.prototype.hasOwnProperty.call(raw || {}, 'negativePrompt');
    if (mode === 'params' && append) enabled = false;
    const detail = enabled || (mode === 'params' && append) ? restoreDetailText(mode, enabled ? schemeRestorePreview(mode) : null, raw) : '';
    if (append && detail === '没有新内容') enabled = false;
    button.disabled = !enabled;
    button.classList.toggle('has-new', append && enabled && mode !== 'all');
    const small = button.querySelector('[data-restore-detail]');
    if (small) small.textContent = mode === 'all' ? detail.replace('这张图', '这个方案') : detail;
  });
}

function restoreSchemePartial(scheme, mode = 'all', characterIndex = null) {
  if (!scheme?.data) return;
  if (mode === 'all' && restoreMerge === 'replace') return restoreScheme(scheme);
  if (restoreMerge === 'append' && mode === 'params') return toast('生成参数只能替换。', 'error');
  const merged = normalizeStoredState(serializeState());
  const result = applyImageRestore(merged, normalizeStoredState(scheme.data), scheme.data, mode === 'character' ? null : mode, Number.isInteger(characterIndex) ? characterIndex : null, restoreMerge);
  if (restoreMerge === 'append' && !result.tags && !result.characters && !result.uc) return toast('没有可追加的新内容。');
  if (result.structured) { merged.directMode = false; merged.previewPrompt = ''; merged.prompt = ''; }
  hydrateState(merged);
  els.schemeDialog?.close();
  switchTabTo('editor');
  const labels = { characters: '角色', scene: '场景', camera: '镜头', style: '画风', misc: '其他', 'camera-style': '镜头 + 画风', params: '生成参数', uc: 'Global UC', character: `角色 ${(characterIndex ?? 0) + 1}` };
  if (restoreMerge === 'append') {
    const parts = [result.tags ? `${result.tags} 个 Tag` : '', result.characters ? `${result.characters} 个角色` : '', result.uc ? `${result.uc} 项 UC` : ''].filter(Boolean);
    return toast(`已从“${scheme.name}”追加 ${parts.join('、')}`, 'success');
  }
  toast(`已从“${scheme.name}”恢复：${labels[mode] || mode}`, 'success');
}

function restoreScheme(scheme) {
  if (!scheme?.data) return;
  hydrateState(withCurrentGenerationRoute(scheme.data));
  els.schemeDialog?.close();
  switchTabTo('editor');
  toast(`已完整恢复方案：${scheme.name}；当前通道与 Token 保持不变。`, 'success');
}

async function setDefaultScheme(scheme) {
  if (!scheme?.id) return;
  await api(`/api/schemes/${scheme.id}`, { method: 'PUT', body: { isDefault: true } });
  await loadSchemes();
  toast(`已设为默认：${scheme.name}`, 'success');
}

async function deleteScheme(scheme) {
  if (!scheme?.id) throw new Error('方案不存在。');
  if (!(await confirmAction(`删除方案“${scheme.name}”？图库图片不会被删除。`, { confirmLabel: '删除', danger: true }))) return;
  await api(`/api/schemes/${scheme.id}`, { method: 'DELETE' });
  if (currentSchemeDetail?.id === scheme.id) {
    currentSchemeDetail = null;
    els.schemeDialog?.close();
  }
  await loadSchemes();
  toast('方案已删除。');
}

async function loadSnippets() {
  snippets = await api('/api/snippets');
  renderSnippets();
}

function renderSnippets() {
  if (!els.snippetList) return;
  els.snippetList.innerHTML = '';
  if (!snippets.length) {
    els.snippetList.textContent = '暂无片段';
    return;
  }
  for (const item of snippets) {
    const card = document.createElement('div');
    card.className = 'snippet-card';
    card.innerHTML = `<span>${escapeHtml(item.name)}</span><small>${escapeHtml(GROUP_DEFS.find(([key]) => key === item.category)?.[1] || item.category)} · ${item.tags.length}</small><button class="ghost" data-apply>应用</button><button class="ghost danger" data-delete>×</button>`;
    card.querySelector('[data-apply]').addEventListener('click', () => {
      let added = 0;
      for (const tag of item.tags) if (addTag(item.category, tag.text || tag, tag.weight || 1, tag.enabled !== false, tag.translation || '')) added += 1;
      toast(`已应用 ${item.name}，新增 ${added} 个 Tag。`, 'success');
    });
    card.querySelector('[data-delete]').addEventListener('click', async () => {
      if (!(await confirmAction(`删除片段“${item.name}”？`, { confirmLabel: '删除', danger: true }))) return;
      await api(`/api/snippets/${item.id}`, { method: 'DELETE' });
      await loadSnippets();
    });
    els.snippetList.append(card);
  }
}

async function saveSnippet() {
  const category = els.snippetCategory.value;
  const name = els.snippetName.value.trim();
  const tags = appState.groups[category] || [];
  if (!name) throw new Error('填写片段名称。');
  if (!tags.length) throw new Error('该分组没有 Tag。');
  await api('/api/snippets', { method: 'POST', body: { name, category, tags } });
  els.snippetName.value = '';
  await loadSnippets();
  toast('Tag 片段已保存。', 'success');
}

function showWorkspaceDialog({ title, message, choices = [{ value: 'close', label: '知道了' }], url = '' }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'workspace-choice-dialog';
  const heading = document.createElement('h2');
  heading.id = `workspace-dialog-${uid()}`;
  heading.textContent = title;
  dialog.setAttribute('aria-labelledby', heading.id);
  const body = document.createElement('p');
  body.className = 'dialog-body';
  body.textContent = message;
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  choices.forEach((choice, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = index === 0 ? 'primary' : 'ghost';
    button.textContent = choice.label;
    button.addEventListener('click', () => dialog.close(choice.value));
    actions.append(button);
  });
  dialog.append(heading, body);
  if (url) {
    const link = document.createElement('a');
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '官方文档';
    dialog.append(link);
  }
  dialog.append(actions);
  document.body.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener('close', () => { const value = dialog.returnValue; dialog.remove(); resolve(value || 'cancel'); }, { once: true });
    dialog.showModal();
  });
}

function showParameterHelp(key) {
  const help = PARAMETER_HELP[key];
  if (help) showWorkspaceDialog({ title: help.title, message: help.text, url: help.url });
}

function syncEditedDimensions(changed = 'width') {
  const before = `${$('#width').value}×${$('#height').value}`;
  const size = fitGenerationDimensions($('#width').value, $('#height').value, { ratio: $('#aspectRatio')?.value, changed });
  $('#width').value = size.width;
  $('#height').value = size.height;
  syncSizePreset();
  if (before !== `${size.width}×${size.height}`) toast(`尺寸已适配为 ${size.width}×${size.height}`);
}

function selectedBatchCount() {
  return Number($('#batchCount')?.value === 'custom' ? $('#customCount').value : $('#batchCount')?.value || 1);
}

function syncBatchCount() {
  const custom = $('#batchCount')?.value === 'custom';
  const input = $('#customCount');
  if (input) input.hidden = !custom;
  if (els.floatingGenerateButton) els.floatingGenerateButton.textContent = selectedBatchCount() === 1 ? '抽一发' : `生成 ${selectedBatchCount()} 张`;
}

async function enqueue(count, stateOverride = null) {
  if (enqueueBusy) return;
  const max = Number($('#customCount').max || 12);
  if (!Number.isInteger(count) || count < 1 || count > max) throw new Error(`数量必须在 1–${max} 之间。`);
  enqueueBusy = true;
  $$('.generate-button').forEach(button => button.disabled = true);
  try {
    let state = stateOverride ? structuredClone(stateOverride) : serializeState();
    if (requiresSeedDecision(state, count)) {
      const decision = await showWorkspaceDialog({ title: '固定 Seed 连续生成', message: `当前参数和 Seed 相同，${count} 张可能重复并消耗额度。要让本批使用随机 Seed 吗？`, choices: [
        { value: 'random', label: '本批随机' }, { value: 'fixed', label: '保留固定' }, { value: 'cancel', label: '取消' }
      ] });
      if (decision === 'cancel') return;
      if (decision === 'random') state.seedMode = 'random';
    }
    state = await prepareGenerationState(state, !stateOverride);
    if (!isOfficialProvider(state.provider) && !providerConfigured(state.provider)) throw new Error(state.provider === 'rbq' ? '先在设置中保存 RBQ API Key。' : '这个中转还没有可用的 Key，请在设置里检查。');
    if (state.provider === 'official' && (!state.officialAccountId || providerCatalog?.official?.configured === false)) throw new Error('先在设置中添加并选择 NovelAI 官网 Token。');
    const hasCharacterPrompt = state.characters.some(character => character.enabled !== false && character.promptTags.some(tag => tag.enabled !== false && tag.text.trim()));
    if (state.imageTool?.type === 'none' && !state.prompt.trim() && !hasCharacterPrompt) throw new Error('至少填写全局 Prompt 或一个角色 Prompt。');
    const result = await api('/api/jobs/enqueue', { method: 'POST', body: { state, count } });
    toast(`已加入 ${result.count} 张，${globalThis.NAI_RUNTIME?.native ? '本机队列' : '服务器'}将依次生成。`, 'success');
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    await refreshJobs();
  } finally {
    enqueueBusy = false;
    $$('.generate-button').forEach(button => button.disabled = false);
  }
}

function currentStormArtists() {
  return globalPromptOrder().flatMap(key => appState.groups[key] || [])
    .filter(tag => tag.enabled !== false && isConfirmedArtistTag(tag.text))
    .map(tag => ({ id: tag.id, text: String(tag.text || '').trim(), weight: finiteTagWeight(tag.weight, 1) }));
}

function currentStormPlan() {
  if (directPromptEdited) throw new Error('Storm 需要结构化 Tag 卡片；请先用“导入 NAI / JSON → 解析到 Tag 编辑器”。');
  const count = Math.round(Number(els.stormCount?.value || 7));
  if (!Number.isInteger(count) || count < 2) throw new Error('Storm 至少生成 2 张。');
  if (count > serverMaxStormSize) throw new Error(`当前服务端安全阈值为 ${serverMaxStormSize} 张；可在 .env 调高 MAX_STORM_SIZE。`);
  return buildArtistStormPlan(currentStormArtists(), {
    count,
    delta: Number(els.stormDelta?.value || 0.3),
    mode: els.stormMode?.value,
    externalArtists: els.stormUseExternalArtists?.checked ? stormExternalArtistPool : []
  });
}

function renderStormPlan() {
  try {
    const plan = currentStormPlan();
    els.stormArtistSummary?.classList.remove('is-error');
    if (els.stormArtistSummary) els.stormArtistSummary.textContent = `${plan.artists.length} 位 · ${plan.count} 张${plan.count < plan.requestedCount ? `（合并 ${plan.requestedCount - plan.count} 个重复组合）` : ''} · ±${plan.delta.toFixed(2)} · #${plan.baselineIndex} 原始基准`;
    if (els.stormPlanPreview) {
      const visibleIndexes = plan.count <= 9
        ? plan.variants.map((_, index) => index)
        : [...new Set([0, 1, 2, 3, plan.baselineIndex ? plan.baselineIndex - 1 : -1, plan.count - 2, plan.count - 1].filter(index => index >= 0))].sort((a, b) => a - b);
      const rows = [];
      let previous = -1;
      for (const variantIndex of visibleIndexes) {
        if (previous >= 0 && variantIndex - previous > 1) rows.push(`<div class="storm-plan-row"><strong>…</strong><span>省略 ${variantIndex - previous - 1} 张预览；任务仍会完整生成</span></div>`);
        const variant = plan.variants[variantIndex];
        rows.push(`<div class="storm-plan-row${variant.isBaseline ? ' is-baseline' : ''}"><strong>#${variant.index}${variant.isBaseline ? ' 基准' : ''}</strong><span>${variant.weights.map(item => `${escapeHtml(item.text)} ${Number(item.weight)}`).join(' · ')}${variant.externalArtist ? ` · ＋ ${escapeHtml(variant.externalArtist.text)} 1` : ''}</span></div>`);
        previous = variantIndex;
      }
      els.stormPlanPreview.innerHTML = rows.join('');
    }
    return plan;
  } catch (error) {
    els.stormArtistSummary?.classList.add('is-error');
    if (els.stormArtistSummary) els.stormArtistSummary.textContent = error.message;
    if (els.stormPlanPreview) els.stormPlanPreview.innerHTML = '';
    return null;
  }
}

function stormRecommendationSeedTags() {
  const tags = [];
  for (const key of globalPromptOrder()) {
    for (const tag of appState.groups[key] || []) if (tag.enabled !== false && tag.text && !isConfirmedArtistTag(tag.text)) tags.push(normalizeNaiTagForDanbooru(tag.text));
  }
  for (const character of appState.characters || []) {
    if (character.enabled === false) continue;
    for (const tag of character.promptTags || []) if (tag.enabled !== false && tag.text && !isConfirmedArtistTag(tag.text)) tags.push(normalizeNaiTagForDanbooru(tag.text));
  }
  return uniqueSemanticTags(tags).slice(0, 200);
}

function sampleArtistCandidates(rawItems, count) {
  const items = rawItems.slice(0, 100);
  const selected = [];
  while (items.length && selected.length < count) {
    const index = Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296 * items.length);
    selected.push(items.splice(index, 1)[0]);
  }
  return selected;
}

function renderStormExternalArtists(message = '') {
  if (!els.stormExternalArtistList) return;
  if (message) {
    els.stormExternalArtistList.textContent = message;
    return;
  }
  els.stormExternalArtistList.innerHTML = stormExternalArtistPool.map(item => `<span class="storm-external-chip" title="作品 ${Number(item.postCount || 0).toLocaleString()} · 共现 ${Number(item.coocCount || 0).toLocaleString()}">${escapeHtml(item.text)}</span>`).join('');
}

async function loadStormExternalArtists() {
  const poolSize = Math.min(30, Math.max(2, Math.round(Number(els.stormExternalPoolSize?.value || 8))));
  const seedTags = stormRecommendationSeedTags();
  if (!seedTags.length) seedTags.push('1girl');
  if (els.refreshStormExternalArtistsButton) els.refreshStormExternalArtistsButton.disabled = true;
  renderStormExternalArtists('正在读取候选画师…');
  try {
    const data = await api('/api/danbooru/artists', { method: 'POST', body: { tags: seedTags, limit: 100, minCooc: 1, showNsfw: false } });
    const existing = new Set(currentStormArtists().map(item => normalizeNaiTagForDanbooru(item.text).toLocaleLowerCase('en-US')));
    const candidates = (data.results || []).filter(item => item.artist && !existing.has(normalizeNaiTagForDanbooru(item.artist).toLocaleLowerCase('en-US')));
    stormExternalArtistPool = sampleArtistCandidates(candidates, poolSize).map(item => ({ ...item, text: `artist:${normalizeDanbooruTagForNai(item.artist)}` }));
    if (!stormExternalArtistPool.length) throw new Error('没有找到可用的外来画师。');
    renderStormExternalArtists();
    renderStormPlan();
    return stormExternalArtistPool;
  } catch (error) {
    stormExternalArtistPool = [];
    renderStormExternalArtists(`抽取失败：${error.message}`);
    throw error;
  } finally {
    if (els.refreshStormExternalArtistsButton) els.refreshStormExternalArtistsButton.disabled = false;
  }
}

function chooseStormSeed(state) {
  const value = Number(state.seed);
  if (state.seedMode !== 'random' && Number.isInteger(value) && value >= 0 && value <= 4294967295) return value;
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

async function generateArtistStorm() {
  currentStormPlan();
  let baseState = await prepareGenerationState(serializeState());
  if (!isOfficialProvider(baseState.provider) && !providerConfigured(baseState.provider)) throw new Error(baseState.provider === 'rbq' ? '先在设置中保存 RBQ API Key。' : '这个中转还没有可用的 Key，请在设置里检查。');
  if (baseState.provider === 'official' && (!baseState.officialAccountId || providerCatalog?.official?.configured === false)) throw new Error('先添加并选择一个 NovelAI 官网 Token。');
  if (els.stormUseExternalArtists?.checked && !stormExternalArtistPool.length) {
    await loadStormExternalArtists();
    toast('候选画师已载入，请查看预览后再生成。');
    return;
  }
  const plan = currentStormPlan();
  if (plan.count < 2) throw new Error('只有一个不同组合，请扩大权重范围。');
  const seed = chooseStormSeed(baseState);
  baseState.seedMode = 'fixed';
  baseState.seed = seed;
  if (els.generateStormButton) els.generateStormButton.disabled = true;
  try {
    const result = await api('/api/jobs/enqueue-variants', {
      method: 'POST',
      body: {
        state: baseState, count: plan.requestedCount, delta: plan.delta, mode: plan.mode, seed,
        artistIds: plan.artists.map(item => item.id), externalArtists: plan.externalArtists.map(item => item.text)
      }
    });
    toast(`Storm 已加入 ${result.count} 张 · 固定 Seed ${result.seed}${result.externalArtists ? ` · 外来画师池 ${result.externalArtists} 位` : ''}；结果直接进入图库。`, 'success');
    await refreshJobs();
  } finally {
    if (els.generateStormButton) els.generateStormButton.disabled = false;
  }
}

function statusLabel(status) {
  return ({ pending: '等待', running: '生成中', completed: '完成', failed: '失败', cancelled: '已取消' })[status] || status;
}

function queuePhaseLabel(phase) {
  return ({
    queued: '队列', started: '开始', prepare: '准备', request: '请求', response: '响应',
    'response-error': '响应错误', received: '接收', saving: '保存', thumbnail: '缩略图',
    completed: '完成', 'retry-wait': '重试', 'manual-retry': '重试',
    'cancel-requested': '停止', cancelled: '停止', timeout: '超时', failed: '失败', recovered: '恢复', rerouted: '换渠道',
    'phone-gallery': '相册'
  })[phase] || phase || '状态';
}

function queueElapsedText(job) {
  if (job.status !== 'running' || !job.started_at) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - Number(job.started_at)) / 1000));
  return `已运行 ${seconds}s`;
}

function queueLogClock(value) {
  if (!value) return '';
  try { return new Date(Number(value)).toLocaleTimeString('zh-CN', { hour12: false }); }
  catch { return ''; }
}

function queueLogDetailHtml(detail) {
  if (detail == null) return '';
  let text = '';
  try { text = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2); }
  catch { text = String(detail); }
  if (!text.trim()) return '';
  return `<details class="queue-log-detail"><summary>原始详情</summary><pre>${escapeHtml(text)}</pre></details>`;
}

function queueLogPanelHtml(jobId) {
  const logs = jobLogCache.get(jobId);
  if (!logs) return '<div class="queue-log-loading">正在读取任务日志…</div>';
  if (!logs.length) return '<div class="queue-log-loading">暂无日志。</div>';
  return logs.map(log => `
    <div class="queue-log-row ${escapeHtml(log.level || 'info')}">
      <time>${escapeHtml(queueLogClock(log.created_at))}</time>
      <span class="queue-log-phase">${escapeHtml(queuePhaseLabel(log.phase))}</span>
      <div class="queue-log-message">${escapeHtml(log.message || '')}${queueLogDetailHtml(log.detail)}</div>
    </div>`).join('');
}

async function loadJobLogs(jobId) {
  if (jobLogRequests.has(jobId)) return jobLogRequests.get(jobId);
  const request = api(`/api/jobs/${jobId}/logs?limit=80`).then(data => {
    jobLogCache.set(jobId, Array.isArray(data.logs) ? data.logs : []);
    jobLogRefreshAt.set(jobId, Date.now());
    const panel = document.querySelector(`[data-job-log-panel="${CSS.escape(String(jobId))}"]`);
    if (panel && expandedJobLogs.has(jobId)) panel.innerHTML = queueLogPanelHtml(jobId);
  }).finally(() => jobLogRequests.delete(jobId));
  jobLogRequests.set(jobId, request);
  return request;
}

async function toggleJobLogs(jobId) {
  if (expandedJobLogs.has(jobId)) {
    expandedJobLogs.delete(jobId);
  } else {
    expandedJobLogs.add(jobId);
    await loadJobLogs(jobId);
  }
  await refreshJobs();
}

function bindQueueInteractions() {
  if (!els.queueList || els.queueList.dataset.interactionsBound === '1') return;
  els.queueList.dataset.interactionsBound = '1';
  els.queueList.addEventListener('click', event => {
    const button = event.target.closest('[data-queue-action]');
    const item = button?.closest('[data-queue-id]');
    if (!button || !item) return;
    const jobId = item.dataset.queueId;
    const action = button.dataset.queueAction;
    const run = action === 'cancel'
      ? api(`/api/jobs/${jobId}/cancel`, { method: 'POST' })
      : action === 'retry'
        ? api(`/api/jobs/${jobId}/retry`, { method: 'POST' })
        : action === 'open'
          ? Promise.resolve(openImage(item.dataset.imageId))
          : action === 'logs'
            ? toggleJobLogs(jobId)
            : null;
    if (run?.catch) run.then(() => { if (action === 'cancel' || action === 'retry') refreshJobs(); }).catch(error => toast(error.message, 'error'));
  });
}

function secondsUntilText(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value < 60) return `${value} 秒`;
  if (value < 3600) return `${Math.ceil(value / 60)} 分钟`;
  return `${Math.floor(value / 3600)} 小时 ${Math.ceil((value % 3600) / 60)} 分钟`;
}

function officialAccounts() {
  return Array.isArray(providerCatalog?.official?.accounts) ? providerCatalog.official.accounts : [];
}

function selectedOfficialAccount() {
  const id = String(els.officialAccountSelect?.value || appState.officialAccountId || '');
  return officialAccounts().find(account => account.id === id) || null;
}

function syncOfficialAccountOptions() {
  if (!els.officialAccountSelect || !providerCatalog?.official) return;
  const accounts = officialAccounts();
  const desired = String(appState.officialAccountId || '');
  const selectedId = accounts.some(account => account.id === desired)
    ? desired
    : String(providerCatalog.official.defaultAccountId || accounts[0]?.id || '');
  const previousId = String(els.officialAccountSelect.value || '');
  els.officialAccountSelect.replaceChildren();
  if (!accounts.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '尚未配置官网 Token';
    els.officialAccountSelect.append(option);
  } else {
    for (const account of accounts) {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = `${account.name}${account.tokenHint ? ` · ${account.tokenHint}` : ''}${account.error ? ' · 不可用' : ''}`;
      els.officialAccountSelect.append(option);
    }
  }
  els.officialAccountSelect.value = selectedId;
  appState.officialAccountId = selectedId;
  if (previousId && previousId !== selectedId) latestNaiAccount = null;
}

function renderOfficialAccountList() {
  if (!els.officialAccountList) return;
  const accounts = officialAccounts();
  els.officialAccountList.innerHTML = accounts.length ? accounts.map(account => `
    <div class="provider-account-row${account.error ? ' is-error' : ''}">
      <span class="provider-account-copy"><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.error || `${account.source === 'env' ? '.env 原始值' : account.source === 'ui-default' ? '加密覆盖 .env' : globalThis.NAI_RUNTIME?.native ? '本机加密' : '服务端加密'}${account.tokenHint ? ` · ${account.tokenHint}` : ''}`)}</small></span>
      <span class="provider-account-actions">
        ${account.isDefault ? '<span class="provider-default-badge">默认</span>' : `<button class="ghost" type="button" data-default-official-account="${escapeHtml(account.id)}">设默认</button>`}
        ${account.editable !== false ? `<button class="ghost" type="button" data-edit-official-account="${escapeHtml(account.id)}">修改</button>` : ''}
        ${account.resettable ? '<button class="ghost" type="button" data-reset-official-env>恢复 .env</button>' : ''}
        ${account.removable ? `<button class="ghost danger" type="button" data-delete-official-account="${escapeHtml(account.id)}">删除</button>` : ''}
      </span>
    </div>
  `).join('') : '<small>还没有可用的官网 Token。</small>';
}

function resetOfficialTokenForm() {
  editingOfficialAccountId = '';
  if (els.officialAccountName) {
    els.officialAccountName.disabled = false;
    els.officialAccountName.value = '';
    els.officialAccountName.placeholder = '名称，例如 Opus 主号';
  }
  if (els.officialApiToken) {
    els.officialApiToken.value = '';
    els.officialApiToken.placeholder = '粘贴 pst- 开头的 Persistent API Token';
  }
  if (els.saveOfficialTokenButton) els.saveOfficialTokenButton.textContent = '添加';
  els.cancelOfficialTokenEdit?.classList.add('hidden');
}

function beginOfficialTokenEdit(accountId) {
  const account = officialAccounts().find(item => item.id === accountId);
  if (!account || account.editable === false) return;
  editingOfficialAccountId = account.id;
  const isEnv = account.id === 'env';
  if (els.officialAccountName) {
    els.officialAccountName.disabled = isEnv;
    els.officialAccountName.value = isEnv ? '默认 Token' : account.name;
    els.officialAccountName.placeholder = isEnv ? '默认 Token' : '修改账户名称';
  }
  if (els.officialApiToken) {
    els.officialApiToken.value = '';
    els.officialApiToken.placeholder = isEnv ? '粘贴新的默认 pst- Token' : '粘贴新 Token；留空则只改名称';
  }
  if (els.saveOfficialTokenButton) els.saveOfficialTokenButton.textContent = isEnv ? '替换默认' : '保存修改';
  els.cancelOfficialTokenEdit?.classList.remove('hidden');
  const manager = els.officialAccountList?.closest('details');
  if (manager) manager.open = true;
  els.officialApiToken?.focus();
}

// Third-party relays: the RBQ preset plus relays the user adds (public/provider-route.js).
// RBQ is listed only once it has a Key, so a fresh install shows NovelAI alone.
let editingRelayId = '';
function relayHost(url) {
  try { return new URL(url).host; } catch { return ''; }
}
function relayCatalog() {
  const list = [];
  const rbq = providerCatalog?.rbq;
  if (rbq?.configured || rbq?.error) list.push({ id: 'rbq', name: 'RBQ 中转', host: relayHost(rbq.endpoint), tokenHint: rbq.tokenHint, source: rbq.source, configured: Boolean(rbq.configured), error: rbq.error || '' });
  for (const relay of providerCatalog?.relays || []) if (relay.id) list.push({ ...relay, source: 'ui' });
  return list;
}
function relayById(id) {
  return relayCatalog().find(item => item.id === id) || null;
}
function providerConfigured(provider) {
  if (!providerCatalog) return true;
  if (isOfficialProvider(provider)) return providerCatalog.official?.configured !== false;
  return Boolean(relayById(normalizeProviderId(provider))?.configured);
}
// The channel select lists NovelAI plus every configured relay. appState.provider is the
// source of truth: before the catalog arrives the saved relay keeps a placeholder option, so
// an early generate can never fall back to the official account by accident.
function syncProviderOptions() {
  const select = els.generationProvider;
  const group = $('#relayProviderGroup');
  if (!select || !group) return;
  const current = normalizeProviderId(appState.provider);
  const relays = relayCatalog();
  group.replaceChildren(...relays.map(relay => new Option(relay.name, relay.id)));
  if (!isOfficialProvider(current) && !relays.some(relay => relay.id === current) && !providerCatalog) {
    group.append(new Option(current === 'rbq' ? 'RBQ 中转' : '第三方中转', current));
  }
  group.hidden = !group.children.length;
  const available = [...select.options].some(option => option.value === current);
  select.value = available ? current : 'official';
  if (!available && providerCatalog) appState.provider = 'official';
}
function renderRelayList() {
  const list = $('#relayList');
  if (!list) return;
  const relays = relayCatalog();
  list.innerHTML = relays.map(relay => `
    <div class="provider-account-row${relay.error ? ' is-error' : ''}">
      <span class="provider-account-copy"><strong>${escapeHtml(relay.name)}</strong><small>${escapeHtml(relay.error || [relay.host, relay.tokenHint, relay.source === 'env' ? '.env' : ''].filter(Boolean).join(' · '))}</small></span>
      <span class="provider-account-actions">
        <button class="ghost" type="button" data-edit-relay="${escapeHtml(relay.id)}">修改</button>
        ${relay.source === 'env' ? '' : `<button class="ghost danger" type="button" data-delete-relay="${escapeHtml(relay.id)}">删除</button>`}
      </span>
    </div>`).join('');
  list.hidden = !relays.length;
}
function syncRelayForm() {
  const kind = $('#relayKind'), name = $('#relayName'), url = $('#relayApiUrl'), hint = $('#relayCustomHint');
  const customAllowed = providerCatalog?.customRelays === true;
  if (kind) {
    kind.querySelector('[value="custom"]')?.toggleAttribute('disabled', !customAllowed);
    if (!customAllowed) kind.value = 'rbq';
    kind.hidden = Boolean(editingRelayId) || !customAllowed;
  }
  const custom = editingRelayId ? editingRelayId.startsWith('relay:') : kind?.value === 'custom';
  for (const node of [name, url, hint]) if (node) node.hidden = !custom;
  if (els.rbqApiKey) els.rbqApiKey.placeholder = editingRelayId.startsWith('relay:') ? '新的 Key；留空则不改' : custom ? '粘贴中转 Key' : '粘贴 RBQ API Key';
  if (els.saveRbqKeyButton) els.saveRbqKeyButton.textContent = editingRelayId ? '保存修改' : '保存';
  $('#cancelRelayEdit')?.classList.toggle('hidden', !editingRelayId);
}
function resetRelayForm() {
  editingRelayId = '';
  for (const id of ['#relayName', '#relayApiUrl']) { const node = $(id); if (node) node.value = ''; }
  if (els.rbqApiKey) els.rbqApiKey.value = '';
  syncRelayForm();
}
function beginRelayEdit(id) {
  const relay = relayById(id);
  if (!relay) return;
  editingRelayId = relay.id;
  if (relay.id.startsWith('relay:')) {
    $('#relayName').value = relay.name;
    $('#relayApiUrl').value = relay.endpoint || '';
  }
  if (els.rbqApiKey) els.rbqApiKey.value = '';
  syncRelayForm();
  els.rbqApiKey?.focus();
}
async function deleteRelay(id) {
  const relay = relayById(id);
  if (!relay || !(await confirmAction(`删除「${relay.name}」？保存的 Key 会一起删除。`, { confirmLabel: '删除', danger: true }))) return;
  const path = id === 'rbq' ? '/api/providers/rbq' : `/api/providers/relays/${encodeURIComponent(id.slice('relay:'.length))}`;
  const data = await api(path, { method: 'DELETE' });
  providerCatalog = data.providers || providerCatalog;
  if (editingRelayId === id) resetRelayForm();
  syncProviderUi();
  toast(`已删除：${relay.name}`, 'success');
}
async function saveCustomRelay() {
  const key = String(els.rbqApiKey?.value || '').trim();
  const body = { name: String($('#relayName')?.value || '').trim(), apiUrl: String($('#relayApiUrl')?.value || '').trim(), key };
  if (!body.apiUrl) throw new Error('请填写中转的接口地址。');
  if (!editingRelayId && !key) throw new Error('请先粘贴中转 Key。');
  const editing = editingRelayId;
  const data = editing
    ? await api(`/api/providers/relays/${encodeURIComponent(editing.slice('relay:'.length))}`, { method: 'PUT', body })
    : await api('/api/providers/relays', { method: 'POST', body });
  providerCatalog = data.providers || providerCatalog;
  resetRelayForm();
  if (!editing && data.providerId) appState.provider = data.providerId;
  syncProviderUi();
  if (!editing && data.providerId) els.generationProvider?.dispatchEvent(new Event('change', { bubbles: true }));
  toast(editing ? '中转已更新。' : '中转已保存，并设为当前通道。', 'success');
}

function syncAccountUsageSummary() {
  if (!els.accountUsageSummary) return;
  const route = normalizeProviderId(els.generationProvider?.value);
  if (route !== 'rbq' && !isOfficialProvider(route)) {
    els.accountUsageSummary.textContent = `${relayById(route)?.name || '第三方中转'} · 额度由中转管理`;
    return;
  }
  if (route === 'rbq') {
    const remaining = latestRbqAccount?.usage?.remainingImages;
    els.accountUsageSummary.textContent = remaining == null ? 'RBQ 额度 · 读取中…' : `RBQ 额度 · 剩余 ${Number(remaining).toLocaleString()}`;
    return;
  }
  const percent = Number(latestNaiAccount?.usage?.percent);
  const anlas = Number(latestNaiAccount?.anlas?.total);
  const accountName = selectedOfficialAccount()?.name || 'NovelAI';
  els.accountUsageSummary.textContent = Number.isFinite(percent) && Number.isFinite(anlas)
    ? `${accountName} · V5 ${percent}% · Anlas ${anlas.toLocaleString()}`
    : `${accountName} · 额度读取中…`;
}

function syncProviderUi() {
  syncProviderOptions();
  const provider = normalizeProviderId(els.generationProvider?.value);
  const official = providerCatalog?.official || null;
  const relayRoute = !isOfficialProvider(provider);
  const relay = relayRoute ? relayById(provider) : null;
  syncOfficialAccountOptions();
  renderOfficialAccountList();
  renderRelayList();
  syncRelayForm();
  if (els.officialProviderPanel) {
    els.officialProviderPanel.hidden = relayRoute && !globalThis.NAI_RUNTIME?.native;
    if (globalThis.NAI_RUNTIME?.native) {
      let help = $('#nativeVibeAccountHelp');
      if (!help) {
        help = document.createElement('p'); help.id = 'nativeVibeAccountHelp'; help.className = 'muted';
        help.textContent = '中转普通生成只需 Key。Vibe 编码缓存不足时需要下方选中的官网账号，发送参考图前会确认。';
        els.officialProviderPanel.prepend(help);
      }
      help.hidden = !relayRoute;
      const label = els.officialProviderPanel.querySelector('.provider-account-picker');
      if (label?.firstChild) label.firstChild.textContent = relayRoute ? 'Vibe 编码账号（普通生成无需）' : '本次使用';
    }
    els.officialProviderPanel.classList.toggle('is-ready', provider === 'official' && official?.configured === true && !official?.error);
    els.officialProviderPanel.classList.toggle('is-error', provider === 'official' && (official?.configured === false || Boolean(official?.error)));
  }
  if (els.officialProviderStatus) {
    const selected = selectedOfficialAccount();
    if (!official) els.officialProviderStatus.textContent = '正在读取配置…';
    else if (official.error) els.officialProviderStatus.textContent = official.error;
    else if (!official.configured) els.officialProviderStatus.textContent = '未配置 Token';
    else els.officialProviderStatus.textContent = `${official.accounts.length} 个 · 当前 ${selected?.name || '未选择'}`;
  }
  if (els.rbqProviderPanel) {
    els.rbqProviderPanel.hidden = !relayRoute;
    els.rbqProviderPanel.classList.toggle('is-ready', relayRoute && relay?.configured === true);
    els.rbqProviderPanel.classList.toggle('is-error', relayRoute && Boolean(providerCatalog) && (!relay?.configured || Boolean(relay?.error)));
  }
  const relayName = $('#relayProviderName');
  if (relayName) relayName.textContent = relay?.name || (provider === 'rbq' ? 'RBQ 中转' : '第三方中转');
  if (els.rbqProviderStatus) {
    if (!providerCatalog) els.rbqProviderStatus.textContent = '正在读取配置…';
    else if (relay?.error) els.rbqProviderStatus.textContent = relay.error;
    else if (relay?.configured) els.rbqProviderStatus.textContent = [relay.host, relay.tokenHint, relay.source === 'env' ? '.env' : ''].filter(Boolean).join(' · ');
    else els.rbqProviderStatus.textContent = '未配置 Key';
  }
  if (els.naiAccountUsage) els.naiAccountUsage.hidden = relayRoute;
  if (els.rbqAccountUsage) els.rbqAccountUsage.hidden = provider !== 'rbq';
  syncAccountUsageSummary();
  // First run on the phone: nothing can be generated until the user adds their own credential.
  // The server site always has its configured accounts, so the hint is native-only.
  const firstRun = $('#firstRunHint');
  if (firstRun) firstRun.hidden = !globalThis.NAI_RUNTIME?.native || !providerCatalog || official?.configured === true || relayCatalog().some(item => item.configured);
  const hint = $('#generateHint');
  if (hint) hint.textContent = relayRoute
    ? (relay?.name || '第三方中转')
    : `NovelAI${selectedOfficialAccount()?.name ? ` · ${selectedOfficialAccount().name}` : ''}`;
}

async function refreshProviderStatus(showError = false) {
  try {
    const data = await api('/api/providers');
    providerCatalog = data.providers || null;
    syncProviderUi();
    return providerCatalog;
  } catch (error) {
    if (showError) toast(error.message, 'error');
    return null;
  }
}

async function saveRbqKey() {
  if (editingRelayId.startsWith('relay:') || (!editingRelayId && $('#relayKind')?.value === 'custom')) return saveCustomRelay();
  const token = String(els.rbqApiKey?.value || '').trim();
  if (!token) throw new Error('请先粘贴 RBQ API Key。');
  const firstKey = !providerCatalog?.rbq?.configured;
  if (els.saveRbqKeyButton) els.saveRbqKeyButton.disabled = true;
  try {
    const data = await api('/api/providers/rbq', { method: 'POST', body: { token } });
    providerCatalog = data.providers || null;
    resetRelayForm();
    if (firstKey) appState.provider = 'rbq';
    syncProviderUi();
    if (firstKey) els.generationProvider?.dispatchEvent(new Event('change', { bubbles: true }));
    toast(globalThis.NAI_RUNTIME?.native ? 'RBQ Key 已在本机加密保存。' : 'RBQ Key 已在服务端加密保存。', 'success');
    await refreshRbqAccount(false);
  } finally {
    if (els.saveRbqKeyButton) els.saveRbqKeyButton.disabled = false;
  }
}

async function saveOfficialToken() {
  const token = String(els.officialApiToken?.value || '').trim();
  const name = String(els.officialAccountName?.value || '').trim();
  const editing = String(editingOfficialAccountId || '');
  if (!editing && !token) throw new Error('请先粘贴 pst- 开头的 NovelAI Persistent API Token。');
  if (editing === 'env' && !token) throw new Error('替换默认 Token 时需要粘贴新的 pst- Token。');
  if (els.saveOfficialTokenButton) els.saveOfficialTokenButton.disabled = true;
  try {
    const data = editing
      ? await api(`/api/providers/official/accounts/${encodeURIComponent(editing)}`, { method: 'PUT', body: { name, token } })
      : await api('/api/providers/official/accounts', { method: 'POST', body: { name, token } });
    providerCatalog = data.providers || null;
    appState.officialAccountId = String(data.accountId || '');
    const edited = Boolean(editing);
    resetOfficialTokenForm();
    latestNaiAccount = null;
    syncProviderUi();
    toast(edited ? 'NovelAI 官网 Token 已更新并选中。' : globalThis.NAI_RUNTIME?.native ? 'NovelAI 官网 Token 已在本机加密保存并选中。' : 'NovelAI 官网 Token 已在服务端加密保存并选中。', 'success');
    await refreshNaiAccount(false);
  } finally {
    if (els.saveOfficialTokenButton) els.saveOfficialTokenButton.disabled = false;
  }
}

async function setDefaultOfficialAccount(accountId) {
  const account = officialAccounts().find(item => item.id === accountId);
  if (!account) return;
  const data = await api(`/api/providers/official/accounts/${encodeURIComponent(accountId)}/default`, { method: 'PUT' });
  providerCatalog = data.providers || null;
  appState.officialAccountId = accountId;
  latestNaiAccount = null;
  syncProviderUi();
  toast(`已设为默认 Token：${account.name}`, 'success');
  await refreshNaiAccount(false);
}

async function resetOfficialEnvToken() {
  if (!(await confirmAction('恢复使用服务器 .env 中的 NOVELAI_API_TOKEN？', { confirmLabel: '恢复' }))) return;
  const data = await api('/api/providers/official/accounts/env/override', { method: 'DELETE' });
  providerCatalog = data.providers || null;
  appState.officialAccountId = 'env';
  resetOfficialTokenForm();
  latestNaiAccount = null;
  syncProviderUi();
  toast('默认 Token 已恢复为 .env 原始值。', 'success');
  await refreshNaiAccount(false);
}

async function deleteOfficialAccount(accountId) {
  const account = officialAccounts().find(item => item.id === accountId);
  if (!account?.removable) return;
  if (!(await confirmAction(`删除官网 Token「${account.name}」？此操作不会删除已生成图片。`, { confirmLabel: '删除', danger: true }))) return;
  const data = await api(`/api/providers/official/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
  providerCatalog = data.providers || null;
  if (appState.officialAccountId === accountId) appState.officialAccountId = String(providerCatalog?.official?.defaultAccountId || '');
  if (editingOfficialAccountId === accountId) resetOfficialTokenForm();
  latestNaiAccount = null;
  syncProviderUi();
  toast(`已删除官网 Token「${account.name}」。`, 'success');
  await refreshNaiAccount(false);
}

async function refreshRbqAccount(showError = false) {
  if (els.generationProvider?.value !== 'rbq') return null;
  if (providerCatalog?.rbq?.configured === false) {
    if (els.rbqAccountName) els.rbqAccountName.textContent = '未配置 Key';
    if (els.rbqUsageHint) els.rbqUsageHint.textContent = '先在上方保存 RBQ API Key';
    if (els.rbqAccountUsage) els.rbqAccountUsage.classList.add('is-error');
    return null;
  }
  try {
    const data = await api('/api/providers/rbq/account');
    latestRbqAccount = data;
    const used = Number(data?.usage?.totalImages || 0);
    const quota = data?.usage?.quotaImages == null ? null : Number(data.usage.quotaImages);
    const remaining = data?.usage?.remainingImages == null ? null : Number(data.usage.remainingImages);
    const percent = quota && Number.isFinite(quota) ? Math.min(100, Math.max(0, used / quota * 100)) : 0;
    if (els.rbqAccountName) els.rbqAccountName.textContent = `${data.name || 'RBQ'}${data.active ? '' : ' · 不可用'}`;
    if (els.rbqUsageText) els.rbqUsageText.textContent = quota == null ? `${used.toLocaleString()} / 不限` : `${used.toLocaleString()} / ${quota.toLocaleString()}`;
    if (els.rbqUsageMeter) els.rbqUsageMeter.value = percent;
    if (els.rbqRemainingText) els.rbqRemainingText.textContent = remaining == null ? '不限' : remaining.toLocaleString();
    if (els.rbqConcurrentText) els.rbqConcurrentText.textContent = Number(data.maxConcurrent || 0).toLocaleString();
    if (els.rbqUsageHint) {
      const expiry = data.expiresAt ? `到期 ${data.expiresAt}` : '永久有效';
      els.rbqUsageHint.textContent = `${expiry} · 已请求 ${Number(data?.usage?.totalRequests || 0).toLocaleString()} 次`;
    }
    if (els.rbqAccountUsage) els.rbqAccountUsage.classList.toggle('is-error', !data.active);
    syncAccountUsageSummary();
    return data;
  } catch (error) {
    latestRbqAccount = null;
    if (els.rbqAccountName) els.rbqAccountName.textContent = '额度读取失败';
    if (els.rbqUsageHint) els.rbqUsageHint.textContent = error.message;
    if (els.rbqAccountUsage) els.rbqAccountUsage.classList.add('is-error');
    syncAccountUsageSummary();
    if (showError) toast(error.message, 'error');
    return null;
  }
}

async function refreshNaiAccount(showError = false) {
  if (!isOfficialProvider(els.generationProvider?.value)) return null;
  try {
    const accountId = String(els.officialAccountSelect?.value || appState.officialAccountId || '');
    if (!accountId) throw new Error('请先添加或选择 NovelAI 官网 Token。');
    const data = await api(`/api/novelai/account?accountId=${encodeURIComponent(accountId)}`);
    latestNaiAccount = data;
    if (els.naiAccountTier) els.naiAccountTier.textContent = `${data.tierName || 'NovelAI'}${data.active ? '' : ' · 非活动订阅'}`;
    const percent = Number(data?.usage?.percent);
    if (els.naiV5UsageText) els.naiV5UsageText.textContent = Number.isFinite(percent) ? `${percent}%` : '不可用';
    if (els.naiV5UsageMeter) els.naiV5UsageMeter.value = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
    if (els.naiV5UsageHint) {
      if (data?.usage?.isNegative) els.naiV5UsageHint.textContent = '当前动态免费额度不可用';
      else if (data?.usage && Number.isFinite(Number(data.usage.timeUntilNextPercent))) els.naiV5UsageHint.textContent = `约 ${secondsUntilText(data.usage.timeUntilNextPercent)} 后 +1% · 官方仅返回整数刻度`;
      else els.naiV5UsageHint.textContent = '当前订阅未返回 V5 动态额度状态';
    }
    if (els.naiAnlasText) els.naiAnlasText.textContent = Number(data?.anlas?.total || 0).toLocaleString();
    if (els.naiAccountUsage) els.naiAccountUsage.classList.remove('is-error');
    syncAccountUsageSummary();
    return data;
  } catch (error) {
    latestNaiAccount = null;
    if (els.naiAccountTier) els.naiAccountTier.textContent = '额度读取失败';
    if (els.naiAccountUsage) els.naiAccountUsage.classList.add('is-error');
    syncAccountUsageSummary();
    if (showError) toast(error.message, 'error');
    return null;
  }
}

function queueBillingText(job) {
  const billing = job?.billing;
  if (!billing?.delta) return job?.billing_log || '';
  const parts = [];
  if (billing.v5) {
    const net = Number(billing.delta.usagePercentNet);
    if (billing.before?.usageUnavailable) parts.push('V5 免费额度不可用');
    else if (Number.isFinite(net) && net > 0) parts.push(`V5 净 -${net}%`);
  }
  const anlas = Number(billing.delta.anlasSpent);
  if (Number.isFinite(anlas) && anlas > 0) parts.push(`Anlas -${anlas}`);
  return parts.join(' · ');
}

function refreshJobs() {
  if (refreshJobsRequest) return refreshJobsRequest;
  refreshJobsRequest = refreshJobsNow().finally(() => { refreshJobsRequest = null; });
  return refreshJobsRequest;
}

async function refreshJobsNow() {
  try {
    const params = new URLSearchParams({ limit: '120' });
    if (galleryCompletionCursor) params.set('completionCursor', galleryCompletionCursor);
    const data = await api(`/api/jobs?${params.toString()}`);
    renderJobs(data);
    const now = Date.now();
    for (const jobId of expandedJobLogs) {
      if (now - Number(jobLogRefreshAt.get(jobId) || 0) < 6000) continue;
      loadJobLogs(jobId).catch(() => {});
    }
    const completedImages = Array.isArray(data.completedImages) ? data.completedImages : [];
    const newlyQueued = [];
    for (const event of completedImages) {
      const image = event?.image;
      if (!image?.id || loadedGalleryImage(image.id) || pendingGalleryImages.has(image.id)) continue;
      pendingGalleryImages.set(image.id, image);
      newlyQueued.push(image);
    }
    if (data.completionSnapshotCursor) pendingGallerySnapshotCursor = String(data.completionSnapshotCursor);
    if (data.completionCursor) galleryCompletionCursor = String(data.completionCursor);
    galleryNewImageCount = pendingGalleryImages.size;
    renderGalleryNewImagesNotice();
    if (newlyQueued.length) {
      tryAutoLoadPendingGalleryImages();
      refreshQuickLatestOnly().catch(() => {});
      if (els.generationProvider?.value === 'rbq') refreshRbqAccount(false).catch(() => {});
      else refreshNaiAccount(false).catch(() => {});
      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        new Notification('NAI Pocket', { body: `${newlyQueued.length} 张图片已生成完成。`, icon: '/icons/icon-flow-192.png' });
      }
    }
    // A finished sample job files an artist example a moment after it completes. An open artist
    // page (list counts, coverage line, the detail being watched) refreshes itself shortly after,
    // instead of staying stale until the next navigation. refresh() is a no-op when it is closed.
    if (completedImages.length) {
      clearTimeout(artistRefreshAfterCompletion);
      artistRefreshAfterCompletion = window.setTimeout(() => artistLibrary?.refresh?.(), 1500);
    }
    if (data.completionHasMore) window.setTimeout(() => refreshJobs(), 0);
    const cooldownSeconds = Math.max(0, Math.ceil((Number(data.cooldownUntil || 0) - Date.now()) / 1000));
    els.connectionText.textContent = authContext.role === 'visitor'
      ? '参观模式 · 只读'
      : data.paused ? '队列已暂停' : cooldownSeconds ? `限流冷却 ${cooldownSeconds}s` : '已连接';
  } catch (error) {
    els.connectionText.textContent = authContext.role === 'visitor' ? '参观模式 · 只读' : '连接异常';
  }
}

// Queue control (owner): why the queue is paused, 换渠道 for every waiting
// job, and 全部取消 (two taps). Picking a route also resumes the queue and
// makes it the editor's route, so new jobs do not go back to a dead account.

let queueLastData = null;
let queuePauseAnnouncedAt = 0;
let queueCancelArmedUntil = 0;

function queueRouteName(job) {
  if (job.provider === 'rbq') return 'RBQ';
  if (!isOfficialProvider(job.provider)) return relayById(job.provider)?.name || '中转';
  return officialAccounts().find(account => account.id === job.official_account_id)?.name || '官方';
}

function queuePauseText(reason) {
  if (!reason) return '';
  if (reason.kind !== 'account') return '队列已暂停。';
  const why = Number(reason.status) === 402 ? 'Anlas 不足' : Number(reason.status) === 401 ? 'Token 失效' : `被拒绝（${reason.status}）`;
  return `队列已自动暂停：${reason.label || '当前渠道'} ${why}。换一个渠道继续，或检查这个账号后再继续。`;
}

function renderQueueControl(data) {
  queueLastData = data;
  const note = $('#queuePauseNote');
  if (note) {
    note.hidden = !data.paused;
    note.textContent = queuePauseText(data.pauseReason || (data.paused ? { kind: 'manual' } : null));
    note.classList.toggle('warn', data.pauseReason?.kind === 'account');
  }
  const waiting = Number(data.counts?.pending || 0);
  const cancel = $('#queueCancelAllButton');
  if (cancel) {
    cancel.disabled = !waiting;
    const armed = waiting && queueCancelArmedUntil > Date.now();
    cancel.textContent = armed ? `再点一次：取消 ${waiting} 个等待中的任务` : '全部取消';
    cancel.classList.toggle('confirm', Boolean(armed));
  }
  const reroute = $('#queueRerouteButton');
  if (reroute) reroute.disabled = !waiting && data.pauseReason?.kind !== 'account';
  const reason = data.pauseReason;
  if (reason?.kind === 'account' && reason.at && reason.at !== queuePauseAnnouncedAt && authContext.role === 'owner') {
    queuePauseAnnouncedAt = reason.at;
    toast(`${queuePauseText(reason).replace('换一个渠道继续，或检查这个账号后再继续。', '')}到「队列」页换渠道继续。`, 'error');
  }
}

function queueRouteChoices() {
  const choices = officialAccounts().map(account => ({ provider: 'official', officialAccountId: account.id, label: account.name }));
  for (const relay of relayCatalog()) if (relay.configured) choices.push({ provider: relay.id, officialAccountId: '', label: relay.name });
  return choices;
}

function openQueueRouteMenu() {
  const menu = $('#queueRouteMenu');
  const button = $('#queueRerouteButton');
  if (!menu) return;
  const open = menu.hidden;
  menu.hidden = !open;
  button?.setAttribute('aria-expanded', String(open));
  if (!open) return;
  const dead = queueLastData?.pauseReason?.kind === 'account' ? queueLastData.pauseReason.route : null;
  const choices = queueRouteChoices();
  menu.innerHTML = `<p>把等待中的任务改用：</p>${choices.map((choice, index) => {
    const isDead = dead && dead.provider === choice.provider && (!isOfficialProvider(choice.provider) || dead.officialAccountId === choice.officialAccountId);
    return `<button type="button" data-queue-route="${index}"${isDead ? ' class="dead"' : ''}>${escapeHtml(choice.label)}${isDead ? '<small>刚才失败</small>' : ''}</button>`;
  }).join('') || '<p>还没有可用的渠道；先在设置里添加 Token。</p>'}<small class="queue-route-hint">改用后会继续队列，之后新生成的图也用这个渠道。</small>`;
  menu.querySelectorAll('[data-queue-route]').forEach(node => node.addEventListener('click', () => rerouteQueue(choices[Number(node.dataset.queueRoute)])));
}

async function rerouteQueue(choice) {
  if (!choice) return;
  const result = await api('/api/jobs/reroute', { method: 'POST', body: { provider: choice.provider, officialAccountId: choice.officialAccountId, resume: true } });
  $('#queueRouteMenu').hidden = true;
  $('#queueRerouteButton')?.setAttribute('aria-expanded', 'false');
  // New jobs from the editor take the same route.
  if (els.generationProvider && els.generationProvider.value !== choice.provider) {
    appState.provider = choice.provider;
    syncProviderOptions();
    els.generationProvider.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (choice.provider === 'official' && els.officialAccountSelect && els.officialAccountSelect.value !== choice.officialAccountId) {
    els.officialAccountSelect.value = choice.officialAccountId;
    els.officialAccountSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const parts = [`${result.moved + result.retried} 个任务改用 ${choice.label}`];
  if (result.retried) parts.push(`其中 ${result.retried} 个失败的已重新排队`);
  if (result.skipped) parts.push(`${result.skipped} 个官方图片工具任务没有改（中转不支持）`);
  toast(`${parts.join('，')}；队列已继续。`, 'success');
  refreshJobs();
}

async function cancelAllQueued() {
  if (queueCancelArmedUntil <= Date.now()) {
    queueCancelArmedUntil = Date.now() + 4000;
    if (queueLastData) renderQueueControl(queueLastData);
    setTimeout(() => { if (queueLastData) renderQueueControl(queueLastData); }, 4100);
    return;
  }
  queueCancelArmedUntil = 0;
  const result = await api('/api/jobs/cancel-all', { method: 'POST', body: {} });
  toast(result.cancelled ? `已取消 ${result.cancelled} 个等待中的任务。` : '没有等待中的任务。', result.cancelled ? 'success' : '');
  refreshJobs();
}

function renderJobs(data) {
  bindQueueInteractions();
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const counts = Object.fromEntries(['pending', 'running', 'completed', 'failed'].map(key => [key, Number(data.counts?.[key] ?? jobs.filter(job => job.status === key).length)]));
  els.queueBadge.textContent = counts.pending + counts.running;
  if (els.floatingQueueCount) els.floatingQueueCount.textContent = counts.pending + counts.running;
  const cooldownSeconds = Math.max(0, Math.ceil((Number(data.cooldownUntil || 0) - Date.now()) / 1000));
  els.queueSummary.innerHTML = [
    ['生成中', counts.running], ['等待', counts.pending], ['完成', counts.completed], ['失败', counts.failed]
  ].map(([label, value]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join('')
    + (cooldownSeconds ? `<div class="queue-cooldown"><strong>429 限流冷却</strong><span>约 ${cooldownSeconds} 秒后自动续跑；无需手动逐个重试。</span></div>` : '');
  $('#pauseQueueButton').disabled = data.paused;
  $('#resumeQueueButton').disabled = !data.paused;
  renderQueueControl(data);
  const signature = jobs.map(job => [job.id, job.status, job.position, job.seed, job.attempts, job.provider, job.official_account_id, job.last_log, job.last_log_phase, job.last_log_level, job.error, job.image_id, expandedJobLogs.has(job.id)].map(value => String(value ?? '')).join(':')).join('|');
  if (signature === queueRenderSignature) {
    const jobById = new Map(jobs.map(job => [String(job.id), job]));
    els.queueList.querySelectorAll('[data-queue-elapsed]').forEach(node => {
      const job = jobById.get(String(node.dataset.queueElapsed));
      if (job) node.textContent = queueElapsedText(job);
    });
    return;
  }
  queueRenderSignature = signature;
  els.queueList.innerHTML = '';
  if (!jobs.length) {
    els.queueList.textContent = '暂无任务';
    return;
  }
  for (const job of jobs) {
    const item = document.createElement('div');
    item.className = `queue-item is-${job.status}`;
    item.dataset.queueId = job.id;
    if (job.image_id) item.dataset.imageId = job.image_id;
    const elapsed = queueElapsedText(job);
    const showLive = job.last_log && job.status !== 'completed' && String(job.last_log) !== String(job.error || '');
    const previousErrorPrefix = job.status === 'running' && job.error ? '<span class="queue-error-prefix">上次异常</span>' : '';
    const logsOpen = expandedJobLogs.has(job.id);
    const storm = job.experiment?.type === 'artist-storm' ? job.experiment : null;
    // New layout: each row leads with a square, the finished image or a status mark.
    const lead = job.image_id
      ? `<button type="button" class="queue-thumb" data-new-layout-only data-queue-action="open" aria-label="查看图片"><img src="/api/images/${encodeURIComponent(job.image_id)}/thumbnail" alt="" loading="lazy" decoding="async"></button>`
      : `<span class="queue-thumb placeholder ${escapeHtml(job.status)}" data-new-layout-only aria-hidden="true"></span>`;
    item.innerHTML = `
      ${lead}
      <div class="queue-main">
        <div class="queue-line"><span class="status ${job.status}">${statusLabel(job.status)}</span><strong>第 ${job.position} 张</strong><small>Seed ${job.seed}</small><small class="queue-route">${escapeHtml(queueRouteName(job))}</small>${Number(job.attempts || 0) > 1 ? `<small class="queue-attempts">已尝试 ${job.attempts} 次</small>` : ''}${elapsed ? `<small class="queue-elapsed" data-queue-elapsed="${escapeHtml(String(job.id))}">${escapeHtml(elapsed)}</small>` : ''}<small>${formatDate(job.created_at)}</small></div>
        ${storm ? `<div><span class="queue-storm">Storm ${storm.index}/${storm.total}${storm.externalArtist?.text ? ` · 外来 ${escapeHtml(storm.externalArtist.text)}` : ''}</span></div>` : ''}
        ${queueBillingText(job) ? `<div><span class="queue-billing" title="${escapeHtml(job.billing_log || '官方账户状态前后差值')}">${escapeHtml(queueBillingText(job))}</span></div>` : ''}
        ${showLive ? `<div class="queue-live ${escapeHtml(job.last_log_level || 'info')}"><span>${escapeHtml(queuePhaseLabel(job.last_log_phase))}</span><div>${escapeHtml(job.last_log)}</div></div>` : ''}
        ${job.error ? `<div class="queue-error">${previousErrorPrefix}${escapeHtml(job.error)}</div>` : ''}
      </div>
      <div class="inline-actions queue-actions">
        ${['pending', 'running'].includes(job.status) ? `<button class="ghost danger" data-cancel data-queue-action="cancel">${job.status === 'running' ? '停止' : '取消'}</button>` : ''}
        ${job.status === 'failed' ? '<button class="ghost" data-retry data-queue-action="retry">重试</button>' : ''}
        ${job.image_id ? '<button class="ghost" data-open data-queue-action="open">查看</button>' : ''}
        <button class="ghost" data-logs data-queue-action="logs">${logsOpen ? '收起日志' : '日志'}</button>
      </div>
      ${logsOpen ? `<div class="queue-log-panel" data-job-log-panel="${job.id}">${queueLogPanelHtml(job.id)}</div>` : ''}`;
    els.queueList.append(item);
  }
}

function renderResourceStatus(resources) {
  if (!resources || !els.storageMeter) return;
  if (Array.isArray(resources.disks)) {
    diskCapacitySnapshot = { disks: resources.disks, relationship: resources.diskRelationship };
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const unitFor = bytes => Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024))));
  const amount = (bytes, unit) => {
    const value = bytes / 1024 ** unit;
    return value > 0 && value < 0.05 ? '<0.1' : value.toFixed(unit ? 1 : 0);
  };
  const diskHtml = diskCapacitySnapshot ? ['system', 'data'].map(id => {
    const disk = diskCapacitySnapshot.disks.find(item => item.id === id);
    const label = id === 'system' ? (disk?.containerFilesystem ? '运行盘' : '系统盘') : '数据盘';
    const shared = id === 'data' && diskCapacitySnapshot.relationship === 'shared' ? '·共享' : '';
    const readable = disk?.available && [disk.usedBytes, disk.totalBytes, disk.availableBytes].every(value => Number.isFinite(value) && value >= 0) && disk.totalBytes > 0;
    if (!readable) return `<div class="storage-meter-line" data-storage-disk="${id}"><span>${label}${shared} · 容量不可用</span></div>`;
    const unit = unitFor(disk.totalBytes);
    const freeUnit = unitFor(disk.availableBytes);
    const description = `${label} · 已用 ${formatBytes(disk.usedBytes)} / 总量 ${formatBytes(disk.totalBytes)} · 可用 ${formatBytes(disk.availableBytes)}${disk.reservedBytes > 0 ? ` · 系统保留 ${formatBytes(disk.reservedBytes)}` : ''}${shared ? ' · 与运行根目录共享同一文件系统容量' : ''}${disk.containerFilesystem ? ' · Docker 存储所在文件系统，可能与宿主机系统盘不同；两项容量不相加。' : ''}`;
    return `<div class="storage-meter-line" data-storage-disk="${id}" title="${escapeHtml(description)}" aria-label="${escapeHtml(description)}"><span>${label}${shared} ${escapeHtml(amount(disk.usedBytes, unit))} / ${amount(disk.totalBytes, unit)} ${units[unit]} · 可用 ${escapeHtml(amount(disk.availableBytes, freeUnit))} ${units[freeUnit]}</span></div>`;
  }).join('') : `<div class="storage-meter-line" data-storage-disk="data"><span>数据盘 · ${Number.isFinite(resources.freeBytes) ? `可用 ${escapeHtml(amount(resources.freeBytes, unitFor(resources.freeBytes)))} ${units[unitFor(resources.freeBytes)]}` : '容量不可用'}</span></div>`;
  els.storageMeter.innerHTML = `${diskHtml}<div class="storage-audit-summary" data-storage-audit-summary>${escapeHtml(storageAuditSummary)}</div>`;
}

async function runStorageAudit() {
  const button = els.storageAuditButton;
  const summary = els.storageMeter?.querySelector('[data-storage-audit-summary]');
  if (!button || !summary) return;
  button.disabled = true;
  summary.textContent = '正在检查数据目录…';
  try {
    const data = await api('/api/storage/audit');
    const orphanCount = Array.isArray(data.orphanFiles) ? data.orphanFiles.length : 0;
    const missingCount = Array.isArray(data.missingFiles) ? data.missingFiles.length : 0;
    storageAuditSummary = `实际 ${formatBytes(data.actualDataBytes)} · 已登记图库 ${formatBytes(data.trackedGalleryBytes)} · 孤儿文件 ${orphanCount}（${formatBytes(data.orphanBytes)}）· 缺失索引 ${missingCount}`;
    summary.textContent = storageAuditSummary;
  } catch (error) {
    storageAuditSummary = `检查失败：${error.message}`;
    summary.textContent = storageAuditSummary;
  } finally {
    button.disabled = false;
  }
}

async function refreshSystem() {
  try {
    const data = await api('/api/system');
    $('#customCount').max = data.limits.maxBatchSize;
    serverMaxStormSize = Number(data.limits.maxStormSize || 1000);
    renderStormPlan();
    renderResourceStatus(data.resources);
  } catch {}
}

function buildGroupsFromPrompt(prompt) {
  const groups = Object.fromEntries(GROUP_DEFS.map(([key]) => [key, []]));
  tokenizePrompt(prompt).forEach((token, originalOrder) => {
    const tag = hydrateTag({ ...parseTagToken(token), originalOrder });
    if (!tag.text) return;
    const key = classifyTag(tag.text);
    // Restore/import paths keep repeated tags because duplicates can be intentional conditioning.
    groups[key].push(tag);
  });
  return groups;
}

function inspectionAsNaiImport(inspection) {
  const defaults = createDefaultState();
  const detectedModel = inspection?.modelDetected !== false;
  // A PNG without an explicit model is common after re-encoding or metadata stripping.
  // Keep the user's active model instead of turning an unknown image into V4.5.
  const restoreModel = detectedModel ? (inspection?.model || defaults.model) : ($('#model')?.value || appState?.model || defaults.model);
  const seed = Number(inspection?.seed);
  return {
    sourceFormat: 'png-metadata',
    prompt: String(inspection?.prompt || inspection?.description || '').trim(),
    negativePrompt: String(inspection?.negativePrompt || '').trim(),
    characters: (inspection?.characters || []).slice(0, characterLimitForModel(restoreModel)).map((item, index) => ({
      number: index + 1,
      name: '',
      promptRaw: String(item?.prompt || item?.promptRaw || '').trim(),
      ucRaw: String(item?.uc || item?.ucRaw || '').trim(),
      centers: Array.isArray(item?.centers) && item.centers.length ? structuredClone(item.centers) : [{ x: 0.5, y: 0.5 }],
      positionExplicit: Array.isArray(item?.centers) && item.centers.length > 0
    })),
    model: restoreModel,
    seed: Number.isFinite(seed) ? seed : undefined,
    params: {
      ...defaults.params,
      ...(inspection?.params || {}),
      advancedOverrides: filterAdvancedOverrides(inspection?.params?.advancedOverrides || {})
    },
    imageWorkflow: { ...defaults.imageWorkflow, ...(inspection?.imageWorkflow || {}) },
    imageTool: { ...defaults.imageTool, ...(inspection?.imageTool || {}) },
    embeddedInputImage: inspection?.embeddedInputImage ? structuredClone(inspection.embeddedInputImage) : null,
    embeddedMaskImage: inspection?.embeddedMaskImage ? structuredClone(inspection.embeddedMaskImage) : null,
    imageRecovery: inspection?.imageRecovery ? structuredClone(inspection.imageRecovery) : null,
    workflowMetadata: inspection?.workflowMetadata ? structuredClone(inspection.workflowMetadata) : null,
    v4Options: { ...defaults.v4Options, ...(inspection?.v4Options || {}) },
    warnings: Array.isArray(inspection?.warnings) ? inspection.warnings : []
  };
}

function stateFromInspection(inspection, restoreAll = true) {
  // PNG metadata extraction is only the transport layer. From here onward it uses
  // the exact same structured restore engine as NAI / JSON import.
  const restored = buildStateFromNaiImport(inspectionAsNaiImport(inspection), { structured: true });
  if (inspection?.modelDetected === false) restored.model = $('#model')?.value || appState?.model || createDefaultState().model;
  if (restoreAll) return restored;

  const current = serializeState();
  current.groups = structuredClone(restored.groups);
  current.characters = structuredClone(restored.characters);
  current.prompt = restored.prompt;
  current.negativePrompt = restored.negativePrompt;
  current.previewPrompt = restored.previewPrompt;
  current.directMode = false;
  current.promptOrderMode = restored.promptOrderMode;
  current.v4Options = structuredClone(restored.v4Options);
  return current;
}

function closeInspectDialog() {
  els.inspectDialog?.close();
  currentInspection = null;
  if (currentInspectionObjectUrl) URL.revokeObjectURL(currentInspectionObjectUrl);
  currentInspectionObjectUrl = '';
  if (els.inspectPreview) els.inspectPreview.removeAttribute('src');
}

function estimateEmbeddedBytes(value) {
  const text = String(value || '').replace(/^data:[^,]+,/, '').replace(/\s+/g, '');
  return text ? Math.max(0, Math.floor((text.length * 3) / 4) - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0)) : 0;
}

function redactRawParameters(value, key = '', depth = 0) {
  if (depth > 6) return '[已省略过深对象]';
  const lower = String(key || '').toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  if (['image', 'mask', 'inputimage', 'baseimage', 'sourceimage', 'originalimage', 'maskimage'].includes(compact) && typeof value === 'string') {
    if (/^\[(?:asset|mask|encoded-vibe|precise|media|resolved):[^\]]+\]$/i.test(value.trim())) {
      return value.toLowerCase().startsWith('[mask:') ? 'Mask 资产引用（需本机存在对应资产）' : '图片资产引用（需本机存在对应资产）';
    }
    const bytes = estimateEmbeddedBytes(value);
    return bytes ? `[图片数据已分流到输入工作流 · ${formatBytes(bytes)}]` : '[图片数据未随记录保存]';
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactRawParameters(item, key, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 200).map(([childKey, childValue]) => [childKey, redactRawParameters(childValue, childKey, depth + 1)]));
  }
  if (typeof value === 'string' && value.length > 20_000) return `${value.slice(0, 20_000)}…[已截断]`;
  return value;
}

function advancedOverrideLabel(key) {
  return ({
    controlnet_condition: 'ControlNet 条件', controlnet_model: 'ControlNet 模型', controlnet_strength: 'ControlNet 强度',
    dynamic_thresholding: 'Dynamic Thresholding', skip_cfg_above_sigma: 'Variety+ / 跳过 CFG',
    tag_hint_qt: 'Quality 标签提示', tag_hint_uc_preset: 'UC Preset 提示'
  })[key] || key;
}

function renderAdvancedOverrideSummary() {
  const node = $('#advancedOverridesSummary');
  const textarea = $('#advancedOverrides');
  if (!node || !textarea) return;
  const text = textarea.value.trim();
  if (!text) {
    node.classList.add('hidden');
    node.textContent = '';
    return;
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    node.classList.remove('hidden');
    node.className = 'advanced-overrides-summary warning-text';
    node.textContent = 'JSON 尚未闭合；保存或生成前需要先修正。';
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    node.classList.remove('hidden');
    node.className = 'advanced-overrides-summary warning-text';
    node.textContent = '这里必须是 JSON 对象。';
    return;
  }
  const keys = Object.keys(parsed);
  const filtered = filterAdvancedOverrides(parsed);
  const blocked = keys.filter(key => isNonAdvancedParameterKey(key));
  const safe = keys.filter(key => Object.prototype.hasOwnProperty.call(filtered, key)
    || Object.prototype.hasOwnProperty.call(filtered, canonicalAdvancedParameterKey(key)));
  const ignored = keys.filter(key => !blocked.includes(key) && !Object.prototype.hasOwnProperty.call(filtered, key));
  node.className = 'advanced-overrides-summary';
  node.classList.remove('hidden');
  const rows = [];
  if (safe.length) rows.push(`已启用 ${safe.length} 项：${safe.map(key => advancedOverrideLabel(key)).join('、')}`);
  if (blocked.length) rows.push(`工作流/普通控件/请求记录字段 ${blocked.length} 项不会从这里发送（由对应控件接管）：${blocked.join('、')}`);
  if (ignored.length) rows.push(`空值或结构化对象 ${ignored.length} 项不会发送：${ignored.join('、')}`);
  node.textContent = rows.join('。') || '没有可发送的高级参数。';
}

const INSPECT_MEDIA_KEYS = new Set([
  'image', 'mask', 'input_image', 'base_image', 'source_image', 'original_image', 'mask_image'
]);

function inspectKeyMatches(set, key) {
  const lower = String(key || '').toLowerCase();
  if (set.has(lower)) return true;
  const compact = lower.replace(/[^a-z0-9]/g, '');
  for (const item of set) if (String(item).replace(/[^a-z0-9]/g, '') === compact) return true;
  return false;
}

function inspectValueSummary(key, value) {
  if (value == null) return '未保存 / null';
  if (inspectKeyMatches(INSPECT_MEDIA_KEYS, key) && typeof value === 'string') {
    const marker = value.trim().match(/^\[(asset|mask|media|encoded-vibe|precise|resolved):([^\]]+)\]$/i);
    if (marker) {
      const kind = marker[1].toLowerCase();
      const detail = marker[2].toLowerCase() === 'resolved'
        ? '已分流到本地输入资产'
        : '资产引用（需本机存在对应资产）';
      return kind === 'mask' ? `Mask ${detail}` : `图片 ${detail}`;
    }
    const bytes = estimateEmbeddedBytes(value);
    return bytes ? `图片数据（${formatBytes(bytes)}，已分流）` : '未保存原图';
  }
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  if (Array.isArray(value)) return `数组（${value.length} 项）`;
  if (typeof value === 'object') return `结构化对象（${Object.keys(value).length} 个字段）`;
  return String(value);
}

const INSPECT_OPERATION_LABELS = Object.freeze({
  text: '文生图',
  img2img: '图生图',
  image2image: '图生图',
  imagetoimage: '图生图',
  enhance: '官方 Enhance',
  inpaint: '局部重绘',
  upscale: '官方 Upscale',
  director: 'Director 工具'
});

function inspectionOperationLabel(data) {
  const recovery = data?.imageRecovery || {};
  const metadata = data?.workflowMetadata || {};
  const workflow = data?.imageWorkflow || {};
  const operation = String(recovery.operation || metadata.operation || data?.operation || workflow.mode || 'text')
    .trim().toLowerCase().replace(/[\s_-]+/g, '');
  const resolvedMode = workflowModeForState(data);
  if (resolvedMode === 'unknown') return '待确认';
  if (resolvedMode === 'enhance') return '官方 Enhance';
  if (resolvedMode === 'upscale') return '官方 Upscale';
  if (resolvedMode === 'inpaint') return '局部重绘';
  if (resolvedMode === 'img2img') return '图生图';
  if (resolvedMode === 'director') return 'Director 工具';
  return String(recovery.label || '').trim() || INSPECT_OPERATION_LABELS[operation] || '文生图';
}

function inspectionInputStatus(data) {
  const recovery = data?.imageRecovery || {};
  const metadata = data?.workflowMetadata || {};
  const operation = String(recovery.operation || metadata.operation || data?.operation || data?.imageWorkflow?.mode || 'text')
    .trim().toLowerCase().replace(/[\s_-]+/g, '');
  const status = String(recovery.status || '').trim().toLowerCase();
  const sourceStatuses = [recovery.source?.status, recovery.sourceStatus, metadata.sourceStatus, data?.embeddedInputImage?.status]
    .map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
  const maskStatuses = [recovery.mask?.status, recovery.maskStatus, metadata.maskStatus, data?.embeddedMaskImage?.status]
    .map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
  const sourceStatus = sourceStatuses.includes('embedded') ? 'embedded'
    : sourceStatuses.includes('too-large') ? 'too-large'
      : sourceStatuses.includes('unresolved') ? 'unresolved' : sourceStatuses[0] || '';
  const maskStatus = maskStatuses.includes('embedded') ? 'embedded'
    : maskStatuses.includes('too-large') ? 'too-large'
      : maskStatuses.includes('unresolved') ? 'unresolved' : maskStatuses[0] || '';
  const hasMask = maskStatus === 'embedded' || data?.embeddedMaskImage?.status === 'embedded';

  if (recovery.ambiguous === true || metadata.ambiguous === true) {
    return { text: '工作流未确认：文生图标记与输入图信息冲突，请手动选择', tone: 'warning', status: 'ambiguous' };
  }
  if (operation === 'unknown') {
    return { text: '请求类型未识别，请手动选择工作流', tone: 'warning', status: status || 'unresolved' };
  }
  if (operation === 'director' && String(data?.imageTool?.reqType || '').toLowerCase() === 'unknown') {
    return { text: 'Director 工具类型未识别', tone: 'warning', status: status || 'unresolved' };
  }

  // Some dedicated Upscale outputs retain the input PNG's old Comment. If
  // that stale record still says Text2Image but carries embedded media, do
  // not silently call it Upscale (or restore it as Img2Img); show the
  // ambiguity so the user can choose the workflow explicitly.
  if (operation === 'text' && ['embedded', 'too-large', 'unresolved', 'upload-failed'].includes(sourceStatus)) {
    return { text: '记录标为文生图但含输入图，可能是旧元数据；如需 Upscale 请手动确认', tone: 'warning', status: 'ambiguous' };
  }

  if (operation !== 'text' && (status === 'ready' || sourceStatus === 'embedded' && (operation !== 'inpaint' || maskStatus === 'embedded'))) {
    const operationLabel = data?.imageWorkflow?.enhance === true ? 'Enhance 原图' : operation === 'upscale' ? 'Upscale 输入图' : '原图';
    return { text: hasMask ? `已嵌入${operationLabel} + Mask，可恢复` : `已嵌入${operationLabel}，可恢复`, tone: 'ready', status: status || 'ready' };
  }
  if (operation === 'text' || status === 'none') return { text: '无需输入图', tone: 'neutral', status: status || 'none' };
  if (status === 'unresolved' || sourceStatus === 'unresolved' || maskStatus === 'unresolved') {
    return { text: '只有资产引用', tone: 'warning', status: status || 'unresolved' };
  }
  if (status === 'too-large' || sourceStatus === 'too-large' || maskStatus === 'too-large') {
    return { text: '嵌入图超过 16 MB', tone: 'warning', status: status || 'too-large' };
  }
  if (status === 'upload-failed') return { text: '恢复上传失败', tone: 'warning', status };
  return { text: '未随记录保存', tone: 'warning', status: status || 'missing' };
}

// The parameter view (1.8.5). Names follow NovelAI's own web UI so a record reads the same as the
// generator it came from; each gets one short Chinese gloss. Prompt texts are shown once above, so they
// are not repeated as rows; every field this table does not explain is listed under 其他记录.

const INSPECT_ON_OFF = value => (value === true || Number(value) > 0 ? '开' : '关');
const INSPECT_SAMPLER_LABELS = new Map(Object.values(SAMPLING_PROFILES).flatMap(profile => profile.samplers));
const INSPECT_SCHEDULE_LABELS = new Map([...Object.values(SAMPLING_PROFILES).flatMap(profile => profile.schedules), ['native', 'Native']]);
const INSPECT_PARAMETERS = [
  // [raw keys, NovelAI name, gloss, format(value, raw), shown(data, value)]
  [['steps'], 'Steps', '步数'],
  [['scale'], 'Prompt Guidance', '提示词引导'],
  [['cfg_rescale'], 'Prompt Guidance Rescale', '引导重缩放'],
  [['sampler'], 'Sampler', '采样器', value => INSPECT_SAMPLER_LABELS.get(value) || value],
  [['noise_schedule'], 'Noise Schedule', '噪声调度', value => INSPECT_SCHEDULE_LABELS.get(value) || value],
  [['skip_cfg_above_sigma'], 'Variety+', '多样性增强', value => (Number(value) > 0 ? '开' : '关')],
  [['qualityToggle', 'quality_toggle'], 'Add Quality Tags', '自动加质量词', INSPECT_ON_OFF],
  [['ucPreset', 'uc_preset'], 'UC Preset', '负面预设'],
  // V3-only switches: shown for V3 images, or when a record has one switched on.
  [['sm'], 'SMEA', '仅 V3', INSPECT_ON_OFF, (data, value) => /diffusion-3/.test(String(data?.model || '')) || value === true],
  [['sm_dyn'], 'DYN', '仅 V3', INSPECT_ON_OFF, (data, value) => /diffusion-3/.test(String(data?.model || '')) || value === true],
  // Also restored into editor controls (and sent): Brownian Noise, the Euler Ancestral fix, 原生透明.
  [['prefer_brownian'], 'Brownian Noise', '布朗噪声', INSPECT_ON_OFF],
  [['deliberate_euler_ancestral_bug'], 'Euler Ancestral Bug', '保留旧版 Euler A 行为', INSPECT_ON_OFF],
  [['straight_alpha', 'tag_hint_transparent_background'], 'Transparent Background', '原生透明', (value, raw) => INSPECT_ON_OFF(raw.straight_alpha === true || raw.tag_hint_transparent_background === true)]
];
// Restored as advanced parameters and sent with every generation (params.advancedOverrides).
const INSPECT_ADVANCED_NAMES = Object.freeze({
  dynamic_thresholding: ['Decrisper', '防过饱和', INSPECT_ON_OFF],
  controlnet_condition: ['ControlNet Condition', 'ControlNet 条件'],
  controlnet_model: ['ControlNet Model', 'ControlNet 模型'],
  controlnet_strength: ['ControlNet Strength', 'ControlNet 强度']
});
// Recorded only: restoring never uses them. Named as NovelAI does where it has a name.
const INSPECT_RECORD_NAMES = Object.freeze({
  uncond_scale: ['Undesired Content Strength', value => `${Math.round(Number(value) * 100)}%`],
  legacy: ['Legacy Prompt Parsing'], legacy_v3_extend: ['Legacy V3 Extend'], params_version: ['Params Version'],
  signed_hash: ['Signature', () => '已签名'], request_type: ['Request Type'], strength: ['Strength'], noise: ['Noise'],
  add_original_image: ['Add Original Image'], extra_noise_seed: ['Extra Noise Seed']
});
const INSPECT_WORKFLOW_PARAMETERS = [
  [['strength'], 'Strength', '图生图强度'],
  [['noise'], 'Noise', '图生图噪声'],
  [['request_type'], 'Request Type', '请求类型', value => (value === 'NativeInfilling' ? 'Inpaint（局部重绘）' : value)],
  [['enhance'], 'Enhance', '官方增强', INSPECT_ON_OFF],
  [['enhance_upscale_factor'], 'Upscale Amount', '放大倍数', value => `${value}×`],
  [['upscaled_width', 'upscaled_height'], 'Upscaled Size', '放大后尺寸', (value, raw) => `${raw.upscaled_width ?? '—'} × ${raw.upscaled_height ?? '—'}`],
  [['target_width', 'target_height'], 'Target Size', '目标尺寸', (value, raw) => `${raw.target_width ?? '—'} × ${raw.target_height ?? '—'}`],
  [['declared_blur_sigma'], 'Blur', '模糊']
];
// Shown above (prompts, size) or meaningless here (always one image per request).
const INSPECT_SHOWN_ELSEWHERE = new Set(['prompt', 'negative_prompt', 'uc', 'v4_prompt', 'v4_negative_prompt', 'width', 'height', 'seed', 'n_samples', 'characterprompts']);
const INSPECT_VIBE_KEYS = ['reference_image_multiple', 'reference_strength_multiple', 'reference_information_extracted_multiple'];
const INSPECT_PRECISE_KEYS = ['director_reference_images', 'director_reference_descriptions', 'director_reference_strength_values', 'director_reference_information_extracted', 'director_reference_secondary_strength_values'];

function inspectParameterRows(raw, table, data) {
  const used = new Set(), rows = [];
  for (const [keys, name, gloss, format, shown] of table) {
    const key = keys.find(candidate => Object.hasOwn(raw, candidate));
    if (!key || raw[key] == null) continue;
    for (const candidate of keys) used.add(candidate);
    // Restored either way; hidden only when it means nothing for this image (SMEA / DYN outside V3).
    if (shown && !shown(data, raw[key])) continue;
    rows.push({ name, gloss, value: format ? format(raw[key], raw) : String(raw[key]) });
  }
  return { rows, used };
}
function inspectListLine(values) { return (Array.isArray(values) ? values : [values]).map(value => Number.isFinite(Number(value)) ? Number(value) : value).join(' / '); }

function renderInspectionFieldMap(data) {
  if (!els.inspectFieldMap) return;
  const raw = data?.rawParameters && typeof data.rawParameters === 'object' && !Array.isArray(data.rawParameters) ? data.rawParameters : {};
  const generation = inspectParameterRows(raw, INSPECT_PARAMETERS, data);
  // NovelAI stores strength / noise / request type on every record; for text-to-image they say nothing,
  // so the workflow table appears only for an image workflow (they stay under 其他记录 otherwise).
  const imageWorkflow = inspectionOperationLabel(data) !== '文生图';
  const workflow = imageWorkflow ? inspectParameterRows(raw, INSPECT_WORKFLOW_PARAMETERS, data) : { rows: [], used: new Set() };
  const used = new Set([...generation.used, ...workflow.used]);
  // Vibe Transfer / Precise Reference: one line each, counts and per-image values.
  const vibes = Array.isArray(raw.reference_image_multiple) ? raw.reference_image_multiple.length : 0;
  // Empty reference lists carry nothing; they are not listed.
  if (Array.isArray(raw.reference_image_multiple) && !vibes) for (const key of INSPECT_VIBE_KEYS) used.add(key);
  if (Array.isArray(raw.director_reference_images) && !raw.director_reference_images.length) for (const key of INSPECT_PRECISE_KEYS) used.add(key);
  if (vibes) {
    workflow.rows.push({ name: 'Vibe Transfer', gloss: '氛围参考', value: `${vibes} 张 · 强度 ${inspectListLine(raw.reference_strength_multiple || [])} · 信息提取 ${inspectListLine(raw.reference_information_extracted_multiple || [])}` });
    for (const key of INSPECT_VIBE_KEYS) used.add(key);
  }
  const precise = Array.isArray(raw.director_reference_images) ? raw.director_reference_images.length : 0;
  if (precise) {
    workflow.rows.push({ name: 'Precise Reference', gloss: '精准参考', value: `${precise} 张 · 强度 ${inspectListLine(raw.director_reference_strength_values || [])}` });
    for (const key of INSPECT_PRECISE_KEYS) used.add(key);
  }
  for (const key of INSPECT_MEDIA_KEYS) if (Object.hasOwn(raw, key)) {
    workflow.rows.push({ name: key === 'mask' || key === 'mask_image' ? 'Mask' : 'Base Image', gloss: key.includes('mask') ? '重绘区域' : '输入原图', value: inspectValueSummary(key, raw[key]) });
    used.add(key);
  }
  const compactKey = key => String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  const advanced = Object.entries(data?.params?.advancedOverrides || {}).map(([key, value]) => {
    const [name, gloss = '', format] = INSPECT_ADVANCED_NAMES[key] || [key, '高级参数'];
    for (const rawKey of Object.keys(raw)) if (compactKey(rawKey) === compactKey(key)) used.add(rawKey);
    return { name, gloss, value: format ? format(value) : inspectValueSummary(key, value) };
  });
  const others = Object.entries(raw).filter(([key]) => !used.has(key) && !INSPECT_SHOWN_ELSEWHERE.has(key.toLowerCase()));
  const table = rows => `<div class="inspect-param-table">${rows.map(row => `<div class="inspect-param-row"><span><b>${escapeHtml(row.name)}</b><small>${escapeHtml(row.gloss)}</small></span><code>${escapeHtml(row.value)}</code></div>`).join('')}</div>`;
  const parts = [];
  if (generation.rows.length) parts.push(`<section><h3>生成参数<small>恢复后写入编辑器</small></h3>${table(generation.rows)}</section>`);
  if (advanced.length) parts.push(`<section><h3>高级参数<small>恢复后随生成发送</small></h3>${table(advanced)}</section>`);
  if (workflow.rows.length) parts.push(`<section><h3>${imageWorkflow ? '图像工作流' : '参考图'}<small>${escapeHtml(inspectionOperationLabel(data))}</small></h3>${table(workflow.rows)}</section>`);
  if (others.length) {
    parts.push(`<details class="inspect-other"><summary>不会恢复 · ${others.length} 项<small>只作记录，恢复参数时不使用</small></summary><div class="inspect-other-list">${
      others.map(([key, value]) => {
        const [name, format] = INSPECT_RECORD_NAMES[key] || [];
        return `<div><span class="inspect-other-name">${name ? `${escapeHtml(name)} <code>${escapeHtml(key)}</code>` : `<code>${escapeHtml(key)}</code>`}</span><span>${escapeHtml(format ? format(value) : inspectValueSummary(key, value))}</span></div>`;
      }).join('')}</div></details>`);
  }
  if (!parts.length) parts.push('<p class="inspect-field-note">这张图没有 NovelAI 生成参数记录。</p>');
  els.inspectFieldMap.innerHTML = parts.join('');
}

function showInspection(data, file) {
  currentInspection = data;
  els.inspectActionStatus?.classList.add('hidden');
  if (currentInspectionObjectUrl) URL.revokeObjectURL(currentInspectionObjectUrl);
  currentInspectionObjectUrl = URL.createObjectURL(file);
  els.inspectPreview.src = currentInspectionObjectUrl;
  els.inspectSourceLabel.textContent = ({
    'png-text': 'PNG 文本元数据',
    'stealth': 'Alpha 隐写元数据',
    'png-text+stealth': 'PNG 文本 + Alpha 隐写元数据',
    'webp-exif': 'WebP EXIF 元数据',
    'webp-exif+stealth': 'WebP EXIF + Alpha 隐写元数据',
    'jpeg-exif': 'JPEG EXIF 元数据'
  })[data.metadataSource] || data.metadataSource || 'PNG metadata';
  const characterCount = Array.isArray(data.characters) ? data.characters.length : 0;
  // Keep the compact metadata rows in lockstep with the semantic summary
  // below.  In particular, a stale Text2Image Comment that still contains an
  // embedded source must be shown as "待确认", not as a harmless text record
  // with an apparently absent input image.
  const inspectedOperationLabel = inspectionOperationLabel(data);
  const inspectedInput = inspectionInputStatus(data);
  const modelName = data.modelDetected === false ? '未识别' : ($("#model")?.querySelector(`option[value="${CSS.escape(String(data.model || ''))}"]`)?.textContent || data.model || '未识别');
  const facts = [
    ['模型', modelName, data.modelDetected === false ? '恢复时保持当前模型' : ''],
    ['工作流', inspectedOperationLabel, inspectedInput.status === 'none' ? '' : inspectedInput.text],
    ['尺寸', `${data.params?.width || data.width || '—'} × ${data.params?.height || data.height || '—'}`, ''],
    ['Seed', Number.isFinite(Number(data.seed)) ? String(data.seed) : '—', ''],
    ...(characterCount ? [['角色', `${characterCount} 位`, '']] : []),
    ['来源', [data.software, els.inspectSourceLabel.textContent].filter(Boolean).join(' · '), '']
  ];
  els.inspectSummary.innerHTML = facts.map(([label, value, note]) => `<div class="inspect-fact${note && inspectedInput.tone === 'warning' && label === '工作流' ? ' is-warning' : ''}"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b>${note ? `<small>${escapeHtml(note)}</small>` : ''}</div>`).join('');
  if (els.inspectPrompts) {
    const block = (label, text) => text ? `<div class="inspect-prompt"><span>${escapeHtml(label)}</span><p>${escapeHtml(text)}</p></div>` : '';
    els.inspectPrompts.innerHTML = [
      block('Prompt', data.prompt || data.description),
      block('Undesired Content', data.negativePrompt),
      ...(Array.isArray(data.characters) ? data.characters : []).map((character, index) =>
        block(`角色 ${index + 1}${character.name && character.name !== `角色 ${index + 1}` ? ` · ${character.name}` : ''}`, [character.prompt, character.uc ? `UC：${character.uc}` : ''].filter(Boolean).join('\n')))
    ].join('');
  }
  const hasRawParameters = Boolean(data.rawParameters && Object.keys(data.rawParameters).length);
  renderInspectionFieldMap(data);
  els.inspectRawParameters.textContent = JSON.stringify(redactRawParameters(data.rawParameters || {}), null, 2);
  const restoreAllButton = $('#inspectRestoreAll');
  if (restoreAllButton) {
    restoreAllButton.disabled = !hasRawParameters;
    restoreAllButton.textContent = hasRawParameters ? '恢复全部参数' : '没有完整参数';
  }
  const warnings = Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [];
  els.inspectWarnings.classList.toggle('hidden', !warnings.length);
  els.inspectWarnings.innerHTML = warnings.map(item => `<p>${escapeHtml(item)}</p>`).join('');
  // Inspection is a normal application dialog.  It must not inherit the
  // tutorial's non-modal stacking mode or move the tutorial card into it.
  els.inspectDialog?.showModal();
}

async function inspectImageFile(file) {
  if (!file) return;
  if (inspectBusy) return;
  // PNG, WebP and JPEG all get a real read; the server says plainly when a picture has no parameters.
  if (!/^image\/(png|webp|jpe?g)$/.test(file.type || '') && !/\.(png|webp|jpe?g)$/i.test(file.name || '')) throw new Error('只支持 PNG / WebP / JPEG 图片。');
  inspectBusy = true;
  if (els.inspectImageFile) els.inspectImageFile.disabled = true;
  const restoreLabel = els.restoreToolLabel;
  const restoreDefaultLabel = restoreLabel?.dataset.defaultLabel || restoreLabel?.textContent || '恢复';
  if (restoreLabel) restoreLabel.dataset.defaultLabel = restoreDefaultLabel;
  if (els.restoreToolButton) {
    els.restoreToolButton.disabled = true;
    els.restoreToolButton.classList.add('is-loading');
    els.restoreToolButton.setAttribute('aria-busy', 'true');
  }
  const startedAt = Date.now();
  const updateRestoreStatus = () => {
    const seconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    if (restoreLabel) restoreLabel.textContent = `读取中 · ${seconds} 秒`;
  };
  updateRestoreStatus();
  if (inspectStatusTimer) clearInterval(inspectStatusTimer);
  inspectStatusTimer = setInterval(updateRestoreStatus, 700);
  try {
    const response = await fetch('/api/inspect-image', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      body: file
    });
    let data = null;
    try { data = await response.json(); } catch {}
    if (isAppUnauthenticated(response.status, data)) {
      showLogin();
      throw new Error('登录已失效。');
    }
    if (!response.ok) throw new Error(data?.error || response.statusText || '图片参数读取失败。');
    showInspection(data, file);
  } catch (error) {
    throw error;
  } finally {
    if (inspectStatusTimer) { clearInterval(inspectStatusTimer); inspectStatusTimer = 0; }
    inspectBusy = false;
    if (els.inspectImageFile) els.inspectImageFile.disabled = false;
    if (els.restoreToolButton) {
      els.restoreToolButton.disabled = false;
      els.restoreToolButton.classList.remove('is-loading');
      els.restoreToolButton.removeAttribute('aria-busy');
    }
    if (restoreLabel) restoreLabel.textContent = restoreDefaultLabel;
  }
}

async function restoreInspection(restoreAll) {
  if (!currentInspection || restoreBusy) return;
  restoreBusy = true;
  const promptButton = $('#inspectPromptOnly');
  const restoreButton = $('#inspectRestoreAll');
  if (promptButton) promptButton.disabled = true;
  if (restoreButton) restoreButton.disabled = true;
  const status = els.inspectActionStatus;
  if (status) {
    status.classList.remove('hidden');
    status.textContent = restoreAll && currentInspection.embeddedInputImage?.status === 'embedded'
      ? '正在把记录里的输入图片保存为本地工作流资产…'
      : restoreAll ? '正在整理导入参数…' : '正在恢复 Prompt / UC…';
  }
  let succeeded = false;
  try {
    const state = withCurrentGenerationRoute(stateFromInspection(currentInspection, restoreAll));
    const workflowWarnings = restoreAll ? await attachImportedWorkflowAssets(state, currentInspection, {
      onProgress: message => { if (status) status.textContent = message; }
    }) : [];
    hydrateState(state);
    closeInspectDialog();
    switchTabTo('editor');
    if (workflowWarnings.length) toast(workflowWarnings.join(' '), 'error');
    else if (restoreAll && state.imageRecovery?.status === 'missing') toast(state.imageRecovery.reason, 'error');
    else toast(restoreAll ? '已从 PNG 恢复 Prompt、角色、UC、Seed、生成参数与工作流意图。' : '已从 PNG 恢复 Prompt、角色与 UC。', 'success');
    succeeded = true;
  } catch (error) {
    if (status) {
      status.classList.remove('hidden');
      status.textContent = `恢复失败：${error?.message || error}`;
    }
    throw error;
  } finally {
    restoreBusy = false;
    if (succeeded) status?.classList.add('hidden');
    if (promptButton) promptButton.disabled = false;
    if (restoreButton) restoreButton.disabled = !currentInspection || !currentInspection.rawParameters || !Object.keys(currentInspection.rawParameters).length;
  }
}

function updateGallerySelectionUi() {
  const selected = selectedGalleryIds.size;
  if (els.galleryCleanupToggle) {
    els.galleryCleanupToggle.textContent = galleryCleanupMode ? '退出清理' : '清理模式';
    els.galleryCleanupToggle.classList.toggle('active', galleryCleanupMode);
    els.galleryCleanupToggle.setAttribute('aria-pressed', String(galleryCleanupMode));
  }
  els.imageDialog?.classList.toggle('cleanup-mode', galleryCleanupMode);
  els.cleanupActionBar?.classList.toggle('hidden', !galleryCleanupMode);
  els.cleanupJumpControls?.classList.toggle('hidden', !galleryCleanupMode);
  els.cleanupFavoriteButton?.classList.toggle('hidden', !galleryCleanupMode);
  [els.favoriteOnly, els.gallerySearch, els.galleryAgeFilter, els.galleryMonthFilter, els.galleryDateFrom, els.galleryDateTo, els.galleryNewImagesButton].filter(Boolean).forEach(control => { control.disabled = galleryCleanupMode || gallerySelectionMode; });
  if (els.imageDialogTitle) els.imageDialogTitle.textContent = galleryCleanupMode ? '清理' : '图片详情';
  els.gallerySelectAll?.classList.toggle('hidden', !gallerySelectionMode);
  els.gallerySelectNonFavorites?.classList.toggle('hidden', !gallerySelectionMode);
  els.galleryClearSelection?.classList.toggle('hidden', !gallerySelectionMode);
  els.galleryDeleteSelected?.classList.toggle('hidden', !gallerySelectionMode);
  els.gallerySelectionText?.classList.toggle('hidden', !gallerySelectionMode);
  els.galleryExitSelection?.classList.toggle('hidden', !gallerySelectionMode);
  if (els.gallerySelectionText) els.gallerySelectionText.textContent = `已选择 ${selected} 张`;
  if (els.gallerySelectToggle) {
    els.gallerySelectToggle.textContent = gallerySelectionMode ? '退出批量选择' : '批量选择';
    els.gallerySelectToggle.classList.toggle('active', gallerySelectionMode);
    els.gallerySelectToggle.setAttribute('aria-pressed', String(gallerySelectionMode));
  }
  els.galleryGrid?.classList.toggle('selection-mode', gallerySelectionMode);
  document.querySelectorAll('.gallery-card').forEach(card => {
    const selectedNow = selectedGalleryIds.has(card.dataset.galleryId);
    card.classList.toggle('selected', selectedNow);
    const check = card.querySelector('.gallery-check');
    if (check) {
      check.classList.toggle('hidden', !gallerySelectionMode);
      check.textContent = selectedNow ? '✓' : '○';
    }
  });
  syncCleanupControls();
}

function restoreCleanupDeletedSummary(pending) {
  if (!pending?.image || loadedGalleryImage(pending.image.id)) return;
  const index = Math.max(0, Math.min(Number(pending.index) || 0, loadedGalleryImages.length));
  loadedGalleryImages.splice(index, 0, pending.image);
  galleryLoaded = loadedGalleryImages.length;
  galleryTotal += 1;
  els.galleryGrid.classList.remove('empty-state');
  rebuildGalleryMasonry();
  els.loadMoreButton.classList.toggle('hidden', !galleryHasMore);
  if (pending.wasLatest || (galleryWindowStart === 0 && index === 0)) renderQuickLatest(loadedGalleryImages[0] || null);
  updateGallerySelectionUi();
  syncDialogNavigation();
}

function scheduleCleanupDeleteCommit() {
  if (cleanupCommitTimer) clearTimeout(cleanupCommitTimer);
  cleanupCommitTimer = 0;
  if (!cleanupPendingDeletes.length) return;
  if (cleanupPendingDeletes.length >= CLEANUP_BATCH_SIZE) {
    commitPendingCleanupDeletes();
    return;
  }
  cleanupCommitTimer = window.setTimeout(() => {
    cleanupCommitTimer = 0;
    commitPendingCleanupDeletes();
  }, CLEANUP_COMMIT_DELAY_MS);
}

function commitPendingCleanupDeletes() {
  if (cleanupCommitTimer) clearTimeout(cleanupCommitTimer);
  cleanupCommitTimer = 0;
  if (!cleanupPendingDeletes.length) return null;
  const batch = cleanupPendingDeletes.splice(0, CLEANUP_BATCH_SIZE);
  const ids = batch.map(item => item.image.id);
  cleanupInFlightCount += batch.length;
  syncCleanupControls();
  const request = api('/api/images/batch-delete', { method: 'POST', body: { ids } })
    .then(result => {
      cleanupSessionCommitted += batch.length;
      if (result.resources) renderResourceStatus(result.resources);
      if (batch.some(item => item.wasLatest)) renderQuickLatest(result.latestImage || null);
      // Counts the examples that went with these images and refreshes the artist library;
      // syncCleanupControls in finally() then repaints the session line.
      noteGalleryExamplesDeleted(result);
    })
    .catch(error => {
      for (const pending of [...batch].reverse()) restoreCleanupDeletedSummary(pending);
      cleanupSessionDeleted = Math.max(0, cleanupSessionDeleted - batch.length);
      toast(`有 ${batch.length} 张删除失败，已放回原位置：${error.message}`, 'error');
    })
    .finally(() => {
      cleanupInFlightCount = Math.max(0, cleanupInFlightCount - batch.length);
      cleanupDeleteRequests.delete(request);
      syncCleanupControls();
      if (cleanupPendingDeletes.length) scheduleCleanupDeleteCommit();
    });
  cleanupDeleteRequests.add(request);
  return request;
}

function stageCleanupDelete(image, index, wasLatest) {
  cleanupPendingDeletes.push({ image, index, wasLatest });
  cleanupSessionDeleted += 1;
  scheduleCleanupDeleteCommit();
  syncCleanupControls();
}

async function undoCleanupDelete() {
  const pending = cleanupPendingDeletes.pop();
  if (!pending) return;
  restoreCleanupDeletedSummary(pending);
  cleanupSessionDeleted = Math.max(0, cleanupSessionDeleted - 1);
  scheduleCleanupDeleteCommit();
  syncCleanupControls();
  toast('已撤销上一张删除。', 'success');
}

async function settleCleanupDeletes() {
  if (cleanupCommitTimer) clearTimeout(cleanupCommitTimer);
  cleanupCommitTimer = 0;
  if (cleanupDeleteRequests.size) await Promise.allSettled([...cleanupDeleteRequests]);
  while (cleanupPendingDeletes.length) {
    const pendingRequest = commitPendingCleanupDeletes();
    if (!pendingRequest) break;
    await Promise.allSettled([pendingRequest]);
  }
}

async function setGalleryCleanupMode(enabled) {
  const next = Boolean(enabled);
  if (next === galleryCleanupMode) return;
  if (next) {
    if (galleryFilterTimer) clearTimeout(galleryFilterTimer);
    galleryFilterTimer = 0;
    if (gallerySelectionMode) {
      gallerySelectionMode = false;
      selectedGalleryIds.clear();
    }
    if (!loadedGalleryImages.length) await loadGallery();
    if (!loadedGalleryImages.length) return toast('图库里还没有图片。');
    cleanupSessionKept = 0;
    cleanupSessionDeleted = 0;
    cleanupSessionCommitted = 0;
    cleanupSessionExamplesDeleted = 0;
    galleryCleanupMode = true;
    updateGallerySelectionUi();
    await openImage(loadedGalleryImages[0].id);
    return;
  }
  galleryCleanupMode = false;
  updateGallerySelectionUi();
  if (els.imageDialog?.open) els.imageDialog.close();
  await settleCleanupDeletes();
  tryAutoLoadPendingGalleryImages();
}

async function cleanupLoadOriginal() {
  if (!galleryCleanupMode || !currentImage?.originalUrl) return;
  await loadCurrentOriginal();
}

async function cleanupKeepAndNext() {
  if (!galleryCleanupMode || !currentImage) return;
  cleanupSessionKept += 1;
  syncCleanupControls();
  await navigateImageDialog(1);
}

async function cleanupJumpToPosition() {
  if (!galleryCleanupMode || !els.cleanupJumpInput) return;
  const requested = Math.trunc(Number(els.cleanupJumpInput.value));
  if (!Number.isFinite(requested) || requested < 1 || requested > Math.max(galleryTotal, loadedGalleryImages.length)) {
    return toast(`请输入 1–${Math.max(galleryTotal, loadedGalleryImages.length)}。`, 'error');
  }
  const targetIndex = requested - 1;
  let localIndex = targetIndex - galleryWindowStart;
  if (localIndex < 0 || localIndex >= loadedGalleryImages.length) {
    await loadGalleryWindow(targetIndex);
    localIndex = targetIndex - galleryWindowStart;
  }
  const target = loadedGalleryImages[localIndex];
  if (!target) return toast('没有找到这一张，图库可能刚刚发生了变化。', 'error');
  await openImage(target.id);
}

async function deleteCleanupCurrentImage() {
  if (!galleryCleanupMode || !currentImage) return;
  const deleting = { ...currentImage };
  const oldIndex = loadedGalleryIndex(deleting.id);
  const wasLatest = $('#quickLatest')?.dataset.imageId === deleting.id;
  const replacement = loadedGalleryImages[oldIndex + 1] || loadedGalleryImages[oldIndex - 1] || null;
  let windowFallback = null;

  removeGalleryCard(deleting.id);
  currentImage = null;
  stageCleanupDelete(deleting, oldIndex, wasLatest);
  if (wasLatest) renderQuickLatest(loadedGalleryImages[0] || null);

  if (replacement) {
    await openImage(replacement.id);
  } else if (galleryTotal > 0) {
    if (galleryHasMore) {
      await settleCleanupDeletes();
      await loadGallery();
    } else if (galleryWindowStart > 0) {
      windowFallback = await loadGalleryWindow(Math.min(galleryTotal - 1, galleryWindowStart - 1));
    }
    const fallback = windowFallback || loadedGalleryImages[Math.min(oldIndex, loadedGalleryImages.length - 1)] || loadedGalleryImages[0];
    if (fallback) await openImage(fallback.id);
    else await setGalleryCleanupMode(false);
  } else {
    await setGalleryCleanupMode(false);
  }
  syncCleanupControls();
}

function toggleGallerySelection(id) {
  if (selectedGalleryIds.has(id)) selectedGalleryIds.delete(id);
  else selectedGalleryIds.add(id);
  updateGallerySelectionUi();
}

function loadedGalleryIndex(id) {
  return loadedGalleryImages.findIndex(item => item.id === id);
}

function loadedGalleryImage(id) {
  return loadedGalleryImages.find(item => item.id === id) || null;
}

function removeGalleryCard(id) {
  detachGalleryCard(id);
  const index = loadedGalleryIndex(id);
  if (index >= 0) loadedGalleryImages.splice(index, 1);
  galleryLoaded = loadedGalleryImages.length;
  selectedGalleryIds.delete(id);
  imageDetailCache.delete(id);
  const previewEntry = imagePreviewCache.get(id);
  previewEntry?.controller?.abort();
  if (previewEntry?.url) URL.revokeObjectURL(previewEntry.url);
  imagePreviewCache.delete(id);
  galleryTotal = Math.max(0, galleryTotal - 1);
  if (!els.galleryGrid.querySelector('.gallery-card')) {
    if (galleryTotal === 0) {
      els.galleryGrid.textContent = galleryEmptyMessage();
      els.galleryGrid.classList.add('empty-state');
    } else {
      els.galleryGrid.innerHTML = '';
      els.galleryGrid.classList.remove('empty-state');
    }
  }
  els.loadMoreButton.classList.toggle('hidden', !galleryHasMore);
  renderGalleryResultSummary();
  updateGallerySelectionUi();
  syncDialogNavigation();
}

async function refillGalleryIfNeeded() {
  if (els.galleryGrid.querySelector('.gallery-card') || galleryTotal <= 0) return;
  if (galleryHasMore) await loadGallery();
  else if (galleryWindowStart > 0) await loadGalleryWindow(galleryTotal - 1);
}

async function refreshQuickLatestOnly() {
  try {
    // "最新生成结果" always means deliberate work: a rotation sample must never
    // take over the latest-result chip, whichever gallery view is open.
    const data = await api('/api/images?offset=0&limit=1&favorite=0&kind=gallery');
    renderQuickLatest(data.images?.[0] || null);
  } catch {}
}

function applyGalleryDeleteResult(result, { updateLatest = false } = {}) {
  if (result?.resources) renderResourceStatus(result.resources);
  if (updateLatest) renderQuickLatest(result?.latestImage || null);
  noteGalleryExamplesDeleted(result);
}

// Deleting a gallery image also deletes the artist examples copied out of it, so the
// artist library is refreshed and the removal is reported rather than silent. The count is
// returned so a caller can fold it into its own message.
function noteGalleryExamplesDeleted(result) {
  const count = Number(result?.deletedExamples) || 0;
  if (!count) return 0;
  cleanupSessionExamplesDeleted += count;
  artistLibrary?.refresh();
  return count;
}

// "（含 N 条例图）" for messages that already exist, or an empty string.
const galleryExamplesSuffix = count => (count ? `（含 ${count} 条例图及其标注）` : '');

function chunkValues(values, size = 200) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function updateGalleryFavoriteCard(id, favorite) {
  const cached = loadedGalleryImage(id);
  if (cached) cached.favorite = favorite;
  const card = document.querySelector(`[data-gallery-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.dataset.favorite = favorite ? '1' : '0';
  const button = card.querySelector('.gallery-favorite-button');
  if (button) {
    button.textContent = favorite ? '★' : '☆';
    button.classList.toggle('active', favorite);
    button.setAttribute('aria-label', favorite ? '取消收藏' : '收藏');
  }
}

function updateDialogFavoriteButton(favorite) {
  if (els.dialogFavorite) {
    els.dialogFavorite.textContent = favorite ? '★ 已收藏' : '☆ 收藏';
    els.dialogFavorite.classList.toggle('active', Boolean(favorite));
  }
  if (els.cleanupFavoriteButton) {
    els.cleanupFavoriteButton.textContent = favorite ? '★' : '☆';
    els.cleanupFavoriteButton.classList.toggle('active', Boolean(favorite));
    els.cleanupFavoriteButton.setAttribute('aria-label', favorite ? '取消收藏' : '收藏');
  }
}

function syncCleanupControls(index = currentImage ? loadedGalleryIndex(currentImage.id) : -1) {
  const total = Math.max(galleryTotal, loadedGalleryImages.length);
  els.cleanupJumpControls?.classList.toggle('hidden', !galleryCleanupMode);
  els.cleanupFavoriteButton?.classList.toggle('hidden', !galleryCleanupMode);
  if (els.imageDialogTitle) els.imageDialogTitle.textContent = galleryCleanupMode ? '清理' : '图片详情';
  if (els.cleanupJumpTotal) els.cleanupJumpTotal.textContent = String(total || 0);
  if (els.cleanupJumpInput) {
    els.cleanupJumpInput.max = String(Math.max(1, total));
    if (document.activeElement !== els.cleanupJumpInput) els.cleanupJumpInput.value = index >= 0 ? String(galleryWindowStart + index + 1) : '';
  }
  const pendingCount = cleanupPendingDeletes.length;
  if (els.cleanupUndoButton) {
    els.cleanupUndoButton.disabled = pendingCount === 0;
    els.cleanupUndoButton.textContent = pendingCount ? `撤销 ${pendingCount}` : '撤销';
  }
  if (els.cleanupSessionStatus) {
    const submitting = cleanupInFlightCount ? ` · 提交中 ${cleanupInFlightCount}` : '';
    const pending = pendingCount ? ` · 待提交 ${pendingCount}` : '';
    // Examples removed along with the images are counted here rather than toasted per
    // batch, which would be noise during a long cleanup session.
    const examples = cleanupSessionExamplesDeleted ? ` · 含例图 ${cleanupSessionExamplesDeleted}` : '';
    els.cleanupSessionStatus.textContent = `本轮 保留 ${cleanupSessionKept} · 删除 ${cleanupSessionDeleted} · 已提交 ${cleanupSessionCommitted}${examples}${pending}${submitting}`;
  }
  if (currentImage) updateDialogFavoriteButton(currentImage.favorite);
}

function syncDialogNavigation() {
  if (!els.dialogPrevious || !els.dialogNext || !els.dialogPosition) return;
  const index = currentImage ? loadedGalleryIndex(currentImage.id) : -1;
  const hasPrevious = index > 0;
  const hasKnownNext = index >= 0 && index < loadedGalleryImages.length - 1;
  const canLoadNext = index >= 0 && galleryHasMore;
  els.dialogPrevious.disabled = !hasPrevious;
  els.dialogNext.disabled = !(hasKnownNext || canLoadNext);
  els.dialogPosition.textContent = index >= 0
    ? `${galleryWindowStart + index + 1} / ${Math.max(galleryTotal, galleryWindowStart + loadedGalleryImages.length)}`
    : (currentImage ? '图库外图片' : '—');
  syncCleanupControls(index);
}

function trimImageCache(map, limit = 12) {
  while (map.size > limit) {
    const first = map.keys().next().value;
    if (first == null) break;
    map.delete(first);
  }
}

function trimPreviewCache(limit = 8) {
  if (imagePreviewCache.size <= limit) return;
  for (const [id, entry] of imagePreviewCache) {
    if (imagePreviewCache.size <= limit) break;
    if (id === currentImage?.id || entry.promise) continue;
    if (entry.url) URL.revokeObjectURL(entry.url);
    imagePreviewCache.delete(id);
  }
}

function ensurePreviewLoad(image, { foreground = false } = {}) {
  if (!image?.id || !image.previewUrl) return Promise.resolve(null);
  const existing = imagePreviewCache.get(image.id);
  if (existing) {
    imagePreviewCache.delete(image.id);
    imagePreviewCache.set(image.id, existing);
    return existing.url ? Promise.resolve(existing.url) : existing.promise;
  }
  if (foreground) {
    for (const [id, entry] of imagePreviewCache) {
      if (id === image.id || !entry.promise) continue;
      entry.controller?.abort();
      imagePreviewCache.delete(id);
    }
  }
  const controller = new AbortController();
  const entry = { controller, promise: null, url: '' };
  entry.promise = fetch(image.previewUrl, {
    credentials: 'same-origin',
    signal: controller.signal
  }).then(async response => {
    if (response.status === 401) {
      let payload = {};
      try { payload = await response.json(); } catch {}
      if (isAppUnauthenticated(response.status, payload)) showLogin();
      throw new Error(payload.error || `预览图加载失败（${response.status}）`);
    }
    if (!response.ok) throw new Error(`预览图加载失败（${response.status}）`);
    const blob = await response.blob();
    entry.url = URL.createObjectURL(blob);
    entry.promise = null;
    entry.controller = null;
    trimPreviewCache();
    return entry.url;
  }).catch(error => {
    if (imagePreviewCache.get(image.id) === entry) imagePreviewCache.delete(image.id);
    if (error?.name === 'AbortError') return null;
    throw error;
  });
  imagePreviewCache.set(image.id, entry);
  return entry.promise;
}

function cancelScheduledPreviewPrefetch() {
  if (!scheduledPreviewPrefetch) return;
  if (typeof cancelIdleCallback === 'function') cancelIdleCallback(scheduledPreviewPrefetch);
  else clearTimeout(scheduledPreviewPrefetch);
  scheduledPreviewPrefetch = 0;
}

function scheduleNextPreview(imageId) {
  cancelScheduledPreviewPrefetch();
  const run = () => {
    scheduledPreviewPrefetch = 0;
    if (currentImage?.id !== imageId) return;
    const index = loadedGalleryIndex(imageId);
    const next = index >= 0 ? loadedGalleryImages[index + 1] : null;
    if (next?.previewUrl) ensurePreviewLoad(next).catch(() => {});
  };
  scheduledPreviewPrefetch = typeof requestIdleCallback === 'function'
    ? requestIdleCallback(run, { timeout: 900 })
    : window.setTimeout(run, 300);
}

async function loadCurrentOriginal() {
  const image = currentImage;
  if (!image?.id || !image.originalUrl) return;
  cancelScheduledPreviewPrefetch();
  const buttons = [els.dialogLoadOriginal, els.cleanupLoadOriginalButton].filter(Boolean);
  for (const button of buttons) {
    button.disabled = true;
    button.textContent = button === els.dialogLoadOriginal ? '加载中' : '加载中…';
    if (button === els.dialogLoadOriginal) button.title = '正在加载高清原图';
  }
  let loaded = false;
  try {
    const loader = new Image();
    loader.decoding = 'async';
    await new Promise((resolve, reject) => {
      loader.onload = resolve;
      loader.onerror = () => reject(new Error('高清原图加载失败'));
      loader.src = image.originalUrl;
    });
    if (currentImage?.id !== image.id) return;
    els.dialogImage.src = image.originalUrl;
    els.dialogImage.classList.remove('showing-thumbnail');
    loaded = true;
  } finally {
    if (currentImage?.id === image.id) {
      for (const button of buttons) {
        button.disabled = false;
        button.textContent = loaded ? '已高清' : (button === els.cleanupLoadOriginalButton ? '高清' : '原图');
        if (button === els.dialogLoadOriginal) {
          button.title = loaded ? '当前已显示高清原图' : '加载高清原图';
          button.setAttribute('aria-label', button.title);
        }
      }
    }
  }
}

function fetchImageDetail(id) {
  if (!id) return Promise.reject(new Error('缺少图片 ID'));
  const cached = imageDetailCache.get(id);
  if (cached?.data) {
    imageDetailCache.delete(id);
    imageDetailCache.set(id, cached);
    return Promise.resolve(cached.data);
  }
  if (cached?.promise) return cached.promise;
  const entry = {};
  entry.promise = api(`/api/images/${id}`).then(data => {
    entry.data = data;
    entry.promise = null;
    imageDetailCache.delete(id);
    imageDetailCache.set(id, entry);
    trimImageCache(imageDetailCache, 16);
    return data;
  }).catch(error => {
    imageDetailCache.delete(id);
    throw error;
  });
  imageDetailCache.set(id, entry);
  trimImageCache(imageDetailCache, 16);
  return entry.promise;
}

// 全部参数: the NovelAI request rebuilt on the server for the current image; read only while
// the section is open, and again whenever the dialog moves to another image.
const dialogPayloadCache = new Map();
let dialogPayloadFor = '';
function syncDialogPayload() {
  const box = $('#dialogPayload');
  const pre = $('#dialogPayloadJson');
  const id = currentImage?.id || '';
  if (!box || !pre) return;
  if (!box.open) { dialogPayloadFor = ''; pre.textContent = '展开后读取…'; return; }
  if (!id || dialogPayloadFor === id) return;
  dialogPayloadFor = id;
  const cached = dialogPayloadCache.get(id);
  if (cached) { pre.textContent = cached; return; }
  pre.textContent = '正在读取…';
  api(`/api/images/${encodeURIComponent(id)}/payload`).then(payload => {
    const text = JSON.stringify(payload, null, 2);
    dialogPayloadCache.set(id, text);
    if (dialogPayloadCache.size > 30) dialogPayloadCache.delete(dialogPayloadCache.keys().next().value);
    if (dialogPayloadFor === id) pre.textContent = text;
  }).catch(error => { if (dialogPayloadFor === id) { pre.textContent = `读取失败：${error.message}`; dialogPayloadFor = ''; } });
}

function renderDialogMetadata(image, detailReady = true) {
  const state = detailReady ? (image.params || {}) : {};
  els.dialogMeta.innerHTML = [
    ['时间', image.created_at ? formatDate(image.created_at) : '正在读取…'],
    ['Seed', image.seed ?? '—'],
    ['尺寸', image.width && image.height ? `${image.width}×${image.height}` : '—'],
    ['模型', detailReady ? (state.model || '—') : '正在读取…'],
    ['参数', detailReady && state.params ? `${state.params.steps} Steps · CFG ${state.params.scale} · ${state.params.sampler} · ${state.params.noiseSchedule}` : (detailReady ? '—' : '正在读取…')],
    ['Prompt', image.prompt || '—'],
    ['Undesired Content', image.negative_prompt || '—']
  ].map(([label, value]) => `<div class="meta-row"><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></div>`).join('');
  syncDialogPayload();
  $('#dialogReuse').disabled = !detailReady || !image.params;
  $('#dialogReuseMenu').disabled = !detailReady || !image.params;
  $('#dialogSaveScheme').disabled = !detailReady || !image.params;
  $('#dialogRegenerate').disabled = !detailReady || !image.params;
}

function showDialogImageInstant(image, { loadPreview = true, detailReady = Boolean(image?.params) } = {}) {
  if (!image) return;
  cancelScheduledPreviewPrefetch();
  currentImage = image;
  const thumb = image.thumbUrl || '';
  const preview = image.previewUrl || '';
  const original = image.originalUrl || '';
  if (thumb) {
    els.dialogImage.src = thumb;
    els.dialogImage.classList.add('showing-thumbnail');
  } else if (original) {
    els.dialogImage.src = original;
  }
  if (els.dialogDownload) els.dialogDownload.disabled = !original;
  if (els.dialogLoadOriginal) {
    els.dialogLoadOriginal.disabled = !original;
    els.dialogLoadOriginal.textContent = '原图';
    els.dialogLoadOriginal.title = original ? '加载高清原图' : '没有可用原图';
    els.dialogLoadOriginal.setAttribute('aria-label', els.dialogLoadOriginal.title);
  }
  if (els.cleanupLoadOriginalButton) {
    els.cleanupLoadOriginalButton.disabled = !original;
    els.cleanupLoadOriginalButton.textContent = '高清';
  }
  els.dialogNote.value = image.note || '';
  updateDialogFavoriteButton(image.favorite);
  renderDialogMetadata(image, detailReady);
  syncDialogNavigation();
  if (!els.imageDialog.open) els.imageDialog.showModal();

  if (loadPreview && preview) {
    ensurePreviewLoad(image, { foreground: true }).then(previewObjectUrl => {
      if (!previewObjectUrl) return;
      if (currentImage?.id !== image.id) return;
      els.dialogImage.src = previewObjectUrl;
      els.dialogImage.classList.remove('showing-thumbnail');
      scheduleNextPreview(image.id);
    }).catch(() => {
      // Keep the instantly available thumbnail if preview generation/loading fails.
    });
  }
}

async function toggleGalleryFavorite(image) {
  const next = !Boolean(image.favorite);
  const data = await api(`/api/images/${image.id}/favorite`, { method: 'POST', body: { favorite: next } });
  image.favorite = data.favorite;
  updateGalleryFavoriteCard(image.id, data.favorite);
  if (currentImage?.id === image.id) {
    currentImage.favorite = data.favorite;
    updateDialogFavoriteButton(data.favorite);
  }
  if (els.favoriteOnly.checked && !data.favorite) {
    const removedIndex = loadedGalleryIndex(image.id);
    removeGalleryCard(image.id);
    await refillGalleryIfNeeded();
    if (currentImage?.id === image.id) {
      const replacement = loadedGalleryImages[removedIndex] || loadedGalleryImages[removedIndex - 1];
      if (replacement) await openImage(replacement.id);
      else els.imageDialog.close();
    }
  }
  // Favouriting an image also favourites the artist it belongs to, so the artist library
  // and its 收藏 view are refreshed and the extra effect is stated rather than silent.
  const linkedArtists = Array.isArray(data.favoriteArtists) ? data.favoriteArtists : [];
  if (linkedArtists.length) {
    artistLibrary?.refresh();
    const names = linkedArtists.slice(0, 3).join('、');
    toast(`已收藏${linkedArtists.length > 3 ? `，并收藏了画师 ${names} 等 ${linkedArtists.length} 位` : `，并收藏了画师 ${names}`}。`, 'success');
    return;
  }
  toast(data.favorite ? '已收藏。' : '已取消收藏。', 'success');
}

async function deleteGalleryImageInline(image) {
  if (!(await confirmGalleryDelete('删除这张图片、缩略图和图库记录？'))) return;
  const wasCurrent = currentImage?.id === image.id;
  const wasLatest = $('#quickLatest')?.dataset.imageId === image.id;
  const oldIndex = loadedGalleryIndex(image.id);
  const replacement = loadedGalleryImages[oldIndex + 1] || loadedGalleryImages[oldIndex - 1] || null;

  // Optimistic UI: the card disappears immediately; disk/database I/O continues in the background.
  removeGalleryCard(image.id);
  if (wasCurrent) {
    currentImage = null;
    if (replacement) openImage(replacement.id).catch(error => toast(error.message, 'error'));
    else els.imageDialog.close();
  }
  if (wasLatest) renderQuickLatest(loadedGalleryImages[0] || null);

  try {
    const result = await api('/api/images/batch-delete', { method: 'POST', body: { ids: [image.id] } });
    refillGalleryIfNeeded().catch(() => {});
    applyGalleryDeleteResult(result, { updateLatest: wasLatest });
    if (result?.trashed) { noteGalleryTrash({ trashCount: result.trashCount }); trashedToast([image.id]); }
    else toast(`图片已删除。${galleryExamplesSuffix(Number(result?.deletedExamples) || 0)}`, 'success');
  } catch (error) {
    restoreCleanupDeletedSummary({ image, index: oldIndex, wasLatest });
    toast(`删除失败，图片已放回原位置：${error.message}`, 'error');
  }
}

async function deleteSelectedGallery() {
  if (!selectedGalleryIds.size) return toast('先选择要删除的图片。');
  if (!(await confirmGalleryDelete(`删除选中的 ${selectedGalleryIds.size} 张图片？`))) return;
  const ids = [...selectedGalleryIds];
  const removedLatest = ids.includes($('#quickLatest')?.dataset.imageId || '');
  let handled = 0;
  let examplesRemoved = 0;
  let latestResult = null;
  const movedIds = [];
  if (els.galleryDeleteSelected) els.galleryDeleteSelected.disabled = true;
  try {
    for (const chunk of chunkValues(ids, 200)) {
      const result = await api('/api/images/batch-delete', { method: 'POST', body: { ids: chunk } });
      const absentIds = [...new Set([...(result.deletedIds || []), ...(result.missingIds || [])])];
      movedIds.push(...(result.deletedIds || []));
      for (const id of absentIds) {
        removeGalleryCard(id);
        selectedGalleryIds.delete(id);
      }
      handled += absentIds.length;
      latestResult = result;
      applyGalleryDeleteResult(result);
      examplesRemoved += Number(result?.deletedExamples) || 0;
      updateGallerySelectionUi();
    }
    await refillGalleryIfNeeded();
    if (removedLatest) applyGalleryDeleteResult(latestResult, { updateLatest: true });
    if (latestResult?.trashed) { noteGalleryTrash({ trashCount: latestResult.trashCount }); trashedToast(movedIds); }
    else toast(`已删除 ${handled} 张图片。${galleryExamplesSuffix(examplesRemoved)}`, 'success');
  } catch (error) {
    toast(`已完成 ${handled} 张，剩余图片保持选中：${error.message}`, 'error');
  } finally {
    if (els.galleryDeleteSelected) els.galleryDeleteSelected.disabled = false;
  }
}

async function resetGallery(switchTab = false) {
  if (galleryScope === 'trash') return renderTrashView();
  const timeRange = resolveGalleryTimeRange();
  if (galleryCleanupMode) {
    galleryCleanupMode = false;
    if (els.imageDialog?.open) els.imageDialog.close();
    await settleCleanupDeletes();
  }
  galleryPage = 1;
  galleryEpoch += 1;
  pendingGalleryImages.clear();
  pendingGallerySnapshotCursor = '';
  galleryNewImageCount = 0;
  renderGalleryNewImagesNotice();
  galleryLoaded = 0;
  galleryWindowStart = 0;
  galleryCursor = '';
  gallerySnapshotCursor = '';
  galleryHasMore = false;
  galleryFilterSince = timeRange.since;
  galleryFilterUntil = timeRange.until;
  loadedGalleryImages = [];
  galleryMasonryColumns = [];
  galleryMasonryColumnCount = 0;
  selectedGalleryIds.clear();
  els.galleryGrid.innerHTML = '';
  els.galleryGrid.classList.add('empty-state');
  updateGallerySelectionUi();
  await loadGallery();
  if (switchTab) switchTabTo('gallery');
}

// 最新结果 is drawn as a canvas in the current output proportions (CSSOM).
function paintLatestCanvas() {
  const node = $('#quickLatest');
  if (!node) return;
  const width = Math.max(64, Number($('#width')?.value) || 832), height = Math.max(64, Number($('#height')?.value) || 1216);
  node.style.setProperty('--cw', String(width));
  node.style.setProperty('--ch', String(height));
  const size = node.querySelector('[data-canvas-size]');
  if (size) size.textContent = `${width} × ${height}`;
}

function renderQuickLatest(image) {
  const node = $('#quickLatest');
  node.innerHTML = '';
  node.dataset.imageId = image?.id || '';
  // The bar's seed switch fixes this seed when switching from random.
  latestImageSeed = Number(image?.seed);
  if (!image) { node.innerHTML = '<span class="canvas-empty"><b data-canvas-size></b><small>尚无生成结果</small></span>'; node.onclick = null; paintLatestCanvas(); return; }
  const img = document.createElement('img');
  img.src = image.thumbUrl;
  img.alt = '最新生成结果';
  node.append(img);
  node.onclick = () => openImage(image.id);
}

function renderGalleryNewImagesNotice() {
  if (!els.galleryNewImagesButton) return;
  els.galleryNewImagesButton.classList.toggle('hidden', galleryNewImageCount <= 0);
  els.galleryNewImagesButton.textContent = galleryNewImageCount > 0 ? `载入新图 ${galleryNewImageCount}` : '载入新图';
}

function galleryHasActiveFilters() {
  return Boolean(
    els.favoriteOnly?.checked
    || String(els.gallerySearch?.value || '').trim()
    || String(els.galleryAgeFilter?.value || 'all') !== 'all'
  );
}

function galleryIsNearTop() {
  const gridTop = (els.galleryGrid?.getBoundingClientRect().top || 0) + window.scrollY;
  return window.scrollY <= Math.max(160, gridTop + 80);
}

function canAutoLoadPendingGalleryImages() {
  return pendingGalleryImages.size > 0
    && activeMainTab === 'gallery'
    && !galleryHasActiveFilters()
    && !galleryCleanupMode
    && !gallerySelectionMode
    && !els.imageDialog?.open
    && !galleryFilterTimer
    && !galleryLoadRequests.size
    && !cleanupPendingDeletes.length
    && !cleanupInFlightCount
    && galleryWindowStart === 0
    && galleryIsNearTop();
}

function loadPendingGalleryImages({ force = false } = {}) {
  if (!pendingGalleryImages.size || galleryScope === 'trash') return false;
  if (galleryHasActiveFilters() || galleryWindowStart !== 0) return false;
  if (!force && !canAutoLoadPendingGalleryImages()) return false;

  const knownIds = new Set(loadedGalleryImages.map(image => image.id));
  const images = [...pendingGalleryImages.values()]
    .filter(image => !knownIds.has(image.id))
    .sort((left, right) => Number(right.created_at) - Number(left.created_at) || String(right.id).localeCompare(String(left.id)));
  pendingGalleryImages.clear();
  galleryNewImageCount = 0;
  renderGalleryNewImagesNotice();
  if (!images.length) {
    pendingGallerySnapshotCursor = '';
    return false;
  }

  const previousScrollY = window.scrollY;
  const previousDocumentHeight = document.documentElement.scrollHeight;
  const preserveScroll = !galleryIsNearTop();
  loadedGalleryImages = [...images, ...loadedGalleryImages];
  galleryLoaded = loadedGalleryImages.length;
  galleryTotal += images.length;
  if (pendingGallerySnapshotCursor) gallerySnapshotCursor = pendingGallerySnapshotCursor;
  pendingGallerySnapshotCursor = '';
  prependGalleryMasonryCards(images);
  renderGalleryResultSummary();
  updateGallerySelectionUi();
  syncDialogNavigation();

  if (preserveScroll) {
    requestAnimationFrame(() => {
      const addedHeight = document.documentElement.scrollHeight - previousDocumentHeight;
      window.scrollTo({ top: previousScrollY + Math.max(0, addedHeight), left: 0, behavior: 'auto' });
    });
  }
  return true;
}

function tryAutoLoadPendingGalleryImages() {
  return loadPendingGalleryImages({ force: false });
}

function localDateBoundary(value, nextDay = false) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return 0;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + (nextDay ? 1 : 0));
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

function resolveGalleryTimeRange() {
  const mode = String(els.galleryAgeFilter?.value || 'all');
  if (mode.startsWith('recent:')) {
    const days = Math.max(0, Number(mode.slice(7)) || 0);
    return { since: days ? Date.now() - days * 86400_000 : 0, until: 0 };
  }
  // Accept the old numeric values when upgrading with a browser-restored form value.
  if (/^\d+$/.test(mode) && Number(mode) > 0) return { since: Date.now() - Number(mode) * 86400_000, until: 0 };
  if (mode === 'month') {
    const match = /^(\d{4})-(\d{2})$/.exec(String(els.galleryMonthFilter?.value || ''));
    if (!match) throw new Error('请先选择要查看的月份。');
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    return { since: new Date(year, month, 1).getTime(), until: new Date(year, month + 1, 1).getTime() };
  }
  if (mode === 'custom') {
    const since = localDateBoundary(els.galleryDateFrom?.value, false);
    const until = localDateBoundary(els.galleryDateTo?.value, true);
    if (!since && !until) throw new Error('请至少填写开始日期或结束日期。');
    if (since && until && since >= until) throw new Error('开始日期不能晚于结束日期。');
    return { since, until };
  }
  return { since: 0, until: 0 };
}

function syncGalleryTimeControls() {
  const mode = String(els.galleryAgeFilter?.value || 'all');
  if (mode === 'month' && !els.galleryMonthFilter?.value) {
    const now = new Date();
    els.galleryMonthFilter.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  // 自定义始末 opens on the last 30 days instead of an empty range that can only error.
  if (mode === 'custom' && els.galleryDateFrom && els.galleryDateTo && !els.galleryDateFrom.value && !els.galleryDateTo.value) {
    const day = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const today = new Date();
    els.galleryDateTo.value = day(today);
    els.galleryDateFrom.value = day(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29));
  }
  els.galleryMonthFilter?.classList.toggle('hidden', mode !== 'month');
  els.galleryCustomRange?.classList.toggle('hidden', mode !== 'custom');
}

function syncGalleryScopeControls() {
  for (const [scope, button] of [['gallery', els.galleryScopeGallery], ['rotation', els.galleryScopeRotation], ['iteration', els.galleryScopeIteration], ['trash', $('#galleryScopeTrash')]]) {
    const active = galleryScope === scope;
    button?.setAttribute('aria-pressed', String(active));
    button?.classList.toggle('is-active', active);
  }
  const heading = document.querySelector('.gallery-title-row h2');
  if (heading) heading.textContent = { gallery: '云端图库', rotation: '例图样本', iteration: '迭代实验', trash: '回收站' }[galleryScope];
  // The bin view keeps the grid but not the list's search, time filter, batch modes or storage line.
  document.querySelector('#galleryTab .gallery-panel')?.classList.toggle('is-trash', galleryScope === 'trash');
  const bar = $('#galleryTrashBar'); if (bar) bar.hidden = galleryScope !== 'trash';
  renderGalleryTrashButton();
}

function galleryMasonryTargetCount() {
  const measured = Math.floor(els.galleryGrid?.getBoundingClientRect().width || 0);
  const width = measured > 0 ? measured : Math.max(280, Math.min(1200, document.documentElement.clientWidth - 20));
  if (width <= 640) return 2;
  if (width <= 960) return 3;
  return Math.max(3, Math.min(5, Math.floor((width + 10) / 220)));
}

function resetGalleryMasonryColumns(count = galleryMasonryTargetCount()) {
  galleryMasonryColumnCount = count;
  galleryMasonryColumns = [];
  els.galleryGrid.innerHTML = '';
  els.galleryGrid.classList.remove('empty-state');
  els.galleryGrid.style.setProperty('--gallery-column-count', String(count));
  for (let index = 0; index < count; index += 1) {
    const column = document.createElement('div');
    column.className = 'gallery-column';
    column.dataset.estimatedHeight = '0';
    column.setAttribute('aria-label', `图库第 ${index + 1} 列`);
    galleryMasonryColumns.push(column);
    els.galleryGrid.append(column);
  }
}

function galleryCardEstimatedHeight(image) {
  const width = Math.max(1, Number(image?.width) || 1);
  const height = Math.max(1, Number(image?.height) || width);
  const gap = galleryMasonryColumnCount > 1 ? 10 * (galleryMasonryColumnCount - 1) : 0;
  const columnWidth = Math.max(120, ((els.galleryGrid.getBoundingClientRect().width || 1100) - gap) / Math.max(1, galleryMasonryColumnCount));
  return columnWidth * Math.max(0.25, Math.min(4, height / width)) + 35;
}

function appendGalleryMasonryCard(image) {
  if (!galleryMasonryColumns.length || galleryMasonryColumns.some(column => !column.isConnected)) resetGalleryMasonryColumns();
  const card = createGalleryCard(image);
  const estimatedHeight = galleryCardEstimatedHeight(image);
  card.dataset.masonryHeight = String(estimatedHeight);
  const column = galleryMasonryColumns.reduce((best, candidate) => (
    Number(candidate.dataset.estimatedHeight || 0) < Number(best.dataset.estimatedHeight || 0) ? candidate : best
  ), galleryMasonryColumns[0]);
  column.append(card);
  column.dataset.estimatedHeight = String(Number(column.dataset.estimatedHeight || 0) + estimatedHeight + 10);
  return card;
}

function prependGalleryMasonryCards(images) {
  if (!images.length) return;
  if (!galleryMasonryColumns.length || galleryMasonryColumns.some(column => !column.isConnected)) {
    resetGalleryMasonryColumns();
  }
  const assignments = new Map(galleryMasonryColumns.map(column => [column, []]));
  const projectedHeights = new Map(galleryMasonryColumns.map(column => [column, Number(column.dataset.estimatedHeight || 0)]));
  for (const image of images) {
    const column = galleryMasonryColumns.reduce((best, candidate) => (
      projectedHeights.get(candidate) < projectedHeights.get(best) ? candidate : best
    ), galleryMasonryColumns[0]);
    const estimatedHeight = galleryCardEstimatedHeight(image);
    assignments.get(column).push({ image, estimatedHeight });
    projectedHeights.set(column, projectedHeights.get(column) + estimatedHeight + 10);
  }
  for (const column of galleryMasonryColumns) {
    const assigned = assignments.get(column);
    for (const { image, estimatedHeight } of [...assigned].reverse()) {
      const card = createGalleryCard(image);
      card.dataset.masonryHeight = String(estimatedHeight);
      column.prepend(card);
    }
    column.dataset.estimatedHeight = String(projectedHeights.get(column));
  }
  els.galleryGrid.classList.remove('empty-state');
}

// The empty message says which list is empty and how to fill it, so an empty
// rotation view is not mistaken for a broken gallery.
function galleryEmptyMessage() {
  if (galleryScope === 'iteration') return '还没有迭代实验图。DSH 调词、画师组合与参数测试生成的图会单独保存在这里。';
  return galleryScope === 'rotation'
    ? '还没有例图样本。在画师库里打开「画师例图生成」、保存基准后开始一批，生成的图会出现在这里，不会进入常规作品。'
    : '暂无图片';
}

function rebuildGalleryMasonry() {
  if (galleryScope === 'trash') return; // the bin view lays out its own grid
  if (!loadedGalleryImages.length) {
    galleryMasonryColumns = [];
    galleryMasonryColumnCount = 0;
    els.galleryGrid.textContent = galleryEmptyMessage();
    els.galleryGrid.classList.add('empty-state');
    return;
  }
  resetGalleryMasonryColumns();
  for (const image of loadedGalleryImages) appendGalleryMasonryCard(image);
  updateGallerySelectionUi();
}

function syncGalleryMasonryForViewport() {
  if (galleryScope === 'trash') return; // the bin view lays out its own grid
  if (!loadedGalleryImages.length) return;
  const nextCount = galleryMasonryTargetCount();
  if (nextCount !== galleryMasonryColumnCount) rebuildGalleryMasonry();
}

function detachGalleryCard(id) {
  const card = document.querySelector(`[data-gallery-id="${CSS.escape(id)}"]`);
  if (!card) return;
  const column = card.closest('.gallery-column');
  if (column) {
    const nextHeight = Math.max(0, Number(column.dataset.estimatedHeight || 0) - Number(card.dataset.masonryHeight || 0) - 10);
    column.dataset.estimatedHeight = String(nextHeight);
  }
  card.remove();
}

function createGalleryCard(image) {
  const card = document.createElement('article');
  card.className = 'gallery-card';
  card.dataset.galleryId = image.id;
  card.dataset.favorite = image.favorite ? '1' : '0';
  const imageWidth = Math.max(1, Math.trunc(Number(image.width) || 1));
  const imageHeight = Math.max(1, Math.trunc(Number(image.height) || imageWidth));
  card.innerHTML = `
    <img src="${image.thumbUrl}" width="${imageWidth}" height="${imageHeight}" loading="lazy" decoding="async" alt="NovelAI 生成图片">
    <button class="gallery-delete-button" type="button" aria-label="删除图片">×</button>
    <button class="gallery-favorite-button ${image.favorite ? 'active' : ''}" type="button" aria-label="${image.favorite ? '取消收藏' : '收藏'}">${image.favorite ? '★' : '☆'}</button>
    <button class="gallery-check hidden" type="button" aria-label="选择图片">○</button>
    <footer><span>Seed ${image.seed}</span><span>${image.width}×${image.height}</span></footer>`;

  // A rotation sample belongs to an artist, so the card says which one and opens that
  // artist's page. The chip sits between the image and the footer in normal flow, so it
  // cannot cover the Seed/尺寸 line; clicking it must not also open the image dialog.
  const artist = String(image.artist || '').trim();
  if (artist) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'gallery-artist-chip';
    chip.dataset.galleryArtist = artist;
    chip.title = `打开画师资料：${artist}`;
    const label = document.createElement('span');
    label.textContent = artist;
    chip.append(label);
    chip.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      openArtistLibrary(artist);
    });
    const row = document.createElement('div');
    row.className = 'gallery-card-artist';
    row.append(chip);
    card.querySelector('footer').before(row);
  }

  card.querySelector('.gallery-favorite-button').addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    toggleGalleryFavorite(image).catch(error => toast(error.message, 'error'));
  });
  card.querySelector('.gallery-delete-button').addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    deleteGalleryImageInline(image).catch(error => toast(error.message, 'error'));
  });
  card.querySelector('.gallery-check').addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    toggleGallerySelection(image.id);
  });
  card.addEventListener('click', event => {
    if (gallerySelectionMode) {
      event.preventDefault();
      toggleGallerySelection(image.id);
      return;
    }
    openImage(image.id);
  });
  return card;
}

function galleryQueryParams(extra = {}) {
  const params = new URLSearchParams({
    limit: String(extra.limit || 30),
    favorite: els.favoriteOnly.checked ? '1' : '0',
    // The two views are separate lists over the same table. Rotation samples never
    // appear in the ordinary gallery, and vice versa.
    kind: galleryScope
  });
  if (Object.prototype.hasOwnProperty.call(extra, 'cursor')) params.set('cursor', String(extra.cursor || ''));
  if (Object.prototype.hasOwnProperty.call(extra, 'offset')) params.set('offset', String(Math.max(0, Number(extra.offset) || 0)));
  if (gallerySnapshotCursor) params.set('snapshot', gallerySnapshotCursor);
  const query = String(els.gallerySearch?.value || '').trim();
  if (query) params.set('q', query);
  if (galleryFilterSince) params.set('since', String(galleryFilterSince));
  if (galleryFilterUntil) params.set('until', String(galleryFilterUntil));
  return params;
}

function renderGalleryResultSummary() {
  if (!els.galleryResultSummary) return;
  if (!galleryTotal || !galleryLoaded) {
    els.galleryResultSummary.textContent = `${galleryTotal || 0} 张`;
    return;
  }
  const start = galleryWindowStart + 1;
  const end = galleryWindowStart + galleryLoaded;
  els.galleryResultSummary.textContent = start === 1 ? `已载入 ${end} / ${galleryTotal}` : `第 ${start}–${end} / ${galleryTotal}`;
}

function trimGalleryDomWindow() {
  if (loadedGalleryImages.length <= GALLERY_DOM_LIMIT || gallerySelectionMode) return;
  if (cleanupPendingDeletes.length || cleanupInFlightCount) return;
  const currentIndex = els.imageDialog?.open && currentImage ? loadedGalleryIndex(currentImage.id) : -1;
  const overflow = loadedGalleryImages.length - GALLERY_DOM_LIMIT;
  const removableBeforeCurrent = currentIndex >= 0 ? Math.max(0, currentIndex - 30) : overflow;
  const removeCount = Math.min(overflow, removableBeforeCurrent);
  if (removeCount <= 0) return;
  const removed = loadedGalleryImages.splice(0, removeCount);
  for (const image of removed) {
    detachGalleryCard(image.id);
    imageDetailCache.delete(image.id);
    const previewEntry = imagePreviewCache.get(image.id);
    previewEntry?.controller?.abort();
    if (previewEntry?.url) URL.revokeObjectURL(previewEntry.url);
    imagePreviewCache.delete(image.id);
  }
  galleryWindowStart += removeCount;
  galleryLoaded = loadedGalleryImages.length;
}

async function loadGalleryWindow(targetIndex) {
  if (galleryCleanupMode) await settleCleanupDeletes();
  const offset = Math.min(
    Math.max(0, Number(targetIndex || 0) - 10),
    Math.max(0, galleryTotal - 30)
  );
  const epoch = ++galleryEpoch;
  const params = galleryQueryParams({ offset, limit: 30 });
  els.loadMoreButton.disabled = true;
  try {
    const data = await api(`/api/images?${params.toString()}`);
    if (epoch !== galleryEpoch) return null;
    galleryTotal = data.total;
    noteGalleryTrash(data);
    galleryWindowStart = Number(data.offset || 0);
    galleryCursor = String(data.nextCursor || '');
    gallerySnapshotCursor = String(data.snapshotCursor || gallerySnapshotCursor || '');
    galleryHasMore = Boolean(data.hasMore);
    galleryPage = 2;
    loadedGalleryImages = [];
    selectedGalleryIds.clear();
    for (const image of data.images || []) {
      loadedGalleryImages.push(image);
    }
    galleryLoaded = loadedGalleryImages.length;
    if (!galleryLoaded) {
      els.galleryGrid.textContent = galleryEmptyMessage();
      els.galleryGrid.classList.add('empty-state');
      galleryMasonryColumns = [];
      galleryMasonryColumnCount = 0;
    } else {
      rebuildGalleryMasonry();
    }
    els.loadMoreButton.classList.toggle('hidden', !galleryHasMore);
    renderGalleryResultSummary();
    updateGallerySelectionUi();
    syncDialogNavigation();
    return loadedGalleryImages[Number(targetIndex) - galleryWindowStart] || loadedGalleryImages[0] || null;
  } finally {
    els.loadMoreButton.disabled = false;
  }
}

async function loadGallery() {
  const epoch = galleryEpoch;
  const requestCursor = galleryCursor;
  const requestKey = `${epoch}:${requestCursor || 'first'}`;
  if (galleryLoadRequests.has(requestKey)) return galleryLoadRequests.get(requestKey);
  const request = (async () => {
    const firstPage = galleryPage === 1;
    const params = galleryQueryParams({ cursor: requestCursor, limit: 30 });
    els.loadMoreButton.disabled = true;
    const data = await api(`/api/images?${params.toString()}`);
    if (epoch !== galleryEpoch) return;
    galleryTotal = data.total;
    noteGalleryTrash(data);
    galleryCursor = String(data.nextCursor || '');
    gallerySnapshotCursor = String(data.snapshotCursor || gallerySnapshotCursor || '');
    galleryHasMore = Boolean(data.hasMore);
    if (firstPage) await refreshQuickLatestOnly();
    if (epoch !== galleryEpoch) return;
    if (firstPage && !data.images.length) {
      els.galleryGrid.textContent = galleryEmptyMessage();
      galleryMasonryColumns = [];
      galleryMasonryColumnCount = 0;
    } else if (firstPage) {
      resetGalleryMasonryColumns();
    }
    const knownIds = new Set(loadedGalleryImages.map(item => item.id));
    for (const image of data.images) {
      if (knownIds.has(image.id)) continue;
      loadedGalleryImages.push(image);
      knownIds.add(image.id);
      appendGalleryMasonryCard(image);
    }
    trimGalleryDomWindow();
    galleryLoaded = loadedGalleryImages.length;
    els.loadMoreButton.classList.toggle('hidden', !galleryHasMore);
    renderGalleryResultSummary();
    galleryPage += 1;
    updateGallerySelectionUi();
    syncDialogNavigation();
  })().finally(() => {
    galleryLoadRequests.delete(requestKey);
    if (![...galleryLoadRequests.keys()].some(key => key.startsWith(`${galleryEpoch}:`))) els.loadMoreButton.disabled = false;
  });
  galleryLoadRequests.set(requestKey, request);
  return request;
}

async function openImage(id) {
  if (!id) return;
  const summary = loadedGalleryImage(id);
  const cached = imageDetailCache.get(id)?.data || null;

  if (galleryCleanupMode && summary) {
    currentImage = { ...summary };
    showDialogImageInstant(currentImage, { loadPreview: true, detailReady: false });
    return currentImage;
  }

  // Navigation should feel instantaneous: show the already-loaded thumbnail before any API round trip.
  if (cached) showDialogImageInstant({ ...(summary || {}), ...cached });
  else if (summary) showDialogImageInstant({ ...summary, params: null });
  else {
    currentImage = { id };
    els.dialogPrevious.disabled = true;
    els.dialogNext.disabled = true;
    els.dialogMeta.innerHTML = '<div class="meta-row"><span>图片</span><code>正在读取…</code></div>';
    if (!els.imageDialog.open) els.imageDialog.showModal();
  }

  const image = cached || await fetchImageDetail(id);
  if (currentImage?.id && currentImage.id !== id) return image;
  currentImage = { ...(summary || {}), ...image };
  if (els.dialogDownload) els.dialogDownload.disabled = !currentImage.originalUrl;
  els.dialogNote.value = currentImage.note || '';
  updateDialogFavoriteButton(currentImage.favorite);
  renderDialogMetadata(currentImage, true);
  syncDialogNavigation();
  if (!summary && !cached) showDialogImageInstant(currentImage);
  return image;
}

async function navigateImageDialog(step) {
  if (!currentImage || !Number.isInteger(step) || !step) return;
  let index = loadedGalleryIndex(currentImage.id);
  if (index < 0) return;
  if (step < 0 && index === 0 && galleryWindowStart > 0) {
    const target = await loadGalleryWindow(galleryWindowStart - 1);
    if (target) await openImage(target.id);
    return;
  }
  if (step > 0 && index >= loadedGalleryImages.length - 1 && galleryHasMore) {
    if (galleryCleanupMode) await settleCleanupDeletes();
    await loadGallery();
    index = loadedGalleryIndex(currentImage.id);
  }
  const target = loadedGalleryImages[index + step];
  if (!target) return;
  await openImage(target.id);
}

function triggerBrowserDownload(url) {
  if (!url) return;
  if (globalThis.NAI_RUNTIME?.download) { globalThis.NAI_RUNTIME.download(url).then(saved => { if (saved) toast('文件已保存。'); }).catch(error => toast(error.message, 'error')); return; }
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

function openDownloadChoice() {
  if (!currentImage?.id || !currentImage?.originalUrl) return toast('当前图片没有可下载的原图。', 'error');
  els.downloadChoiceDialog?.showModal();
}

function imageSourceHasStructuredGroups(raw) {
  return Boolean(raw?.groups && typeof raw.groups === 'object' && !Array.isArray(raw.groups));
}

// 部分恢复 merge mode: 替换 overwrites the chosen part; 追加 adds what is missing (法典's rule).
let restoreMerge = storageGet('nai-pocket-restore-merge') === 'append' ? 'append' : 'replace';
const RESTORE_TAG_GROUPS = { scene: ['scene'], camera: ['camera'], style: ['style'], misc: ['misc'], 'camera-style': ['camera', 'style'] };
const restoreTermList = text => String(text || '').split(',').map(item => item.trim()).filter(Boolean);

// Applies one restore choice to `merged` (a copy of the editor) and reports what changed.
function applyImageRestore(merged, source, rawSource, mode, characterIndex, merge) {
  const result = { tags: 0, characters: 0, uc: 0, structured: false, params: false };
  const present = new Set();
  for (const list of Object.values(merged.groups || {})) for (const tag of list || []) present.add(codexTagKey(tag));
  const appendTags = (target, tags, keys) => {
    let added = 0;
    for (const tag of tags || []) {
      const key = codexTagKey(tag);
      if (!key || keys.has(key)) continue;
      keys.add(key);
      target.push({ ...structuredClone(tag), id: uid(), originalOrder: null });
      added += 1;
    }
    return added;
  };
  const groupsFor = mode === 'all' ? Object.keys(source.groups || {}) : RESTORE_TAG_GROUPS[mode];
  if (groupsFor && (mode !== 'all' || merge === 'append')) {
    for (const group of groupsFor) {
      if (!merged.groups[group]) merged.groups[group] = [];
      if (merge === 'append') result.tags += appendTags(merged.groups[group], source.groups[group], present);
      else {
        merged.groups[group] = structuredClone(source.groups[group] || []);
        if (merged.promptOrderMode === 'original') merged.groups[group].forEach(tag => { tag.originalOrder = null; });
        result.tags += merged.groups[group].length;
      }
    }
    result.structured = true;
  }
  const characterIndexes = Number.isInteger(characterIndex) ? [characterIndex]
    : (mode === 'characters' || (mode === 'all' && merge === 'append')) ? source.characters.map((_, index) => index) : [];
  if (characterIndexes.length) {
    const limit = characterLimitForModel(rawSource?.model || merged.model);
    if (merge === 'replace' && mode === 'characters') {
      merged.characters = structuredClone(source.characters);
      result.characters = merged.characters.length;
    } else {
      for (const index of characterIndexes) {
        const incoming = source.characters[index];
        if (!incoming) continue;
        const existing = merged.characters[index];
        if (merge === 'replace') {
          while (merged.characters.length <= index) merged.characters.push(createCharacter({ name: '' }));
          merged.characters[index] = createCharacter({ ...structuredClone(incoming), id: merged.characters[index]?.id || uid() });
          result.characters += 1;
        } else if (existing) {
          const keys = new Set((existing.promptTags || []).map(codexTagKey));
          const ucKeys = new Set((existing.ucTags || []).map(codexTagKey));
          existing.promptTags = existing.promptTags || []; existing.ucTags = existing.ucTags || [];
          result.tags += appendTags(existing.promptTags, incoming.promptTags, keys) + appendTags(existing.ucTags, incoming.ucTags, ucKeys);
        } else if (merged.characters.length < limit) {
          merged.characters.push(createCharacter({ ...structuredClone(incoming), id: uid() }));
          result.characters += 1;
        }
      }
    }
    result.structured = true;
  }
  if (mode === 'uc' || (mode === 'all' && merge === 'append')) {
    if (merge === 'append') {
      const current = restoreTermList(merged.negativePrompt);
      const keys = new Set(current.map(term => term.toLowerCase()));
      const added = restoreTermList(source.negativePrompt).filter(term => !keys.has(term.toLowerCase()) && keys.add(term.toLowerCase()));
      if (added.length) merged.negativePrompt = [...current, ...added].join(', ');
      result.uc = added.length;
    } else {
      merged.negativePrompt = source.negativePrompt;
      result.uc = restoreTermList(source.negativePrompt).length;
    }
  }
  if (mode === 'params' && merge === 'replace') {
    merged.model = String(rawSource?.model || '').trim() || merged.model;
    merged.params = structuredClone(source.params);
    merged.seedMode = source.seedMode;
    merged.seed = source.seed;
    merged.v4Options = structuredClone(source.v4Options);
    result.params = true;
  }
  return result;
}

function restorePreviewCount(mode, characterIndex = null) {
  const rawSource = currentImage?.params;
  if (!rawSource) return null;
  const merged = normalizeStoredState(serializeState());
  return applyImageRestore(merged, normalizeStoredState(rawSource), rawSource, mode, characterIndex, restoreMerge);
}

function restoreDetailText(mode, result, raw) {
  if (restoreMerge === 'append' && mode === 'params') return '只能替换';
  if (!result) return '';
  if (restoreMerge === 'append') {
    const parts = [];
    if (result.tags) parts.push(`+${result.tags} 个 Tag`);
    if (result.characters) parts.push(`+${result.characters} 个角色`);
    if (result.uc) parts.push(`+${result.uc} 项 UC`);
    if (mode === 'all') return parts.length ? `只补缺少的，不删除 · ${parts.join(' · ')}` : '没有新内容';
    return parts.join(' · ') || '没有新内容';
  }
  if (mode === 'all') return '覆盖为这张图：提示词、角色、UC 与参数';
  if (mode === 'params') { const p = raw?.params || {}; return [modelDisplayName?.(raw?.model) || raw?.model, p.width && p.height ? `${p.width}×${p.height}` : '', p.steps ? `${p.steps} 步` : ''].filter(Boolean).join(' · '); }
  if (mode === 'uc') return `${result.uc} 项`;
  if (mode === 'characters' || mode === 'character') return `${result.characters} 个角色`;
  return `${result.tags} 个 Tag`;
}

function renderImageRestoreOptions() {
  const raw = currentImage?.params;
  const hasParams = Boolean(raw);
  const hasGroups = imageSourceHasStructuredGroups(raw);
  const append = restoreMerge === 'append';
  const characters = Array.isArray(raw?.characters) ? raw.characters.slice(0, characterLimitForModel(raw?.model || appState.model)) : [];
  els.imageRestoreDialog?.querySelectorAll('[data-restore-merge]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.restoreMerge === restoreMerge)));
  if (els.imageRestoreDialog) els.imageRestoreDialog.dataset.merge = restoreMerge;
  const allLabel = $('#imageRestoreAllLabel');
  if (allLabel) allLabel.textContent = append ? '全部追加' : '完整恢复';
  if (els.imageRestoreCharacterActions) {
    els.imageRestoreCharacterActions.innerHTML = characters.map((character, index) => {
      const first = (character.promptTags || []).find(tag => tag.enabled !== false && tag.text)?.text || '';
      const name = String(character.name || '').trim() || first;
      const detail = restoreDetailText('character', hasParams ? restorePreviewCount('character', index) : null, raw);
      const empty = append && detail === '没有新内容';
      return `<button class="restore-tile${append && !empty ? ' has-new' : ''}" type="button" data-image-restore-character="${index}"${empty ? ' disabled' : ''}><strong>角色 ${index + 1}${name ? ` · ${escapeHtml(name.slice(0, 24))}` : ''}</strong><small>${escapeHtml(detail)}</small></button>`;
    }).join('');
  }
  els.imageRestoreDialog?.querySelectorAll('[data-image-restore-mode]').forEach(button => {
    const mode = button.dataset.imageRestoreMode;
    let enabled = hasParams;
    if (['scene', 'camera', 'style', 'misc', 'camera-style'].includes(mode)) enabled = hasParams && hasGroups;
    if (mode === 'characters') enabled = hasParams && characters.length > 0;
    if (mode === 'uc') enabled = hasParams && Object.prototype.hasOwnProperty.call(raw || {}, 'negativePrompt');
    if (mode === 'params' && append) enabled = false;
    const result = enabled ? restorePreviewCount(mode) : null;
    const detail = enabled || (mode === 'params' && append) ? restoreDetailText(mode, result, raw) : '';
    if (append && detail === '没有新内容') enabled = false;
    button.disabled = !enabled;
    button.classList.toggle('has-new', append && enabled && mode !== 'all');
    const small = button.querySelector('[data-restore-detail]');
    if (small) small.textContent = detail;
  });
  const legacyHint = $('#imageRestoreLegacyHint');
  legacyHint?.classList.toggle('hidden', !hasParams || hasGroups);
}

function openImageRestoreOptions() {
  if (!currentImage?.params) return toast('这张图片没有可恢复的完整参数。', 'error');
  renderImageRestoreOptions();
  els.imageRestoreDialog?.showModal();
}

function restoreCurrentImagePartial(mode = 'all', characterIndex = null) {
  if (!currentImage?.params) return;
  if (mode === 'all' && restoreMerge === 'replace') {
    els.imageRestoreDialog?.close();
    return restoreImageState();
  }
  if (restoreMerge === 'append') {
    if (mode === 'params') return toast('生成参数只能替换。', 'error');
    const rawSource = currentImage.params;
    const merged = normalizeStoredState(serializeState());
    const result = applyImageRestore(merged, normalizeStoredState(rawSource), rawSource, mode === 'character' ? null : mode, Number.isInteger(characterIndex) ? characterIndex : null, 'append');
    if (!result.tags && !result.characters && !result.uc) return toast('没有可追加的新内容。');
    if (result.structured) { merged.directMode = false; merged.previewPrompt = ''; merged.prompt = ''; }
    hydrateState(merged);
    els.imageRestoreDialog?.close();
    els.imageDialog?.close();
    switchTabTo('editor');
    const parts = [result.tags ? `${result.tags} 个 Tag` : '', result.characters ? `${result.characters} 个角色` : '', result.uc ? `${result.uc} 项 UC` : ''].filter(Boolean);
    return toast(`已追加 ${parts.join('、')}`, 'success');
  }

  const rawSource = currentImage.params;
  const current = normalizeStoredState(serializeState());
  const source = normalizeStoredState(rawSource);
  const sourceModel = String(rawSource?.model || '').trim();
  const merged = structuredClone(current);
  let structuredContentChanged = false;
  let label = mode;

  if (Number.isInteger(characterIndex)) {
    const sourceCharacter = source.characters[characterIndex];
    if (!sourceCharacter) return toast(`这张图没有角色 ${characterIndex + 1}。`, 'error');
    while (merged.characters.length <= characterIndex) {
      merged.characters.push(createCharacter({ name: '' }));
    }
    const targetId = merged.characters[characterIndex]?.id || uid();
    merged.characters[characterIndex] = createCharacter({ ...structuredClone(sourceCharacter), id: targetId });
    structuredContentChanged = true;
    label = `角色 ${characterIndex + 1}`;
  } else if (mode === 'characters') {
    merged.characters = structuredClone(source.characters);
    structuredContentChanged = true;
    label = '全部角色';
  } else if (mode === 'scene' || mode === 'camera' || mode === 'style' || mode === 'misc') {
    if (!imageSourceHasStructuredGroups(rawSource)) return toast('这张旧图没有可恢复的结构化分区。', 'error');
    merged.groups[mode] = structuredClone(source.groups[mode]);
    if (merged.promptOrderMode === 'original') merged.groups[mode].forEach(tag => { tag.originalOrder = null; });
    structuredContentChanged = true;
    label = ({ scene: '场景', camera: '镜头', style: '画风', misc: '其他' })[mode];
  } else if (mode === 'camera-style') {
    if (!imageSourceHasStructuredGroups(rawSource)) return toast('这张旧图没有可恢复的结构化分区。', 'error');
    merged.groups.camera = structuredClone(source.groups.camera);
    merged.groups.style = structuredClone(source.groups.style);
    if (merged.promptOrderMode === 'original') {
      merged.groups.camera.forEach(tag => { tag.originalOrder = null; });
      merged.groups.style.forEach(tag => { tag.originalOrder = null; });
    }
    structuredContentChanged = true;
    label = '镜头 + 画风';
  } else if (mode === 'uc') {
    merged.negativePrompt = source.negativePrompt;
    label = 'Global UC';
  } else if (mode === 'params') {
    merged.model = sourceModel || current.model;
    merged.params = structuredClone(source.params);
    merged.seedMode = source.seedMode;
    merged.seed = source.seed;
    merged.v4Options = structuredClone(source.v4Options);
    label = '生成参数';
  } else {
    return;
  }

  if (structuredContentChanged) {
    merged.directMode = false;
    merged.previewPrompt = '';
    merged.prompt = '';
  }
  hydrateState(merged);
  els.imageRestoreDialog?.close();
  els.imageDialog?.close();
  switchTabTo('editor');
  toast(`已从图库图片恢复：${label}`, 'success');
}

function restoreImageState() {
  if (!currentImage?.params) return;
  const state = currentImage.params;
  if (state.groups) {
    const restored = withCurrentGenerationRoute(state);
    if (!String(state.model || '').trim()) restored.model = $('#model')?.value || appState.model || createDefaultState().model;
    restored.seedMode = 'fixed';
    restored.seed = Number(currentImage.seed || 0);
    hydrateState(restored);
  } else {
    const restored = withCurrentGenerationRoute(createDefaultState());
    for (const [originalOrder, text] of splitPrompt(currentImage.prompt).entries()) restored.groups[classifyTag(text)].push({ id: uid(), text, weight: 1, enabled: true, originalOrder });
    restored.promptOrderMode = 'original';
    restored.prompt = currentImage.prompt;
    restored.negativePrompt = currentImage.negative_prompt;
    restored.model = String(state.model || '').trim() || $('#model')?.value || appState.model || restored.model;
    restored.params = { ...restored.params, ...(state.params || {}) };
    restored.seedMode = 'fixed';
    restored.seed = currentImage.seed;
    hydrateState(restored);
  }
  els.imageDialog.close();
  switchTabTo('editor');
  toast('已恢复该图片的创作参数；当前通道与 Token 保持不变。', 'success');
}

async function switchFavorite() {
  if (!currentImage) return;
  await toggleGalleryFavorite(currentImage);
}

async function deleteCurrentImage() {
  if (!currentImage || !(await confirmGalleryDelete('删除这张图片、缩略图和图库记录？'))) return;
  const deleting = { ...currentImage };
  const oldIndex = loadedGalleryIndex(deleting.id);
  const wasLatest = $('#quickLatest')?.dataset.imageId === deleting.id;
  const next = oldIndex >= 0 ? loadedGalleryImages[oldIndex + 1] : null;
  const previous = oldIndex > 0 ? loadedGalleryImages[oldIndex - 1] : null;
  const replacement = next || previous || null;

  // Optimistic delete: switch first, then wait for server-side file/database cleanup.
  removeGalleryCard(deleting.id);
  currentImage = null;
  if (replacement) openImage(replacement.id).catch(error => toast(error.message, 'error'));
  else els.imageDialog.close();
  if (wasLatest) renderQuickLatest(loadedGalleryImages[0] || null);

  try {
    const result = await api('/api/images/batch-delete', { method: 'POST', body: { ids: [deleting.id] } });
    if (!replacement && galleryTotal > 0) {
      let windowFallback = null;
      if (galleryHasMore) await loadGallery();
      else if (galleryWindowStart > 0) windowFallback = await loadGalleryWindow(galleryTotal - 1);
      const fallback = windowFallback || loadedGalleryImages[Math.min(oldIndex, loadedGalleryImages.length - 1)] || loadedGalleryImages[0];
      if (fallback) openImage(fallback.id).catch(error => toast(error.message, 'error'));
    }
    applyGalleryDeleteResult(result, { updateLatest: wasLatest });
    if (result?.trashed) { noteGalleryTrash({ trashCount: result.trashCount }); trashedToast([deleting.id]); }
    else toast(`${replacement ? '图片已删除，已立即顺延。' : '图片已删除。'}${galleryExamplesSuffix(Number(result?.deletedExamples) || 0)}`, 'success');
  } catch (error) {
    restoreCleanupDeletedSummary({ image: deleting, index: oldIndex, wasLatest });
    toast(`删除失败，图片已放回原位置：${error.message}`, 'error');
  }
}

async function saveNote() {
  if (!currentImage) return;
  await api(`/api/images/${currentImage.id}/note`, { method: 'PATCH', body: { note: els.dialogNote.value } });
  currentImage.note = els.dialogNote.value;
}

function switchTabTo(name) {
  if (name === 'artists' && !artistLibraryAvailable) return toast('本机画师栏尚未接入。');
  if (name === 'storm' && !stormAvailable) return toast('此版本未包含 Storm 工作台。');
  if (name === activeMainTab && document.querySelector(`.tab[data-tab="${name}"]`)?.classList.contains('active')) return;
  if (!tabScrollPositions[name] && tabScrollPositions[name] !== 0) tabScrollPositions[name] = 0;
  if (activeMainTab && activeMainTab !== name) tabScrollPositions[activeMainTab] = window.scrollY;
  activeMainTab = name;
  if ($('#pageCrumb')) $('#pageCrumb').textContent = ({ editor: '编辑工作台', artists: '画师资料库', storm: '画风 Storm', codex: '法典', gallery: '图库', scheme: '方案', queue: '生成队列' })[name] || '工作台';
  $$('.tab').forEach(button => button.classList.toggle('active', button.dataset.tab === name));
  $$('.tab-panel').forEach(panel => panel.classList.remove('active'));
  $(`#${name}Tab`)?.classList.add('active');
  document.body.classList.toggle('editor-tab-active', name === 'editor');
  els.floatingGenerateBar?.classList.toggle('hidden', name !== 'editor');
  if (name === 'gallery' && !galleryLoaded) resetGallery(false);
  else if (name === 'gallery') requestAnimationFrame(() => {
    syncGalleryMasonryForViewport();
    tryAutoLoadPendingGalleryImages();
  });
  if (name !== 'codex') codexPanel.closeDetail();
  if (name === 'codex') codexPanel.ensureLoaded();
  if (name === 'scheme') loadSchemes().catch(error => toast(error.message, 'error'));
  if (name === 'artists') ensureArtistLibrary().show().then(() => artistAutomationAvailable ? ensureArtistAutomation().refresh() : undefined).catch(error => toast(error.message, 'error'));
  if (name === 'storm') {
    if (els.artistStormPanel) els.artistStormPanel.open = true;
    renderStormPlan();
  }
  const targetY = Number(tabScrollPositions[name] || 0);
  requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: targetY, left: 0, behavior: 'auto' })));
}

// 整块 only differs from ＋ when the input holds several items, so the row shows it only then.
function syncWholeAddButtons() {
  document.querySelectorAll('.tag-add').forEach(row => {
    row.classList.toggle('has-multiple', /[,，;；|\n]/.test(row.querySelector('input')?.value || ''));
  });
}

// 语义工作台 has two pages: 查词 (describe → tags) and 联想 (from existing tags).
function setSemanticTab(tab) {
  const page = tab === 'explore' ? 'explore' : 'search';
  if (els.semanticDialog) els.semanticDialog.dataset.tab = page;
  document.querySelectorAll('[data-semantic-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.semanticTab === page)));
}

function initBindings() {
  document.addEventListener('input', event => { if (event.target.closest?.('.tag-add')) syncWholeAddButtons(); });
  document.addEventListener('click', event => { if (event.target.closest?.('.tag-add')) requestAnimationFrame(syncWholeAddButtons); });
  document.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.closest?.('.tag-add')) requestAnimationFrame(syncWholeAddButtons); });
  document.querySelectorAll('[data-semantic-tab]').forEach(button => button.addEventListener('click', () => setSemanticTab(button.dataset.semanticTab)));
  observeToastClearance($('#toastHost'), els.floatingGenerateBar);
  installSelectSheets({ isEnabled: () => !document.body.classList.contains('tag-layout-legacy') });
  for (const area of [els.promptPreview, $('#negativePrompt')]) attachWeightHighlight(area, { isEnabled: () => !document.body.classList.contains('tag-layout-legacy') });
  // 自动联想 floats over the page (tag-chips.css). Whichever render path shows a menu, it opens
  // above its input when the room below, above the generate bar, is too short. The class is
  // only touched when the placement changes, so this observer never feeds itself.
  const placeSuggestionMenu = menu => {
    const host = menu.parentElement;
    if (!host || menu.classList.contains('hidden')) return;
    const box = host.getBoundingClientRect();
    const bar = els.floatingGenerateBar?.getBoundingClientRect();
    const floor = bar && bar.height && bar.top > box.bottom ? bar.top : innerHeight;
    const need = Math.min(menu.scrollHeight, 240) + 12;
    menu.classList.toggle('is-above', floor - box.bottom < need && box.top > floor - box.bottom);
  };
  new MutationObserver(records => {
    for (const record of records) {
      const menu = record.target;
      if (menu instanceof HTMLElement && menu.classList.contains('suggestion-menu')) placeSuggestionMenu(menu);
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-open-artist-library]');
    if (!button) return;
    event.preventDefault();
    openArtistLibrary(button.dataset.openArtistLibrary || '');
  });
  $('#artistPreviewLibrary')?.addEventListener('click', () => {
    const name = activeArtistPreview?.artist.name;
    if (!name) return;
    closeArtistPreview();
    openArtistLibrary(name);
  });
  // The tutorial is archived until its freeze has been diagnosed; no initialization.
  $('#openSettingsButton')?.addEventListener('click', () => {
    $('#settingsDialog')?.showModal();
    if (authContext.role === 'owner' && artistAutomationAvailable) ensureArtistAutomation().refresh().catch(error => toast(error.message, 'error'));
  });
  $('#firstRunSettingsButton')?.addEventListener('click', () => $('#openSettingsButton')?.click());
  $('#closeSettingsButton')?.addEventListener('click', () => $('#settingsDialog')?.close());
  // New layout: 退出 lives in settings, away from the everyday top-bar buttons.
  $('#settingsLogoutButton')?.addEventListener('click', () => { $('#settingsDialog')?.close(); $('#logoutButton')?.click(); });
  document.addEventListener('click', event => {
    const help = event.target.closest('[data-parameter-help]');
    if (help) { event.preventDefault(); showParameterHelp(help.dataset.parameterHelp); }
    const jump = event.target.closest('[data-character-jump]');
    if (jump) {
      selectEditorModule('characters', { scroll: false });
      requestAnimationFrame(() => document.querySelector(`[data-character-card="${CSS.escape(jump.dataset.characterJump)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  });
  els.loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    els.loginError.textContent = '';
    try {
      const loginResult = await api('/api/auth/login', { method: 'POST', body: { password: els.loginPassword.value } });
      els.loginPassword.value = '';
      applyAuthContext(loginResult);
      await startApp(loginResult);
    } catch (error) { els.loginError.textContent = error.message; }
  });

  $('#logoutButton')?.addEventListener('click', async () => { clearDraft(); draftReady = false; draftRestored = false; await api('/api/auth/logout', { method: 'POST' }); showLogin(); });
  bindDraftAutosave();
  applyTagLayoutClass();
  bindNewLayoutControls();
  els.tagSelectionDock?.addEventListener('click', handleTagDockClick);
  document.addEventListener('click', event => {
    const quick = event.target.closest('[data-chip-quick]')?.dataset.chipQuick;
    if (!quick) return;
    event.preventDefault();
    event.stopPropagation();
    if (quick === 'delete') deleteSelectedTags();
    else handleTagDockClick({ target: els.tagSelectionDock.querySelector('[data-dock="edit"]') || event.target });
  }, true);
  window.addEventListener('resize', positionTagDock);
  window.addEventListener('resize', () => { if (activeMainTab === 'codex') codexPanel.stickHeader(); });
  els.tagSelectionDock?.addEventListener('change', event => {
    if (event.target.matches('[data-dock="move"]') && event.target.value) moveSelectedTags(event.target.value);
  });
  $('#tagUndoButton')?.addEventListener('click', () => stepTagHistory(-1));
  $('#tagRedoButton')?.addEventListener('click', () => stepTagHistory(1));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && tagSelection.size && !document.querySelector('dialog[open]')) { clearTagSelection(); return; }
    const typing = event.target.closest?.('input, textarea, select, [contenteditable="true"]') || document.querySelector('dialog[open]');
    if (!typing && tagSelection.size && (event.key === 'Delete' || event.key === 'Backspace')) { event.preventDefault(); deleteSelectedTags(); return; }
    if (typing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' || !$('#editorTab')?.classList.contains('active')) return;
    event.preventDefault();
    stepTagHistory(event.shiftKey ? 1 : -1);
  });
  els.saveVisitorPasswordButton?.addEventListener('click', async () => {
    try {
      const password = String(els.visitorPasswordInput?.value || '');
      const expiresHours = Number(els.visitorPasswordHours?.value || 24);
      await api('/api/auth/visitor-password', { method: 'POST', body: { password, expiresHours } });
      if (els.visitorPasswordInput) els.visitorPasswordInput.value = '';
      await refreshVisitorPasswordStatus();
      toast('临时参观密码已启用；请通过安全方式单独发送给访客。', 'success');
    } catch (error) { toast(error.message, 'error'); }
  });
  els.revokeVisitorPasswordButton?.addEventListener('click', async () => {
    try {
      await api('/api/auth/visitor-password', { method: 'DELETE' });
      await refreshVisitorPasswordStatus();
      toast('临时参观密码已作废，已有参观会话也已退出。', 'success');
    } catch (error) { toast(error.message, 'error'); }
  });
  $$('.tab').forEach(button => button.addEventListener('click', () => switchTabTo(button.dataset.tab)));
  document.querySelectorAll('[data-editor-nav]').forEach(button => button.addEventListener('click', () => {
    selectEditorModule(button.dataset.editorNav, { scroll: true });
  }));
  els.focusModeButton?.addEventListener('click', () => {
    editorFocusMode = !editorFocusMode;
    if (editorFocusMode && activeEditorModule === 'all') {
      const visible = GROUP_DEFS.find(([key]) => enabledTagCount(appState.groups[key] || []))?.[0] || 'scene';
      setEditorNavActive(visible);
    }
    applyEditorFocusMode({ scroll: editorFocusMode });
  });
  els.denseTagsButton?.addEventListener('click', () => setDenseTagsMode(!denseTagsMode));
  els.promptTagSearch?.addEventListener('input', event => {
    tagSearchQuery = event.target.value;
    applyTagSearch();
  });
  els.promptTagSearch?.addEventListener('keydown', event => {
    if (event.key === 'Escape' && event.currentTarget.value) {
      event.preventDefault();
      event.currentTarget.value = '';
      tagSearchQuery = '';
      applyTagSearch();
    }
  });
  // Open the native chooser directly.  Rendering the restore sheet first made
  // the first chooser invocation pay for a modal/backdrop layout pass and also
  // coupled image import to the optional onboarding overlay.
  els.restoreToolButton?.addEventListener('click', () => {
    if (inspectBusy) return;
    els.inspectImageFile?.click();
  });
  window.addEventListener('scroll', scheduleEditorScrollSync, { passive: true });
  els.installButton?.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    els.installButton.classList.add('hidden');
  });
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    els.installButton?.classList.remove('hidden');
  });

  els.promptPreview.addEventListener('input', () => { directPromptEdited = true; appState.prompt = els.promptPreview.value; updatePromptModeHint(); autoGrowTextarea(els.promptPreview); syncV5PromptBudget(els.promptPreview.value); });
  els.negativePrompt.addEventListener('input', () => { appState.negativePrompt = els.negativePrompt.value; autoGrowTextarea(els.negativePrompt); updatePromptPreviewFromStructure(); updateEditorModuleCounts(); });
  window.addEventListener('resize', debounce(() => {
    autoGrowTextarea(els.promptPreview);
    autoGrowTextarea(els.negativePrompt);
    syncGalleryMasonryForViewport();
    syncTopbarHeight();
  }, 120));
  $('#copyPromptButton').addEventListener('click', async () => { await navigator.clipboard.writeText(els.promptPreview.value); toast('Prompt 已复制。'); });
  $('#openNaiImportButton')?.addEventListener('click', openNaiImportDialog);
  $('#advancedOverrides')?.addEventListener('input', renderAdvancedOverrideSummary);
  els.cleanAdvancedOverridesButton?.addEventListener('click', () => {
    const textarea = $('#advancedOverrides');
    const raw = textarea?.value.trim() || '';
    if (!raw) return toast('高级覆盖 JSON 目前为空。');
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) {
      return toast('JSON 还不能清理：' + error.message, 'error');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return toast('高级覆盖必须是 JSON 对象。', 'error');
    const cleaned = filterAdvancedOverrides(parsed);
    const removed = Object.keys(parsed).length - Object.keys(cleaned).length;
    textarea.value = Object.keys(cleaned).length ? JSON.stringify(cleaned, null, 2) : '';
    renderAdvancedOverrideSummary();
    toast(removed ? '已移除 ' + removed + ' 个由工作流/普通控件/请求记录接管的字段。' : '没有发现需要清理的字段。', 'success');
  });

  els.generationModeSelect?.addEventListener('change', event => setGenerationMode(event.target.value));
  // Legacy button fallback for cached/embedded markup from pre-selector builds.
  document.querySelectorAll('[data-generation-mode]:not(option)').forEach(button => button.addEventListener('click', () => setGenerationMode(button.dataset.generationMode)));
  document.querySelectorAll('[data-reference-mode]').forEach(button => button.addEventListener('click', () => setReferenceMode(button.dataset.referenceMode)));
  els.chooseBaseImageButton?.addEventListener('click', () => openImagePicker({ kind: 'base' }));
  els.replaceBaseImageButton?.addEventListener('click', () => openImagePicker({ kind: 'base' }));
  els.clearBaseImageButton?.addEventListener('click', () => {
    const modeBeforeClear = workflowModeForState(appState);
    appState.imageWorkflow.baseImage = null;
    appState.imageWorkflow.maskImage = null;
    // Clearing the source must not silently switch an official Upscale or
    // Director request into Text mode. Keep the selected tool visible and let
    // the workflow panel report the missing input instead.
    appState.imageRecovery = modeBeforeClear === 'unknown'
      ? { status: 'unresolved', operation: 'unknown', label: '待确认', reason: '输入图片已清除；记录的工作流仍有歧义，请先选择生成方式。' }
      : null;
    appState.workflowMetadata = null;
    resetMaskCanvas();
    renderImageWorkflow();
  });
  els.imageStrength?.addEventListener('input', event => {
    appState.imageWorkflow.strength = Number(event.target.value);
    if (els.imageStrengthValue) els.imageStrengthValue.textContent = Number(event.target.value).toFixed(2);
  });
  els.imageNoise?.addEventListener('input', event => {
    appState.imageWorkflow.noise = Number(event.target.value);
    if (els.imageNoiseValue) els.imageNoiseValue.textContent = Number(event.target.value).toFixed(2);
  });
  els.imageColorCorrect?.addEventListener('change', event => { appState.imageWorkflow.colorCorrect = event.target.checked; });
  els.enhanceUpscaleFactor?.addEventListener('change', event => {
    appState.imageWorkflow.enhanceUpscaleFactor = event.target.value === 'max'
      ? (isV5Model() ? 'max' : DEFAULT_ENHANCE_UPSCALE_FACTOR)
      : Number(event.target.value) || DEFAULT_ENHANCE_UPSCALE_FACTOR;
    // A manual choice supersedes an imported target-size hint.  Keeping the
    // target would make a later generation silently jump back to the old
    // dimensions in stateForOfficialEnhance().
    appState.imageWorkflow.enhanceTargetWidth = null;
    appState.imageWorkflow.enhanceTargetHeight = null;
    if (appState.workflowMetadata) {
      appState.workflowMetadata.enhanceTargetWidth = null;
      appState.workflowMetadata.enhanceTargetHeight = null;
    }
    renderImageWorkflow();
  });
  els.officialDirectorPrompt?.addEventListener('input', event => {
    appState.imageTool.prompt = String(event.target.value || '').slice(0, 4000);
  });
  els.officialDirectorDefry?.addEventListener('change', event => {
    appState.imageTool.defry = Math.max(0, Math.min(5, Math.round(Number(event.target.value) || 0)));
  });
  // Adding fills an existing empty slot first (turning a reference mode on creates one),
  // so no image-less slot is left behind to fail the request.
  els.addPreciseReferenceButton?.addEventListener('click', () => {
    const list = appState.referenceControl.precise;
    let index = list.findIndex(item => !item?.image);
    if (index < 0) {
      if (list.length >= 16) return toast('这个 PWA 当前最多保留 16 个 Precise Reference 槽位。', 'error');
      list.push({ image: null, type: 'character', strength: .6, fidelity: .5 });
      index = list.length - 1;
    }
    renderImageWorkflow();
    openImagePicker({ kind: 'precise', index });
  });
  els.addVibeReferenceButton?.addEventListener('click', () => {
    const list = appState.referenceControl.vibes;
    let index = list.findIndex(item => !item?.image);
    if (index < 0) {
      if (list.length >= 16) return toast('Vibe Transfer 最多 16 张参考图。', 'error');
      list.push({ image: null, strength: .6, informationExtracted: 1 });
      index = list.length - 1;
    }
    renderImageWorkflow();
    openImagePicker({ kind: 'vibe', index });
  });
  els.normalizeVibeStrengthButton?.addEventListener('click', () => {
    const list = appState.referenceControl.vibes || [];
    const total = list.reduce((sum, item) => sum + Number(item.strength || 0), 0);
    if (total <= 0) return toast('当前 Vibe Strength 总和为 0。');
    list.forEach(item => { item.strength = Number(item.strength || 0) / total; });
    renderVibeReferences();
    toast('已把 Vibe Strength 总和归一化到 1.0。', 'success');
  });
  const cancelImagePicker = () => {
    imagePickerTarget = null;
    imagePickerActionToken += 1;
    els.imagePickerDialog?.close();
  };
  $('#closeImagePickerDialog')?.addEventListener('click', () => {
    if (imagePickerActionBusy) return toast('图片正在确认，请等待完成。', 'error');
    cancelImagePicker();
  });
  els.imagePickerDialog?.addEventListener('cancel', event => {
    if (!imagePickerActionBusy) return;
    event.preventDefault();
    toast('图片正在确认，请等待完成。', 'error');
  });
  els.imagePickerDialog?.addEventListener('close', () => {
    // Escape/programmatic close does not pass through the close button.
    // Invalidate the old target immediately so a late gallery/upload promise
    // cannot attach an asset to the next picker invocation.
    if (imagePickerTarget == null) return;
    imagePickerTarget = null;
    imagePickerActionToken += 1;
  });
  els.imagePickerDialog?.addEventListener('click', event => {
    if (event.target !== els.imagePickerDialog) return;
    if (imagePickerActionBusy) return toast('图片正在确认，请等待完成。', 'error');
    cancelImagePicker();
  });
  els.uploadWorkflowImageButton?.addEventListener('click', () => els.workflowImageFile?.click());
  els.refreshImagePickerGallery?.addEventListener('click', () => {
    const pickerToken = imagePickerActionToken;
    loadImagePickerGallery({ force: true, pickerToken }).catch(error => {
      // A refresh can finish after the dialog was closed or after a newer
      // picker took ownership of the same DOM.  Never surface stale errors in
      // that newer context (or pop a misleading toast after the user moved on).
      if (!pickerUiIsCurrent(pickerToken)) return;
      if (els.imagePickerStatus) {
        els.imagePickerStatus.classList.remove('hidden');
        els.imagePickerStatus.textContent = `读取图库失败：${error.message}`;
      }
      toast(error.message, 'error');
    });
  });
  els.workflowImageFile?.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (imagePickerActionBusy) return;
    imagePickerActionBusy = true;
    const actionToken = imagePickerActionToken;
    try {
      els.uploadWorkflowImageButton.disabled = true;
      if (els.refreshImagePickerGallery) els.refreshImagePickerGallery.disabled = true;
      if (els.imagePickerStatus) {
        els.imagePickerStatus.classList.remove('hidden');
        els.imagePickerStatus.textContent = '正在上传并保存输入图片…';
      }
      const asset = await uploadWorkflowFile(file);
      if (!applyWorkflowAsset(asset, actionToken)) throw new Error('图片选择已取消，请重新选择。');
      if (els.imagePickerStatus) els.imagePickerStatus.textContent = '图片已上传并确认。';
      toast('图片已上传并确认。', 'success');
    } catch (error) {
      toast(error.message, 'error');
      if (els.imagePickerStatus) els.imagePickerStatus.textContent = `上传失败：${error.message}`;
    } finally {
      imagePickerActionBusy = false;
      els.uploadWorkflowImageButton.disabled = false;
      if (els.refreshImagePickerGallery) els.refreshImagePickerGallery.disabled = false;
    }
  });

  els.maskBrushButton?.addEventListener('click', () => { maskTool = 'brush'; els.maskBrushButton.classList.add('active'); els.maskEraserButton?.classList.remove('active'); });
  els.maskEraserButton?.addEventListener('click', () => { maskTool = 'eraser'; els.maskEraserButton.classList.add('active'); els.maskBrushButton?.classList.remove('active'); });
  els.maskClearButton?.addEventListener('click', () => {
    const canvas = els.inpaintMaskCanvas;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    markMaskUnsaved('Mask 已清空，生成时会自动保存。');
    maskDirty = true; maskHasPaint = false; pushMaskHistory();
    if (els.maskStatus) els.maskStatus.textContent = 'Mask 已清空。';
  });
  els.maskInvertButton?.addEventListener('click', invertMask);
  els.maskUndoButton?.addEventListener('click', () => { if (maskHistoryIndex > 0) { maskHistoryIndex -= 1; restoreMaskSnapshot(maskHistoryIndex); } });
  els.maskRedoButton?.addEventListener('click', () => { if (maskHistoryIndex < maskHistory.length - 1) { maskHistoryIndex += 1; restoreMaskSnapshot(maskHistoryIndex); } });
  els.inpaintMaskCanvas?.addEventListener('pointerdown', event => {
    if (!appState.imageWorkflow?.baseImage) return;
    event.preventDefault();
    maskDrawing = true;
    els.inpaintMaskCanvas.setPointerCapture?.(event.pointerId);
    maskLastPoint = maskPoint(event);
    drawMaskSegment(maskLastPoint, maskLastPoint);
  });
  els.inpaintMaskCanvas?.addEventListener('pointermove', event => {
    if (!maskDrawing) return;
    event.preventDefault();
    const point = maskPoint(event);
    drawMaskSegment(maskLastPoint, point);
    maskLastPoint = point;
  });
  const finishMaskStroke = event => {
    if (!maskDrawing) return;
    maskDrawing = false;
    try { els.inpaintMaskCanvas?.releasePointerCapture?.(event.pointerId); } catch {}
    pushMaskHistory();
  };
  els.inpaintMaskCanvas?.addEventListener('pointerup', finishMaskStroke);
  els.inpaintMaskCanvas?.addEventListener('pointercancel', finishMaskStroke);
  $('#closeNaiImportDialog')?.addEventListener('click', () => els.naiImportDialog?.close());
  els.naiImportDialog?.addEventListener('click', event => { if (event.target === els.naiImportDialog) els.naiImportDialog.close(); });
  els.naiImportReview?.addEventListener('click', event => {
    const toggle = event.target.closest('[data-import-repair-toggle]');
    const all = event.target.closest('[data-import-repair-all]');
    if (toggle) {
      const id = toggle.dataset.importRepairToggle;
      if (naiImportDisabledRepairIds.has(id)) naiImportDisabledRepairIds.delete(id);
      else naiImportDisabledRepairIds.add(id);
      if (currentNaiImport) renderNaiImportPreview(currentNaiImport);
    } else if (all && currentNaiImport) {
      const issueIds = analyzeImportedPrompt(currentNaiImport).repairPlan.issues.map(issue => issue.id);
      if (all.dataset.importRepairAll === 'restore') issueIds.forEach(id => naiImportDisabledRepairIds.add(id));
      else naiImportDisabledRepairIds.clear();
      renderNaiImportPreview(currentNaiImport);
    }
  });
  $('#analyzeNaiImportButton')?.addEventListener('click', () => {
    try { analyzeNaiImportFromDialog(); } catch (error) { resetNaiImportPreview(`识别失败：${error.message}`); toast(error.message, 'error'); }
  });
  $('#importNaiStructuredButton')?.addEventListener('click', () => applyNaiImport({ structured: true, generate: false }).catch(error => toast(error.message, 'error')));
  $('#importNaiDirectButton')?.addEventListener('click', () => applyNaiImport({ structured: false, generate: true }).catch(error => toast(error.message, 'error')));
  els.naiImportText?.addEventListener('input', debounce(() => {
    naiImportDisabledRepairIds.clear();
    if (!els.naiImportText.value.trim()) {
      resetNaiImportPreview();
      return;
    }
    try { analyzeNaiImportFromDialog(); } catch (error) {
      resetNaiImportPreview();
      if (els.naiImportSummary) els.naiImportSummary.innerHTML = `<div class="import-stat"><span>识别失败</span><b>${escapeHtml(error.message)}</b></div>`;
    }
  }, 350));
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-artist-preview]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    openArtistPreview(button);
  });
  $('#closeArtistPreviewDialog')?.addEventListener('click', closeArtistPreview);
  els.artistPreviewDialog?.addEventListener('close', () => {
    if (!els.artistPreviewDialog.open) closeArtistPreview();
  });
  els.artistPreviewDialog?.addEventListener('click', event => { if (event.target === els.artistPreviewDialog) closeArtistPreview(); });
  els.artistPreviewReject?.addEventListener('click', rejectArtistPreview);
  els.artistPreviewAddPrefix?.addEventListener('click', addArtistPrefixFromPreview);
  els.artistPreviewImage?.addEventListener('load', () => {
    if (!activeArtistPreview || activeArtistPreview.timedOut || activeArtistPreview.requestId !== Number(els.artistPreviewImage.dataset.previewRequestId)) return;
    clearArtistPreviewLoadTimer();
    els.artistPreviewImage.classList.remove('hidden');
    els.artistPreviewFallback.classList.add('hidden');
    els.artistPreviewRetry?.classList.add('hidden');
    els.artistPreviewStatus.textContent = activeArtistPreview.artist.explicit
      ? '已由 artist: 前缀确认 · NAX V5 参考样图'
      : 'NAX V5 精确名单命中 · 请审核是否加入 artist:';
  });
  els.artistPreviewImage?.addEventListener('error', () => {
    if (!activeArtistPreview || activeArtistPreview.timedOut || activeArtistPreview.requestId !== Number(els.artistPreviewImage.dataset.previewRequestId)) return;
    clearArtistPreviewLoadTimer();
    els.artistPreviewImage.classList.add('hidden');
    els.artistPreviewFallback.textContent = 'NAX V5 对照图暂时载入失败；可直接打开 NAX 作者搜索或 Danbooru。';
    els.artistPreviewFallback.classList.remove('hidden');
    els.artistPreviewRetry?.classList.remove('hidden');
    els.artistPreviewStatus.textContent = '画师已识别 · 远程预览暂不可用';
  });
  els.artistPreviewRetry?.addEventListener('click', retryArtistPreview);
  $('#smartImportPromptButton').addEventListener('click', () => importPromptToCards(true));
  $('#importPromptButton').addEventListener('click', () => importPromptToCards(false));
  $('#syncPromptButton').addEventListener('click', () => {
    directPromptEdited = false;
    compilePromptToPreview(true);
    toast('已用 Tag 卡片重新编译 Prompt。', 'success');
  });
  $('#clearTagsButton').addEventListener('click', async () => {
    if (!(await confirmAction('清空全部 Tag？', { confirmLabel: '清空', danger: true }))) return;
    for (const [key] of GROUP_DEFS) appState.groups[key] = [];
    appState.characters = [];
    renderCharacters();
    renderTagGroups();
    compilePromptToPreview(true);
  });
  $('#translateMissingButton').addEventListener('click', () => translateMissingTags());
  els.addCharacterButton?.addEventListener('click', () => addCharacter());
  els.characterUseCoords?.addEventListener('change', event => {
    appState.v4Options.useCoords = event.target.checked;
    renderCharacters();
    toast(event.target.checked ? '已开启角色位置引导。' : '已交回 AI 自动安排角色位置。');
  });
  $('#expandTagGroupsButton').addEventListener('click', () => {
    for (const [key] of GROUP_DEFS) openTagGroups.add(key);
    renderTagGroups();
  });
  $('#collapseTagGroupsButton').addEventListener('click', () => {
    openTagGroups.clear();
    renderTagGroups();
  });
  $('#showTranslations').addEventListener('change', event => {
    storageSet('nai-pocket-show-translations', event.target.checked ? '1' : '0');
    $$('.tag-card').forEach(card => card.classList.toggle('translations-hidden', !event.target.checked));
  });
  els.promptOrderMode?.addEventListener('change', event => {
    appState.promptOrderMode = event.target.value === 'original' ? 'original' : 'grouped';
    if (appState.promptOrderMode === 'original') ensureGlobalOriginalOrder();
    compilePromptToPreview();
    updatePromptModeHint();
    renderPromptGroupOrder();
    toast(appState.promptOrderMode === 'original' ? '已切到保持顺序：分类整理不再改变生成先后。' : `已切到分组顺序：按 ${globalPromptOrderLabel()} 构造。`);
  });
  $$('[data-prompt-order]').forEach(button => button.addEventListener('click', () => {
    if (!els.promptOrderMode || els.promptOrderMode.value === button.dataset.promptOrder) return;
    els.promptOrderMode.value = button.dataset.promptOrder;
    els.promptOrderMode.dispatchEvent(new Event('change'));
  }));
  $('#promptGroupOrder')?.addEventListener('click', event => {
    const move = event.target.closest('[data-group-earlier]'); if (!move) return;
    const order = [...globalPromptOrder()], index = order.indexOf(move.dataset.groupEarlier);
    if (index <= 0) return;
    [order[index - 1], order[index]] = [order[index], order[index - 1]];
    setGlobalPromptOrder(order);
    compilePromptToPreview();
    renderPromptGroupOrder();
    $('#promptGroupOrder')?.querySelector(`[data-group-earlier="${move.dataset.groupEarlier}"]`)?.focus();
  });
  renderPromptGroupOrder();
  els.rebuildPromptOrderButton?.addEventListener('click', async () => {
    if (!(await confirmAction(`按当前分组（${globalPromptOrderLabel()}）把 Prompt 顺序重排一次？之后继续保持这个顺序。`, { confirmLabel: '重排' }))) return;
    const count = rebuildGlobalOriginalOrderFromGrouped();
    appState.promptOrderMode = 'original';
    compilePromptToPreview();
    updatePromptModeHint();
    toast(`已按分组重排 ${count} 个 Tag。`, 'success');
  });
  $('#clearNegativeButton').addEventListener('click', () => { els.negativePrompt.value = ''; appState.negativePrompt = ''; updatePromptPreviewFromStructure(); });

  $('#closeSemanticDialog').addEventListener('click', () => els.semanticDialog.close());
  $('#semanticSearchButton').addEventListener('click', () => runSemanticSearch());
  $('#semanticRelatedButton').addEventListener('click', () => runSemanticRelated());
  $('#semanticArtistsButton').addEventListener('click', () => runSemanticArtists());
  els.semanticAddSelectedButton?.addEventListener('click', addSelectedSemanticTags);
  els.semanticClearSelectedButton?.addEventListener('click', clearSemanticSelection);
  els.semanticMode?.addEventListener('change', () => applySemanticModePreset(els.semanticMode.value, { announce: true }));
  [els.semanticTopK, els.semanticLimit, els.semanticPopularityWeight, els.semanticUseSegmentation, els.semanticGroupMode, els.semanticMaxPerGroup, els.semanticShowNsfw, els.semanticDisplaySemantic, els.semanticDisplayLayer, els.semanticDisplaySource, els.semanticRelatedLimit, els.semanticArtistLimit].filter(Boolean).forEach(control => control.addEventListener('input', () => {
    updateSemanticAdvancedUi();
    if (semanticLastSearchData && [els.semanticDisplaySemantic, els.semanticDisplayLayer, els.semanticDisplaySource].includes(control)) renderSemanticTagResults(semanticLastSearchData, 'search', els.semanticResults);
  }));
  $$('[data-semantic-layer], [data-semantic-category]').forEach(control => control.addEventListener('change', saveSemanticSettings));
  els.semanticSeedSource?.addEventListener('change', () => { saveSemanticSettings(); updateSemanticSelectionSummary(); scheduleSemanticRecommendationRefresh(); });
  els.semanticQuery.addEventListener('keydown', event => {
    // New layout: Enter searches (Shift+Enter for a new line); legacy keeps Ctrl+Enter.
    const plainEnter = event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && tagLayout() !== 'legacy';
    if (plainEnter || ((event.ctrlKey || event.metaKey) && event.key === 'Enter')) {
      event.preventDefault();
      runSemanticSearch();
    }
  });
  $$('[data-semantic-mode-chip]').forEach(button => button.addEventListener('click', () => {
    if (els.semanticMode.value === button.dataset.semanticModeChip) return;
    els.semanticMode.value = button.dataset.semanticModeChip;
    els.semanticMode.dispatchEvent(new Event('change'));
  }));
  $$('[data-semantic-seed-chip]').forEach(button => button.addEventListener('click', () => {
    els.semanticSeedSource.value = button.dataset.semanticSeedChip;
    els.semanticSeedSource.dispatchEvent(new Event('change'));
  }));
  // The bar under a selection: clear, add, or recommend from it.
  $('#semanticActionBar')?.addEventListener('click', event => {
    const action = event.target.closest('[data-semantic-bar]')?.dataset.semanticBar;
    if (action === 'clear') clearSemanticSelection();
    if (action === 'add') addSelectedSemanticTags();
    if (action === 'related' || action === 'artists') {
      if (els.semanticSeedSource.value !== 'selected') { els.semanticSeedSource.value = 'selected'; saveSemanticSettings(); syncSemanticChips(); }
      $('.semantic-recommendation-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (action === 'related') runSemanticRelated(); else runSemanticArtists();
    }
  });
  els.semanticDialog.addEventListener('click', event => {
    if (event.target === els.semanticDialog && !semanticBusy) els.semanticDialog.close();
  });
  els.floatingQueueButton?.addEventListener('click', () => switchTabTo('queue'));

  els.tagEditorGroup.innerHTML = tagEditorDestinationOptions({ scope: 'global' });
  els.tagEditorForm.addEventListener('submit', event => {
    event.preventDefault();
    saveTagEditor().catch(error => toast(error.message, 'error'));
  });
  $('#closeTagEditorButton').addEventListener('click', closeTagEditor);
  $('#tagEditorCancel').addEventListener('click', closeTagEditor);
  $('#tagEditorTranslateButton').addEventListener('click', autoTranslateEditorTag);
  $('#tagEditorDelete').addEventListener('click', deleteEditingTag);
  els.tagEditorText.addEventListener('input', () => syncTagEditorDraft('text'));
  els.tagEditorTranslation.addEventListener('input', () => syncTagEditorDraft('translation'));
  els.tagEditorDialog.addEventListener('cancel', () => { editingTagRef = null; translationDraft = null; });
  els.tagEditorDialog.addEventListener('click', event => {
    if (event.target === els.tagEditorDialog) closeTagEditor();
  });

  $('#openSchemeLibraryButton')?.addEventListener('click', () => switchTabTo('scheme'));
  $('#schemeLibrarySaveCurrent')?.addEventListener('click', () => saveSchemeFromEditor(els.schemeLibraryName?.value).catch(error => toast(error.message, 'error')));
  $('#saveSnippetButton')?.addEventListener('click', () => saveSnippet().catch(error => toast(error.message, 'error')));

  $('#model').addEventListener('change', event => {
    const sampling = syncSamplingOptions(event.target.value, {
      sampler: $('#sampler').value,
      noiseSchedule: $('#noiseSchedule').value
    });
    appState.model = event.target.value;
    appState.params.sampler = sampling.sampler;
    appState.params.noiseSchedule = sampling.noiseSchedule;
    if (appState.referenceControl?.mode === 'precise' && !supportsPreciseReference(event.target.value)) {
      appState.referenceControl.mode = 'none';
      toast('已关闭 Precise Reference：它当前只支持 V4.5。');
    }
    if (appState.referenceControl?.mode === 'vibe' && !supportsVibeTransfer(event.target.value)) {
      appState.referenceControl.mode = 'none';
      toast('已关闭 Vibe Transfer：V5 首发暂不支持。');
    }
    if (!isV5Model(event.target.value) && appState.characters.length > DEFAULT_CHARACTER_LIMIT) {
      toast(`当前方案有超过 ${DEFAULT_CHARACTER_LIMIT} 个角色；V4/V4.5 生成时只会发送前 ${DEFAULT_CHARACTER_LIMIT} 个启用角色。`);
    }
    if ($('#nativeAlpha')) $('#nativeAlpha').disabled = !isV5Model(event.target.value);
    if (!isV5Model(event.target.value) && appState.imageWorkflow?.enhanceUpscaleFactor === 'max') {
      appState.imageWorkflow.enhanceUpscaleFactor = DEFAULT_ENHANCE_UPSCALE_FACTOR;
    }
    renderCharacters();
    renderImageWorkflow();
    syncV5PromptBudget(els.promptPreview.value);
  });

  els.generationProvider?.addEventListener('change', event => {
    appState.provider = normalizeProviderId(event.target.value);
    syncProviderUi();
    if (authContext.role !== 'owner') return;
    if (appState.provider === 'official') refreshNaiAccount(false).catch(() => {});
    else if (appState.provider === 'rbq') refreshRbqAccount(false).catch(() => {});
  });
  els.officialAccountSelect?.addEventListener('change', event => {
    appState.officialAccountId = String(event.target.value || '');
    latestNaiAccount = null;
    syncProviderUi();
    if (authContext.role !== 'owner') return;
    refreshNaiAccount(false).catch(() => {});
  });
  els.saveOfficialTokenButton?.addEventListener('click', () => saveOfficialToken().catch(error => toast(error.message, 'error')));
  els.cancelOfficialTokenEdit?.addEventListener('click', resetOfficialTokenForm);
  els.officialAccountList?.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-edit-official-account')) {
      beginOfficialTokenEdit(String(button.dataset.editOfficialAccount || ''));
    } else if (button.hasAttribute('data-default-official-account')) {
      setDefaultOfficialAccount(String(button.dataset.defaultOfficialAccount || '')).catch(error => toast(error.message, 'error'));
    } else if (button.hasAttribute('data-reset-official-env')) {
      resetOfficialEnvToken().catch(error => toast(error.message, 'error'));
    } else if (button.hasAttribute('data-delete-official-account')) {
      deleteOfficialAccount(String(button.dataset.deleteOfficialAccount || '')).catch(error => toast(error.message, 'error'));
    }
  });
  els.saveRbqKeyButton?.addEventListener('click', () => saveRbqKey().catch(error => toast(error.message, 'error')));
  $('#relayKind')?.addEventListener('change', syncRelayForm);
  $('#cancelRelayEdit')?.addEventListener('click', resetRelayForm);
  $('#relayList')?.addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-relay]');
    if (edit) return beginRelayEdit(edit.dataset.editRelay);
    const remove = event.target.closest('[data-delete-relay]');
    if (remove) deleteRelay(remove.dataset.deleteRelay).catch(error => toast(error.message, 'error'));
  });

  $('#sizePreset').addEventListener('change', event => {
    if (event.target.value === 'custom') return;
    const [width, height] = event.target.value.split('x');
    $('#width').value = width; $('#height').value = height;
    if ($('#aspectRatio')) $('#aspectRatio').value = 'free';
  });
  $('#width').addEventListener('change', () => syncEditedDimensions('width'));
  $('#height').addEventListener('change', () => syncEditedDimensions('height'));
  $('#aspectRatio')?.addEventListener('change', () => syncEditedDimensions('width'));
  $('#swapDimensionsButton')?.addEventListener('click', () => {
    const width = $('#width').value;
    $('#width').value = $('#height').value;
    $('#height').value = width;
    const aspect = $('#aspectRatio');
    if (aspect && aspect.value !== 'free') aspect.value = aspect.value.split(':').reverse().join(':');
    syncEditedDimensions('width');
  });
  $('#seedMode').addEventListener('change', () => { $('#seed').disabled = $('#seedMode').value === 'random'; });
  $('#seedMode').dispatchEvent(new Event('change'));

  $$('.generate-button').forEach(button => button.addEventListener('click', () => enqueue(button === els.floatingGenerateButton ? selectedBatchCount() : Number(button.dataset.count)).catch(error => toast(error.message, 'error'))));
  $('#batchCount')?.addEventListener('change', syncBatchCount);
  $('#customCount').addEventListener('input', syncBatchCount);
  syncBatchCount();
  els.refreshNaiAccountButton?.addEventListener('click', () => refreshNaiAccount(true));
  els.refreshRbqAccountButton?.addEventListener('click', () => refreshRbqAccount(true));
  els.accountUsagePanel?.addEventListener('toggle', () => storageSet('nai-pocket-account-usage-open', els.accountUsagePanel.open ? '1' : '0'));
  [els.stormCount, els.stormDelta, els.stormMode].filter(Boolean).forEach(control => control.addEventListener('input', renderStormPlan));
  els.artistStormPanel?.addEventListener('toggle', () => { if (els.artistStormPanel.open) renderStormPlan(); });
  els.refreshStormPlanButton?.addEventListener('click', renderStormPlan);
  els.generateStormButton?.addEventListener('click', () => generateArtistStorm().catch(error => toast(error.message, 'error')));
  els.stormUseExternalArtists?.addEventListener('change', () => {
    if (els.stormExternalControls) els.stormExternalControls.hidden = !els.stormUseExternalArtists.checked;
    if (els.stormUseExternalArtists.checked && !stormExternalArtistPool.length) loadStormExternalArtists().catch(error => toast(error.message, 'error'));
    renderStormPlan();
  });
  els.refreshStormExternalArtistsButton?.addEventListener('click', () => loadStormExternalArtists().catch(error => toast(error.message, 'error')));
  els.stormExternalPoolSize?.addEventListener('input', () => {
    stormExternalArtistPool = [];
    renderStormExternalArtists('点击“换一批画师”重新抽取。');
    renderStormPlan();
  });
  $('#pauseQueueButton').addEventListener('click', async () => { await api('/api/jobs/pause', { method: 'POST' }); refreshJobs(); });
  $('#resumeQueueButton').addEventListener('click', async () => { await api('/api/jobs/resume', { method: 'POST' }); refreshJobs(); });
  $('#queueRerouteButton')?.addEventListener('click', openQueueRouteMenu);
  $('#queueCancelAllButton')?.addEventListener('click', () => cancelAllQueued().catch(error => toast(error.message, 'error')));
  els.loadMoreButton.addEventListener('click', loadGallery);
  els.favoriteOnly.addEventListener('change', () => resetGallery(false).catch(error => toast(error.message, 'error')));
  els.galleryAgeFilter?.addEventListener('change', () => {
    syncGalleryTimeControls();
    resetGallery(false).catch(error => toast(error.message, 'error'));
  });
  // Switching the gallery view reloads from the start: the two lists share the
  // search and time filters but never the images.
  const setGalleryScope = scope => {
    const next = ['rotation', 'iteration', 'trash'].includes(scope) ? scope : 'gallery';
    if (next === galleryScope) return;
    galleryScope = next;
    syncGalleryScopeControls();
    (next === 'trash' ? renderTrashView() : resetGallery(false)).catch(error => toast(error.message, 'error'));
  };
  els.galleryScopeGallery?.addEventListener('click', () => setGalleryScope('gallery'));
  els.galleryScopeRotation?.addEventListener('click', () => setGalleryScope('rotation'));
  els.galleryScopeIteration?.addEventListener('click', () => setGalleryScope('iteration'));
  $('#galleryScopeTrash')?.addEventListener('click', () => setGalleryScope('trash'));
  els.galleryMonthFilter?.addEventListener('change', () => resetGallery(false).catch(error => toast(error.message, 'error')));
  [els.galleryDateFrom, els.galleryDateTo].filter(Boolean).forEach(control => control.addEventListener('change', () => {
    if (els.galleryAgeFilter?.value !== 'custom') return;
    resetGallery(false).catch(error => toast(error.message, 'error'));
  }));
  els.galleryNewImagesButton?.addEventListener('click', () => {
    if (loadPendingGalleryImages({ force: true })) return;
    resetGallery(false).catch(error => toast(error.message, 'error'));
  });
  els.gallerySearch?.addEventListener('input', () => {
    if (galleryFilterTimer) clearTimeout(galleryFilterTimer);
    galleryFilterTimer = window.setTimeout(() => {
      galleryFilterTimer = 0;
      resetGallery(false).catch(error => toast(error.message, 'error'));
    }, 320);
  });
  els.galleryCleanupToggle?.addEventListener('click', () => {
    setGalleryCleanupMode(!galleryCleanupMode).catch(error => toast(error.message, 'error'));
  });
  els.gallerySelectToggle?.addEventListener('click', async () => {
    if (galleryCleanupMode) {
      await setGalleryCleanupMode(false);
    }
    gallerySelectionMode = !gallerySelectionMode;
    if (!gallerySelectionMode) selectedGalleryIds.clear();
    updateGallerySelectionUi();
    if (!gallerySelectionMode) tryAutoLoadPendingGalleryImages();
  });
  // 完成 sits beside the count, so leaving batch mode does not require the ⋯ menu.
  els.galleryExitSelection?.addEventListener('click', () => { if (gallerySelectionMode) els.gallerySelectToggle?.click(); });
  els.gallerySelectAll?.addEventListener('click', () => {
    selectedGalleryIds.clear();
    document.querySelectorAll('[data-gallery-id]').forEach(card => selectedGalleryIds.add(card.dataset.galleryId));
    updateGallerySelectionUi();
  });
  els.gallerySelectNonFavorites?.addEventListener('click', () => {
    selectedGalleryIds.clear();
    document.querySelectorAll('[data-gallery-id]').forEach(card => {
      if (card.dataset.favorite !== '1') selectedGalleryIds.add(card.dataset.galleryId);
    });
    updateGallerySelectionUi();
  });
  els.galleryClearSelection?.addEventListener('click', () => { selectedGalleryIds.clear(); updateGallerySelectionUi(); });
  els.galleryDeleteSelected?.addEventListener('click', () => deleteSelectedGallery().catch(error => toast(error.message, 'error')));
  els.cleanupUndoButton?.addEventListener('click', () => undoCleanupDelete().catch(error => toast(error.message, 'error')));
  els.cleanupDeleteButton?.addEventListener('click', () => deleteCleanupCurrentImage().catch(error => toast(error.message, 'error')));
  els.cleanupKeepButton?.addEventListener('click', () => cleanupKeepAndNext().catch(error => toast(error.message, 'error')));
  els.cleanupLoadOriginalButton?.addEventListener('click', () => cleanupLoadOriginal().catch(error => toast(error.message, 'error')));
  els.cleanupFavoriteButton?.addEventListener('click', () => { if (currentImage) toggleGalleryFavorite(currentImage).catch(error => toast(error.message, 'error')); });
  els.cleanupJumpButton?.addEventListener('click', () => cleanupJumpToPosition().catch(error => toast(error.message, 'error')));
  els.cleanupJumpInput?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    cleanupJumpToPosition().catch(error => toast(error.message, 'error'));
  });

  els.inspectImageFile?.addEventListener('change', event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    inspectImageFile(file).catch(error => toast(error.message, 'error'));
  });
  let inspectDragDepth = 0;
  window.addEventListener('dragenter', event => {
    if (!Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file')) return;
    event.preventDefault();
    inspectDragDepth += 1;
    els.inspectDropOverlay?.classList.remove('hidden');
  });
  window.addEventListener('dragover', event => {
    if (!Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', event => {
    event.preventDefault();
    inspectDragDepth = Math.max(0, inspectDragDepth - 1);
    if (inspectDragDepth === 0) els.inspectDropOverlay?.classList.add('hidden');
  });
  window.addEventListener('drop', event => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    event.preventDefault();
    inspectDragDepth = 0;
    els.inspectDropOverlay?.classList.add('hidden');
    inspectImageFile(file).catch(error => toast(error.message, 'error'));
  });
  $('#closeInspectDialog')?.addEventListener('click', closeInspectDialog);
  $('#inspectPromptOnly')?.addEventListener('click', () => {
    restoreInspection(false).catch(error => toast(error.message, 'error'));
  });
  $('#inspectRestoreAll')?.addEventListener('click', () => {
    restoreInspection(true).catch(error => toast(error.message, 'error'));
  });
  els.inspectDialog?.addEventListener('click', event => { if (event.target === els.inspectDialog) closeInspectDialog(); });

  $('#closeDialogButton').addEventListener('click', () => {
    els.imageDialog.close();
    if (galleryCleanupMode) {
      galleryCleanupMode = false;
      updateGallerySelectionUi();
      settleCleanupDeletes().then(tryAutoLoadPendingGalleryImages).catch(() => {});
    }
  });
  els.imageDialog?.addEventListener('cancel', () => {
    if (!galleryCleanupMode) return;
    galleryCleanupMode = false;
    updateGallerySelectionUi();
    settleCleanupDeletes().then(tryAutoLoadPendingGalleryImages).catch(() => {});
  });
  els.imageDialog?.addEventListener('close', () => window.setTimeout(tryAutoLoadPendingGalleryImages, 0));
  window.addEventListener('scroll', () => {
    if (activeMainTab === 'gallery' && pendingGalleryImages.size) tryAutoLoadPendingGalleryImages();
  }, { passive: true });
  window.addEventListener('keydown', event => {
    if (!galleryCleanupMode || !els.imageDialog?.open) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteCleanupCurrentImage().catch(error => toast(error.message, 'error'));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      cleanupKeepAndNext().catch(error => toast(error.message, 'error'));
    } else if (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'u') {
      event.preventDefault();
      undoCleanupDelete().catch(error => toast(error.message, 'error'));
    } else if (event.key.toLowerCase() === 'f' && currentImage) {
      event.preventDefault();
      toggleGalleryFavorite(currentImage).catch(error => toast(error.message, 'error'));
    }
  });
  els.dialogPrevious?.addEventListener('click', () => navigateImageDialog(-1).catch(error => toast(error.message, 'error')));
  els.dialogNext?.addEventListener('click', () => navigateImageDialog(1).catch(error => toast(error.message, 'error')));
  els.dialogFavorite.addEventListener('click', () => switchFavorite().catch(error => toast(error.message, 'error')));
  els.dialogLoadOriginal?.addEventListener('click', () => loadCurrentOriginal().catch(error => toast(error.message, 'error')));
  els.dialogDownload?.addEventListener('click', openDownloadChoice);
  els.dialogCreateFromImage?.addEventListener('click', () => els.imageCreateDialog?.showModal());
  // 以此图搜索相似: the artist library's similar panel is hosted by the artists tab, and a panel
  // opened while its host is off screen is refused (the 0×0-modal fix), so the tab switch is the
  // library's job — `openSimilarImage` switches first and opens second. This dialog is closed
  // before that so the panel cannot end up behind it, which is the same reason the panel's own
  // result click closes the panel before loading the detail.
  els.dialogSimilarFromImage?.addEventListener('click', () => {
    if (!currentImage?.id) return;
    const image = currentImage;
    els.imageDialog?.close();
    ensureArtistLibrary().openSimilarImage(image.id, image.seed ? `Seed ${image.seed}` : '图库图片');
  });
  $('#dialogPayload')?.addEventListener('toggle', syncDialogPayload);
  $('#dialogPayloadCopy')?.addEventListener('click', () => {
    const text = $('#dialogPayloadJson')?.textContent || '';
    if (!text.startsWith('{')) return toast('参数还没有读取完成。');
    navigator.clipboard.writeText(text).then(() => toast('已复制全部参数 JSON。', 'success')).catch(() => toast('复制失败，浏览器未允许访问剪贴板。', 'error'));
  });
  // Gallery ⋯ (new layout): each item stands in for an original button, so state and
  // behavior stay in one place; the menu shows the toggles' current state.
  const galleryMore = $('#galleryMoreMenu');
  const setGalleryMore = open => {
    if (!galleryMore) return;
    galleryMore.hidden = !open;
    $('#galleryMoreButton')?.setAttribute('aria-expanded', String(open));
    if (open) galleryMore.querySelectorAll('[data-gallery-proxy]').forEach(item => {
      const pressed = $(`#${item.dataset.galleryProxy}`)?.getAttribute('aria-pressed');
      if (pressed) item.setAttribute('aria-checked', pressed); else item.removeAttribute('aria-checked');
    });
  };
  $('#galleryMoreButton')?.addEventListener('click', () => setGalleryMore(galleryMore.hidden));
  galleryMore?.addEventListener('click', event => {
    const proxy = event.target.closest('[data-gallery-proxy]');
    if (!proxy) return;
    setGalleryMore(false);
    $(`#${proxy.dataset.galleryProxy}`)?.click();
  });
  document.addEventListener('pointerdown', event => { if (galleryMore && !galleryMore.hidden && !event.target.closest('.gallery-more')) setGalleryMore(false); });
  // 方案 ⋯: 导出备份 / 导入备份 click the original buttons.
  const schemeMore = $('#schemeMoreMenu');
  const setSchemeMore = open => {
    if (!schemeMore) return;
    schemeMore.hidden = !open;
    $('#schemeMoreButton')?.setAttribute('aria-expanded', String(open));
  };
  $('#schemeMoreButton')?.addEventListener('click', () => setSchemeMore(schemeMore.hidden));
  schemeMore?.addEventListener('click', event => {
    const proxy = event.target.closest('[data-scheme-proxy]');
    if (!proxy) return;
    setSchemeMore(false);
    $(`#${proxy.dataset.schemeProxy}`)?.click();
  });
  document.addEventListener('pointerdown', event => { if (schemeMore && !schemeMore.hidden && !event.target.closest('.scheme-more')) setSchemeMore(false); });
  // 反推 Tag from a gallery image, or from an image picked on the device (⋯ 图片反推…).
  $('#dialogTaggerFromImage')?.addEventListener('click', () => {
    if (!currentImage?.id) return;
    const image = currentImage;
    els.imageDialog?.close();
    taggerPanel.open({ imageId: image.id, label: image.seed ? `Seed ${image.seed}` : '图库图片' });
  });
  $('#taggerFile')?.addEventListener('change', event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) taggerPanel.open({ file });
  });
  $('#closeImageCreateDialog')?.addEventListener('click', () => els.imageCreateDialog?.close());
  els.imageCreateDialog?.addEventListener('click', event => { if (event.target === els.imageCreateDialog) els.imageCreateDialog.close(); });
  els.imageCreateDialog?.querySelectorAll('[data-create-from-image]').forEach(button => button.addEventListener('click', async () => {
    if (imageCreateActionBusy) return;
    imageCreateActionBusy = true;
    const choices = [...els.imageCreateDialog.querySelectorAll('[data-create-from-image]')];
    const originalLabel = button.innerHTML;
    choices.forEach(choice => { choice.disabled = true; });
    button.textContent = '正在复制图片…';
    try {
      await createFromCurrentGalleryImage(button.dataset.createFromImage);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      imageCreateActionBusy = false;
      choices.forEach(choice => { choice.disabled = false; });
      button.innerHTML = originalLabel;
    }
  }));
  $('#closeDownloadChoiceDialog')?.addEventListener('click', () => els.downloadChoiceDialog?.close());
  els.downloadChoiceDialog?.addEventListener('click', event => { if (event.target === els.downloadChoiceDialog) els.downloadChoiceDialog.close(); });
  $('#downloadOriginalButton')?.addEventListener('click', () => {
    if (!currentImage?.originalUrl) return;
    triggerBrowserDownload(`${currentImage.originalUrl}?download=1`);
    els.downloadChoiceDialog?.close();
  });
  $('#downloadCleanButton')?.addEventListener('click', () => {
    if (!currentImage?.id) return;
    triggerBrowserDownload(`/api/images/${encodeURIComponent(currentImage.id)}/clean`);
    els.downloadChoiceDialog?.close();
    toast('正在下载净图；该文件不能再用于恢复 NovelAI 元数据。', 'success');
  });

  $('#dialogReuse').addEventListener('click', restoreImageState);
  $('#dialogReuseMenu')?.addEventListener('click', openImageRestoreOptions);
  $('#closeImageRestoreDialog')?.addEventListener('click', () => els.imageRestoreDialog?.close());
  els.imageRestoreDialog?.addEventListener('click', event => { if (event.target === els.imageRestoreDialog) els.imageRestoreDialog.close(); });
  els.imageRestoreDialog?.querySelectorAll('[data-restore-merge]').forEach(button => button.addEventListener('click', () => {
    restoreMerge = button.dataset.restoreMerge === 'append' ? 'append' : 'replace';
    storageSet('nai-pocket-restore-merge', restoreMerge);
    renderImageRestoreOptions();
  }));
  els.imageRestoreDialog?.querySelectorAll('[data-image-restore-mode]').forEach(button => button.addEventListener('click', () => {
    try { restoreCurrentImagePartial(button.dataset.imageRestoreMode); }
    catch (error) { toast(error.message, 'error'); }
  }));
  els.imageRestoreCharacterActions?.addEventListener('click', event => {
    const button = event.target.closest?.('[data-image-restore-character]');
    if (!button) return;
    const index = Number(button.dataset.imageRestoreCharacter);
    try { restoreCurrentImagePartial('character', Number.isInteger(index) ? index : null); }
    catch (error) { toast(error.message, 'error'); }
  });

  $('#dialogSaveScheme')?.addEventListener('click', () => saveCurrentImageAsScheme().catch(error => toast(error.message, 'error')));
  $('#dialogRegenerate').addEventListener('click', () => {
    if (!currentImage?.params) return;
    const state = withCurrentGenerationRoute(currentImage.params);
    state.seedMode = 'random';
    enqueue(1, state).then(() => els.imageDialog.close()).catch(error => toast(error.message, 'error'));
  });
  $('#dialogDelete').addEventListener('click', () => deleteCurrentImage().catch(error => toast(error.message, 'error')));
  els.dialogNote.addEventListener('change', () => saveNote().catch(error => toast(error.message, 'error')));

  window.addEventListener('keydown', event => {
    if (!els.imageDialog.open || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      navigateImageDialog(-1).catch(error => toast(error.message, 'error'));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      navigateImageDialog(1).catch(error => toast(error.message, 'error'));
    }
  });

  let viewerTouchStart = null;
  els.dialogImageStage?.addEventListener('touchstart', event => {
    const touch = event.changedTouches?.[0];
    if (touch) viewerTouchStart = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  els.dialogImageStage?.addEventListener('touchend', event => {
    const touch = event.changedTouches?.[0];
    if (!touch || !viewerTouchStart) return;
    const dx = touch.clientX - viewerTouchStart.x;
    const dy = touch.clientY - viewerTouchStart.y;
    viewerTouchStart = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.35) return;
    navigateImageDialog(dx < 0 ? 1 : -1).catch(error => toast(error.message, 'error'));
  }, { passive: true });

  $('#payloadPreviewButton').addEventListener('click', async () => {
    try {
      const state = await prepareGenerationState(serializeState());
      const data = await api('/api/payload-preview', { method: 'POST', body: { state } });
      els.jsonPreview.textContent = JSON.stringify(data, null, 2);
      els.jsonDialog.showModal();
    } catch (error) { toast(error.message, 'error'); }
  });
  els.storageAuditButton?.addEventListener('click', () => runStorageAudit());
  $('#closeJsonDialog').addEventListener('click', () => els.jsonDialog.close());
  $('#closeSchemeDialog')?.addEventListener('click', () => els.schemeDialog?.close());
  els.schemeDialog?.querySelectorAll('[data-scheme-restore-mode]').forEach(button => button.addEventListener('click', () => {
    if (!currentSchemeDetail) return;
    try { restoreSchemePartial(currentSchemeDetail, button.dataset.schemeRestoreMode); }
    catch (error) { toast(error.message, 'error'); }
  }));
  els.schemeDialog?.querySelectorAll('[data-scheme-merge]').forEach(button => button.addEventListener('click', () => {
    restoreMerge = button.dataset.schemeMerge === 'append' ? 'append' : 'replace';
    storageSet('nai-pocket-restore-merge', restoreMerge);
    renderSchemeRestoreOptions();
  }));
  $('#schemeRestoreCharacterActions')?.addEventListener('click', event => {
    const button = event.target.closest?.('[data-scheme-restore-character]');
    if (!button || !currentSchemeDetail) return;
    const index = Number(button.dataset.schemeRestoreCharacter);
    try { restoreSchemePartial(currentSchemeDetail, 'character', Number.isInteger(index) ? index : null); }
    catch (error) { toast(error.message, 'error'); }
  });

  $('#importButton')?.addEventListener('click', () => $('#importFile')?.click());
  $('#exportButton').addEventListener('click', async () => {
    try {
      const response = await fetch('/api/export', { credentials: 'same-origin' });
      if (response.status === 401) {
        let payload = {};
        try { payload = await response.json(); } catch {}
        if (isAppUnauthenticated(response.status, payload)) {
          showLogin();
          throw new Error('登录已失效。');
        }
        throw new Error(payload.error || response.statusText);
      }
      if (!response.ok) throw new Error((await response.json()).error || response.statusText);
      const blob = await response.blob();
      if (globalThis.NAI_RUNTIME?.download) {
        const saved = await globalThis.NAI_RUNTIME.download('/api/export');
        if (saved) toast('备份已保存。', 'success');
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = `nai-pocket-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { toast(error.message, 'error'); }
  });
  $('#importFile').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const content = JSON.parse(await file.text());
      const imported = await api('/api/import', { method: 'POST', body: content });
      await loadSchemes();
      if (Object.hasOwn(imported, 'artistPreferences')) {
        artistLibrary?.reset();
        await loadArtistIdentityIndex();
        if ($('#artistsTab')?.classList.contains('active')) await ensureArtistLibrary().show();
        toast(`备份已导入，包含 ${imported.artistPreferences} 位画师的收藏和备注。`, 'success');
      } else toast('备份已导入；旧片段数据仍保留在备份中。', 'success');
    } catch (error) { toast(`导入失败：${error.message}`, 'error'); }
    event.target.value = '';
  });
}

async function startApp(context = authContext) {
  applyAuthContext(context);
  showApp();
  syncGalleryTimeControls();
  syncGalleryScopeControls();
  if (els.accountUsagePanel) els.accountUsagePanel.open = storageGet('nai-pocket-account-usage-open') !== '0';
  setupCollapsiblePanels();
  switchTabTo('editor');
  $('#showTranslations').checked = storageGet('nai-pocket-show-translations') !== '0';
  denseTagsMode = storageGet('nai-pocket-dense-tags') === '1';
  setDenseTagsMode(denseTagsMode);
  document.body.classList.add('editor-tab-active');
  editorFocusMode = storageGet('nai-pocket-focus-mode') === '1';
  activeEditorModule = storageGet('nai-pocket-active-module') || 'all';
  if (editorFocusMode && activeEditorModule === 'all') activeEditorModule = 'scene';
  hydrateState(createDefaultState());
  restoreDraft();
  applyEditorFocusMode();
  updateEditorModuleCounts();
  const dataLoads = [refreshJobs(), refreshSystem(), resetGallery(false), refreshTranslationStatus(), loadArtistIdentityIndex()];
  if (authContext.role === 'owner') dataLoads.push(loadSchemes({ applyDefault: true }), refreshProviderStatus(), refreshVisitorPasswordStatus());
  await Promise.all(dataLoads);
  draftReady = true;
  if (pollTimer) clearInterval(pollTimer);
  if (systemTimer) clearInterval(systemTimer);
  if (authContext.role === 'owner') {
    if (els.generationProvider?.value === 'rbq') refreshRbqAccount(false).catch(() => {});
    else refreshNaiAccount(false).catch(() => {});
  }
  renderStormPlan();
  pollTimer = setInterval(refreshJobs, 2500);
  systemTimer = setInterval(() => {
    refreshSystem();
    if (authContext.role === 'owner') {
      if (els.generationProvider?.value === 'rbq') refreshRbqAccount(false);
      else refreshNaiAccount(false);
    }
  }, 30_000);
  // The tour is opt-in from the Help button.  Do not interrupt a user's first
  // file import with an automatic modal/tutorial.
}

async function bootstrap() {
  initBindings();
  // Once now, again when webfonts settle (the top bar's height depends on them), and on
  // every resize via the listener above.
  syncTopbarHeight();
  if (document.fonts?.ready) document.fonts.ready.then(() => syncTopbarHeight()).catch(() => {});
  window.addEventListener('load', () => syncTopbarHeight(), { once: true });
  if (!globalThis.NAI_RUNTIME?.native) watchForUpdates();
  try {
    const context = await api('/api/auth/me');
    applyAuthContext(context);
    await startApp(context);
  } catch (error) {
    if (globalThis.NAI_RUNTIME?.native) { showApp(); toast(`本机初始化失败：${error.message}`, 'error'); }
    else showLogin();
  }
}

bootstrap();
