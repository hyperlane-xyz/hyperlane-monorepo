import { Signer } from 'ethers';

import { ChainName, TxSubmitterType } from '@hyperlane-xyz/sdk';

import { ISubmitterStrategy } from '../strategies/submitter/SubmitterStrategy.js';
import { SubmitterStrategyFactory } from '../strategies/submitter/SubmitterStrategyFactory.js';

export class ContextManager {
  private strategy: ISubmitterStrategy;

  constructor(
    defaultStrategy: any,
    private chains: ChainName[],
    submitterType: TxSubmitterType,
  ) {
    this.strategy = SubmitterStrategyFactory.createStrategy(
      submitterType,
      defaultStrategy,
    );
  }

  async getChainKeys(): Promise<
    Array<{ chainName: ChainName; privateKey: string }>
  > {
    const chainKeys = await Promise.all(
      this.chains.map(async (chain) => ({
        chainName: chain,
        privateKey: await this.strategy.getPrivateKey(chain),
      })),
    );

    return chainKeys;
  }

  async getSigners(): Promise<Record<ChainName, Signer>> {
    const chainKeys = await this.getChainKeys();
    return Object.fromEntries(
      chainKeys.map(({ chainName, privateKey }) => [
        chainName,
        this.strategy.getSigner(privateKey),
      ]),
    );
  }
}
