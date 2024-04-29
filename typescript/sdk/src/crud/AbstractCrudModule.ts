import { Logger } from 'pino';

import { Address, Annotated, ProtocolType } from '@hyperlane-xyz/utils';

import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import {
  ProtocolTypedProvider,
  ProtocolTypedTransaction,
} from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';

export type CrudModuleArgs<
  TProtocol extends ProtocolType,
  TConfig,
  TAddressMap extends Record<string, Address>,
> = {
  addresses: TAddressMap;
  chain: ChainNameOrId;
  chainMetadataManager: ChainMetadataManager;
  config: TConfig;
  provider: ProtocolTypedProvider<TProtocol>['provider'];
};

export abstract class CrudModule<
  TProtocol extends ProtocolType,
  TConfig,
  TAddressMap extends Record<string, Address>,
> {
  protected abstract readonly logger: Logger;

  protected constructor(
    protected readonly args: CrudModuleArgs<TProtocol, TConfig, TAddressMap>,
  ) {}

  public serialize(): TAddressMap {
    return this.args.addresses;
  }

  public abstract read(address: Address): Promise<TConfig>;
  public abstract update(
    config: TConfig,
  ): Promise<Annotated<ProtocolTypedTransaction<TProtocol>[]>>;

  // /*
  //   Types and static methods can be challenging. Ensure each implementation includes a static create function.
  //   Currently, include TConfig to maintain the structure for ISM/Hook configurations.
  //   If found to be unnecessary, we may consider revisiting and potentially removing these config requirements later.
  //   */
  // public static create<
  //   TConfig extends CrudConfig,
  //   TProtocol extends ProtocolType,
  //   TAddress extends Record<string, any>,
  //   TModule extends CrudModule<TProtocol, TConfig, TAddress>,
  // >(_config: TConfig): Promise<TModule> {
  //   throw new Error('not implemented');
  // }
}
