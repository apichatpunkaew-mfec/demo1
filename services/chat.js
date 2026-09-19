'use strict';

/**
 * Chat session manager — keeps a bounded rolling-window of messages per
 * sessionId, exposes context for the LLM, and lets the caller inject a
 * Dynatrace problem so the bot can answer questions about it.
 *
 * Design:
 *  - In-memory Map<sessionId, { messages, problemContext, lastUsed }>
 *  - Sessions auto-expire after SESSION_TTL_MS
 *  - History is capped at MAX_MESSAGES (oldest dropped FIFO) to bound tokens
 */

const SESSION_TTL_MS = 60 * 60 * 1000;   // 1 hour
const MAX_MESSAGES = 40;                  // 20 turns (user+assistant)

const sessions = new Map();

const BASE_SYSTEM = [
  'You are a helpful AI assistant embedded in the Dynatrace AI Dashboard.',
  'You help on-call engineers reason about Dynatrace problems, performance data,',
  'and operational incidents. Be concise, actionable, and reference concrete',
  'evidence from the conversation or attached problem context when possible.',
  'Use plain prose with optional short lists. Do not wrap answers in JSON or',
  'markdown fences unless the user explicitly asks for code.',
].join(' ');

function gc() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL_MS) sessions.delete(id);
  }
}

function getOrCreate(sessionId) {
  gc();
  let s = sessions.get(sessionId);
  if (!s) {
    s = { messages: [], problemContext: null, lastUsed: Date.now() };
    sessions.set(sessionId, s);
  }
  s.lastUsed = Date.now();
  return s;
}

function get(sessionId) {
  return sessions.get(sessionId) || null;
}

function setProblemContext(sessionId, problem) {
  const s = getOrCreate(sessionId);
  s.problemContext = problem || null;
  // Reset history when context changes — otherwise the bot might answer
  // about the wrong incident.
  s.messages = [];
  return s;
}

function clear(sessionId) {
  sessions.delete(sessionId);
}

/**
 * Returns the message array to send to the LLM:
 *   [system(problem-aware), ...history, user(content, optional problemAttachment)]
 */
function buildMessages(sessionId, userContent) {
  const s = getOrCreate(sessionId);
  const sysLines = [BASE_SYSTEM];
  if (s.problemContext) {
    const p = s.problemContext;
    sysLines.push('');
    sysLines.push('You are currently discussing this Dynatrace problem:');
    sysLines.push('  Display ID : ' + (p.displayId || p.problemId || '?'));
    sysLines.push('  Title      : ' + (p.title || '(no title)'));
    sysLines.push('  Status     : ' + (p.status || '?'));
    sysLines.push('  Severity   : ' + (p.severityLevel || '?'));
    sysLines.push('  Impact     : ' + (p.impactLevel || '?'));
    if (p.rootCauseEntity && p.rootCauseEntity.name) {
      sysLines.push('  Root cause : ' + p.rootCauseEntity.name +
        ' (' + (p.rootCauseEntity.entityId && p.rootCauseEntity.entityId.type || '') + ')');
    }
    if (p.startTime) {
      sysLines.push('  Started    : ' + new Date(p.startTime).toISOString());
    }
    if (Array.isArray(p.affectedEntities) && p.affectedEntities.length) {
      const aff = p.affectedEntities
        .slice(0, 10)
        .map((e) => (e.name || (e.entityId && e.entityId.id) || '?') +
                     ' [' + ((e.entityId && e.entityId.type) || '') + ']')
        .join(', ');
      sysLines.push('  Affected   : ' + aff);
    }
    if (p.description) sysLines.push('  Description: ' + p.description);
  }
  sysLines.push('');
  sysLines.push('When the user asks about "this problem" or "the incident", refer to the above.');

  const systemMsg = { role: 'system', content: sysLines.join('\n') };

  // Trim oldest turns (keep system + last MAX_MESSAGES-1 non-system turns).
  let history = s.messages.slice(-MAX_MESSAGES);

  return [systemMsg, ...history, { role: 'user', content: userContent }];
}

/**
 * Persist a completed turn to the session.
 */
function recordTurn(sessionId, userContent, assistantContent) {
  const s = getOrCreate(sessionId);
  s.messages.push({ role: 'user', content: userContent });
  s.messages.push({ role: 'assistant', content: assistantContent });
  // Cap to MAX_MESSAGES (drop oldest non-system turn).
  if (s.messages.length > MAX_MESSAGES) {
    s.messages.splice(0, s.messages.length - MAX_MESSAGES);
  }
  s.lastUsed = Date.now();
}

function getStats() {
  gc();
  let totalTurns = 0;
  for (const s of sessions.values()) totalTurns += s.messages.length;
  return { sessions: sessions.size, total_turns: totalTurns };
}

module.exports = {
  getOrCreate,
  get,
  setProblemContext,
  clear,
  buildMessages,
  recordTurn,
  getStats,
};