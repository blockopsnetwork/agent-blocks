export type IssueStatus =
  | 'queued'
  | 'hydrating'
  | 'planning'
  | 'coding'
  | 'validating'
  | 'pr_created'
  | 'failed'
  | 'cancelled';

export interface GitHubIssue {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  repo: { owner: string; name: string; fullName: string };
  labels: string[];
  author: string;
  createdAt: string;
}

export interface AgentJob {
  id: string;
  issue: GitHubIssue;
  status: IssueStatus;
  attempts: number;
  slackThread: { channel: string; ts: string; progressTs?: string };
  createdAt: Date;
  lastEventAt: Date;
  prUrl?: string;
  error?: string;
  plan?: AgentPlan;
}

export interface AgentPlan {
  approach: string;
  files: string[];
  testStrategy: string;
  riskLevel: 'low' | 'medium' | 'high';
  estimatedChanges: string;
}

export interface AgentContext {
  issue: GitHubIssue;
  repoStructure: string;
  recentCommits: Array<{ sha: string; message: string; files: string[] }>;
  similarIssues: Array<{ number: number; title: string; prTitle?: string }>;
  codeowners: Record<string, string[]>;
  testFiles: string[];
  linkedPRs: Array<{ number: number; title: string; state: string }>;
}

export interface ValidationResult {
  pass: boolean;
  layer: 'lint' | 'types' | 'tests';
  output: string;
  autofixed?: boolean;
}

export interface ParsedCommand {
  intent: 'fix' | 'status' | 'cancel' | 'list' | 'unknown';
  issueUrl?: string;
  repoUrl?: string;
  issueNumber?: number;
  repoOwner?: string;
  repoName?: string;
  extraInstructions?: string;
  rawText: string;
}
