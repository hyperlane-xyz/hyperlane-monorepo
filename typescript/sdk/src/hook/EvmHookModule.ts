import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneAddresses } from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleArgs,
} from '../core/AbstractHyperlaneModule.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EthersV5Transaction } from '../providers/ProviderType.js';

import { EvmHookReader } from './EvmHookReader.js';
import { HookFactories } from './contracts.js';
import { HookConfig } from './types.js';

// WIP example implementation of EvmHookModule
export class EvmHookModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  HookConfig,
  HyperlaneAddresses<HookFactories> & {
    deployedHook: Address;
  }
> {
  protected logger = rootLogger.child({ module: 'EvmHookModule' });
  protected reader: EvmHookReader;

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly deployer: HyperlaneDeployer<any, any>,
    args: HyperlaneModuleArgs<
      HookConfig,
      HyperlaneAddresses<HookFactories> & {
        deployedHook: Address;
      }
    >,
  ) {
    super(args);
    this.reader = new EvmHookReader(multiProvider, args.chain);
  }

  public async read(): Promise<HookConfig> {
    return await this.reader.deriveHookConfig(this.args.addresses.deployedHook);
  }

  public async update(_config: HookConfig): Promise<EthersV5Transaction[]> {
    throw new Error('Method not implemented.');
  }

  // manually write static create function
  public static create(_config: HookConfig): Promise<EvmHookModule> {
    throw new Error('not implemented');
  }
}
