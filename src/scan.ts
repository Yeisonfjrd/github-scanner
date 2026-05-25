import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { closeDB, initDB, isNew, markSeen } from "./db";
import { getOpenIssues, getUserRepos } from "./github";
import { analyzeIssue, checkGroqAvailable } from "./llm";
import { generateJSON, generateMarkdown, type AnalyzedIssue } from "./report";

const defaultDbPath = "data/sentinel.db";
const defaultModel = "llama-3.1-8b-instant";

function requiredEnv(name: string): string {
  const value = Bun.env[name];

  if (!value?.trim()) {
    console.error(`[scan] Falta ${name}. Revisa tu archivo .env.`);
    process.exit(1);
  }

  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return Bun.env[name]?.trim() || fallback;
}

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function uniqueReportPath(extension: "md" | "json", generatedAt: Date): string {
  const base = join("data", `report-${dateStamp(generatedAt)}`);
  let path = `${base}.${extension}`;
  let counter = 2;

  while (existsSync(path)) {
    path = `${base}-${counter}.${extension}`;
    counter += 1;
  }

  return path;
}

function riskLabel(risk: string): string {
  return risk.toUpperCase();
}

async function main(): Promise<void> {
  const githubUser = requiredEnv("GITHUB_USER");
  const groqKey = requiredEnv("GROQ_API_KEY");
  const githubToken = Bun.env.GITHUB_TOKEN ?? "";
  const groqModel = optionalEnv("GROQ_MODEL", defaultModel);
  const dbPath = optionalEnv("SENTINEL_DB_PATH", defaultDbPath);

  mkdirSync("data", { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = initDB(dbPath);
  const analyzedIssues: AnalyzedIssue[] = [];

  try {
    const groqAvailable = await checkGroqAvailable();
    console.log(groqAvailable ? `[scan] Groq disponible (${groqModel}).` : `[scan] Groq no disponible (${groqModel}).`);

    if (!groqAvailable || !groqKey.trim()) {
      console.error("[scan] No se puede continuar sin Groq disponible.");
      process.exitCode = 1;
      return;
    }

    const repos = await getUserRepos(githubUser, githubToken);
    console.log(`[scan] Repos encontrados: ${repos.length}`);

    for (const repo of repos) {
      console.log(`[scan] Revisando ${repo.full_name}...`);

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
        console.error(`[scan]   Error revisando ${repo.full_name}: ${message}`);
      }
    }
  } finally {
    closeDB(db);
  }

  const generatedAt = new Date();
  const markdownPath = uniqueReportPath("md", generatedAt);
  const jsonPath = uniqueReportPath("json", generatedAt);

  await Bun.write(markdownPath, generateMarkdown(analyzedIssues, generatedAt));
  await Bun.write(jsonPath, generateJSON(analyzedIssues));

  console.log(`\nReporte guardado en: ${markdownPath}`);

  if (analyzedIssues.length === 0) {
    console.log("\nTodo al día. Sin issues nuevas.");
    return;
  }

  console.log("\nResumen:");

  for (const { repo, issue, analysis } of analyzedIssues) {
    console.log(`  [${riskLabel(analysis.risk)}] ${repo}#${issue.number} — ${issue.title}`);
  }
}

await main();
