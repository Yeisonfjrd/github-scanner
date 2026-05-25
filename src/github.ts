export interface Repo {
  full_name: string;
  default_branch: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  created_at: string;
  labels: string[];
}

interface GitHubRepoResponse {
  full_name: string;
  default_branch: string;
  fork: boolean;
}

interface GitHubIssueResponse {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  created_at: string;
  labels: Array<string | { name?: string | null }>;
  pull_request?: unknown;
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

export async function getUserRepos(user: string, token: string): Promise<Repo[]> {
  const url = `${githubApiBaseUrl}/users/${encodeURIComponent(user)}/repos?per_page=100&sort=updated&type=owner`;
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
      labels: issue.labels
        .map((label) => (typeof label === "string" ? label : label.name))
        .filter((label): label is string => Boolean(label))
    }));
}
