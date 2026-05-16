import { AgentRole } from '../agents/registry';

export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface PipelineStage {
  role: AgentRole;
  status: StageStatus;
  startedAt?: Date;
  completedAt?: Date;
  output?: StageOutput;
  error?: string;
  k8sJobName?: string;
}

export interface StageOutput {
  role: AgentRole;
  raw: string;               // full agent response
  structured?: unknown;      // parsed JSON output if applicable
}

// Principal Architect output
export interface ArchitectOutput {
  approach: string;
  files: string[];
  testStrategy: string;
  riskLevel: 'low' | 'medium' | 'high';
  blastRadius: string;
  defensiveFixes?: string;   // similar bugs to fix proactively
  estimatedChanges: string;
}

// DevOps Architect output
export interface DevOpsOutput {
  hasInfraConcerns: boolean;
  securityIssues: string[];
  resourceConcerns: string[];
  deploymentRisks: string[];
  approved: boolean;
  notes: string;
}

// Code Reviewer output
export interface ReviewOutput {
  overall: 'approve' | 'request_changes' | 'comment';
  score: number;
  summary: string;
  issues: Array<{
    severity: 'critical' | 'major' | 'minor';
    file: string;
    line?: number;
    description: string;
  }>;
}

export interface AgentPipeline {
  jobId: string;
  stages: PipelineStage[];
  architectOutput?: ArchitectOutput;
  devopsOutput?: DevOpsOutput;
  reviewOutput?: ReviewOutput;
  prUrl?: string;
}
