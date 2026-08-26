'use strict';

/**
 * OpenTelemetry bootstrap. Required as the FIRST line of server.js so that
 * instrumentations can monkey-patch `express`, `undici` (Node fetch), etc.
 * before they are imported.
 *
 * Sends traces to the Dynatrace classic OTLP endpoint using the API token
 * already configured in .env (`DYNATRACE_API_TOKEN`).
 *
 * Disable by setting `OTEL_SDK_DISABLED=true` or `DISABLE_TRACING=1`.
 */

// Load .env first so DYNATRACE_API_TOKEN is available to the OTLP exporter.
require('dotenv').config();

if (process.env.OTEL_SDK_DISABLED === 'true' || process.env.DISABLE_TRACING === '1') {
  // eslint-disable-next-line no-console
  console.log('[tracing] disabled via env');
  return;
}

const token = process.env.DYNATRACE_API_TOKEN;
if (!token) {
  // eslint-disable-next-line no-console
  console.warn('[tracing] DYNATRACE_API_TOKEN not set — tracing disabled');
  return;
}

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-proto');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
  'https://waa41263.live.dynatrace.com/api/v2/otlp/v1/traces';

const logsEndpoint =
  process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ||
  'https://waa41263.live.dynatrace.com/api/v2/otlp/v1/logs';

const serviceName = process.env.OTEL_SERVICE_NAME || 'dynatrace-ai-dashboard';
const serviceVersion = process.env.npm_package_version || '1.0.0';

const traceExporter = new OTLPTraceExporter({
  url: endpoint,
  // Dynatrace OTLP HTTP endpoint strictly checks Content-Type.
  // Protobuf exporter sets 'Content-Type: application/x-protobuf' correctly.
  headers: {
    Authorization: `Api-Token ${token}`,
  },
});

const logExporter = new OTLPLogExporter({
  url: logsEndpoint,
  headers: {
    Authorization: `Api-Token ${token}`,
  },
});

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
    'deployment.environment': process.env.NODE_ENV || 'development',
  }),
  traceExporter,
  logRecordProcessors: [
    new (require('@opentelemetry/sdk-logs').BatchLogRecordProcessor)(logExporter),
  ],
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs spans are extremely noisy for an Express app
      '@opentelemetry/instrumentation-fs': { enabled: false },
      // DNS adds little value here
      '@opentelemetry/instrumentation-dns': { enabled: false },
      // net spans are similarly noisy
      '@opentelemetry/instrumentation-net': { enabled: false },
    }),
  ],
});

try {
  sdk.start();
  // eslint-disable-next-line no-console
  console.log(`[tracing] OTel SDK started -> ${endpoint}`);
  // eslint-disable-next-line no-console
  console.log(`[tracing]   service.name = ${serviceName}`);
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('[tracing] failed to start SDK:', e.message);
}

const shutdown = () => {
  sdk
    .shutdown()
    .then(() => console.log('[tracing] SDK shut down'))
    .catch((e) => console.error('[tracing] shutdown error:', e.message))
    .finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);