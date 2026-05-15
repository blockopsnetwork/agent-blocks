import { AgentJob, IssueStatus } from '../../types';

const STATUS_EMOJI: Record<IssueStatus, string> = {
  queued:     ':hourglass_flowing_sand:',
  hydrating:  ':mag:',
  planning:   ':memo:',
  coding:     ':computer:',
  validating: ':white_check_mark:',
  pr_created: ':tada:',
  failed:     ':x:',
  cancelled:  ':no_entry:',
};

const STATUS_LABEL: Record<IssueStatus, string> = {
  queued:     'Queued',
  hydrating:  'Gathering context...',
  planning:   'Planning approach...',
  coding:     'Writing code...',
  validating: 'Running tests & lint...',
  pr_created: 'PR created',
  failed:     'Failed',
  cancelled:  'Cancelled',
};

export function buildProgressMessage(job: AgentJob) {
  const emoji = STATUS_EMOJI[job.status];
  const label = STATUS_LABEL[job.status];
  const issue = job.issue;

  const header = job.status === 'pr_created'
    ? `${emoji} *PR created for <${issue.url}|${issue.repo.fullName}#${issue.number}>*`
    : `${emoji} *${label}* — <${issue.url}|${issue.repo.fullName}#${issue.number}: ${issue.title}>`;

  const blocks: object[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: header },
    },
  ];

  if (job.status === 'planning' && job.plan) {
    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Approach*\n${job.plan.approach}` },
        { type: 'mrkdwn', text: `*Files*\n\`${job.plan.files.slice(0, 3).join('`\n`')}\`` },
        { type: 'mrkdwn', text: `*Risk*\n${job.plan.riskLevel}` },
        { type: 'mrkdwn', text: `*Tests*\n${job.plan.testStrategy}` },
      ],
    });
  }

  if (job.status === 'pr_created' && job.prUrl) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View PR', emoji: true },
            style: 'primary',
            url: job.prUrl,
            action_id: 'view_pr',
          },
        ],
      }
    );
  }

  if (job.status === 'failed' && job.error) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Error*\n\`\`\`${job.error.slice(0, 300)}\`\`\`` },
    });

    if (job.attempts < 3) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Retry', emoji: true },
            action_id: `retry_job:${job.id}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Cancel', emoji: true },
            style: 'danger',
            action_id: `cancel_job:${job.id}`,
          },
        ],
      });
    }
  }

  // Attempt counter footer
  if (job.attempts > 1) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Attempt ${job.attempts}` }],
    });
  }

  return { text: `${emoji} ${label} — ${issue.repo.fullName}#${issue.number}`, blocks };
}

export function buildApprovalMessage(jobId: string, action: string, details: string) {
  return {
    text: `Block needs approval to: ${action}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: *Block needs your approval*\n*Action:* ${action}\n*Details:*\n\`\`\`${details.slice(0, 500)}\`\`\``,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve', emoji: true },
            style: 'primary',
            action_id: `approve:${jobId}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Deny', emoji: true },
            style: 'danger',
            action_id: `deny:${jobId}`,
          },
        ],
      },
    ],
  };
}

export function buildAckMessage(issueTitle: string, issueUrl: string) {
  return {
    text: `:eyes: On it — looking at *${issueTitle}*`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:eyes: On it. Analyzing <${issueUrl}|*${issueTitle}*>...`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'I\'ll post updates here as I work.' }],
      },
    ],
  };
}
