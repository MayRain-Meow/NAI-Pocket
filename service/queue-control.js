import { flow } from './port-flow.js';

export function createQueueControl({ db, transaction, settings, getAppState, setAppState, generationProvider, activeJobControllers, randomSeed, clock = { now: () => Date.now() }, isV5GenerationModel, logger = console }) {
let startupRecoveryDone = false;
const JOB_LOG_LIMIT = 80;
function isV5State(state) {
  return isV5GenerationModel(state?.model);
}
function providerLabel(state) {
  return state?.provider === 'rbq' ? 'RBQ 中转' : 'NovelAI 官方';
}
function billingMessage(delta) {
  if (!delta) return '本次计费状态暂不可用。';
  const parts = ['本次计费'];
  if (delta.v5 && delta.before.usagePercent != null && delta.after.usagePercent != null) {
    const net = delta.delta.usagePercentNet;
    if (delta.before.usageUnavailable) parts.push(`V5 免费额度不可用 · ${delta.before.usagePercent}% → ${delta.after.usagePercent}%`);
    else if (net > 0) parts.push(`V5 ${delta.before.usagePercent}% → ${delta.after.usagePercent}%（净 -${net}%）`);
  }
  if (delta.delta.anlasSpent > 0 && delta.before.anlasTotal != null && delta.after.anlasTotal != null) {
    parts.push(`Anlas ${delta.before.anlasTotal} → ${delta.after.anlasTotal}（-${delta.delta.anlasSpent}）`);
  }
  return parts.length > 1 ? parts.join(' · ') : '';
}
function safeLogDetail(detail) {
  if (detail == null) return null;
  try { return JSON.stringify(detail).slice(0, 12_000); }
  catch { return JSON.stringify({ note: String(detail) }).slice(0, 12_000); }
}
const appendJobLog = flow(function* (jobId, level, phase, message, detail = null) {
  const normalizedLevel = ['info', 'warn', 'error'].includes(level) ? level : 'info';
  const now = clock.now();
  (yield db.prepare(`
    INSERT INTO job_logs(job_id,level,phase,message,detail_json,created_at)
    VALUES (?,?,?,?,?,?)
  `).run(String(jobId), normalizedLevel, String(phase || ''), String(message || '').slice(0, 4000), safeLogDetail(detail), now));
  (yield db.prepare(`
    DELETE FROM job_logs
    WHERE job_id=? AND id NOT IN (
      SELECT id FROM job_logs WHERE job_id=? ORDER BY id DESC LIMIT ?
    )
  `).run(String(jobId), String(jobId), JOB_LOG_LIMIT));
  return now;
});
const getJobLogs = flow(function* (jobId, limit = JOB_LOG_LIMIT) {
  const bounded = Math.max(1, Math.min(JOB_LOG_LIMIT, Number(limit) || JOB_LOG_LIMIT));
  return (yield db.prepare(`
    SELECT id,level,phase,message,detail_json,created_at
    FROM job_logs WHERE job_id=? ORDER BY id ASC LIMIT ?
  `).all(String(jobId), bounded)).map(row => ({
    ...row,
    detail: (() => { try { return row.detail_json ? JSON.parse(row.detail_json) : null; } catch { return row.detail_json || null; } })()
  }));
});
function chooseSeed(state, index) {
  if (state.seedMode === 'fixed') return state.seed;
  if (state.seedMode === 'increment') return (state.seed + index) >>> 0;
  return randomSeed();
}
function retryable(error) {
  if (error?.code === 'JOB_DEADLINE' || error?.code === 'JOB_CANCELLED') return false;
  // A successful NovelAI response already billed the attempt. Local save bugs
  // (missing import, ImageMagick, SQLite) used to look like status 0 and pay again.
  
  if (error?.imageReceived) return false;
  if (error instanceof ReferenceError || error instanceof TypeError) return false;
  const status = Number(error.status || 0);
  if ([400, 401, 402, 403, 404, 409, 422].includes(status)) return false;
  return status === 429 || status === 0 || status >= 500;
}
function rateLimitDelayMs(error) {
  const hinted = Math.max(0, Number(error?.retryAfterMs || 0));
  // 429 uses a predictable fixed cooldown. Honor a longer server Retry-After when provided.
  return Math.max(settings.rateLimitIntervalMs, hinted);
}
const queueCooldownUntil = flow(function* () {
  return Math.max(0, Number((yield getAppState('queue_rate_limit_until', '0')) || 0));
});
const currentJobStatus = flow(function* (jobId) {
  return (yield db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId))?.status || null;
});
function cancelledError() {
  const error = new Error('生成任务已取消。');
  error.code = 'JOB_CANCELLED';
  return error;
}
const recoverOrphanedRunningJobs = flow(function* () {
  if (startupRecoveryDone) return 0;
  startupRecoveryDone = true;
  const rows = (yield db.prepare("SELECT id FROM jobs WHERE status='running'").all());
  if (!rows.length) return 0;
  const now = clock.now();
  const message = '服务重启中断了正在生成的任务；任务未自动重试，以避免重复消耗。可手动重试。';
  const result = (yield db.prepare(`
    UPDATE jobs SET status='failed', error=?, finished_at=? WHERE status='running'
  `).run(message, now));
  for (const row of rows) (yield appendJobLog(row.id, 'error', 'recovered', message));
  logger.warn(`[queue] recovered ${result.changes} orphaned running job(s) as failed`);
  return Number(result.changes || 0);
});
const cancelJob = flow(function* (jobId) {
  const row = (yield db.prepare('SELECT id,status FROM jobs WHERE id=?').get(jobId));
  if (!row) return { ok: false, reason: '任务不存在。' };
  if (row.status === 'cancelled') return { ok: true, cancelled: 0, alreadyCancelled: true };
  if (!['pending', 'running'].includes(row.status)) return { ok: false, reason: '只能取消等待中或生成中的任务。' };

  const result = (yield db.prepare("UPDATE jobs SET status='cancelled',finished_at=? WHERE id=? AND status IN ('pending','running')").run(clock.now(), jobId));
  if (Number(result.changes)) (yield appendJobLog(jobId, 'warn', 'cancel-requested', row.status === 'running' ? '用户请求停止正在生成的任务。' : '用户取消了等待中的任务。'));
  const controller = activeJobControllers.get(jobId);
  if (controller && !controller.signal.aborted) controller.abort();
  return { ok: Number(result.changes) > 0, cancelled: Number(result.changes || 0), wasRunning: row.status === 'running' };
});
const pauseForAccountError = flow(function* (jobId, state, status, message) {
  let label = providerLabel(state);
  try { label = (yield generationProvider(state.provider, state.officialAccountId)).label; } catch {}
  (yield setAppState('queue_paused', '1'));
  (yield setAppState('queue_pause_reason', JSON.stringify({
    kind: 'account', status, jobId, label, at: clock.now(),
    route: { provider: state.provider === 'rbq' ? 'rbq' : 'official', officialAccountId: String(state.officialAccountId || '') },
    message: String(message || '').slice(0, 300)
  })));
});
const queuePauseReason = flow(function* () {
  if ((yield getAppState('queue_paused', '0')) !== '1') return null;
  try { return JSON.parse((yield getAppState('queue_pause_reason', '')) || 'null') || { kind: 'manual' }; } catch { return { kind: 'manual' }; }
});
const cancelQueuedJobs = flow(function* ({ includeRunning = false } = {}) {
  const statuses = includeRunning ? ['pending', 'running'] : ['pending'];
  const marks = statuses.map(() => '?').join(',');
  const rows = (yield db.prepare(`SELECT id,status FROM jobs WHERE status IN (${marks})`).all(...statuses));
  if (!rows.length) return { ok: true, cancelled: 0 };
  const result = (yield db.prepare(`UPDATE jobs SET status='cancelled',finished_at=? WHERE status IN (${marks})`).run(clock.now(), ...statuses));
  for (const row of rows) {
    (yield appendJobLog(row.id, 'warn', 'cancel-requested', row.status === 'running' ? '全部取消：请求停止正在生成的任务。' : '全部取消：取消等待中的任务。'));
    const controller = activeJobControllers.get(row.id);
    if (controller && !controller.signal.aborted) controller.abort();
  }
  return { ok: true, cancelled: Number(result.changes || 0) };
});
const rerouteQueuedJobs = flow(function* ({ provider, officialAccountId = '' } = {}) {
  const target = { provider: provider === 'rbq' ? 'rbq' : 'official', officialAccountId: provider === 'rbq' ? '' : String(officialAccountId || '') };
  const route = (yield generationProvider(target.provider, target.officialAccountId));
  if (route.accountId) target.officialAccountId = route.accountId;
  const reason = (yield queuePauseReason());
  const rows = (yield db.prepare("SELECT id,status,request_json FROM jobs WHERE status='pending'").all());
  if (reason?.kind === 'account' && reason.jobId) {
    const failed = (yield db.prepare("SELECT id,status,request_json FROM jobs WHERE id=? AND status='failed'").get(reason.jobId));
    if (failed) rows.push(failed);
  }
  let moved = 0, skipped = 0, retried = 0;
  const update = db.prepare('UPDATE jobs SET request_json=? WHERE id=? AND status=?');
  const requeue = db.prepare("UPDATE jobs SET status='pending',request_json=?,attempts=0,error=NULL,started_at=NULL,finished_at=NULL WHERE id=? AND status='failed'");
  (yield transaction(function* () {
    for (const row of rows) {
      let state;
      try { state = JSON.parse(row.request_json); } catch { skipped += 1; continue; }
      if (target.provider === 'rbq' && state.imageTool?.type && state.imageTool.type !== 'none') { skipped += 1; continue; }
      state.provider = target.provider;
      state.officialAccountId = target.officialAccountId;
      const json = JSON.stringify(state);
      if (row.status === 'failed') {
        if (Number((yield requeue.run(json, row.id)).changes)) { retried += 1; (yield appendJobLog(row.id, 'info', 'rerouted', `改用 ${route.label} 重试。`)); }
      } else if (Number((yield update.run(json, row.id, 'pending')).changes)) {
        moved += 1;
        (yield appendJobLog(row.id, 'info', 'rerouted', `改用 ${route.label}。`));
      }
    }
  }));
  return { ok: true, moved, skipped, retried, label: route.label };
});
const cancelBatch = flow(function* (batchId) {
  const rows = (yield db.prepare("SELECT id,status FROM jobs WHERE batch_id=? AND status IN ('pending','running')").all(batchId));
  if (!rows.length) return { ok: true, cancelled: 0 };
  const result = (yield db.prepare("UPDATE jobs SET status='cancelled',finished_at=? WHERE batch_id=? AND status IN ('pending','running')").run(clock.now(), batchId));
  for (const row of rows) {
    (yield appendJobLog(row.id, 'warn', 'cancel-requested', row.status === 'running' ? '批次取消：请求停止正在生成的任务。' : '批次取消：取消等待中的任务。'));
    const controller = activeJobControllers.get(row.id);
    if (controller && !controller.signal.aborted) controller.abort();
  }
  return { ok: true, cancelled: Number(result.changes || 0) };
});
const retryJob = flow(function* (jobId) {
  const row = (yield db.prepare("SELECT id,status,error FROM jobs WHERE id=?").get(jobId));
  if (!row) return { ok: false, reason: '任务不存在。' };
  if (row.status !== 'failed') return { ok: false, reason: '只有失败任务可以重试。' };
  const result = (yield db.prepare("UPDATE jobs SET status='pending',attempts=0,started_at=NULL,finished_at=NULL WHERE id=? AND status='failed'").run(jobId));
  if (Number(result.changes)) (yield appendJobLog(jobId, 'info', 'manual-retry', '用户手动重试任务；上一次错误与日志已保留。'));
  return Number(result.changes) ? { ok: true } : { ok: false, reason: '任务状态已经变化。' };
});
const setQueuePaused = flow(function* (paused) {
  (yield setAppState('queue_paused', paused ? '1' : '0'));
  (yield setAppState('queue_pause_reason', paused ? JSON.stringify({ kind: 'manual', at: clock.now() }) : ''));
});
const isQueuePaused = flow(function* () {
  return (yield getAppState('queue_paused', '0')) === '1';
});
return { isV5State, providerLabel, billingMessage, safeLogDetail, chooseSeed, retryable, rateLimitDelayMs, cancelledError, appendJobLog, getJobLogs, queueCooldownUntil, currentJobStatus, recoverOrphanedRunningJobs, cancelJob, pauseForAccountError, queuePauseReason, cancelQueuedJobs, rerouteQueuedJobs, cancelBatch, retryJob, setQueuePaused, isQueuePaused };
}
