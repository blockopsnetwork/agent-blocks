import Anthropic from '@anthropic-ai/sdk';
import { AgentContext } from '../../types';
import { ArchitectOutput, DevOpsOutput } from '../../types/pipeline';
import { AGENT_REGISTRY } from '../registry';

const client = new Anthropic();
const def = AGENT_REGISTRY['devops-architect'];

export async function runDevOpsAgent(
  ctx: AgentContext,
  plan: ArchitectOutput
): Promise<DevOpsOutput> {
  const response = await client.messages.create({
    model: def.model,
    max_tokens: 1024,
    system: def.persona,
    messages: [
      {
        role: 'user',
        content: buildDevOpsPrompt(ctx, plan),
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return parseDevOpsOutput(text);
}

function buildDevOpsPrompt(ctx: AgentContext, plan: ArchitectOutput): string {
  const infraFiles = plan.files.filter(f =>
    /docker|k8s|helm|\.ya?ml$|terraform|\.tf$|Makefile|\.github/i.test(f)
  );

  return `## Issue: ${ctx.issue.repo.fullName}#${ctx.issue.number}
${ctx.issue.title}

## Plan from Principal Architect
Approach: ${plan.approach}
Files changing: ${plan.files.join(', ')}
Risk level: ${plan.riskLevel}

## Infrastructure Files Being Changed
${infraFiles.length ? infraFiles.join('\n') : 'None identified — double-check the file list.'}

## Repo Structure (relevant)
\`\`\`
${ctx.repoStructure}
\`\`\`

---
Review the infrastructure implications of this change.
Respond as JSON:
\`\`\`json
{
  "hasInfraConcerns": true|false,
  "securityIssues": ["list of security concerns"],
  "resourceConcerns": ["CPU/memory/storage issues"],
  "deploymentRisks": ["risks to deployment pipeline"],
  "approved": true|false,
  "notes": "summary for the engineering team"
}
\`\`\``.trim();
}

function parseDevOpsOutput(text: string): DevOpsOutput {
  try {
    const match = text.match(/```(?:json)?\n?([\s\S]+?)\n?```/);
    const json = match ? match[1] : text;
    return JSON.parse(json) as DevOpsOutput;
  } catch {
    return {
      hasInfraConcerns: false,
      securityIssues: [],
      resourceConcerns: [],
      deploymentRisks: [],
      approved: true,
      notes: text.slice(0, 300),
    };
  }
}
