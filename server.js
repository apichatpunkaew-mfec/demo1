'use strict';

/**
 * Dynatrace AI Dashboard
 * -----------------------
 * Express server that:
 *   - serves the static UI in /public
 *   - exposes a small JSON API around the Dynatrace Problems v2 endpoint
 *     and the LiteLLM-compatible chat endpoint configured in .env
 */

require('dotenv').config();

const path = require('path');
const express = require('express');

const dynatrace = require('./services/dynatrace');
const ai = require('./services/ai');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

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
    pageSize: parseInt(q.pageSize || process.env.DEFAULT_PROBLEM_PAGE_SIZE || '20', 10),
    from: q.from || '',
    to: q.to || '',
    nextPageKey: q.nextPageKey || '',
  };
  Object.keys(opts).forEach((k) => { if (opts[k] === '' || opts[k] === undefined) delete opts[k]; });
  const data = await dynatrace.listProblems(dtCfg, opts);
  res.json({ ...data, summary: summarizeProblems(data) });
}));

// Get a single problem (with details + comments if available)
app.get('/api/problems/:problemId', asyncHandler(async (req, res) => {
  const data = await dynatrace.getProblem(dtCfg, req.params.problemId);
  res.json(data);
}));

// AI: list available models
app.get('/api/models', asyncHandler(async (_req, res) => {
  const data = await ai.listModels(aiCfg);
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

// AI: batch analyze (default: OPEN problems, first N)
app.post('/api/analyze-all', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const limit = Math.min(parseInt(body.limit != null ? body.limit : '5', 10), 25);
  const status = body.status || 'OPEN';
  const pageSize = Math.max(limit, 5);
  const list = await dynatrace.listProblems(dtCfg, { status, pageSize });
  const problems = (list.problems || []).slice(0, limit);

  const override = body.model || '';
  const cfg = override ? { ...aiCfg, model: override } : aiCfg;

  const results = [];
  for (const p of problems) {
    try {
      const r = await ai.analyzeProblem(cfg, p, { temperature: 0.2 });
      results.push({ ok: true, problem: p, analysis: r });
    } catch (e) {
      results.push({ ok: false, problem: p, error: e.message });
    }
  }

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
});