
export function createQueueRunner({ control, nextJob, processOne, clearCooldown, setActive, onError }) {
  let running = null, requested = false, wake = null;

  function wait(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(finish, ms);
      function finish() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = finish;
    });
  }

  async function drain() {
    try {
      do {
        while (true) {
          requested = false;
          if (await control.isQueuePaused()) break;
          const job = await nextJob();
          if (!job) break;
          // Also refresh the existing service's bounded wake lock. Do not stop
          // the service during a retry wait: Android can reject a background restart.
          await setActive(true);
          const cooldown = await control.queueCooldownUntil();
          if (cooldown > Date.now()) {
            // An edit may arrive while reading state, before a wait is installed.
            if (!requested) await wait(Math.min(60000, cooldown - Date.now()));
            continue;
          }
          if (cooldown) await clearCooldown();
          await processOne(job);
        }
        await setActive(false);
        // A new job/resume may arrive while the native stop is in flight.
      } while (requested);
    } catch (error) {
      try { await onError(error); }
      finally { await setActive(false); }
    } finally {
      running = null;
    }
  }

  function kick() {
    requested = true;
    wake?.();
    // Defer drain so even synchronous port errors have the same ownership.
    running ??= Promise.resolve().then(drain);
    return running;
  }
  return { kick };
}
