import { WebClient } from '@slack/web-api';
import { AgentJob } from '../types';
import { buildProgressMessage, buildApprovalMessage } from './ui/blocks';

export class SlackNotifier {
  constructor(private client: WebClient) {}

  // Post initial ack in thread, returns the message ts for future updates
  async postAck(channel: string, threadTs: string, message: object): Promise<string> {
    const res = await this.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      ...message,
    });
    return res.ts as string;
  }

  // Update the progress message in-place (no new messages)
  async updateProgress(job: AgentJob): Promise<void> {
    const { channel, ts, progressTs } = job.slackThread;
    if (!progressTs) return;

    const message = buildProgressMessage(job);
    await this.client.chat.update({
      channel,
      ts: progressTs,
      ...message,
    });
  }

  // Post a new message in thread (for approval requests, important milestones)
  async postInThread(job: AgentJob, message: object): Promise<string> {
    const res = await this.client.chat.postMessage({
      channel: job.slackThread.channel,
      thread_ts: job.slackThread.ts,
      ...message,
    });
    return res.ts as string;
  }

  async requestApproval(job: AgentJob, action: string, details: string): Promise<string> {
    return this.postInThread(job, buildApprovalMessage(job.id, action, details));
  }

  async postFinal(job: AgentJob): Promise<void> {
    const message = buildProgressMessage(job);
    if (job.slackThread.progressTs) {
      await this.client.chat.update({
        channel: job.slackThread.channel,
        ts: job.slackThread.progressTs,
        ...message,
      });
    } else {
      await this.postInThread(job, message);
    }
  }
}
