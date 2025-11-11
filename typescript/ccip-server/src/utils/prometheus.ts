import express from 'express';
import { Counter, Registry } from 'prom-client';

// Global register for offchain lookup metrics
const register = new Registry();

const requestCounter = new Counter({
  name: 'hyperlane_offchain_lookup_server_http_requests',
  help: 'Total number of HTTP offchain lookup requests',
  labelNames: ['service', 'status_code'],
  registers: [register],
});

/**
 * Error reasons for unhandled errors
 */
export enum UnhandledErrorReason {
  // Module initialization
  MODULE_INITIALIZATION_FAILED = 'module_initialization_failed',

  // Hyperlane Explorer errors
  EXPLORER_GRAPHQL_500 = 'explorer_graphql_500',
  EXPLORER_GRAPHQL_NO_RESULTS = 'explorer_graphql_no_results',

  // CCTP errors
  CCTP_MESSAGE_SENT_NOT_FOUND = 'cctp_message_sent_not_found',
  CCTP_UNSUPPORTED_VERSION = 'cctp_unsupported_version',
  CCTP_ATTESTATION_SERVICE_500 = 'cctp_attestation_service_500',
  CCTP_ATTESTATION_SERVICE_UNKNOWN_ERROR = 'cctp_attestation_service_unknown_error',

  // CallCommitments errors
  CALL_COMMITMENTS_DATABASE_ERROR = 'call_commitments_database_error',

  // Generic fallback
  UNKNOWN = 'unknown',
}

const unhandledErrorCounter = new Counter({
  name: 'hyperlane_offchain_lookup_server_unhandled_errors',
  help: 'Total number of unhandled errors',
  labelNames: ['service', 'error_reason'],
  registers: [register],
});

export const PrometheusMetrics = {
  logLookupRequest(service: string, statusCode: number) {
    requestCounter.inc({ service, status_code: statusCode });
  },
  logUnhandledError(service: string, errorReason: UnhandledErrorReason) {
    unhandledErrorCounter.inc({
      service,
      error_reason: errorReason,
    });
  },
};

export async function startPrometheusServer() {
  const app = express();

  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  const port = parseInt(process.env.PROMETHEUS_PORT ?? '9090');
  app.listen(port, () =>
    console.log(`Prometheus server started on port ${port}`),
  );
}
