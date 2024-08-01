import { Logger } from 'pino';

import { Ownable__factory } from '@hyperlane-xyz/core';
import {
  Address,
  Annotated,
  ProtocolType,
  eqAddress,
} from '@hyperlane-xyz/utils';

import {
  AnnotatedEV5Transaction,
  ProtocolTypedTransaction,
} from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';

export type HyperlaneModuleParams<
  TConfig,
  TAddressMap extends Record<string, any>,
> = {
  addresses: TAddressMap;
  chain: ChainNameOrId;
  config: TConfig;
};

export abstract class HyperlaneModule<
  TProtocol extends ProtocolType,
  TConfig,
  TAddressMap extends Record<string, any>,
> {
  protected abstract readonly logger: Logger;

  protected constructor(
    protected readonly args: HyperlaneModuleParams<TConfig, TAddressMap>,
  ) {}

  public serialize(): TAddressMap {
    return this.args.addresses;
  }

  public abstract read(): Promise<TConfig>;
  public abstract update(
    config: TConfig,
  ): Promise<Annotated<ProtocolTypedTransaction<TProtocol>['transaction'][]>>;

  /**
   * Transfers ownership of a contract to a new owner.
   *
   * @param actualOwner - The current owner of the contract.
   * @param expectedOwner - The expected new owner of the contract.
   * @param deployedAddress - The address of the deployed contract.
   * @param chainId - The chain ID of the network the contract is deployed on.
   * @returns An array of annotated EV5 transactions that need to be executed to update the owner.
   */
  static createTransferOwnershipTx(params: {
    actualOwner: Address;
    expectedOwner: Address;
    deployedAddress: Address;
    chainId: number;
  }): AnnotatedEV5Transaction[] {
    const { actualOwner, expectedOwner, deployedAddress, chainId } = params;
    const updateTransactions: AnnotatedEV5Transaction[] = [];
    if (eqAddress(actualOwner, expectedOwner)) {
      return [];
    }

    updateTransactions.push({
      annotation: `Transferring ownership of ${deployedAddress} from current owner ${actualOwner} to new owner ${expectedOwner}`,
      chainId,
      to: deployedAddress,
      data: Ownable__factory.createInterface().encodeFunctionData(
        'transferOwnership(address)',
        [expectedOwner],
      ),
    });

    return updateTransactions;
  }

  // /*
  //   Types and static methods can be challenging. Ensure each implementation includes a static create function.
  //   Currently, include TConfig to maintain the structure for ISM/Hook configurations.
  //   If found to be unnecessary, we may consider revisiting and potentially removing these config requirements later.
  //   */
  // public static create(_config: TConfig): Promise<TModule> {
  //   throw new Error('not implemented');
  // }
}
