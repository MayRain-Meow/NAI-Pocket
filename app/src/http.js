import { Buffer } from 'buffer';
import { PocketNative } from './providers.js';

// Native HTTP has explicit cancellation and never retries a paid POST.
export async function nativeFetch(input, init = {}) {
  const request = new Request(input, init);
  const abortError = () => new DOMException('Request aborted', 'AbortError');
  if (request.signal.aborted) throw abortError();
  const id = crypto.randomUUID();
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer()).toString('base64');
  if (request.signal.aborted) throw abortError();
  const cancel = () => { PocketNative.cancelRequest({ id }).catch(() => {}); };
  request.signal.addEventListener('abort', cancel, { once: true });
  try {
    const result = await PocketNative.request({ id, url: request.url, method: request.method, body, headers: Object.fromEntries(request.headers) });
    if (request.signal.aborted) throw abortError();
    if (result.status >= 300 && result.status < 400 && request.redirect === 'error') throw new TypeError('Redirect refused');
    return new Response(request.method === 'HEAD' || [204, 205, 304].includes(result.status) ? null : Buffer.from(result.body, 'base64'),
      { status: result.status, headers: result.headers });
  } catch (error) {
    if (request.signal.aborted || error.code === 'ABORTED') throw abortError();
    throw error;
  } finally { request.signal.removeEventListener('abort', cancel); }
}
