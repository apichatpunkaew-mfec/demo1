'use strict';

// Bootstrap OpenTelemetry BEFORE any other require. tracing.js loads .env
// for us and registers instrumentations for express / undici / http.
require('./tracing');

/**
 * Dynatrace AI Dashboard
 * -----------------------
 * Express server that:
 *   - serves the static UI in /public
 *   - exposes a small JSON API around the Dynatrace Problems v2 endpoint
 *     and the LiteLLM-compatible chat endpoint configured in .env
 *
 * Performance features:
 *   - In-memory TTL cache on problems + models (services/cache.js,
 *     services/dynatrace.js, services/ai.js)
 *   - Reused TLS connections to Dynatrace + OpenAI-compatible gateway
 *   - Parallel LLM calls in /api/analyze-all with bounded concurrency
 *   - Cache-Control headers on GETs so the browser/proxy can cache too
 */

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const dynatrace = require('./services/dynatrace');
const ai = require('./services/ai');
const chat = require('./services/chat');
const log = require('./services/logger');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Performance tunables
const ANALYZE_CONCURRENCY = Math.max(1, parseInt(process.env.ANALYZE_CONCURRENCY || '3', 10));
const DEFAULT_PROBLEM_PAGE_SIZE = parseInt(process.env.DEFAULT_PROBLEM_PAGE_SIZE || '10', 10);
const PROBLEMS_CACHE_MAX_AGE = 10;     // seconds - browser-side cache
const PROBLEMS_SWR = 30;               // stale-while-revalidate seconds
const MODELS_CACHE_MAX_AGE = 60;

const dtCfg = {
  baseUrl: process.env.DYNATRACE_BASE_URL || '',
  token: process.env.DYNATRACE_API_TOKEN || '',
};

const aiCfg = {
  baseUrl: process.env.AI_BASE_URL || '',
  apiKey: process.env.AI_API_KEY || '',
  model: process.env.AI_MODEL || '',
};

const app = express();

// SECURITY: helmet sets sensible HTTP headers (HSTS, X-Content-Type-Options,
// X-Frame-Options, Referrer-Policy, etc.) to harden against common web attacks.
// CSP is left off because the static UI uses inline styles.
app.use(helmet({ contentSecurityPolicy: false }));

// SECURITY: Bound request size at the parser level (defense in depth —
// readMessage() also caps chat messages at 32 KiB).
app.use(express.json({ limit: '1mb' }));

// SECURITY: Per-IP rate limiter for AI endpoints. Each chat call hits the
// LiteLLM gateway ($$$) so we cap to prevent cost spikes + DoS.
//   chat endpoints: 30 req / min / IP
//   analyze endpoints: 20 req / min / IP
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many chat requests, slow down.' },
});
const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many analyze requests, slow down.' },
});

app.use(express.static(path.join(__dirname, 'public')));

/* ----------------------------- helpers ----------------------------- */

function maskToken(t) {
  if (!t) return '(unset)';
  if (t.length < 12) return '***';
  return t.slice(0, 6) + '...' + t.slice(-4);
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
    // Try to attach the exception to the active OTel span (if any) before
    // handing off to Express's error middleware. Express auto-instrumentation
    // closes the request span only after `next(err)` is invoked, so this
    // still attributes the error to the request span.
    try {
      // eslint-disable-next-line global-require
      const { trace, SpanStatusCode } = require('@opentelemetry/api');
      const span = trace.getActiveSpan();
      if (span) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      }
    } catch { /* OTel not loaded - ignore */ }
    next(err);
  });
}

function summarizeProblems(payload) {
  const problems = payload.problems || [];
  const bySeverity = {};
  const byStatus = {};
  let open = 0;
  for (const p of problems) {
    bySeverity[p.severityLevel] = (bySeverity[p.severityLevel] || 0) + 1;
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    if (p.status === 'OPEN') open++;
  }
  return {
    total: problems.length,
    open,
    bySeverity,
    byStatus,
    pageSize: payload.pageSize,
    nextPageKey: payload.nextPageKey,
    warnings: payload.warnings || [],
  };
}

/**
 * Bounded-concurrency runner. Like Promise.all but never more than `limit`
 * tasks in flight at once. Preserves the input order in the result array.
 */
