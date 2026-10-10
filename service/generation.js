import { DIRECTOR_TOOL_TYPES } from '../public/parameter-semantics.js';
import { DEFAULT_ENHANCE_UPSCALE_FACTOR } from '../public/generation-state.js';
import { buildPayload, apiModelFor, safeEnhanceTargetDimensions } from '../public/generation-payload.js';


// binary is a byte-buffer codec; inflateRaw must enforce maxOutputLength.
export function createGenerationClient({ settings, assets, generationProvider, binary, inflateRaw, ids,
  http = { fetch: (...args) => globalThis.fetch(...args) }, clock = { now: () => Date.now() } }) {
const { base64ForRef, encodeVibeReference, preciseReferenceBase64, resolveImageRef } = assets;
function correlationId() {
  return ids.request();
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function extractZipImage(buffer) {
  if (!binary.isBuffer(buffer) || buffer.length < 22) throw new Error('ZIP 响应不完整。');
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) throw new Error('ZIP 响应缺少中央目录。');
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const directoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (entryCount < 1 || entryCount > 16) throw new Error('ZIP 响应中的文件数量异常。');

  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 中央目录损坏。');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nextCursor = nameStart + nameLength + extraLength + commentLength;
    if (nextCursor > buffer.length) throw new Error('ZIP 文件名或扩展字段越界。');
    const filename = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    cursor = nextCursor;
    if (!/\.(?:png|webp|jpe?g)$/i.test(filename)) continue;
    if (flags & 0x1) throw new Error('不支持加密 ZIP 响应。');
    if (![0, 8].includes(method)) throw new Error(`不支持 ZIP 压缩方法 ${method}。`);
    if (uncompressedSize < 8 || uncompressedSize > 64 * 1024 * 1024) throw new Error('ZIP 图片大小异常。');
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏。');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart < 0 || dataEnd > buffer.length) throw new Error('ZIP 图片数据越界。');
    const compressed = buffer.subarray(dataStart, dataEnd);
    const image = method === 0
      ? binary.from(compressed)
      : inflateRaw(compressed, { maxOutputLength: 64 * 1024 * 1024 });
    if (image.length !== uncompressedSize) throw new Error('ZIP 图片解压后大小不一致。');
    const mime = detectMime(image, filename.toLowerCase().endsWith('.webp') ? 'image/webp' : filename.toLowerCase().match(/\.jpe?g$/) ? 'image/jpeg' : 'image/png');
    if (!['image/png', 'image/webp', 'image/jpeg'].includes(mime)) throw new Error('ZIP 中没有可识别的图片。');
    return { buffer: image, mime, filename };
  }
  throw new Error('ZIP 响应中没有 PNG / WebP / JPEG 图片。');
}

function parseRetryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, date - clock.now()) : 0;
}

