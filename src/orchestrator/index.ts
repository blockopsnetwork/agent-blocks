/**
 * Orchestrator — domain service that owns the job lifecycle.
 *
 * ADR-NOTE: The Orchestrator accepts IJobStore and SlackNotifier via constructor
 * injection (Ports & Adapters / Hexagonal Architecture). This keeps the domain
 * layer decoupled from infrastructure concerns (Redis, in-memory, Postgres) and
 * makes unit-testing trivial — pass a fake IJobStore, no I/O needed.
 */

import { createHash } from 'crypto';
import { AgentJob, GitHubIssue, IssueStatus } from '../types';
import { IJobStore } from '../ports/IJobStore';
import { SlackNotifier } from '../slack/notifier';
import { GitHubClient } from '../context/github';
import { planIssue } from '../agents/planning';
import { runCodingAgent } from '../agents/coding';
import { logger } from '../logger';

interface EnqueueOptions {
  issue: GitHubIssue;
  extraInstructions?: string | null;
  slackThread: { channel: string; ts: string; progressTs?: string };
}

export interface OrchestratorOptions {
  store: IJobStore;
  notifier: SlackNotifier;
  maxAgents?: number;
  stallTimeoutMs?: number;
}

export class Orchestrator {
  private readonly store: IJobStore;
  private readonly notifier: SlackNotifier;
  private readonly MAX_AGENTS: number;
  private readonly STALL_TIMEOUT_MS: number;
  private readonly MAX_ATTEMPTS = 3;

  constructor(
    private github: GitHubClient,
    opts: OrchestratorOptions,
  ) {
    this.store            = opts.store;
    this.notifier         = opts.notifier;
    this.MAX_AGENTS       = opts.maxAgents       ?? 5;
    this.STALL_TIMEOUT_MS = opts.stallTimeoutMs  ?? 300_000;
  }

  private static jobId(owner: string, repo: string, issueNumber: number): string {
    return createHash('sha256')
      .update(`${owner}/${repo}#${issueNumber}`)
      .digest('hex')
      .slice(0, 16);
  }

  async enqueue(opts: EnqueueOptions): Promise<AgentJob> {
    const id = Orchestrator.jobId(
      opts.issue.repo.owner,
      opts.issue.repo.name,
      opts.issue.number,
    );

    // Deduplication: return existing active job rather than spawning a duplicate
    const existing = await this.store.get(id);
    if (existing && !['pr_created', 'failed', 'cancelled'].includes(existing.status)) {
      logger.info({ jobId: id, issueNumber: opts.issue.number }, 'job already active, skipping enqueue');
      return existing;
    }

    const job: AgentJob = {
      id,
      issue: opts.issue,
      status: 'queued',
      attempts: 0,
      slackThread: opts.slackThread,
      createdAt: new Date(),
      lastEventAt: new Date(),
    };
    await this.store.save(job);
    logger.info(
      { jobId: job.id, issueNumber: job.issue.number, repo: job.issue.repo.fullName },
      'job enqueued',
    );
    this.runJob(job).catch(err => this.handleJobError(job, err));
    return job;
  }

