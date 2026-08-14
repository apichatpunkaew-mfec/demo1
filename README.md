# Dynatrace + AI Dashboard

A small Node.js + Express web app that:

1. Pulls **Dynatrace problems** (REST API v2) from `https://waa41263.live.dynatrace.com`.
2. Sends them to a **LiteLLM-compatible chat endpoint** (`https://gpt.mfec.co.th/litellm`) for analysis (root cause, impact, recommended actions, runbooks).
3. Shows the results in a clean, dark-mode dashboard.

No bundler, no build step, no framework. Just Express + native `fetch` + vanilla DOM.

---

## Project structure

```
demo1-1/
├── package.json
├── .env                    # Dynatrace + AI tokens (DO NOT COMMIT)
├── .gitignore
├── server.js               # Express server + JSON API
├── services/
│   ├── dynatrace.js        # Dynatrace Problems v2 client
│   ├── ai.js               # LiteLLM / OpenAI-compatible chat client
│   └── problemAnalysis.js  # Prompts + JSON parsing for problem analysis
└── public/
    ├── index.html
    ├── styles.css
    └── app.js              # Frontend (no framework)
```

---

## Setup

### 1. Requirements
- **Node.js ≥ 18** (uses native `fetch`).
- A Dynatrace API token with the `problems.read` scope.
- An AI API key for an OpenAI-compatible chat endpoint.

### 2. Install
```bash
npm install
```

### 3. Configure
Edit `.env` (or use shell env vars):

| Variable | Description | Example |
|---|---|---|
| `DYNATRACE_BASE_URL` | Dynatrace tenant URL (no trailing slash) | `https://waa41263.live.dynatrace.com` |
| `DYNATRACE_API_TOKEN` | Dynatrace API token (header value only) | `dt0c01....` |
| `AI_BASE_URL` | LiteLLM / OpenAI-compatible base URL (no trailing slash) | `https://gpt.mfec.co.th/litellm` |
| `AI_API_KEY` | Bearer token for the AI endpoint | `sk-...` |
| `AI_MODEL` | Default model id | `gpt-5-mini` |
| `PORT` / `HOST` | HTTP server config | `3000` / `0.0.0.0` |
| `DEFAULT_PROBLEM_STATUS` | Default filter (`OPEN`, `CLOSED`, or empty) | `OPEN` |
| `DEFAULT_PROBLEM_SEVERITY` | Optional default severity filter | empty |
| `DEFAULT_PROBLEM_PAGE_SIZE` | Default page size | `20` |

### 4. Run
```bash
npm start
```

Visit:
- Dashboard: **http://localhost:3000**
- Health JSON: **http://localhost:3000/api/health**

---

## HTTP API

All endpoints return JSON unless noted.

| Method | Path | Description |
|---|---|---|
| `GET`  | `/api/health` | Shows whether tokens and endpoints are configured (tokens are masked). |
| `GET`  | `/api/problems?status=OPEN&severity=ERROR&pageSize=20` | List problems (Dynatrace v2). Adds a `summary` block. |
| `GET`  | `/api/problems/:problemId` | One problem with full details. |
| `GET`  | `/api/models` | List models exposed by the AI endpoint. |
| `POST` | `/api/analyze` | Body: `{ "problem": {...}, "model"?: "...", "summaryOnly"?: bool }`. Returns parsed analysis JSON. |
| `GET`  | `/api/analyze/:problemId?model=...&summaryOnly=1` | Fetch the problem then analyze it. Returns `{ problem, analysis }`. |
| `POST` | `/api/analyze-all` | Body: `{ "limit": 5, "status": "OPEN", "model"?: "..." }`. Sequential analysis loop. |

`/api/analyze` expects the AI to return strict JSON shaped like:
```json
{
  "summary": "...",
  "likelyRootCause": "...",
  "severity": "HIGH",
  "impact": "...",
  "recommendedActions": ["..."],
  "runbooks": ["..."],
  "confidence": 0.82
}
```
If the model wraps it in fences or returns prose, the server falls back to returning the raw output (frontend still shows it).

---

## UI features

- **Health banner** showing whether Dynatrace and AI are configured.
- **Filter row** for status / severity / page size.
- **Summary cards** with totals and a per-severity breakdown.
- **Problems table** with badges for severity and status.
- **Modal** that opens either the full problem payload, or the AI analysis, with sections for:
  - Summary
  - Likely root cause
  - Impact
  - Severity assessment (with confidence %)
  - Recommended actions (ordered list)
  - Runbook / checklist (ordered list)
- **“🤖 Analyze”** button per row, plus **“Analyze all (open)”** to batch-process.

You can switch the model at runtime in the top-right **Model** dropdown — values come from `GET /api/models`.

---

## Tested endpoints

I verified connectivity against the supplied credentials:

- **Dynatrace:** `GET /api/v2/problems?pageSize=3` → HTTP 200, 17 total problems, sample includes
  `P-2608515 “Monitoring not available”`, `P-2608514 “High CPU throttling”`, `P-2608513 “No pod ready”`.

- **AI:** `GET /v1/models` → 17 models available (`gpt-5-mini`, `claude-sonnet-5`, `gemini-3-flash`, `glm-5`, etc.).
  `POST /v1/chat/completions` with `gpt-5-mini` returns an OpenAI-compatible response.

If you see the model picker empty in the UI, hit `/api/health` to confirm the AI section is `configured`.

---

## Troubleshooting

- **401 from Dynatrace** → the API token is wrong or missing scopes; in Dynatrace, *Access tokens → Generate token* with `problems.read` and `entities.read`.
- **403/400 from AI** → verify `AI_BASE_URL` (no trailing slash) and that `AI_MODEL` exists in `GET /v1/models`.
- **Modal shows raw text, not parsed JSON** → the model returned prose instead of JSON. Try a different model or set a stronger system prompt via a custom wrapper.
- **Slow batch analysis** → reduce the `limit` in `/api/analyze-all` or switch to a faster model.

---

## Dynatrace MCP Server (VS Code / Copilot)

For AI-assisted queries against Dynatrace (problems, logs, metrics,
**traces**, entities, DQL), this repo ships a preconfigured
**`.vscode/mcp.json`** that registers the official `dynatrace-mcp-server`.
See **[`MCP_SETUP.md`](MCP_SETUP.md)** for the full guide.

Quick start:

```powershell
code C:\Users\User\Desktop\app\demo1\demo1-1   # opens VS Code with MCP config
# VS Code prompts for a Platform Token once; Copilot Chat then has:
#   - "List open problems"
#   - "What was the slowest trace in the last hour?"
#   - "Run this DQL: fetch logs, from:now()-1h | filter status=\"error\""
```

> Note: the MCP server uses **Platform APIs** (`*.apps.dynatrace.com`) and
> therefore requires a **Platform Token (Bearer JWT)**, not the classic
> Api-Token that the dashboard app uses.

---

## Security notes

- `.env` is in `.gitignore`. **Never commit API tokens.**
- The server is intended to run inside a trusted network. If you expose it publicly, add auth (the API key in the `Authorization` header is the simplest bearer-token gate) and switch to HTTPS.
- Tokens are masked in `/api/health` so you can safely share that endpoint for diagnostics.