function detectMime(buffer, fallback = 'image/png') {
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(binary.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  return fallback;
}


async function resolveGenerationMedia(state, officialToken = '', { signal } = {}) {
  const workflow = state.imageWorkflow || { mode: 'text' };
  const reference = state.referenceControl || { mode: 'none' };
  const media = {};
  if (workflow.mode === 'img2img' || workflow.mode === 'inpaint') {
    media.baseImage = await base64ForRef(workflow.baseImage, { signal });
  }
  if (workflow.mode === 'inpaint') media.maskImage = await base64ForRef(workflow.maskImage, { signal });
  if (reference.mode === 'precise') {
    media.precise = [];
    for (const item of reference.precise || []) {
      media.precise.push({
        image: await preciseReferenceBase64(item.image, { signal }),
        type: item.type,
        strength: item.strength,
        fidelity: item.fidelity
      });
    }
  } else if (reference.mode === 'vibe') {
    media.vibes = [];
    for (const item of reference.vibes || []) {
      media.vibes.push({
        image: await encodeVibeReference(item.image, state.model, item.informationExtracted, officialToken, { signal, officialAccountId: state.officialAccountId }),
        strength: item.strength,
        informationExtracted: item.informationExtracted
      });
    }
  }
  return media;
}

function imageRefDimensions(resolved, fallbackWidth, fallbackHeight) {
  const width = Number(resolved?.row?.width || fallbackWidth || 0);
  const height = Number(resolved?.row?.height || fallbackHeight || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('无法读取输入图片尺寸，无法调用 NovelAI 官方图片工具。');
  }
  return { width: Math.round(width), height: Math.round(height) };
}

function scaledEnhanceDimensions(width, height, factor) {
  const maxPixels = 3_145_728;
  const requestedFactor = String(factor || '').toLowerCase() === 'max'
    ? Math.sqrt(maxPixels / Math.max(1, width * height))
    : Number(factor) || DEFAULT_ENHANCE_UPSCALE_FACTOR;
  const safeFactor = Math.min(2, Math.max(1, requestedFactor));
  // Enhance targets are internal V5 image-generation dimensions and may be
  // larger than the ordinary editor presets, while remaining within the
  // official three-megapixel request budget.
  let nextWidth = Math.max(64, Math.min(4096, Math.round(width * safeFactor / 64) * 64));
  let nextHeight = Math.max(64, Math.min(4096, Math.round(height * safeFactor / 64) * 64));
  if (nextWidth * nextHeight > maxPixels) {
    const ratio = Math.sqrt(maxPixels / (nextWidth * nextHeight));
    nextWidth = Math.max(64, Math.floor(nextWidth * ratio / 64) * 64);
    nextHeight = Math.max(64, Math.floor(nextHeight * ratio / 64) * 64);
  }
  return { width: nextWidth, height: nextHeight };
}

async function stateForOfficialEnhance(state, resolved) {
  const dimensions = imageRefDimensions(resolved, state.params?.width, state.params?.height);
  const recordedTarget = safeEnhanceTargetDimensions(state.imageWorkflow?.enhanceTargetWidth, state.imageWorkflow?.enhanceTargetHeight);
  const target = recordedTarget || scaledEnhanceDimensions(dimensions.width, dimensions.height, state.imageWorkflow?.enhanceUpscaleFactor);
  return {
    ...state,
    imageWorkflow: { ...state.imageWorkflow, mode: 'img2img' },
    params: { ...state.params, ...target }
  };
}

async function parseOfficialImageResponse(response, payload, seed, emit, requestId, label) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await response.json();
    const item = json?.images?.[0];
    if (!item?.image) throw new Error(`${label} JSON 返回中没有图片。`);
    const buffer = binary.from(String(item.image).replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
    emit('info', 'received', `${label}已收到图片数据 · ${Math.round(buffer.length / 1024)} KB`, { requestId, bytes: buffer.length });
    return { buffer, mime: detectMime(buffer, 'image/png'), seed: Number.isInteger(item.seed) ? item.seed : seed, payload };
  }
  const buffer = binary.from(await response.arrayBuffer());
  emit('info', 'received', `${label}已收到返回数据 · ${Math.round(buffer.length / 1024)} KB`, { requestId, bytes: buffer.length, contentType });
  if (contentType.includes('zip') || buffer.subarray(0, 2).toString() === 'PK') {
    const image = extractZipImage(buffer);
    emit('info', 'received', `${label}已从 ZIP 解出 ${image.filename} · ${Math.round(image.buffer.length / 1024)} KB`, { requestId, bytes: image.buffer.length, filename: image.filename });
    return { ...image, seed, payload };
  }
  return { buffer, mime: contentType.startsWith('image/') ? contentType.split(';')[0] : 'image/png', seed, payload };
}

