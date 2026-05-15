import Anthropic from '@anthropic-ai/sdk';
import { AgentContext, AgentPlan } from '../types';
import { buildPlanningPrompt } from './prompt';

const client = new Anthropic();

export async function planIssue(ctx: AgentContext): Promise<AgentPlan> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: buildPlanningPrompt(ctx) }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  try {
    // Strip markdown code fences if model wraps output
    const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(json) as AgentPlan;
  } catch {
    // Fallback plan when parsing fails
    return {
      approach: 'Analyze issue and implement minimal fix.',
      files: [],
      testStrategy: 'Update existing tests for changed behavior.',
      riskLevel: 'medium',
      estimatedChanges: 'Unknown',
    };
  }
}
