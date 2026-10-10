import { flow } from '../port-flow.js';
const SUMMARY_COLUMNS = 'id,batch_id,mime,width,height,bytes,thumb_bytes,preview_bytes,prompt,negative_prompt,seed,favorite,note,created_at';
const QUALIFIED_SUMMARY_COLUMNS = SUMMARY_COLUMNS.split(',').map(column => `i.${column}`).join(',');

export function createJobsStore(db) {
  return {
    listJobs: flow(function* (limit) {
      return (yield db.prepare(`
        SELECT
          j.id,j.batch_id,j.position,j.status,j.seed,j.attempts,j.error,j.image_id,j.initiated_at,j.created_at,j.started_at,j.finished_at,
          COALESCE(json_extract(j.request_json, '$.provider'), 'official') AS provider,
          json_extract(j.request_json, '$.officialAccountId') AS official_account_id,
          json_extract(j.request_json, '$.experiment') AS experiment_json,
          (SELECT l.message FROM job_logs l WHERE l.job_id=j.id ORDER BY l.id DESC LIMIT 1) AS last_log,
          (SELECT l.phase FROM job_logs l WHERE l.job_id=j.id ORDER BY l.id DESC LIMIT 1) AS last_log_phase,
          (SELECT l.level FROM job_logs l WHERE l.job_id=j.id ORDER BY l.id DESC LIMIT 1) AS last_log_level,
          (SELECT l.created_at FROM job_logs l WHERE l.job_id=j.id ORDER BY l.id DESC LIMIT 1) AS last_log_at,
          (SELECT l.message FROM job_logs l WHERE l.job_id=j.id AND l.phase='billing' ORDER BY l.id DESC LIMIT 1) AS billing_log,
          (SELECT l.detail_json FROM job_logs l WHERE l.job_id=j.id AND l.phase='billing' ORDER BY l.id DESC LIMIT 1) AS billing_detail_json,
          (SELECT l.message FROM job_logs l WHERE l.job_id=j.id AND l.level IN ('warn','error') ORDER BY l.id DESC LIMIT 1) AS last_problem,
          (SELECT l.created_at FROM job_logs l WHERE l.job_id=j.id AND l.level IN ('warn','error') ORDER BY l.id DESC LIMIT 1) AS last_problem_at
        FROM jobs j
        ORDER BY
          CASE WHEN j.status='running' THEN 0 WHEN j.status='pending' THEN 1 ELSE 2 END,
          CASE WHEN j.status IN ('running','pending') THEN j.created_at END ASC,
          CASE WHEN j.status NOT IN ('running','pending') THEN j.created_at END DESC
        LIMIT ?
      `).all(limit));
    }),

    countJobs: flow(function* () {
      return (yield db.prepare(`
        SELECT
          SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
        FROM jobs
      `).get());
    }),

    completedImagesAfter: flow(function* (cursor, limit) {
      return (yield db.prepare(`
        SELECT j.id AS completion_job_id,j.finished_at AS completion_finished_at,${QUALIFIED_SUMMARY_COLUMNS}
        FROM jobs j
        INNER JOIN images i ON i.id=j.image_id
        WHERE j.status='completed' AND j.finished_at IS NOT NULL
          AND (j.finished_at>? OR (j.finished_at=? AND j.id>?))
        ORDER BY j.finished_at ASC,j.id ASC
        LIMIT ?
      `).all(cursor.finishedAt, cursor.finishedAt, cursor.id, limit));
    }),

    latestCompletion: flow(function* () {
      return (yield db.prepare(`
        SELECT j.id AS completion_job_id,j.finished_at AS completion_finished_at
        FROM jobs j
        INNER JOIN images i ON i.id=j.image_id
        WHERE j.status='completed' AND j.finished_at IS NOT NULL
        ORDER BY j.finished_at DESC,j.id DESC
        LIMIT 1
      `).get());
    })
  };
}