async function mapWithConcurrency(items, limit, mapper) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await mapper(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

/* ------------------------------ API ------------------------------- */

// SECURITY: Input validation helpers for /api/chat/* endpoints.
// Without these, an attacker can DoS the in-memory session Map by sending
// huge payloads or unbounded sessionIds.
function readSessionId(req, res) {
  const sid = req.body && req.body.sessionId;
  if (!sid || typeof sid !== 'string') {
    res.status(400).json({ error: 'sessionId required' });
    return null;
  }
  // Cap length to prevent unbounded Map keys + JSON overhead.
  if (sid.length > 128) {
    res.status(400).json({ error: 'sessionId too long (max 128 chars)' });
    return null;
  }
  // UUID v4 shape OR 'sess-' prefix (for backward compat with old clients).
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sid)) {
    res.status(400).json({ error: 'sessionId has invalid characters' });
    return null;
  }
  return sid;
}

function readMessage(req, res) {
  const msg = req.body && req.body.message;
  if (!msg || typeof msg !== 'string' || !msg.trim()) {
    res.status(400).json({ error: 'message required' });
    return null;
  }
  // 32 KiB cap — well above any reasonable prompt but blocks obvious DoS.
  if (msg.length > 32 * 1024) {
    res.status(400).json({ error: 'message too long (max 32 KiB)' });
    return null;
  }
  return msg;
}

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    dynatrace: { configured: !!dtCfg.token, baseUrl: dtCfg.baseUrl, token: maskToken(dtCfg.token) },
    ai: { configured: !!aiCfg.apiKey, baseUrl: aiCfg.baseUrl, model: aiCfg.model, key: maskToken(aiCfg.apiKey) },
    time: new Date().toISOString(),
  });
});
// List problems
app.get('/api/problems', asyncHandler(async (req, res) => {
  const q = req.query;
  const opts = {
    status: q.status || process.env.DEFAULT_PROBLEM_STATUS || '',
    severityLevel: q.severity || process.env.DEFAULT_PROBLEM_SEVERITY || '',
    pageSize: parseInt(q.pageSize || process.env.DEFAULT_PROBLEM_PAGE_SIZE || DEFAULT_PROBLEM_PAGE_SIZE, 10),
    from: q.from || '',
    to: q.to || '',
    nextPageKey: q.nextPageKey || '',
  };
  Object.keys(opts).forEach((k) => { if (opts[k] === '' || opts[k] === undefined) delete opts[k]; });
  const data = await dynatrace.listProblems(dtCfg, opts);
  res.set('Cache-Control', 'private, max-age=' + PROBLEMS_CACHE_MAX_AGE + ', stale-while-revalidate=' + PROBLEMS_SWR);
  res.json({ ...data, summary: summarizeProblems(data) });
}));

// Get a single problem (with details + comments if available)
app.get('/api/problems/:problemId', asyncHandler(async (req, res) => {
  const data = await dynatrace.getProblem(dtCfg, req.params.problemId);
  res.set('Cache-Control', 'private, max-age=' + PROBLEMS_CACHE_MAX_AGE);
  res.json(data);
}));

// AI: list available models
app.get('/api/models', asyncHandler(async (_req, res) => {
  const data = await ai.listModels(aiCfg);
  res.set('Cache-Control', 'public, max-age=' + MODELS_CACHE_MAX_AGE);
  res.json(data);
}));

// Admin: per-model in-memory latency snapshot (rolling window).
// Populated by services/ai.js from each ai.chat span. Useful when Dynatrace
// is unavailable or for quick health checks; for full fidelity query Dynatrace.
app.get('/api/admin/latency', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    service: 'dynatrace-ai-dashboard',
    uptime_s: Math.round(process.uptime()),
    concurrency: ANALYZE_CONCURRENCY,
    page_size: DEFAULT_PROBLEM_PAGE_SIZE,
    ai_model_configured: aiCfg.model,
    latency_targets: ai.MODEL_LATENCY_TARGETS,
    models: ai.getMetrics(),
    timestamp: new Date().toISOString(),
  });
}));