  private async runJob(job: AgentJob): Promise<void> {
    const all = await this.store.list();
    const runningCount = all.filter(j =>
      j.status === 'coding' || j.status === 'planning' || j.status === 'hydrating'
    ).length;

    if (runningCount >= this.MAX_AGENTS) {
      setTimeout(() => this.runJob(job), 15_000);
      return;
    }

    job.attempts += 1;
    job.lastEventAt = new Date();
    await this.store.save(job);

    const logCtx = {
      jobId: job.id,
      issueNumber: job.issue.number,
      repo: job.issue.repo.fullName,
    };

    try {
      // Phase 1: Hydrate context
      await this.transition(job, 'hydrating');
      logger.info({ ...logCtx, stage: 'hydrating' }, 'hydrating context');
      const ctx = await this.github.hydrateContext(job.issue);

      // Phase 2: Plan
      await this.transition(job, 'planning');
      logger.info({ ...logCtx, stage: 'planning' }, 'planning issue');
      const t0Plan = Date.now();
      const plan = await planIssue(ctx);
      job.plan = plan;
      await this.store.save(job);
      logger.info(
        { ...logCtx, stage: 'planning', durationMs: Date.now() - t0Plan },
        'plan ready',
      );
      await this.notifier.updateProgress(job);

      // Phase 3: Code
      await this.transition(job, 'coding');
      logger.info({ ...logCtx, stage: 'coding' }, 'starting coding agent');
      const t0Code = Date.now();
      const result = await runCodingAgent(ctx, plan, job.attempts, (_type) => {
        job.lastEventAt = new Date();
      });
      logger.info(
        { ...logCtx, stage: 'coding', durationMs: Date.now() - t0Code },
        'coding done',
      );

      // Phase 4: Validate (diff review — non-blocking)
      await this.transition(job, 'validating');
      job.prUrl = result.prUrl;
      await this.store.save(job);

      // Phase 5: Done
      await this.transition(job, 'pr_created');
      logger.info({ ...logCtx, stage: 'pr_created' }, `PR created: ${result.prUrl}`);

      await this.github.commentOnIssue(
        job.issue.repo.owner,
        job.issue.repo.name,
        job.issue.number,
        `Block has created a PR to fix this issue: ${result.prUrl}`,
      );

    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      await this.handleJobError(job, e);
    }
  }

  private async handleJobError(job: AgentJob, err: Error): Promise<void> {
    job.error = err.message;
    const logCtx = {
      jobId: job.id,
      issueNumber: job.issue.number,
      repo: job.issue.repo.fullName,
      error: err.message,
    };

    if (job.attempts < this.MAX_ATTEMPTS) {
      const backoffMs = Math.min(10_000 * Math.pow(2, job.attempts - 1), 300_000);
      logger.warn({ ...logCtx, backoffMs, attempt: job.attempts }, 'job failed, scheduling retry');
      setTimeout(() => {
        job.error = undefined;
        this.runJob(job).catch(e =>
          this.handleJobError(job, e instanceof Error ? e : new Error(String(e)))
        );
      }, backoffMs);
      await this.transition(job, 'failed');
    } else {
      logger.error({ ...logCtx, attempt: job.attempts }, 'job exhausted all attempts');
      await this.transition(job, 'failed');
    }
  }

  private async transition(job: AgentJob, status: IssueStatus): Promise<void> {
    job.status = status;
    job.lastEventAt = new Date();
    await this.store.save(job);
    await this.notifier.updateProgress(job);
  }

  async getActiveJobs(): Promise<AgentJob[]> {
    const terminal: IssueStatus[] = ['pr_created', 'failed', 'cancelled'];
    const all = await this.store.list();
    return all.filter(j => !terminal.includes(j.status));
  }

  async cancelByIssueNumber(issueNumber: number): Promise<boolean> {
    const all = await this.store.list();
    const job = all.find(j => j.issue.number === issueNumber);
    if (!job) return false;
    job.status = 'cancelled';
    this.notifier.updateProgress(job).catch(() => {});
    await this.store.delete(job.id);
    logger.info({ jobId: job.id, issueNumber }, 'job cancelled');
    return true;
  }

  // Stall detection — call on a timer
  async reconcile(): Promise<void> {
    const now = Date.now();
    const active: IssueStatus[] = ['hydrating', 'planning', 'coding', 'validating'];
    const all = await this.store.list();
    for (const job of all) {
      if (!active.includes(job.status)) continue;
      const elapsed = now - job.lastEventAt.getTime();
      if (elapsed > this.STALL_TIMEOUT_MS) {
        logger.warn(
          {
            jobId: job.id,
            issueNumber: job.issue.number,
            repo: job.issue.repo.fullName,
            elapsed,
          },
          'stall detected — triggering error handling',
        );
        await this.handleJobError(
          job,
          new Error(`Agent stalled after ${Math.round(elapsed / 1000)}s`),
        );
      }
    }
  }
}
