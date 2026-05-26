import type { Issue, PR } from "./github";
import type { IssueAnalysis, PRAnalysis } from "./llm";

export interface AnalyzedIssue {
  repo: string;
  issue: Issue;
  analysis: IssueAnalysis;
}

export interface AnalyzedPR {
  repo: string;
  pr: PR;
  analysis: PRAnalysis;
}

export interface StaleIssue {
  repo: string;
  issue: Issue;
  daysSinceUpdate: number;
}

const typeLabels: Record<IssueAnalysis["type"], string> = {
  bug: "Bug",
  feature: "Feature",
  docs: "Docs",
  question: "Question",
  other: "Other"
};

const riskLabels: Record<IssueAnalysis["risk"], string> = {
  low: "Bajo",
  med: "Medio",
  high: "Alto"
};

function formatDate(value: Date | string): string {
  return new Intl.DateTimeFormat("es", {
    dateStyle: "medium",
    timeStyle: value instanceof Date ? "short" : undefined
  }).format(value instanceof Date ? value : new Date(value));
}

function groupByRepo(issues: AnalyzedIssue[]): Map<string, AnalyzedIssue[]> {
  const grouped = new Map<string, AnalyzedIssue[]>();

  for (const issue of issues) {
    const current = grouped.get(issue.repo) ?? [];
    current.push(issue);
    grouped.set(issue.repo, current);
  }

  return grouped;
}

function groupPRsByRepo(prs: AnalyzedPR[]): Map<string, AnalyzedPR[]> {
  const grouped = new Map<string, AnalyzedPR[]>();

  for (const pr of prs) {
    const current = grouped.get(pr.repo) ?? [];
    current.push(pr);
    grouped.set(pr.repo, current);
  }

  return grouped;
}

function groupStaleByRepo(stale: StaleIssue[]): Map<string, StaleIssue[]> {
  const grouped = new Map<string, StaleIssue[]>();

  for (const issue of stale) {
    const current = grouped.get(issue.repo) ?? [];
    current.push(issue);
    grouped.set(issue.repo, current);
  }

  return grouped;
}

function generateIssuesSection(issues: AnalyzedIssue[]): string {
  if (issues.length === 0) {
    return "No se encontraron issues nuevas desde el último scan.";
  }

  const grouped = groupByRepo(issues);
  return Array.from(grouped.entries()).map(([repo, repoIssues]) => {
    const issueSections = repoIssues.map(({ issue, analysis }) => {
      const files = analysis.likely_files.length > 0 ? analysis.likely_files.join(", ") : "No se puede confirmar con la información disponible.";

      return `### #${issue.number} — ${issue.title}
- Enlace: ${issue.html_url}
- Creada: ${formatDate(issue.created_at)}
- Tipo: ${typeLabels[analysis.type]}
- Riesgo: ${riskLabels[analysis.risk]}

**Resumen:** ${analysis.summary}

**Archivos probables:** ${files}

**Propuesta:** ${analysis.proposal}`;
    });

    return `## ${repo}

${issueSections.join("\n\n---\n\n")}`;
  }).join("\n\n---\n\n");
}

export function generatePRMarkdown(prs: AnalyzedPR[], generatedAt: Date): string {
  if (prs.length === 0) {
    return `# Pull Requests abiertos
Generado: ${formatDate(generatedAt)}

No se encontraron PRs abiertos nuevos desde el último scan.
`;
  }

  const grouped = groupPRsByRepo(prs);
  const sections = Array.from(grouped.entries()).map(([repo, repoPRs]) => {
    const prSections = repoPRs.map(({ pr, analysis }) => {
      return `### PR #${pr.number} — ${pr.title}
- Enlace: ${pr.html_url}
- Rama: ${pr.head_branch} → ${pr.base_branch}
- Archivos cambiados: ${pr.changed_files} (+${pr.additions} / -${pr.deletions})
- Riesgo: ${riskLabels[analysis.risk]}
- Draft: ${pr.draft ? "Si" : "No"}

**Resumen:** ${analysis.summary}

**Impacto probable:** ${analysis.likely_impact}

**Foco de revisión:** ${analysis.review_focus}`;
    });

    return `## ${repo}

${prSections.join("\n\n---\n\n")}`;
  });

  return `# Pull Requests abiertos
Generado: ${formatDate(generatedAt)}
PRs abiertos: ${prs.length}

---

${sections.join("\n\n---\n\n")}
`;
}

export function generateStaleMarkdown(stale: StaleIssue[], generatedAt: Date): string {
  if (stale.length === 0) {
    return `# Issues sin actividad — Stale
Generado: ${formatDate(generatedAt)}

No se encontraron issues stale.
`;
  }

  const grouped = groupStaleByRepo(stale);
  const sections = Array.from(grouped.entries()).map(([repo, repoIssues]) => {
    const issueSections = repoIssues.map(({ issue, daysSinceUpdate }) => {
      return `### #${issue.number} — ${issue.title}
- Enlace: ${issue.html_url}
- Última actividad: hace ${daysSinceUpdate} días
- Creada: ${issue.created_at.slice(0, 10)}

Sugerencia: revisar si sigue siendo relevante o cerrar como stale.`;
    });

    return `## ${repo}

${issueSections.join("\n\n---\n\n")}`;
  });

  return `# Issues sin actividad — Stale
Generado: ${formatDate(generatedAt)}
Issues stale: ${stale.length}

---

${sections.join("\n\n---\n\n")}
`;
}

export function generateMarkdown(
  issues: AnalyzedIssue[],
  generatedAt: Date,
  prs: AnalyzedPR[] = [],
  stale: StaleIssue[] = []
): string {
  const prBody = generatePRMarkdown(prs, generatedAt)
    .replace(/^# Pull Requests abiertos\nGenerado: .+\n(?:PRs abiertos: \d+\n)?\n?---\n\n/s, "")
    .replace(/^# Pull Requests abiertos\nGenerado: .+\n\n/s, "")
    .trim();
  const staleBody = generateStaleMarkdown(stale, generatedAt)
    .replace(/^# Issues sin actividad — Stale\nGenerado: .+\n(?:Issues stale: \d+\n)?\n?---\n\n/s, "")
    .replace(/^# Issues sin actividad — Stale\nGenerado: .+\n\n/s, "")
    .trim();

  return `# Reporte GitHub Scanner
Generado: ${formatDate(generatedAt)}

## Issues nuevas (${issues.length})

${generateIssuesSection(issues)}

## Pull Requests abiertos (${prs.length})

${prBody}

## Issues sin actividad — Stale (${stale.length})

${staleBody}
`;
}

export function generateJSON(issues: AnalyzedIssue[], prs: AnalyzedPR[] = [], stale: StaleIssue[] = []): string {
  return JSON.stringify({ issues, prs, stale }, null, 2);
}
