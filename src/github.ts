export interface Repo {
  full_name: string;
  default_branch: string;
}

export interface AuthenticatedUser {
  login: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  labels: string[];
}

export interface PR {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  draft: boolean;
  changed_files: number;
  additions: number;
  deletions: number;
  base_branch: string;
  head_branch: string;
  author: string;
  labels: string[];
}

interface GitHubRepoResponse {
  full_name: string;
  default_branch: string;
  fork: boolean;
}

interface GitHubUserResponse {
  login: string;
}

interface GitHubIssueResponse {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  labels: Array<string | { name?: string | null }>;
  pull_request?: unknown;
}

interface GitHubPullResponse {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  draft: boolean;
  changed_files?: number;
  additions?: number;
  deletions?: number;
  base: { ref: string };
  head: { ref: string };
  user?: { login?: string | null } | null;
  labels: Array<string | { name?: string | null }>;
}

const githubApiBaseUrl = "https://api.github.com";

function githubHeaders(token: string): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  if (token.trim()) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  for (const part of linkHeader.split(",")) {
    const [urlPart, relPart] = part.split(";").map((value) => value.trim());

    if (relPart === 'rel="next"') {
      return urlPart.slice(1, -1);
    }
  }

  return null;
}

async function fetchAllPages<T>(url: string, token: string): Promise<T[]> {
  const items: T[] = [];
  let nextUrl: string | null = url;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: githubHeaders(token)
    });

    if (!response.ok) {
      throw new Error(`GitHub ${response.status}: ${await response.text()}`);
    }

    const page = (await response.json()) as T[];
    items.push(...page);
    nextUrl = nextPageUrl(response.headers.get("Link"));
  }

  return items;
}

async function fetchGitHub<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: githubHeaders(token)
  });

  if (!response.ok) {
    throw new Error(`GitHub ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as T;
}

export async function getAuthenticatedUser(token: string): Promise<AuthenticatedUser> {
  const user = await fetchGitHub<GitHubUserResponse>(`${githubApiBaseUrl}/user`, token);

  return {
    login: user.login
  };
}

export async function getUserRepos(token: string): Promise<Repo[]> {
  const url = `${githubApiBaseUrl}/user/repos?per_page=100&sort=updated&affiliation=owner`;
  const repos = await fetchAllPages<GitHubRepoResponse>(url, token);

  return repos
    .filter((repo) => !repo.fork)
    .map((repo) => ({
      full_name: repo.full_name,
      default_branch: repo.default_branch
    }));
}

export async function getOpenIssues(repo: string, token: string): Promise<Issue[]> {
  const url = `${githubApiBaseUrl}/repos/${repo}/issues?state=open&per_page=100&sort=created&direction=desc`;
  const issues = await fetchAllPages<GitHubIssueResponse>(url, token);

  return issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      html_url: issue.html_url,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      labels: issue.labels
        .map((label) => (typeof label === "string" ? label : label.name))
        .filter((label): label is string => Boolean(label))
    }));
}

function labelsFrom(labels: Array<string | { name?: string | null }>): string[] {
  return labels
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((label): label is string => Boolean(label));
}

function issueFromResponse(issue: GitHubIssueResponse): Issue {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    html_url: issue.html_url,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    labels: labelsFrom(issue.labels)
  };
}

function prFromResponse(pr: GitHubPullResponse): PR {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    html_url: pr.html_url,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    draft: pr.draft,
    changed_files: pr.changed_files ?? 0,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    base_branch: pr.base.ref,
    head_branch: pr.head.ref,
    author: pr.user?.login ?? "",
    labels: labelsFrom(pr.labels)
  };
}

export async function getOpenPRs(repo: string, token: string): Promise<PR[]> {
  const url = `${githubApiBaseUrl}/repos/${repo}/pulls?state=open&per_page=100`;
  const prs = await fetchAllPages<GitHubPullResponse>(url, token);
  const detailedPRs: PR[] = [];

  for (const pr of prs) {
    const detail = await fetchGitHub<GitHubPullResponse>(
      `${githubApiBaseUrl}/repos/${repo}/pulls/${pr.number}`,
      token
    );
    detailedPRs.push(prFromResponse(detail));
  }

  return detailedPRs;
}

export async function getStaleIssues(repo: string, token: string, staleDays: number): Promise<Issue[]> {
  const url = `${githubApiBaseUrl}/repos/${repo}/issues?state=open&per_page=100&sort=updated&direction=asc`;
  const issues = await fetchAllPages<GitHubIssueResponse>(url, token);
  const staleBefore = Date.now() - staleDays * 24 * 60 * 60 * 1000;

  return issues
    .filter((issue) => !issue.pull_request)
    .filter((issue) => new Date(issue.updated_at).getTime() < staleBefore)
    .map(issueFromResponse);
}
