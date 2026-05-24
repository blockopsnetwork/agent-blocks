import { App } from '@slack/bolt';
import { Orchestrator } from '../orchestrator';
import { GitHubClient } from '../context/github';
import { registerFixCommand } from './commands/fix';
import { registerArchitectCommand } from './commands/architect';
import { resolveConfirmation } from '../api/confirmation';

export function createSlackApp(orchestrator: Orchestrator, github: GitHubClient): App {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    socketMode: true,   // no public URL needed — works behind firewalls
  });

  // @block fix / status / cancel / list
  registerFixCommand(app, orchestrator, github);

  // @block architect <task> / @block devopsec <task>
  registerArchitectCommand(app);

  // Approve/deny button handlers
  // action_id format: approve:{jobId}:{requestId}  or  deny:{jobId}:{requestId}
  app.action(/^approve:(.+)$/, async ({ ack, action, body, client }: any) => {
    await ack();
    const parts = (action as any).action_id.split(':');
    const requestId = parts.slice(2).join(':');
    resolveConfirmation(requestId, true);
    await client.chat.update({
      channel: body.channel?.id ?? '',
      ts: body.message?.ts ?? '',
      text: ':white_check_mark: Approved — agent proceeding',
      blocks: [],
    });
  });

  app.action(/^deny:(.+)$/, async ({ ack, action, body, client }: any) => {
    await ack();
    const parts = (action as any).action_id.split(':');
    const requestId = parts.slice(2).join(':');
    resolveConfirmation(requestId, false);
    await client.chat.update({
      channel: body.channel?.id ?? '',
      ts: body.message?.ts ?? '',
      text: ':no_entry: Denied — agent will choose a safer approach',
      blocks: [],
    });
  });

  app.action(/^retry_job:(.+)$/, async ({ ack, action, body, client }: any) => {
    await ack();
    // Re-enqueue handled by orchestrator retry logic automatically
    await client.chat.update({
      channel: body.channel?.id ?? '',
      ts: body.message?.ts ?? '',
      text: ':arrows_counterclockwise: Retrying...',
      blocks: [],
    });
  });

  app.action(/^cancel_job:(.+)$/, async ({ ack, action, body, client }: any) => {
    await ack();
    const jobId = (action as any).action_id.split(':')[1];
    await orchestrator.cancelByIssueNumber(parseInt(jobId));
    await client.chat.update({
      channel: body.channel?.id ?? '',
      ts: body.message?.ts ?? '',
      text: ':no_entry: Cancelled',
      blocks: [],
    });
  });

  return app;
}
