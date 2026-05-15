import { Agent } from '@cursor/sdk';
import { AgentContext, AgentPlan } from '../types';
import { buildCodingPrompt } from './prompt';

export interface CodingResult {
  prUrl: string;
  branch: string;
  summary: string;
}

export async function runCodingAgent(
  ctx: AgentContext,
  plan: AgentPlan,
  attempt: number,
  onEvent?: (type: string, data: unknown) => void
): Promise<CodingResult> {
  const { owner, name } = ctx.issue.repo;

  await using agent = await Agent.create({
    cloud: {
      repos: [{ name: `${owner}/${name}` }],
      autoCreatePR: true,
      envVars: {
        GITHUB_ISSUE_NUMBER: String(ctx.issue.number),
        GITHUB_ISSUE_URL: ctx.issue.url,
      },
    },
    // Sub-agent for writing tests — keeps coding agent focused on the fix
    agents: {
      'test-writer': {
        description: 'Writes and updates tests for changed code',
        prompt: 'Write thorough tests that cover the fix and edge cases. Follow existing test patterns in the repo. Do not over-test.',
        model: 'inherit',
      },
    },
  });

  const prompt = buildCodingPrompt(ctx, plan, attempt);
  const run = await agent.send(prompt);

  let prUrl = '';
  let summary = '';

  for await (const event of run.stream()) {
    onEvent?.(event.type, event);

    if (event.type === 'assistant') {
      // Capture last assistant message as summary
      summary = typeof event === 'object' && 'content' in event
        ? String((event as any).content).slice(0, 500)
        : summary;
    }
  }

  const gitInfo = await run.conversation();
  // Extract PR URL from run metadata or conversation
  const prMatch = JSON.stringify(gitInfo).match(/https:\/\/github\.com\/[^\s"]+\/pull\/\d+/);
  if (prMatch) prUrl = prMatch[0];

  if (!prUrl) throw new Error('Agent completed but no PR URL found');

  return { prUrl, branch: '', summary };
}
