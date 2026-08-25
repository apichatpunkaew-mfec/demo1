'use strict';

/**
 * Minimal Dynatrace REST v2 client (Problems API).
 * Docs: https://www.dynatrace.com/docs/dynatrace-api/environment-api/problems-v2
 *
 * Performance features:
 *  - keepAlive https Agent so we reuse the TLS connection to Dynatrace
 *  - small in-memory TTL cache on listProblems() (10s) so UI refreshes don't re-hit
 *  - OTel spans on every request so we can prove the win in Dynatrace
 */

const { trace, SpanStatusCode } = require('@opentelemetry/api');
const http = require('http');
const https = require('https');
const { cache } = require('./cache');
const log = require('./logger');

const tracer = trace.getTracer('dynatrace-rest', '1.0.0');
const DEFAULT_TIMEOUT_MS = 20000;

// Reuse connections to Dynatrace (avoids repeated TCP+TLS handshakes).
// Cap concurrent sockets per host so we don't blow through Dynatrace's rate limit.
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 16,
  scheduling: 'lifo', // prefer the most recent socket (warmer)
});
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });

function buildUrl(baseUrl, path, query) {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function dynatraceFetch(baseUrl, token, path, query = {}) {
  return tracer.startActiveSpan('dynatrace.fetch ' + path, async (span) => {
    if (!baseUrl) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'DYNATRACE_BASE_URL not configured' });
      throw new Error('DYNATRACE_BASE_URL is not configured');
    }
    if (!token) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'DYNATRACE_API_TOKEN not configured' });
      throw new Error('DYNATRACE_API_TOKEN is not configured');
    }
    span.setAttribute('dynatrace.path', path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        span.setAttribute('dynatrace.query.' + k, String(v));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    const url = buildUrl(baseUrl, path, query);
    try {
      const res = await fetch(url, {
        method: 'GET',
        agent: url.startsWith('https') ? httpsAgent : httpAgent,
        headers: {
          Authorization: `Api-Token ${token}`,
          Accept: 'application/json; charset=utf-8',
        },
        signal: controller.signal,
      });

      span.setAttribute('http.status_code', res.status);

      const text = await res.text();
      if (!res.ok) {
        let detail = text;
        try { detail = JSON.parse(text); } catch { /* keep raw */ }
        const err = new Error(
          `Dynatrace API ${res.status} ${res.statusText} on ${path}: ` +
          (typeof detail === 'string' ? detail : JSON.stringify(detail))
        );
        err.status = res.status;
        err.body = detail;
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        throw err;
      }
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timer);
      span.end();
    }
  });
}
/**
 * List problems.
 * @param {object} cfg   { baseUrl, token }
 * @param {object} [opts]
 * @param {string} [opts.status]        - OPEN, CLOSED, RESOLVED
 * @param {string} [opts.severityLevel] - AVAILABILITY, ERROR, ...
 * @param {number} [opts.pageSize]      - 1..200
 * @param {string} [opts.from]          - RFC3339 timestamp
 * @param {string} [opts.to]            - RFC3339 timestamp
 * @param {string} [opts.nextPageKey]   - pagination cursor (skips cache)
 */
async function listProblems(cfg, opts = {}) {
  // Cache only the cheap, frequently-refreshed list view.
  // Pagination cursors and deep time-range queries are NOT cached.
  const cacheable =
    !opts.nextPageKey && !opts.from && !opts.to &&
    (opts.pageSize == null || opts.pageSize <= 50);
  const key = 'listProblems:' + JSON.stringify({
    s: opts.status || '', sv: opts.severityLevel || '', ps: opts.pageSize || 0,
  });
  const TTL_LIST_MS = 10000; // 10s - UI refreshes every few seconds

  if (cacheable) {
    return tracer.startActiveSpan('cache.listProblems', async (span) => {
      try {
        const { value, hit } = await cache.getOrLoad(key, TTL_LIST_MS, () =>
          dynatraceFetch(cfg.baseUrl, cfg.token, 'api/v2/problems', {
            status: opts.status,
            severityLevel: opts.severityLevel,
            pageSize: opts.pageSize,
          })
        );
        span.setAttribute('cache.hit', hit);
        return value;
      } finally {
        span.end();
      }
    });
  }

  return dynatraceFetch(cfg.baseUrl, cfg.token, 'api/v2/problems', {
    status: opts.status,
    severityLevel: opts.severityLevel,
    pageSize: opts.pageSize,
    from: opts.from,
    to: opts.to,
    nextPageKey: opts.nextPageKey,
  });
}

/**
 * Get a single problem details (incl. affected entities / root cause / comments).
 */
async function getProblem(cfg, problemId) {
  return dynatraceFetch(cfg.baseUrl, cfg.token, 'api/v2/problems/' + encodeURIComponent(problemId));
}

/**
 * Try to fetch entity names for affected entity IDs. Best effort; failures are
 * logged as warnings (with trace_id) so we don't lose visibility in Dynatrace,
 * but the caller still falls back to whatever was embedded in the problem
 * payload.
 */
async function getEntities(cfg, ids = []) {
  if (!ids.length) return [];
  const out = [];
  const chunkSize = 50;
  const uniqueTypes = [...new Set(ids.map((c) => c.type).filter(Boolean))];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    try {
      const body = await dynatraceFetch(cfg.baseUrl, cfg.token, 'api/v2/entities', {
        entitySelector: 'type("' + uniqueTypes.join('","') + '")',
        pageSize: chunkSize,
      });
      for (const ent of body.entities || []) {
        const match = chunk.find(
          (c) => c.id === ent.entityId?.id && c.type === ent.entityId?.type
        );
        if (match) {
          out.push({ id: ent.entityId.id, type: ent.entityId.type, name: ent.displayName });
        }
      }
    } catch (e) {
      // Log instead of swallow: we still fall back to embedded payload, but
      // Dynatrace now sees the failure with trace_id/span_id correlation.
      log.warn('dynatrace.getEntities.chunk_failed', {
        chunk_index: Math.floor(i / chunkSize),
        chunk_size: chunk.length,
        entity_types: uniqueTypes,
      }, e);
    }
  }
  return out;
}

module.exports = {
  listProblems,
  getProblem,
  getEntities,
};
