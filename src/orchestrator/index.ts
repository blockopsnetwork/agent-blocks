import { v4 as uuid } from 'uuid';
import { AgentJob, GitHubIssue, IssueStatus } from '../types';
import { SlackNotifier } from '../slack/notifier';
import { GitHubClient } from '../context/github';
import { planIssue } from '../agents/planning';
import { runCodingAgent } from '../agents/coding';

interface EnqueueOptions {
  issue: GitHubIssue;
  extraInstructions?: string | null;
  slackThread: { channel: string; ts: string; progressTs?: string };
}

export class Orchestrator {
  private jobs = new Map<string, AgentJob>();
  private readonly MAX_AGENTS: number;
  private readonly STALL_TIMEOUT_MS: number;
  private readonly MAX_ATTEMPTS = 3;

  constructor(
    private notifier: SlackNotifier,
    private github: GitHubClient,
    options: { maxAgents?: number; stallTimeoutMs?: number } = {}
  ) {
    this.MAX_AGENTS = options.maxAgents ?? 5;
    this.STALL_TIMEOUT_MS = options.stallTimeoutMs ?? 300_000;
  }

  async enqueue(opts: EnqueueOptions): Promise<AgentJob> {
    const job: AgentJob = {
      id: uuid(),
      issue: opts.issue,
      status: 'queued',
      attempts: 0,
      slackThread: opts.slackThread,
      createdAt: new Date(),
      lastEventAt: new Date(),
    };
    this.jobs.set(job.id, job);
    this.runJob(job).catch(err => this.handleJobError(job, err));
    return job;
  }

  private async runJob(job: AgentJob): Promise<void> {
    const runningCount = [...this.jobs.values()].filter(j =>
      j.status === 'coding' || j.status === 'planning' || j.status === 'hydrating'
    ).length;

    if (runningCount >= this.MAX_AGENTS) {
      // Re-queue after delay
      setTimeout(() => this.runJob(job), 15_000);
      return;
    }

    job.attempts += 1;
    job.lastEventAt = new Date();

    try {
      // Phase 1: Hydrate context
      await this.transition(job, 'hydrating');
      const ctx = await this.github.hydrateContext(job.issue);

      // Phase 2: Plan
      await this.transition(job, 'planning');
      const plan = await planIssue(ctx);
      job.plan = plan;
      await this.notifier.updateProgress(job);

      // Phase 3: Code
      await this.transition(job, 'coding');
      const result = await runCodingAgent(ctx, plan, job.attempts, (type) => {
        job.lastEventAt = new Date();
        // Stall detection: callers update lastEventAt on every agent event
      });

      // Phase 4: Validate (LLM diff review posted as PR comment — non-blocking)
      await this.transition(job, 'validating');
      job.prUrl = result.prUrl;

      // Phase 5: Done
      await this.transition(job, 'pr_created');

      // Comment on GitHub issue with PR link
      await this.github.commentOnIssue(
        job.issue.repo.owner,
        job.issue.repo.name,
        job.issue.number,
        `Block has created a PR to fix this issue: ${result.prUrl}`
      );

    } catch (err: any) {
      await this.handleJobError(job, err);
    }
  }

  private async handleJobError(job: AgentJob, err: Error): Promise<void> {
    job.error = err.message;
    if (job.attempts < this.MAX_ATTEMPTS) {
      const backoffMs = Math.min(10_000 * Math.pow(2, job.attempts - 1), 300_000);
      setTimeout(() => {
        job.error = undefined;
        this.runJob(job).catch(e => this.handleJobError(job, e));
      }, backoffMs);
      await this.transition(job, 'failed');
    } else {
      await this.transition(job, 'failed');
    }
  }

  private async transition(job: AgentJob, status: IssueStatus): Promise<void> {
    job.status = status;
    job.lastEventAt = new Date();
    await this.notifier.updateProgress(job);
  }

  getActiveJobs(): AgentJob[] {
    const terminal: IssueStatus[] = ['pr_created', 'failed', 'cancelled'];
    return [...this.jobs.values()].filter(j => !terminal.includes(j.status));
  }

  cancelByIssueNumber(issueNumber: number): boolean {
    const job = [...this.jobs.values()].find(j => j.issue.number === issueNumber);
    if (!job) return false;
    job.status = 'cancelled';
    this.notifier.updateProgress(job).catch(() => {});
    this.jobs.delete(job.id);
    return true;
  }

  // Stall detection — call on a timer
  async reconcile(): Promise<void> {
    const now = Date.now();
    const active: IssueStatus[] = ['hydrating', 'planning', 'coding', 'validating'];
    for (const job of this.jobs.values()) {
      if (!active.includes(job.status)) continue;
      const elapsed = now - job.lastEventAt.getTime();
      if (elapsed > this.STALL_TIMEOUT_MS) {
        await this.handleJobError(job, new Error(`Agent stalled after ${Math.round(elapsed / 1000)}s`));
      }
    }
  }
}
