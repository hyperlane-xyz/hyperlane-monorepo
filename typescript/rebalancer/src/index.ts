/**
 * @hyperlane-xyz/rebalancer
 *
 * Hyperlane Warp Route Collateral Rebalancer
 *
 * This package provides functionality for automatically rebalancing collateral
 * across Hyperlane warp routes to maintain optimal token distribution.
 */

// Core service
export { RebalancerService } from './core/RebalancerService.js';
export type {
  RebalancerServiceConfig,
  ManualRebalanceRequest,
} from './core/RebalancerService.js';

// Core rebalancing logic
export { Rebalancer } from './core/Rebalancer.js';

// Configuration
export { RebalancerConfig } from './config/RebalancerConfig.js';
export {
  DEFAULT_INTENT_TTL_MS,
  DEFAULT_INTENT_TTL_S,
  getStrategyChainConfig,
  getStrategyChainNames,
  RebalancerBaseChainConfigSchema,
  RebalancerConfigSchema,
  RebalancerMinAmountConfigSchema,
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
  RebalancerStrategySchema,
  RebalancerWeightedChainConfigSchema,
  StrategyConfigSchema,
} from './config/types.js';
export type {
  MinAmountStrategyConfig,
  RebalancerConfig as RebalancerConfigType,
  RebalancerConfigFileInput,
  RebalancerMinAmountChainConfig,
  RebalancerWeightedChainConfig,
  StrategyConfig,
  WeightedStrategyConfig,
} from './config/types.js';

// Strategy
export { BaseStrategy } from './strategy/BaseStrategy.js';
export { CompositeStrategy } from './strategy/CompositeStrategy.js';
export { WeightedStrategy } from './strategy/WeightedStrategy.js';
export { MinAmountStrategy } from './strategy/MinAmountStrategy.js';
export { StrategyFactory } from './strategy/StrategyFactory.js';

// Monitor
export { Monitor } from './monitor/Monitor.js';

// Metrics
export { Metrics } from './metrics/Metrics.js';
export { PriceGetter } from './metrics/PriceGetter.js';

// Interfaces
export type {
  ExecutionResult,
  IInventoryRebalancer,
  IMovableCollateralRebalancer,
  IRebalancer,
  InventoryExecutionResult,
  MovableCollateralExecutionResult,
  PreparedTransaction,
  RebalancerType,
} from './interfaces/IRebalancer.js';
export type {
  IStrategy,
  InflightContext,
  InventoryRoute,
  MovableCollateralRoute,
  RawBalances,
  Route,
  StrategyRoute,
} from './interfaces/IStrategy.js';
export type {
  ConfirmedBlockTag,
  ConfirmedBlockTags,
  IMonitor,
} from './interfaces/IMonitor.js';
export {
  MonitorEventType,
  MonitorEvent,
  MonitorPollingError,
  MonitorStartError,
} from './interfaces/IMonitor.js';
export type { IMetrics } from './interfaces/IMetrics.js';

// Utils
export {
  getBridgeConfig,
  isMovableCollateralConfig,
  isInventoryConfig,
} from './utils/bridgeUtils.js';
export type {
  BridgeConfigWithOverride,
  BridgeConfig,
  MovableCollateralBridgeConfig,
  InventoryBridgeConfig,
} from './utils/bridgeUtils.js';
export { getRawBalances } from './utils/balanceUtils.js';
export { isCollateralizedTokenEligibleForRebalancing } from './utils/tokenUtils.js';
export { ExplorerClient } from './utils/ExplorerClient.js';

// Tracking
export { InflightContextAdapter } from './tracking/InflightContextAdapter.js';
export type {
  IActionTracker,
  CreateRebalanceIntentParams,
  CreateRebalanceActionParams,
} from './tracking/IActionTracker.js';
export type {
  Transfer,
  RebalanceIntent,
  RebalanceAction,
  ActionType,
  PartialInventoryIntent,
} from './tracking/types.js';

// Factory
export { RebalancerContextFactory } from './factories/RebalancerContextFactory.js';
