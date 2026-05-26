import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { createIssue, mergePR, pushWorkflow } from "./actions";
import { auditRepo, detectStack, type MaintenanceItem, type RepoAudit } from "./audit";
import { confirm } from "./confirm";
import { closeDB, getAppliedActions, initDB, isNew, isPRNew, logAction, markPRSeen, markSeen, resetDB } from "./db";
import { getAuthenticatedUser, getOpenIssues, getOpenPRs, getStaleIssues, getUserRepos, type PR, type Repo } from "./github";
import { analyzeIssue, analyzePR, checkGroqAvailable, type PRAnalysis } from "./llm";
import {
  generateJSON,
  generateMarkdown,
  type AnalyzedIssue,
  type AnalyzedPR,
  type StaleIssue
} from "./report";
import { generateWorkflow } from "./workflows";

const defaultDbPath = "data/sentinel.db";
const defaultModel = "llama-3.1-8b-instant";
const defaultStaleDays = 30;

interface Flags {
  digest: boolean;
  prs: boolean;
  stale: boolean;
  reset: boolean;
  print: boolean;
  audit: boolean;
  apply: boolean;
  mergeDeps: boolean;
  pushWorkflows: boolean;
  repo?: string;
}

interface DigestSummary {
  total: number;
  byType: Record<string, number>;
  byRisk: Record<string, number>;
  repos: string[];
}

interface MergeablePR {
  repo: string;
  pr: PR;
  analysis: PRAnalysis;
}

interface AuditFile {
  generatedAt: string;
  audits: RepoAudit[];
  mergeablePRs: MergeablePR[];
}

function requiredEnv(name: string): string {
  const value = Bun.env[name];

  if (!value?.trim()) {
    throw new Error(`[scan] Falta ${name}. Revisa tu archivo .env.`);
  }

  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return Bun.env[name]?.trim() || fallback;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {
    digest: false,
    prs: false,
    stale: false,
    reset: false,
    print: false,
    audit: false,
    apply: false,
    mergeDeps: false,
    pushWorkflows: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--digest") flags.digest = true;
    if (arg === "--prs") flags.prs = true;
    if (arg === "--stale") flags.stale = true;
    if (arg === "--reset") flags.reset = true;
    if (arg === "--print") flags.print = true;
    if (arg === "--audit") flags.audit = true;
    if (arg === "--apply") flags.apply = true;
    if (arg === "--merge-deps") flags.mergeDeps = true;
    if (arg === "--push-workflows") flags.pushWorkflows = true;
    if (arg === "--repo") {
      flags.repo = args[index + 1];
      index += 1;
    }
  }

  return flags;
}

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isoWeek(date: Date): { year: number; week: number } {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((value.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);

  return { year: value.getUTCFullYear(), week };
}

function uniquePath(basePath: string, extension: "md" | "json"): string {
  let path = `${basePath}.${extension}`;
  let counter = 2;

  while (existsSync(path)) {
    path = `${basePath}-${counter}.${extension}`;
    counter += 1;
  }

  return path;
}

function outputBase(generatedAt: Date, vaultPath: string | undefined): string {
  if (vaultPath) {
    const dir = join(vaultPath, "github-scanner");
    return join(dir, `report-${dateStamp(generatedAt)}`);
  }

  mkdirSync("data", { recursive: true });
  return join("data", `report-${dateStamp(generatedAt)}`);
}

function riskLabel(risk: string): string {
  return risk.toUpperCase();
}

function daysSince(value: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(value).getTime()) / (24 * 60 * 60 * 1000));
}

