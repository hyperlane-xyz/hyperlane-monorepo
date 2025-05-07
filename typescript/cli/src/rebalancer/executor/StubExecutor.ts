import { log } from '../../logger.js';
import { IExecutor } from '../interfaces/IExecutor.js';
import { RebalancingRoute } from '../interfaces/IStrategy.js';

export class StubExecutor implements IExecutor {
  async rebalance(_routes: RebalancingRoute[]) {
    log('StubExecutor rebalance called');
  }
}
