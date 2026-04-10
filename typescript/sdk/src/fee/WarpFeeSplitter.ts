import { BigNumberish, ContractTransaction } from 'ethers';

import { WarpFeeSplitter, WarpFeeSplitter__factory } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

export type WarpFeeSplitterConfig = {
  owner: Address;
  hubRouter: Address;
  lpBps: BigNumberish;
  protocolBeneficiary: Address;
  streamingPeriod: BigNumberish;
};

export type DerivedWarpFeeSplitterConfig = WarpFeeSplitterConfig & {
  address: Address;
};

export class EvmWarpFeeSplitterModule {
  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
    public readonly contract: WarpFeeSplitter,
  ) {}

  static async create({
    multiProvider,
    chain,
    config,
  }: {
    multiProvider: MultiProvider;
    chain: ChainNameOrId;
    config: WarpFeeSplitterConfig;
  }): Promise<EvmWarpFeeSplitterModule> {
    const chainName = multiProvider.getChainName(chain);
    const contract = await new WarpFeeSplitter__factory(
      multiProvider.getSigner(chainName),
    ).deploy(
      config.owner,
      config.hubRouter,
      config.lpBps,
      config.protocolBeneficiary,
      config.streamingPeriod,
    );
    await contract.deployed();
    return new EvmWarpFeeSplitterModule(multiProvider, chainName, contract);
  }

  async read(): Promise<DerivedWarpFeeSplitterConfig> {
    const [owner, hubRouter, lpBps, protocolBeneficiary, streamingPeriod] =
      await Promise.all([
        this.contract.owner(),
        this.contract.hubRouter(),
        this.contract.lpBps(),
        this.contract.protocolBeneficiary(),
        this.contract.streamingPeriod(),
      ]);

    return {
      address: this.contract.address,
      owner,
      hubRouter,
      lpBps,
      protocolBeneficiary,
      streamingPeriod,
    };
  }

  notify(token: Address): Promise<ContractTransaction> {
    return this.contract.notify(token);
  }

  drip(token: Address): Promise<ContractTransaction> {
    return this.contract.drip(token);
  }
}