// AI: analyze a problem payload supplied in the request body
app.post('/api/analyze', analyzeLimiter, asyncHandler(async (req, res) => {
  const problem = req.body && req.body.problem;
  if (!problem || typeof problem !== 'object') {
    return res.status(400).json({ error: 'Body must include { problem: {...} }' });
  }
  const override = (req.body && req.body.model) || '';
  const cfg = override ? { ...aiCfg, model: override } : aiCfg;
  const result = await ai.analyzeProblem(cfg, problem, {
    summaryOnly: !!(req.body && req.body.summaryOnly),
    temperature: req.body && req.body.temperature,
    maxTokens: req.body && req.body.maxTokens,
    timeoutMs: req.body && req.body.timeoutMs,
  });
  res.json(result);
}));

// AI: fetch + analyze a single problem by id
app.get('/api/analyze/:problemId', analyzeLimiter, asyncHandler(async (req, res) => {
  const problem = await dynatrace.getProblem(dtCfg, req.params.problemId);
  const override = req.query.model || '';
  const cfg = override ? { ...aiCfg, model: override } : aiCfg;
  const result = await ai.analyzeProblem(cfg, problem, {
    summaryOnly: req.query.summaryOnly === '1' || req.query.summaryOnly === 'true',
  });
  res.json({ problem, analysis: result });
}));
// AI: batch analyze (default: OPEN problems, first N). Parallel, bounded concurrency.
app.post('/api/analyze-all', analyzeLimiter, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const limit = Math.min(parseInt(body.limit != null ? body.limit : '5', 10), 25);
  const status = body.status || 'OPEN';
  const pageSize = Math.max(limit, 5);
  const list = await dynatrace.listProblems(dtCfg, { status, pageSize });
  const problems = (list.problems || []).slice(0, limit);

  const override = body.model || '';
  const cfg = override ? { ...aiCfg, model: override } : aiCfg;

  const results = await mapWithConcurrency(problems, ANALYZE_CONCURRENCY, async (p) => {
    try {
      const r = await ai.analyzeProblem(cfg, p, { temperature: 0.2, timeoutMs: 45000 });
      return { ok: true, problem: p, analysis: r };
    } catch (e) {
      return { ok: false, problem: p, error: e.message };
    }
  });

  res.json({ count: results.length, results });
}));

/* ---------------------------- chat with bot ---------------------- */

/**
 * Bind a session to a Dynatrace problem so subsequent /api/chat calls in the
 * same session answer questions about that specific incident.
 * Body: { sessionId, problemId }
 */
app.post('/api/chat/attach-problem', chatLimiter, asyncHandler(async (req, res) => {
  const sessionId = readSessionId(req, res);
  if (sessionId === null) return;
  const { problemId } = req.body || {};
  if (!problemId || typeof problemId !== 'string') {
    return res.status(400).json({ error: 'problemId required' });
  }
  if (problemId.length > 128) {
    return res.status(400).json({ error: 'problemId too long (max 128 chars)' });
  }
  const problem = await dynatrace.getProblem(dtCfg, problemId);
  chat.setProblemContext(sessionId, problem);
  res.json({ sessionId, problemId: problem.problemId || problemId, title: problem.title });
}));

/**
 * Detach the current problem context (start a fresh conversation).
 */
app.post('/api/chat/clear', chatLimiter, asyncHandler(async (req, res) => {
  const sessionId = readSessionId(req, res);
  if (sessionId === null) return;
  chat.clear(sessionId);
  res.json({ sessionId, cleared: true });
}));

/**
 * Send a chat message, get the full reply (non-streaming).
 * Body: { sessionId, message, model?, temperature?, maxTokens? }
 */
app.post('/api/chat', chatLimiter, asyncHandler(async (req, res) => {
  const sessionId = readSessionId(req, res);
  if (sessionId === null) return;
  const message = readMessage(req, res);
  if (message === null) return;
  const { model, temperature, maxTokens } = req.body || {};

  const cfg = model ? { ...aiCfg, model } : aiCfg;
  const messages = chat.buildMessages(sessionId, message.trim());
  const startMs = Date.now();
  const reply = await ai.chatCompletion(cfg, messages, {
    json: false,
    temperature: typeof temperature === 'number' ? temperature : 0.5,
    maxTokens,
    timeoutMs: 60000,
  });
  const content = (reply.choices && reply.choices[0] && reply.choices[0].message && reply.choices[0].message.content) || '';
  chat.recordTurn(sessionId, message.trim(), content);
  res.json({
    sessionId,
    model: reply.model,
    reply: content,
    usage: reply.usage || null,
    duration_ms: Date.now() - startMs,
  });
}));

