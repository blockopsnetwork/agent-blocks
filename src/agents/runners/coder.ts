import { Agent } from '@cursor/sdk';
import { AgentContext } from '../../types';
import { ArchitectOutput, DevOpsOutput } from '../../types/pipeline';
import { AGENT_REGISTRY } from '../registry';

export interface CoderResult {
  prUrl: string;
  branch: string;
  commitSha: string;
  summary: string;
}

const def = AGENT_REGISTRY['coding-engineer'];

export async function runCoderAgent(
  ctx: AgentContext,
  plan: ArchitectOutput,
  devopsReview: DevOpsOutput | null,
  attempt: number,
  onEvent?: (type: string, data: unknown) => void
): Promise<CoderResult> {
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
    agents: {
      'test-writer': {
        description: 'Writes and updates tests for changed code.',
        prompt: `Write tests per this strategy: ${plan.testStrategy}
Follow existing test patterns. Cover edge cases. Run tests before reporting done.`,
        model: 'inherit',
      },
    },
  });

  const prompt = buildCoderPrompt(ctx, plan, devopsReview, attempt);
  const run = await agent.send(prompt);

  let prUrl = '';
  let summary = '';

  for await (const event of run.stream()) {
    onEvent?.(event.type, event);
    if (event.type === 'assistant' && 'content' in event) {
      summary = String((event as any).content).slice(0, 500);
    }
  }

  const conversation = await run.conversation();
  const prMatch = JSON.stringify(conversation).match(
    /https:\/\/github\.com\/[^\s"]+\/pull\/\d+/
  );
  if (prMatch) prUrl = prMatch[0];
  if (!prUrl) throw new Error('Coding agent completed but no PR URL found');

  return { prUrl, branch: '', commitSha: '', summary };
}

function buildCoderPrompt(
  ctx: AgentContext,
  plan: ArchitectOutput,
  devops: DevOpsOutput | null,
  attempt: number
): string {
  const retryNote = attempt > 1
    ? `\n> **Retry ${attempt}**: Previous attempt failed. Re-read the plan carefully.\n`
    : '';

  const devopsNote = devops?.hasInfraConcerns
    ? `\n## DevOps Architect Flags\n${[
        ...devops.securityIssues,
        ...devops.resourceConcerns,
        ...devops.deploymentRisks,
      ].map(i => `- ${i}`).join('\n')}\n`
    : '';

  return `${def.persona}
${retryNote}
## Issue: ${ctx.issue.repo.fullName}#${ctx.issue.number}
**${ctx.issue.title}**

${ctx.issue.body}

## Implementation Plan (from Principal Architect)
**Approach:** ${plan.approach}
**Files:** ${plan.files.join(', ')}
**Test strategy:** ${plan.testStrategy}
**Blast radius:** ${plan.blastRadius}
${plan.defensiveFixes ? `**Defensive fixes:** ${plan.defensiveFixes}` : ''}
${devopsNote}
## Context
Recent commits:
${ctx.recentCommits.slice(0, 3).map(c => `- ${c.sha.slice(0, 7)}: ${c.message}`).join('\n')}

Similar past fixes:
${ctx.similarIssues.map(i => `- #${i.number}: ${i.title}`).join('\n') || 'None'}

## Execution Checklist
- [ ] Read the files listed in the plan before changing anything
- [ ] Implement exactly the approach described — no scope creep
- [ ] Use test-writer subagent for new/updated tests
- [ ] Run lint, fix all issues
- [ ] Verify callers of any modified function still compile and pass
- [ ] Commit: \`fix: ${ctx.issue.title.toLowerCase()} (resolves #${ctx.issue.number})\`
- [ ] PR description: root cause, what changed, test coverage

Max 2 lint/test retry rounds.`.trim();
}
