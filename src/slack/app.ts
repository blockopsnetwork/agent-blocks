import { App } from '@slack/bolt';
import { Orchestrator } from '../orchestrator';
import { GitHubClient } from '../context/github';
import { registerFixCommand } from './commands/fix';

export function createSlackApp(orchestrator: Orchestrator, github: GitHubClient): App {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    socketMode: true,   // no public URL needed — works behind firewalls
  });

  // @block fix / status / cancel / list
  registerFixCommand(app, orchestrator, github);

  // Approve/deny button handlers
  app.action(/^approve:(.+)$/, async ({ ack, action, body, client }) => {
    await ack();
    // TODO: wire approval response to waiting agent run
    const jobId = (action as any).action_id.split(':')[1];
    await client.chat.update({
      channel: body.channel?.id ?? '',
      ts: body.message?.ts ?? '',
      text: ':white_check_mark: Approved',
      blocks: [],
    });
  });

  app.action(/^deny:(.+)$/, async ({ ack, action, body, client }) => {
    await ack();
    const jobId = (action as any).action_id.split(':')[1];
    await client.chat.update({
      channel: body.channel?.id ?? '',
      ts: body.message?.ts ?? '',
      text: ':no_entry: Denied',
      blocks: [],
    });
    orchestrator.cancelByIssueNumber(parseInt(jobId));
  });

  app.action(/^retry_job:(.+)$/, async ({ ack, action, body, client }) => {
    await ack();
    // Re-enqueue handled by orchestrator retry logic automatically
    await client.chat.update({
      channel: body.channel?.id ?? '',
      ts: body.message?.ts ?? '',
      text: ':arrows_counterclockwise: Retrying...',
      blocks: [],
    });
  });

  app.action(/^cancel_job:(.+)$/, async ({ ack, action, body, client }) => {
    await ack();
    const jobId = (action as any).action_id.split(':')[1];
    orchestrator.cancelByIssueNumber(parseInt(jobId));
    await client.chat.update({
      channel: body.channel?.id ?? '',
      ts: body.message?.ts ?? '',
      text: ':no_entry: Cancelled',
      blocks: [],
    });
  });

  return app;
}
