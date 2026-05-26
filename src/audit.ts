export type StackType =
  | "node-npm"
  | "node-bun"
  | "java-maven"
  | "java-gradle"
  | "go"
  | "python"
  | "static"
  | "unknown";

export interface RepoStack {
  type: StackType;
  hasCI: boolean;
  hasTests: boolean;
  hasReadme: boolean;
  defaultBranch: string;
  rootFiles: string[];
}

export interface MaintenanceItem {
  type: "missing-ci" | "missing-tests" | "missing-readme" | "merge-dep-pr";
  title: string;
  body: string;
  priority: "high" | "med" | "low";
  prNumber?: number;
}

export interface RepoAudit {
  repo: string;
  stack: RepoStack;
  items: MaintenanceItem[];
}

interface ContentItem {
  name: string;
  type: string;
}

interface RepoResponse {
  default_branch?: string;
}

interface IssueResponse {
  title: string;
  pull_request?: unknown;
}

const githubApiBaseUrl = "https://api.github.com";
const emptyStack: RepoStack = {
  type: "unknown",
  hasCI: false,
  hasTests: false,
  hasReadme: false,
  defaultBranch: "",
  rootFiles: []
};

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

async function fetchGitHub(url: string, token: string): Promise<Response> {
  return fetch(url, { headers: githubHeaders(token) });
}

async function readContents(repo: string, path: string, token: string): Promise<ContentItem[] | null> {
  const response = await fetchGitHub(`${githubApiBaseUrl}/repos/${repo}/contents/${path}`, token);

  if (response.status === 404 || response.status === 403) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`GitHub ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  return Array.isArray(payload) ? payload as ContentItem[] : null;
}

async function readDefaultBranch(repo: string, token: string): Promise<string> {
  try {
    const response = await fetchGitHub(`${githubApiBaseUrl}/repos/${repo}`, token);

    if (!response.ok) {
      return "";
    }

    const payload = await response.json() as RepoResponse;
    return payload.default_branch || "";
  } catch {
    return "";
  }
}

function detectType(rootFiles: string[]): StackType {
  const files = new Set(rootFiles);

  if (files.has("bun.lock") || files.has("bunfig.toml")) return "node-bun";
  if (files.has("package.json")) return "node-npm";
  if (files.has("pom.xml")) return "java-maven";
  if (files.has("build.gradle") || files.has("build.gradle.kts")) return "java-gradle";
  if (files.has("go.mod")) return "go";
  if (files.has("requirements.txt") || files.has("pyproject.toml") || files.has("setup.py")) return "python";
  if (files.has("index.html")) return "static";
  return "unknown";
}

function hasTestEntry(items: ContentItem[]): boolean {
  const testDirs = new Set(["test", "tests", "__tests__", "spec"]);

  return items.some((item) => {
    if (testDirs.has(item.name)) {
      return true;
    }

    return /\b(test|spec)\.[^.]+$/i.test(item.name) || /\.(test|spec)\.[^.]+$/i.test(item.name);
  });
}

function testSuggestion(stackType: StackType): string {
  if (stackType === "node-npm" || stackType === "node-bun") {
    return "Use Vitest or Jest. Add a `test` script in `package.json`.";
  }

  if (stackType === "java-maven" || stackType === "java-gradle") {
    return "Use JUnit 5 with Mockito for unit tests.";
  }

  if (stackType === "go") {
    return "Use the standard `testing` package. Run with `go test ./...`.";
  }

  if (stackType === "python") {
    return "Use pytest. Add a `tests/` directory.";
  }

  return "Add unit tests for the core logic.";
}

function issueBody(type: MaintenanceItem["type"], stackType: StackType): string {
  if (type === "missing-ci") {
    return `## Context

This repository does not have a GitHub Actions CI workflow.

## Proposed action

Add \`.github/workflows/ci.yml\` to run tests and build on every push and pull request.

This ensures:
- Broken code is caught before merging
- Dependencies are validated on each change
- Build artifacts are verified consistently

## Stack detected

${stackType}

_This issue was created automatically by [github-scanner](https://github.com/Yeisonfjrd/github-scanner)._`;
  }

  if (type === "missing-tests") {
    return `## Context

No test directory or test files were detected in this repository.

## Proposed action

Add unit tests covering the core logic of this project.

Suggested approach for ${stackType}:
- ${testSuggestion(stackType)}

_This issue was created automatically by [github-scanner](https://github.com/Yeisonfjrd/github-scanner)._`;
  }

  return `## Context

This repository does not have a README.md file.

## Proposed action

Add a \`README.md\` with at minimum:
- Project description
- Prerequisites
- Setup instructions
- Usage examples

_This issue was created automatically by [github-scanner](https://github.com/Yeisonfjrd/github-scanner)._`;
}

async function openIssueTitles(repo: string, token: string): Promise<Set<string>> {
  const response = await fetchGitHub(`${githubApiBaseUrl}/repos/${repo}/issues?state=open&per_page=100`, token);

  if (!response.ok) {
    return new Set();
  }

  const issues = await response.json() as IssueResponse[];
  return new Set(
    issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => issue.title)
  );
}

export async function detectStack(repo: string, token: string): Promise<RepoStack> {
  try {
    const root = await readContents(repo, "", token);

    if (!root) {
      return { ...emptyStack };
    }

    const rootFiles = root.map((item) => item.name);
    const type = detectType(rootFiles);
    const workflows = await readContents(repo, ".github/workflows", token);
    const src = hasTestEntry(root) ? null : await readContents(repo, "src", token);

    return {
      type,
      hasCI: workflows?.some((item) => item.name.endsWith(".yml")) ?? false,
      hasTests: hasTestEntry(root) || (src ? hasTestEntry(src) : false),
      hasReadme: rootFiles.some((file) => file.toLowerCase() === "readme.md"),
      defaultBranch: await readDefaultBranch(repo, token),
      rootFiles
    };
  } catch {
    return { ...emptyStack };
  }
}

export async function auditRepo(repo: string, token: string, staleDays: number): Promise<RepoAudit> {
  void staleDays;

  const stack = await detectStack(repo, token);
  const items: MaintenanceItem[] = [];

  if (stack.type === "unknown") {
    return { repo, stack, items };
  }

  const existingTitles = await openIssueTitles(repo, token);

  function pushIfMissing(item: MaintenanceItem): void {
    if (!existingTitles.has(item.title)) {
      items.push(item);
    }
  }

  if (!stack.hasCI && stack.type !== "static") {
    pushIfMissing({
      type: "missing-ci",
      priority: "high",
      title: "ci: add GitHub Actions CI workflow",
      body: issueBody("missing-ci", stack.type)
    });
  }

  if (!stack.hasTests && stack.type !== "static") {
    pushIfMissing({
      type: "missing-tests",
      priority: "med",
      title: "test: add unit tests",
      body: issueBody("missing-tests", stack.type)
    });
  }

  if (!stack.hasReadme) {
    pushIfMissing({
      type: "missing-readme",
      priority: "low",
      title: "docs: add README with setup and usage instructions",
      body: issueBody("missing-readme", stack.type)
    });
  }

  return { repo, stack, items };
}
