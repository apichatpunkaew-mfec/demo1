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

const dynatrace = require('./services/dynatrace');
const ai = require('./services/ai');

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
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ----------------------------- helpers ----------------------------- */

function maskToken(t) {
  if (!t) return '(unset)';
  if (t.length < 12) return '***';
  return t.slice(0, 6) + '...' + t.slice(-4);
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
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

// AI: analyze a problem payload supplied in the request body
app.post('/api/analyze', asyncHandler(async (req, res) => {
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
app.get('/api/analyze/:problemId', asyncHandler(async (req, res) => {
  const problem = await dynatrace.getProblem(dtCfg, req.params.problemId);
  const override = req.query.model || '';
  const cfg = override ? { ...aiCfg, model: override } : aiCfg;
  const result = await ai.analyzeProblem(cfg, problem, {
    summaryOnly: req.query.summaryOnly === '1' || req.query.summaryOnly === 'true',
  });
  res.json({ problem, analysis: result });
}));
// AI: batch analyze (default: OPEN problems, first N). Parallel, bounded concurrency.
app.post('/api/analyze-all', asyncHandler(async (req, res) => {
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

/* ---------------------------- 404 + errors ----------------------- */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found', path: req.path });
  }
  res.status(404).send('Not found');
});

app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error('[error]', err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    detail: err.body || null,
  });
});

/* ----------------------------- boot ------------------------------ */

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log('Dynatrace AI Dashboard listening on http://' + HOST + ':' + PORT);
  console.log('  Dynatrace:', dtCfg.baseUrl || '(not configured)', 'token=', maskToken(dtCfg.token));
  console.log('  AI:       ', aiCfg.baseUrl || '(not configured)', 'model=', aiCfg.model || '(unset)');
  console.log('  tune:     analyze_concurrency=' + ANALYZE_CONCURRENCY +
              ' default_page_size=' + DEFAULT_PROBLEM_PAGE_SIZE);
});
