// Native host only: after a finished image is committed to the in-app gallery,
// put a copy of the original bytes into the phone's photo album (Pictures/NAI Pocket).
// The image is already paid for and saved, so nothing here may fail the job or cause
// a retry: copy() never rejects and schedule() never blocks the queue.

export const PHONE_GALLERY_KEY = 'phone_gallery_copy';

// Same name as the in-app 「下载原图」 export (service/media.js original download).
export function phoneGalleryName(row) {
  const created = new Date(Number(row.created_at) || Date.now()).toISOString().replace(/[:.]/g, '-');
  return `nai-${created}.${row.mime === 'image/webp' ? 'webp' : 'png'}`;
}

const reasons = {
  'permission-denied': '未获得存储权限，未复制到手机相册；应用内图库已保存。可在系统设置中允许存储权限。',
  'permission-pending': '应用在后台，暂未请求存储权限，本张未复制到手机相册；应用内图库已保存。'
};

export function createPhoneGallery({ state, save, locate, log = async () => {}, notify = () => {} }) {
  let tail = Promise.resolve();
  const notified = new Set();

  async function enabled() { return String(await state.get(PHONE_GALLERY_KEY, '1')) !== '0'; }
  async function setEnabled(value) { await state.set(PHONE_GALLERY_KEY, value ? '1' : '0'); return Boolean(value); }

  async function note(jobId, kind, message) {
    try { await log(jobId, 'warn', 'phone-gallery', message); } catch {}
    // One toast per kind and session; every image still gets a job log line.
    if (!notified.has(kind)) { notified.add(kind); try { notify(message); } catch {} }
  }

  async function copy(jobId, row) {
    try {
      if (!row || !await enabled()) return { saved: false, skipped: true };
      const result = await save({ path: locate(row), mime: row.mime, name: phoneGalleryName(row) });
      if (result?.saved) {
        try { await log(jobId, 'info', 'phone-gallery', '已另存到手机相册 Pictures/NAI Pocket。'); } catch {}
        return result;
      }
      const reason = String(result?.reason || 'failed');
      await note(jobId, reason, reasons[reason] || '未能复制到手机相册；应用内图库已保存。');
      return { saved: false, reason };
    } catch (error) {
      await note(jobId, 'error', `复制到手机相册失败：${error?.message || error}；应用内图库已保存。`);
      return { saved: false, reason: 'error' };
    }
  }

  // Serialise copies without making the queue wait (a first-run permission
  // prompt on Android 7-9 can wait for the person indefinitely).
  function schedule(jobId, row) {
    const run = tail.then(() => copy(jobId, row));
    tail = run;
    return run;
  }

  return { enabled, setEnabled, copy, schedule };
}
