'use strict';

/**
 * Tiny LiteLLM / OpenAI-compatible chat completion client.
 * Works with any endpoint that accepts:
 *   POST {baseUrl}/v1/chat/completions
 *   Authorization: Bearer <key>
 *   { model, messages, temperature, max_tokens, ... }
 */

const { trace, SpanStatusCode } = require('@opentelemetry/api');
const http = require('http');
const https = require('https');
const { cache } = require('./cache');
const log = require('./logger');

const tracer = trace.getTracer('ai-litellm', '1.0.0');
const DEFAULT_TIMEOUT_MS = 60000;
const problemAnalysis = require('./problemAnalysis');

// Reuse TLS connections to the LiteLLM gateway.
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, scheduling: 'lifo' });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });

/**
 * Latency targets and deprecation policy.
 * Populated from a one-off Dynatrace live-trace analysis (24h, waa41263.live.dynatrace.com):
 *   glm-5.2          19 calls   33.9s avg / 45s p95  -> slow
 *   minimax-m3       21 calls   12.8s avg / 15.5s p95
 *   claude-sonnet-5  39 calls    8.0s avg / 11.2s p95 -> production main
 *   gemini-2.5-flash 19 calls    7.1s avg /  9.6s p95 -> fastest
 * `perplexity` (74ms) is excluded because traces show zero token usage — likely mock.
 */
const MODEL_LATENCY_TARGETS = {
  'glm-5.2':          { maxMs: 40000, deprecate: true,  fallback: 'claude-sonnet-5' },
  'minimax-m3':       { maxMs: 20000, deprecate: false, fallback: 'claude-sonnet-5' },
  'claude-sonnet-5':  { maxMs: 15000, deprecate: false, fallback: 'gemini-2.5-flash' },
  'gemini-2.5-flash': { maxMs: 12000, deprecate: false, fallback: 'claude-sonnet-5' },
};

function pickFasterModel(requested, { allowDeprecation = true } = {}) {
  const target = MODEL_LATENCY_TARGETS[requested];
  if (target && target.deprecate && allowDeprecation && target.fallback) {
    log.warn('model.deprecated_routed', { from: requested, to: target.fallback });
    return target.fallback;
  }
  return requested;
}

/**
 * Ring buffer of recent model-call metrics (per-model).
 * Exposed via getMetrics() so /api/admin/latency can return them without querying Dynatrace.
 */
const METRICS_WINDOW = 200; // last N calls per model
const modelMetrics = new Map(); // model -> { samples: number[] (ms), errors: number, timeouts: number }

function recordMetric(model, durationMs, errorCode) {
  if (!modelMetrics.has(model)) {
    modelMetrics.set(model, { samples: [], errors: 0, timeouts: 0 });
  }
  const m = modelMetrics.get(model);
  m.samples.push(durationMs);
  if (m.samples.length > METRICS_WINDOW) m.samples.shift();
  if (errorCode) {
    m.errors += 1;
    if (errorCode === 'AI_TIMEOUT') m.timeouts += 1;
  }
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(samples) {
  if (!samples.length) return { count: 0, avg_ms: 0, p50_ms: 0, p95_ms: 0, max_ms: 0 };
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    count: samples.length,
    avg_ms: Math.round(sum / samples.length),
    p50_ms: Math.round(percentile(samples, 50)),
    p95_ms: Math.round(percentile(samples, 95)),
    max_ms: Math.round(Math.max(...samples)),
  };
}

function getMetrics() {
  const out = {};
  for (const [model, m] of modelMetrics.entries()) {
    out[model] = {
      ...summarize(m.samples),
      errors: m.errors,
      timeouts: m.timeouts,
      latency_target: MODEL_LATENCY_TARGETS[model] || null,
    };
  }
  return out;
}

