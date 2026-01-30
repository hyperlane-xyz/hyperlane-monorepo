/**
 * Rebalancer Simulation Framework
 *
 * A fast, real-time simulation framework for testing Hyperlane warp route
 * rebalancers against synthetic transfer scenarios.
 */

// Core simulation classes
export { BridgeMockController } from './BridgeMockController.js';
export { KPICollector } from './KPICollector.js';
export { MessageTracker } from './MessageTracker.js';
export { RebalancerSimulationHarness } from './RebalancerSimulationHarness.js';
export {
  deployMultiDomainSimulation,
  getWarpTokenBalance,
} from './SimulationDeployment.js';
export { DEFAULT_TIMING, SimulationEngine } from './SimulationEngine.js';

// Scenario generation and loading
export { ScenarioGenerator } from './ScenarioGenerator.js';
export {
  getScenariosDir,
  listScenarios,
  loadScenario,
  loadScenarioFile,
} from './ScenarioLoader.js';

// Rebalancer runners
export {
  cleanupProductionRebalancer,
  ProductionRebalancerRunner,
} from './runners/ProductionRebalancerRunner.js';
export { cleanupSimpleRunner, SimpleRunner } from './runners/SimpleRunner.js';
export { SimulationRegistry } from './runners/SimulationRegistry.js';

// Visualization
export { generateTimelineHtml } from './visualizer/HtmlTimelineGenerator.js';

// Types - explicit exports for tree-shaking
export type {
  // Bridge types
  BridgeEvent,
  BridgeEventType,
  BridgeMockConfig,
  BridgeRouteConfig,
  PendingTransfer,
  // Deployment types
  DeployedDomain,
  MultiDomainDeploymentOptions,
  MultiDomainDeploymentResult,
  SimulatedChainConfig,
  // KPI types
  ChainMetrics,
  ComparisonReport,
  RebalanceRecord,
  SimulationKPIs,
  SimulationResult,
  StateSnapshot,
  TransferRecord,
  // Rebalancer types
  ChainStrategyConfig,
  IRebalancerRunner,
  RebalancerEvent,
  RebalancerSimConfig,
  RebalancerStrategyConfig,
  // Scenario types
  RandomTrafficOptions,
  ScenarioExpectations,
  ScenarioFile,
  SerializedBridgeConfig,
  SerializedScenario,
  SerializedStrategyConfig,
  SerializedTransferEvent,
  SimulationTiming,
  SurgeScenarioOptions,
  TransferEvent,
  TransferScenario,
  UnidirectionalFlowOptions,
  // Visualizer types
  HtmlGeneratorOptions,
  SimulationConfig,
  TimelineEvent,
  VisualizationData,
} from './types.js';

// Constants and utility functions
export {
  ANVIL_BRIDGE_CONTROLLER_ADDRESS,
  ANVIL_BRIDGE_CONTROLLER_KEY,
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_DEPLOYER_KEY,
  ANVIL_MAILBOX_PROCESSOR_ADDRESS,
  ANVIL_MAILBOX_PROCESSOR_KEY,
  ANVIL_REBALANCER_ADDRESS,
  ANVIL_REBALANCER_KEY,
  createSymmetricBridgeConfig,
  DEFAULT_BRIDGE_ROUTE_CONFIG,
  DEFAULT_SIMULATED_CHAINS,
  toVisualizationData,
} from './types.js';
