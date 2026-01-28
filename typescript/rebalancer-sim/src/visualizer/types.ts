import type {
  RebalanceRecord,
  SimulationResult,
  StateSnapshot,
  TransferRecord,
} from '../kpi/types.js';

/**
 * Unified timeline event for visualization
 */
export type TimelineEvent =
  | {
      type: 'transfer_start';
      timestamp: number;
      data: TransferRecord;
    }
  | {
      type: 'transfer_complete';
      timestamp: number;
      data: TransferRecord;
    }
  | {
      type: 'transfer_failed';
      timestamp: number;
      data: TransferRecord;
    }
  | {
      type: 'rebalance_start';
      timestamp: number;
      data: RebalanceRecord;
    }
  | {
      type: 'rebalance_complete';
      timestamp: number;
      data: RebalanceRecord;
    }
  | {
      type: 'rebalance_failed';
      timestamp: number;
      data: RebalanceRecord;
    }
  | {
      type: 'balance_snapshot';
      timestamp: number;
      data: StateSnapshot;
    };

/**
 * Processed data ready for visualization
 */
export interface VisualizationData {
  scenario: string;
  rebalancerName: string;
  startTime: number;
  endTime: number;
  duration: number;
  chains: string[];
  events: TimelineEvent[];
  transfers: TransferRecord[];
  rebalances: RebalanceRecord[];
  balanceTimeline: StateSnapshot[];
  kpis: SimulationResult['kpis'];
}

/**
 * Options for HTML generation
 */
export interface HtmlGeneratorOptions {
  /** Width of the timeline in pixels */
  width?: number;
  /** Height per chain row in pixels */
  rowHeight?: number;
  /** Whether to show balance curves */
  showBalances?: boolean;
  /** Whether to show rebalance markers */
  showRebalances?: boolean;
  /** Title override */
  title?: string;
}

/**
 * Convert SimulationResult to VisualizationData
 */
export function toVisualizationData(
  result: SimulationResult,
): VisualizationData {
  const events: TimelineEvent[] = [];

  // Collect all chains from transfers and rebalances
  const chainSet = new Set<string>();
  for (const t of result.transferRecords) {
    chainSet.add(t.origin);
    chainSet.add(t.destination);
  }
  for (const r of result.rebalanceRecords) {
    chainSet.add(r.origin);
    chainSet.add(r.destination);
  }

  // Add transfer events
  for (const transfer of result.transferRecords) {
    events.push({
      type: 'transfer_start',
      timestamp: transfer.startTime,
      data: transfer,
    });

    if (transfer.endTime) {
      events.push({
        type:
          transfer.status === 'failed'
            ? 'transfer_failed'
            : 'transfer_complete',
        timestamp: transfer.endTime,
        data: transfer,
      });
    }
  }

  // Add rebalance events (start and complete/fail)
  for (const rebalance of result.rebalanceRecords) {
    // Rebalance start
    events.push({
      type: 'rebalance_start',
      timestamp: rebalance.startTime,
      data: rebalance,
    });
    // Rebalance complete/fail
    if (rebalance.endTime) {
      events.push({
        type:
          rebalance.status === 'failed'
            ? 'rebalance_failed'
            : 'rebalance_complete',
        timestamp: rebalance.endTime,
        data: rebalance,
      });
    }
  }

  // Add balance snapshots
  for (const snapshot of result.timeline) {
    events.push({
      type: 'balance_snapshot',
      timestamp: snapshot.timestamp,
      data: snapshot,
    });
  }

  // Sort events by timestamp
  events.sort((a, b) => a.timestamp - b.timestamp);

  return {
    scenario: result.scenarioName,
    rebalancerName: result.rebalancerName,
    startTime: result.startTime,
    endTime: result.endTime,
    duration: result.duration,
    chains: Array.from(chainSet).sort(),
    events,
    transfers: result.transferRecords,
    rebalances: result.rebalanceRecords,
    balanceTimeline: result.timeline,
    kpis: result.kpis,
  };
}
