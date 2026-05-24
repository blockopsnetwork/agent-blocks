import { Octokit } from '@octokit/rest';
import { GitHubIssue, AgentContext } from '../types';

export class GitHubClient {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
    const { data } = await this.octokit.issues.get({ owner, repo, issue_number: number });
    return {
      id: String(data.id),
      number: data.number,
      title: data.title,
      body: data.body ?? '',
      url: data.html_url,
      repo: { owner, name: repo, fullName: `${owner}/${repo}` },
      labels: data.labels.map(l => (typeof l === 'string' ? l : l.name ?? '')),
      author: data.user?.login ?? 'unknown',
      createdAt: data.created_at,
    };
  }

  async hydrateContext(issue: GitHubIssue): Promise<AgentContext> {
    const { owner, name } = issue.repo;

    const [recentCommits, linkedPRs, similarIssues, repoTree] = await Promise.allSettled([
      this.getRecentCommits(owner, name),
      this.getLinkedPRs(owner, name, issue.number),
      this.searchSimilarIssues(owner, name, issue.title),
      this.getRepoStructure(owner, name),
    ]);

    return {
      issue,
      repoStructure: repoTree.status === 'fulfilled' ? repoTree.value : '',
      recentCommits: recentCommits.status === 'fulfilled' ? recentCommits.value : [],
      similarIssues: similarIssues.status === 'fulfilled' ? similarIssues.value : [],
      codeowners: {},
      testFiles: [],
      linkedPRs: linkedPRs.status === 'fulfilled' ? linkedPRs.value : [],
    };
  }

  private async getRecentCommits(owner: string, repo: string) {
    const { data } = await this.octokit.repos.listCommits({ owner, repo, per_page: 10 });
    return data.map(c => ({
      sha: c.sha,
      message: c.commit.message.split('\n')[0],
      files: [],
    }));
  }

  private async getLinkedPRs(owner: string, repo: string, issueNumber: number) {
    // Search PRs that reference the issue number in title/body
    const { data } = await this.octokit.search.issuesAndPullRequests({
      q: `repo:${owner}/${repo} is:pr ${issueNumber} in:body`,
      per_page: 5,
    });
    return data.items.map(i => ({
      number: i.number,
      title: i.title,
      state: i.state,
    }));
  }

  private async searchSimilarIssues(owner: string, repo: string, title: string) {
    const keywords = title.split(' ').slice(0, 4).join(' ');
    try {
      const { data } = await this.octokit.search.issuesAndPullRequests({
        q: `repo:${owner}/${repo} is:issue is:closed ${keywords}`,
        per_page: 5,
        sort: 'updated',
      });
      return data.items.map(i => ({ number: i.number, title: i.title }));
    } catch {
      return [];
    }
  }

  private async getRepoStructure(owner: string, repo: string): Promise<string> {
    try {
      const { data } = await this.octokit.git.getTree({
        owner,
        repo,
        tree_sha: 'HEAD',
        recursive: 'false',
      });
      return data.tree
        .filter(f => f.type === 'blob' || f.type === 'tree')
        .slice(0, 80)
        .map(f => f.path)
        .join('\n');
    } catch {
      return '';
    }
  }

  async commentOnIssue(owner: string, repo: string, number: number, body: string) {
    await this.octokit.issues.createComment({ owner, repo, issue_number: number, body });
  }
}
