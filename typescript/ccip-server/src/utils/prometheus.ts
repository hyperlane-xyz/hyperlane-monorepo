import { Counter, Registry } from 'prom-client';

// Global register for offchain lookup metrics
export const register = new Registry();

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
  CCTP_ATTESTATION_SERVICE_JSON_PARSE_ERROR = 'cctp_attestation_service_json_parse_error',
  CCTP_ATTESTATION_SERVICE_PENDING = 'cctp_attestation_service_pending',

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
