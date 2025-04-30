import { ChainName, Token, WarpCore } from '@hyperlane-xyz/sdk';

import { IExecutor } from '../interfaces/IExecutor.js';
import { RebalancingRoute } from '../interfaces/IStrategy.js';

export class Executor implements IExecutor {
  constructor(
    private readonly persistance: IExecutorPersistance,
    private readonly warpCore: WarpCore,
  ) {}

  async rebalance(routes: RebalancingRoute[]) {
    if ((await this.persistance.getStatus()) === 'ongoing') {
      throw new Error('Rebalance already in progress');
    }

    const adaptedTokenByChain: Record<ChainName, TokenAdapter> =
      Object.fromEntries(
        routes.map((route) => [
          route.fromChain,
          this.getAdaptedTokenForChain(route.fromChain),
        ]),
      );

    try {
      await this.persistance.start();

      await Promise.all(
        routes.map((route) =>
          adaptedTokenByChain[route.fromChain].rebalance({
            toChain: route.toChain,
            amount: BigInt(route.amount),
          }),
        ),
      );

      await this.persistance.complete();
    } catch (_e) {
      await this.persistance.fail();
    }
  }

  private getAdaptedTokenForChain(chain: ChainName) {
    const tokens = this.warpCore.getTokensForChain(chain);
    if (tokens.length !== 1) {
      throw new Error(`Invalid number of tokens for chain ${chain}`);
    }
    return new TokenAdapter(tokens[0]);
  }
}

export class ExecutorInMemoryPersistance implements IExecutorPersistance {
  private status: 'ongoing' | 'completed' | 'failed' | null = null;

  async getStatus() {
    return this.status;
  }

  async start() {
    this.status = 'ongoing';
  }

  async fail() {
    this.status = 'failed';
  }

  async complete() {
    this.status = 'completed';
  }
}

export interface IExecutorPersistance {
  getStatus(): Promise<'ongoing' | 'completed' | 'failed' | null>;

  start(): Promise<void>;

  fail(): Promise<void>;

  complete(): Promise<void>;
}

export class TokenAdapter {
  constructor(protected readonly token: Token) {}

  async rebalance(_args: Pick<RebalancingRoute, 'toChain' | 'amount'>) {
    // TODO: Execute the rebalance function on the smart contract and wait for the whole bridge operation to conclude
  }
}
