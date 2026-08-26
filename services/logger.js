'use strict';

/**
 * Structured logger for the Dynatrace AI Dashboard.
 *
 * Emits JSON log lines on stdout (so Dynatrace Log ingest can pick them up
 * via the OneAgent stdout source) and mirrors to stderr.
 *
 * Why structured?
 *   - Each log line carries: timestamp, level, service, trace_id, span_id,
 *     event, plus any user-supplied context.
 *   - trace_id/span_id are pulled from the active OpenTelemetry span so we can
 *     pivot between logs and traces in Dynatrace.
 *   - PII is **never** logged automatically; callers must redact themselves.
 *
 * Levels: debug, info, warn, error.
 */

const { trace, context } = require('@opentelemetry/api');

// Lazily resolve the OTel log provider. Loaded only after tracing.js has
// initialised the SDK, so the shared OTLP log exporter picks up our records.
let logProvider = null;
let logSent = 0;
let logSendFailures = 0;
function getLogger() {
  if (logProvider) return logProvider.getLogger('dynatrace-ai-dashboard');
  try {
    // eslint-disable-next-line global-require
    const logs = require('@opentelemetry/api-logs');
    // The sdk-logs BatchLogRecordProcessor attaches the provider globally
    // once NodeSDK starts. We only need the API handle here.
    logProvider = logs;
    return logs.getLogger('dynatrace-ai-dashboard');
  } catch {
    return null;
  }
}

const SERVICE = process.env.OTEL_SERVICE_NAME || 'dynatrace-ai-dashboard';
const HOST = process.env.HOSTNAME || require('os').hostname();

function activeTraceIds() {
  try {
    const span = trace.getSpan(context.active());
    if (!span) return { trace_id: null, span_id: null };
    const ctx = span.spanContext();
    return {
      trace_id: ctx.traceId && /^[0-9a-f]{32}$/.test(ctx.traceId) ? ctx.traceId : null,
      span_id: ctx.spanId && /^[0-9a-f]{16}$/.test(ctx.spanId) ? ctx.spanId : null,
    };
  } catch {
    return { trace_id: null, span_id: null };
  }
}

function emit(level, event, fields, err) {
  const { trace_id, span_id } = activeTraceIds();
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE,
    host: HOST,
    event,
    trace_id,
    span_id,
    ...fields,
  };
  if (err) {
    record.error = {
      name: err.name,
      message: err.message,
      code: err.code,
      status: err.status,
      stack: err.stack,
    };
  }

  // SeverityText mapping (OTLP logs spec) — severity_number is optional but
  // useful for Dynatrace log queries / alerting.
  const sev = level === 'error' ? 17 : level === 'warn' ? 13 : level === 'info' ? 9 : 5;

  // Send via OTLP logs if SDK is loaded.
  try {
    const { logs: logsApi } = require('@opentelemetry/api-logs');
    const logger = logsApi.getLogger(SERVICE);
    logger.emit({
      severityText: level.toUpperCase(),
      severityNumber: sev,
      body: event,
      attributes: record,
      timestamp: Date.now() * 1000000, // OTLP requires nanoseconds
    });
    logSent += 1;
  } catch (e) {
    logSendFailures += 1;
    if (logSendFailures <= 3) {
      // eslint-disable-next-line no-console
      console.error('[logger] OTLP send failed:', e.message);
    }
  }

  // Mirror to stdout/stderr so local `node server.js` still shows readable logs.
  const line = JSON.stringify(record) + '\n';
  if (level === 'error' || level === 'warn') process.stderr.write(line);
  else process.stdout.write(line);
}

module.exports = {
  debug: (event, fields) => emit('debug', event, fields),
  info:  (event, fields) => emit('info',  event, fields),
  warn:  (event, fields, err) => emit('warn',  event, fields, err),
  error: (event, fields, err) => emit('error', event, fields, err),
  child: (extra) => ({
    debug: (event, fields) => emit('debug', event, { ...extra, ...fields }),
    info:  (event, fields) => emit('info',  event, { ...extra, ...fields }),
    warn:  (event, fields, err) => emit('warn',  event, { ...extra, ...fields }, err),
    error: (event, fields, err) => emit('error', event, { ...extra, ...fields }, err),
  }),
};
