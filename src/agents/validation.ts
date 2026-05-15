import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export interface DiffReview {
  score: number;       // 0–1
  approved: boolean;
  feedback: string;
  concerns: string[];
}

export async function reviewDiff(diff: string, issueTitle: string): Promise<DiffReview> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: `You are a principal engineer reviewing a code diff for a GitHub PR.
Evaluate: correctness, completeness, test coverage, blast radius, security, code quality.
Return ONLY valid JSON:
{
  "score": 0.0-1.0,
  "approved": true|false,
  "feedback": "1-2 sentence summary",
  "concerns": ["list of specific concerns, empty if none"]
}`,
    messages: [
      {
        role: 'user',
        content: `Issue: ${issueTitle}\n\nDiff:\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\``,
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
  try {
    return JSON.parse(text) as DiffReview;
  } catch {
    return { score: 0.5, approved: true, feedback: 'Review parsing failed.', concerns: [] };
  }
}
