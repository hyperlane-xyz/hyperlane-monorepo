import { BigNumberish, ContractTransaction } from 'ethers';

import { WarpFeeVault, WarpFeeVault__factory } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

export type WarpFeeVaultConfig = {
  owner: Address;
  asset: Address;
  hubRouter: Address;
  lpBps: BigNumberish;
  protocolBeneficiary: Address;
  streamingPeriod: BigNumberish;
  name: string;
  symbol: string;
};

export type DerivedWarpFeeVaultConfig = WarpFeeVaultConfig & {
  address: Address;
};

export class EvmWarpFeeVaultModule {
  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
    public readonly contract: WarpFeeVault,
  ) {}

  static async create({
    multiProvider,
    chain,
    config,
  }: {
    multiProvider: MultiProvider;
    chain: ChainNameOrId;
    config: WarpFeeVaultConfig;
  }): Promise<EvmWarpFeeVaultModule> {
    const chainName = multiProvider.getChainName(chain);
    const contract = await new WarpFeeVault__factory(
      multiProvider.getSigner(chainName),
    ).deploy(
      config.owner,
      config.asset,
      config.hubRouter,
      config.lpBps,
      config.protocolBeneficiary,
      config.streamingPeriod,
      config.name,
      config.symbol,
    );
    await contract.deployed();
    return new EvmWarpFeeVaultModule(multiProvider, chainName, contract);
  }

  async read(): Promise<DerivedWarpFeeVaultConfig> {
    const [
      owner,
      asset,
      hubRouter,
      lpBps,
      protocolBeneficiary,
      streamingPeriod,
      name,
      symbol,
    ] = await Promise.all([
      this.contract.owner(),
      this.contract.asset(),
      this.contract.hubRouter(),
      this.contract.lpBps(),
      this.contract.protocolBeneficiary(),
      this.contract.streamingPeriod(),
      this.contract.name(),
      this.contract.symbol(),
    ]);

    return {
      address: this.contract.address,
      owner,
      asset,
      hubRouter,
      lpBps,
      protocolBeneficiary,
      streamingPeriod,
      name,
      symbol,
    };
  }

  notify(): Promise<ContractTransaction> {
    return this.contract.notify();
  }
}
