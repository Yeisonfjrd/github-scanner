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
GITHUB_USER=tu_usuario
GROQ_API_KEY=tu_key
GROQ_MODEL=llama-3.1-8b-instant
SENTINEL_DB_PATH=data/sentinel.db
```

## Uso

```bash
bun scan
```

## Reportes

Los reportes se generan en:

```text
data/report-YYYY-MM-DD.md
data/report-YYYY-MM-DD.json
```
