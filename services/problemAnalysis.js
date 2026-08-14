'use strict';

/**
 * Helpers for building Dynatrace problem analysis prompts and parsing LLM output.
 */

const SYS_PROMPT = [
  'You are a senior Site Reliability Engineer analyzing Dynatrace problems.',
  'You will receive a single Dynatrace problem payload (JSON-ish description).',
  'Return a concise, actionable analysis suitable for an on-call engineer.',
  'Respond strictly with JSON using this schema:',
  '{',
  '  "summary": "string",                // 1-2 sentence plain-English description',
  '  "likelyRootCause": "string",        // best guess, explained',
  '  "severity": "string",               // LOW | MEDIUM | HIGH | CRITICAL',
  '  "impact": "string",                 // what users/services are affected',
  '  "recommendedActions": ["string"],   // ordered, concrete steps',
  '  "runbooks": ["string"],             // generic procedures/checklists',
  '  "confidence": number                // 0..1',
  '}',
  'No prose outside the JSON. No markdown fences. No commentary.',
].join('\n');

function problemText(problem) {
  const lines = [];
  lines.push('Display ID: ' + (problem.displayId || problem.problemId));
  lines.push('Title: ' + (problem.title || '(no title)'));
  lines.push('Status: ' + problem.status);
  lines.push('Severity: ' + problem.severityLevel);
  lines.push('Impact level: ' + problem.impactLevel);
  if (problem.startTime) lines.push('Started: ' + new Date(problem.startTime).toISOString());
  if (problem.endTime && problem.endTime > 0) {
    lines.push('Ended: ' + new Date(problem.endTime).toISOString());
  }
  if (problem.rootCauseEntity) {
    lines.push(
      'Root cause entity: ' +
      (problem.rootCauseEntity.name || '') +
      ' (' + (problem.rootCauseEntity.entityId?.type || '') + ')'
    );
  }
  const affected = (problem.affectedEntities || problem.impactedEntities || [])
    .map(function (e) { return (e.name || e.entityId?.id) + ' [' + e.entityId?.type + ']'; })
    .join(', ');
  if (affected) lines.push('Affected entities: ' + affected);
  if (problem.entityTags && problem.entityTags.length) {
    lines.push(
      'Tags: ' +
      problem.entityTags.map(function (t) {
        return t.stringRepresentation || (t.key + ':' + t.value);
      }).join('; ')
    );
  }
  if (problem.managementZones && problem.managementZones.length) {
    lines.push('Management zones: ' + problem.managementZones.map(function (z) { return z.name; }).join(', '));
  }
  if (problem.commentCount !== undefined) {
    lines.push('Comments: ' + problem.commentCount);
  }
  if (problem.description) lines.push('Description: ' + problem.description);
  return lines.join('\n');
}

function buildAnalysisMessages(problem, options) {
  options = options || {};
  const summaryOnly = !!options.summaryOnly;

  const sys = summaryOnly
    ? 'You are a senior SRE. Summarize Dynatrace problems in 2 short sentences, plain text only, no markdown.'
    : SYS_PROMPT;

  const user = summaryOnly
    ? 'Summarize this Dynatrace problem:\n\n' + problemText(problem)
    : 'Analyze the following Dynatrace problem payload and return the structured JSON defined in the system prompt.\n\nPROBLEM:\n' + problemText(problem);

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

function parseJsonSafe(s) {
  if (typeof s !== 'string') return { ok: false, error: 'non-string content' };
  let text = s.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  SYS_PROMPT,
  problemText,
  buildAnalysisMessages,
  parseJsonSafe,
};
