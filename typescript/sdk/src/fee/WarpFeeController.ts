import { BigNumberish, ContractTransaction } from 'ethers';

import {
  RoutingFee__factory,
  WarpFeeController,
  WarpFeeController__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  AddressBytes32,
  addressToBytes32,
} from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

export type WarpFeeControllerConfig = {
  owner: Address;
  interchainAccountRouter: Address;
  hubDomain: number;
  hubRouter: Address;
  lpBps: BigNumberish;
  protocolBeneficiary: Address;
  feeManager: Address;
};

export type DerivedWarpFeeControllerConfig = WarpFeeControllerConfig & {
  address: Address;
};

export type WarpFeeControllerCall = {
  to: AddressBytes32;
  value: BigNumberish;
  data: string;
};

export class EvmWarpFeeControllerModule {
  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
    public readonly contract: WarpFeeController,
  ) {}

  static async create({
    multiProvider,
    chain,
    config,
  }: {
    multiProvider: MultiProvider;
    chain: ChainNameOrId;
    config: WarpFeeControllerConfig;
  }): Promise<EvmWarpFeeControllerModule> {
    const chainName = multiProvider.getChainName(chain);
    const contract = await new WarpFeeController__factory(
      multiProvider.getSigner(chainName),
    ).deploy(
      config.owner,
      config.interchainAccountRouter,
      config.hubDomain,
      config.hubRouter,
      config.lpBps,
      config.protocolBeneficiary,
      config.feeManager,
    );
    await contract.deployed();
    return new EvmWarpFeeControllerModule(multiProvider, chainName, contract);
  }

  async read(): Promise<DerivedWarpFeeControllerConfig> {
    const [
      owner,
      interchainAccountRouter,
      hubDomain,
      hubRouter,
      lpBps,
      protocolBeneficiary,
      feeManager,
    ] = await Promise.all([
      this.contract.owner(),
      this.contract.icaRouter(),
      this.contract.hubDomain(),
      this.contract.hubRouter(),
      this.contract.lpBps(),
      this.contract.protocolBeneficiary(),
      this.contract.feeManager(),
    ]);

    return {
      address: this.contract.address,
      owner,
      interchainAccountRouter,
      hubDomain,
      hubRouter,
      lpBps,
      protocolBeneficiary,
      feeManager,
    };
  }

  static buildRoutingFeeUpdateCall({
    routingFee,
    destination,
    feeContract,
  }: {
    routingFee: Address;
    destination: number;
    feeContract: Address;
  }): WarpFeeControllerCall {
    return {
      to: addressToBytes32(routingFee),
      value: 0,
      data: RoutingFee__factory.createInterface().encodeFunctionData(
        'setFeeContract(uint32,address)',
        [destination, feeContract],
      ),
    };
  }

  dispatchFeeUpdate({
    remoteDomain,
    calls,
    hookMetadata = '0x',
    value = 0,
  }: {
    remoteDomain: number;
    calls: WarpFeeControllerCall[];
    hookMetadata?: string;
    value?: BigNumberish;
  }): Promise<ContractTransaction> {
    return this.contract.dispatchFeeUpdate(remoteDomain, calls, hookMetadata, {
      value,
    });
  }

  collect({
    remoteDomain,
    feeContract,
    token,
    remoteRouter,
    amount,
    paymentAmount,
    tokenClaim = false,
    hookMetadata = '0x',
    value = 0,
  }: {
    remoteDomain: number;
    feeContract: Address;
    token: Address;
    remoteRouter: Address;
    amount: BigNumberish;
    paymentAmount: BigNumberish;
    tokenClaim?: boolean;
    hookMetadata?: string;
    value?: BigNumberish;
  }): Promise<ContractTransaction> {
    return this.contract.collect(
      remoteDomain,
      feeContract,
      token,
      remoteRouter,
      amount,
      paymentAmount,
      tokenClaim,
      hookMetadata,
      { value },
    );
  }

  distribute(token: Address): Promise<ContractTransaction> {
    return this.contract.distribute(token);
  }
}
