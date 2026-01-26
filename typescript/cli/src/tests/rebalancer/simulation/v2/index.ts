/**
 * Simulation Harness v2
 *
 * End-to-end simulation environment for testing the real RebalancerService
 * against simulated warp route traffic and mock bridges.
 */

// Clock
export { SimulationClock } from './SimulationClock.js';
export type { SimulationClockConfig } from './SimulationClock.js';

// Traffic Generator (optimized, handles message bytes correctly)
export { OptimizedTrafficGenerator } from './OptimizedTrafficGenerator.js';

// Fast Simulation (optimized for dozens of transfers)
export { FastSimulation } from './FastSimulation.js';
export type { FastSimulationConfig } from './FastSimulation.js';

// Integrated Simulation (real RebalancerService)
export { IntegratedSimulation, createWeightedStrategyConfig } from './IntegratedSimulation.js';
export type { IntegratedSimulationConfig } from './IntegratedSimulation.js';

// Mock Registry
export { MockRegistry } from './MockRegistry.js';
export type { MockRegistryConfig } from './MockRegistry.js';

// Traffic Patterns
export {
  trafficPatterns,
  generateTraffic,
  steadyTrafficPattern,
  burstTrafficPattern,
  imbalancedTrafficPattern,
  heavyOneWayPattern,
  bidirectionalImbalancedPattern,
} from './TrafficPatterns.js';

// Visualizer
export { visualizeSimulation, compareSimulations } from './SimulationVisualizer.js';

// Types
export type {
  // Simulation run configuration
  ScheduledTransfer,
  SimulationRun,
  SimulationRunFile,
  // Bridge configuration
  SimulatedBridgeConfig,
  // Traffic patterns
  TrafficPattern,
  TrafficPatternConfig,
  // Pending items
  PendingWarpTransfer,
  PendingBridgeTransfer,
  // Metrics
  TransferMetric,
  BridgeMetric,
  TimeSeriesPoint,
  EnhancedTimeSeriesPoint,
  TransferEvent,
  LatencyStats,
  SimulationResults,
} from './types.js';

// Bridge config presets
export { BRIDGE_CONFIGS } from './types.js';