async function generateOfficialImageTool(state, seed, provider, controller, emit) {
  const workflow = state.imageWorkflow || {};
  const tool = state.imageTool || {};
  if (tool.type === 'director' && !DIRECTOR_TOOL_TYPES.has(String(tool.reqType || ''))) {
    throw new Error('Director 工具类型未识别；请重新选择具体工具后再生成。');
  }
  const resolved = await resolveImageRef(workflow.baseImage, { signal: controller.signal });
  const dimensions = imageRefDimensions(resolved, state.params?.width, state.params?.height);
  let endpoint = settings.naiAugmentApi;
  let request;
  let payload;
  let label = 'NovelAI 官方图片工具';
  if (tool.type === 'upscale') {
    endpoint = settings.naiUpscaleApi;
    request = { image: resolved.buffer.toString('base64'), model: apiModelFor(state.model) };
    payload = { operation: 'upscale', endpoint, request: { ...request, image: `[asset:${workflow.baseImage.id}]` } };
    label = 'NovelAI 官方 Upscale';
  } else {
    request = {
      req_type: tool.reqType,
      width: dimensions.width,
      height: dimensions.height,
      image: resolved.buffer.toString('base64'),
      ...(tool.reqType === 'colorize' || tool.reqType === 'emotion' ? { prompt: tool.prompt || '', defry: tool.defry || 0 } : {})
    };
    payload = {
      operation: 'director', endpoint,
      request: { ...request, image: `[asset:${workflow.baseImage.id}]` }
    };
    label = `NovelAI 官方 Director Tools · ${tool.reqType}`;
  }
  const requestId = correlationId();
  emit('info', 'request', `已向${label}发送请求，正在等待响应。`, { requestId, provider: provider.id, operation: payload.operation, endpoint, timeoutMs: settings.naiTimeoutMs });
  const response = await http.fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.token}`,
      'Content-Type': 'application/json',
      Accept: tool.type === 'upscale' ? 'application/json' : 'application/zip',
      'x-correlation-id': requestId
    },
    body: JSON.stringify(request),
    signal: controller.signal
  });
  emit(response.ok ? 'info' : 'warn', 'response', `${label}已响应 · HTTP ${response.status}`, { requestId, provider: provider.id, status: response.status, contentType: response.headers.get('content-type') || '' });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 2000);
    const error = new Error(`${label} ${response.status}: ${text || response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return parseOfficialImageResponse(response, payload, seed, emit, requestId, label);
}

