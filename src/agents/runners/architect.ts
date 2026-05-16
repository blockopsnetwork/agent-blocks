import Anthropic from '@anthropic-ai/sdk';
import { AgentContext } from '../../types';
import { ArchitectOutput } from '../../types/pipeline';
import { AGENT_REGISTRY } from '../registry';

const client = new Anthropic();
const def = AGENT_REGISTRY['principal-architect'];

export async function runArchitectAgent(ctx: AgentContext): Promise<ArchitectOutput> {
  const response = await client.messages.create({
    model: def.model,
    max_tokens: 2048,
    system: def.persona,
    messages: [
      {
        role: 'user',
        content: buildArchitectPrompt(ctx),
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return parseArchitectOutput(text);
}

function buildArchitectPrompt(ctx: AgentContext): string {
  return `## Issue: ${ctx.issue.repo.fullName}#${ctx.issue.number}
**Title:** ${ctx.issue.title}

**Description:**
${ctx.issue.body}

## Repository Structure
\`\`\`
${ctx.repoStructure}
\`\`\`

## Recent Commits (last 10)
${ctx.recentCommits.map(c => `- ${c.sha.slice(0, 7)} ${c.message}`).join('\n')}

## Similar Resolved Issues
${ctx.similarIssues.map(i => `- #${i.number}: ${i.title}`).join('\n') || 'None found'}

## Linked PRs
${ctx.linkedPRs.map(p => `- #${p.number}: ${p.title} (${p.state})`).join('\n') || 'None'}

---
Produce your implementation plan as JSON:
\`\`\`json
{
  "approach": "precise description of the fix",
  "files": ["files/to/change.ts"],
  "testStrategy": "what tests to add/update",
  "riskLevel": "low|medium|high",
  "blastRadius": "what else could be affected",
  "defensiveFixes": "similar bugs to fix proactively (optional)",
  "estimatedChanges": "~N lines across M files"
}
\`\`\``.trim();
}

function parseArchitectOutput(text: string): ArchitectOutput {
  try {
    const match = text.match(/```(?:json)?\n?([\s\S]+?)\n?```/);
    const json = match ? match[1] : text;
    return JSON.parse(json) as ArchitectOutput;
  } catch {
    return {
      approach: text.slice(0, 500),
      files: [],
      testStrategy: 'Update tests for changed behavior.',
      riskLevel: 'medium',
      blastRadius: 'Unknown — review manually.',
      estimatedChanges: 'Unknown',
    };
  }
}
