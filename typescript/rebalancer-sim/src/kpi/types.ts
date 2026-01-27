/**
 * Per-chain metrics
 */
export interface ChainMetrics {
  chainName: string;
  initialBalance: bigint;
  finalBalance: bigint;
  transfersIn: number;
  transfersOut: number;
  rebalancesIn: number;
  rebalancesOut: number;
  rebalanceVolumeIn: bigint;
  rebalanceVolumeOut: bigint;
}

/**
 * KPIs collected during simulation
 */
export interface SimulationKPIs {
  totalTransfers: number;
  completedTransfers: number;
  failedTransfers: number;
  completionRate: number;
  averageLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  totalRebalances: number;
  rebalanceVolume: bigint;
  totalGasCost: bigint;
  perChainMetrics: Record<string, ChainMetrics>;
}

/**
 * State snapshot at a point in time
 */
export interface StateSnapshot {
  timestamp: number;
  balances: Record<string, bigint>;
  pendingTransfers: number;
  pendingRebalances: number;
}

/**
 * Transfer tracking record
 */
export interface TransferRecord {
  id: string;
  origin: string;
  destination: string;
  amount: bigint;
  startTime: number;
  endTime?: number;
  latency?: number;
  status: 'pending' | 'completed' | 'failed';
}

/**
 * Rebalance tracking record
 */
export interface RebalanceRecord {
  id: string;
  origin: string;
  destination: string;
  amount: bigint;
  timestamp: number;
  gasCost: bigint;
  success: boolean;
}

/**
 * Complete simulation result
 */
export interface SimulationResult {
  scenarioName: string;
  rebalancerName: string;
  startTime: number;
  endTime: number;
  duration: number;
  kpis: SimulationKPIs;
  timeline: StateSnapshot[];
  transferRecords: TransferRecord[];
  rebalanceRecords: RebalanceRecord[];
}

/**
 * Comparison report for multiple rebalancers
 */
export interface ComparisonReport {
  scenarioName: string;
  results: SimulationResult[];
  comparison: {
    bestCompletionRate: string;
    bestLatency: string;
    lowestGasCost: string;
  };
}
