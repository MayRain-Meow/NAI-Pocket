
const RBQ_TOKEN_STATE_KEY = 'provider_rbq_token_v1';
const OFFICIAL_TOKENS_STATE_KEY = 'provider_official_tokens_v1';
const OFFICIAL_DEFAULT_ACCOUNT_STATE_KEY = 'provider_official_default_account_v1';
const OFFICIAL_ENV_OVERRIDE_STATE_KEY = 'provider_official_env_override_v1';
const OFFICIAL_ENV_ACCOUNT_ID = 'env';
const MAX_OFFICIAL_ACCOUNTS = 30;
const RELAYS_STATE_KEY = 'provider_relays_v1';
const MAX_RELAYS = 20;
const RELAY_PREFIX = 'relay:';

// allowCustomRelays: user-entered relay addresses are fetched by whoever runs this service.
// On a phone that is the user's own device; a shared server must first refuse private and
// loopback targets, so it leaves this off until it has that guard.
export function createProviderService({ settings, state, secrets, ids, clock = { now: () => Date.now() }, http = { fetch: (...args) => globalThis.fetch(...args) }, allowCustomRelays = false }) {
const getAppState = (key, fallback) => state.get(key, fallback);
const setAppState = (key, value) => state.set(key, value);
const encryptToken = value => secrets.encrypt(value);
const decryptToken = (value, label) => secrets.decrypt(value, label);
function validateRbqToken(raw) {
  const token = String(raw || '').trim();
  if (token.length < 20 || token.length > 300 || !/^[A-Za-z0-9._-]+$/.test(token)) {
    throw new Error('RBQ API Key 格式不正确。');
  }
  return token;
}

function storedRbqToken() {
  return decryptToken(getAppState(RBQ_TOKEN_STATE_KEY, ''), 'RBQ Key');
}

function getRbqToken() {
  return storedRbqToken() || String(settings.rbqNaiToken || '').trim();
}

function saveRbqToken(rawToken) {
  const token = validateRbqToken(rawToken);
  setAppState(RBQ_TOKEN_STATE_KEY, encryptToken(token));
  return providerStatus();
}

function deleteRbqToken() {
  setAppState(RBQ_TOKEN_STATE_KEY, '');
  return providerStatus();
}

function relayError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function validateRelayUrl(raw) {
  const text = String(raw || '').trim();
  let url;
  try { url = new URL(text); } catch { throw relayError('中转接口地址无效，请填写完整的 https:// 地址。'); }
  if (url.protocol !== 'https:') throw relayError('中转接口地址必须以 https:// 开头。');
  if (url.username || url.password) throw relayError('中转接口地址不能包含用户名或密码。');
  if (url.href.length > 500) throw relayError('中转接口地址过长。');
  url.hash = '';
  return url.href;
}

function validateRelayKey(raw) {
  const key = String(raw || '').trim();
  if (key.length < 8 || key.length > 500 || /[\s\u0000-\u001f\u007f]/.test(key)) throw relayError('中转 Key 格式不正确。');
  return key;
}

function storedRelays() {
  let parsed;
  try { parsed = JSON.parse(getAppState(RELAYS_STATE_KEY, '[]') || '[]'); }
  catch { throw relayError('第三方中转列表损坏，请重新添加。', 500); }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, MAX_RELAYS).filter(item => /^[A-Za-z0-9-]{8,80}$/.test(String(item?.id || ''))).map(item => ({
    id: String(item.id),
    name: sanitizeAccountName(item.name, '第三方中转'),
    apiUrl: String(item.apiUrl || ''),
    encryptedKey: String(item.encryptedKey || ''),
    createdAt: Math.max(0, Number(item.createdAt || 0)),
    updatedAt: Math.max(0, Number(item.updatedAt || 0))
  }));
}

function relayRecord(providerId) {
  const id = String(providerId || '').startsWith(RELAY_PREFIX) ? String(providerId).slice(RELAY_PREFIX.length) : String(providerId || '');
  const record = storedRelays().find(item => item.id === id);
  if (!record) throw relayError('这个第三方中转已不存在，请重新选择生成通道。', 404);
  return record;
}

