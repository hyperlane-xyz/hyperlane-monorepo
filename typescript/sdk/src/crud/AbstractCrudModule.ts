import { Logger } from 'pino';

import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneFactories } from '../contracts/types.js';
import { CoreConfig } from '../core/types.js';
import { HookConfig } from '../hook/types.js';
import { IsmConfig } from '../ism/types.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { WarpRouteConfig } from '../metadata/warpRouteConfig.js';
import {
  Annotated,
  ProtocolTypedProvider,
  ProtocolTypedTransaction,
  SupportedProtocolType,
} from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';

export type CrudConfig = CoreConfig | WarpRouteConfig | HookConfig | IsmConfig;

export type CrudModuleArgs<
  TProtocol extends SupportedProtocolType,
  TConfig extends CrudConfig,
  TAddress extends Record<string, any>,
> = {
  addresses: Record<keyof TAddress, Address>;
  chain: ChainNameOrId;
  chainMetadataManager: ChainMetadataManager;
  config: TConfig;
  provider: ProtocolTypedProvider<TProtocol>['provider'];
};

export abstract class CrudModule<
  TProtocol extends SupportedProtocolType,
  TConfig extends CrudConfig,
  TFactory extends HyperlaneFactories,
> {
  protected abstract readonly logger: Logger;

  protected constructor(
    protected readonly args: CrudModuleArgs<TProtocol, TConfig, TFactory>,
  ) {}

  public serialize(): string {
    return JSON.stringify(this.args.addresses);
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
  // public static create(_config: XYZConfig): Promise<PROTOCOL_XYZ_Module> {
  //   throw new Error('not implemented');
  // }
}
