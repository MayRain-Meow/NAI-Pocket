import { flow } from '../port-flow.js';
export function createQueueWorkerStore(db) {
  return {
    claim: flow(function* (id, attempts, startedAt) {
      return Number((yield db.prepare("UPDATE jobs SET status='running', attempts=?, started_at=? WHERE id=? AND status='pending'").run(attempts, startedAt, id)).changes);
    }),
    pending: flow(function* (id, message, rateLimit) {
      if (rateLimit) return (yield db.prepare("UPDATE jobs SET status='pending', error=?, started_at=NULL, finished_at=NULL WHERE id=? AND status='running'").run(message, id));
      return (yield db.prepare("UPDATE jobs SET status='pending', error=?, started_at=NULL WHERE id=? AND status='running'").run(message, id));
    }),
    fail: flow(function* (id, message, now) {
      return (yield db.prepare("UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=? AND status='running'").run(message, now, id));
    })
  };
}