// Create (no id) or update a relay. On update an empty key keeps the stored one.
function saveRelay({ id = '', name, apiUrl, key } = {}) {
  if (!allowCustomRelays) throw relayError('此版本暂不支持自定义中转。', 403);
  const records = storedRelays();
  const url = validateRelayUrl(apiUrl);
  const now = clock.now();
  const existingId = String(id || '').replace(RELAY_PREFIX, '');
  if (existingId) {
    const record = records.find(item => item.id === existingId);
    if (!record) throw relayError('这个第三方中转已不存在。', 404);
    record.name = sanitizeAccountName(name, record.name);
    record.apiUrl = url;
    if (String(key || '').trim()) record.encryptedKey = encryptToken(validateRelayKey(key));
    record.updatedAt = now;
    setAppState(RELAYS_STATE_KEY, JSON.stringify(records));
    return { providerId: `${RELAY_PREFIX}${record.id}`, providers: providerStatus() };
  }
  if (records.length >= MAX_RELAYS) throw relayError(`最多保存 ${MAX_RELAYS} 个第三方中转。`);
  const record = { id: ids.next(), name: sanitizeAccountName(name, `中转 ${records.length + 1}`), apiUrl: url, encryptedKey: encryptToken(validateRelayKey(key)), createdAt: now, updatedAt: now };
  records.push(record);
  setAppState(RELAYS_STATE_KEY, JSON.stringify(records));
  return { providerId: `${RELAY_PREFIX}${record.id}`, providers: providerStatus() };
}

function deleteRelay(providerId) {
  const record = relayRecord(providerId);
  setAppState(RELAYS_STATE_KEY, JSON.stringify(storedRelays().filter(item => item.id !== record.id)));
  return providerStatus();
}

function publicRelay(record) {
  let hint = '', error = '';
  try { hint = tokenHint(decryptToken(record.encryptedKey, `中转「${record.name}」的 Key`)); }
  catch (cause) { error = String(cause?.message || cause); }
  let host = '';
  try { host = new URL(record.apiUrl).host; } catch {}
  return { id: `${RELAY_PREFIX}${record.id}`, name: record.name, label: record.name, endpoint: record.apiUrl, host, configured: Boolean(hint), tokenHint: hint, error };
}

function validateOfficialToken(raw) {
  const token = String(raw || '').trim();
  if (!/^pst-[A-Za-z0-9._-]{16,500}$/.test(token)) {
    throw new Error('NovelAI 官网 Token 必须是以 pst- 开头的 Persistent API Token。');
  }
  return token;
}

function sanitizeAccountName(raw, fallback = '官网 Token') {
  const name = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return name || fallback;
}

function storedOfficialRecords() {
  const raw = getAppState(OFFICIAL_TOKENS_STATE_KEY, '[]');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('NovelAI 官网 Token 列表损坏，请重新保存 Token。'); }
  if (!Array.isArray(parsed)) throw new Error('NovelAI 官网 Token 列表格式无效。');
  return parsed.slice(0, MAX_OFFICIAL_ACCOUNTS).map((item, index) => ({
    id: /^[0-9a-f-]{16,80}$/i.test(String(item?.id || '')) ? String(item.id) : `invalid-${index}`,
    name: sanitizeAccountName(item?.name, `官网 Token ${index + 1}`),
    encryptedToken: String(item?.encryptedToken || ''),
    createdAt: Math.max(0, Number(item?.createdAt || 0)),
    updatedAt: Math.max(0, Number(item?.updatedAt || 0))
  }));
}

function saveOfficialRecords(records) {
  setAppState(OFFICIAL_TOKENS_STATE_KEY, JSON.stringify(records.slice(0, MAX_OFFICIAL_ACCOUNTS)));
}

function storedOfficialEnvOverride() {
  const encrypted = getAppState(OFFICIAL_ENV_OVERRIDE_STATE_KEY, '');
  return encrypted ? decryptToken(encrypted, '默认 NovelAI Token') : '';
}

function effectiveOfficialEnvToken() {
  const override = storedOfficialEnvOverride();
  return {
    token: override || String(settings.naiToken || '').trim(),
    overridden: Boolean(override)
  };
}

