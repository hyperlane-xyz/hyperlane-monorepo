import { Config } from '../config/Config.js';
import { IExecutor } from '../interfaces/IExecutor.js';
import { RebalancingRoute } from '../interfaces/IStrategy.js';

export class WithSemaphore implements IExecutor {
  private waitUntil: number = 0;

  constructor(
    private readonly config: Config,
    private readonly executor: IExecutor,
  ) {}

  async rebalance(routes: RebalancingRoute[]) {
    if (Date.now() < this.waitUntil && routes.length) {
      return;
    }

    const highestTolerance = this.getHighestTolerance(routes);

    await this.executor.rebalance(routes);

    this.waitUntil = Date.now() + highestTolerance;
  }

  private getHighestTolerance(routes: RebalancingRoute[]) {
    return routes.reduce((highest, route) => {
      const bridgeTolerance =
        this.config.chains[route.fromChain]?.bridgeTolerance;

      if (!bridgeTolerance) {
        throw new Error(
          `Bridge tolerance not found for chain ${route.fromChain}`,
        );
      }

      return Math.max(highest, bridgeTolerance);
    }, 0);
  }
}