async function listModels(cfg) {
  if (!cfg.baseUrl) {
    log.error('ai.config.missing', { field: 'AI_BASE_URL' });
    const err = new Error('AI_BASE_URL is not configured');
    err.code = 'CONFIG_MISSING';
    throw err;
  }
  const key = 'listModels:' + cfg.baseUrl;
  const TTL_MS = 60_000; // 60s — model list is essentially static

  return tracer.startActiveSpan('cache.listModels', async (span) => {
    span.setAttribute('cache.key', key);
    try {
      const { value, hit } = await cache.getOrLoad(key, TTL_MS, async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
        const url = new URL('v1/models', cfg.baseUrl.endsWith('/') ? cfg.baseUrl : cfg.baseUrl + '/').toString();
        try {
          const res = await fetch(url, {
            method: 'GET',
            agent: url.startsWith('https') ? httpsAgent : httpAgent,
            headers: {
              Authorization: `Bearer ${cfg.apiKey}`,
              Accept: 'application/json',
            },
            signal: controller.signal,
          });
          const text = await res.text();
          if (!res.ok) {
            const err = new Error(`AI /models ${res.status}: ${text}`);
            err.status = res.status;
            span.recordException(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            log.error('ai.listModels.http_error', { url, status: res.status, statusText: res.statusText }, err);
            throw err;
          }
          return JSON.parse(text);
        } catch (e) {
          if (e.name === 'AbortError') {
            const err = new Error(`AI /models timed out after ${DEFAULT_TIMEOUT_MS}ms`);
            err.code = 'TIMEOUT';
            span.recordException(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            log.error('ai.listModels.timeout', { url, timeoutMs: DEFAULT_TIMEOUT_MS }, err);
            throw err;
          }
          if (!e.status) {
            // Network-level error: capture trace_id/span_id via OTel + structured log.
            span.recordException(e);
            span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
            log.error('ai.listModels.network_error', { url }, e);
          }
          throw e;
        } finally {
          clearTimeout(timer);
        }
      });
      span.setAttribute('cache.hit', hit);
      return value;
    } finally {
      span.end();
    }
  });
}

/**
 * Run a chat completion against the LiteLLM-compatible endpoint.
 */
async function chatCompletion(cfg, messages, options = {}) {
  return tracer.startActiveSpan('ai.chat', async (span) => {
    if (!cfg.baseUrl) { span.end(); throw new Error('AI_BASE_URL is not configured'); }
    if (!cfg.apiKey) { span.end(); throw new Error('AI_API_KEY is not configured'); }
    if (!cfg.model)  { span.end(); throw new Error('AI_MODEL is not configured'); }

    span.setAttribute('ai.model', cfg.model);
    span.setAttribute('ai.temperature', options.temperature ?? 0.3);
    if (options.maxTokens) span.setAttribute('ai.max_tokens', options.maxTokens);
    span.setAttribute('ai.message_count', messages.length);

    const url = new URL(
      'v1/chat/completions',
      cfg.baseUrl.endsWith('/') ? cfg.baseUrl : cfg.baseUrl + '/'
    ).toString();

    const startMs = Date.now();
    const requestedModel = cfg.model;
    const effectiveModel = pickFasterModel(requestedModel);
    span.setAttribute('ai.model.requested', requestedModel);
    span.setAttribute('ai.model.effective', effectiveModel);
    span.setAttribute('ai.routed', requestedModel !== effectiveModel);

    const body = {
      model: effectiveModel,
      messages,
      temperature: options.temperature ?? 0.3,
    };
    if (options.maxTokens) body.max_tokens = options.maxTokens;
    if (options.json) body.response_format = { type: 'json_object' };

    const controller = new AbortController();
    const effectiveTimeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      // Mark the active span as a timeout error so Dynatrace dashboards can filter it.
      const err = new Error(`AI chat exceeded ${effectiveTimeoutMs}ms`);
      err.code = 'AI_TIMEOUT';
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'ai.timeout' });
      span.setAttribute('error.type', 'ai.timeout');
      span.setAttribute('error.timeout_ms', effectiveTimeoutMs);
    }, effectiveTimeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        agent: url.startsWith('https') ? httpsAgent : httpAgent,
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      span.setAttribute('http.status_code', res.status);

      const text = await res.text();
      if (!res.ok) {
        let detail = text;
        try { detail = JSON.parse(text); } catch { /* keep raw text */ }
        const err = new Error(
          'AI chat ' + res.status + ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))
        );
        err.status = res.status;
        err.body = detail;
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        throw err;
      }
      const parsed = JSON.parse(text);
      if (parsed.usage) {
        span.setAttribute('ai.usage.prompt_tokens', parsed.usage.prompt_tokens || 0);
        span.setAttribute('ai.usage.completion_tokens', parsed.usage.completion_tokens || 0);
        span.setAttribute('ai.usage.total_tokens', parsed.usage.total_tokens || 0);
      }
      recordMetric(effectiveModel, Date.now() - startMs, null);
      return parsed;
    } catch (err) {
      // Surface AbortError due to our own timeout as a clear AI_TIMEOUT so callers / Dynatrace
      // can distinguish gateway timeouts from client cancellations.
      if (timedOut || (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'))) {
        err.code = 'AI_TIMEOUT';
        err.timeoutMs = effectiveTimeoutMs;
        span.setAttribute('error.type', 'ai.timeout');
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'ai.timeout' });
      }
      recordMetric(effectiveModel, Date.now() - startMs, err.code || (err.status ? `http.${err.status}` : 'unknown'));
      throw err;
    } finally {
      clearTimeout(timer);
      span.end();
    }
  });
}

/**
 * Convenience wrapper that returns parsed JSON object or { raw } on parse failure.
 */
async function analyzeProblem(cfg, problem, options = {}) {
  const messages = problemAnalysis.buildAnalysisMessages(problem, options);
  const response = await chatCompletion(cfg, messages, {
    json: !options.summaryOnly,
    timeoutMs: options.timeoutMs,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  });
  const choice = response.choices && response.choices[0];
  const content = choice && choice.message && choice.message.content || '';
  const parsed = problemAnalysis.parseJsonSafe(content);
  return {
    model: response.model,
    usage: response.usage,
    finishReason: choice && choice.finish_reason,
    raw: content,
    analysis: parsed.ok ? parsed.value : null,
    parseError: parsed.ok ? null : parsed.error,
  };
}

module.exports = {
  chatCompletion,
  listModels,
  analyzeProblem,
  getMetrics,
  pickFasterModel,
  MODEL_LATENCY_TARGETS,
};