function validDefaultAccountId(records, envAvailable) {
  const preferred = String(getAppState(OFFICIAL_DEFAULT_ACCOUNT_STATE_KEY, '') || '').trim();
  if (preferred === OFFICIAL_ENV_ACCOUNT_ID && envAvailable) return preferred;
  if (records.some(record => record.id === preferred)) return preferred;
  if (envAvailable) return OFFICIAL_ENV_ACCOUNT_ID;
  return records[0]?.id || '';
}

function publicOfficialAccount(record, defaultAccountId = '') {
  let hint = '';
  let error = '';
  try { hint = tokenHint(decryptToken(record.encryptedToken, `NovelAI Token「${record.name}」`)); }
  catch (cause) { error = String(cause?.message || cause); }
  return {
    id: record.id,
    name: record.name,
    tokenHint: hint,
    source: 'ui',
    editable: true,
    removable: true,
    resettable: false,
    isDefault: record.id === defaultAccountId,
    error
  };
}

function saveOfficialToken(rawName, rawToken) {
  const token = validateOfficialToken(rawToken);
  try {
    if (effectiveOfficialEnvToken().token === token) return { accountId: OFFICIAL_ENV_ACCOUNT_ID, providers: providerStatus() };
  } catch {}
  const records = storedOfficialRecords();
  let duplicate = null;
  for (const record of records) {
    try {
      if (decryptToken(record.encryptedToken, `NovelAI Token「${record.name}」`) === token) {
        duplicate = record;
        break;
      }
    } catch {}
  }
  const now = clock.now();
  if (duplicate) {
    duplicate.name = sanitizeAccountName(rawName, duplicate.name);
    duplicate.updatedAt = now;
    duplicate.encryptedToken = encryptToken(token);
    saveOfficialRecords(records);
    return { accountId: duplicate.id, providers: providerStatus() };
  }
  if (records.length >= MAX_OFFICIAL_ACCOUNTS) throw new Error(`最多保存 ${MAX_OFFICIAL_ACCOUNTS} 个 NovelAI 官网 Token。`);
  const account = {
    id: ids.next(),
    name: sanitizeAccountName(rawName, `官网 Token ${records.length + 1}`),
    encryptedToken: encryptToken(token),
    createdAt: now,
    updatedAt: now
  };
  records.push(account);
  saveOfficialRecords(records);
  return { accountId: account.id, providers: providerStatus() };
}

function updateOfficialToken(accountId, rawName, rawToken) {
  const id = String(accountId || '').trim();
  if (id === OFFICIAL_ENV_ACCOUNT_ID) {
    const token = validateOfficialToken(rawToken);
    if (settings.naiToken && token === String(settings.naiToken).trim()) setAppState(OFFICIAL_ENV_OVERRIDE_STATE_KEY, '');
    else setAppState(OFFICIAL_ENV_OVERRIDE_STATE_KEY, encryptToken(token));
    return { accountId: OFFICIAL_ENV_ACCOUNT_ID, providers: providerStatus() };
  }

  const records = storedOfficialRecords();
  const record = records.find(item => item.id === id);
  if (!record) {
    const error = new Error('NovelAI 官网 Token 不存在。');
    error.status = 404;
    throw error;
  }
  const tokenText = String(rawToken || '').trim();
  record.name = sanitizeAccountName(rawName, record.name);
  if (tokenText) record.encryptedToken = encryptToken(validateOfficialToken(tokenText));
  record.updatedAt = clock.now();
  saveOfficialRecords(records);
  return { accountId: record.id, providers: providerStatus() };
}

function resetOfficialEnvOverride() {
  if (!String(settings.naiToken || '').trim()) {
    const error = new Error('服务器 .env 没有 NOVELAI_API_TOKEN，无法恢复。');
    error.status = 400;
    throw error;
  }
  setAppState(OFFICIAL_ENV_OVERRIDE_STATE_KEY, '');
  return providerStatus();
}

function setDefaultOfficialAccount(accountId) {
  const account = resolveOfficialAccount(accountId);
  setAppState(OFFICIAL_DEFAULT_ACCOUNT_STATE_KEY, account.id);
  return providerStatus();
}

