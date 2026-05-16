import { AgentJob, IssueStatus } from '../../types';
import { AgentPipeline, PipelineStage } from '../../types/pipeline';
import { AgentRole } from '../../agents/registry';

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

// ── Pipeline progress view ─────────────────────────────────────────────────

const ROLE_EMOJI: Record<AgentRole, string> = {
  'principal-architect': ':building_construction:',
  'devops-architect':    ':gear:',
  'coding-engineer':     ':computer:',
  'code-reviewer':       ':mag:',
};

const ROLE_LABEL: Record<AgentRole, string> = {
  'principal-architect': 'Principal Architect',
  'devops-architect':    'DevOps Architect',
  'coding-engineer':     'Senior Engineer',
  'code-reviewer':       'Code Reviewer',
};

const STAGE_STATUS_ICON: Record<PipelineStage['status'], string> = {
  pending:   ':white_circle:',
  running:   ':large_yellow_circle:',
  completed: ':large_green_circle:',
  failed:    ':red_circle:',
  skipped:   ':white_circle:',
};

export function buildPipelineMessage(pipeline: AgentPipeline, issueTitle: string, issueUrl: string) {
  const allDone = pipeline.stages.every(s =>
    ['completed', 'failed', 'skipped'].includes(s.status)
  );
  const anyFailed = pipeline.stages.some(s => s.status === 'failed');
  const hasPR = !!pipeline.prUrl;

  const stageLines = pipeline.stages
    .filter(s => s.status !== 'skipped')
    .map(s => {
      const icon = STAGE_STATUS_ICON[s.status];
      const label = ROLE_LABEL[s.role];
      const emoji = ROLE_EMOJI[s.role];
      const duration = s.startedAt && s.completedAt
        ? ` _(${Math.round((s.completedAt.getTime() - s.startedAt.getTime()) / 1000)}s)_`
        : s.status === 'running' ? ' _running..._' : '';
      return `${icon} ${emoji} *${label}*${duration}`;
    })
    .join('\n');

  const header = hasPR
    ? `:tada: *PR ready* — <${issueUrl}|${issueTitle}>`
    : anyFailed
    ? `:x: *Agent pipeline failed* — <${issueUrl}|${issueTitle}>`
    : `:large_yellow_circle: *Working on* — <${issueUrl}|${issueTitle}>`;

  const blocks: object[] = [
    { type: 'section', text: { type: 'mrkdwn', text: header } },
    { type: 'section', text: { type: 'mrkdwn', text: stageLines } },
  ];

  // Architect plan summary — shown once plan is ready
  if (pipeline.architectOutput) {
    const plan = pipeline.architectOutput;
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Approach*\n${plan.approach}` },
        { type: 'mrkdwn', text: `*Risk*\n${plan.riskLevel} — ${plan.blastRadius}` },
      ],
    });
  }

  // DevOps concerns — shown if any
  if (pipeline.devopsOutput?.hasInfraConcerns) {
    const concerns = [
      ...pipeline.devopsOutput.securityIssues,
      ...pipeline.devopsOutput.deploymentRisks,
    ].slice(0, 3);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:warning: *DevOps flags*\n${concerns.map(c => `• ${c}`).join('\n')}`,
      },
    });
  }

  // Reviewer summary — shown after code review
  if (pipeline.reviewOutput) {
    const review = pipeline.reviewOutput;
    const reviewIcon = review.overall === 'approve'
      ? ':white_check_mark:'
      : review.overall === 'request_changes'
      ? ':x:'
      : ':speech_balloon:';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${reviewIcon} *Code review* (score: ${(review.score * 100).toFixed(0)}%)\n${review.summary}`,
      },
    });
    if (review.issues.filter(i => i.severity === 'critical' || i.severity === 'major').length > 0) {
      const topIssues = review.issues
        .filter(i => i.severity !== 'minor')
        .slice(0, 3)
        .map(i => `• \`${i.file}\` — ${i.description}`)
        .join('\n');
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: topIssues },
      });
    }
  }

  // PR button
  if (hasPR) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View PR', emoji: true },
          style: 'primary',
          url: pipeline.prUrl,
          action_id: 'view_pr',
        },
      ],
    });
  }

  return {
    text: hasPR ? `PR ready — ${issueTitle}` : `Working on ${issueTitle}`,
    blocks,
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
