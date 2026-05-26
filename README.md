# github-scanner

CLI local para revisar issues abiertas en repositorios propios de GitHub, analizar issues nuevas con Groq y generar reportes Markdown y JSON en `data/`.

## Requisitos

- Bun >= 1.3
- Cuenta y API key en https://console.groq.com/keys
- Token de GitHub con permisos `Issues: Read-only` y `Metadata: Read-only`

## Setup

```bash
bun install
cp .env.example .env
```

Completa `.env`:

```bash
GITHUB_TOKEN=tu_token
GITHUB_USER=tu_usuario # opcional; se usa para advertir si el token es de otra cuenta
GROQ_API_KEY=tu_key
GROQ_MODEL=llama-3.1-8b-instant
SENTINEL_DB_PATH=data/sentinel.db
OBSIDIAN_VAULT_PATH=/ruta/a/tu/vault
STALE_DAYS=30
```

El scanner valida `GITHUB_TOKEN` contra la API de GitHub y revisa los repositorios propios de la cuenta autenticada, incluidos repos privados visibles para el token.

## Comandos

| Comando              | Descripción                                      |
|----------------------|--------------------------------------------------|
| `bun scan`           | Escaneo completo: issues + PRs + stale           |
| `bun scan --reset`   | Borra la DB y re-analiza todo desde cero         |
| `bun scan --prs`     | Solo PRs abiertos                                |
| `bun scan --stale`   | Solo issues sin actividad                        |
| `bun scan --digest`  | Digest semanal desde la DB, sin llamadas externas|
| `bun scan --print`   | Muestra el reporte en terminal además de guardarlo|
| `bun scan --repo X`  | Escanea solo el repo especificado                |

## Reportes

Los reportes se generan en `data/` si `OBSIDIAN_VAULT_PATH` está vacío.
Si `OBSIDIAN_VAULT_PATH` está definido, se escriben en el vault bajo `github-scanner/`.

```text
data/report-YYYY-MM-DD.md
data/report-YYYY-MM-DD.json
```

## Integración con Obsidian

Si defines `OBSIDIAN_VAULT_PATH` en `.env`, cada scan escribe notas
individuales en tu vault con frontmatter compatible con Dataview.

Ejemplo de query Dataview para ver issues de riesgo alto:

```dataview
TABLE repo, issue_type, created FROM "github-scanner/repos"
WHERE type = "issue" AND risk = "high"
SORT created DESC
```

Ejemplo para ver PRs abiertos:

```dataview
TABLE repo, changed_files, risk FROM "github-scanner/repos"
WHERE type = "pr"
SORT risk DESC
```
