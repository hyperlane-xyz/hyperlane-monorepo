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
export { WithInflightGuard } from './core/WithInflightGuard.js';
export { WithSemaphore } from './core/WithSemaphore.js';

// Configuration
export { RebalancerConfig } from './config/RebalancerConfig.js';

// Strategy
export { BaseStrategy } from './strategy/BaseStrategy.js';
export { WeightedStrategy } from './strategy/WeightedStrategy.js';
export { MinAmountStrategy } from './strategy/MinAmountStrategy.js';
export { CollateralDeficitStrategy } from './strategy/CollateralDeficitStrategy.js';
export type { CollateralDeficitStrategyConfig } from './strategy/CollateralDeficitStrategy.js';
export { CompositeStrategy } from './strategy/CompositeStrategy.js';
export { StrategyFactory } from './strategy/StrategyFactory.js';

// Tracker
export {
  MessageTracker,
  type MessageTrackerConfig,
  type InflightMessage,
  RebalanceTracker,
  type Rebalance,
  type RebalanceStatus,
  type Execution,
  type ExecutionType,
  type ExecutionStatus,
  type CreateRebalanceInput,
  type CreateExecutionInput,
  type RebalanceContext,
} from './tracker/index.js';

// Executor
export { RebalanceExecutor } from './executor/RebalanceExecutor.js';
export type {
  InventoryConfig,
  IInventoryProvider,
  IInventoryBridge,
} from './executor/RebalanceExecutor.js';

// Monitor
export { Monitor } from './monitor/Monitor.js';

// Metrics
export { Metrics } from './metrics/Metrics.js';
export { PriceGetter } from './metrics/PriceGetter.js';

// Interfaces
export type {
  IRebalancer,
  PreparedTransaction,
} from './interfaces/IRebalancer.js';
export type {
  IStrategy,
  RebalancingRoute,
  RawBalances,
  InflightContext,
} from './interfaces/IStrategy.js';
export type { IMonitor } from './interfaces/IMonitor.js';
export {
  MonitorEventType,
  MonitorEvent,
  MonitorPollingError,
  MonitorStartError,
} from './interfaces/IMonitor.js';
export type { IMetrics } from './interfaces/IMetrics.js';

// Utils
export { getBridgeConfig } from './utils/bridgeUtils.js';
export type {
  BridgeConfigWithOverride,
  BridgeConfig,
} from './utils/bridgeUtils.js';
export { getRawBalances } from './utils/balanceUtils.js';
export { isCollateralizedTokenEligibleForRebalancing } from './utils/tokenUtils.js';
export { ExplorerClient } from './utils/ExplorerClient.js';

// Factory
export { RebalancerContextFactory } from './factories/RebalancerContextFactory.js';
