import { App } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { parseCommand } from '../parser';
import { buildAckMessage } from '../ui/blocks';
import { Orchestrator } from '../../orchestrator';
import { GitHubClient } from '../../context/github';

export function registerFixCommand(app: App, orchestrator: Orchestrator, github: GitHubClient) {
  app.event('app_mention', async ({ event, client, say }) => {
    const slackClient = client as WebClient;

    // Gather thread context for richer NL parsing
    let threadMessages: string[] = [];
    if (event.thread_ts) {
      try {
        const thread = await slackClient.conversations.replies({
          channel: event.channel,
          ts: event.thread_ts,
          limit: 10,
        });
        threadMessages = (thread.messages ?? [])
          .filter(m => m.ts !== event.ts)
          .map(m => m.text ?? '');
      } catch { /* non-fatal */ }
    }

    const command = await parseCommand(event.text, threadMessages);

    if (command.intent !== 'fix') {
      // Route to other handlers or ignore
      if (command.intent === 'status') {
        await handleStatus(event, orchestrator, say);
      } else if (command.intent === 'cancel') {
        await handleCancel(event, command, orchestrator, say);
      } else if (command.intent === 'list') {
        await handleList(event, orchestrator, say);
      } else {
        await say({
          text: 'I didn\'t understand that. Try: `@block fix this issue <github-issue-url>`',
          thread_ts: event.ts,
        });
      }
      return;
    }

    if (!command.repoOwner || !command.repoName || !command.issueNumber) {
      await say({
        text: ':thinking_face: I need a GitHub issue URL. Try:\n`@block fix this issue https://github.com/org/repo/issues/123`',
        thread_ts: event.ts,
      });
      return;
    }

    // Fetch issue from GitHub
    let issue;
    try {
      issue = await github.getIssue(command.repoOwner, command.repoName, command.issueNumber);
    } catch (err: any) {
      await say({
        text: `:x: Couldn't fetch issue: ${err.message}`,
        thread_ts: event.ts,
      });
      return;
    }

    // Post ack immediately in thread
    const ackMsg = buildAckMessage(issue.title, issue.url);
    const ackRes = await slackClient.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      ...ackMsg,
    });

    // Enqueue job — orchestrator takes it from here
    await orchestrator.enqueue({
      issue,
      extraInstructions: command.extraInstructions,
      slackThread: {
        channel: event.channel,
        ts: event.ts,
        progressTs: ackRes.ts as string,
      },
    });
  });
}

async function handleStatus(event: any, orchestrator: Orchestrator, say: any) {
  const jobs = orchestrator.getActiveJobs();
  if (jobs.length === 0) {
    await say({ text: 'No active jobs.', thread_ts: event.ts });
    return;
  }
  const lines = jobs.map(
    j => `• *${j.issue.repo.fullName}#${j.issue.number}* — ${j.status} (attempt ${j.attempts})`
  );
  await say({ text: lines.join('\n'), thread_ts: event.ts });
}

async function handleCancel(event: any, command: any, orchestrator: Orchestrator, say: any) {
  if (!command.issueNumber) {
    await say({ text: 'Specify an issue number to cancel. e.g. `@block cancel #123`', thread_ts: event.ts });
    return;
  }
  const cancelled = orchestrator.cancelByIssueNumber(command.issueNumber);
  await say({
    text: cancelled ? `:no_entry: Cancelled job for #${command.issueNumber}` : `No active job for #${command.issueNumber}`,
    thread_ts: event.ts,
  });
}

async function handleList(event: any, orchestrator: Orchestrator, say: any) {
  await handleStatus(event, orchestrator, say);
}
