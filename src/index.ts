import 'dotenv/config';
import { WebClient } from '@slack/web-api';
import { GitHubClient } from './context/github';
import { SlackNotifier } from './slack/notifier';
import { Orchestrator } from './orchestrator';
import { createSlackApp } from './slack/app';

async function main() {
  const github = new GitHubClient(process.env.GITHUB_TOKEN!);
  const slackWeb = new WebClient(process.env.SLACK_BOT_TOKEN!);
  const notifier = new SlackNotifier(slackWeb);

  const orchestrator = new Orchestrator(notifier, github, {
    maxAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS ?? '5'),
    stallTimeoutMs: parseInt(process.env.STALL_TIMEOUT_MS ?? '300000'),
  });

  // Stall detection loop
  setInterval(() => orchestrator.reconcile().catch(console.error), 30_000);

  const app = createSlackApp(orchestrator, github);

  await app.start();
  console.log('Block is running (Socket Mode)');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
