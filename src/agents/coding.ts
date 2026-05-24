import { Octokit } from '@octokit/rest';
import { AgentContext, AgentPlan } from '../types';
import { registerJob, unregisterJob } from '../api/callback';
import { logger } from '../logger';

export interface CodingResult {
  prUrl: string;
  branch: string;
  summary: string;
}

const GH_WORKFLOW_FILE = 'fix-issue.yml';

// External oracle: confirm PR exists on GitHub before declaring success.
// Mirrors Goose's SuccessCheck shell oracle — ground truth, not LLM self-report.
async function verifyPrExists(octokit: Octokit, prUrl: string): Promise<void> {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) throw new Error(`Cannot parse PR URL: ${prUrl}`);
  const [, owner, repo, num] = match;
  const pr = await octokit.pulls.get({ owner, repo, pull_number: parseInt(num, 10) });
  if (pr.data.state === 'closed') {
    throw new Error(`PR #${num} exists but is already closed`);
  }
}
const WORKFLOW_TIMEOUT_MS = 35 * 60 * 1000; // 35 min (workflow timeout is 30)
const POLL_INTERVAL_MS = 15_000;

export async function runCodingAgent(
  ctx: AgentContext,
  plan: AgentPlan,
  attempt: number,
  onEvent?: (type: string, data: unknown) => void,
): Promise<CodingResult> {
  const { owner, name } = ctx.issue.repo;
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  const callbackUrl = process.env.BLOCKS_CALLBACK_URL ?? '';
  if (!callbackUrl) throw new Error('BLOCKS_CALLBACK_URL is not set');

  // Encode context for the agent-worker (plan + devops review embedded)
  const workerCtx = {
    issue: ctx.issue,
    plan: {
      approach: plan.approach,
      files: plan.files,
      testStrategy: plan.testStrategy,
      blastRadius: plan.riskLevel,
    },
    devopsReview: null,
    attempt,
  };
  const contextB64 = Buffer.from(JSON.stringify(workerCtx)).toString('base64');

  // Register event emitter before dispatching (no race condition)
  const emitter = registerJob(ctx.issue.id);
  const jobId   = ctx.issue.id;

  try {
    logger.info({ owner, repo: name, issueNumber: ctx.issue.number }, 'dispatching GHA workflow');

    await octokit.actions.createWorkflowDispatch({
      owner: 'blockopsnetwork',
      repo:  'agent-blocks',
      workflow_id: GH_WORKFLOW_FILE,
      ref: 'main',
      inputs: {
        issue_number: String(ctx.issue.number),
        repo_owner:   owner,
        repo_name:    name,
        job_id:       jobId,
        attempt:      String(attempt),
        callback_url: callbackUrl,
        context_b64:  contextB64,
      },
    });

    logger.info({ jobId }, 'workflow dispatched, waiting for callback events');

    // Await done/error event from the agent-worker via callback server
    return await new Promise<CodingResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`GHA workflow timed out after ${WORKFLOW_TIMEOUT_MS / 60_000}min`));
      }, WORKFLOW_TIMEOUT_MS);

      emitter.on('event', (event: Record<string, unknown>) => {
        onEvent?.(String(event.type), event);

        if (event.type === 'done') {
          clearTimeout(timeout);
          const prUrl = String(event.prUrl ?? '');
          if (!prUrl) {
            reject(new Error('Workflow reported done but no prUrl in payload'));
            return;
          }
          // Shell oracle: verify the PR actually exists — don't trust agent self-report.
          verifyPrExists(octokit, prUrl)
            .then(() => resolve({ prUrl, branch: '', summary: String(event.summary ?? '') }))
            .catch(err => reject(new Error(`PR verification failed: ${err.message}`)));
        }

        if (event.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(String(event.message ?? 'Unknown agent-worker error')));
        }
      });
    });
  } finally {
    unregisterJob(jobId);
  }
}
