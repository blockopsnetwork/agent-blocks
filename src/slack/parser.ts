import Anthropic from '@anthropic-ai/sdk';
import { ParsedCommand } from '../types';

const client = new Anthropic();

// Extracts owner/repo/number from GitHub issue or PR URLs
function parseGitHubUrl(url: string): { owner: string; name: string; number?: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\/issues\/(\d+)|\/pull\/(\d+))?(?:[/?#]|$)/);
  if (!m) return null;
  return {
    owner: m[1],
    name: m[2].replace(/\.git$/, ''),
    number: m[3] ? parseInt(m[3]) : m[4] ? parseInt(m[4]) : undefined,
  };
}

export async function parseCommand(text: string, threadMessages?: string[]): Promise<ParsedCommand> {
  // Strip Slack user mention formatting <@USERID>
  const cleaned = text.replace(/<@[A-Z0-9]+>/g, '').trim();

  const context = threadMessages?.length
    ? `\nSlack thread context:\n${threadMessages.slice(-5).join('\n')}`
    : '';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: `Extract structured data from a Slack command directed at a coding agent called Block.
Return ONLY valid JSON matching this schema:
{
  "intent": "fix" | "status" | "cancel" | "list" | "unknown",
  "issueUrl": string | null,       // full GitHub issue URL if present
  "repoUrl": string | null,        // full GitHub repo URL if present (no issue number)
  "issueNumber": number | null,    // bare issue number like #123 if no full URL
  "extraInstructions": string | null  // any additional instructions from the user
}`,
    messages: [
      {
        role: 'user',
        content: `Command: "${cleaned}"${context}`,
      },
    ],
  });

  let parsed: Omit<ParsedCommand, 'rawText' | 'repoOwner' | 'repoName'>;
  try {
    const content = response.content[0];
    parsed = JSON.parse(content.type === 'text' ? content.text : '{}');
  } catch {
    return { intent: 'unknown', rawText: cleaned };
  }

  const result: ParsedCommand = { ...parsed, rawText: cleaned };

  // Resolve owner/name/number from URLs
  const urlToParse = parsed.issueUrl ?? parsed.repoUrl;
  if (urlToParse) {
    const gh = parseGitHubUrl(urlToParse);
    if (gh) {
      result.repoOwner = gh.owner;
      result.repoName = gh.name;
      if (gh.number) result.issueNumber = gh.number;
    }
  }

  return result;
}