function parseStaleDays(): number {
  const parsed = Number.parseInt(optionalEnv("STALE_DAYS", String(defaultStaleDays)), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultStaleDays;
}

function shouldScanIssues(flags: Flags): boolean {
  return !flags.prs && !flags.stale && !flags.digest && !flags.audit && !flags.apply && !flags.mergeDeps && !flags.pushWorkflows;
}

function shouldScanPRs(flags: Flags): boolean {
  return flags.prs || (!flags.stale && !flags.digest && !flags.audit && !flags.apply && !flags.mergeDeps && !flags.pushWorkflows);
}

function shouldScanStale(flags: Flags): boolean {
  return flags.stale || (!flags.prs && !flags.digest && !flags.audit && !flags.apply && !flags.mergeDeps && !flags.pushWorkflows);
}

function requiresGroq(flags: Flags): boolean {
  return shouldScanIssues(flags) || shouldScanPRs(flags) || flags.audit || flags.mergeDeps;
}

async function resolveRepos(token: string, flags: Flags): Promise<Repo[]> {
  if (flags.repo?.trim()) {
    return [{ full_name: flags.repo.trim(), default_branch: "" }];
  }

  return getUserRepos(token);
}

async function writeObsidian(
  vaultPath: string | undefined,
  issues: AnalyzedIssue[],
  prs: AnalyzedPR[],
  stale: StaleIssue[],
  generatedAt: Date
): Promise<void> {
  if (!vaultPath) {
    return;
  }

  const obsidian = await import("./obsidian");

  for (const issue of issues) {
    await obsidian.writeIssueNote(vaultPath, issue);
  }

  for (const pr of prs) {
    await obsidian.writePRNote(vaultPath, pr);
  }

  await obsidian.writeStaleNote(vaultPath, stale, generatedAt);
  await obsidian.writeDigest(vaultPath, issues, prs, stale, generatedAt);
  await obsidian.updateVaultIndex(vaultPath, generatedAt);
}

function readDigestSummary(db: Database, date: Date): DigestSummary {
  const since = new Date(date.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .query("SELECT repo, type, risk FROM seen_issues WHERE analyzed_at >= ?")
    .all(since) as Array<{ repo: string; type: string | null; risk: string | null }>;
  const summary: DigestSummary = {
    total: rows.length,
    byType: {},
    byRisk: {},
    repos: Array.from(new Set(rows.map((row) => row.repo))).sort()
  };

  for (const row of rows) {
    const type = row.type || "other";
    const risk = row.risk || "low";
    summary.byType[type] = (summary.byType[type] ?? 0) + 1;
    summary.byRisk[risk] = (summary.byRisk[risk] ?? 0) + 1;
  }

  return summary;
}

function generateDigestMarkdown(summary: DigestSummary, date: Date): string {
  const typeLines = ["bug", "feature", "docs", "question", "other"]
    .map((type) => `- ${type}: ${summary.byType[type] ?? 0}`)
    .join("\n");
  const riskLines = ["high", "med", "low"]
    .map((risk) => `- ${risk}: ${summary.byRisk[risk] ?? 0}`)
    .join("\n");
  const repos = summary.repos.length > 0 ? summary.repos.map((repo) => `- ${repo}`).join("\n") : "Sin repos con actividad.";

  return `# Digest GitHub Scanner
Generado: ${dateStamp(date)}

Issues analizadas en los últimos 7 días: ${summary.total}

## Desglose por tipo

${typeLines}

## Desglose por riesgo

${riskLines}

## Repos con actividad

${repos}
`;
}

async function writeDigestFromDB(db: Database, dbPath: string, vaultPath: string | undefined): Promise<void> {
  const generatedAt = new Date();
  const summary = readDigestSummary(db, generatedAt);
  const content = generateDigestMarkdown(summary, generatedAt);
  const { year, week } = isoWeek(generatedAt);
  const dir = vaultPath ? join(vaultPath, "github-scanner", "digests") : "data";
  mkdirSync(dirname(dbPath), { recursive: true });

  const path = join(dir, `digest-${year}-W${week}.md`);
  try {
    mkdirSync(dir, { recursive: true });
    await Bun.write(path, content);
  } catch (error) {
    if (!vaultPath) {
      throw error;
    }

    console.error(`[obsidian] Error escribiendo digest: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (vaultPath) {
    const obsidian = await import("./obsidian");
    await obsidian.updateVaultIndex(vaultPath, generatedAt);
  }

  console.log(`[scan] Digest guardado en: ${path}`);
}

async function writeReportFiles(
  markdownPath: string,
  jsonPath: string,
  markdown: string,
  json: string,
  vaultPath: string | undefined
): Promise<void> {
  try {
    mkdirSync(dirname(markdownPath), { recursive: true });
    await Bun.write(markdownPath, markdown);
    await Bun.write(jsonPath, json);
  } catch (error) {
    if (!vaultPath) {
      throw error;
    }

    console.error(`[obsidian] Error escribiendo reporte: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function auditPathFor(date: Date): string {
  mkdirSync("data", { recursive: true });
  return join("data", `audit-${dateStamp(date)}.json`);
}

function applyLogPathFor(date: Date): string {
  mkdirSync("data", { recursive: true });
  return join("data", `apply-${dateStamp(date)}.log`);
}

async function appendApplyLog(path: string, line: string): Promise<void> {
  await Bun.write(path, `${existsSync(path) ? await Bun.file(path).text() : ""}${line}\n`);
}

function shortRepoName(repo: string): string {
  return repo.split("/").pop() || repo;
}

function check(value: boolean): string {
  return value ? "✓" : "✗";
}

function labelsFor(item: MaintenanceItem): string[] {
  if (item.type === "missing-ci") return ["ci", "maintenance"];
  if (item.type === "missing-tests") return ["testing", "maintenance"];
  if (item.type === "missing-readme") return ["documentation", "maintenance"];
  return ["maintenance"];
}

function isDependencyPR(pr: PR): boolean {
  const title = pr.title.toLowerCase();
  return /^(chore|fix|deps|bump)(\(.+\))?:/.test(title) || title.startsWith("bump ") || title.includes("dependenc");
}

function isBotAuthor(author: string): boolean {
  const value = author.toLowerCase();
  return value.includes("[bot]") || value.includes("dependabot") || value.includes("renovate");
}

function isMergeableDependencyPR(pr: PR, analysis: PRAnalysis): boolean {
  return analysis.risk === "low" && isDependencyPR(pr) && isBotAuthor(pr.author);
}

function wasApplied(db: Database, repo: string, type: "merge-pr" | "push-workflow" | "create-issue", target: string): boolean {
  return getAppliedActions(db, repo).some(
    (action) => action.type === type && action.target === target && action.result === "success"
  );
}

async function collectMergeablePRs(repos: Repo[], token: string): Promise<MergeablePR[]> {
  const mergeable: MergeablePR[] = [];

  for (const repo of repos) {
    console.log(`[scan] Revisando PRs mergeables en ${repo.full_name}...`);

    try {
      const prs = await getOpenPRs(repo.full_name, token);

      for (const pr of prs) {
        const analysis = await analyzePR(pr.title, pr.body, repo.full_name, pr);

        if (isMergeableDependencyPR(pr, analysis)) {
          mergeable.push({ repo: repo.full_name, pr, analysis });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scan]   Error revisando PRs mergeables en ${repo.full_name}: ${message}`);
    }
  }

  return mergeable;
}

function generateAuditMarkdown(auditFile: AuditFile): string {
  const lines = [`# Audit GitHub Scanner`, `Generado: ${auditFile.generatedAt.slice(0, 10)}`, ""];

  for (const audit of auditFile.audits) {
    lines.push(`## ${audit.repo}`);
    lines.push(`- Stack: ${audit.stack.type}`);
    lines.push(`- CI: ${check(audit.stack.hasCI)}`);
    lines.push(`- Tests: ${check(audit.stack.hasTests)}`);
    lines.push(`- README: ${check(audit.stack.hasReadme)}`);
    lines.push(`- Items: ${audit.items.length}`);
    lines.push("");
  }

  lines.push(`## PRs de dependencias mergeables`);
  lines.push(auditFile.mergeablePRs.length === 0
    ? "Sin PRs mergeables."
    : auditFile.mergeablePRs.map((item) => `- ${item.repo}#${item.pr.number}: ${item.pr.title}`).join("\n"));
  lines.push("");

  return lines.join("\n");
}

async function writeAuditFile(auditFile: AuditFile, vaultPath: string | undefined): Promise<string> {
  const path = auditPathFor(new Date(auditFile.generatedAt));
  await Bun.write(path, JSON.stringify(auditFile, null, 2));

  if (vaultPath) {
    const dir = join(vaultPath, "github-scanner", "audits");
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, `audit-${auditFile.generatedAt.slice(0, 10)}.md`), generateAuditMarkdown(auditFile));
  }

  return path;
}

async function runAudit(repos: Repo[], token: string, staleDays: number, vaultPath: string | undefined): Promise<AuditFile> {
  const audits: RepoAudit[] = [];

  for (const repo of repos) {
    const audit = await auditRepo(repo.full_name, token, staleDays);
    audits.push(audit);

    console.log(`[audit] ${repo.full_name}`);
    console.log(`  stack: ${audit.stack.type}`);
    console.log(`  CI: ${check(audit.stack.hasCI)}${audit.items.some((item) => item.type === "missing-ci") ? "  → falta workflow" : ""}`);
    console.log(`  tests: ${check(audit.stack.hasTests)}${audit.items.some((item) => item.type === "missing-tests") ? "  → no se encontraron tests" : ""}`);
    console.log(`  readme: ${check(audit.stack.hasReadme)}${audit.items.some((item) => item.type === "missing-readme") ? "  → falta README" : ""}`);
    console.log(audit.items.length === 0
      ? "  → Sin items de mantenimiento."
      : `  → ${audit.items.length} item${audit.items.length === 1 ? "" : "s"} de mantenimiento.`);
    console.log("");
  }

  const mergeablePRs = await collectMergeablePRs(repos, token);
  const auditFile: AuditFile = {
    generatedAt: new Date().toISOString(),
    audits,
    mergeablePRs
  };
  const path = await writeAuditFile(auditFile, vaultPath);
  const missingCI = audits.filter((audit) => audit.items.some((item) => item.type === "missing-ci")).length;
  const missingTests = audits.filter((audit) => audit.items.some((item) => item.type === "missing-tests")).length;
  const missingReadme = audits.filter((audit) => audit.items.some((item) => item.type === "missing-readme")).length;

  console.log(`Audit guardado en: ${path}`);
  console.log("\nResumen audit:");
  console.log(`  Repos auditados: ${audits.length}`);
  console.log(`  Sin CI: ${missingCI}`);
  console.log(`  Sin tests: ${missingTests}`);
  console.log(`  Sin README: ${missingReadme}`);
  console.log(`  PRs de dependencias mergeables: ${mergeablePRs.length}`);

  return auditFile;
}

async function readTodayAuditOrNull(): Promise<AuditFile | null> {
  const today = dateStamp(new Date());

  if (!existsSync("data")) {
    return null;
  }

  const files = readdirSync("data")
    .filter((file) => file === `audit-${today}.json`)
    .sort()
    .reverse();

  if (files.length === 0) {
    return null;
  }

  return JSON.parse(await Bun.file(join("data", files[0])).text()) as AuditFile;
}

async function runMergeDeps(
  db: Database,
  mergeablePRs: MergeablePR[],
  token: string,
  autoMerge: boolean,
  logPath?: string
): Promise<{ done: number; total: number; errors: number }> {
  let done = 0;
  let errors = 0;

  for (const item of mergeablePRs) {
    const target = String(item.pr.number);

    if (wasApplied(db, item.repo, "merge-pr", target)) {
      continue;
    }

    const shouldApply = autoMerge || await confirm(`[apply] Merge PR #${item.pr.number} en ${shortRepoName(item.repo)}
        ${item.pr.title} (riesgo=${item.analysis.risk}, autor=${item.pr.author})
        ¿Confirmar?`);

    if (!shouldApply) {
      logAction(db, item.repo, "merge-pr", target, "skipped", "Saltado por el usuario");
      continue;
    }

    const result = await mergePR(item.repo, item.pr.number, item.pr.title, token);
    logAction(db, item.repo, "merge-pr", target, result.success ? "success" : "error", result.message);
    console.log(result.success ? `  ✓ ${result.message}` : `  ✗ ${result.message}`);

    if (result.success) {
      done += 1;
    } else {
      errors += 1;
      if (logPath) {
        await appendApplyLog(logPath, `${new Date().toISOString()} merge-pr ${item.repo}#${item.pr.number}: ${result.message}`);
      }
    }
  }

  return { done, total: mergeablePRs.length, errors };
}

async function runPushWorkflows(
  db: Database,
  audits: RepoAudit[],
  token: string,
  logPath?: string
): Promise<{ done: number; total: number; errors: number }> {
  let done = 0;
  let errors = 0;
  const candidates = audits.filter((audit) => audit.items.some((item) => item.type === "missing-ci"));

  for (const audit of candidates) {
    if (wasApplied(db, audit.repo, "push-workflow", "ci.yml")) {
      continue;
    }

    const workflow = generateWorkflow(audit.stack, audit.repo);

    if (!workflow) {
      continue;
    }

    const shouldApply = await confirm(`[apply] Push workflow CI para ${shortRepoName(audit.repo)}
        stack: ${audit.stack.type} → .github/workflows/ci.yml
        ¿Confirmar?`);

    if (!shouldApply) {
      logAction(db, audit.repo, "push-workflow", "ci.yml", "skipped", "Saltado por el usuario");
      continue;
    }

    const result = await pushWorkflow(audit.repo, audit.stack.defaultBranch || "main", workflow, token);
    logAction(db, audit.repo, "push-workflow", "ci.yml", result.success ? "success" : "error", result.message);
    console.log(result.success ? `  ✓ ${result.message} → .github/workflows/ci.yml` : `  ✗ ${result.message}`);

    if (result.success) {
      done += 1;
    } else {
      errors += 1;
      if (logPath) {
        await appendApplyLog(logPath, `${new Date().toISOString()} push-workflow ${audit.repo}: ${result.message}`);
      }
    }
  }

  return { done, total: candidates.length, errors };
}

async function runCreateIssues(
  db: Database,
  audits: RepoAudit[],
  token: string,
  logPath?: string
): Promise<{ done: number; total: number; errors: number }> {
  let done = 0;
  let errors = 0;
  const items = audits.flatMap((audit) => audit.items.map((item) => ({ audit, item })));

  for (const { audit, item } of items) {
    if (item.type === "merge-dep-pr" || wasApplied(db, audit.repo, "create-issue", item.title)) {
      continue;
    }

    const labels = labelsFor(item);
    const shouldApply = await confirm(`[apply] Crear issue en ${shortRepoName(audit.repo)}
        "${item.title}" [labels: ${labels.join(", ")}]
        ¿Confirmar?`);

    if (!shouldApply) {
      logAction(db, audit.repo, "create-issue", item.title, "skipped", "Saltado por el usuario");
      continue;
    }

    const result = await createIssue(audit.repo, item.title, item.body, labels, token);
    logAction(db, audit.repo, "create-issue", item.title, result.success ? "success" : "error", result.message);
    console.log(result.success ? `  ✓ ${result.message}` : `  ✗ ${result.message}`);

    if (result.success) {
      done += 1;
    } else {
      errors += 1;
      if (logPath) {
        await appendApplyLog(logPath, `${new Date().toISOString()} create-issue ${audit.repo} "${item.title}": ${result.message}`);
      }
    }
  }

  return { done, total: items.filter(({ item }) => item.type !== "merge-dep-pr").length, errors };
}

async function runApply(db: Database, repos: Repo[], token: string, staleDays: number, vaultPath: string | undefined): Promise<void> {
  let auditFile = await readTodayAuditOrNull();

  if (!auditFile) {
    const groqAvailable = await checkGroqAvailable();

    if (!groqAvailable || !Bun.env.GROQ_API_KEY?.trim()) {
      console.error("[scan] No existe audit de hoy y Groq no está disponible para generarlo automáticamente.");
      process.exitCode = 1;
      return;
    }

    auditFile = await runAudit(repos, token, staleDays, vaultPath);
  }

  const autoMerge = (Bun.env.AUTO_MERGE_DEPS ?? "false").toLowerCase() === "true";
  const logPath = applyLogPathFor(new Date());
  const mergeSummary = await runMergeDeps(db, auditFile.mergeablePRs, token, autoMerge, logPath);
  const workflowSummary = await runPushWorkflows(db, auditFile.audits, token, logPath);
  const issueSummary = await runCreateIssues(db, auditFile.audits, token, logPath);
  const errors = mergeSummary.errors + workflowSummary.errors + issueSummary.errors;

  if (errors > 0) {
    await appendApplyLog(logPath, `${new Date().toISOString()} errores=${errors}`);
  }

  console.log("\nResumen --apply:");
  console.log(`  PRs mergeados: ${mergeSummary.done}/${mergeSummary.total}`);
  console.log(`  Workflows pusheados: ${workflowSummary.done}/${workflowSummary.total}`);
  console.log(`  Issues creadas: ${issueSummary.done}/${issueSummary.total}`);
  console.log(`  Errores: ${errors}${errors > 0 ? ` (ver ${logPath})` : ""}`);
}

async function runPushWorkflowsOnly(db: Database, repos: Repo[], token: string): Promise<void> {
  const audits: RepoAudit[] = [];

  for (const repo of repos) {
    const stack = await detectStack(repo.full_name, token);

    if (!stack.hasCI && stack.type !== "unknown" && stack.type !== "static") {
      audits.push({
        repo: repo.full_name,
        stack,
        items: [{
          type: "missing-ci",
          title: "ci: add GitHub Actions CI workflow",
          body: "",
          priority: "high"
        }]
      });
    }
  }

  const summary = await runPushWorkflows(db, audits, token);
  console.log(`\nResumen --push-workflows: ${summary.done}/${summary.total} workflows pusheados, errores: ${summary.errors}`);
}

async function main(): Promise<void> {
  const flags = parseFlags(Bun.argv.slice(2));
  const dbPath = optionalEnv("SENTINEL_DB_PATH", defaultDbPath);
  const vaultPath = Bun.env.OBSIDIAN_VAULT_PATH?.trim() || undefined;

  mkdirSync("data", { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = initDB(dbPath);

  try {
    if (flags.reset) {
      resetDB(db);
      console.log("[scan] DB reiniciada.");
    }

    if (flags.digest) {
      await writeDigestFromDB(db, dbPath, vaultPath);
      return;
    }

    const configuredGithubUser = Bun.env.GITHUB_USER?.trim();
    const githubToken = requiredEnv("GITHUB_TOKEN");
    const groqKey = Bun.env.GROQ_API_KEY?.trim() ?? "";
    const groqModel = optionalEnv("GROQ_MODEL", defaultModel);
    const staleDays = parseStaleDays();
    const analyzedIssues: AnalyzedIssue[] = [];
    const analyzedPRs: AnalyzedPR[] = [];
    const staleIssues: StaleIssue[] = [];

    if (requiresGroq(flags)) {
      const groqAvailable = await checkGroqAvailable();
      console.log(groqAvailable ? `[scan] Groq disponible (${groqModel}).` : `[scan] Groq no disponible (${groqModel}).`);

      if (!groqAvailable || !groqKey) {
        console.error("[scan] No se puede continuar sin Groq disponible.");
        process.exitCode = 1;
        return;
      }
    }

    const githubUser = await getAuthenticatedUser(githubToken);

    if (configuredGithubUser && configuredGithubUser.toLowerCase() !== githubUser.login.toLowerCase()) {
      console.warn(
        `[scan] GITHUB_USER=${configuredGithubUser}, pero el token pertenece a ${githubUser.login}. Se usarán los repos del token.`
      );
    }

    console.log(`[scan] GitHub autenticado como ${githubUser.login}.`);

    const repos = await resolveRepos(githubToken, flags);
    console.log(`[scan] Repos encontrados: ${repos.length}`);

    if (flags.audit) {
      await runAudit(repos, githubToken, staleDays, vaultPath);
      return;
    }

    if (flags.mergeDeps) {
      const mergeablePRs = await collectMergeablePRs(repos, githubToken);
      const summary = await runMergeDeps(db, mergeablePRs, githubToken, false);
      console.log(`\nResumen --merge-deps: ${summary.done}/${summary.total} PRs mergeados, errores: ${summary.errors}`);
      return;
    }

    if (flags.pushWorkflows) {
      await runPushWorkflowsOnly(db, repos, githubToken);
      return;
    }

    if (flags.apply) {
      await runApply(db, repos, githubToken, staleDays, vaultPath);
      return;
    }

    if (shouldScanIssues(flags)) {
      for (const repo of repos) {
        console.log(`[scan] Revisando issues en ${repo.full_name}...`);

        try {
          const issues = await getOpenIssues(repo.full_name, githubToken);
          const newIssues = issues.filter((issue) => isNew(db, repo.full_name, issue.number));

          if (newIssues.length === 0) {
            console.log("[scan]   Sin issues nuevas.");
            continue;
          }

          for (const issue of newIssues) {
            console.log(`[scan]   Nueva issue #${issue.number} — ${issue.title}`);
            const analysis = await analyzeIssue(issue.title, issue.body, repo.full_name);

            markSeen(db, repo.full_name, issue.number, issue.title, analysis.type, analysis.risk);
            analyzedIssues.push({
              repo: repo.full_name,
              issue,
              analysis
            });

            console.log(`[scan]   Analizada: tipo=${analysis.type} riesgo=${analysis.risk}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[scan]   Error revisando issues en ${repo.full_name}: ${message}`);
        }
      }
    }

    if (shouldScanPRs(flags)) {
      for (const repo of repos) {
        console.log(`[scan] Revisando PRs en ${repo.full_name}...`);

        try {
          const prs = await getOpenPRs(repo.full_name, githubToken);
          const newPRs = prs.filter((pr) => isPRNew(db, repo.full_name, pr.number));

          if (newPRs.length === 0) {
            console.log("[scan]   Sin PRs nuevos.");
            continue;
          }

          for (const pr of newPRs) {
            console.log(`[scan]   Nuevo PR #${pr.number} — ${pr.title}`);
            const analysis = await analyzePR(pr.title, pr.body, repo.full_name, pr);

            markPRSeen(db, repo.full_name, pr.number, pr.title, analysis.risk);
            analyzedPRs.push({
              repo: repo.full_name,
              pr,
              analysis
            });

            console.log(`[scan]   Analizado: riesgo=${analysis.risk}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[scan]   Error revisando PRs en ${repo.full_name}: ${message}`);
        }
      }
    }

    if (shouldScanStale(flags)) {
      const now = new Date();

      for (const repo of repos) {
        console.log(`[scan] Revisando stale en ${repo.full_name}...`);

        try {
          const stale = await getStaleIssues(repo.full_name, githubToken, staleDays);

          for (const issue of stale) {
            staleIssues.push({
              repo: repo.full_name,
              issue,
              daysSinceUpdate: daysSince(issue.updated_at, now)
            });
          }

          console.log(`[scan]   Issues stale: ${stale.length}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[scan]   Error revisando stale en ${repo.full_name}: ${message}`);
        }
      }
    }

    const generatedAt = new Date();
    const base = outputBase(generatedAt, vaultPath);
    const markdownPath = uniquePath(base, "md");
    const jsonPath = uniquePath(base, "json");
    const markdown = generateMarkdown(analyzedIssues, generatedAt, analyzedPRs, staleIssues);

    await writeObsidian(vaultPath, analyzedIssues, analyzedPRs, staleIssues, generatedAt);
    await writeReportFiles(
      markdownPath,
      jsonPath,
      markdown,
      generateJSON(analyzedIssues, analyzedPRs, staleIssues),
      vaultPath
    );

    if (flags.print) {
      console.log(`\n${markdown}`);
    }

    console.log(`\nReporte guardado en: ${markdownPath}`);
    console.log(`JSON guardado en: ${jsonPath}`);

    if (analyzedIssues.length === 0 && analyzedPRs.length === 0 && staleIssues.length === 0) {
      console.log("\nTodo al día. Sin novedades.");
      return;
    }

    console.log("\nResumen:");

    for (const { repo, issue, analysis } of analyzedIssues) {
      console.log(`  [${riskLabel(analysis.risk)}] ${repo}#${issue.number} — ${issue.title}`);
    }

    for (const { repo, pr, analysis } of analyzedPRs) {
      console.log(`  [PR ${riskLabel(analysis.risk)}] ${repo}#${pr.number} — ${pr.title}`);
    }

    if (staleIssues.length > 0) {
      console.log(`  [STALE] ${staleIssues.length} issues sin actividad por ${staleDays}+ días`);
    }
  } finally {
    closeDB(db);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
