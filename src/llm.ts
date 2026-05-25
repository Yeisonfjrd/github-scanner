export interface IssueAnalysis {
  summary: string;
  type: "bug" | "feature" | "docs" | "question" | "other";
  risk: "low" | "med" | "high";
  likely_files: string[];
  proposal: string;
}

const groqApiBaseUrl = "https://api.groq.com/openai/v1";
const defaultModel = "llama-3.1-8b-instant";
const fallbackMessage = "No se puede confirmar con la información disponible.";
const issueTypes = new Set<IssueAnalysis["type"]>(["bug", "feature", "docs", "question", "other"]);
const issueRisks = new Set<IssueAnalysis["risk"]>(["low", "med", "high"]);

const systemPrompt = `Eres un asistente técnico que analiza issues de GitHub.
Tu trabajo es leer una issue y extraer información estructurada.
Responde siempre en español. Sin emojis. Sin texto adicional fuera del JSON.

Reglas:
- Solo afirma lo que está explícitamente en la issue. No especules.
- Si algo no está claro en la issue, indícalo con "No se puede confirmar con la información disponible."
- El campo "proposal" debe ser una acción concreta, no una descripción.
- Si la issue no tiene suficiente contexto, dilo en "proposal" en lugar de inventar.`;

function groqToken(): string {
  return Bun.env.GROQ_API_KEY ?? "";
}

function groqModel(): string {
  return Bun.env.GROQ_MODEL || defaultModel;
}

function cleanJsonPayload(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function validType(value: unknown): IssueAnalysis["type"] {
  return typeof value === "string" && issueTypes.has(value as IssueAnalysis["type"])
    ? (value as IssueAnalysis["type"])
    : "other";
}

function validRisk(value: unknown): IssueAnalysis["risk"] {
  return typeof value === "string" && issueRisks.has(value as IssueAnalysis["risk"])
    ? (value as IssueAnalysis["risk"])
    : "low";
}

function validFiles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeAnalysis(value: unknown): IssueAnalysis {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};

  return {
    summary: nonEmptyString(source.summary, fallbackMessage),
    type: validType(source.type),
    risk: validRisk(source.risk),
    likely_files: validFiles(source.likely_files),
    proposal: nonEmptyString(source.proposal, fallbackMessage)
  };
}

export async function checkGroqAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${groqApiBaseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${groqToken()}`
      }
    });

    return response.status === 200;
  } catch {
    return false;
  }
}

export async function analyzeIssue(title: string, body: string | null, repo: string): Promise<IssueAnalysis> {
  const prompt = `Analiza esta issue del repositorio "${repo}":

TÍTULO: ${title}
DESCRIPCIÓN: ${body || "(sin descripción)"}

Responde SOLO con este JSON, sin texto adicional:
{
  "summary": "una sola oración que describe qué reporta esta issue",
  "type": "bug | feature | docs | question | other",
  "risk": "low | med | high",
  "likely_files": ["ruta/archivo.ts"],
  "proposal": "acción concreta a tomar"
}`;

  try {
    const response = await fetch(`${groqApiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqToken()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: groqModel(),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      return normalizeAnalysis(null);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(cleanJsonPayload(content));

    return normalizeAnalysis(parsed);
  } catch {
    return normalizeAnalysis(null);
  }
}