function deleteOfficialToken(accountId) {
  const id = String(accountId || '');
  if (id === OFFICIAL_ENV_ACCOUNT_ID) {
    const error = new Error('.env 中的 NOVELAI_API_TOKEN 不能在 UI 删除。');
    error.status = 400;
    throw error;
  }
  const records = storedOfficialRecords();
  const next = records.filter(record => record.id !== id);
  if (next.length === records.length) {
    const error = new Error('NovelAI 官网 Token 不存在。');
    error.status = 404;
    throw error;
  }
  saveOfficialRecords(next);
  if (getAppState(OFFICIAL_DEFAULT_ACCOUNT_STATE_KEY, '') === id) setAppState(OFFICIAL_DEFAULT_ACCOUNT_STATE_KEY, '');
  return providerStatus();
}

function resolveOfficialAccount(accountId = '') {
  const requested = String(accountId || '').trim();
  const records = storedOfficialRecords();
  const env = effectiveOfficialEnvToken();
  const selectedId = requested || validDefaultAccountId(records, Boolean(env.token));
  if (selectedId === OFFICIAL_ENV_ACCOUNT_ID && env.token) {
    return {
      id: OFFICIAL_ENV_ACCOUNT_ID,
      name: env.overridden ? '默认 Token' : '.env 默认 Token',
      source: env.overridden ? 'ui-default' : 'env',
      token: validateOfficialToken(env.token)
    };
  }
  const selected = records.find(record => record.id === selectedId);
  if (!selected) {
    const error = new Error(selectedId ? '所选 NovelAI 官网 Token 已不存在，请重新选择。' : '尚未配置可用的 NovelAI 官网 Token。');
    error.status = 400;
    throw error;
  }
  try {
    return {
      id: selected.id,
      name: selected.name,
      source: 'ui',
      token: validateOfficialToken(decryptToken(selected.encryptedToken, `NovelAI Token「${selected.name}」`))
    };
  } catch (cause) {
    cause.status = 400;
    throw cause;
  }
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safePricing(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result = {};
  for (const [key, value] of Object.entries(raw).slice(0, 30)) {
    if (!/^[a-z0-9_]{1,60}$/i.test(key)) continue;
    if (typeof value === 'boolean' || typeof value === 'string') result[key] = String(value).slice(0, 120);
    else if (Number.isFinite(Number(value))) result[key] = Number(value);
    else if (value === null) result[key] = null;
  }
  return result;
}

function normalizeRbqAccount(raw) {
  const totalImages = nullableNumber(raw?.total_images) ?? 0;
  const quotaImages = nullableNumber(raw?.quota_images);
  const remainingImages = quotaImages === null ? null : Math.max(0, quotaImages - totalImages);
  return {
    name: String(raw?.name || 'RBQ').slice(0, 120),
    active: raw?.is_active === true,
    role: String(raw?.role || '').slice(0, 40),
    maxConcurrent: Math.max(0, nullableNumber(raw?.max_concurrent) ?? 0),
    usage: {
      totalRequests: Math.max(0, nullableNumber(raw?.total_requests) ?? 0),
      totalImages: Math.max(0, totalImages),
      totalAnlas: Math.max(0, nullableNumber(raw?.total_anlas) ?? 0),
      quotaRequests: nullableNumber(raw?.quota_requests),
      quotaImages,
      quotaAnlas: nullableNumber(raw?.quota_anlas),
      remainingImages
    },
    expiresAt: raw?.expires_at == null ? null : String(raw.expires_at).slice(0, 120),
    freeOnly: raw?.free_only === true,
    hasSecurityCode: raw?.has_security_code === true,
    pricing: safePricing(raw?.pricing),
    fetchedAt: clock.now()
  };
}

async function getRbqAccountStatus(options = {}) {
  const token = getRbqToken();
  if (!token) {
    const error = new Error('RBQ 中转尚未配置 API Key。');
    error.status = 400;
    throw error;
  }
  const timeoutMs = Math.min(30_000, Math.max(3_000, Number(options.timeoutMs || 12_000)));
  let response;
  try {
    response = await http.fetch(settings.rbqNaiUserInfoApi, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store'
    });
  } catch (cause) {
    const error = new Error(cause?.name === 'TimeoutError' ? 'RBQ 余额查询超时。' : `RBQ 余额查询失败：${cause?.message || cause}`);
    error.status = 502;
    throw error;
  }
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) {
    const error = new Error(String(payload?.detail || payload?.message || payload?.error || `RBQ 返回 HTTP ${response.status}`).slice(0, 500));
    error.status = response.status === 401 || response.status === 403 ? response.status : 502;
    throw error;
  }
  return normalizeRbqAccount(payload);
}

