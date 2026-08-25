import { IFundingStrategy } from './IFundingStrategy';
import { DirectNativeStrategy } from './DirectNativeStrategy';
import { WarpRouteStrategy } from './WarpRouteStrategy';
import { RollupBridgeStrategy } from './RollupBridgeStrategy';
import { FundingAction, FundingExecutionResult, StrategyExecutionContext } from '../types';

export class StrategyRouter {
  private strategies: Map<string, IFundingStrategy> = new Map();

  constructor() {
    this.registerDefaultStrategies();
  }

  private registerDefaultStrategies(): void {
    const direct = new DirectNativeStrategy();
    const warp = new WarpRouteStrategy();
    const rollup = new RollupBridgeStrategy();

    this.registerStrategy('direct', direct);
    this.registerStrategy('warpRoute', warp);
    this.registerStrategy('opStackBridge', rollup);
    this.registerStrategy('optimismPortal', rollup);
    this.registerStrategy('arbitrumInbox', rollup);
    this.registerStrategy('arbitrum', rollup);
    this.registerStrategy('rollupBridge', rollup);
  }

  /**
   * Register or override a strategy instance
   */
  public registerStrategy(name: string, strategy: IFundingStrategy): void {
    this.strategies.set(name.toLowerCase(), strategy);
  }

  /**
   * Check if a strategy is registered
   */
  public hasStrategy(name: string): boolean {
    return this.strategies.has(name.toLowerCase());
  }

  /**
   * Get strategy by name
   */
  public getStrategy(name: string): IFundingStrategy {
    const strategy = this.strategies.get(name.toLowerCase());
    if (!strategy) {
      throw new Error(`Funding strategy "${name}" is not registered`);
    }
    return strategy;
  }

  /**
   * Execute funding action via appropriate strategy
   */
  public async execute(
    action: FundingAction,
    context: StrategyExecutionContext,
    signerContext?: any
  ): Promise<FundingExecutionResult> {
    const strategyName = action.strategy || 'direct';
    const strategy = this.getStrategy(strategyName);
    return await strategy.execute(action, context, signerContext);
  }
}
