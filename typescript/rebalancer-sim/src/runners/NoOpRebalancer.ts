import { EventEmitter } from 'events';

import type {
  IRebalancerRunner,
  RebalancerEvent,
  RebalancerSimConfig,
} from '../types.js';

/**
 * NoOpRebalancer does nothing - used as a baseline to show what happens
 * when no rebalancer is running. Useful for demonstrating that transfers
 * fail without active liquidity management.
 */
export class NoOpRebalancer extends EventEmitter implements IRebalancerRunner {
  readonly name = 'NoOpRebalancer';

  async initialize(_config: RebalancerSimConfig): Promise<void> {
    // No-op
  }

  async start(): Promise<void> {
    // No-op
  }

  async stop(): Promise<void> {
    // No-op
  }

  isActive(): boolean {
    return false;
  }

  async waitForIdle(_timeoutMs?: number): Promise<void> {
    // Always idle
  }

  on(_event: 'rebalance', _listener: (e: RebalancerEvent) => void): this {
    return this;
  }
}
