import { IExecutor } from '../interfaces/IExecutor.js';
import { RebalancingRoute } from '../interfaces/IStrategy.js';

export class Executor implements IExecutor {
  async processRebalancingRoutes(routes: RebalancingRoute[]): Promise<void> {
    console.log('Executing rebalancing routes:', routes);
  }
}
