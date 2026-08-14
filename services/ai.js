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

const tracer = trace.getTracer('ai-litellm', '1.0.0');
const DEFAULT_TIMEOUT_MS = 60000;
const problemAnalysis = require('./problemAnalysis');

// Reuse TLS connections to the LiteLLM gateway.
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, scheduling: 'lifo' });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });

async function listModels(cfg) {
  if (!cfg.baseUrl) throw new Error('AI_BASE_URL is not configured');
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
            throw err;
          }
          return JSON.parse(text);
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

    const body = {
      model: cfg.model,
      messages,
      temperature: options.temperature ?? 0.3,
    };
    if (options.maxTokens) body.max_tokens = options.maxTokens;
    if (options.json) body.response_format = { type: 'json_object' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);

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
      return parsed;
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
};