function tokenHint(token) {
  if (!token) return '';
  if (token.length <= 10) return `${token.slice(0, 2)}…${token.slice(-2)}`;
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function providerStatus() {
  let rbqToken = '';
  let rbqError = '';
  let storedToken = '';
  try {
    storedToken = storedRbqToken();
    rbqToken = storedToken || String(settings.rbqNaiToken || '').trim();
  }
  catch (error) { rbqError = String(error?.message || error); }
  let officialRecords = [];
  let officialError = '';
  try { officialRecords = storedOfficialRecords(); }
  catch (error) { officialError = String(error?.message || error); }
  let envToken = '';
  let envOverridden = false;
  let envError = '';
  try {
    const env = effectiveOfficialEnvToken();
    envToken = env.token;
    envOverridden = env.overridden;
  } catch (error) {
    envError = String(error?.message || error);
  }
  const defaultAccountId = validDefaultAccountId(officialRecords, Boolean(envToken || envError));
  const officialAccounts = [];
  if (envToken || envError) {
    officialAccounts.push({
      id: OFFICIAL_ENV_ACCOUNT_ID,
      name: envOverridden ? '默认 Token' : '.env 默认 Token',
      tokenHint: tokenHint(envToken),
      source: envOverridden ? 'ui-default' : 'env',
      editable: true,
      removable: false,
      resettable: envOverridden && Boolean(settings.naiToken),
      isDefault: defaultAccountId === OFFICIAL_ENV_ACCOUNT_ID,
      error: envError
    });
  }
  officialAccounts.push(...officialRecords.map(record => publicOfficialAccount(record, defaultAccountId)));
  return {
    official: {
      id: 'official',
      label: 'NovelAI 官方',
      configured: officialAccounts.length > 0,
      endpoint: settings.naiImageApi,
      accounts: officialAccounts,
      defaultAccountId,
      error: officialError
    },
    rbq: {
      id: 'rbq',
      label: 'RBQ 中转',
      configured: Boolean(rbqToken),
      endpoint: settings.rbqNaiImageApi,
      tokenHint: tokenHint(rbqToken),
      source: storedToken ? 'ui' : (settings.rbqNaiToken ? 'env' : ''),
      error: rbqError
    },
    relays: relayStatus(),
    customRelays: Boolean(allowCustomRelays)
  };
}

function relayStatus() {
  try { return storedRelays().map(publicRelay); }
  catch (error) { return [{ id: '', name: '第三方中转', label: '第三方中转', configured: false, error: String(error?.message || error) }]; }
}

function generationProvider(providerId, officialAccountId = '') {
  if (providerId === 'rbq') {
    const token = getRbqToken();
    if (!token) {
      const error = new Error('RBQ 中转尚未配置 API Key；请先在生成通道下方保存 Key。');
      error.status = 400;
      throw error;
    }
    return { id: 'rbq', label: 'RBQ 中转', apiUrl: settings.rbqNaiImageApi, token };
  }
  if (String(providerId || '').startsWith(RELAY_PREFIX)) {
    const record = relayRecord(providerId);
    let token;
    try { token = validateRelayKey(decryptToken(record.encryptedKey, `中转「${record.name}」的 Key`)); }
    catch (cause) { cause.status = 400; throw cause; }
    return { id: `${RELAY_PREFIX}${record.id}`, label: `中转 · ${record.name}`, apiUrl: validateRelayUrl(record.apiUrl), token };
  }
  const account = resolveOfficialAccount(officialAccountId);
  return {
    id: 'official',
    label: `NovelAI 官方 · ${account.name}`,
    apiUrl: settings.naiImageApi,
    token: account.token,
    accountId: account.id,
    accountName: account.name
  };
}

return { getRbqToken, saveRbqToken, deleteRbqToken, saveRelay, deleteRelay, saveOfficialToken, updateOfficialToken, resetOfficialEnvOverride, setDefaultOfficialAccount, deleteOfficialToken, resolveOfficialAccount, normalizeRbqAccount, getRbqAccountStatus, providerStatus, generationProvider };
}
