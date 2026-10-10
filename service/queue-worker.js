
export function createQueueWorker({ store, settings, activeJobControllers = new Map(), clock = { now: () => Date.now() },
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), appendJobLog, providerLabel, ensureResources, currentJobStatus, cancelledError, isV5State, safeSubscriptionSnapshot, generateImage, calculateUsageDelta, billingMessage, saveImage, rateLimitDelayMs, setAppState, retryable, pauseForAccountError }) {
async function processOne(job) {
  const state = JSON.parse(job.request_json);
  const attempts = job.attempts + 1;
  const controller = new AbortController();
  activeJobControllers.set(job.id, controller);
  const startedAt = clock.now();
  let started;
  try { started = await store.claim(job.id, attempts, startedAt); }
  catch (error) { activeJobControllers.delete(job.id); throw error; }
  if (!Number(started)) {
    activeJobControllers.delete(job.id);
    return;
  }
  const operationLabel = state.imageTool?.type && state.imageTool.type !== 'none'
    ? (state.imageTool.type === 'upscale' ? '官方 Upscale' : `官方 Director Tools ${state.imageTool.reqType}`)
    : state.imageWorkflow?.enhance === true ? '官方 Enhance' : '图像生成';
  try { await appendJobLog(job.id, 'info', 'started', `开始${operationLabel} · ${providerLabel(state)} · 第 ${attempts} 次尝试`); }
  catch (error) { activeJobControllers.delete(job.id); throw error; }
  const deadlineMs = settings.naiTimeoutMs + 60_000;
  let deadlineTimer;
  const run = (async () => {
    await ensureResources();
    if ((await currentJobStatus(job.id)) === 'cancelled') throw cancelledError();
    const shouldTrackBilling = state.provider !== 'rbq' && (isV5State(state) || (state.imageTool?.type && state.imageTool.type !== 'none') || state.imageWorkflow?.enhance === true);
    const usageBefore = shouldTrackBilling ? await safeSubscriptionSnapshot(job.id, '生成前', state) : null;
    const result = await generateImage(state, job.seed, {
      signal: controller.signal,
      onEvent: event => {
        // Progress is best-effort; an async log failure must not discard a paid response.
        try { Promise.resolve(appendJobLog(job.id, event.level || 'info', event.phase || 'novelai', event.message || 'NovelAI 状态更新', event.detail || null)).catch(() => {}); }
        catch {}
      }
    });
    try {
      if ((await currentJobStatus(job.id)) === 'cancelled') throw cancelledError();
      if (shouldTrackBilling) {
        const usageAfter = await safeSubscriptionSnapshot(job.id, '生成后', state);
        const billing = calculateUsageDelta(usageBefore, usageAfter, { v5: true, model: state.model });
        const message = billingMessage(billing);
        if (billing && message) await appendJobLog(job.id, 'info', 'billing', message, billing);
      }
      await saveImage(job, result.effectiveState || state, result);
    } catch (error) {
      if (error && typeof error === 'object' && error.code !== 'JOB_CANCELLED') error.imageReceived = true;
      throw error;
    }
  })();
  try {
    // generateImage already has naiTimeoutMs, but ensureResources / billing /
    // saveImage / ImageMagick can ignore abort. The whole body has one deadline
    // so a stuck step always logs and workerLoop can take the next job.
    
    await Promise.race([
      run,
      new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error(`任务超过 ${Math.round(deadlineMs / 1000)} 秒总时限，已中止。`), { code: 'JOB_DEADLINE' }));
        }, deadlineMs);
      })
    ]);
  } catch (error) {
    const existingStatus = (await currentJobStatus(job.id));
    if (error?.code === 'JOB_CANCELLED' || existingStatus === 'cancelled') {
      await appendJobLog(job.id, 'warn', 'cancelled', '任务已停止；不会继续保存本次结果。');
      return;
    }

    const message = String(error?.message || error).slice(0, 4000);
    const status = Number(error?.status || 0);
    if (!error?.imageReceived && status === 429 && attempts <= settings.rateLimitRetries) {
      const delayMs = rateLimitDelayMs(error);
      const until = clock.now() + delayMs;
      await setAppState('queue_rate_limit_until', String(until));
      const seconds = Math.max(1, Math.ceil(delayMs / 1000));
      const retryMessage = `${providerLabel(state)} 429 限流：队列冷却约 ${seconds} 秒后自动重试（第 ${attempts}/${settings.rateLimitRetries} 次）。`;
      await appendJobLog(job.id, 'warn', 'retry-wait', retryMessage, { status, delayMs });
      await store.pending(job.id, retryMessage, true);
      return;
    }
    if (retryable(error) && status !== 429 && attempts <= settings.maxRetries) {
      const delayMs = Math.min(30_000, 3000 * attempts);
      await appendJobLog(job.id, 'warn', 'retry-wait', `生成异常，将在 ${Math.ceil(delayMs / 1000)} 秒后重试：${message}`, { status, delayMs });
      await store.pending(job.id, message, false);
      await sleep(delayMs);
      return;
    }
    await appendJobLog(job.id, 'error', 'failed', message, { status, ...(error?.code === 'JOB_DEADLINE' ? { deadlineMs } : {}) });
    await store.fail(job.id, message, clock.now());
    if ([401, 402, 403].includes(Number(error.status || 0))) await pauseForAccountError(job.id, state, status, message);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    activeJobControllers.delete(job.id);
  }
}


return { processOne };
}
