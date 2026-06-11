// Main SDK class
export { MetaswapsSDK } from './sdk.js';

// Standalone routing client (for quote-only use cases, e.g. UI price display).
export { RoutingClient } from './client/RoutingClient.js';

// CCS helper
export { CCSError } from './client/ccs.js';

// Zod schemas + inferred types (re-export so consumers can validate responses).
export {
  // Schemas
  Address,
  ChainDiscoverySchema,
  ChainsResponseSchema,
  TokenDiscoverySchema,
  TokensResponseSchema,
  QuoteRequestSchema,
  QuoteResponseSchema,
  RouteResponseSchema,
  CallCommitmentSchema,
  RouteTxSchema,
  // Types
  type ChainDiscovery,
  type ChainsResponse,
  type TokenDiscovery,
  type TokensResponse,
  type TokensQuery,
  type QuoteRequest,
  type QuoteResponse,
  type RouteResponse,
  type QuoteStep,
  type QuoteSwapStep,
  type QuoteBridgeStep,
  type RouteTx,
  type CallCommitment,
  type CallCommitmentBody,
  type HealthResponse,
  type ReadinessResponse,
} from './client/schemas.js';

// Wallet
export type { WalletConfig } from './wallet/types.js';

// Status tracking types
export {
  SwapStatus,
  checkMessageDelivery,
  type SwapStatusUpdate,
  type SwapDeliveryResult,
  type MessageDeliveryStatus,
} from './swap/tracker.js';

// Config and handle types
export type { MetaswapsSDKConfig, SwapHandle } from './types.js';

// Constants (all in one place)
export {
  DEFAULT_ROUTING_URL,
  DEFAULT_CCS_URL,
  DEFAULT_EXPLORER_API_URL,
  DEFAULT_POLLING_INTERVAL_MS,
  DEFAULT_DEADLINE_SECONDS,
  BRIDGE_EVENT_TOPIC,
  CROSS_CHAIN_SWAP_TOPIC,
  DISPATCH_ID_TOPIC,
  CCTP_MESSAGE_SENT_TOPIC,
  CCTP_MESSAGE_TRANSMITTER_ADDRESSES,
  REGISTRY_RPC_URLS,
  REGISTRY_CHAIN_NAMES,
  resolveRpcUrl,
} from './utils/constants.js';

// DEFAULT_RPC_URLS is an alias for REGISTRY_RPC_URLS
export { REGISTRY_RPC_URLS as DEFAULT_RPC_URLS } from './utils/constants.js';
