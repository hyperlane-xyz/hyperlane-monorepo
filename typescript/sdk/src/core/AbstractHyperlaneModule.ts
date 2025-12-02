import { Logger } from 'pino';

import { Annotated, ProtocolType } from '@hyperlane-xyz/utils';

import { ProtocolTypedTransaction } from '../providers/ProviderType.js';
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
  ): Promise<Annotated<ProtocolTypedTransaction<TProtocol>['transaction']>[]>;

  // /*
  //   Types and static methods can be challenging. Ensure each implementation includes a static create function.
  //   Currently, include TConfig to maintain the structure for ISM/Hook configurations.
  //   If found to be unnecessary, we may consider revisiting and potentially removing these config requirements later.
  //   */
  // public static create(_config: TConfig): Promise<TModule> {
  //   throw new Error('not implemented');
  // }
}
