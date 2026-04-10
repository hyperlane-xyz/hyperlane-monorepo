import { BigNumber, BigNumberish, ContractTransaction } from 'ethers';

import { WarpFeeVault, WarpFeeVault__factory } from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  assert,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { transferOwnershipTransactions } from '../contracts/contracts.js';
import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
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

export type WarpFeeVaultAddresses = {
  warpFeeVault: Address;
};

function bigNumberishEquals(a: BigNumberish, b: BigNumberish): boolean {
  return BigNumber.from(a).eq(b);
}

function formatBigNumberish(value: BigNumberish): string {
  return BigNumber.from(value).toString();
}

export class EvmWarpFeeVaultModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  WarpFeeVaultConfig,
  WarpFeeVaultAddresses
> {
  static protocols = [ProtocolType.Ethereum, ProtocolType.Tron];
  protected readonly logger = rootLogger.child({
    module: 'EvmWarpFeeVaultModule',
  });
  public readonly contract: WarpFeeVault;
  protected readonly chainName: string;
  protected readonly chainId: number;

  constructor(
    protected readonly multiProvider: MultiProvider,
    params: HyperlaneModuleParams<WarpFeeVaultConfig, WarpFeeVaultAddresses>,
    contract?: WarpFeeVault,
  ) {
    super(params);
    this.chainName = multiProvider.getChainName(params.chain);
    this.chainId = multiProvider.getEvmChainId(this.chainName);
    this.contract =
      contract ??
      WarpFeeVault__factory.connect(
        params.addresses.warpFeeVault,
        multiProvider.getProvider(this.chainName),
      );
  }

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
    return new EvmWarpFeeVaultModule(
      multiProvider,
      {
        addresses: {
          warpFeeVault: contract.address,
        },
        chain: chainName,
        config,
      },
      contract,
    );
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
      address: this.args.addresses.warpFeeVault,
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

  async update(
    targetConfig: WarpFeeVaultConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    const actualConfig = await this.read();

    assert(
      eqAddress(actualConfig.asset, targetConfig.asset),
      'WarpFeeVault asset is immutable; deploy a new vault to change it',
    );
    assert(
      eqAddress(actualConfig.hubRouter, targetConfig.hubRouter),
      'WarpFeeVault hubRouter is immutable; deploy a new vault to change it',
    );
    assert(
      actualConfig.name === targetConfig.name,
      'WarpFeeVault name is immutable; deploy a new vault to change it',
    );
    assert(
      actualConfig.symbol === targetConfig.symbol,
      'WarpFeeVault symbol is immutable; deploy a new vault to change it',
    );

    const transactions: AnnotatedEV5Transaction[] = [];
    const iface = WarpFeeVault__factory.createInterface();
    const contract = this.args.addresses.warpFeeVault;

    if (!bigNumberishEquals(actualConfig.lpBps, targetConfig.lpBps)) {
      transactions.push({
        annotation: `Set WarpFeeVault LP bps from ${formatBigNumberish(actualConfig.lpBps)} to ${formatBigNumberish(targetConfig.lpBps)}`,
        chainId: this.chainId,
        to: contract,
        data: iface.encodeFunctionData('setLpBps', [targetConfig.lpBps]),
      });
    }

    if (
      !eqAddress(
        actualConfig.protocolBeneficiary,
        targetConfig.protocolBeneficiary,
      )
    ) {
      transactions.push({
        annotation: `Set WarpFeeVault protocol beneficiary from ${actualConfig.protocolBeneficiary} to ${targetConfig.protocolBeneficiary}`,
        chainId: this.chainId,
        to: contract,
        data: iface.encodeFunctionData('setProtocolBeneficiary', [
          targetConfig.protocolBeneficiary,
        ]),
      });
    }

    if (
      !bigNumberishEquals(
        actualConfig.streamingPeriod,
        targetConfig.streamingPeriod,
      )
    ) {
      transactions.push({
        annotation: `Set WarpFeeVault streaming period from ${formatBigNumberish(actualConfig.streamingPeriod)} to ${formatBigNumberish(targetConfig.streamingPeriod)}`,
        chainId: this.chainId,
        to: contract,
        data: iface.encodeFunctionData('setStreamingPeriod', [
          targetConfig.streamingPeriod,
        ]),
      });
    }

    return [
      ...transactions,
      ...transferOwnershipTransactions(
        this.chainId,
        contract,
        actualConfig,
        targetConfig,
        'Warp Fee Vault',
      ),
    ];
  }

  notify(): Promise<ContractTransaction> {
    return this.contract.notify();
  }
}