/**
 * Streaming chat via Server-Sent Events.
 * Body: { sessionId, message, model?, temperature?, maxTokens? }
 * SSE events:
 *   event: chunk    data: {"delta":"..."}
 *   event: done     data: {"reply":"...","model":"...","usage":{...}}
 *   event: error    data: {"error":"..."}
 */
app.post('/api/chat/stream', chatLimiter, asyncHandler(async (req, res) => {
  const sessionId = readSessionId(req, res);
  if (sessionId === null) return;
  const message = readMessage(req, res);
  if (message === null) return;
  const { model, temperature, maxTokens } = req.body || {};

  // SSE headers
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering
  });
  res.flushHeaders && res.flushHeaders();

  // Send a comment immediately so the browser's EventSource fires onopen
  res.write(`: chat stream open\n\n`);

  const cfg = model ? { ...aiCfg, model } : aiCfg;
  let messages;
  try {
    messages = chat.buildMessages(sessionId, message.trim());
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
    return;
  }

  // Abort if the client disconnects mid-stream.
  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const iterator = await ai.streamChatCompletion(cfg, messages, {
      temperature: typeof temperature === 'number' ? temperature : 0.5,
      maxTokens,
      timeoutMs: 90000,
    });

    let full = '';
    for await (const delta of iterator) {
      if (aborted) break;
      full += delta;
      res.write(`event: chunk\ndata: ${JSON.stringify({ delta })}\n\n`);
    }
    if (!aborted) {
      chat.recordTurn(sessionId, message.trim(), full);
      res.write(`event: done\ndata: ${JSON.stringify({
        sessionId,
        reply: full,
        model: iterator.model,
      })}\n\n`);
    }
  } catch (e) {
    if (!aborted) {
      res.write(`event: error\ndata: ${JSON.stringify({
        error: e.message,
        code: e.code || null,
        status: e.status || null,
      })}\n\n`);
    }
  } finally {
    if (!aborted) res.end();
  }
}));

/**
 * Inspect chat session stats (for /api/admin/latency-style debugging).
 */
app.get('/api/admin/chat', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(chat.getStats());
});

/* ---------------------------- 404 + errors ----------------------- */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found', path: req.path });
  }
  res.status(404).send('Not found');
});

app.use((err, _req, res, _next) => {
  // Mark the active span as ERROR so Dynatrace can pivot logs <-> traces,
  // emit a structured log line, then return a JSON response.
  // eslint-disable-next-line global-require
  const { trace, SpanStatusCode } = require('@opentelemetry/api');
  const span = trace.getActiveSpan();
  if (span) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  }
  log.error('http.error', {
    path: _req.path,
    method: _req.method,
    status: err.status || 500,
  }, err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    detail: err.body || null,
  });
});

/* ----------------------------- boot ------------------------------ */

// Last-resort safety net: log instead of crashing on stray rejections.
// Node 22 treats any unhandled rejection as fatal by default; we prefer a
// structured log line so a tail-latency bug doesn't take down the dashboard.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  // eslint-disable-next-line global-require
  const { trace, SpanStatusCode } = require('@opentelemetry/api');
  const span = trace.getActiveSpan();
  if (span) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  }
  log.error('process.unhandledRejection', {}, err);
});

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log('Dynatrace AI Dashboard listening on http://' + HOST + ':' + PORT);
  console.log('  Dynatrace:', dtCfg.baseUrl || '(not configured)', 'token=', maskToken(dtCfg.token));
  console.log('  AI:       ', aiCfg.baseUrl || '(not configured)', 'model=', aiCfg.model || '(unset)');
  console.log('  tune:     analyze_concurrency=' + ANALYZE_CONCURRENCY +
              ' default_page_size=' + DEFAULT_PROBLEM_PAGE_SIZE);
});
