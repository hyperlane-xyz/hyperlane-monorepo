import { IExecutor } from '../interfaces/IExecutor.js';
import { StrategyEvent } from '../interfaces/IStrategy.js';

export class Executor implements IExecutor {
  async handleStrategyEvent(_event: StrategyEvent): Promise<void> {
    // TODO: Replace with actual executor logic
    // Current implementation is a placeholder used to test something in typescript/cli/src/tests/warp/warp-rebalancer.e2e-test.ts
    console.log('Executing strategy event:', _event);
  }
}
