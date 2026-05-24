import { Router } from 'express';
import { EventEmitter } from 'events';

// Global event bus: jobId → emitter
export const jobEventBus = new Map<string, EventEmitter>();

export function registerJob(jobId: string): EventEmitter {
  const emitter = new EventEmitter();
  jobEventBus.set(jobId, emitter);
  return emitter;
}

export function unregisterJob(jobId: string): void {
  jobEventBus.delete(jobId);
}

export interface CallbackRouterOptions {
  onConfirm?: (
    jobId: string,
    requestId: string,
    description: string,
    command?: string,
  ) => void;
}

export function createCallbackRouter(options?: CallbackRouterOptions): Router {
  const router = Router();

  router.post('/jobs/:jobId/events', (req, res) => {
    const { jobId } = req.params;
    const event = req.body as Record<string, unknown>;

    const emitter = jobEventBus.get(jobId);
    if (emitter) {
      emitter.emit('event', event);
    }

    // Confirmation requests: notify Slack so human can approve/deny.
    // The resolution channel is in confirmation.ts (long-poll GET endpoint).
    if (event.type === 'confirm') {
      const requestId = String(event.requestId ?? '');
      const description = String(event.description ?? '');
      const command = event.command ? String(event.command) : undefined;
      options?.onConfirm?.(jobId, requestId, description, command);
    }

    res.sendStatus(200);
  });

  return router;
}
