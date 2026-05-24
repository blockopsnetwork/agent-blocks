import 'dotenv/config';
import express from 'express';
import { WebClient } from '@slack/web-api';
import { GitHubClient } from './context/github';
import { SlackNotifier } from './slack/notifier';
import { Orchestrator } from './orchestrator';
import { InMemoryJobStore } from './adapters/InMemoryJobStore';
import { RedisJobStore, createRedisClient } from './adapters/RedisJobStore';
import { IJobStore } from './ports/IJobStore';
import { createSlackApp } from './slack/app';
import { logger } from './logger';
import { createCallbackRouter } from './api/callback';
import { createConfirmationRouter } from './api/confirmation';
import { buildConfirmBlocks } from './slack/ui/blocks';

async function main() {
  const github   = new GitHubClient(process.env.GITHUB_TOKEN!);
  const slackWeb = new WebClient(process.env.SLACK_BOT_TOKEN!);
  const notifier = new SlackNotifier(slackWeb);

  let store: IJobStore;
  if (process.env.REDIS_URL) {
    const redis = createRedisClient(process.env.REDIS_URL);
    await redis.connect();
    store = new RedisJobStore(redis);
    logger.info('using RedisJobStore');
  } else {
    store = new InMemoryJobStore();
    logger.warn('REDIS_URL not set — using InMemoryJobStore (jobs lost on restart)');
  }

  const orchestrator = new Orchestrator(github, {
    store,
    notifier,
    maxAgents:      parseInt(process.env.MAX_CONCURRENT_AGENTS ?? '5'),
    stallTimeoutMs: parseInt(process.env.STALL_TIMEOUT_MS ?? '300000'),
  });

  // Stall detection loop
  setInterval(
    () => orchestrator.reconcile().catch(err => logger.error({ err }, 'reconcile error')),
    30_000,
  );

  // HTTP callback server for ARC agent-worker events + human confirmations
  const notifyChannel = process.env.SLACK_NOTIFY_CHANNEL ?? '';
  const callbackPort = parseInt(process.env.BLOCKS_CALLBACK_PORT ?? '3001');
  const callbackApp = express();
  callbackApp.use(express.json());
  callbackApp.use('/api', createCallbackRouter({
    onConfirm: (jobId, requestId, description, command) => {
      if (!notifyChannel) return;
      slackWeb.chat.postMessage({
        channel: notifyChannel,
        text: `Agent requesting approval (job ${jobId})`,
        blocks: buildConfirmBlocks(description, command, jobId, requestId) as any[],
      }).catch(err => logger.error({ err, jobId }, 'Failed to post confirm message'));
    },
  }));
  callbackApp.use('/api', createConfirmationRouter());
  callbackApp.listen(callbackPort, () => {
    logger.info(`Callback server listening on port ${callbackPort}`);
  });

  const app = createSlackApp(orchestrator, github);

  await app.start();
  logger.info('Block is running (Socket Mode)');
}

main().catch(err => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