async function generateImage(state, seed, options = {}) {
  const externalSignal = options?.signal;
  const onEvent = typeof options?.onEvent === 'function' ? options.onEvent : null;
  const emit = (level, phase, message, detail = null) => {
    try { onEvent?.({ level, phase, message, detail, at: clock.now() }); } catch {}
  };
  const controller = new AbortController();
  let cancelledByCaller = false;
  let timedOut = false;

  const abortFromCaller = () => {
    cancelledByCaller = true;
    if (!controller.signal.aborted) controller.abort();
  };
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener?.('abort', abortFromCaller, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    if (!controller.signal.aborted) controller.abort();
  }, settings.naiTimeoutMs);

  try {
    if (cancelledByCaller) {
      const error = new Error('生成任务已取消。');
      error.code = 'JOB_CANCELLED';
      throw error;
    }

    const provider = await generationProvider(state.provider, state.officialAccountId);
    if (state.imageTool?.type && state.imageTool.type !== 'none') {
      if (provider.id !== 'official') throw new Error('NovelAI 官方图片工具不支持 RBQ 中转，请切换到官网 Token。');
      const result = await generateOfficialImageTool(state, seed, provider, controller, emit);
      return { ...result, effectiveState: state };
    }
    emit('info', 'prepare', '正在准备参考图、遮罩与生成参数。');
    let requestState = state;
    if (state.imageWorkflow?.enhance === true) {
      const resolved = await resolveImageRef(state.imageWorkflow.baseImage, { signal: controller.signal });
      requestState = await stateForOfficialEnhance(state, resolved);
    }
    const media = await resolveGenerationMedia(requestState, provider.id === 'official' ? provider.token : '', { signal: controller.signal });
    emit('info', 'prepare', '生成参数准备完成。');
    if (cancelledByCaller) {
      const error = new Error('生成任务已取消。');
      error.code = 'JOB_CANCELLED';
      throw error;
    }
    const payload = buildPayload(requestState, seed, media);
    const requestId = correlationId();
    emit('info', 'request', `已向${provider.label}发送生成请求，正在等待响应。`, {
      requestId, provider: provider.id, model: payload.model, action: payload.action, timeoutMs: settings.naiTimeoutMs
    });
    const response = await http.fetch(provider.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-correlation-id': requestId
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const contentType = response.headers.get('content-type') || '';
    const retryAfterMs = response.status === 429 ? parseRetryAfterMs(response.headers.get('retry-after')) : 0;
    emit(response.ok ? 'info' : 'warn', 'response', `${provider.label}已响应 · HTTP ${response.status}`, {
      requestId, provider: provider.id, status: response.status, contentType, retryAfterMs
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 2000);
      emit('error', 'response-error', `${provider.label} ${response.status}: ${text || response.statusText}`, {
        requestId, provider: provider.id, status: response.status, body: text || response.statusText, retryAfterMs
      });
      const error = new Error(`${provider.label} ${response.status}: ${text || response.statusText}`);
      error.status = response.status;
      if (response.status === 429) error.retryAfterMs = retryAfterMs;
      throw error;
    }

    if (contentType.includes('application/json')) {
      const json = await response.json();
      const item = json?.images?.[0];
      if (!item?.image) throw new Error('NovelAI JSON 返回中没有图片。');
      const buffer = binary.from(String(item.image).replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
      emit('info', 'received', `已收到 NovelAI 图片数据 · ${Math.round(buffer.length / 1024)} KB`, { requestId, bytes: buffer.length });
      return {
        buffer,
        mime: detectMime(buffer, requestState.params.imageFormat === 'webp' ? 'image/webp' : 'image/png'),
        seed: Number.isInteger(item.seed) ? item.seed : seed,
        payload,
        effectiveState: requestState
      };
    }

    const buffer = binary.from(await response.arrayBuffer());
    emit('info', 'received', `已收到 NovelAI 返回数据 · ${Math.round(buffer.length / 1024)} KB`, { requestId, bytes: buffer.length, contentType });
    if (contentType.includes('zip') || buffer.subarray(0, 2).toString() === 'PK') {
      const image = extractZipImage(buffer);
      emit('info', 'received', `已从 ZIP 解出 ${image.filename} · ${Math.round(image.buffer.length / 1024)} KB`, { requestId, bytes: image.buffer.length, filename: image.filename });
      return { ...image, seed, payload, effectiveState: requestState };
    }
    return { buffer, mime: contentType.startsWith('image/') ? contentType.split(';')[0] : 'image/png', seed, payload, effectiveState: requestState };
  } catch (error) {
    if (cancelledByCaller) {
      emit('warn', 'cancelled', 'NovelAI 请求已由用户停止。');
      const cancelError = new Error('生成任务已取消。');
      cancelError.code = 'JOB_CANCELLED';
      throw cancelError;
    }
    if (timedOut || error.name === 'AbortError') {
      const message = `NovelAI 请求超过 ${Math.round(settings.naiTimeoutMs / 1000)} 秒。`;
      emit('error', 'timeout', message, { timeoutMs: settings.naiTimeoutMs });
      const timeoutError = new Error(message);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', abortFromCaller);
  }
}

function finiteIntegerOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function clampUsagePercent(value) {
  const parsed = finiteIntegerOrNull(value);
  return parsed == null ? null : Math.min(100, Math.max(0, parsed));
}

function normalizeSubscriptionStatus(raw = {}) {
  const training = raw?.trainingStepsLeft || {};
  const fixed = Math.max(0, finiteIntegerOrNull(training.fixedTrainingStepsLeft) ?? 0);
  const purchased = Math.max(0, finiteIntegerOrNull(training.purchasedTrainingSteps) ?? 0);
  const usage = raw?.usage && typeof raw.usage === 'object' ? raw.usage : null;
  const tier = finiteIntegerOrNull(raw?.tier);
  const tierName = ({ 0: 'Free', 1: 'Tablet', 2: 'Scroll', 3: 'Opus' })[tier] || (tier == null ? 'Unknown' : `Tier ${tier}`);
  return {
    active: Boolean(raw?.active),
    tier,
    tierName,
    expiresAt: finiteIntegerOrNull(raw?.expiresAt),
    isGracePeriod: Boolean(raw?.isGracePeriod),
    anlas: {
      fixed,
      purchased,
      total: fixed + purchased
    },
    usage: usage ? {
      percent: clampUsagePercent(usage.percent),
      isNegative: Boolean(usage.isNegative),
      timeUntilNextPercent: Math.max(0, finiteIntegerOrNull(usage.timeUntilNextPercent) ?? 0)
    } : null,
    fetchedAt: clock.now()
  };
}

function calculateUsageDelta(before, after, { v5 = false, model = '' } = {}) {
  if (!before || !after) return null;
  const beforeAnlas = Number(before?.anlas?.total);
  const afterAnlas = Number(after?.anlas?.total);
  const anlasSpent = Number.isFinite(beforeAnlas) && Number.isFinite(afterAnlas)
    ? Math.max(0, beforeAnlas - afterAnlas)
    : null;
  const beforePercent = Number(before?.usage?.percent);
  const afterPercent = Number(after?.usage?.percent);
  const usagePercentNet = Number.isFinite(beforePercent) && Number.isFinite(afterPercent)
    ? Math.max(0, beforePercent - afterPercent)
    : null;
  return {
    v5: Boolean(v5),
    model: String(model || ''),
    before: {
      usagePercent: Number.isFinite(beforePercent) ? beforePercent : null,
      usageUnavailable: Boolean(before?.usage?.isNegative),
      anlasTotal: Number.isFinite(beforeAnlas) ? beforeAnlas : null
    },
    after: {
      usagePercent: Number.isFinite(afterPercent) ? afterPercent : null,
      usageUnavailable: Boolean(after?.usage?.isNegative),
      anlasTotal: Number.isFinite(afterAnlas) ? afterAnlas : null
    },
    delta: {
      usagePercentNet,
      anlasSpent
    }
  };
}

async function getSubscriptionStatus(options = {}) {
  const account = await generationProvider('official', options.officialAccountId);
  const response = await http.fetch(settings.naiSubscriptionApi, {
    headers: {
      Authorization: `Bearer ${account.token}`,
      Accept: 'application/json'
    },
    signal: options.signal || AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 1200);
    const error = new Error(`NovelAI 订阅状态接口 ${response.status}: ${text || response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return normalizeSubscriptionStatus(await response.json());
}

async function suggestTags(model, prompt) {
  const query = new URL(settings.naiTagApi);
  query.searchParams.set('model', apiModelFor(model || 'nai-diffusion-4-5-full'));
  query.searchParams.set('prompt', String(prompt || '').slice(0, 200));
  query.searchParams.set('lang', 'en');
  const response = await http.fetch(query, {
    headers: { Authorization: `Bearer ${settings.naiToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 1000);
    const error = new Error(`Tag 建议接口 ${response.status}: ${text || response.statusText}`);
    error.status = response.status;
    throw error;
  }
  const json = await response.json();
  const tags = Array.isArray(json?.tags) ? json.tags : Array.isArray(json) ? json : [];
  return tags.slice(0, 20).map(item => ({
    tag: String(item.tag || item),
    count: Number(item.count || 0),
    confidence: Number(item.confidence || 0)
  }));
}

return { extractZipImage, resolveGenerationMedia, generateImage, normalizeSubscriptionStatus, calculateUsageDelta, getSubscriptionStatus, suggestTags };
}
