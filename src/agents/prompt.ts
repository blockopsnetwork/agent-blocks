import { AgentContext, AgentPlan } from '../types';

export function buildPlanningPrompt(ctx: AgentContext): string {
  return `You are a principal software engineer. Analyze this GitHub issue and produce an implementation plan.

## Issue: ${ctx.issue.repo.fullName}#${ctx.issue.number}
**Title:** ${ctx.issue.title}
**Body:**
${ctx.issue.body}

## Repository Structure (top-level)
\`\`\`
${ctx.repoStructure}
\`\`\`

## Recent Commits
${ctx.recentCommits.slice(0, 5).map(c => `- ${c.sha.slice(0, 7)}: ${c.message}`).join('\n')}

## Similar Resolved Issues
${ctx.similarIssues.map(i => `- #${i.number}: ${i.title}`).join('\n') || 'None found'}

Return ONLY valid JSON:
{
  "approach": "2-3 sentence description of the fix approach",
  "files": ["list", "of", "files", "to", "change"],
  "testStrategy": "which tests to add/update and why",
  "riskLevel": "low" | "medium" | "high",
  "estimatedChanges": "e.g. ~50 lines across 3 files"
}`.trim();
}

export function buildCodingPrompt(ctx: AgentContext, plan: AgentPlan, attempt: number): string {
  const retryNote = attempt > 1
    ? `\n## Retry Note\nThis is attempt ${attempt}. Previous attempt failed. Reconsider your approach.\n`
    : '';

  return `You are a principal software engineer fixing a GitHub issue. Be precise, minimal, and correct.

## Issue: ${ctx.issue.repo.fullName}#${ctx.issue.number}
**Title:** ${ctx.issue.title}
**Description:**
${ctx.issue.body}
${retryNote}
## Implementation Plan
${plan.approach}
**Files to change:** ${plan.files.join(', ')}
**Test strategy:** ${plan.testStrategy}
**Risk:** ${plan.riskLevel}

## Context
Similar past fixes:
${ctx.similarIssues.map(i => `- #${i.number}: ${i.title}`).join('\n') || 'None'}

Recent commits on this repo:
${ctx.recentCommits.slice(0, 3).map(c => `- ${c.sha.slice(0, 7)}: ${c.message}`).join('\n')}

## Requirements (strictly follow)
1. Fix ONLY what the issue describes — no unrelated cleanup
2. Run linter after changes and fix all issues
3. Add/update tests per the test strategy above
4. Check callers of any function you modify for blast radius
5. Look for similar bugs in adjacent code and fix defensively
6. Commit with message: "fix: <short description> (resolves #${ctx.issue.number})"
7. PR title: "fix: ${ctx.issue.title}"
8. PR body must include:
   - Root cause
   - What changed and why
   - Test coverage added
   - Any risk or follow-up work

## Validation
After changes, run tests for affected files. Max 2 CI retry rounds.
`.trim();
}
