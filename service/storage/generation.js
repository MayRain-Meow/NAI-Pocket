import { flow } from '../port-flow.js';

export function createGenerationStore(db, transaction) {
  return {
    enqueue: flow(function* (rows, maxQueueSize, appendJobLog) {
      return yield transaction(function* () {
        const pending = Number((yield db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending','running')").get()).count);
        if (pending + rows.length > maxQueueSize) throw new Error(`队列最多允许 ${maxQueueSize} 个待处理任务。`);
        const insert = db.prepare(`INSERT INTO jobs(id,batch_id,position,status,request_json,seed,attempts,initiated_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
        for (const row of rows) {
          yield insert.run(row.id, row.batchId, row.position, 'pending', row.json, row.seed, 0, row.now, row.now + row.position - 1);
          yield appendJobLog(row.id, 'info', 'queued', `已加入队列 · Seed ${row.seed}`);
        }
      });
    }),
    saveImage: flow(function* (record) {
      return yield transaction(function* () {
        const status = (yield db.prepare('SELECT status FROM jobs WHERE id=?').get(record.jobId))?.status;
        if (status !== 'running') return false;
        yield db.prepare(`INSERT INTO images(id,job_id,batch_id,original_name,thumb_name,preview_name,mime,width,height,bytes,thumb_bytes,preview_bytes,prompt,negative_prompt,params_json,seed,created_at,kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...record.values);
        yield db.prepare("UPDATE jobs SET status='completed',image_id=?,finished_at=?,error=NULL WHERE id=? AND status='running'").run(record.id, record.now, record.jobId);
        return true;
      });
    })
  };
}
