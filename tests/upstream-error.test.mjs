import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUpstreamError } from '../service/upstream-error.js';
import { createQueueControl } from '../service/queue-control.js';

const queue = createQueueControl({ settings: { rateLimitIntervalMs: 30_000 } });
const wrapped = body => parseUpstreamError({ status: 502, statusText: 'Bad Gateway', label: '测试中转', body });

test('escaped relay JSON becomes readable and definitive upstream 400 is not retried', () => {
  const error = wrapped(String.raw`{"error":{"message":"\u89e6\u53d1NAI\u8fdc\u7a0bAPI\u9519\u8bef\uff0c\u9644\u5e26\u7801: 400","type":"nai_api_error"}}`);
  assert.ok(error instanceof Error);
  assert.equal(error.status, 400);
  assert.equal(error.gatewayStatus, 502);
  assert.equal(error.upstreamStatus, 400);
  assert.match(error.message, /HTTP 502（上游 400）/);
  assert.match(error.message, /触发NAI远程API错误，附带码: 400/);
  assert.equal(error.message.includes('\\u'), false);
  assert.equal(queue.retryable(error), false);
});

test('only explicit HTTP status fields in known envelopes affect queue retry classification', () => {
  for (const status of [400, 401, 402, 403, 404, 409, 422]) {
    for (const field of ['status', 'status_code', 'http_status']) {
      for (const value of [status, String(status)]) {
        for (const body of [{ error: { [field]: value, message: 'rejected' } }, { [field]: value, message: 'rejected' }, { upstream: { [field]: value }, message: 'rejected' }]) {
          const error = wrapped(JSON.stringify(body));
          assert.equal(error.status, status);
          assert.equal(error.gatewayStatus, 502);
          assert.equal(error.upstreamStatus, status);
          assert.equal(queue.retryable(error), false);
        }
      }
    }
  }
});

test('explicit upstream messages are recognized without guessing arbitrary numbers', () => {
  for (const message of ['附带码：401', 'upstream HTTP 402', 'Upstream returned HTTP 403', 'upstream status code: 422', '上游 HTTP 400', '上游接口状态码：401']) {
    const error = wrapped(JSON.stringify({ error: { message } }));
    assert.ok([400, 401, 402, 403, 422].includes(error.status));
    assert.equal(queue.retryable(error), false);
  }
  const echoedGateway = wrapped(JSON.stringify({ status: 502, error: { message: 'upstream HTTP 400' } }));
  assert.equal(echoedGateway.status, 400, 'an explicit upstream status is not hidden by the gateway status echo');
});

test('ambiguous codes, parameters and messages retain the gateway status', () => {
  for (const body of [
    { error: { code: 400, type: 'nai_api_error', message: 'steps 400 quota 401 code 402 model 403' } },
    { code: '400', steps: 401, quota: 402, message: 'request failed with code 403' },
    { error: { status: 'error', code: '400' }, parameters: { status: 401 } },
    { error: { status_code: '400_BAD_REQUEST' } },
    { error: { http_status: 400.1 } },
    { error: { status: 200, message: 'no image' } },
    { error: { status: 600 } },
    { error: { message: 'upstream HTTP 4000 or 400.5, code 403' } },
    { error: { message: '附带码: 400.5' } },
    { error: { code: 'upstream HTTP 400' } },
    { parameters: { message: 'upstream HTTP 401' } },
    { message: 'quota', data: { status: 400 } },
    [{ status: 400 }]
  ]) {
    const error = wrapped(JSON.stringify(body));
    assert.equal(error.status, 502, JSON.stringify(body));
    assert.equal(error.upstreamStatus, undefined);
    assert.equal(queue.retryable(error), true);
  }
  const malformed = wrapped('{"error":{"code":"upstream HTTP 400"');
  assert.equal(malformed.status, 502, 'raw malformed JSON cannot promote an arbitrary field to an error message');
});

test('ordinary 429 and wrapped upstream 429 retain rate limit delay semantics', () => {
  for (const status of [429, 502]) {
    const error = parseUpstreamError({ status, body: JSON.stringify({ error: { http_status: 429, message: '稍后重试' } }), retryAfterMs: 45_000 });
    assert.equal(error.status, 429);
    assert.equal(error.gatewayStatus, status);
    assert.equal(error.retryAfterMs, 45_000);
    assert.equal(queue.retryable(error), true);
    assert.equal(queue.rateLimitDelayMs(error), 45_000);
  }
  const short = parseUpstreamError({ status: 429, body: 'too many requests', retryAfterMs: 4_000 });
  assert.equal(short.retryAfterMs, 4_000);
  assert.equal(queue.rateLimitDelayMs(short), 30_000);
  assert.equal(parseUpstreamError({ status: 429, retryAfterMs: Infinity }).retryAfterMs, 0);
});

test('plain errors and malformed JSON preserve their HTTP status and readable text', () => {
  for (const [status, body, retryable] of [[502, 'Bad Gateway', true], [503, '<html>temporarily unavailable</html>', true], [401, 'unauthorized', false], [400, '{"error":broken', false]]) {
    const error = parseUpstreamError({ status, body });
    assert.equal(error.status, status);
    assert.equal(error.gatewayStatus, status);
    assert.equal(error.upstreamStatus, undefined);
    assert.ok(error.message.endsWith(body));
    assert.equal(queue.retryable(error), retryable);
  }
  assert.match(parseUpstreamError({ status: 502, statusText: 'Bad Gateway' }).message, /Bad Gateway$/);
});

test('successful HTTP with no image is not reclassified and all output text is bounded', () => {
  const success = parseUpstreamError({ status: 200, body: '{"error":{"status":400,"message":"upstream HTTP 401"}}' });
  assert.equal(success.status, 200);
  assert.equal(success.gatewayStatus, 200);
  assert.equal(success.upstreamStatus, undefined);
  const enormous = parseUpstreamError({ status: 502, label: 'L'.repeat(100_000), statusText: 'S'.repeat(100_000), body: JSON.stringify({ error: { message: 'M'.repeat(100_000), status: 400 } }) });
  assert.ok(enormous.message.length < 2_300);
  assert.equal(enormous.status, 502, 'a truncated JSON body cannot supply a reliable structured status');
  const tail = wrapped(JSON.stringify({ error: { message: 'm'.repeat(2_001) + ' upstream HTTP 400' } }));
  assert.equal(tail.status, 502, 'message scanning is bounded too');
});
