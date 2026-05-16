import { AgentContext } from '../types';
import { AgentPipeline, PipelineStage, ArchitectOutput } from '../types/pipeline';
import { AGENT_REGISTRY, AgentRole } from './registry';
import { runArchitectAgent } from './runners/architect';
import { runDevOpsAgent } from './runners/devops';
import { runCoderAgent } from './runners/coder';
import { runReviewerAgent } from './runners/reviewer';

type StageEventCallback = (pipeline: AgentPipeline) => void;

export async function runPipeline(
  jobId: string,
  ctx: AgentContext,
  attempt: number,
  getDiff: (prUrl: string) => Promise<string>,
  onStageUpdate: StageEventCallback
): Promise<AgentPipeline> {
  const pipeline: AgentPipeline = {
    jobId,
    stages: buildInitialStages(ctx),
  };

  // ── Stage 1: Principal Software Architect ─────────────────────────────
  await transition(pipeline, 'principal-architect', 'running', onStageUpdate);
  let architectOutput: ArchitectOutput;
  try {
    architectOutput = await runArchitectAgent(ctx);
    pipeline.architectOutput = architectOutput;
    await transition(pipeline, 'principal-architect', 'completed', onStageUpdate, {
      role: 'principal-architect',
      raw: JSON.stringify(architectOutput),
      structured: architectOutput,
    });
  } catch (err: any) {
    await transition(pipeline, 'principal-architect', 'failed', onStageUpdate);
    throw new Error(`Architect agent failed: ${err.message}`);
  }

  // ── Stage 2: DevOps Architect (conditional — runs parallel-ish) ────────
  const devopsDef = AGENT_REGISTRY['devops-architect'];
  const needsDevOps = devopsDef.shouldRun(architectOutput, ctx);

  let devopsPromise = Promise.resolve(null as null);
  if (needsDevOps) {
    await transition(pipeline, 'devops-architect', 'running', onStageUpdate);
    devopsPromise = runDevOpsAgent(ctx, architectOutput)
      .then(async output => {
        pipeline.devopsOutput = output;
        await transition(pipeline, 'devops-architect', 'completed', onStageUpdate, {
          role: 'devops-architect',
          raw: JSON.stringify(output),
          structured: output,
        });
        return null;
      })
      .catch(async err => {
        await transition(pipeline, 'devops-architect', 'failed', onStageUpdate);
        console.error('DevOps agent failed (non-fatal):', err.message);
        return null;
      });
  } else {
    await transition(pipeline, 'devops-architect', 'skipped', onStageUpdate);
  }

  // ── Stage 3: Coding Engineer ───────────────────────────────────────────
  // Wait for devops to finish (it runs concurrently above)
  await devopsPromise;

  // Block if devops found critical security issues
  if (pipeline.devopsOutput && !pipeline.devopsOutput.approved) {
    const criticalIssues = pipeline.devopsOutput.securityIssues;
    await transition(pipeline, 'coding-engineer', 'failed', onStageUpdate);
    throw new Error(
      `DevOps Architect blocked: ${criticalIssues.join('; ')}`
    );
  }

  await transition(pipeline, 'coding-engineer', 'running', onStageUpdate);
  let prUrl: string;
  try {
    const result = await runCoderAgent(
      ctx,
      architectOutput,
      pipeline.devopsOutput ?? null,
      attempt
    );
    prUrl = result.prUrl;
    await transition(pipeline, 'coding-engineer', 'completed', onStageUpdate, {
      role: 'coding-engineer',
      raw: result.summary,
    });
  } catch (err: any) {
    await transition(pipeline, 'coding-engineer', 'failed', onStageUpdate);
    throw new Error(`Coder agent failed: ${err.message}`);
  }

  // ── Stage 4: Code Reviewer (Principal Engineer) ────────────────────────
  await transition(pipeline, 'code-reviewer', 'running', onStageUpdate);
  try {
    const diff = await getDiff(prUrl);
    const review = await runReviewerAgent(ctx, architectOutput, diff);
    pipeline.reviewOutput = review;
    pipeline.prUrl = prUrl;

    await transition(pipeline, 'code-reviewer', 'completed', onStageUpdate, {
      role: 'code-reviewer',
      raw: JSON.stringify(review),
      structured: review,
    });
  } catch (err: any) {
    // Reviewer failure is non-fatal — PR exists, just lacks automated review
    await transition(pipeline, 'code-reviewer', 'failed', onStageUpdate);
    pipeline.prUrl = prUrl;
    console.error('Reviewer agent failed (non-fatal):', err.message);
  }

  return pipeline;
}

function buildInitialStages(ctx: AgentContext): PipelineStage[] {
  const roles: AgentRole[] = [
    'principal-architect',
    'devops-architect',
    'coding-engineer',
    'code-reviewer',
  ];
  return roles.map(role => ({
    role,
    status: 'pending' as const,
  }));
}

async function transition(
  pipeline: AgentPipeline,
  role: AgentRole,
  status: PipelineStage['status'],
  onUpdate: StageEventCallback,
  output?: PipelineStage['output']
): Promise<void> {
  const stage = pipeline.stages.find(s => s.role === role);
  if (!stage) return;
  stage.status = status;
  if (status === 'running') stage.startedAt = new Date();
  if (status === 'completed' || status === 'failed') stage.completedAt = new Date();
  if (output) stage.output = output;
  onUpdate(pipeline);
}
