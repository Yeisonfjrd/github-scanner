import type { Issue } from "./github";
import type { IssueAnalysis } from "./llm";

export interface AnalyzedIssue {
  repo: string;
  issue: Issue;
  analysis: IssueAnalysis;
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

export function generateMarkdown(issues: AnalyzedIssue[], generatedAt: Date): string {
  if (issues.length === 0) {
    return `# Reporte GitHub Scanner
Generado: ${formatDate(generatedAt)}

No se encontraron issues nuevas desde el último scan.
`;
  }

  const grouped = groupByRepo(issues);
  const sections = Array.from(grouped.entries()).map(([repo, repoIssues]) => {
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
  });

  return `# Reporte GitHub Scanner
Generado: ${formatDate(generatedAt)}
Issues nuevas: ${issues.length}

---

${sections.join("\n\n---\n\n")}

---
`;
}

export function generateJSON(issues: AnalyzedIssue[]): string {
  return JSON.stringify(issues, null, 2);
}
