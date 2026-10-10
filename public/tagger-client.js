// Portable Gradio upload -> call -> SSE protocol over an injected fetch.

export const TAGGER_SPACE = 'https://smilingwolf-wd-tagger.hf.space/gradio_api';
export const TAGGER_MODEL = 'SmilingWolf/wd-eva02-large-tagger-v3';
const GENERAL_THRESHOLD = 0.35;
const CHARACTER_THRESHOLD = 0.85;
const TIMEOUT_MS = 90_000;
export const TAGGER_MAX_BYTES = 10 * 1024 * 1024;

const failure = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// The Space answers in Gradio's two-step form: POST starts an event, GET streams it as SSE.
export function parseEventStream(text) {
  const events = [...String(text).matchAll(/event: (\w+)\r?\ndata: (.*)/g)];
  const last = events.filter(([, name]) => name === 'complete' || name === 'error').at(-1);
  if (!last) throw failure(502, '反推服务没有返回结果，请稍后重试。', { retryable: true });
  if (last[1] === 'error') throw failure(502, '反推服务暂时出错（可能正在启动），请稍后重试。', { retryable: true });
  let data;
  try { data = JSON.parse(last[2]); } catch { throw failure(502, '反推服务返回了无法读取的结果。'); }
  if (!Array.isArray(data) || data.length < 4) throw failure(502, '反推服务返回了无法读取的结果。');
  return data;
}

const confidences = label => (Array.isArray(label?.confidences) ? label.confidences : [])
  .filter(item => typeof item?.label === 'string' && Number.isFinite(Number(item.confidence)))
  .map(item => ({ tag: item.label.trim(), confidence: Math.round(Number(item.confidence) * 1000) / 1000 }))
  .filter(item => item.tag);

export function normalizeTaggerResult(data) {
  const [, rating, characters, tags] = data;
  return {
    model: TAGGER_MODEL,
    rating: typeof rating?.label === 'string' ? rating.label : '',
    characters: confidences(characters),
    tags: confidences(tags)
  };
}

export async function callTaggerSpace(imageBytes, mime, { signal, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const form = new FormData();
    form.append('files', new Blob([imageBytes], { type: mime }), `image.${mime.split('/')[1]}`);
    const upload = await fetchImpl(`${TAGGER_SPACE}/upload`, { method: 'POST', body: form, signal: controller.signal, redirect: 'error' });
    if (!upload.ok) throw failure(502, `反推服务上传失败（HTTP ${upload.status}）。`, { retryable: upload.status >= 500 });
    const paths = await upload.json().catch(() => null);
    if (!Array.isArray(paths) || typeof paths[0] !== 'string') throw failure(502, '反推服务上传后没有返回文件。');
    const image = { path: paths[0], meta: { _type: 'gradio.FileData' }, orig_name: 'image', mime_type: mime, size: imageBytes.length };
    const start = await fetchImpl(`${TAGGER_SPACE}/call/predict`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, redirect: 'error',
      body: JSON.stringify({ data: [image, TAGGER_MODEL, GENERAL_THRESHOLD, false, CHARACTER_THRESHOLD, false] })
    });
    if (!start.ok) throw failure(502, `反推服务拒绝了请求（HTTP ${start.status}）。`, { retryable: start.status >= 500 });
    const { event_id: eventId } = await start.json().catch(() => ({}));
    if (!eventId || !/^[\w-]+$/.test(String(eventId))) throw failure(502, '反推服务没有返回任务编号。');
    const stream = await fetchImpl(`${TAGGER_SPACE}/call/predict/${eventId}`, { signal: controller.signal, redirect: 'error' });
    if (!stream.ok) throw failure(502, `反推服务读取结果失败（HTTP ${stream.status}）。`, { retryable: stream.status >= 500 });
    return normalizeTaggerResult(parseEventStream(await stream.text()));
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw failure(504, '反推超时（90 秒）；公共服务可能正在启动，请稍后重试。', { retryable: true });
    if (signal?.aborted) throw failure(499, '反推已取消。');
    if (error.status) throw error;
    throw failure(502, `无法连接反推服务：${error.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
