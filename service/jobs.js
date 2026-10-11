import { normalizeProviderId } from '../public/provider-route.js';

export class JobsServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'JobsServiceError';
    this.status = status;
  }
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

export function createJobsService({ store, cursors, state, queue }) {
  if (!store || !cursors || !state || !queue) throw new TypeError('jobs service ports are required');

  return {
    async list(searchParams) {
      const limit = clampInt(searchParams.get('limit'), 100, 1, 300);
      const rows = await store.listJobs(limit);
      const jobs = rows.map(row => {
        const billing = parseJson(row.billing_detail_json);
        const experiment = parseJson(row.experiment_json);
        const { billing_detail_json, experiment_json, ...safeRow } = row;
        return { ...safeRow, billing, provider: normalizeProviderId(row.provider), experiment };
      });

      const counts = await store.countJobs();
      const tracksCompletions = searchParams.has('completionCursor');
      const rawCompletionCursor = String(searchParams.get('completionCursor') || '');
      const requestedCompletionCursor = tracksCompletions
        ? cursors.decodeGalleryCompletionCursor(rawCompletionCursor)
        : null;
      if (tracksCompletions && !requestedCompletionCursor) {
        throw new JobsServiceError(400, '生成完成游标无效，请刷新页面。');
      }

      let completionRows = [];
      let completionHasMore = false;
      let completionCursor = '';
      if (tracksCompletions) {
        completionRows = await store.completedImagesAfter(requestedCompletionCursor, cursors.completionLimit + 1);
        completionHasMore = completionRows.length > cursors.completionLimit;
        if (completionHasMore) completionRows = completionRows.slice(0, cursors.completionLimit);
        completionCursor = completionRows.length
          ? cursors.encodeGalleryCompletionCursor(completionRows.at(-1))
          : rawCompletionCursor;
      } else {
        const latestCompletion = await store.latestCompletion();
        completionCursor = cursors.encodeGalleryCompletionCursor(latestCompletion || { finished_at: 0, id: '' });
      }

      const newestCompletedImage = completionRows.length
        ? [...completionRows].sort((left, right) => Number(right.created_at) - Number(left.created_at) || String(right.id).localeCompare(String(left.id)))[0]
        : null;
      return {
        paused: await queue.isPaused(),
        pauseReason: await queue.pauseReason(),
        cooldownUntil: Math.max(0, Number(await state.get('queue_rate_limit_until', '0') || 0)),
        counts,
        completionCursor,
        completionHasMore,
        completionSnapshotCursor: newestCompletedImage ? cursors.encodeGalleryCursor(newestCompletedImage) : '',
        completedImages: completionRows.map(row => ({
          jobId: row.completion_job_id,
          cursor: cursors.encodeGalleryCompletionCursor(row),
          image: cursors.galleryImageSummary(row)
        })),
        jobs
      };
    }
  };
}
