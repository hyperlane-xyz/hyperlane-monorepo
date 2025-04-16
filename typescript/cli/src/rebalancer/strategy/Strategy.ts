import EventEmitter from 'events';

import { MonitorEvent } from '../interfaces/IMonitor.js';
import { IStrategy, StrategyEvent } from '../interfaces/IStrategy.js';

/**
 * Simple strategy implementation that processes token balances accross chains and emits a StrategyEvent
 * containing if and how rebalancing is has to be applied.
 */
export class Strategy implements IStrategy {
  private readonly STRATEGY_EVENT = 'strategy';
  private readonly emitter = new EventEmitter();

  subscribe(fn: (event: StrategyEvent) => void): void {
    this.emitter.on(this.STRATEGY_EVENT, fn);
  }

  async handleMonitorEvent(event: MonitorEvent): Promise<void> {
    // TODO: Implement actual strategy logic
    // Current implementation is a placeholder used to test something in typescript/cli/src/tests/warp/warp-rebalancer.e2e-test.ts
    const strategyEvent: StrategyEvent = {
      route: event.balances.map((b) => ({
        origin: b.chain,
        destination: b.chain,
        token: b.token,
        amount: b.value,
      })),
    };
    this.emitter.emit(this.STRATEGY_EVENT, strategyEvent);
  }
}
