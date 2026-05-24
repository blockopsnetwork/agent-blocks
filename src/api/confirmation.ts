import { Router } from 'express';

// Oneshot channel per requestId — resolve fires exactly once when human decides.
// Zero polling on the server side: GET /confirm/:id holds open until resolution.
const pending = new Map<string, (approved: boolean) => void>();

const LONG_POLL_TIMEOUT_MS = 55_000; // keep under Cloudflare/ALB 60s idle timeout

export function resolveConfirmation(requestId: string, approved: boolean): boolean {
  const resolve = pending.get(requestId);
  if (!resolve) return false;
  pending.delete(requestId);
  resolve(approved);
  return true;
}

export function createConfirmationRouter(): Router {
  const router = Router();

  // Long-poll: agent-worker calls this once and waits. No busy-loop needed.
  // Resolves instantly if decision arrives; times out after ~55s (agent retries).
  router.get('/jobs/:jobId/confirm/:requestId', (req, res) => {
    const { requestId } = req.params;

    const timer = setTimeout(() => {
      pending.delete(requestId);
      res.json({ status: 'pending' }); // agent-worker will retry
    }, LONG_POLL_TIMEOUT_MS);

    pending.set(requestId, (approved: boolean) => {
      clearTimeout(timer);
      res.json({ status: approved ? 'approved' : 'denied' });
    });

    req.on('close', () => {
      // Client disconnected before we resolved — clean up
      clearTimeout(timer);
      pending.delete(requestId);
    });
  });

  return router;
}
