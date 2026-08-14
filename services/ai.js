'use strict';

/**
 * Tiny LiteLLM / OpenAI-compatible chat completion client.
 * Works with any endpoint that accepts:
 *   POST {baseUrl}/v1/chat/completions
 *   Authorization: Bearer <key>
 *   { model, messages, temperature, max_tokens, ... }
 */

const DEFAULT_TIMEOUT_MS = 60000;
const problemAnalysis = require('./problemAnalysis');

async function listModels(cfg) {
  if (!cfg.baseUrl) throw new Error('AI_BASE_URL is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const url = new URL('v1/models', cfg.baseUrl.endsWith('/') ? cfg.baseUrl : cfg.baseUrl + '/').toString();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`AI /models ${res.status}: ${text}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a chat completion against the LiteLLM-compatible endpoint.
 */
async function chatCompletion(cfg, messages, options = {}) {
  if (!cfg.baseUrl) throw new Error('AI_BASE_URL is not configured');
  if (!cfg.apiKey) throw new Error('AI_API_KEY is not configured');
  if (!cfg.model) throw new Error('AI_MODEL is not configured');

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
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try { detail = JSON.parse(text); } catch { /* keep raw text */ }
      const err = new Error(
        'AI chat ' + res.status + ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))
      );
      err.status = res.status;
      err.body = detail;
      throw err;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
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
