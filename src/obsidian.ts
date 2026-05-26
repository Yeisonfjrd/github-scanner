import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AnalyzedIssue, AnalyzedPR, StaleIssue } from "./report";

const rootDir = "github-scanner";

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function riskLabel(risk: string): string {
  return risk === "high" ? "Alto" : risk === "med" ? "Medio" : "Bajo";
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function repoParts(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  return {
    owner: owner || "unknown",
    name: name || "repo"
  };
}

function repoDir(vaultPath: string, repo: string): string {
  const { owner, name } = repoParts(repo);
  return join(vaultPath, rootDir, "repos", owner, name);
}

function repoLink(repo: string): string {
  const { owner, name } = repoParts(repo);
  return `[[${rootDir}/repos/${owner}/${name}/README|${repo}]]`;
}

function countMarkdownNotes(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }

  let count = 0;

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);

    if (entry.isDirectory()) {
      count += countMarkdownNotes(entryPath);
    } else if (entry.name.endsWith(".md") && entry.name !== "README.md") {
      count += 1;
    }
  }

  return count;
}

async function writeRepoIndex(vaultPath: string, repo: string): Promise<void> {
  const dir = repoDir(vaultPath, repo);
  ensureDir(dir);
  await Bun.write(join(dir, "README.md"), `# ${repo}

Notas generadas por github-scanner para este repositorio.
`);
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/g, "");

  return slug || "sin-titulo";
}

export async function writeIssueNote(vaultPath: string, item: AnalyzedIssue): Promise<void> {
  try {
    const dir = repoDir(vaultPath, item.repo);
    ensureDir(dir);
    await writeRepoIndex(vaultPath, item.repo);

    const files = item.analysis.likely_files.length > 0
      ? item.analysis.likely_files.map((file) => `- \`${file}\``).join("\n")
      : "- No se puede confirmar con la información disponible.";
    const path = join(dir, `issue-${item.issue.number}-${slugify(item.issue.title)}.md`);
    const content = `---
type: issue
repo: ${item.repo}
number: ${item.issue.number}
title: ${yamlString(item.issue.title)}
issue_type: ${item.analysis.type}
risk: ${item.analysis.risk}
created: ${item.issue.created_at.slice(0, 10)}
analyzed: ${dateStamp(new Date())}
tags:
  - github
  - ${item.analysis.type}
  - risk-${item.analysis.risk}
---

# Issue #${item.issue.number} — ${item.issue.title}

- **Repo:** ${repoLink(item.repo)}
- **Enlace:** ${item.issue.html_url}
- **Creada:** ${item.issue.created_at.slice(0, 10)}
- **Riesgo:** ${riskLabel(item.analysis.risk)}

## Resumen

${item.analysis.summary}

## Archivos probables

${files}

## Propuesta

${item.analysis.proposal}
`;

    await Bun.write(path, content);
  } catch (error) {
    console.error(`[obsidian] Error escribiendo issue: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writePRNote(vaultPath: string, item: AnalyzedPR): Promise<void> {
  try {
    const dir = repoDir(vaultPath, item.repo);
    ensureDir(dir);
    await writeRepoIndex(vaultPath, item.repo);

    const path = join(dir, `pr-${item.pr.number}-${slugify(item.pr.title)}.md`);
    const content = `---
type: pr
repo: ${item.repo}
number: ${item.pr.number}
title: ${yamlString(item.pr.title)}
risk: ${item.analysis.risk}
draft: ${item.pr.draft}
changed_files: ${item.pr.changed_files}
created: ${item.pr.created_at.slice(0, 10)}
analyzed: ${dateStamp(new Date())}
tags:
  - github
  - pr
  - risk-${item.analysis.risk}
---

# PR #${item.pr.number} — ${item.pr.title}

- **Repo:** ${repoLink(item.repo)}
- **Enlace:** ${item.pr.html_url}
- **Rama:** \`${item.pr.head_branch}\` → \`${item.pr.base_branch}\`
- **Cambios:** ${item.pr.changed_files} archivos (+${item.pr.additions} / -${item.pr.deletions})

## Resumen

${item.analysis.summary}

## Impacto probable

${item.analysis.likely_impact}

## Foco de revisión

${item.analysis.review_focus}
`;

    await Bun.write(path, content);
  } catch (error) {
    console.error(`[obsidian] Error escribiendo PR: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeStaleNote(vaultPath: string, stale: StaleIssue[], date: Date): Promise<void> {
  try {
    const dir = join(vaultPath, rootDir, "stale");
    ensureDir(dir);
    const items = stale.length === 0
      ? "No se encontraron issues stale."
      : stale.map(({ repo, issue, daysSinceUpdate }) => `### ${repo}#${issue.number} — ${issue.title}
- Enlace: ${issue.html_url}
- Última actividad: hace ${daysSinceUpdate} días
- Creada: ${issue.created_at.slice(0, 10)}

Sugerencia: revisar si sigue siendo relevante o cerrar como stale.`).join("\n\n---\n\n");

    await Bun.write(join(dir, `stale-${dateStamp(date)}.md`), `# Issues sin actividad — Stale
Generado: ${dateStamp(date)}

${items}
`);
  } catch (error) {
    console.error(`[obsidian] Error escribiendo stale: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isoWeek(date: Date): { year: number; week: number } {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((value.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);

  return { year: value.getUTCFullYear(), week };
}

export async function writeDigest(
  vaultPath: string,
  issues: AnalyzedIssue[],
  prs: AnalyzedPR[],
  stale: StaleIssue[],
  date: Date
): Promise<void> {
  try {
    const dir = join(vaultPath, rootDir, "digests");
    ensureDir(dir);
    const { year, week } = isoWeek(date);
    const repos = Array.from(new Set([
      ...issues.map((item) => item.repo),
      ...prs.map((item) => item.repo),
      ...stale.map((item) => item.repo)
    ])).sort();

    await Bun.write(join(dir, `digest-${year}-W${week}.md`), `# Digest GitHub Scanner
Generado: ${dateStamp(date)}

- Issues nuevas: ${issues.length}
- PRs abiertos analizados: ${prs.length}
- Issues stale: ${stale.length}

## Repos con actividad

${repos.length > 0 ? repos.map((repo) => `- ${repoLink(repo)}`).join("\n") : "Sin actividad registrada."}
`);
  } catch (error) {
    console.error(`[obsidian] Error escribiendo digest: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function updateVaultIndex(vaultPath: string, date: Date): Promise<void> {
  try {
    const dir = join(vaultPath, rootDir);
    ensureDir(dir);
    const reposDir = join(dir, "repos");
    const digestsDir = join(dir, "digests");
    const noteCount = countMarkdownNotes(reposDir);
    const digestFiles = existsSync(digestsDir)
      ? readdirSync(digestsDir).filter((file) => file.endsWith(".md")).sort().slice(-5).reverse()
      : [];

    await Bun.write(join(dir, "README.md"), `# GitHub Scanner

Último scan: ${dateStamp(date)}

- Notas: ${noteCount}
- Digests recientes: ${digestFiles.length}

## Digests recientes

${digestFiles.length > 0 ? digestFiles.map((file) => `- [[${rootDir}/digests/${file.replace(/\.md$/, "")}|${file}]]`).join("\n") : "Sin digests todavía."}
`);
  } catch (error) {
    console.error(`[obsidian] Error actualizando índice: ${error instanceof Error ? error.message : String(error)}`);
  }
}
