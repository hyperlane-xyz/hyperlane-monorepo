// Re-export shared types from metrics
export {
  type NativeWalletBalance,
  type WarpRouteBalance,
  type XERC20Info,
  type XERC20Limit,
} from '@hyperlane-xyz/metrics';

/**
 * Configuration for the warp monitor service.
 */
export interface WarpMonitorConfig {
  warpRouteId: string;
  checkFrequency: number;
  coingeckoApiKey?: string;
  registryUri?: string;
}
