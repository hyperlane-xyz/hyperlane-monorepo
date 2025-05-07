import { log } from '../../logger.js';
import { IExecutor } from '../interfaces/IExecutor.js';
import { RebalancingRoute } from '../interfaces/IStrategy.js';

export class MonitorOnlyExecutor implements IExecutor {
  async rebalance(_routes: RebalancingRoute[]) {
    log('No rebalance executed in monitorOnly mode');
  }
}
