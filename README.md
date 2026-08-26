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

For AI-assisted queries against Dynatrace (**traces, logs, metrics,
entities, DQL**), this repo ships a preconfigured **`.vscode/mcp.json`**
that registers the official `dynatrace-mcp-server`. Authentication uses
**OAuth client-credentials** (the secret is prompted once and stored in
the VS Code keychain — never written to a tracked file).

See **[`MCP_SETUP.md`](MCP_SETUP.md)** for the full guide, including the
known scope limitation (`read:problems` is not granted to this OAuth
client, so the `get-problems` MCP tool returns 400).

Quick start:

```powershell
code C:\Users\User\Desktop\app\demo1\demo1-1
# VS Code prompts for the OAuth client secret once; Copilot Chat then has:
#   - "What was the slowest trace in the last hour?"
#   - "Run this DQL: fetch logs, from:now()-1h | filter status=\"error\""
```

---

## Security notes

- `.env` is in `.gitignore`. **Never commit API tokens.**
- The server is intended to run inside a trusted network. If you expose it publicly, add auth (the API key in the `Authorization` header is the simplest bearer-token gate) and switch to HTTPS.
- Tokens are masked in `/api/health` so you can safely share that endpoint for diagnostics.

---

## Performance & caching

The server caches upstream responses and reuses TLS connections to minimize latency:

| Layer | What | TTL | Notes |
|---|---|---|---|
| `services/cache.js` | In-memory cache for `/api/problems` | **10 s** | Coalesces concurrent misses so the user never pays twice for the same refresh |
| `services/cache.js` | In-memory cache for `/api/models` | **60 s** | |
| `https.Agent({ keepAlive: true })` | TLS connection pool for Dynatrace + LiteLLM | persistent | `maxSockets: 16`, `freeSocketTimeout: 30s` |
| `mapWithConcurrency(3)` | Bounded parallelism in `/api/analyze-all` | per-request | Default concurrency = 3 (configurable) |
| `Cache-Control` headers | Browser-side cache | 5 s | |
| `DEFAULT_PROBLEM_PAGE_SIZE=10` | Lighter Dynatrace response | — | Default 20 → 10 |
| Per-call LLM timeout (45 s) | Defends against slow models | — | |

### Measured improvements

Wall-clock timings (single Windows machine, localhost server):

| Endpoint | Before | After | Speedup |
|---|---|---|---|
| `GET /api/problems` (cold MISS) | 2 637 ms | 400–700 ms | ~5× (TLS reuse kicks in on burst) |
| `GET /api/problems` (warm HIT) | 2 637 ms | **5–13 ms** | **~300×** |
| `GET /api/models` (warm HIT) | 50 ms | **5 ms** | ~10× |
| `POST /api/analyze-all` (3 problems) | 221 s (sequential) | **5.3 s** (parallel) | **~40×** |

Confirmed in Dynatrace traces (span durations from DQL):

```
cache.listProblems          11  cache.hit  318µs–671ms
cache.listModels             3  cache.hit  136µs–45ms
POST /api/analyze-all        2  -          5.3s (new) / 79.7s (old)
dynatrace.fetch api/v2/...   1  -          669ms    (one outbound per 10s window)
```

---

## Error handling & observability

Async route handlers run inside `asyncHandler` which catches rejections and forwards them to the Express error middleware **without crashing the process**:

| Failure mode | Before | After |
|---|---|---|
| Async throw from upstream (e.g. `fetch failed`) | process exit, no response | `HTTP 500` + structured log |
| `unhandledRejection` | process exit | caught, logged, process keeps serving |
| Spans marked on error | not marked | `span.recordException(err)` + `span.setStatus({ code: ERROR, message })` |
| Logs | plain `console.error` only | mirror to **stdout JSON** + **OTel Logs API** (severity 5/9/13/17, `trace_id`, `span_id`) |

### Verified against live Dynatrace (`waa41263.apps.dynatrace.com`)

Two error traces (`e1c382e3d5cc6d9f8870a1789ce12182`, `5bcf525da866639b7916f915e5599468`) ingested end-to-end:

```
service.name    : dynatrace-ai-dashboard-test
dt.entity.service: SERVICE-083B248710036AFA
span.name       : cache.listModels
span.status_code: error
span.status_message: fetch failed
span.events[0].exception.type  : TypeError
span.events[0].exception.message: fetch failed
span.events[0].exception.stack_trace: full undici stack
```

DQL to verify locally:

```dql
fetch spans, from: now() - 1h
| filter service.name == "dynatrace-ai-dashboard-test"
       and span.name == "cache.listModels"
| fields span.name, span.status_code, span.status_message, trace.id, span.events
```

---

## OpenTelemetry tracing

`tracing.js` boots an OTel SDK with the auto-instrumentations + Dynatrace OTLP exporter (protobuf):

```js
// exports to https://<tenant>.live.dynatrace.com/api/v2/otlp/v1/traces
// via @opentelemetry/exporter-trace-otlp-proto
```

Custom spans emitted by this app:

| Span | Source | Attributes |
|---|---|---|
| `cache.listProblems` | `services/dynatrace.js` | `cache.key`, `cache.hit` |
| `dynatrace.fetch <path>` | `services/dynatrace.js` | `http.method`, `http.url`, `http.status_code`, on error: `exception` |
| `cache.listModels` | `services/ai.js` | `cache.key`, `cache.hit` |
| `ai.chat` | `services/ai.js` | `ai.model`, `ai.usage.{prompt,completion,total}_tokens`, `http.status_code` |

Service name on Dynatrace side: `dynatrace-ai-dashboard`.

### Verifying ingest in Dynatrace DQL

```dql
fetch spans, from:now()-15m
| filter dt.service.name == "dynatrace-ai-dashboard"
| filter span.name == "cache.listProblems"
| fields timestamp, duration, cache.hit
| sort timestamp desc
```

The `_query_spans.py` helper is a thin wrapper around the Dynatrace DQL Query API for quick checks:

```powershell
$env:_CID   = '<client-id>'
$env:_SECRET = '<client-secret>'
$env:_RES    = '<account-urn>'
python _query_spans.py
```

### Why protobuf and not JSON?

`@opentelemetry/exporter-trace-otlp-http` hardcodes `Content-Type: application/json`. Dynatrace's OTLP endpoint intermittently rejects this with **HTTP 415 Unsupported Media Type**. `@opentelemetry/exporter-trace-otlp-proto` sends `application/x-protobuf` (the OTLP wire format) and is the supported exporter for Dynatrace.