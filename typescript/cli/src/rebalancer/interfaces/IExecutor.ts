import { RebalancingRoute } from './IStrategy.js';

export interface IExecutor {
  processRebalancingRoutes(routes: RebalancingRoute[]): Promise<void>;
}
