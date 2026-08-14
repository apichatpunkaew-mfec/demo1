'use strict';

/**
 * Minimal Dynatrace REST v2 client (Problems API).
 * Docs: https://www.dynatrace.com/docs/dynatrace-api/environment-api/problems-v2
 */

const DEFAULT_TIMEOUT_MS = 20000;

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
  if (!baseUrl) throw new Error('DYNATRACE_BASE_URL is not configured');
  if (!token) throw new Error('DYNATRACE_API_TOKEN is not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  const url = buildUrl(baseUrl, path, query);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Api-Token ${token}`,
        Accept: 'application/json; charset=utf-8',
      },
      signal: controller.signal,
    });

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
      throw err;
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List problems.
 * @param {object} cfg
 * @param {string} cfg.baseUrl
 * @param {string} cfg.token
 * @param {object} [opts]
 * @param {string} [opts.status]      - OPEN, CLOSED, RESOLVED
 * @param {string} [opts.severityLevel] - AVAILABILITY, ERROR, PERFORMANCE, RESOURCE_CONTENTION, MONITORING_UNAVAILABLE, CUSTOM_ALERT, INFORMATION
 * @param {number} [opts.pageSize]    - 1..200, default 50
 * @param {string} [opts.from]        - RFC3339 timestamp
 * @param {string} [opts.to]          - RFC3339 timestamp
 * @param {string} [opts.nextPageKey] - pagination cursor
 */
async function listProblems(cfg, opts = {}) {
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
  return dynatraceFetch(cfg.baseUrl, cfg.token, `api/v2/problems/${encodeURIComponent(problemId)}`);
}

/**
 * Try to fetch entity names for affected entity IDs. Best effort; failures are swallowed.
 * Returns an array of {id, type, name}.
 */
async function getEntities(cfg, ids = []) {
  if (!ids.length) return [];
  const out = [];
  // Up to 50 per call to keep responses small.
  const chunkSize = 50;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    try {
      const body = await dynatraceFetch(cfg.baseUrl, cfg.token, 'api/v2/entities', {
        entitySelector: `type("${chunk.map((c) => c.type).filter((v, i, a) => a.indexOf(v) === i).join('","')}")`,
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
      // ignore — we'll fall back to whatever was embedded in the problem payload
    }
  }
  return out;
}

module.exports = {
  listProblems,
  getProblem,
  getEntities,
};
