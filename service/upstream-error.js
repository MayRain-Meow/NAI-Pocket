// A relay may wrap a definitive upstream rejection in HTTP 502. Preserve both statuses so
// the queue does not retry a rejected generation merely because the gateway used 5xx.

const MAX_BODY_LENGTH = 16_384;
const MAX_MESSAGE_LENGTH = 2_000;
const STATUS_FIELDS = ['status', 'status_code', 'http_status'];

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function httpErrorStatus(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  return /^[45]\d{2}$/.test(text) ? Number(text) : null;
}

function structuredStatus(parsed) {
  // Inspect only known error envelopes; never recursively interpret quota, request parameters
  // or provider-specific `code` fields as HTTP statuses.
  const error = object(parsed?.error);
  for (const item of [object(error?.upstream), object(parsed?.upstream), error, object(parsed)]) {
    if (!item) continue;
    for (const field of STATUS_FIELDS) {
      const status = httpErrorStatus(item[field]);
      if (status !== null) return status;
    }
  }
  return null;
}

function messageStatus(message) {
  for (const pattern of [
    /附带码\s*[:：]\s*([45]\d{2})(?![\dA-Za-z_.])/i,
    /\bupstream\s+(?:returned\s+)?(?:HTTP(?:\s+status)?|status(?:\s+code)?)\s*[:=]?\s*([45]\d{2})(?![\dA-Za-z_.])/i,
    /上游(?:\s*(?:API|接口))?\s*(?:HTTP(?:\s*(?:状态码|status))?|状态码)\s*[:：=]?\s*([45]\d{2})(?![\dA-Za-z_.])/i
  ]) {
    const match = pattern.exec(message);
    if (match) return Number(match[1]);
  }
  return null;
}

export function parseUpstreamError({ status, statusText = '', body = '', label = '', retryAfterMs = 0 } = {}) {
  const statusNumber = Number(status);
  const gatewayStatus = Number.isFinite(statusNumber) ? statusNumber : 0;
  const text = String(body ?? '').slice(0, MAX_BODY_LENGTH).trim();
  let parsed = null, validJson = false;
  try { parsed = JSON.parse(text); validJson = true; } catch {}
  const candidates = [parsed?.error?.message, parsed?.message, parsed?.error, parsed?.detail, parsed?.error?.detail, parsed];
  const readable = candidates.find(value => typeof value === 'string' && value.trim());
  const detail = (readable || text || String(statusText) || '请求失败。').trim().slice(0, MAX_MESSAGE_LENGTH);
  // Raw JSON is only a display fallback: a string hidden in `code` or request parameters
  // must not become an error message, including when that JSON was truncated or malformed.
  const statusMessage = (readable || (!validJson && !text.startsWith('{') && !text.startsWith('[') ? text : '')).slice(0, MAX_MESSAGE_LENGTH);
  // Successful HTTP responses with missing/invalid image data belong to the image parser.
  // Explicit upstream wording is stronger evidence than a root status field echoing the gateway.
  const upstreamStatus = gatewayStatus >= 400 && gatewayStatus <= 599
    ? messageStatus(statusMessage) ?? structuredStatus(parsed) : null;
  const effectiveStatus = upstreamStatus ?? gatewayStatus;
  const upstreamLabel = upstreamStatus !== null && upstreamStatus !== gatewayStatus ? `（上游 ${upstreamStatus}）` : '';
  const error = new Error(`${String(label || '上游接口').slice(0, 160)} HTTP ${gatewayStatus}${upstreamLabel}: ${detail}`);
  error.status = effectiveStatus;
  error.gatewayStatus = gatewayStatus;
  if (upstreamStatus !== null) error.upstreamStatus = upstreamStatus;
  if (effectiveStatus === 429) {
    const delay = Number(retryAfterMs);
    error.retryAfterMs = Number.isFinite(delay) ? Math.max(0, delay) : 0;
  }
  return error;
}
