import { StrategyEvent } from './IStrategy.js';

/**
 * Interface for the class that will execute rebalancing transactions on-chain.
 */
export interface IExecutor {
  /**
   * Executes rebalancing based on the data provided by the strategy.
   */
  handleStrategyEvent(event: StrategyEvent): Promise<void>;
}
