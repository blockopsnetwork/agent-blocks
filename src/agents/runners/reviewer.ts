import Anthropic from '@anthropic-ai/sdk';
import { AgentContext } from '../../types';
import { ArchitectOutput, ReviewOutput } from '../../types/pipeline';
import { AGENT_REGISTRY } from '../registry';

const client = new Anthropic();
const def = AGENT_REGISTRY['code-reviewer'];

export async function runReviewerAgent(
  ctx: AgentContext,
  plan: ArchitectOutput,
  diff: string
): Promise<ReviewOutput> {
  const response = await client.messages.create({
    model: def.model,
    max_tokens: 2048,
    system: def.persona,
    messages: [
      {
        role: 'user',
        content: buildReviewerPrompt(ctx, plan, diff),
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return parseReviewOutput(text);
}

function buildReviewerPrompt(
  ctx: AgentContext,
  plan: ArchitectOutput,
  diff: string
): string {
  return `## Original Issue: ${ctx.issue.repo.fullName}#${ctx.issue.number}
${ctx.issue.title}

## Architect's Plan
Approach: ${plan.approach}
Files: ${plan.files.join(', ')}
Test strategy: ${plan.testStrategy}
Blast radius: ${plan.blastRadius}

## PR Diff
\`\`\`diff
${diff.slice(0, 10_000)}
\`\`\`

---
Review this diff against the plan and issue.
Respond as JSON:
\`\`\`json
{
  "overall": "approve|request_changes|comment",
  "score": 0.0,
  "summary": "1-2 sentence summary",
  "issues": [
    {
      "severity": "critical|major|minor",
      "file": "path/to/file.ts",
      "line": 42,
      "description": "specific, actionable description"
    }
  ]
}
\`\`\``.trim();
}

function parseReviewOutput(text: string): ReviewOutput {
  try {
    const match = text.match(/```(?:json)?\n?([\s\S]+?)\n?```/);
    const json = match ? match[1] : text;
    return JSON.parse(json) as ReviewOutput;
  } catch {
    return {
      overall: 'comment',
      score: 0.5,
      summary: 'Review parsing failed — manual review required.',
      issues: [],
    };
  }
}
