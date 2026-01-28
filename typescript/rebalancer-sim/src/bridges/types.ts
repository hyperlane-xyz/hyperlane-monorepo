import type { Address } from '@hyperlane-xyz/utils';

/**
 * Bridge mock configuration for REBALANCER transfers.
 *
 * This configures the simulated bridge delays for when the rebalancer moves
 * funds between chains. In production, these bridges (CCTP, etc.) can have
 * delays ranging from ~10 seconds to 7 days depending on the bridge type.
 *
 * NOTE: This is separate from user transfer delivery, which goes through
 * Hyperlane/Mailbox and is configured via SimulationTiming.userTransferDeliveryDelay.
 */
export interface BridgeMockConfig {
  [origin: string]: {
    [dest: string]: BridgeRouteConfig;
  };
}

/**
 * Configuration for a single bridge route
 */
export interface BridgeRouteConfig {
  /** Delivery delay in milliseconds (e.g., 500ms for fast simulation) */
  deliveryDelay: number;
  /** Failure rate as decimal 0-1 (e.g., 0.01 for 1%) */
  failureRate: number;
  /** Jitter in milliseconds (± variance) */
  deliveryJitter: number;
  /** Optional native fee for bridge */
  nativeFee?: bigint;
  /** Optional token fee as basis points (e.g., 10 = 0.1%) */
  tokenFeeBps?: number;
}

/**
 * Pending transfer in bridge controller
 */
export interface PendingTransfer {
  id: string;
  origin: string;
  destination: string;
  amount: bigint;
  recipient: Address;
  scheduledDelivery: number;
  failed: boolean;
  delivered: boolean;
  deliveredAt?: number;
}

/**
 * Bridge event types
 */
export type BridgeEventType =
  | 'transfer_initiated'
  | 'transfer_delivered'
  | 'transfer_failed';

/**
 * Bridge event for tracking
 */
export interface BridgeEvent {
  type: BridgeEventType;
  transfer: PendingTransfer;
  timestamp: number;
}

/**
 * Default bridge config for testing
 */
export const DEFAULT_BRIDGE_ROUTE_CONFIG: BridgeRouteConfig = {
  deliveryDelay: 500,
  failureRate: 0,
  deliveryJitter: 100,
};

/**
 * Creates a symmetric bridge config for all chain pairs
 */
export function createSymmetricBridgeConfig(
  chains: string[],
  config: BridgeRouteConfig = DEFAULT_BRIDGE_ROUTE_CONFIG,
): BridgeMockConfig {
  const bridgeConfig: BridgeMockConfig = {};

  for (const origin of chains) {
    bridgeConfig[origin] = {};
    for (const dest of chains) {
      if (origin !== dest) {
        bridgeConfig[origin][dest] = { ...config };
      }
    }
  }

  return bridgeConfig;
}
