import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import { execSync } from 'child_process';
import { executeTool } from './tools';
import { RepetitionInspector, handleLargeResponse } from './inspectors';
import { compactIfNeeded } from './compaction';

// MOIM: inject working-dir context before tool results each turn.
// Placed just before the model sees new tool output — highest attention position.
function buildMoimContext(workspaceDir: string): string {
  let branch = '';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: workspaceDir, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { /* not a git repo or git not available */ }
  return [
    `[Working directory: ${workspaceDir}]`,
    branch ? `[Current branch: ${branch}]` : '',
    `[Time: ${new Date().toISOString()}]`,
  ].filter(Boolean).join('  ');
}

export interface AgentEvent {
  type: 'progress' | 'tool' | 'error';
  text?: string;
  name?: string;
  input?: unknown;
  error?: string;
}

export interface AgentLoopOptions {
  client: Anthropic;
  model: string;
  systemPrompt: string;
  initialMessages: MessageParam[];
  tools: Tool[];
  workspaceDir: string;
  maxTurns?: number;
  onEvent: (event: AgentEvent) => Promise<void>;
}

export interface AgentLoopResult {
  finalMessage: string;
  turns: number;
}

// Context window sizes for known models (tokens)
const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-7': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-3-5': 200_000,
};

function getContextWindow(model: string): number {
  for (const [key, val] of Object.entries(CONTEXT_WINDOWS)) {
    if (model.includes(key) || key.includes(model)) return val;
  }
  return 200_000; // safe default
}

export async function runAgentLoop(
  options: AgentLoopOptions
): Promise<AgentLoopResult> {
  const {
    client,
    model,
    systemPrompt,
    initialMessages,
    tools,
    workspaceDir,
    maxTurns = 100,
    onEvent,
  } = options;

  const inspector = new RepetitionInspector();
  const contextWindow = getContextWindow(model);
  let messages: MessageParam[] = [...initialMessages];
  let turns = 0;
  let finalMessage = '';

  while (turns < maxTurns) {
    // Compact context if approaching limit
    messages = await compactIfNeeded(
      client,
      model,
      messages,
      systemPrompt,
      contextWindow,
      0.8
    );

    // Call model
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: messages as Anthropic.MessageParam[],
      tools: tools as Anthropic.Tool[],
    });

    turns += 1;

    // Build assistant message content
    const assistantContent: Anthropic.ContentBlock[] = response.content;

    // Collect text and tool_use blocks
    let hasToolUse = false;
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of assistantContent) {
      if (block.type === 'text') {
        if (block.text.trim()) {
          finalMessage = block.text;
          await onEvent({ type: 'progress', text: block.text });
        }
      } else if (block.type === 'tool_use') {
        hasToolUse = true;
        const toolBlock = block as ToolUseBlock;

        await onEvent({
          type: 'tool',
          name: toolBlock.name,
          input: toolBlock.input,
        });

        // Repetition check
        const allowed = inspector.check(toolBlock.name, toolBlock.input);
        let toolOutput: string;

        if (!allowed) {
          toolOutput =
            `You've called this tool ${inspector.currentRepeatCount + 1} times with identical arguments. ` +
            `Try a different approach.`;
          inspector.reset();
        } else {
          try {
            const raw = await executeTool(
              toolBlock.name,
              toolBlock.input,
              workspaceDir
            );
            toolOutput = handleLargeResponse(raw);
          } catch (err: unknown) {
            toolOutput = `Tool error: ${(err as Error).message}`;
          }
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: toolOutput,
        });
      }
    }

    // Add assistant turn to messages
    messages = [
      ...messages,
      {
        role: 'assistant',
        content: assistantContent,
      },
    ];

    // Stop conditions
    if (response.stop_reason === 'end_turn' && !hasToolUse) {
      break;
    }

    if (!hasToolUse) {
      // No tool use and not end_turn — stop anyway
      break;
    }

    // Add tool results as user turn, prefixed with MOIM context block.
    // Injecting here (not in system prompt) keeps the system prompt stable for
    // prompt caching while putting volatile state where model attention is highest.
    messages = [
      ...messages,
      {
        role: 'user',
        content: [
          { type: 'text' as const, text: buildMoimContext(workspaceDir) },
          ...toolResults,
        ],
      },
    ];
  }

  return { finalMessage, turns };
}
